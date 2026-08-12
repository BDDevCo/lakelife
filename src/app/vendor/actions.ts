"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getMyVendorId } from "./data";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { allowsNotification } from "@/lib/notif-gate";
import { settleJob } from "@/lib/automation";
import { todayLakeDate } from "@/lib/booking";
import { getFullProfile, toPricingProfile } from "@/app/profile/data";
import {
  summariseCorrection, correctionMessage, noAnswerOutcome, completionBlock,
  type TimedRule,
} from "@/lib/arrival";
import { planRecovery } from "@/lib/recovery";

// Only these profile fields may be changed by a crew flag, with safe values.
const COUNT_FIELDS = new Set(["pier_sections", "boat_lifts", "pwc_lifts", "jet_skis", "toy_lifts"]);
const LAWN_BANDS = new Set(["small", "medium", "large"]);
function sanitizeProposed(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (COUNT_FIELDS.has(k)) {
      const n = Math.floor(Number(v));
      if (Number.isFinite(n) && n >= 0 && n <= 99) out[k] = n;
    } else if (k === "lawn_band" && typeof v === "string" && LAWN_BANDS.has(v)) {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  photoCount?: number;
}

/** Confirm the job is assigned to the signed-in vendor. Returns the job row or null. */
async function assertVendorJob(jobId: string) {
  const vendorId = await getMyVendorId();
  if (!vendorId) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("jobs")
    // Deliberately NO customer_price / vendor_cost: this is the crew code path,
    // and rule 1 forbids a vendor from ever seeing menu price or margin. Keeping
    // those columns out of reach by construction (settleJob re-loads them ops-side).
    .select("id, status, vendor_id, service_id, date, property_id, group_id, held_at, no_show_at, services(name, min_photos, needs_interior_access)")
    .eq("id", jobId)
    .maybeSingle();
  if (!data || data.vendor_id !== vendorId) return null;
  return data;
}

/**
 * Upload one job photo. The crew's device sends the image in a FormData; the
 * file goes to a PRIVATE storage bucket and only a row (job_id + path) is kept.
 */
export async function uploadJobPhoto(jobId: string, form: FormData): Promise<ActionResult> {
  const job = await assertVendorJob(jobId);
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

  const { error: upErr } = await admin.storage.from("job-photos").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (upErr) return { ok: false, error: upErr.message };

  const { error: rowErr } = await admin.from("job_photos").insert({ job_id: jobId, url: path });
  if (rowErr) return { ok: false, error: rowErr.message };

  // Stamp the crew's clock-in on the first photo (scoring: actual job duration).
  // Best-effort, only if not already set.
  await admin.from("jobs").update({ started_at: new Date().toISOString() }).eq("id", jobId).is("started_at", null);

  const { count } = await admin
    .from("job_photos")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  return { ok: true, photoCount: count ?? 0 };
}

/**
 * Mark a job complete — HARD photo gate (CLAUDE.md rule 2): cannot complete,
 * and payout cannot release, without at least the service's min_photos.
 * On success: status -> complete, an invoice is raised, the vendor payout is
 * released (photo-verified), and the owner gets the "done + photos" text.
 */
export async function completeJob(jobId: string): Promise<ActionResult> {
  const job = await assertVendorJob(jobId);
  if (!job) return { ok: false, error: "That job isn't on your route." };
  if (job.status === "complete" || job.status === "paid") {
    return { ok: false, error: "That job is already complete." };
  }

  // 0084's trigger is the real gate and stays the real gate. This exists so a
  // crew gets a sentence instead of a raw constraint violation — the same
  // reason canApprove exists on the park side.
  const blocked = completionBlock(job as { held_at?: string | null; no_show_at?: string | null });
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
    const { data: legs } = await admin
      .from("job_items").select("services(min_photos)").eq("job_id", jobId);
    if (legs && legs.length > 0) {
      minPhotos = legs.reduce((sum, l) => {
        const ls = (Array.isArray(l.services) ? l.services[0] : l.services) as { min_photos?: number } | null;
        return sum + (ls?.min_photos ?? 0);
      }, 0);
    }
  }
  const { count } = await admin
    .from("job_photos")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  const photoCount = count ?? 0;
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
  const { data: prop } = await admin
    .from("properties")
    .select("address, users(id, phone)")
    .eq("id", job.property_id)
    .maybeSingle();
  const ownerUser = (Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as
    { id?: string; phone?: string } | null;
  const ownerPhone = ownerUser?.phone;
  let confirmLinks = "";
  try {
    const { data: conf } = await admin
      .from("job_confirmations")
      .insert({ job_id: jobId, property_id: job.property_id, vendor_id: job.vendor_id })
      .select("confirm_token")
      .single();
    if (conf?.confirm_token) {
      const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
      confirmLinks = ` All good? ${site}/c/${conf.confirm_token}/good — something off? ${site}/c/${conf.confirm_token}/issue`;
    }
  } catch {
    /* pre-migration or duplicate row — the completion text still goes out */
  }
  if (ownerPhone && (await allowsNotification(ownerUser?.id, "done", "sms"))) {
    void sendSms(
      ownerPhone,
      `LakeLife: ${svc?.name ?? "Your service"} is done at ${prop?.address ?? "your place"} — ${photoCount} photos are in your property log.${confirmLinks} 🌊`,
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
  const job = await assertVendorJob(jobId);
  if (!job) return { ok: false, error: "That job isn't on your route." };
  if (job.status === "complete" || job.status === "paid") {
    return { ok: false, error: "That job is already closed out." };
  }

  const admin = createServiceClient();
  const proposed = sanitizeProposed(proposedChange);

  if (atArrival && !proposed) {
    return {
      ok: false,
      error: "Say what's different — the counts are what the owner approves.",
    };
  }
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

    const { data: prop } = await admin
      .from("properties")
      .select("address, nickname, users(id, name, email, phone)")
      .eq("id", job.property_id as string)
      .maybeSingle();
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
    if (atArrival && proposed) {
      try {
        const [{ data: rule }, profile] = await Promise.all([
          admin.from("services")
            .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands, needs_interior_access")
            .eq("id", job.service_id as string).maybeSingle(),
          getFullProfile(job.property_id as string),
        ]);
        if (rule && profile?.hasProfile) {
          const summary = summariseCorrection(
            rule as unknown as TimedRule,
            toPricingProfile(profile),
            proposed as Parameters<typeof summariseCorrection>[2],
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

    if (owner?.phone && (await allowsNotification(owner.id, "appr", "sms"))) {
      void sendSms(
        owner.phone,
        detail
          ? `LakeLife: ${detail} ${site}/approvals 🌊`
          : `LakeLife: the crew at ${where} found something that doesn't match your ` +
            `profile on your ${svcName}. Nothing changes and nothing is charged until ` +
            `you say yes: ${site}/approvals 🌊`,
      );
    }
    if (owner?.email) {
      void sendEmail({
        to: owner.email,
        subject: `A quick check on your ${svcName}`,
        html:
          `<p>Hi ${owner.name ?? "there"},</p>` +
          (detail
            ? `<p>${detail}</p>`
            : `<p>The crew at ${where} found something on site that doesn't match ` +
              `what we have on file for your ${svcName}.</p>`) +
          `<p><b>Nothing has changed and nothing has been charged.</b> It waits ` +
          `for you.</p>` +
          `<p><a href="${site}/approvals">Take a look</a></p><p>🌊</p>`,
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
  const job = await assertVendorJob(jobId);
  if (!job) return { ok: false, error: "That job isn't on your route." };
  if (job.status === "complete" || job.status === "paid") {
    return { ok: false, error: "That job is already closed out." };
  }

  const why = reason.trim().slice(0, 300);
  if (!why) {
    // The customer may be charged for this. They are entitled to know what
    // happened, in the words of the person who was standing there.
    return { ok: false, error: "Say what happened — the owner may be charged for this." };
  }

  const admin = createServiceClient();
  const { data: rule } = await admin
    .from("services").select("name, needs_interior_access")
    .eq("id", job.service_id as string).maybeSingle();

  if (rule && noAnswerOutcome(rule as { needs_interior_access?: boolean | null }) === "proceed_as_booked") {
    return {
      ok: false,
      error:
        `${(rule.name as string) ?? "This work"} doesn't need anyone to let you in — ` +
        `go ahead and do it as booked. If something is genuinely in the way, ` +
        `flag it instead so the owner can sort it.`,
    };
  }

  // THE ATTEMPT IS WRITTEN DOWN FIRST, and it is append-only. Rescheduling
  // clears the job's live no-show columns so the work can run again; without
  // this row, the trip the crew made would vanish with them (0089's trigger
  // refuses the clear if it is missing).
  const today = todayLakeDate();
  await admin.from("job_visit_attempts").insert({
    job_id: jobId,
    vendor_id: job.vendor_id,
    attempted_on: today,
    outcome: "no_access",
    reason: why,
  });

  const plan = planRecovery("no_access", today, {
    serviceName: (rule?.name as string) ?? "your service",
  });

  const { error } = await admin
    .from("jobs")
    .update({
      no_show_at: new Date().toISOString(),
      no_show_reason: why,
      recovery_state: "awaiting_customer",
      reschedule_deadline: plan.deadline,
    })
    .eq("id", jobId);
  if (error) return { ok: false, error: error.message };

  // Ops picks this up: a no-show is a conversation (reschedule by agreement,
  // else the cancellation policy), never an automatic charge. Nobody is billed
  // by a crew tapping a button on a doorstep.
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const { data: prop } = await admin
      .from("properties").select("address, nickname, users(id, name, email, phone)")
      .eq("id", job.property_id as string).maybeSingle();
    const owner = (Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as
      { id?: string; name?: string; email?: string; phone?: string } | null;
    const where = (prop?.nickname as string) || (prop?.address as string) || "your place";
    const svcName = (rule?.name as string) ?? "your service";

    if (owner?.email) {
      void sendEmail({
        to: owner.email,
        subject: `We couldn't get in for your ${svcName}`,
        html:
          `<p>Hi ${owner.name ?? "there"},</p>` +
          `<p>Our crew was at ${where} today for your ${svcName} and couldn't get ` +
          `inside to do the work.</p>` +
          `<p><i>${why}</i></p>` +
          `<p><b>You have not been charged.</b> ${plan.ask}</p>` +
          `<p><a href="${site}/requests">Pick another day</a></p>` +
          // WHAT SILENCE COSTS, SAID NOW. Finding out later that a window
          // existed and closed is the version of this that makes people angry,
          // and rightly.
          `<p class="mut">${plan.ifNothingHappens}</p><p>🌊</p>`,
      });
    }
  } catch {
    /* The no-show is recorded. A failed notice must not undo it. */
  }

  return { ok: true };
}

/** Signed URLs for a job's photos (used to show thumbnails to the crew/owner). */
export async function getJobPhotoUrls(jobId: string): Promise<string[]> {
  const job = await assertVendorJob(jobId);
  if (!job) return [];
  const admin = createServiceClient();
  const { data: rows } = await admin.from("job_photos").select("url").eq("job_id", jobId);
  const paths = (rows ?? []).map((r) => r.url as string);
  if (paths.length === 0) return [];
  const { data: signed } = await admin.storage.from("job-photos").createSignedUrls(paths, 3600);
  return (signed ?? []).map((s) => s.signedUrl).filter(Boolean) as string[];
}
