"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createHash } from "node:crypto";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { getMyVendorId } from "./data";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { notify } from "@/lib/notify";
import { allowsNotification } from "@/lib/notif-gate";
import { settleJob } from "@/lib/automation";
import { todayLakeDate } from "@/lib/booking";
import { getFullProfile, toPricingProfile } from "@/app/profile/data";
import { loadParkRatesChecked } from "@/app/park/rate-data";
import type { ParkRates } from "@/lib/park-rates";
import {
  summariseCorrection, correctionMessage, noAnswerOutcome, completionBlock,
  arrivalFlagRefusal, arrivalNoteMessage,
  type TimedRule,
} from "@/lib/arrival";
import { html } from "@/lib/html-safe";
import { planRecovery } from "@/lib/recovery";

// Only these profile fields may be changed by a crew flag, with safe values.
// THE CEILING IS PER FIELD, NOT GLOBAL. 99 was chosen for pier sections and
// boat lifts. A lakefront wall of glass routinely runs past 99 panes, and the
// old shared clamp would have DROPPED the key — sanitizeProposed then returns
// null if it was the only one, and the crew's correction is filed as a bare
// note with no error. 999 matches the CHECK on the column (0159).
const COUNT_MAX: Record<string, number> = {
  pier_sections: 99, boat_lifts: 99, pwc_lifts: 99, jet_skis: 99, toy_lifts: 99,
  panes: 999,
};
/** A photo slot is a slug: lower-case, digits, underscore, hyphen, 1-40. */
const SLOT_SHAPE = /^[a-z0-9_-]{1,40}$/;
const BAND_FIELDS = new Set(["lawn_band", "drive_band"]);
const BANDS = new Set(["small", "medium", "large"]);
function sanitizeProposed(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const max = COUNT_MAX[k];
    if (max !== undefined) {
      const n = Math.floor(Number(v));
      if (Number.isFinite(n) && n >= 0 && n <= max) out[k] = n;
    } else if (BAND_FIELDS.has(k) && typeof v === "string" && BANDS.has(v)) {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  photoCount?: number;
  /**
   * SOMETHING TRUE THE ACTION COULD NOT DO. The write succeeded; a notice it
   * promised did not. Used by `releaseJob`, whose toast used to say "the owner
   * has been told" unconditionally while the send's own answer was discarded.
   */
  note?: string;
}

/**
 * Confirm the job is assigned to the signed-in vendor. Returns the job row or null.
 *
 * `null` means ONE thing: this job is not yours. A failed read THROWS instead —
 * every caller below turns that into a sentence, because "That job isn't on your
 * route" said to a crew standing on the property is a lie, not a refusal.
 */
async function assertVendorJob(jobId: string) {
  const vendorId = await getMyVendorId();
  if (!vendorId) return null;
  const admin = createServiceClient();
  const data = mustRead(
    "your job",
    await admin
      .from("jobs")
      // Deliberately NO customer_price / vendor_cost: this is the crew code path,
      // and rule 1 forbids a vendor from ever seeing menu price or margin. Keeping
      // those columns out of reach by construction (settleJob re-loads them ops-side).
      .select("id, status, vendor_id, service_id, date, property_id, group_id, held_at, no_show_at, stood_down_at, services(name, min_photos, needs_interior_access)")
      .eq("id", jobId)
      .maybeSingle(),
  );
  if (!data || data.vendor_id !== vendorId) return null;
  return data;
}

type VendorJob = Awaited<ReturnType<typeof assertVendorJob>>;

/**
 * Upload one job photo. The crew's device sends the image in a FormData; the
 * file goes to a PRIVATE storage bucket and only a row (job_id + path) is kept.
 */
export async function uploadJobPhoto(jobId: string, form: FormData): Promise<ActionResult> {
  let job: VendorJob;
  try {
    job = await assertVendorJob(jobId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your job", e) };
  }
  if (!job) return { ok: false, error: "That job isn't on your route." };

  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No photo received." };
  const okTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  if (!okTypes.includes(file.type)) return { ok: false, error: "Use a JPG, PNG, WEBP or HEIC photo." };
  if (file.size > 12 * 1024 * 1024) return { ok: false, error: "Photo is too large (max 12MB)." };

  const admin = createServiceClient();
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${jobId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  // WHAT MAKES THIS A PIECE OF EVIDENCE AND NOT JUST A PICTURE (0146).
  //
  // A custody photo has to survive an argument six months later, so three
  // things are captured that the old four-column row could not hold.
  //
  // The HASH is of the bytes we actually stored, taken before the upload, so
  // "this is the same file, unaltered" is answerable against the object.
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // The SLOT is which named shot this is — the list lives on
  // services.required_photo_slots.
  //
  // THIS COMMENT USED TO CLAIM free text was refused rather than stored. It
  // was not: the code clamped to 40 characters and kept whatever arrived. A server
  // action's arguments are client-supplied by construction, so a crew posting
  // by hand could write anything into an evidence column. `slot=constructor`
  // then crashed the customer's own complaint page — see
  // the-slot-that-was-not-a-string.test.ts.
  //
  // A SHAPE, NOT A WHITELIST, and the distinction is deliberate: KNOWN in
  // shot-list.ts is explicitly not a whitelist either, because
  // required_photo_slots is authored in SQL and may name a slot no label
  // exists for yet. Refusing those would show a crew a shorter walk-around
  // than the service asks for. So anything slug-shaped is kept and anything
  // else becomes null — an unlabelled extra photo was always fine.
  const rawSlot = form.get("slot");
  const trimmedSlot = typeof rawSlot === "string" ? rawSlot.trim().toLowerCase() : "";
  const slot = SLOT_SHAPE.test(trimmedSlot) ? trimmedSlot : null;

  // The DEVICE TIME is the file's own modified time, kept BESIDE taken_at and
  // never instead of it. It is NOT EXIF and must never be called capture time.
  // Its worth is that it can DISAGREE with the server clock.
  const deviceTime = Number.isFinite(file.lastModified) && file.lastModified > 0
    ? new Date(file.lastModified).toISOString()
    : null;

  // WHO uploaded it. jobs.vendor_id is the company; a dispute asks who was
  // standing at the dock. Best-effort by design — a failed session read must
  // not refuse a photo the crew is standing there trying to send.
  let takenBy: string | null = null;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    takenBy = user?.id ?? null;
  } catch {
    // logged rather than surfaced: the photo matters more than its author
    console.error("[LakeLife] could not attribute a job photo to a person");
  }

  const { error: upErr } = await admin.storage.from("job-photos").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (upErr) return { ok: false, error: upErr.message };

  const { error: rowErr } = await admin.from("job_photos").insert({
    job_id: jobId, url: path, slot, sha256, taken_by: takenBy, device_time: deviceTime,
  });
  if (rowErr) return { ok: false, error: rowErr.message };

  // Stamp the crew's clock-in on the first photo (scoring: actual job duration).
  // Best-effort, only if not already set.
  await admin.from("jobs").update({ started_at: new Date().toISOString() }).eq("id", jobId).is("started_at", null);

  const countRes = await admin
    .from("job_photos")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  // The photo IS uploaded, so this cannot fail the action. But `count ?? 0` sent
  // back a zero the card would have displayed — the counter jumping backwards
  // right after a successful upload. Omitting photoCount instead makes the card
  // fall back to its own +1, which is the one thing we do know for certain.
  if (countRes.error) {
    console.error("[read failed] the photo count after upload:", countRes.error);
    return { ok: true };
  }
  return { ok: true, photoCount: countRes.count ?? 0 };
}

/**
 * Mark a job complete — HARD photo gate (CLAUDE.md rule 2): cannot complete,
 * and payout cannot release, without at least the service's min_photos.
 * On success: status -> complete, an invoice is raised, the vendor payout is
 * released (photo-verified), and the owner gets the "done + photos" text.
 */
export async function completeJob(jobId: string): Promise<ActionResult> {
  let job: VendorJob;
  try {
    job = await assertVendorJob(jobId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your job", e, { money: true }) };
  }
  if (!job) return { ok: false, error: "That job isn't on your route." };
  if (job.status === "complete" || job.status === "paid") {
    return { ok: false, error: "That job is already complete." };
  }

  // 0084's trigger is the real gate and stays the real gate. This exists so a
  // crew gets a sentence instead of a raw constraint violation — the same
  // reason canApprove exists on the park side.
  const blocked = completionBlock(job as {
    held_at?: string | null; no_show_at?: string | null; stood_down_at?: string | null;
  });
  if (blocked) return { ok: false, error: blocked };

  // A job can only be closed on or after the day it's scheduled — no closing
  // (and no payout) on work that isn't due yet.
  if (job.date && String(job.date) > todayLakeDate()) {
    return { ok: false, error: "This job isn't scheduled until later — you can complete it on the day." };
  }

  const svc = (Array.isArray(job.services) ? job.services[0] : job.services) as
    | { name?: string; min_photos?: number }
    | null;
  if (!job.service_id || !svc) return { ok: false, error: "This job has no service set — call Ops." };
  let minPhotos = svc.min_photos ?? 0;

  const admin = createServiceClient();
  // Package visit (rule 2 across legs): the gate is the SUM of every leg's
  // minimum — a haul-winterize-wrap-store visit needs its at-dock,
  // on-trailer, wrapped and racked shots, not just the anchor's two. The
  // condition photos ARE the custody baseline that settles spring disputes.
  const groupId = (job as { group_id?: string | null }).group_id ?? null;
  if (groupId) {
    const legsRes = await admin
      .from("job_items").select("services(min_photos)").eq("job_id", jobId);
    // THE GATE GETS WEAKER, NOT LOUDER, IF THIS IS ALLOWED TO FAIL QUIETLY.
    // An unread leg list leaves minPhotos at the ANCHOR service's minimum, so a
    // six-photo custody baseline becomes a two-photo one and the payout releases
    // against it. Rule 2 is not something to infer from a dropped connection.
    if (legsRes.error) {
      return { ok: false, error: readFailedMessage("this visit's photo requirement", legsRes.error, { money: true }) };
    }
    const legs = legsRes.data;
    if (legs && legs.length > 0) {
      minPhotos = legs.reduce((sum, l) => {
        const ls = (Array.isArray(l.services) ? l.services[0] : l.services) as { min_photos?: number } | null;
        return sum + (ls?.min_photos ?? 0);
      }, 0);
    }
  }
  const countRes = await admin
    .from("job_photos")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  // `count ?? 0` cut both ways here. On a service whose minimum is 0 a failed
  // read PASSED the gate; on every other service it refused with "0/6 uploaded"
  // to a crew looking at six photos on their own screen — and the counter in
  // that sentence would never move however many more they took.
  if (countRes.error) {
    return { ok: false, error: readFailedMessage("the photos on this job", countRes.error, { money: true }) };
  }
  const photoCount = countRes.count ?? 0;
  if (photoCount < minPhotos) {
    return {
      ok: false,
      photoCount,
      error: `Photos required — no photos, no payout. ${photoCount}/${minPhotos} uploaded.`,
    };
  }

  // Idempotent complete: only a job that is still open transitions, and the
  // WHERE clause guarantees exactly one caller wins — so a double-tap or retry
  // can't raise two invoices or release two payouts.
  const { data: changed, error } = await admin
    .from("jobs")
    .update({ status: "complete", completed_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["scheduled", "in_progress", "requested"])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!changed || changed.length === 0) {
    return { ok: false, error: "That job is already complete." };
  }

  // CUSTODY BEGINS (S3): a completed fall visit with a reserved stay flips
  // it to in_storage and stamps intake_at — the timestamp the season-end
  // and per-diem math hang off. Guarded flip: only a reserved stay moves.
  if (groupId) {
    await admin
      .from("storage_stays")
      .update({ status: "in_storage", intake_at: new Date().toISOString() })
      .eq("group_id", groupId)
      .eq("status", "reserved");
  }

  // Settle the job: payout + invoice + auto-charge + receipt. Extracted into an
  // IDEMPOTENT helper (checks-then-writes) so a partial failure here is
  // recoverable — the nightly reconcile sweep re-runs it for any job left
  // completed-but-unbilled. rule 4: only the vault token is ever charged.
  await settleJob(jobId);

  // "Service complete — with photos" text to the owner (best effort), now
  // carrying the one-tap quality check: the CUSTOMER is the auditor (Phase E
  // design). 👍 builds the crew's trust record; 👎 pings the crew to make it
  // right — never an ops queue.
  const propRes = await admin
    .from("properties")
    .select("address, users(id, phone, email)")
    .eq("id", job.property_id)
    .maybeSingle();
  // Swallowed on purpose — the job is complete and the payout has settled; a
  // missing "we're done" text must not undo that. Logged, because "no phone on
  // file" and "we couldn't look" send exactly the same number of texts.
  if (propRes.error) console.error("[read failed] who to tell the job is done:", propRes.error);
  const prop = propRes.data;
  const ownerUser = (Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as
    { id?: string; phone?: string; email?: string } | null;
  const ownerPhone = ownerUser?.phone;
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  let confirmLinks = "";
  // The same two links, laid out for an inbox rather than a text bubble.
  let confirmLines = "";
  try {
    const { data: conf, error: confErr } = await admin
      .from("job_confirmations")
      .insert({ job_id: jobId, property_id: job.property_id, vendor_id: job.vendor_id })
      .select("confirm_token")
      .single();
    // Swallowed on purpose — the completion text still goes out without the
    // links — but logged: no token means the customer-as-auditor check quietly
    // isn't on this job, and the crew's trust record never hears about it.
    if (confErr) console.error("[read failed] this job's confirmation link:", confErr);
    if (conf?.confirm_token) {
      confirmLinks = ` All good? ${site}/c/${conf.confirm_token}/good — something off? ${site}/c/${conf.confirm_token}/issue`;
      confirmLines =
        `\n\nAll good?\n  ${site}/c/${conf.confirm_token}/good` +
        `\n\nSomething off?\n  ${site}/c/${conf.confirm_token}/issue`;
    }
  } catch {
    /* pre-migration or duplicate row — the completion text still goes out */
  }
  // BOTH SWITCHES, NOT ONE. "Service complete — with photos" has always been a
  // "Text + email" type on the settings screen, so each channel has its own
  // switch and each is asked separately here — the email is the one this type
  // was already promised on, not a new message. It matters more than it looks:
  // these two links are how the customer audits the job, and the 👎 is what
  // holds the crew's pay. On text alone that choice reached nobody since July.
  const [doneBySms, doneByEmail] = await Promise.all([
    allowsNotification(ownerUser?.id, "done", "sms"),
    allowsNotification(ownerUser?.id, "done", "email"),
  ]);
  if ((ownerPhone && doneBySms) || (ownerUser?.email && doneByEmail)) {
    await notify(
      "the owner that their service is done and their photos are up",
      {
        phone: doneBySms ? ownerPhone : null,
        email: doneByEmail ? ownerUser?.email : null,
      },
      {
        // "YOUR PROPERTY LOG" DOES NOT EXIST. Every completion message — the
        // first sentence a homeowner reads after the work — sent them to a
        // screen with no route. The photos live on the job page, so that is
        // what is named and linked.
        sms: `LakeLife: ${svc?.name ?? "Your service"} is done at ${prop?.address ?? "your place"} — ${photoCount} photos are on your job page: ${site}/requests/${jobId}${confirmLinks} 🌊`,
        subject: `${svc?.name ?? "Your service"} is done at ${prop?.address ?? "your place"}`,
        body:
          `${svc?.name ?? "Your service"} is done at ${prop?.address ?? "your place"} — ` +
          `${photoCount} photos are on your job page:\n  ${site}/requests/${jobId}${confirmLines}`,
      },
    );
  }

  return { ok: true, photoCount };
}

/** Vendor flags a profile discrepancy — goes to the owner for approval (rule 6). */
export async function submitFlag(
  jobId: string,
  type: string,
  note: string,
  proposedChange: Record<string, unknown> | null,
  /**
   * TRUE when the crew is standing on site and has not started yet.
   *
   * This is the difference between a note and a stop sign. An at-arrival
   * discrepancy HOLDS the job: 0084's trigger refuses to let it complete until
   * the owner decides, so the extra work can never be done-and-billed-later
   * the way it used to be. An ordinary correction, filed any other time,
   * stops nothing.
   */
  atArrival = false,
  /**
   * Only meaningful with `atArrival`. THE QUESTION ONLY THE CREW CAN ANSWER:
   * if the owner says no, can the booked job still be done?
   *
   * "Do it as booked" assumes every job is divisible, and plenty are not — a
   * pier REMOVAL at 8 of 12 sections leaves four in the water for the ice.
   * When this says no, declining stands the crew down instead of sending them
   * at an impossible scope (0088).
   */
  scope?: { canProceed: boolean; cannotReason?: string },
): Promise<ActionResult> {
  let job: VendorJob;
  try {
    job = await assertVendorJob(jobId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your job", e) };
  }
  if (!job) return { ok: false, error: "That job isn't on your route." };
  if (job.status === "complete" || job.status === "paid") {
    return { ok: false, error: "That job is already closed out." };
  }

  const admin = createServiceClient();
  const proposed = sanitizeProposed(proposedChange);

  // COUNTS OR WORDS, AND NEVER NEITHER. This used to demand a proposed change,
  // which is why the arrival sheet had no door for a problem that isn't a
  // number — and why a crew whose pier was already out of the water had to
  // invent one, for the owner to approve into their profile.
  // `proposedChange` (raw) as well as `proposed` (sanitized): a count the
  // sanitizer dropped must be refused, not quietly refiled as a note.
  const arrivalRefusal = atArrival ? arrivalFlagRefusal(proposed, note, proposedChange) : null;
  if (arrivalRefusal) return { ok: false, error: arrivalRefusal };
  if (atArrival && scope && !scope.canProceed && !scope.cannotReason?.trim()) {
    // The owner is being asked to choose between two outcomes. They cannot
    // choose blind, and 0088's check constraint would refuse the row anyway.
    return { ok: false, error: "Say why the booked job can't be done." };
  }

  const { data: flagRow, error } = await admin.from("flags").insert({
    job_id: jobId,
    vendor_id: job.vendor_id,
    type,
    note: note.trim().slice(0, 500) || "Flagged on site by crew.",
    proposed_change: proposed,
    status: "pending",
    at_arrival: atArrival,
    ...(atArrival && scope
      ? {
          crew_can_proceed: scope.canProceed,
          crew_cannot_reason: scope.canProceed ? null : (scope.cannotReason ?? "").trim(),
        }
      : {}),
  }).select("id").single();
  if (error || !flagRow) return { ok: false, error: error?.message ?? "Couldn't file that." };

  // HOLD THE WORK. Rule 6 said a flag changes nothing until the owner
  // approves; what was missing is that nothing STOPPED. The crew could flag
  // twelve sections and complete the job in the same visit, so the owner was
  // billed for eight, the crew was paid for eight, and the approval landed
  // afterwards with nothing left to decide.
  if (atArrival) {
    const { error: holdErr } = await admin
      .from("jobs")
      .update({ held_at: new Date().toISOString(), held_flag_id: flagRow.id })
      .eq("id", jobId);
    if (holdErr) {
      // The hold is the point. Without it this is the old behaviour wearing a
      // new label, so the flag comes back out rather than sitting there
      // looking like it stopped something.
      await admin.from("flags").delete().eq("id", flagRow.id);
      return { ok: false, error: "Couldn't hold the job — try again before you start." };
    }
  }

  // TELL THE OWNER. Rule 6 means a flag reprices nothing and bills nothing
  // until they approve it — which is right, and which is exactly why it has to
  // reach them. This was a bare INSERT: the crew was told "the owner sees it in
  // Approvals, and Ops has a copy", and no text, no email and no ops item ever
  // went anywhere. A crew counting twelve pier sections against a profile of
  // eight did the extra work for nothing until somebody happened to open
  // /approvals. The 'appr' notification type has existed since the start and
  // was declared in NOTIF_DEFS and sent by nobody.
  //
  // Nothing here can fail the flag. It is already filed; a notification that
  // throws must not undo it.
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const svc = (Array.isArray(job.services) ? job.services[0] : job.services) as
      { name?: string } | null;
    const svcName = svc?.name ?? "your service";

    const propRes = await admin
      .from("properties")
      .select("address, nickname, users(id, name, email, phone)")
      .eq("id", job.property_id as string)
      .maybeSingle();
    // Swallowed on purpose (the flag is already filed and the hold is on), but
    // never silently: an unread owner is an owner who is never asked, and the
    // crew has already been told "the owner sees it in Approvals".
    if (propRes.error) console.error("[read failed] who to ask about this flag:", propRes.error);
    const prop = propRes.data;
    const owner = (Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as
      { id?: string; name?: string; email?: string; phone?: string } | null;
    const where = (prop?.nickname as string) || (prop?.address as string) || "your place";

    // WHAT THEY ARE BEING ASKED, IN NUMBERS.
    //
    // The owner asked that the crew "give added pricing"; rule 1 forbids a
    // vendor from ever seeing a customer price. Both hold at once because the
    // CREW sends the count and the SERVER turns it into money — computed here,
    // sent to the homeowner, and never returned to the crew's browser.
    //
    // The time is included too. Since 0083 a bigger job is also a longer one,
    // and somebody deciding on their phone at 7:45 usually cares more that the
    // crew will be there another hour and a quarter than about the money.
    let detail = "";
    // WORDS, NOT COUNTS. The generic fallback below says the crew "found
    // something that doesn't match your profile" — true of a correction, and
    // exactly wrong for the door that exists because the problem isn't a
    // count. The crew's own sentence is the whole of what there is to say.
    if (atArrival && !proposed && note.trim()) {
      detail = arrivalNoteMessage({ note, where, serviceName: svcName });
    }
    if (atArrival && proposed) {
      try {
        const [ruleRes, profile] = await Promise.all([
          admin.from("services")
            .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands, needs_interior_access, crew_priced")
            .eq("id", job.service_id as string).maybeSingle(),
          // asService: the caller is the CREW, and the default path is owner-scoped.
          // Without this it returned {hasProfile:false} — truthy, so no throw,
          // no log — and every owner got the generic message with no numbers.
          getFullProfile(job.property_id as string, { asService: true }),
        ]);
        // Same failure mode the asService comment below describes, one layer
        // down: an unread rule drops the numbers out of the owner's message and
        // they get the generic "found something" text with nothing to decide on.
        if (ruleRes.error) console.error("[read failed] the pricing rule for this correction:", ruleRes.error);
        const rule = ruleRes.data;
        if (rule && profile?.hasProfile) {
          // THE PARK'S OWN NUMBER, IN THE TEXT AND THE EMAIL (0176).
          //
          // This composed the sentence the owner reads on their phone off
          // LakeLife's RETAIL card, while `approveFlag` bills the same
          // correction off the park's own row. Two numbers for one decision —
          // on The Haven's 28-section dock, $1,564 against $840. `parkRates`
          // is `null` for every lake house, which leaves this call exactly
          // what it was.
          //
          // A FAILED READ SENDS NO NUMBERS, not retail ones: `detail` stays ""
          // and the generic "found something that doesn't match your profile"
          // message goes out — the same degraded message an unread pricing
          // rule already produces two lines above.
          let parkRates: ParkRates | null = null;
          if (profile.groundsForParkId) {
            const got = await loadParkRatesChecked(profile.groundsForParkId);
            if (got.failed) throw new Error("park rates unreadable");
            parkRates = got.rates;
          }
          const summary = summariseCorrection(
            rule as unknown as TimedRule,
            toPricingProfile(profile),
            proposed as Parameters<typeof summariseCorrection>[2],
            parkRates,
          );
          detail = correctionMessage(summary, {
            serviceName: (rule.name as string) ?? svcName,
            crewName: null,
          });
        }
      } catch {
        /* A message that can't be built must not lose the hold. */
      }
    }

    // THE SWITCH THEY CAN SEE GOVERNED THE CHANNEL THAT DOESN'T WORK.
    //
    // "Approval needed from a crew flag" was declared a TEXT-ONLY type, so the
    // settings screen drew one chip — SMS — and the text is on the channel that
    // has delivered nothing since 19 July. The email below then went out with
    // no gate on it at all: the message that actually arrives was the one the
    // customer had no way to stop, and the one they could stop never arrived.
    //
    // The def now says "Text + email" and the email asks the same question the
    // text does. Nobody's mail changes today — `appr` defaults on and no
    // customer can have saved an email row for a chip that was never drawn —
    // but from here the switch means what it says.
    const [apprBySms, apprByEmail] = await Promise.all([
      allowsNotification(owner?.id, "appr", "sms"),
      allowsNotification(owner?.id, "appr", "email"),
    ]);
    if (owner?.phone && apprBySms) {
      void sendSms(
        owner.phone,
        detail
          ? `LakeLife: ${detail} ${site}/approvals 🌊`
          : `LakeLife: the crew at ${where} found something that doesn't match your ` +
            `profile on your ${svcName}. Nothing changes and nothing is charged until ` +
            `you say yes: ${site}/approvals 🌊`,
        // Bypasses notify(), so it labels its own receipt row.
        { kind: "profile correction to approve" },
      );
    }
    if (owner?.email && apprByEmail) {
      void sendEmail({
        to: owner.email,
        subject: `A quick check on your ${svcName}`,  // a header, not a body — not HTML
        // `detail` carries a sentence a crew TYPED (arrivalNoteMessage), and
        // the name and nickname beside it are typed by people too. The tag
        // escapes all of them; nothing here needs raw().
        html: html`<p>Hi ${owner.name ?? "there"},</p>${
          detail
            ? html`<p>${detail}</p>`
            : html`<p>The crew at ${where} found something on site that doesn't match what we have on file for your ${svcName}.</p>`
        }<p><b>Nothing has changed and nothing has been charged.</b> It waits for you.</p><p><a href="${site}/approvals">Take a look</a></p><p>🌊</p>`,
      });
    }
  } catch {
    /* The flag is filed. A failed notification must never lose it. */
  }

  return { ok: true };
}

/**
 * NOBODY IS ANSWERING.
 *
 * The owner's rule: "If the crew doesnt need to get into the house then do the
 * work or it becomes a no show, reschedule if both parties agree or they get
 * charged."
 *
 * So the crew never has to decide. The SERVICE already knows whether it needs
 * to get inside (0084), and this refuses to record a no-show for work that
 * could simply have been done — otherwise "no answer" quietly becomes the
 * easiest way to end a hot afternoon early.
 */
export async function recordNoShow(jobId: string, reason: string): Promise<ActionResult> {
  let job: VendorJob;
  try {
    job = await assertVendorJob(jobId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your job", e) };
  }
  if (!job) return { ok: false, error: "That job isn't on your route." };
  if (job.status === "complete" || job.status === "paid") {
    return { ok: false, error: "That job is already closed out." };
  }
  // ONE TRIP, ONE RECORD. Two crew on one login — phone and tablet, both with
  // the route open — could each tap "Nobody's answering" and mint a second
  // attempt row, a second $35 trip payout, and a second "we couldn't get in"
  // email to the homeowner. Every other money path in this file uses a
  // conditional write that exactly one caller wins; this insert did not.
  if (job.no_show_at) {
    return { ok: false, error: "Already recorded as a no-show — nothing more to do here." };
  }

  // AND THE DAY, WHICH completeJob CHECKS AND THIS DID NOT.
  //
  // 380 lines up, completeJob refuses to close out work that is not due yet —
  // "no closing (and no payout) on work that isn't due yet". The sibling action
  // that closes the same visit the OTHER way had no such test, and it also
  // releases money: the nightly funds a $35 trip fee per attempt row. So a
  // Wednesday tap on a Friday job paid for a trip nobody made, emailed the
  // homeowner "our crew was at your place today" about a visit two days out,
  // and — because 0084's trigger refuses to complete a job while no_show_at is
  // set, and only the CUSTOMER's reschedule clears it — bricked the booked
  // visit until they acted, inside a window that closes.
  //
  // One-directional on purpose: a crew recording yesterday's no-show this
  // morning is legitimate and common. Only the future is refused.
  if (job.date && String(job.date) > todayLakeDate()) {
    return {
      ok: false,
      error: "That visit isn't until later — you can record a no-show on the day.",
    };
  }

  const why = reason.trim().slice(0, 300);
  if (!why) {
    // The customer may be charged for this. They are entitled to know what
    // happened, in the words of the person who was standing there.
    return { ok: false, error: "Say what happened — the owner may be charged for this." };
  }

  const admin = createServiceClient();
  const ruleRes = await admin
    .from("services").select("name, needs_interior_access, needs_release")
    .eq("id", job.service_id as string).maybeSingle();
  // THE GUARD BELOW IS GUARDED BY `rule &&`, SO A FAILED READ SKIPPED IT.
  //
  // That is the whole check — the one that refuses to call it a no-show when
  // the work never needed anybody to open a door. Silently switched off, a
  // dropped connection would write the attempt row, mint the trip payout, and
  // send the homeowner "we couldn't get in" about a pier the crew could have
  // pulled without knocking. It has to be read, not assumed.
  if (ruleRes.error) {
    return { ok: false, error: readFailedMessage("what this service needs", ruleRes.error) };
  }
  const rule = ruleRes.data;

  if (rule && noAnswerOutcome(rule as { needs_interior_access?: boolean | null; needs_release: boolean | null }) === "proceed_as_booked") {
    return {
      ok: false,
      error:
        `${(rule.name as string) ?? "This work"} doesn't need anyone to let you in or ` +
        `hand anything over — go ahead and do it as booked. If something is genuinely ` +
        `in the way, flag it instead so the owner can sort it.`,
    };
  }

  // THE ATTEMPT IS WRITTEN DOWN FIRST, and it is append-only. Rescheduling
  // clears the job's live no-show columns so the work can run again; without
  // this row, the trip the crew made would vanish with them (0089's trigger
  // refuses the clear if it is missing).
  const today = todayLakeDate();
  const attemptRes = await admin.from("job_visit_attempts").insert({
    job_id: jobId,
    vendor_id: job.vendor_id,
    attempted_on: today,
    outcome: "no_access",
    reason: why,
  }).select("id").single();
  if (attemptRes.error) return { ok: false, error: attemptRes.error.message };

  const plan = planRecovery("no_access", today, {
    serviceName: (rule?.name as string) ?? "your service",
  });

  // THE CLAIM, NOT A READ. The `if (job.no_show_at)` above is a check against a
  // value read four round trips ago — the comment beside it describes exactly
  // the race it does not prevent. `.is("no_show_at", null)` makes the UPDATE
  // itself the lock, so of two crew tapping "Nobody's answering" on one shared
  // login, exactly one wins.
  //
  // The attempt row is still written FIRST, because 0089's trigger refuses to
  // clear no_show_at without one — claiming the job first and then failing to
  // insert would strand a visit nobody could reschedule. So the LOSER removes
  // the row it just added: one request rolling back its own write, before
  // anything has read it, not an edit to the append-only history.
  const claimed = await admin
    .from("jobs")
    .update({
      no_show_at: new Date().toISOString(),
      no_show_reason: why,
      recovery_state: "awaiting_customer",
      reschedule_deadline: plan.deadline,
    })
    .eq("id", jobId)
    .is("no_show_at", null)
    .select("id");
  if (claimed.error) {
    await admin.from("job_visit_attempts").delete().eq("id", attemptRes.data.id);
    return { ok: false, error: claimed.error.message };
  }
  if (!claimed.data || claimed.data.length === 0) {
    // Somebody else recorded it while this request was in flight. Take our
    // attempt row back out so the nightly does not fund a second $35 trip.
    await admin.from("job_visit_attempts").delete().eq("id", attemptRes.data.id);
    return { ok: false, error: "Already recorded as a no-show — nothing more to do here." };
  }

  // Ops picks this up: a no-show is a conversation (reschedule by agreement,
  // else the cancellation policy), never an automatic charge. Nobody is billed
  // by a crew tapping a button on a doorstep.
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const propRes = await admin
      .from("properties").select("address, nickname, users(id, name, email, phone)")
      .eq("id", job.property_id as string).maybeSingle();
    // Swallowed on purpose — the no-show is recorded and must stay recorded —
    // but an owner who is never emailed can't take the reschedule window they
    // are being timed against, so the failure has to exist somewhere.
    if (propRes.error) console.error("[read failed] who to tell we couldn't get in:", propRes.error);
    const prop = propRes.data;
    const owner = (Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as
      { id?: string; name?: string; email?: string; phone?: string } | null;
    const where = (prop?.nickname as string) || (prop?.address as string) || "your place";
    const svcName = (rule?.name as string) ?? "your service";

    if (owner?.email) {
      void sendEmail({
        to: owner.email,
        subject: `We couldn't get in for your ${svcName}`,
        // `why` is a sentence the crew TYPED on the doorstep, and the nickname
        // and name beside it are typed by people too. The tag escapes all of
        // them; nothing here needs raw().
        //
        // The last line is WHAT SILENCE COSTS, SAID NOW. Finding out later that
        // a window existed and closed is the version of this that makes people
        // angry, and rightly.
        html: html`<p>Hi ${owner.name ?? "there"},</p><p>Our crew was at ${where} today for your ${svcName} and couldn't get inside to do the work.</p><p><i>${why}</i></p><p><b>You have not been charged.</b> ${plan.ask}</p><p><a href="${site}/requests">Pick another day</a></p><p class="mut">${plan.ifNothingHappens}</p><p>🌊</p>`,
      });
    }
  } catch {
    /* The no-show is recorded. A failed notice must not undo it. */
  }

  return { ok: true };
}

/**
 * HAND A JOB BACK — the door §11.1 of the crew terms has always promised.
 *
 * "Crews may accept or reject jobs" is in the agreement Josh signs. This file
 * exported five actions and not one of them was a decline or a release, so the
 * only two exits a crew had were to ring somebody or to ghost it — and ghosting
 * writes a permanent `vendor_no_shows` strike (unique(job_id), it never
 * clears) that `demoteLakeStrikes` counts until they lose the lake. Under
 * choose-your-crew a BUYER picks this crew off their rate card, which makes
 * the missing "no" sharper, not softer.
 *
 * THE SMALLEST HONEST DOOR, and each limit is load-bearing:
 *
 *   FUTURE-DATED ONLY. Releasing today's or yesterday's job is not advance
 *   notice, it is a no-show with better manners — and `recordNoShow` /
 *   `recordNoShows` are where that already lives, with their own rules. The
 *   boundary is the same one `completeJob` uses, read the other way round.
 *
 *   NOT A NO-SHOW. No strike, no trip fee, no touch on standing or payouts.
 *   Punishing advance notice would make ghosting the cheaper option.
 *
 *   THE REASON IS REQUIRED AND IS WRITTEN DOWN (0177). Without a row the
 *   release is invisible the instant somebody else claims the job — the
 *   difference between "nobody ever wanted this" and "one crew handed it back
 *   on Tuesday" would be gone, and ops could not tell whether a crew is
 *   quietly handing back the same work every week.
 *
 *   THE JOB GOES BACK TO THE BOARD UNASSIGNED AND THE BUYER IS TOLD — and is
 *   told the truth, which is that we are looking for another crew AT THE PRICE
 *   THEY AGREED TO. The frozen price columns are deliberately left alone, so
 *   `autoAssignJob`'s agreed-price guard refuses anybody who would charge a
 *   different number.
 *
 *   NOT A FULL "NO AUTO-SWAP". An automatic fill at the SAME price still
 *   happens — `sweepWaitlist` picks this job up the same night — and on a job
 *   where the buyer CHOSE this crew off their rate card, even that is a
 *   substitution of the business they hired. Stopping it needs a marker on the
 *   job that dispatch reads; that, and what a consent screen would need, are
 *   named in the report and deliberately not half-built here.
 */
export async function releaseJob(jobId: string, reason: string): Promise<ActionResult> {
  let job: VendorJob;
  try {
    job = await assertVendorJob(jobId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your job", e) };
  }
  if (!job) return { ok: false, error: "That job isn't on your route." };
  if (job.status === "complete" || job.status === "paid") {
    return { ok: false, error: "That job is already closed out — nothing to hand back." };
  }
  if (job.status === "in_progress") {
    return { ok: false, error: "You've already started this one. Finish it with photos, or flag what's in the way." };
  }
  // The driveway facts (0084/0088). A visit already recorded as unworked is in
  // the recovery flow, and handing it back would strand the customer's
  // reschedule window in a job with no crew attached to it.
  if (job.no_show_at || job.stood_down_at) {
    return { ok: false, error: "This visit is already recorded as unworked — it's with the owner now." };
  }
  if (job.held_at) {
    return { ok: false, error: "The owner is deciding on a correction for this one. It can't be handed back mid-decision." };
  }
  const today = todayLakeDate();
  if (!job.date || String(job.date) <= today) {
    return {
      ok: false,
      error: "Today's and past jobs can't be handed back — that's a no-show, not notice. Do the work, or record what happened on the day.",
    };
  }

  const why = reason.trim().slice(0, 300);
  if (!why) {
    // The customer is about to be told their crew has gone. They are entitled
    // to know why, in the words of the crew who dropped it.
    return { ok: false, error: "Say why you can't make it — the owner is told, and they're owed a reason." };
  }

  const admin = createServiceClient();

  // RULE 2 IS A COUNT ON THE JOB, NOT ON THE CREW — SO PHOTOS CANNOT BE LEFT
  // BEHIND FOR SOMEBODY ELSE TO COMPLETE AGAINST.
  //
  // `completeJob` counts `job_photos` by `job_id` with no vendor scoping, and
  // so does 0050's trigger (`select count(*) from public.job_photos where
  // job_id = new.id`). `uploadJobPhoto` has no date guard, and the crew panel
  // draws "Add photos" on a future job right beside "Can't make it". So a crew
  // could photograph a job, hand it back, and the NEXT crew would tap Mark
  // complete with none of their own — and a payout would release against
  // another business's pictures. `recordNoShows` refuses to release a
  // photo-bearing job for exactly this reason; this was the first door that
  // would have.
  //
  // Refused rather than deleted: those photos are the crew's own evidence of
  // something, and this action has no business destroying them.
  const shotRes = await admin
    .from("job_photos").select("id", { count: "exact", head: true }).eq("job_id", jobId);
  // A FAILED COUNT MAKES THIS GUARD PASS if ignored — `(null ?? 0) > 0` is
  // false — which is the precise shape this codebase has paid for. Refuse.
  if (shotRes.error) {
    return { ok: false, error: readFailedMessage("the photos already on this job", shotRes.error) };
  }
  if ((shotRes.count ?? 0) > 0) {
    return {
      ok: false,
      error:
        "You've already got photos on this one, so it can't be handed back — " +
        "those photos would count toward whoever picks it up. Finish it, or flag what's in the way.",
    };
  }

  // THE BOAT IN THE BARN. Same guard `recordNoShows` runs before it records
  // anything, and `revalidateJob` before it rehomes a scheduled package visit:
  // when a spring leg's boat is physically in THIS crew's building, only this
  // crew can do the work, and putting the leg back on the board would split a
  // custody visit across two businesses with the stay still reserved against
  // the group.
  if (job.group_id) {
    const custodyRes = await admin
      .from("storage_stays").select("id")
      .eq("group_id", job.group_id as string)
      .eq("status", "in_storage")
      .limit(1);
    // Fails OPEN if ignored (null reads as "no boat"), which is the stranding
    // this guard exists to prevent. Nothing has been written yet.
    if (custodyRes.error) {
      return { ok: false, error: readFailedMessage("whether a boat of theirs is still in your building", custodyRes.error) };
    }
    if ((custodyRes.data ?? []).length > 0) {
      return {
        ok: false,
        error:
          "Their boat is still in your building, so this visit can't go back on the board — " +
          "only you can do it. Email hello@lakelife.ai and we'll sort the handover.",
      };
    }
  }

  // THE AGREED PRICE STAYS ON THE ROW. THIS IS THE OPPOSITE OF WHAT IT SAID.
  //
  // The first cut of this action copied `claimJob`'s `unfreeze` and nulled
  // `customer_price`, `crew_quote` and the two frozen percentages on any
  // crew-priced job. The precedent does not transfer, and the direction of the
  // mistake is the expensive one:
  //
  //   claimJob's release undoes a price THAT SAME CALL wrote, seconds earlier,
  //   before anybody was told — its own comment says so ("an assignment that
  //   never stuck agreed nothing").
  //
  //   A release undoes a price A CUSTOMER AGREED TO, days ago, at booking.
  //
  // And `autoAssignJob`'s guard against a silent reprice is
  // `if (agreedPrice > 0 && ...)`. Wiping the price sets `agreedPrice` to 0,
  // which DISARMS that guard — so the nightly would have put a new crew on the
  // job at a new number, at night, with nobody told. The wipe did not just
  // lose the sale; it switched off the thing that protects it.
  //
  // Leaving the three frozen columns alone keeps 0174's all-or-nothing CHECK
  // satisfied (nothing is half-written), keeps the customer's number on the
  // row, and lets the existing guard do exactly its job: a crew who quotes the
  // SAME number can still pick the job up, and anybody else is refused and the
  // job stays honestly 'requested'.
  //
  // `vendor_cost` and `margin` ARE cleared below — those are what LakeLife
  // would have paid THIS crew, and this crew is gone.

  // THE RECORD FIRST, THE RELEASE SECOND — the same order `recordNoShow` uses
  // and for the same reason: the row is the only thing that survives the job
  // being re-claimed, and a release with no row is exactly the silent
  // disappearance this action exists to stop. If the guarded UPDATE then loses
  // (somebody re-dispatched it in flight), this request takes its own row back
  // out before anything has read it.
  const recorded = await admin.from("job_releases").insert({
    job_id: jobId,
    vendor_id: job.vendor_id,
    released_on: today,
    reason: why,
  }).select("id").single();
  if (recorded.error) {
    // "TRY AGAIN IN A MOMENT" FOR A PATH THAT CAN NEVER WORK. 0177 creates
    // `job_releases` and is applied by hand; until it lands, Postgres answers
    // 42P01 and every tap of this button would have sent the crew round a
    // retry loop with no end. Say which of the two it is.
    const missing = (recorded.error as { code?: string } | null)?.code === "42P01";
    return {
      ok: false,
      error: missing
        ? "Handing a job back isn't switched on yet — nothing has changed. Email hello@lakelife.ai and we'll take it off you."
        : "We couldn't record that just now, so nothing has changed. Try again in a moment.",
    };
  }

  // THE CLAIM, NOT A READ. `.eq("vendor_id", ...)` makes the UPDATE itself the
  // lock, so a job the nightly re-dispatched while this request was in flight
  // is not yanked out from under its new crew.
  //
  // 0174: the frozen price columns are deliberately UNTOUCHED — see the long
  // note above. The customer's number stays on the row, which is what keeps
  // `autoAssignJob`'s agreed-price guard armed.
  const released = await admin
    .from("jobs")
    .update({
      vendor_id: null,
      vendor_cost: null,
      margin: null,
      status: "requested",
      // THE STOP COMES OFF THE ROUTE TOO. `revalidateJob`'s own release nulls
      // both of these, and the nightly route rebuild only clears them for
      // rows still in `scheduled` — which a released job is not. Left set,
      // the job keeps a position in a drive order it is no longer part of.
      route_id: null,
      sequence: null,
    })
    .eq("id", jobId)
    .eq("vendor_id", job.vendor_id as string)
    .in("status", ["scheduled", "requested"])
    .select("id");
  if (released.error || !released.data || released.data.length === 0) {
    await admin.from("job_releases").delete().eq("id", recorded.data.id);
    return {
      ok: false,
      error: released.error
        ? "We couldn't hand that back just now, so nothing has changed. Try again in a moment."
        : "That job has already moved on — it isn't yours any more.",
    };
  }

  // THE BUYER IS TOLD — AND TOLD WHAT ACTUALLY HAPPENS NEXT.
  //
  // THE FIRST DRAFT OF THIS SAID "we have NOT put somebody else on it — that's
  // your call", AND IT WAS FALSE WITHIN HOURS. A released job is
  // `status='requested'`, `vendor_id` null, dated in the future — which is
  // exactly `sweepWaitlist`'s query. That sweep runs in the nightly, again in
  // the intraday, and again the moment any crew claims into the lake; the
  // nightly self-heal (`revalidateJob`) reaches it too. The owner would then
  // get "good news — a crew is locked in", having just been promised nobody
  // would be put on it. Nothing excludes the releasing crew either, so it
  // could even have gone straight back to them the same night.
  //
  // WHAT IS TRUE, and what this now says: the job goes back to looking for a
  // crew, the price the customer agreed to is unchanged and protected (see the
  // note on the frozen columns above — `autoAssignJob` refuses anybody who
  // would charge a different number), they are told the moment somebody picks
  // it up, and they can cancel or choose instead.
  //
  // WHAT IS STILL OPEN, and is the owner's call, not a bug to paper over: if a
  // buyer CHOSE this crew off their rate card, even a same-price fill is a
  // substitution of the business they hired. Refusing automatic fills on a
  // chosen crew needs a marker on the job that dispatch reads, which is named
  // in the report and deliberately not half-built here.
  //
  // Post-write and best-effort: the job is already back on the board, so a
  // failed notice cannot undo it — but a customer whose crew has silently come
  // off their calendar finds out from an empty driveway.
  let note: string | undefined;
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const propRes = await admin
      .from("properties").select("address, nickname, users(name, email, phone)")
      .eq("id", job.property_id as string).maybeSingle();
    if (propRes.error) console.error("[read failed] who to tell their crew handed the job back:", propRes.error);
    const prop = propRes.data;
    const owner = (Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as
      { name?: string; email?: string; phone?: string } | null;
    const where = (prop?.nickname as string) || (prop?.address as string) || "your place";
    const svcName = ((Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string } | null)?.name
      ?? "your service";
    const pretty = new Date(String(job.date) + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });
    if (owner?.phone || owner?.email) {
      const told = await notify(
        `the owner that their crew handed back ${svcName} (job ${jobId})`,
        { phone: owner?.phone ?? null, email: owner?.email ?? null },
        {
          // NEVER "we've found you another crew" — nobody has been found. And
          // never "nobody will be put on it" either, which is the promise the
          // waitlist sweep breaks. Say that it is back to looking, and that
          // the price they agreed to does not move.
          sms: `LakeLife: the crew for your ${svcName} on ${pretty} can't make it and handed it back — you haven't been charged. We're looking for another crew at the same price, and we'll tell you the moment one takes it. Your options: ${site}/requests 🌊`,
          subject: `Your crew for ${svcName} on ${pretty} handed it back`,
          body:
            `The crew booked for your ${svcName} at ${where} on ${pretty} has handed it back, and told us why:\n\n` +
            `  ${why}\n\n` +
            `You have not been charged.\n\n` +
            `The job has gone back to looking for a crew AT THE PRICE YOU AGREED TO — nobody ` +
            `can take it on at a different number. We'll tell you the moment somebody picks it ` +
            `up, and if you'd rather not wait you can cancel or pick a new date.\n\n` +
            `Your options are here:\n  ${site}/requests`,
        },
      );
      // "THE OWNER HAS BEEN TOLD" IS A CLAIM, AND IT HAS AN ANSWER. `notify`
      // returns one; this used to throw it away while the crew's toast said it
      // out loud. SMS has delivered nothing since July, so this is not a
      // theoretical branch.
      if (!told.reached) note = told.note ?? "We couldn't reach the owner to tell them — we'll keep trying.";
    } else {
      note = "We've no email or mobile on file for the owner, so we couldn't tell them directly.";
    }
  } catch {
    /* The release is done. A failed notice must not undo it. */
    note = "The job is off your schedule, but we couldn't confirm the owner was told.";
  }

  return { ok: true, note };
}

/** Signed URLs for a job's photos (used to show thumbnails to the crew/owner). */
export async function getJobPhotoUrls(jobId: string): Promise<string[]> {
  // A `string[]` has nowhere to put a sentence, and the caller awaits this
  // inline while an upload spinner is running — a throw here would leave the
  // card stuck mid-upload. So this one stays swallowed, and stays logged: the
  // thumbnails are a mirror of the photo count, which has its own honest path.
  let job: VendorJob;
  try {
    job = await assertVendorJob(jobId);
  } catch (e) {
    console.error("[read failed] the job behind these thumbnails:", e);
    return [];
  }
  if (!job) return [];
  const admin = createServiceClient();
  const rowsRes = await admin.from("job_photos").select("url").eq("job_id", jobId);
  if (rowsRes.error) console.error("[read failed] this job's photo thumbnails:", rowsRes.error);
  const rows = rowsRes.data;
  const paths = (rows ?? []).map((r) => r.url as string);
  if (paths.length === 0) return [];
  const signedRes = await admin.storage.from("job-photos").createSignedUrls(paths, 3600);
  // Same swallow, same reason — but photos that exist and won't sign is a
  // different problem from photos that were never taken, so say which.
  if (signedRes.error) console.error("[read failed] signing this job's photos:", signedRes.error);
  return (signedRes.data ?? []).map((s) => s.signedUrl).filter(Boolean) as string[];
}
