"use server";

import twilio from "twilio";
import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage } from "@/lib/must-read";
import { hasTwilioEnv } from "@/lib/env";
import { toE164 } from "@/lib/phone";
import { phoneRefusal } from "@/lib/contactable";
import { smsConsentText, optInSays, type OptInResult } from "@/lib/sms-consent";

/**
 * THE WRITER FOR TWO COLUMNS THAT HAVE NEVER HAD ONE.
 *
 * `mobile_verified_at` and `sms_consent_operational_at` are read by the
 * reminder engine and by the invite's channel plan, and until now nothing on
 * earth set them — so the SMS gate could never open, for anybody, ever.
 *
 * THE ONLY THING THAT MAY SET THEM IS THE RESIDENT. Not the office typing a
 * number in, not an import carrying one off a roll, not a default. The person
 * whose phone it is, signed in as themselves, entering a code we sent to that
 * handset. That is what makes it their number rather than a number about them,
 * and it is the same proof every other LakeLife account gives (rule 5).
 *
 * SCOPED TO THEIR OWN FILE, ALWAYS. Every write below matches on
 * `user_id = auth.uid()`. A renter id is never accepted as an argument — there
 * is nothing on the wire to point at somebody else's household. Same reasoning
 * as claim_park_file, and the same reasoning that fixed claimCrewInvite.
 */

/**
 * The caller's own claimed park file, or null. Identity from the session only.
 *
 * THREE ANSWERS, NOT TWO. A failed read used to arrive as `null`, which every
 * caller below reported as `no_file` — "We couldn't find your lot. Have a word
 * with the office." That sends a resident to ring about a record that is
 * perfectly fine. `error` is returned alongside so the caller can say the true
 * thing instead.
 */
async function myFile(): Promise<{
  file: { id: string; parkId: string; parkName: string } | null;
  error?: unknown;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { file: null };

  const admin = createServiceClient();
  const res = await admin
    .from("park_renters")
    .select("id, park_id, parks(name)")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (res.error) return { file: null, error: res.error };
  const data = res.data;
  if (!data) return { file: null };

  return {
    file: {
      id: data.id as string,
      parkId: data.park_id as string,
      parkName: ((data.parks as { name?: string } | null)?.name as string) ?? "your park",
    },
  };
}

/** Send the six-digit code to a number the resident just typed. */
export async function startTextOptIn(phone: string): Promise<OptInResult> {
  const { file, error: fileErr } = await myFile();
  if (fileErr) return { ok: false, message: readFailedMessage("your park file", fileErr) };
  if (!file) return { ok: false, message: optInSays("no_file") };

  const e164 = toE164(String(phone ?? ""));
  if (!e164) return { ok: false, message: optInSays("bad_phone") };

  // RESERVED SPACE NEVER GETS A CODE.
  //
  // `sendSms` refuses these before anything else; the Twilio VERIFY path — this
  // one and the sign-up route it mirrors — did not, so a 555 number went
  // straight at the carrier. 555-01xx is fiction, but the rest of the 555
  // exchange is live, and 555-1212 is directory assistance. A verification
  // code is still a text message to a stranger.
  const refusal = phoneRefusal(e164);
  if (refusal) return { ok: false, message: optInSays("bad_phone") };

  if (!hasTwilioEnv()) return { ok: false, message: optInSays("not_configured") };

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
      .verifications.create({ to: e164, channel: "sms" });
    return { ok: true, step: "code_sent", message: `Code sent to ${phone}.` };
  } catch (e) {
    const raw = e instanceof Error ? e.message : "";
    // Twilio 60033 / "not a mobile" — the commonest real failure for an older
    // resident, and one they should not be left guessing about.
    if (/landline|not a mobile|60033|60203/i.test(raw)) {
      return { ok: false, message: optInSays("landline") };
    }
    console.error("[opt-in] verify start failed", raw);
    return { ok: false, message: optInSays("send_failed") };
  }
}

/**
 * Check the code and, only then, write the consent.
 *
 * BOTH TIMESTAMPS AND THE WORDING IN ONE UPDATE. A verified number without
 * recorded consent is a number we still may not text, and consent recorded
 * without the sentence is a timestamp that cannot answer the only question
 * anybody would ask about it.
 */
export async function confirmTextOptIn(phone: string, code: string): Promise<OptInResult> {
  const { file, error: fileErr } = await myFile();
  if (fileErr) return { ok: false, message: readFailedMessage("your park file", fileErr) };
  if (!file) return { ok: false, message: optInSays("no_file") };

  const e164 = toE164(String(phone ?? ""));
  if (!e164) return { ok: false, message: optInSays("bad_phone") };
  if (!hasTwilioEnv()) return { ok: false, message: optInSays("not_configured") };

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
      .verificationChecks.create({ to: e164, code: String(code) });
    if (check.status !== "approved") {
      return { ok: false, message: optInSays("code_wrong") };
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : "";
    if (/expired|20404/i.test(raw)) return { ok: false, message: optInSays("code_expired") };
    console.error("[opt-in] verify check failed", raw);
    return { ok: false, message: optInSays("code_wrong") };
  }

  const now = new Date().toISOString();
  const admin = createServiceClient();
  const { error } = await admin
    .from("park_renters")
    .update({
      mobile_e164: e164,
      mobile_verified_at: now,
      sms_consent_operational_at: now,
      // The sentence they actually read, snapshotted (0133). Copy changes;
      // this must not.
      sms_consent_text: smsConsentText(file.parkName),
    })
    .eq("id", file.id);

  if (error) {
    console.error("[opt-in] consent write failed", error.message);
    return { ok: false, message: "That didn't save. Try again in a minute." };
  }

  revalidatePath("/parks/my");
  return { ok: true, step: "done", message: optInSays("saved") };
}

/**
 * Turn it off again, in one tap, with no reason asked.
 *
 * WITHDRAWAL MUST BE AT LEAST AS EASY AS GIVING IT. The number stays on file —
 * she gave it to us and may want it back on next month — but the consent goes,
 * and consent is what the send path actually reads. Clearing the verification
 * too would mean re-doing the code dance for a change of mind.
 */
export async function stopTexts(): Promise<OptInResult> {
  const { file, error: fileErr } = await myFile();
  // WITHDRAWAL MUST NOT BE THE THING THAT BREAKS. Saying "we couldn't find your
  // lot" to somebody trying to stop texts reads as a refusal to let them stop.
  if (fileErr) return { ok: false, message: readFailedMessage("your park file", fileErr) };
  if (!file) return { ok: false, message: optInSays("no_file") };

  const admin = createServiceClient();
  const { error } = await admin
    .from("park_renters")
    .update({ sms_consent_operational_at: null, sms_consent_text: null })
    .eq("id", file.id);

  if (error) return { ok: false, message: "That didn't save." };

  revalidatePath("/parks/my");
  return { ok: true, step: "idle", message: optInSays("off") };
}
