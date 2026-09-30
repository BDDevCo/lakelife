import { NextResponse } from "next/server";
import twilio from "twilio";
import { createClient } from "@/lib/supabase/server";
import { hasTwilioVerifyEnv } from "@/lib/env";
import { toE164 } from "@/lib/phone";
import { phoneRefusal } from "@/lib/contactable";
import { mayStartVerification, verifyGateRefusal } from "@/lib/verify-rate";

/**
 * POST /api/verify/start  { phone }
 * Sends a 6-digit SMS code via Twilio Verify to the logged-in user's mobile.
 */
export async function POST(request: Request) {
  // Must be signed in first (SSO or email) — matches CLAUDE.md rule 5 order.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }

  const { phone } = await request.json().catch(() => ({ phone: "" }));
  const e164 = toE164(String(phone ?? ""));
  if (!e164) {
    return NextResponse.json(
      { error: "That doesn't look like a valid US mobile number." },
      { status: 400 },
    );
  }

  // RESERVED SPACE NEVER GETS A CODE, AND THIS WAS THE LAST DOOR WITHOUT THE
  // RULE. sendSms has refused these before anything else since contactable.ts
  // was written, and startTextOptIn since the park opt-in shipped; the sign-up
  // route it mirrors did not, so a 555 number went straight at the carrier.
  // 555-01xx is fiction, but the rest of that exchange is live and 555-1212 is
  // directory assistance. A verification code is still a text to a stranger.
  if (phoneRefusal(e164)) {
    return NextResponse.json(
      { error: "That doesn't look like a valid US mobile number." },
      { status: 400 },
    );
  }

  // If Twilio isn't configured yet, don't crash — tell the UI so it can
  // show a friendly note. (Lets you click through before keys are in.)
  if (!hasTwilioVerifyEnv()) {
    return NextResponse.json(
      { error: "Twilio isn't configured yet. Add your Twilio keys to .env.local.", needsKeys: true },
      { status: 503 },
    );
  }

  // HOW OFTEN, NOT WHETHER. Every other gate in front of a send asks whether
  // we may contact this person; nothing asked how many times, and this route
  // is behind a session and nothing else. Records the attempt, then counts the
  // window — see lib/verify-rate. Fails CLOSED.
  const gate = await mayStartVerification(e164, user.id);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: verifyGateRefusal(gate) },
      { status: gate.failed ? 503 : 429 },
    );
  }

  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!,
    );
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
      .verifications.create({ to: e164, channel: "sms" });

    return NextResponse.json({ ok: true, sentTo: e164 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not send the code.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
