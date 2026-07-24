import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { getPlatformSettings } from "@/lib/settings";
import { decideDisputeOutcome, respondByFrom } from "@/lib/dispute-policy";
import { executeRefund } from "@/lib/refund-core";
import { refundableRemaining } from "@/lib/refunds";
import { sendSms } from "@/lib/sms";

/**
 * Make-It-Right disputes (Autonomy Ladder, 2026-07-23) — the machine runs
 * the whole cure-first ladder: a 👎 with a note opens a dispute, HOLDS the
 * crew payout, and hands the CREW the first move (right-to-cure, ToS
 * §11.5) via one-tap links. Fix-it books a $0 photo-gated correction
 * visit; stand-by-it asks the customer to accept the evidence; silence or
 * a failed cure fires the policy: small verified charges refund
 * themselves, big ones escalate with the answer pre-computed. Humans see
 * only the escalations, in the nightly digest.
 */

const token = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));

const site = () => process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

/** held→released, guarded to the loose earning row only. */
async function releaseHeldPayout(admin: ReturnType<typeof createServiceClient>, jobId: string): Promise<void> {
  await admin.from("payouts")
    .update({ status: "released" })
    .eq("job_id", jobId).eq("kind", "earning").eq("status", "held").is("batch_id", null);
}

/** released→held, guarded — money waits while the dispute is open. */
async function holdPayout(admin: ReturnType<typeof createServiceClient>, jobId: string): Promise<void> {
  await admin.from("payouts")
    .update({ status: "held" })
    .eq("job_id", jobId).eq("kind", "earning").eq("status", "released").is("batch_id", null);
}

/**
 * Open a dispute from a 👎-with-note. Idempotent per job (partial unique
 * index on open statuses — a second 👎 path lands on the existing row).
 * Returns the crew links so the intake route can text them.
 */
export async function openDisputeForJob(jobId: string, note: string | null): Promise<{ ok: boolean; crewLinks?: { fix: string; verify: string; talk: string } }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();
  const { data: job } = await admin
    .from("jobs").select("id, vendor_id, status").eq("id", jobId).maybeSingle();
  if (!job || !job.vendor_id) return { ok: false };

  const crewToken = token();
  const customerToken = token();
  const { error } = await admin.from("disputes").insert({
    job_id: jobId,
    customer_note: note,
    crew_token: crewToken,
    customer_token: customerToken,
    respond_by: respondByFrom(Date.now(), settings.disputeResponseHours),
  });
  if (error) {
    // Open dispute already exists (unique index) — reuse its links.
    const { data: existing } = await admin
      .from("disputes").select("crew_token")
      .eq("job_id", jobId)
      .in("status", ["crew_review", "fixing", "verifying", "talk", "escalated"])
      .maybeSingle();
    if (!existing) return { ok: false };
    const t = existing.crew_token as string;
    return { ok: true, crewLinks: linksFor(t) };
  }

  await holdPayout(admin, jobId);
  return { ok: true, crewLinks: linksFor(crewToken) };
}

function linksFor(crewToken: string) {
  return {
    fix: `${site()}/d/${crewToken}/fix`,
    verify: `${site()}/d/${crewToken}/verify`,
    talk: `${site()}/d/${crewToken}/talk`,
  };
}

export interface DisputeRow {
  id: string;
  job_id: string;
  status: string;
  customer_note: string | null;
  customer_token: string;
  crew_token: string;
  correction_job_id: string | null;
}

export async function loadDisputeByToken(kind: "crew" | "customer", tok: string): Promise<DisputeRow | null> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id")
    .eq(kind === "crew" ? "crew_token" : "customer_token", tok)
    .maybeSingle();
  return (data as DisputeRow) ?? null;
}

/** Crew taps "I'll fix it" and picks a date → $0 photo-gated correction visit. */
export async function crewChooseFix(crewToken: string, dateISO: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const d = await loadDisputeByToken("crew", crewToken);
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  if (!["crew_review", "talk", "verifying"].includes(d.status)) return { ok: false, error: "This one's already moving — check your Today list." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: "Pick a day." };

  const { data: job } = await admin
    .from("jobs")
    .select("id, property_id, service_id, vendor_id, properties(address, nickname, users(phone)), services(name)")
    .eq("id", d.job_id).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  // The make-it-right visit: $0, same crew, photo gate still applies —
  // the FIX gets proven the same way the original work was.
  const { data: fixJob, error: insErr } = await admin
    .from("jobs")
    .insert({
      property_id: job.property_id, service_id: job.service_id, vendor_id: job.vendor_id,
      date: dateISO, status: "scheduled", customer_price: 0, vendor_cost: 0, margin: 0,
      correction_of: job.id,
    })
    .select("id").single();
  if (insErr || !fixJob) return { ok: false, error: insErr?.message ?? "Couldn't book the visit." };

  const { data: flipped } = await admin
    .from("disputes")
    .update({ status: "fixing", correction_job_id: fixJob.id })
    .eq("id", d.id)
    .in("status", ["crew_review", "talk", "verifying"])
    .select("id");
  if (!flipped || flipped.length === 0) {
    await admin.from("jobs").delete().eq("id", fixJob.id); // lost the race — undo the visit
    return { ok: false, error: "This one's already moving." };
  }

  const svcName = (one(job.services) as { name?: string } | null)?.name ?? "the work";
  const prop = one(job.properties) as { nickname?: string; address?: string; users?: unknown } | null;
  const ownerPhone = (one(prop?.users) as { phone?: string } | null)?.phone;
  const pretty = new Date(dateISO + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (ownerPhone) {
    void sendSms(ownerPhone, `LakeLife: your crew is coming back ${pretty} to make the ${svcName} right — no charge. You'll get photos when it's done. 🌊`);
  }
  return { ok: true };
}

/** Crew stands by the work → customer decides against the photo evidence. */
export async function crewChooseVerify(crewToken: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const d = await loadDisputeByToken("crew", crewToken);
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  const { data: flipped } = await admin
    .from("disputes").update({ status: "verifying" })
    .eq("id", d.id).eq("status", "crew_review").select("id");
  if (!flipped || flipped.length === 0) return { ok: false, error: "This one's already moving." };

  const { data: job } = await admin
    .from("jobs").select("properties(users(phone)), services(name)").eq("id", d.job_id).maybeSingle();
  const ownerPhone = (one((one(job?.properties) as { users?: unknown } | null)?.users) as { phone?: string } | null)?.phone;
  const svcName = (one(job?.services) as { name?: string } | null)?.name ?? "the work";
  if (ownerPhone) {
    void sendSms(ownerPhone, `LakeLife: the crew stands by the ${svcName} — their completion photos are in your portal. Does that settle it? Yes: ${site()}/d/${d.customer_token}/resolved · No: ${site()}/d/${d.customer_token}/still 🌊`);
  }
  return { ok: true };
}

/** Crew wants to talk → opens the existing message thread, no ops needed. */
export async function crewChooseTalk(crewToken: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const d = await loadDisputeByToken("crew", crewToken);
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  const { data: flipped } = await admin
    .from("disputes").update({ status: "talk" })
    .eq("id", d.id).eq("status", "crew_review").select("id");
  if (!flipped || flipped.length === 0) return { ok: false, error: "This one's already moving." };

  const { data: job } = await admin
    .from("jobs")
    .select("property_id, vendor_id, vendors(user_id), properties(users(id, phone)), services(name)")
    .eq("id", d.job_id).maybeSingle();
  const svcName = (one(job?.services) as { name?: string } | null)?.name ?? "the work";
  const crewUserId = (one(job?.vendors) as { user_id?: string } | null)?.user_id;
  const owner = one((one(job?.properties) as { users?: unknown } | null)?.users) as { id?: string; phone?: string } | null;
  if (job?.property_id && crewUserId) {
    await admin.from("messages").insert({
      property_id: job.property_id,
      from_user: crewUserId,
      body: `About the ${svcName} — we saw your note and want to get this right. What would you like us to do? We can come back, or talk it through here.`,
    });
  }
  if (owner?.phone) {
    // The customer's resolve/still links ride along — a talk dispute can
    // quiet-close in the crew's favor, which is only fair if the customer
    // held the "still not right" lever the whole window (review finding).
    void sendSms(owner.phone, `LakeLife: your crew replied about the ${svcName} — see Messages in your portal to sort it out together. All set: ${site()}/d/${d.customer_token}/resolved · Still not right: ${site()}/d/${d.customer_token}/still 🌊`);
  }
  return { ok: true };
}

/** Customer accepts (photos convinced them / fix satisfied them informally). */
export async function customerResolved(customerToken: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const d = await loadDisputeByToken("customer", customerToken);
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  const { data: flipped } = await admin
    .from("disputes")
    .update({ status: "resolved_verified", resolved_at: new Date().toISOString(), resolution: "customer accepted" })
    .eq("id", d.id)
    .in("status", ["crew_review", "verifying", "talk", "fixing"])
    .select("id");
  if (!flipped || flipped.length === 0) return { ok: false, error: "Already settled — thank you." };
  await releaseHeldPayout(admin, d.job_id);
  return { ok: true };
}

/** Customer says it's STILL not right → the policy decides, no humans unless big. */
export async function customerStill(customerToken: string): Promise<{ ok: boolean; error?: string; refunded?: boolean }> {
  const d = await loadDisputeByToken("customer", customerToken);
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  if (!["verifying", "talk", "fixing", "crew_review"].includes(d.status)) return { ok: false, error: "Already settled." };
  return firePolicy(d, "customer says still unresolved");
}

/** Correction visit's fresh 👍/👎 closes the loop. */
export async function resolveFromCorrection(correctionJobId: string, good: boolean): Promise<void> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id")
    .eq("correction_job_id", correctionJobId)
    .maybeSingle();
  if (!data) return;
  const d = data as DisputeRow;
  if (d.status !== "fixing") return;
  if (good) {
    const { data: flipped } = await admin
      .from("disputes")
      .update({ status: "resolved_fixed", resolved_at: new Date().toISOString(), resolution: "correction visit accepted" })
      .eq("id", d.id).eq("status", "fixing").select("id");
    if (flipped && flipped.length > 0) await releaseHeldPayout(admin, d.job_id);
  } else {
    await firePolicy(d, "correction visit still unsatisfactory");
  }
}

/**
 * The policy: small verified charges refund themselves (full remaining
 * cash, proportional clawback), everything else escalates with the file
 * complete. The HOLD must release BEFORE the refund so the clawback's
 * reduce path sees a 'released' row — conservation depends on it.
 */
async function firePolicy(d: DisputeRow, why: string): Promise<{ ok: boolean; error?: string; refunded?: boolean }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();

  const { data: job } = await admin
    .from("jobs").select("id, customer_price, properties(owner_id)").eq("id", d.job_id).maybeSingle();
  const ownerId = (one(job?.properties) as { owner_id?: string } | null)?.owner_id ?? null;
  const { data: invoice } = await admin
    .from("invoices").select("id").eq("job_id", d.job_id).maybeSingle();
  const { data: payment } = invoice
    ? await admin.from("payments").select("amount").eq("invoice_id", invoice.id).eq("status", "captured").maybeSingle()
    : { data: null };
  const captured = Number(payment?.amount ?? 0);
  const { data: priorRefRows } = invoice
    ? await admin.from("refunds").select("amount").eq("invoice_id", invoice.id)
    : { data: [] as Array<{ amount: number }> };
  const alreadyRefunded = (priorRefRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);

  let priorDisputes = 0;
  if (ownerId) {
    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const { data: props } = await admin.from("properties").select("id").eq("owner_id", ownerId);
    const propIds = (props ?? []).map((p) => p.id as string);
    if (propIds.length) {
      const { data: priorJobs } = await admin.from("jobs").select("id").in("property_id", propIds);
      const jobIds = (priorJobs ?? []).map((j) => j.id as string);
      if (jobIds.length) {
        const { count } = await admin
          .from("disputes").select("id", { count: "exact", head: true })
          .in("job_id", jobIds).eq("status", "resolved_refunded").gte("opened_at", yearAgo);
        priorDisputes = count ?? 0;
      }
    }
  }

  const decision = decideDisputeOutcome({
    capturedCash: captured,
    customerPrice: Number(job?.customer_price ?? 0),
    autoRefundMax: settings.disputeAutoRefundMax,
    priorDisputesByCustomer: priorDisputes,
  });

  if (decision === "escalate") {
    await admin.from("disputes").update({ status: "escalated", resolution: `escalated: ${why}` }).eq("id", d.id)
      .in("status", ["crew_review", "fixing", "verifying", "talk"]);
    // Payout stays HELD — money waits for the human. Digest picks it up.
    return { ok: true, refunded: false };
  }

  // Auto-refund the remaining cash. Release the hold FIRST (see docstring).
  const amount = refundableRemaining(captured, alreadyRefunded);
  if (!(amount > 0)) {
    // Already fully refunded (a prior policy pass or ops beat us) — nothing
    // left to move; close instead of looping through escalation.
    await releaseHeldPayout(admin, d.job_id);
    await admin.from("disputes")
      .update({ status: "resolved_closed", resolved_at: new Date().toISOString(), resolution: `closed, nothing left to refund: ${why}` })
      .eq("id", d.id);
    return { ok: true, refunded: false };
  }
  await releaseHeldPayout(admin, d.job_id);
  const res = await executeRefund({
    jobId: d.job_id,
    amount,
    clawback: null, // proportional default
    reason: `Make-It-Right policy: ${why} (dispute ${d.id})`,
    idempotencyKey: `dispute-${d.id}`,
    createdBy: null, // system actor — the reason carries the trail
  });
  if (!res.ok && /already submitted/i.test(res.error ?? "")) {
    // The dispute's idempotency key already went through — a concurrent
    // path (sweep vs customer tap) won the race. The refund EXISTS; this
    // is success wearing an error message.
    await admin.from("disputes")
      .update({ status: "resolved_refunded", resolved_at: new Date().toISOString(), resolution: `auto-refunded (concurrent path won): ${why}` })
      .eq("id", d.id)
      .neq("status", "resolved_refunded");
    return { ok: true, refunded: true };
  }
  if (!res.ok) {
    // Refund refused (race/processor) — fail safe: hold again, escalate.
    // Guarded to still-open statuses only: a concurrent path that already
    // resolved this dispute must not be clobbered back to 'escalated', and
    // its released payout must not be re-frozen (review finding).
    // If the crew claimed early payout in the release→refund window, the
    // re-hold no-ops on the now-batched row — say so in the resolution so
    // the human knows the recovery is an adjustment, not a release.
    const { data: earning } = await admin
      .from("payouts").select("batch_id").eq("job_id", d.job_id).eq("kind", "earning").maybeSingle();
    const batchedNote = earning?.batch_id != null ? " — crew pay already claimed into a batch; recover via adjustment" : "";
    const { data: reEscalated } = await admin.from("disputes")
      .update({ status: "escalated", resolution: `auto-refund failed: ${res.error ?? "unknown"}${batchedNote}` })
      .eq("id", d.id)
      .in("status", ["crew_review", "fixing", "verifying", "talk"])
      .select("id");
    if (reEscalated && reEscalated.length > 0) await holdPayout(admin, d.job_id);
    return { ok: true, refunded: false };
  }
  await admin.from("disputes")
    .update({ status: "resolved_refunded", resolved_at: new Date().toISOString(), resolution: `auto-refunded $${amount.toFixed(2)}: ${why}` })
    .eq("id", d.id);
  return { ok: true, refunded: true };
}

/**
 * The human's ONE lever for escalated disputes (nightly digest points here).
 * 'close' → crew's favor: hold releases, dispute closes. 'refund' → the
 * remaining cash goes back (held-aware clawback reduces the frozen earning
 * in place), the crew's remainder releases, dispute resolves. Either way
 * the dead end the review panel found — escalations stranding held pay
 * forever — has an exit that isn't manual SQL.
 */
export async function opsResolveEscalated(
  disputeId: string,
  outcome: "refund" | "close",
  resolvedBy: string | null,
): Promise<{ ok: boolean; error?: string; refunded?: number }> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id")
    .eq("id", disputeId)
    .maybeSingle();
  if (!data) return { ok: false, error: "Dispute not found." };
  const d = data as DisputeRow;
  if (d.status !== "escalated") return { ok: false, error: "Only escalated disputes land here — this one already resolved." };

  if (outcome === "close") {
    const { data: flipped } = await admin
      .from("disputes")
      .update({ status: "resolved_closed", resolved_at: new Date().toISOString(), resolution: "ops closed in crew's favor" })
      .eq("id", d.id).eq("status", "escalated")
      .select("id");
    if (!flipped || flipped.length === 0) return { ok: false, error: "Already resolved by another path." };
    await releaseHeldPayout(admin, d.job_id);
    return { ok: true };
  }

  // refund: remaining cash back, clawback reduces the HELD earning in place
  // (planClawback is held-aware), then the crew's remainder releases.
  const { data: invoice } = await admin.from("invoices").select("id").eq("job_id", d.job_id).maybeSingle();
  const { data: payment } = invoice
    ? await admin.from("payments").select("amount").eq("invoice_id", invoice.id).eq("status", "captured").maybeSingle()
    : { data: null };
  const captured = Number(payment?.amount ?? 0);
  const { data: priorRows } = invoice
    ? await admin.from("refunds").select("amount").eq("invoice_id", invoice.id)
    : { data: [] as Array<{ amount: number }> };
  const already = (priorRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const amount = refundableRemaining(captured, already);
  if (!(amount > 0)) {
    // Nothing left to move — close the dispute, release the crew.
    const { data: flipped } = await admin
      .from("disputes")
      .update({ status: "resolved_closed", resolved_at: new Date().toISOString(), resolution: "ops: nothing left to refund" })
      .eq("id", d.id).eq("status", "escalated")
      .select("id");
    if (flipped && flipped.length > 0) await releaseHeldPayout(admin, d.job_id);
    return { ok: true, refunded: 0 };
  }
  const res = await executeRefund({
    jobId: d.job_id,
    amount,
    clawback: null, // proportional default
    reason: `Make-It-Right escalation resolved by ops (dispute ${d.id})`,
    idempotencyKey: `dispute-${d.id}-ops`,
    createdBy: resolvedBy,
  });
  if (!res.ok && !/already submitted/i.test(res.error ?? "")) {
    return { ok: false, error: res.error ?? "Refund failed — dispute stays escalated." };
  }
  await admin
    .from("disputes")
    .update({ status: "resolved_refunded", resolved_at: new Date().toISOString(), resolution: `ops refunded $${amount.toFixed(2)} on escalation` })
    .eq("id", d.id).eq("status", "escalated");
  await releaseHeldPayout(admin, d.job_id); // clawback already reduced the held row; the remainder is the crew's
  return { ok: true, refunded: res.refunded ?? amount };
}

/** How long a completed correction waits for a silent customer before the
 *  photo gate wins: the same trust primitive that pays normal jobs. */
const CORRECTION_QUIET_DAYS = 3;

/**
 * Nightly: silent crews forfeit the cure window; stalled fixes escalate;
 * a COMPLETED fix with a silent customer resolves in the crew's favor
 * (the photo gate proved the cure the same way it proves normal work);
 * quiet conversations close in the crew's favor; and any 👎 whose dispute
 * never got created (transient insert failure burned the once-ever
 * verdict) is reconciled with a fresh dispute + crew SMS.
 */
export async function sweepDisputeDeadlines(): Promise<{ ok: boolean; fired: number; escalated: number; quietCloses: number; reconciled: number }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();
  const now = new Date().toISOString();
  let fired = 0, escalated = 0, quietCloses = 0, reconciled = 0;

  const { data: overdue } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id, opened_at")
    .eq("status", "crew_review")
    .lt("respond_by", now)
    .limit(50);
  for (const row of overdue ?? []) {
    const r = await firePolicy(row as DisputeRow, "crew did not respond in the cure window");
    if (r.refunded) fired++; else escalated++;
  }

  const fixCutoff = new Date(Date.now() - settings.disputeFixDays * 86_400_000).toISOString();
  const confQuietCutoff = new Date(Date.now() - CORRECTION_QUIET_DAYS * 86_400_000).toISOString();
  const { data: fixing } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id, opened_at")
    .eq("status", "fixing")
    .limit(50);
  for (const row of fixing ?? []) {
    const { data: fix } = row.correction_job_id
      ? await admin.from("jobs").select("status").eq("id", row.correction_job_id).maybeSingle()
      : { data: null };
    if (fix && ["complete", "paid"].includes(fix.status as string)) {
      // The cure happened and was photo-gated. The customer got a fresh
      // 👍/👎 link at completion — if they've sat on it CORRECTION_QUIET_DAYS,
      // the evidence wins: resolve fixed, release the crew's pay. Without
      // this, customer apathy (the common case) strands held pay forever
      // on a crew that did the free cure (review finding).
      const { data: conf } = await admin
        .from("job_confirmations")
        .select("id, verdict, created_at")
        .eq("job_id", row.correction_job_id as string)
        .maybeSingle();
      if (conf?.verdict) continue; // outcome path owns it (resolveFromCorrection)
      if (conf && (conf.created_at as string) > confQuietCutoff) continue; // still in the quiet window
      const { data: flipped } = await admin
        .from("disputes")
        .update({ status: "resolved_fixed", resolved_at: new Date().toISOString(), resolution: `correction completed and photo-gated; customer silent ${CORRECTION_QUIET_DAYS}+ days` })
        .eq("id", row.id).eq("status", "fixing")
        .select("id");
      if (flipped && flipped.length > 0) {
        await releaseHeldPayout(admin, row.job_id as string);
        quietCloses++;
      }
      continue;
    }
    // A scheduled-but-never-completed fix past the window is a broken promise.
    if ((row.opened_at as string) < fixCutoff) {
      const r = await firePolicy(row as DisputeRow, "correction visit never happened in the window");
      if (r.refunded) fired++; else escalated++;
    }
  }

  const { data: stalledConvos } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id, opened_at")
    .in("status", ["talk", "verifying"])
    .lt("opened_at", fixCutoff)
    .limit(50);
  for (const row of stalledConvos ?? []) {
    // The crew responded (talked / stood by the work) and the CUSTOMER went
    // quiet — silence after a cure offer resolves in the crew's favor: the
    // hold releases, the dispute closes. Both paths texted the customer
    // their resolved/still links, so the lever was in their hand all along.
    const { data: flipped } = await admin
      .from("disputes")
      .update({ status: "resolved_closed", resolved_at: new Date().toISOString(), resolution: "customer went quiet after crew response — resolved in crew's favor" })
      .eq("id", row.id)
      .in("status", ["talk", "verifying"])
      .select("id");
    if (flipped && flipped.length > 0) {
      await releaseHeldPayout(admin, row.job_id as string);
      quietCloses++;
    }
  }

  // RECONCILE burned verdicts: a 👎 flips the once-ever verdict BEFORE the
  // dispute insert — a transient failure there loses the complaint with no
  // retry path (the verdict is burned). Re-open any recent 'issue' verdict
  // on a normal job that has NO dispute row at all, and re-text the crew.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: issues } = await admin
    .from("job_confirmations")
    .select("job_id, note, vendor_id, jobs(correction_of, services(name))")
    .eq("verdict", "issue")
    .gte("responded_at", weekAgo)
    .limit(100);
  for (const c of issues ?? []) {
    const job = one((c as { jobs?: unknown }).jobs) as { correction_of?: string | null; services?: unknown } | null;
    if (job?.correction_of) continue; // correction 👎s belong to resolveFromCorrection
    const { count } = await admin
      .from("disputes").select("id", { count: "exact", head: true })
      .eq("job_id", c.job_id as string);
    if ((count ?? 0) > 0) continue; // dispute exists (any status) — nothing lost
    const r = await openDisputeForJob(c.job_id as string, (c.note as string) ?? null);
    if (r.ok && r.crewLinks && c.vendor_id) {
      const svcName = (one(job?.services) as { name?: string } | null)?.name ?? "a recent job";
      const { data: v } = await admin.from("vendors").select("user_id").eq("id", c.vendor_id as string).maybeSingle();
      const { data: cu } = v?.user_id
        ? await admin.from("users").select("phone").eq("id", v.user_id as string).maybeSingle()
        : { data: null };
      if (cu?.phone) {
        void sendSms(
          cu.phone as string,
          `LakeLife: the customer flagged the ${svcName}. Your pay for it is ON HOLD until this is settled. Make it right (free return visit): ${r.crewLinks.fix} · It was done right: ${r.crewLinks.verify} · Talk it through: ${r.crewLinks.talk}`,
        );
      }
      reconciled++;
    }
  }

  return { ok: true, fired, escalated, quietCloses, reconciled };
}
