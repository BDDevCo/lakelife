import "server-only";
import { randomUUID } from "node:crypto";
import { isBearerToken } from "@/lib/token-format";
import { createServiceClient } from "@/lib/supabase/server";
import { getPlatformSettings } from "@/lib/settings";
import { decideDisputeOutcome, respondByFrom, DISPUTE_ACCEPTABLE_STATUSES, DISPUTE_ESCALATABLE_STATUSES } from "@/lib/dispute-policy";
import { executeRefund } from "@/lib/refund-core";
import { refundableRemaining } from "@/lib/refunds";
import { notify } from "@/lib/notify";
import { mustRead, readFailedMessage } from "@/lib/must-read";

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

/**
 * A DISPUTE TOKEN IS A BEARER CREDENTIAL. Whoever holds it can act as the crew
 * or as the customer on that dispute — book a correction visit, accept the
 * evidence, trigger a refund. Two things follow from that.
 *
 * IT IS MINTED FROM crypto, NEVER FROM Math.random. This used to fall back to
 * `Math.random().toString(36)` twice when `crypto.randomUUID` was missing,
 * which would have handed out a guessable credential from a seeded PRNG. It
 * was unreachable — this file is server-only and every runtime it loads in has
 * had randomUUID for years — and that is precisely why it survived. A fallback
 * that never runs is a fallback nobody notices is wrong. Importing from
 * `node:crypto` makes the guarantee explicit instead of conditional.
 */
const token = () => randomUUID().replace(/-/g, "");

/**
 * AND IT IS VALIDATED BEFORE IT REACHES A QUERY, against the shared shape in
 * token-format.ts. This loader was the only one in the app passing a raw path
 * segment straight into `.eq()` — /use, /a, /c and /api/ics all check first.
 *
 * The concrete hole was narrow: an empty segment matched any dispute whose
 * token column was literally '', and nothing mints an empty token. But "narrow
 * today" is an argument about the data, not about the code.
 */

const site = () => process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

/**
 * A DISPUTE HOLDS THE JOB PAY AND NOT THE TIP — and that is now a decision
 * rather than an accident of a filter.
 *
 * Both functions below key on `kind = 'earning'`. Since 0090 and 0091 added
 * `trip` and `tip`, that has quietly meant: open a dispute on a tipped job and
 * the crew's earning freezes while the tip payout stays released and sweeps
 * into the next batch.
 *
 * Kept, deliberately, for both of them:
 *
 *   A TIP is not ours to freeze. The homeowner chose to give it, after the
 *   work, to those people. Clawing it back because a later complaint arrived
 *   would make every tip provisional — and a tip you can lose is not a tip,
 *   it is a deposit against future satisfaction. If the work was genuinely bad
 *   the refundable thing is what we CHARGED for the work.
 *
 *   A TRIP FEE is compensation for fuel and an hour already spent, on a visit
 *   that by definition produced no work to dispute. Holding it would mean a
 *   crew paying for our bad address data twice.
 *
 * The consequence is real and should be understood: a full auto-refund leaves
 * the customer having paid the tip and the crew having kept it. If that ever
 * needs to change, change it HERE and say why — do not widen the filter.
 */

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
  const { data: job, error: jobErr } = await admin
    .from("jobs").select("id, vendor_id, status").eq("id", jobId).maybeSingle();
  // This result carries no sentence — the caller only learns ok/not — so the
  // log IS the record. Refusing is right: the sweep's reconcile pass re-opens
  // any 👎 whose dispute row never got written.
  if (jobErr) {
    console.error("[read failed] the job behind this complaint:", jobErr);
    return { ok: false };
  }
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
    const { data: existing, error: existingErr } = await admin
      .from("disputes").select("crew_token")
      .eq("job_id", jobId)
      .in("status", ["crew_review", "fixing", "verifying", "talk", "escalated"])
      .maybeSingle();
    if (existingErr) {
      console.error("[read failed] the dispute already open on this job:", existingErr);
      return { ok: false };
    }
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

/**
 * A FAILED READ IS NOT AN UNKNOWN TOKEN. Every caller turns `null` into "That
 * link isn't valid anymore" — told, on a dropped connection, to a crew member
 * holding a link that is perfectly valid, about a dispute that is holding their
 * pay. So the read throws instead; `disputeForAction` below converts the throw
 * back into an honest sentence for the tapped-link paths.
 */
export async function loadDisputeByToken(kind: "crew" | "customer", tok: string): Promise<DisputeRow | null> {
  if (!isBearerToken(tok)) return null;
  const admin = createServiceClient();
  const res = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id")
    .eq(kind === "crew" ? "crew_token" : "customer_token", tok)
    .maybeSingle();
  return (mustRead("this request", res) as DisputeRow) ?? null;
}

/**
 * The same load, for the functions below: they answer a tapped link and their
 * callers render `error`, where a rejected promise is a blank page with no
 * sentence on it. `null` still means the token genuinely matches nothing.
 */
async function disputeForAction(
  kind: "crew" | "customer",
  tok: string,
): Promise<{ d: DisputeRow | null; readError?: string }> {
  try {
    return { d: await loadDisputeByToken(kind, tok) };
  } catch (e) {
    return { d: null, readError: readFailedMessage("this request", e) };
  }
}

/** Crew taps "I'll fix it" and picks a date → $0 photo-gated correction visit. */
export async function crewChooseFix(crewToken: string, dateISO: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const { d, readError } = await disputeForAction("crew", crewToken);
  if (readError) return { ok: false, error: readError };
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  if (!["crew_review", "talk", "verifying"].includes(d.status)) return { ok: false, error: "This one's already moving — check your Today list." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: "Pick a day." };

  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, property_id, service_id, vendor_id, pickup_address, pickup_lat, pickup_lng, pickup_contact, pickup_phone, release_confirmed_at, properties(address, nickname, users(phone, email)), services(name)")
    .eq("id", d.job_id).maybeSingle();
  if (jobErr) return { ok: false, error: readFailedMessage("this job", jobErr) };
  if (!job) return { ok: false, error: "Job not found." };

  // The make-it-right visit: $0, same crew, photo gate still applies —
  // the FIX gets proven the same way the original work was.
  const { data: fixJob, error: insErr } = await admin
    .from("jobs")
    .insert({
      property_id: job.property_id, service_id: job.service_id, vendor_id: job.vendor_id,
      date: dateISO, status: "scheduled", customer_price: 0, vendor_cost: 0, margin: 0,
      correction_of: job.id,
      // THE BOAT HAS NOT MOVED (0151). This clone carried property_id and
      // service_id and nothing about where the thing actually is, so a
      // make-it-right on a collection sent the crew to the customer's house —
      // where there is no boat, and never was. The original visit's pickup
      // details are the only ones that can be true here; the customer is not
      // booking anything, so there is nobody to ask again.
      pickup_address: job.pickup_address ?? null,
      pickup_lat: job.pickup_lat ?? null,
      pickup_lng: job.pickup_lng ?? null,
      pickup_contact: job.pickup_contact ?? null,
      pickup_phone: job.pickup_phone ?? null,
      release_confirmed_at: job.release_confirmed_at ?? null,
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
  const owner = one(prop?.users) as { phone?: string; email?: string } | null;
  const pretty = new Date(dateISO + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  void notify(
    "the owner that their crew is coming back to make it right",
    { phone: owner?.phone, email: owner?.email },
    {
      sms: `LakeLife: your crew is coming back ${pretty} to make the ${svcName} right — no charge. You'll get photos when it's done. 🌊`,
      subject: `Your crew is coming back ${pretty} to make the ${svcName} right`,
    },
  );
  return { ok: true };
}

/** Crew stands by the work → customer decides against the photo evidence. */
export async function crewChooseVerify(crewToken: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const { d, readError } = await disputeForAction("crew", crewToken);
  if (readError) return { ok: false, error: readError };
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  const { data: flipped } = await admin
    .from("disputes").update({ status: "verifying" })
    .eq("id", d.id).eq("status", "crew_review").select("id");
  if (!flipped || flipped.length === 0) return { ok: false, error: "This one's already moving." };

  // The flip already happened, so this cannot refuse — but a failed read means
  // the customer never gets the text that hands them the decision. Log it: the
  // sweep closes a quiet 'verifying' in the crew's favour, and it must be
  // findable if the customer was never actually asked.
  const { data: job, error: jobErr } = await admin
    .from("jobs").select("properties(users(phone, email)), services(name)").eq("id", d.job_id).maybeSingle();
  if (jobErr) console.error(`[read failed] the customer's number for dispute ${d.id}:`, jobErr);
  const owner = one((one(job?.properties) as { users?: unknown } | null)?.users) as { phone?: string; email?: string } | null;
  const svcName = (one(job?.services) as { name?: string } | null)?.name ?? "the work";
  void notify(
    "the owner that the crew stands by the work and the decision is theirs",
    { phone: owner?.phone, email: owner?.email },
    {
      sms: `LakeLife: the crew stands by the ${svcName} — their completion photos are in your portal. Does that settle it? Yes: ${site()}/d/${d.customer_token}/resolved · No: ${site()}/d/${d.customer_token}/still 🌊`,
      subject: `The crew stands by the ${svcName} — does that settle it?`,
      body:
        `The crew stands by the ${svcName}. Their completion photos are in your portal.\n\n` +
        `Does that settle it?\n\n` +
        `  Yes:\n  ${site()}/d/${d.customer_token}/resolved\n\n` +
        `  No:\n  ${site()}/d/${d.customer_token}/still`,
    },
  );
  return { ok: true };
}

/** Crew wants to talk → opens the existing message thread, no ops needed. */
export async function crewChooseTalk(crewToken: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const { d, readError } = await disputeForAction("crew", crewToken);
  if (readError) return { ok: false, error: readError };
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  const { data: flipped } = await admin
    .from("disputes").update({ status: "talk" })
    .eq("id", d.id).eq("status", "crew_review").select("id");
  if (!flipped || flipped.length === 0) return { ok: false, error: "This one's already moving." };

  // Same as verify: the status is already 'talk'. A failed read here costs the
  // customer both the crew's message and the SMS carrying their two levers, and
  // the quiet-close sweep will later read that silence as agreement — so this
  // failure has to be on the record.
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("property_id, vendor_id, vendors(user_id), properties(users(id, phone, email)), services(name)")
    .eq("id", d.job_id).maybeSingle();
  if (jobErr) console.error(`[read failed] the people on dispute ${d.id}:`, jobErr);
  const svcName = (one(job?.services) as { name?: string } | null)?.name ?? "the work";
  const crewUserId = (one(job?.vendors) as { user_id?: string } | null)?.user_id;
  const owner = one((one(job?.properties) as { users?: unknown } | null)?.users) as { id?: string; phone?: string; email?: string } | null;
  if (job?.property_id && crewUserId) {
    await admin.from("messages").insert({
      property_id: job.property_id,
      // Annotate the job (0046) so the customer's job page — which shows this
      // job's conversation — actually contains the reply its own copy
      // promises ("Your crew replied below"). Without this the crew's message
      // lands only on the property board (review finding).
      job_id: d.job_id,
      from_user: crewUserId,
      body: `About the ${svcName} — we saw your note and want to get this right. What would you like us to do? We can come back, or talk it through here.`,
    });
  }
  // The customer's resolve/still links ride along — a talk dispute can
  // quiet-close in the crew's favor, which is only fair if the customer
  // held the "still not right" lever the whole window (review finding).
  void notify(
    "the owner that their crew replied and the thread is open",
    { phone: owner?.phone, email: owner?.email },
    {
      sms: `LakeLife: your crew replied about the ${svcName} — see Messages in your portal to sort it out together. All set: ${site()}/d/${d.customer_token}/resolved · Still not right: ${site()}/d/${d.customer_token}/still 🌊`,
      subject: `Your crew replied about the ${svcName}`,
      body:
        `Your crew replied about the ${svcName} — see Messages in your portal to sort it out together.\n\n` +
        `  All set:\n  ${site()}/d/${d.customer_token}/resolved\n\n` +
        `  Still not right:\n  ${site()}/d/${d.customer_token}/still`,
    },
  );
  return { ok: true };
}

/** Customer accepts (photos convinced them / fix satisfied them informally). */
export async function customerResolved(customerToken: string): Promise<{ ok: boolean; error?: string; readFailed?: boolean }> {
  const admin = createServiceClient();
  const { d, readError } = await disputeForAction("customer", customerToken);
  // Flagged, not just worded: /d/<token>/resolved headlines a refusal as
  // "Already settled ✓", which is a claim about the dispute this read never saw.
  if (readError) return { ok: false, readFailed: true, error: readError };
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  // THE COMPARE-AND-SET HAS THREE ANSWERS, NOT TWO. `flipped` empty means
  // somebody else moved this dispute first — genuinely "already settled". A
  // failed WRITE also arrives as empty, and answering that with "Already
  // settled — thank you." is the same lie this whole change set exists to
  // remove, one layer down from the read that started it: the customer is told
  // it is closed, `releaseHeldPayout` below never runs, and the crew's pay
  // stays held with nobody told. The error is the third answer.
  const { data: flipped, error: flipErr } = await admin
    .from("disputes")
    .update({ status: "resolved_verified", resolved_at: new Date().toISOString(), resolution: "customer accepted" })
    .eq("id", d.id)
    .in("status", ["crew_review", "verifying", "talk", "fixing"])
    .select("id");
  if (flipErr) {
    console.error("[write failed] closing the dispute:", flipErr);
    return { ok: false, readFailed: true, error: readFailedMessage("this dispute", flipErr) };
  }
  if (!flipped || flipped.length === 0) return { ok: false, error: "Already settled — thank you." };
  await releaseHeldPayout(admin, d.job_id);
  return { ok: true };
}

/** Customer says it's STILL not right → the policy decides, no humans unless big. */
export async function customerStill(customerToken: string): Promise<{ ok: boolean; error?: string; refunded?: boolean; readFailed?: boolean }> {
  const { d, readError } = await disputeForAction("customer", customerToken);
  // Same flag, same reason: /d/<token>/still headlines a refusal as "Already
  // settled", and firePolicy below has seven refusals of its own that mean
  // "we couldn't check the money", not "this is closed".
  if (readError) return { ok: false, readFailed: true, error: readError };
  if (!d) return { ok: false, error: "That link isn't valid anymore." };
  if (!["verifying", "talk", "fixing", "crew_review"].includes(d.status)) return { ok: false, error: "Already settled." };
  return firePolicy(d, "customer says still unresolved");
}

/**
 * SESSION-AUTHORIZED doors to the two customer levers (job detail, 2026-07-26).
 *
 * customerResolved/customerStill are keyed by an unguessable customer_token
 * because they were built for an SMS link. The in-portal job page needs the
 * same two levers, but rendering that token into a page would be a real hole:
 * a token is a bearer credential, and the dispute row also carries the CREW's
 * token — ship either to a browser and one party can act as the other.
 *
 * So these resolve the token server-side from the job and never return it.
 * AUTH IS STILL THE CALLER'S JOB: the portal action must prove the signed-in
 * user owns the property behind this job BEFORE calling either of these.
 */
/** Returns the error alongside the token: both callers below turn a missing
 *  token into a confident sentence about this customer's dispute, and neither
 *  of those sentences is true when the read simply didn't happen. */
async function openDisputeTokenForJob(
  jobId: string,
  statuses: string[],
): Promise<{ token: string | null; error: unknown | null }> {
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("disputes")
    .select("customer_token")
    .eq("job_id", jobId)
    .in("status", statuses)
    .maybeSingle();
  return { token: (data?.customer_token as string) ?? null, error };
}

// The two status lists live in lib/dispute-policy.ts (pure + unit-tested):
// accepting is allowed anytime, escalating only after the crew has had its
// turn — the right-to-cure, enforced here rather than in the JSX.


/** "That settles it" from the portal — same path as the SMS link. */
export async function customerResolvedForJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const { token: tok, error } = await openDisputeTokenForJob(jobId, [...DISPUTE_ACCEPTABLE_STATUSES]);
  if (error) return { ok: false, error: readFailedMessage("the open request on this job", error) };
  if (!tok) return { ok: false, error: "There's nothing open on this job." };
  return customerResolved(tok);
}

/** "Still not right" from the portal — fires the same policy engine. */
export async function customerStillForJob(jobId: string): Promise<{ ok: boolean; error?: string; refunded?: boolean }> {
  const { token: tok, error } = await openDisputeTokenForJob(jobId, [...DISPUTE_ESCALATABLE_STATUSES]);
  // "Your crew is still working on this one" is a statement about the crew.
  // Don't make it on behalf of a read that failed.
  if (error) return { ok: false, error: readFailedMessage("the open request on this job", error) };
  if (!tok) {
    return { ok: false, error: "Your crew is still working on this one — give them a chance to make it right, and you'll get a yes/no from us as soon as they respond." };
  }
  return customerStill(tok);
}

/** Correction visit's fresh 👍/👎 closes the loop. */
export async function resolveFromCorrection(correctionJobId: string, good: boolean): Promise<void> {
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id")
    .eq("correction_job_id", correctionJobId)
    .maybeSingle();
  // Returns void — nobody is waiting on a sentence. Treating a failed read as
  // "no dispute on this correction" would drop the verdict on the free return
  // visit entirely; skip instead, and the nightly sweep still owns this row.
  if (error) {
    console.error("[read failed] the dispute behind this correction visit:", error);
    return;
  }
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
// `readFailed` on a refusal marks the ones below that mean "we couldn't look",
// as opposed to "we looked, and it's already settled". The two read identically
// to a caller holding only `{ ok:false, error }`, and the customer-facing pages
// headline the second — so the flag is what keeps a dropped read from being
// announced as a settlement.
async function firePolicy(d: DisputeRow, why: string): Promise<{ ok: boolean; error?: string; refunded?: boolean; readFailed?: boolean }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();

  // EVERY READ IN THIS FUNCTION DECIDES MONEY, AND NOBODY IS WATCHING.
  // A failed read here reads as $0 captured, $0 already refunded and a
  // spotless customer history — which walks straight into the "nothing left
  // to refund" branch below: dispute closed, held pay released, customer
  // never refunded, no error anywhere. Refuse the whole pass instead; the
  // caller either shows the sentence or (in the sweep) skips this row until
  // tomorrow.
  const { data: job, error: jobErr } = await admin
    .from("jobs").select("id, customer_price, properties(owner_id)").eq("id", d.job_id).maybeSingle();
  if (jobErr) return { ok: false, readFailed: true, error: readFailedMessage("this job", jobErr, { money: true }) };
  const ownerId = (one(job?.properties) as { owner_id?: string } | null)?.owner_id ?? null;
  const { data: invoice, error: invoiceErr } = await admin
    .from("invoices").select("id").eq("job_id", d.job_id).maybeSingle();
  if (invoiceErr) return { ok: false, readFailed: true, error: readFailedMessage("the bill on this job", invoiceErr, { money: true }) };
  const { data: payment, error: paymentErr } = invoice
    ? await admin.from("payments").select("amount").eq("invoice_id", invoice.id).eq("status", "captured").maybeSingle()
    : { data: null, error: null };
  if (paymentErr) return { ok: false, readFailed: true, error: readFailedMessage("the payment on this bill", paymentErr, { money: true }) };
  const captured = Number(payment?.amount ?? 0);
  const { data: priorRefRows, error: priorRefErr } = invoice
    ? await admin.from("refunds").select("amount").eq("invoice_id", invoice.id)
    : { data: [] as Array<{ amount: number }>, error: null };
  if (priorRefErr) return { ok: false, readFailed: true, error: readFailedMessage("the refunds already on this bill", priorRefErr, { money: true }) };
  const alreadyRefunded = (priorRefRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);

  let priorDisputes = 0;
  if (ownerId) {
    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const { data: props, error: propsErr } = await admin.from("properties").select("id").eq("owner_id", ownerId);
    if (propsErr) return { ok: false, readFailed: true, error: readFailedMessage("this customer's properties", propsErr, { money: true }) };
    const propIds = (props ?? []).map((p) => p.id as string);
    if (propIds.length) {
      const { data: priorJobs, error: priorJobsErr } = await admin.from("jobs").select("id").in("property_id", propIds);
      if (priorJobsErr) return { ok: false, readFailed: true, error: readFailedMessage("this customer's past jobs", priorJobsErr, { money: true }) };
      const jobIds = (priorJobs ?? []).map((j) => j.id as string);
      if (jobIds.length) {
        // FAILS OPEN IF IGNORED: a failed count is null, `count ?? 0` reads as
        // a first-time complaint, and the repeat-refund escalation — the one
        // check standing between a serial refunder and an automatic payout —
        // never fires.
        const { count, error: countErr } = await admin
          .from("disputes").select("id", { count: "exact", head: true })
          .in("job_id", jobIds).eq("status", "resolved_refunded").gte("opened_at", yearAgo);
        if (countErr) return { ok: false, readFailed: true, error: readFailedMessage("this customer's earlier refunds", countErr, { money: true }) };
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
    const { data: earning, error: earningErr } = await admin
      .from("payouts").select("batch_id").eq("job_id", d.job_id).eq("kind", "earning").maybeSingle();
    // Escalating is the safe move either way, so this doesn't refuse — but the
    // note tells a human whether the recovery is a release or an adjustment,
    // and "not batched" is not something we can claim from a failed read.
    if (earningErr) console.error(`[read failed] the crew's earning on dispute ${d.id}:`, earningErr);
    const batchedNote = earningErr
      ? " — couldn't check whether crew pay was already claimed into a batch"
      : earning?.batch_id != null ? " — crew pay already claimed into a batch; recover via adjustment" : "";
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
  const { data, error } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id")
    .eq("id", disputeId)
    .maybeSingle();
  if (error) return { ok: false, error: readFailedMessage("this dispute", error, { money: true }) };
  if (!data) return { ok: false, error: "Dispute not found." };
  const d = data as DisputeRow;
  if (d.status !== "escalated") return { ok: false, error: "Only escalated disputes land here — this one already resolved." };

  if (outcome === "close") {
    // Same three answers. A failed write told ops "Already resolved by another
    // path", so the dispute stays escalated and nobody goes back to it.
    const { data: flipped, error: flipErr } = await admin
      .from("disputes")
      .update({ status: "resolved_closed", resolved_at: new Date().toISOString(), resolution: "ops closed in crew's favor" })
      .eq("id", d.id).eq("status", "escalated")
      .select("id");
    if (flipErr) {
      console.error("[write failed] closing the escalated dispute:", flipErr);
      return { ok: false, error: readFailedMessage("this dispute", flipErr) };
    }
    if (!flipped || flipped.length === 0) return { ok: false, error: "Already resolved by another path." };
    await releaseHeldPayout(admin, d.job_id);
    return { ok: true };
  }

  // refund: remaining cash back, clawback reduces the HELD earning in place
  // (planClawback is held-aware), then the crew's remainder releases.
  // Same shape as firePolicy, same stakes: a failed read here reads as $0
  // captured, which lands on "nothing left to refund" — the dispute closes,
  // the crew's held pay releases, and the customer ops just promised a refund
  // to never gets one. Refuse; the dispute stays escalated and re-clickable.
  const { data: invoice, error: invoiceErr } = await admin.from("invoices").select("id").eq("job_id", d.job_id).maybeSingle();
  if (invoiceErr) return { ok: false, error: readFailedMessage("the bill on this job", invoiceErr, { money: true }) };
  const { data: payment, error: paymentErr } = invoice
    ? await admin.from("payments").select("amount").eq("invoice_id", invoice.id).eq("status", "captured").maybeSingle()
    : { data: null, error: null };
  if (paymentErr) return { ok: false, error: readFailedMessage("the payment on this bill", paymentErr, { money: true }) };
  const captured = Number(payment?.amount ?? 0);
  const { data: priorRows, error: priorErr } = invoice
    ? await admin.from("refunds").select("amount").eq("invoice_id", invoice.id)
    : { data: [] as Array<{ amount: number }>, error: null };
  if (priorErr) return { ok: false, error: readFailedMessage("the refunds already on this bill", priorErr, { money: true }) };
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
export async function sweepDisputeDeadlines(): Promise<{ ok: boolean; fired: number; escalated: number; quietCloses: number; reconciled: number; couldNotRead: string[] }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();
  const now = new Date().toISOString();
  let fired = 0, escalated = 0, quietCloses = 0, reconciled = 0;
  // WHAT THIS RUN COULD NOT LOOK AT, in human words. Without it the counts are
  // the only thing that leaves this function, and a section that failed to read
  // contributes 0 — indistinguishable from a section where nothing was due.
  // Every count below is therefore a FLOOR whenever this list is non-empty, and
  // `ok` is false so a caller cannot read the run as clean. (The nightly digest
  // renders only fired/escalated/quietCloses/reconciled today; wiring this list
  // into it is the remaining half.)
  const couldNotRead: string[] = [];

  // NOBODY IS WATCHING THIS RUN, so the rule here is: log and skip, never
  // abort the night. A failed list read leaves its section empty for one
  // night — the rows are still there tomorrow — and it is named in
  // `couldNotRead` so it can never be mistaken for "nothing was due".
  const { data: overdue, error: overdueErr } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id, opened_at")
    .eq("status", "crew_review")
    .lt("respond_by", now)
    .limit(50);
  if (overdueErr) {
    console.error("[read failed] the disputes past their cure window:", overdueErr);
    couldNotRead.push("the disputes past their cure window");
  }
  for (const row of overdue ?? []) {
    const r = await firePolicy(row as DisputeRow, "crew did not respond in the cure window");
    // Logged inside the policy; named here too, so the run's own result says a
    // row was skipped rather than reporting one fewer refund as a quiet night.
    if (!r.ok) { couldNotRead.push(`the money behind dispute ${row.id}`); continue; } // retry tomorrow
    if (r.refunded) fired++; else escalated++;
  }

  const fixCutoff = new Date(Date.now() - settings.disputeFixDays * 86_400_000).toISOString();
  const confQuietCutoff = new Date(Date.now() - CORRECTION_QUIET_DAYS * 86_400_000).toISOString();
  const { data: fixing, error: fixingErr } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id, opened_at")
    .eq("status", "fixing")
    .limit(50);
  if (fixingErr) {
    console.error("[read failed] the disputes waiting on a correction visit:", fixingErr);
    couldNotRead.push("the disputes waiting on a correction visit");
  }
  for (const row of fixing ?? []) {
    const { data: fix, error: fixErr } = row.correction_job_id
      ? await admin.from("jobs").select("status").eq("id", row.correction_job_id).maybeSingle()
      : { data: null, error: null };
    // Falling through would read "couldn't look" as "the visit never happened"
    // and fire the policy — a refund, on a crew that may well have shown up.
    if (fixErr) {
      console.error(`[read failed] the correction visit on dispute ${row.id}:`, fixErr);
      couldNotRead.push(`the correction visit on dispute ${row.id}`);
      continue;
    }
    if (fix && ["complete", "paid"].includes(fix.status as string)) {
      // The cure happened and was photo-gated. The customer got a fresh
      // 👍/👎 link at completion — if they've sat on it CORRECTION_QUIET_DAYS,
      // the evidence wins: resolve fixed, release the crew's pay. Without
      // this, customer apathy (the common case) strands held pay forever
      // on a crew that did the free cure (review finding).
      const { data: conf, error: confErr } = await admin
        .from("job_confirmations")
        .select("id, verdict, created_at")
        .eq("job_id", row.correction_job_id as string)
        .maybeSingle();
      // FAILS OPEN IF IGNORED: a failed read reads as "no verdict yet", and the
      // quiet-close below would resolve in the crew's favour and release the
      // held pay over a 👎 that is sitting right there unread.
      if (confErr) {
        console.error(`[read failed] the customer's verdict on the correction visit for dispute ${row.id}:`, confErr);
        couldNotRead.push(`the customer's verdict on the correction visit for dispute ${row.id}`);
        continue;
      }
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
      if (!r.ok) { couldNotRead.push(`the money behind dispute ${row.id}`); continue; } // logged in the policy — retry tomorrow
      if (r.refunded) fired++; else escalated++;
    }
  }

  const { data: stalledConvos, error: stalledErr } = await admin
    .from("disputes")
    .select("id, job_id, status, customer_note, customer_token, crew_token, correction_job_id, opened_at")
    .in("status", ["talk", "verifying"])
    .lt("opened_at", fixCutoff)
    .limit(50);
  if (stalledErr) {
    console.error("[read failed] the stalled dispute conversations:", stalledErr);
    couldNotRead.push("the stalled dispute conversations");
  }
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
  const { data: issues, error: issuesErr } = await admin
    .from("job_confirmations")
    .select("job_id, note, vendor_id, jobs(correction_of, services(name))")
    .eq("verdict", "issue")
    .gte("responded_at", weekAgo)
    .limit(100);
  // This pass exists BECAUSE a transient failure can lose a complaint. Losing
  // it again to a silent read failure — reported as "0 reconciled" — is the
  // same bug one level up.
  if (issuesErr) {
    console.error("[read failed] this week's 👎 verdicts:", issuesErr);
    couldNotRead.push("this week's 👎 verdicts");
  }
  for (const c of issues ?? []) {
    const job = one((c as { jobs?: unknown }).jobs) as { correction_of?: string | null; services?: unknown } | null;
    if (job?.correction_of) continue; // correction 👎s belong to resolveFromCorrection
    // FAILS OPEN IF IGNORED: a failed count is null, `(count ?? 0) > 0` is
    // false, and this opens a SECOND dispute on a job that already has one —
    // re-holding the crew's pay and re-texting them about a complaint they
    // already answered.
    const { count, error: countErr } = await admin
      .from("disputes").select("id", { count: "exact", head: true })
      .eq("job_id", c.job_id as string);
    if (countErr) {
      console.error(`[read failed] the disputes already on job ${c.job_id}:`, countErr);
      couldNotRead.push(`the disputes already on job ${c.job_id}`);
      continue;
    }
    if ((count ?? 0) > 0) continue; // dispute exists (any status) — nothing lost
    const r = await openDisputeForJob(c.job_id as string, (c.note as string) ?? null);
    if (r.ok && r.crewLinks && c.vendor_id) {
      const svcName = (one(job?.services) as { name?: string } | null)?.name ?? "a recent job";
      const { data: v, error: vErr } = await admin.from("vendors").select("user_id").eq("id", c.vendor_id as string).maybeSingle();
      const { data: cu, error: cuErr } = v?.user_id
        ? await admin.from("users").select("phone, email").eq("id", v.user_id as string).maybeSingle()
        : { data: null, error: null };
      // The dispute is open and the pay is held either way — but a crew that is
      // never told why has no way to use its cure window.
      if (vErr || cuErr) console.error(`[read failed] the crew's number for job ${c.job_id}:`, vErr ?? cuErr);
      // EVERY DOOR, because this one holds their money and starts a clock.
      // It was a text alone, on a channel that has delivered 0 of 81 messages
      // since July — so a crew's pay was being held, a cure window was
      // running, and the only notice of either went nowhere. The email now
      // carries it, and `notify` says so when neither door takes it.
      const told = await notify(
        "the crew that their pay is held and their cure window has started",
        { phone: cu?.phone as string | null, email: cu?.email as string | null },
        {
          sms: `LakeLife: the customer flagged the ${svcName}. Your pay for it is ON HOLD until this is settled. Make it right (free return visit): ${r.crewLinks.fix} · It was done right: ${r.crewLinks.verify} · Talk it through: ${r.crewLinks.talk}`,
          subject: `Your pay for the ${svcName} is on hold — the customer flagged it`,
          // WORD FOR WORD THE SAME NOTICE AS job-verdict.ts, on purpose. This
          // is the sweep's copy of a message that file also sends; two versions
          // of one notice drifting apart is what job-verdict's own module
          // header exists to prevent.
          //
          // AND IT CLAIMS NOTHING THE CODE CANNOT BACK. The first draft of this
          // body said "answering is what releases it" and "if nobody answers,
          // this decides itself against you". Both were invented. Answering
          // does not release the hold — releaseHeldPayout runs on a RESOLUTION,
          // not on a reply — and silence does not decide against them either:
          // decideDisputeOutcome returns `escalate`, which sends it to a human.
          // Telling a crew their money turns on something it does not turn on
          // is the exact failure this whole change set is about, written into
          // the fix for it.
          body:
            `The customer flagged the ${svcName}, so your pay for that job is ON HOLD until it's settled.\n\n` +
            `You have three ways to answer:\n\n` +
            `  Make it right — book a free return visit:\n  ${r.crewLinks.fix}\n\n` +
            `  It was done right — send them your photos:\n  ${r.crewLinks.verify}\n\n` +
            `  Talk it through:\n  ${r.crewLinks.talk}`,
        },
      );
      if (!told.reached && told.note) couldNotRead.push(told.note);
      reconciled++;
    }
  }

  return { ok: couldNotRead.length === 0, fired, escalated, quietCloses, reconciled, couldNotRead };
}
