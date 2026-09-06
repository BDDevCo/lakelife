"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate, dayStatus } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";
import { cancellationQuote, type CancelQuote } from "@/lib/cancellation";
import { planRecovery } from "@/lib/recovery";
import { suggestTip, validateTip, tipSplit, canTip, tipDaysLeft } from "@/lib/tips";
import { revalidatePath } from "next/cache";
import { autoAssignJob } from "@/app/book/dispatch";
import { getAvailability } from "@/app/book/actions";
import { takePayment, NO_PROCESSOR_REASON, chargeKey } from "@/lib/charge-gate";
import { statementDescriptor } from "@/lib/descriptor";
import { alertOpsDoubleCharge, alertOpsCrewUnpaid } from "@/lib/automation";
import { notify } from "@/lib/notify";
import { sendEmail } from "@/lib/email";
import { readFailedMessage } from "@/lib/must-read";

export interface CancelResult {
  ok: boolean;
  error?: string;
  feeCharged?: number; // dollars, when a late fee applied
}

const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

/** Minutes past midnight in lake time — the policy clock. */
function lakeNowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Indiana/Indianapolis", hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

interface LoadedJob {
  job: {
    id: string; status: string; date: string | null; slot: string | null;
    customer_price: number; vendor_cost: number | null; vendor_id: string | null; property_id: string;
    /** The id, not the name — a name is a label and can be edited. */
    service_id: string | null;
    group_id: string | null;
    // 0084/0088/0089 — a visit that happened but produced no work.
    no_show_at: string | null;
    stood_down_at: string | null;
    recovery_state: string | null;
    reschedule_deadline: string | null;
  };
  svcName: string;
  isWaterWork: boolean;
  ownerId: string | null;
  address: string | null;
}

/**
 * "We couldn't look" — the third answer this gate has always had and never
 * been able to give. A failed read resolves to `{ data: null }`, which is the
 * same value as "no such job" and as "somebody else's job", so every caller
 * below told the owner "That request isn't yours" about a request that is
 * theirs. This carries the failure out separately so nobody asserts whose it
 * is when the answer was never read.
 */
interface LoadFailure { readFailed: true; error: unknown }
const loadFailed = (l: LoadedJob | LoadFailure | null): l is LoadFailure =>
  !!l && (l as LoadFailure).readFailed === true;

/** Load a job + verify the signed-in user owns its property. Null = not theirs. */
async function loadOwnJob(jobId: string): Promise<LoadedJob | LoadFailure | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !jobId) return null;
  const admin = createServiceClient();
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, status, date, slot, customer_price, vendor_cost, vendor_id, property_id, service_id, group_id, no_show_at, stood_down_at, recovery_state, reschedule_deadline, services(name, is_water_work), properties(owner_id, address)")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr) return { readFailed: true, error: jobErr };
  if (!job) return null;
  const prop = one(job.properties) as { owner_id?: string; address?: string } | null;
  if (prop?.owner_id !== user.id) return null;
  const svc = one(job.services) as { name?: string; is_water_work?: boolean } | null;
  return {
    job: {
      id: job.id as string,
      status: job.status as string,
      date: (job.date as string) ?? null,
      slot: (job.slot as string) ?? null,
      customer_price: Number(job.customer_price ?? 0),
      vendor_cost: job.vendor_cost == null ? null : Number(job.vendor_cost),
      vendor_id: (job.vendor_id as string) ?? null,
      property_id: job.property_id as string,
      service_id: (job.service_id as string) ?? null,
      group_id: (job.group_id as string) ?? null,
      no_show_at: (job.no_show_at as string) ?? null,
      stood_down_at: (job.stood_down_at as string) ?? null,
      recovery_state: (job.recovery_state as string) ?? null,
      reschedule_deadline: (job.reschedule_deadline as string) ?? null,
    },
    svcName: svc?.name ?? "service",
    isWaterWork: !!svc?.is_water_work,
    ownerId: (prop?.owner_id as string) ?? null,
    address: (prop?.address as string) ?? null,
  };
}

async function quoteFor(l: LoadedJob): Promise<CancelQuote> {
  const dials = await getPlatformSettings();
  return cancellationQuote(
    {
      status: l.job.status,
      hasCrew: l.job.vendor_id != null,
      isWaterWork: l.isWaterWork,
      jobDateISO: l.job.date,
      slot: l.job.slot,
      nowDateISO: todayLakeDate(),
      nowMinutes: lakeNowMinutes(),
      customerPrice: l.job.customer_price,
      vendorCost: l.job.vendor_cost,
    },
    dials,
  );
}

export interface CancelQuoteView {
  allowed: boolean;
  free: boolean;
  fee: number;
  policyNote: string; // customer-facing one-liner for the confirm dialog
}

/** What would cancelling THIS job cost right now? (Display only — the cancel
 *  action recomputes; never trust the number the browser saw.) */
export async function quoteCancellation(jobId: string): Promise<CancelQuoteView> {
  const l = await loadOwnJob(jobId);
  // The button toasts policyNote whenever allowed is false, so the failure has
  // somewhere honest to land without a new field.
  if (loadFailed(l)) return { allowed: false, free: false, fee: 0, policyNote: readFailedMessage("this request", l.error) };
  if (!l) return { allowed: false, free: false, fee: 0, policyNote: "That request isn't yours to cancel." };
  const q = await quoteFor(l);
  if (!q.allowed) return { allowed: false, free: false, fee: 0, policyNote: "A crew is already on this one — send us a message from your portal and we'll sort it out." };
  if (q.free) return { allowed: true, free: true, fee: 0, policyNote: "No charge — this one cancels free." };
  const pct = Math.round(q.feePct * 100);
  return {
    allowed: true, free: false, fee: q.fee,
    policyNote: `Your crew held this slot, so a ${pct}% late fee ($${q.fee.toFixed(2)}) applies. Cancelling earlier next time is always free.`,
  };
}

/**
 * Cancel one of the customer's own requests, policy-aware:
 *  - free cancel → the job row is deleted (as before) and capacity reopens;
 *  - late cancel → the job is kept as 'cancelled' with a fee invoice (charged
 *    to the saved card; left 'due' on their Billing page if the charge fails),
 *    and the crew is paid their rate share of the fee (they held the slot).
 * Everything is recomputed and re-guarded server-side.
 */
export async function cancelRequest(jobId: string): Promise<CancelResult> {
  const l = await loadOwnJob(jobId);
  if (loadFailed(l)) return { ok: false, error: readFailedMessage("this request", l.error, { money: true }) };
  if (!l) return { ok: false, error: "That request isn't yours to cancel." };
  const q = await quoteFor(l);
  if (!q.allowed) {
    return { ok: false, error: "A crew is already on this one — send us a message from your portal and we'll sort it out." };
  }

  const admin = createServiceClient();
  const groupId = (l.job as { group_id?: string | null }).group_id ?? null;

  // A boat already IN winter storage never self-serve-cancels its splash —
  // that's a release conversation, not a booking cancel. This guard runs
  // BEFORE either path (the fee path flips first, so a late check would
  // cancel the job and strand the boat with no billing rail).
  if (groupId) {
    const custodyRes = await admin
      .from("storage_stays").select("id").eq("group_id", groupId).eq("status", "in_storage").limit(1);
    // THIS GUARD FAILED OPEN. A failed read is `data: null`, so `length > 0`
    // was false and a boat sitting in somebody's barn had its splash cancelled
    // by the very check written to stop that. Not knowing is not "no boat".
    if (custodyRes.error) {
      return { ok: false, error: readFailedMessage("this request", custodyRes.error, { money: true }) };
    }
    const custody = custodyRes.data;
    if (custody && custody.length > 0) {
      return { ok: false, error: "Your boat is in winter storage — message us from your portal to arrange the splash or a release instead." };
    }
  }

  // Package fall visit (S2): the cancel must also close the season
  // envelope and free the barn's reserved feet — otherwise the vendor
  // carries phantom feet all winter and S4 births spring work for a
  // package whose fall never happened. A boat already IN storage never
  // self-serve-cancels (that's a release flow, not a booking cancel).
  const cascadePackage = async (): Promise<string | null> => {
    if (!groupId) return null;
    const stayRes = await admin
      .from("storage_stays").select("id, status").eq("group_id", groupId).maybeSingle();
    // Same fail-open shape as the custody check above: a failed read reads as
    // "there is no stay", which would close the season envelope and hand the
    // barn's reserved feet back for a boat that may well be in it.
    if (stayRes.error) {
      return readFailedMessage("this booking", stayRes.error, { money: true });
    }
    const stay = stayRes.data;
    if (stay?.status === "in_storage") {
      return "Your boat is already in winter storage — message us from your portal to arrange a release instead.";
    }
    if (stay) await admin.from("storage_stays").update({ status: "cancelled" }).eq("id", stay.id as string).eq("status", "reserved");
    await admin.from("job_groups").update({ status: "cancelled", storing_vendor: null }).eq("id", groupId);
    return null;
  };

  // ---------- FREE PATH (also covers a degenerate $0 fee): delete, verified ----------
  if (q.free || q.fee <= 0) {
    if (groupId) {
      const blocked = await cascadePackage();
      if (blocked) return { ok: false, error: blocked };
    }
    const { data: gone, error } = await admin
      .from("jobs").delete().eq("id", jobId).in("status", ["requested", "scheduled"]).select("id");
    if (error) return { ok: false, error: error.message };
    if (!gone || gone.length === 0) return { ok: false, error: "This job just changed — refresh and try again." };
    return { ok: true };
  }

  // ---------- FEE PATH ----------
  // Flip to cancelled first (guarded on current status) so a concurrent crew
  // start / double-click can't double-charge: only ONE caller wins this update.
  const { data: flipped, error: flipErr } = await admin
    .from("jobs")
    .update({ status: "cancelled", route_id: null, sequence: null })
    .eq("id", jobId)
    .eq("status", "scheduled")
    .select("id");
  // A failed update also returns `data: null`, and "this job just changed" is a
  // fact we'd have no way of knowing. Nothing has moved yet either way.
  if (flipErr) return { ok: false, error: readFailedMessage("this request", flipErr, { money: true }) };
  if (!flipped || flipped.length === 0) {
    return { ok: false, error: "This job just changed — refresh and try again." };
  }
  if (groupId) await cascadePackage(); // envelope + reserved feet close with the job
  // (the return is discarded on purpose here — the custody guard above already
  // refused an in-storage boat; a read failure inside is logged by cascadePackage.)

  // Fee invoice + charge (mirrors settleJob; invoice stays 'due' if the card fails).
  //
  // THE JOB IS ALREADY CANCELLED BY HERE, so a failed read below cannot be
  // answered by refusing — the cancel really did happen and saying otherwise
  // would be the bigger lie. What a failure changes is what we may TELL them:
  // `feeOnFile` tracks whether the fee actually landed on a bill, and neither
  // the SMS nor the returned `feeCharged` claims a fee unless one exists.
  const invRes = await admin.from("invoices").select("id, status").eq("job_id", jobId).maybeSingle();
  if (invRes.error) {
    // Do NOT fall through to the insert: `invoices_one_per_job` is UNIQUE, so
    // blind-inserting over an invoice we simply couldn't see raises a 23505
    // whose error is discarded, and the fee ends up neither read nor written.
    console.error("[read failed] this job's invoice:", invRes.error.code ?? "", invRes.error.message ?? invRes.error);
  }
  let invoice = invRes.data;
  if (!invoice && !invRes.error) {
    const { data: created, error: createErr } = await admin
      .from("invoices")
      .insert({ job_id: jobId, property_id: l.job.property_id, amount: q.fee, status: "due" })
      .select("id, status")
      .single();
    if (createErr) {
      console.error("[write failed] this job's fee invoice:", createErr.code ?? "", createErr.message ?? createErr);
    }
    invoice = created;
  }
  /** Did the fee actually reach a bill? Nothing below may say so if it didn't. */
  const feeOnFile = !!invoice;
  let charged = false;
  if (invoice && invoice.status !== "paid" && l.ownerId) {
    const pmRes = await admin
      .from("payment_methods")
      .select("token, last4, brand")
      .eq("user_id", l.ownerId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // No card and an unreadable card list both end with the invoice sitting
    // 'due', which is the honest outcome — but only one of them is a fault.
    if (pmRes.error) {
      console.error("[read failed] the card on file:", pmRes.error.code ?? "", pmRes.error.message ?? pmRes.error);
    }
    const pm = pmRes.data;
    // NEVER CHARGE A CARD FOR AN INVOICE THAT IS ALREADY PAID.
    //
    // `payments_one_capture_per_invoice` (0024) allows exactly one captured
    // row per invoice. The card used to be charged FIRST and the insert's
    // error then discarded — so if anything else had already collected this
    // fee, the second charge went through the processor and its record was
    // silently rejected. Money taken, nothing on file, and `processor_ref`
    // overwritten on top.
    //
    // AND THIS IS THE READ THAT CHARGES TWICE WHEN IT FAILS. `data` comes back
    // null, `length > 0` is false, and the branch below takes the card again
    // for a fee something else may already have collected — the exact hole the
    // paragraph above describes, reopened by the failure path instead of the
    // ordering. Not knowing whether it was collected means not collecting it:
    // the invoice stays 'due' and can be settled once reads work again.
    //
    // ONE READ, TWO ANSWERS. It also counts how many times this card has
    // already declined on this invoice, because that number is part of the
    // idempotency key — see `chargeKey`. Reading it here rather than in a
    // second query keeps both facts behind the same failure: if we cannot see
    // this invoice's payments we do not charge at all.
    const capRes = await admin
      .from("payments").select("id, status").eq("invoice_id", invoice.id)
      .in("status", ["captured", "failed"]);
    const seen = capRes.data ?? [];
    const alreadyCaptured = seen.filter((p) => p.status === "captured");
    const declines = seen.filter((p) => p.status === "failed").length;
    if (capRes.error) {
      console.error("[read failed] this fee's payments:", capRes.error.code ?? "", capRes.error.message ?? capRes.error);
    } else if (alreadyCaptured.length > 0) {
      await admin.from("invoices").update({ status: "paid" }).eq("id", invoice.id);
      charged = true;
    } else if (pm?.token) {
      // THE SAME KEY THE NIGHTLY RETRY SENDS. `retryCancellationFees` comes
      // back for this invoice every night until it settles; if the two doors
      // built different keys, a fee collected here and lost in a crash would
      // be charged a SECOND time tonight instead of replayed.
      const charge = await takePayment({
        token: pm.token as string,
        amountCents: Math.round(q.fee * 100),
        description: statementDescriptor("cancel_fee"),
        idempotencyKey: chargeKey("cancel_fee", invoice.id as string, declines),
      });
      // A NON-ATTEMPT IS NOT A DECLINE (see charge-gate). With no processor
      // connected nobody's card was asked, so there is no attempt to file and
      // nothing to blame them for.
      if (!charge.ok && charge.reason === NO_PROCESSOR_REASON) {
        return { ok: false, error: "Card payments aren't switched on yet — nothing was charged. The office can take this one." };
      }
      const { error: payErr } = await admin.from("payments").insert({
        invoice_id: invoice.id, amount: q.fee, status: charge.ok ? "captured" : "failed", processor_ref: charge.ref ?? null,
      });
      // THE PROCESSOR TOOK THE MONEY AND THE LEDGER REFUSED TO RECORD IT —
      // for any reason, not only a duplicate. The old condition named 23505
      // alone, so a dropped connection took the fee, marked the invoice paid,
      // and told nobody. Only a human can give that back.
      //
      // The invoice deliberately stays 'due' when the row failed: the nightly
      // retry finds it, sends the identical key, and the processor replays
      // rather than charges — so the row gets another chance and the card is
      // never touched twice.
      if (charge.ok && payErr) {
        await alertOpsDoubleCharge(admin, invoice.id as string, q.fee, charge.ref ?? null);
      }
      if (charge.ok && !payErr) await admin.from("invoices").update({ status: "paid", processor_ref: charge.ref ?? null }).eq("id", invoice.id);
      charged = charge.ok;
    }
  }

  // Crew share — paid from the fee actually COLLECTED (roadmap §2). If the
  // charge failed, the invoice sits 'due' and no payout releases: LakeLife
  // never fronts crew pay against an uncollected fee. One per job.
  if (charged && l.job.vendor_id && q.crewShare > 0) {
    const existRes = await admin.from("payouts").select("id").eq("job_id", jobId).eq("kind", "earning").maybeSingle();
    // Logged, then the insert is still attempted: `payouts_one_earning_per_job`
    // (0043b) is the real guard, so a failed read here cannot double-pay — and
    // skipping the insert on a failed read WOULD leave the crew unpaid.
    if (existRes.error) {
      console.error("[read failed] this job's crew payout:", existRes.error.code ?? "", existRes.error.message ?? existRes.error);
    }
    const existing = existRes.data;
    if (!existing) {
      await admin.from("payouts").insert({
        vendor_id: l.job.vendor_id, job_id: jobId, amount: q.crewShare, original_amount: q.crewShare, status: "released",
      });
    }
  }

  // Tell both sides. Crew: slot freed + what they're paid. Owner: confirmation.
  // A failed lookup here costs a text, not money, so it is logged and stepped
  // over rather than unwinding a cancel that already happened — but it is
  // LOGGED, because "no phone on file" and "we couldn't look" are different
  // faults and only one of them is the vendor's to fix.
  if (l.job.vendor_id) {
    const vRes = await admin.from("vendors").select("user_id").eq("id", l.job.vendor_id).maybeSingle();
    if (vRes.error) console.error("[read failed, degraded] the crew's account:", vRes.error.code ?? "", vRes.error.message ?? vRes.error);
    const v = vRes.data;
    if (v?.user_id) {
      const cuRes = await admin.from("users").select("phone, email").eq("id", v.user_id).maybeSingle();
      if (cuRes.error) console.error("[read failed, degraded] the crew's phone:", cuRes.error.code ?? "", cuRes.error.message ?? cuRes.error);
      const cu = cuRes.data;
      if (cu?.phone || cu?.email) {
        const payLine = charged && q.crewShare > 0
          ? `you're paid $${q.crewShare.toFixed(2)} for holding the slot`
          : "your slot share releases once the fee settles";
        // EVERY DOOR: this says what they are paid for a stop that is no longer
        // on their route. On text alone it has reached nobody since July.
        await notify(
          "the crew that a stop was cancelled late and what it pays",
          { phone: cu.phone as string | null, email: cu.email as string | null },
          {
            sms: `LakeLife: the ${l.svcName} at ${l.address ?? "a stop"} on ${l.job.date} was cancelled late — ${payLine}. Your route will update tonight. 🌊`,
            subject: `${l.svcName} on ${l.job.date} was cancelled late`,
          },
        );
      }
    }
  }
  const ouRes = await admin.from("users").select("phone, email").eq("id", l.ownerId ?? "").maybeSingle();
  if (ouRes.error) console.error("[read failed, degraded] the owner's phone:", ouRes.error.code ?? "", ouRes.error.message ?? ouRes.error);
  const ou = ouRes.data;
  if (ou?.phone || ou?.email) {
    // The fee clause goes out only when a fee actually reached a bill. If the
    // invoice could neither be read nor raised above, "will appear on your
    // next bill" names a charge that exists nowhere — and the same is true of
    // the `feeCharged` the button turns into "$X late fee applied".
    //
    // EVERY DOOR: on the fee branch this is the only notice that money was
    // taken from their card, and text alone has delivered none of it.
    await notify(
      `the owner that their ${l.svcName} is cancelled`,
      { phone: ou.phone as string | null, email: ou.email as string | null },
      feeOnFile
        ? {
            sms: `LakeLife: your ${l.svcName} is cancelled. A ${Math.round(q.feePct * 100)}% late fee of $${q.fee.toFixed(2)} ${charged ? "was charged to your card on file" : "will appear on your next bill"} — cancelling more than ${l.isWaterWork ? "7 days" : "48 hours"} ahead is always free. 🌊`,
            subject: `Your ${l.svcName} is cancelled — a late fee applies`,
          }
        : {
            sms: `LakeLife: your ${l.svcName} is cancelled. Cancelling more than ${l.isWaterWork ? "7 days" : "48 hours"} ahead is always free. 🌊`,
            subject: `Your ${l.svcName} is cancelled`,
          },
    );
  }

  return feeOnFile ? { ok: true, feeCharged: q.fee } : { ok: true };
}

// ==========================================================================
// THE VISIT WHERE NOBODY GOT ANY WORK DONE
// ==========================================================================

export interface RescheduleView {
  /** Does this job need recovering at all? */
  needed: boolean;
  outcome: "no_access" | "stood_down" | null;
  /** What the crew wrote at the door. */
  reason: string | null;
  ask: string;
  ifNothingHappens: string;
  deadline: string | null;
  /** False for a stand-down — our record was wrong, so nobody is charged. */
  feeEligible: boolean;
  /**
   * We couldn't read the visit. `needed: false` renders NOTHING, which on this
   * particular card is the old fault in miniature: the whole reason it exists
   * is that a customer was asked to pick another day, given no door, and
   * charged seven days later. Silently withholding the door on a failed read
   * walks straight back into that. The card says so instead.
   */
  unavailable?: boolean;
}

/** What the customer is looking at, and what they're being asked. */
export async function getRescheduleView(jobId: string): Promise<RescheduleView> {
  const empty: RescheduleView = {
    needed: false, outcome: null, reason: null, ask: "", ifNothingHappens: "",
    deadline: null, feeEligible: false,
  };
  const loaded = await loadOwnJob(jobId);
  if (loadFailed(loaded)) {
    console.error("[read failed] this visit:", loaded.error);
    return { ...empty, unavailable: true };
  }
  if (!loaded) return empty;

  const { job, svcName } = loaded;
  if (job.recovery_state !== "awaiting_customer") return empty;

  const outcome: "no_access" | "stood_down" = job.stood_down_at ? "stood_down" : "no_access";
  // `no_show_at` is a TIMESTAMP in UTC; slicing its first ten characters gives
  // the UTC calendar day, which after 8pm in Indiana is already tomorrow. The
  // deadline shown to the customer was therefore a day later than the one the
  // nightly enforces off `jobs.reschedule_deadline` — and being told Monday
  // and cut off on Sunday is exactly the kind of thing that makes a fee feel
  // like a trick.
  //
  // So the stored deadline wins whenever there is one; the recomputation is
  // only a fallback for rows written before it existed.
  const attemptedOn = (job.no_show_at ?? job.stood_down_at ?? "").slice(0, 10) || todayLakeDate();
  const plan = planRecovery(outcome, attemptedOn, { serviceName: svcName });
  const enforced = job.reschedule_deadline ?? plan.deadline;
  const planned = enforced === plan.deadline
    ? plan
    : planRecovery(outcome, enforced, { serviceName: svcName, days: 0 });

  return {
    needed: true,
    outcome,
    reason: null, // the crew's words live on the job; the customer already got them
    ask: plan.ask,
    ifNothingHappens: planned.ifNothingHappens,
    deadline: enforced,
    feeEligible: plan.feeEligible,
  };
}

/**
 * BOTH PARTIES AGREE — the customer picks another day.
 *
 * This is the outcome the whole path is built to reach, so it is the easy one:
 * one tap from the email, one date, done. No fee, no conversation, no ops.
 *
 * It re-runs dispatch rather than assuming the same crew is free — the
 * original crew may already be booked solid on the new date, and silently
 * keeping them would produce a job nobody is actually coming to.
 */
export async function rescheduleUnworkedVisit(
  jobId: string,
  newDateISO: string,
): Promise<{ ok: boolean; error?: string; signal?: string }> {
  const loaded = await loadOwnJob(jobId);
  if (loadFailed(loaded)) return { ok: false, error: readFailedMessage("this visit", loaded.error) };
  if (!loaded) return { ok: false, error: "That visit isn't yours." };
  const { job, svcName } = loaded;

  if (job.recovery_state !== "awaiting_customer") {
    return { ok: false, error: "That one's already been sorted." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDateISO)) {
    return { ok: false, error: "Pick a date." };
  }
  const today = todayLakeDate();
  if (newDateISO <= today) {
    return { ok: false, error: "Pick a day that hasn't happened yet." };
  }

  // THE SAME GATE A FIRST BOOKING GETS. Rescheduling must not become a side
  // door around ice-out, the pull deadline, or a crew's real capacity — those
  // exist because a pier cannot go in through ice, not as paperwork.
  const admin0 = createServiceClient();
  // BY ID, NOT BY NAME. This re-found the service with `.eq("name", svcName)`,
  // and a name that has been edited — or a service renamed for a season —
  // returns null. `svcRow?.id` then short-circuits `fullDates` to empty and
  // `is_water_work` to false, so the gate FAILS OPEN: a pier could be
  // rescheduled through ice, and a full day would read as available. The job
  // already knows its service_id; a name is a label, not an identity.
  const [svcRes, propRes] = await Promise.all([
    job.service_id
      ? admin0.from("services").select("id, is_water_work").eq("id", job.service_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admin0.from("properties").select("lakes(ice_out_actual, pull_deadline)")
      .eq("id", job.property_id).maybeSingle(),
  ]);
  // A FAILED READ IS A GATE THAT DIDN'T RUN. The lake one is the quiet half:
  // `propRow` null leaves seasonStart/seasonEnd null, dayStatus fails closed to
  // "off-season", and the customer is told their pier is out of season on a day
  // that is squarely inside it. Refuse honestly instead — and never guess.
  if (svcRes.error || propRes.error) {
    return { ok: false, error: readFailedMessage("this lake's dates", svcRes.error ?? propRes.error) };
  }
  const svcRow = svcRes.data;
  const propRow = propRes.data;
  if (!svcRow?.id) {
    // Without the service we cannot apply ice-out, the pull deadline or
    // capacity. Refusing is the only safe answer — a silent pass is how a
    // pier ends up booked into February.
    return { ok: false, error: "We can't check the dates from here — send us a message from your portal and we'll move it." };
  }
  const lake = one(propRow?.lakes) as { ice_out_actual?: string; pull_deadline?: string } | null;
  const { fullDates, unavailable } = svcRow?.id
    ? await getAvailability(
        svcRow.id as string,
        Number(newDateISO.slice(0, 4)),
        Number(newDateISO.slice(5, 7)) - 1,
        job.property_id,
      )
    : { fullDates: [] as string[], unavailable: false };
  // getAvailability now says "we couldn't look" instead of throwing. Its empty
  // fullDates would fail this gate OPEN — the same way a missing service did
  // above — so refuse the move rather than book onto a day we never checked.
  if (unavailable) {
    return { ok: false, error: "We couldn't check that day's calendar just now, so nothing has been changed. Try again in a moment." };
  }

  const status = dayStatus(newDateISO, {
    today,
    isWaterWork: !!svcRow?.is_water_work,
    seasonStart: lake?.ice_out_actual ?? null,
    seasonEnd: lake?.pull_deadline ?? null,
    fullDates: new Set(fullDates),
    // No rush path here: a re-booked visit is a future date by the check above.
  });
  if (status !== "available") {
    return {
      ok: false,
      error:
        status === "off-season"
          ? `${svcName} is outside this lake's water-work season on that date.`
          : status === "full"
            ? "That day's crews are full — try another."
            : "Pick a day that hasn't happened yet.",
    };
  }

  const admin = createServiceClient();
  // 0089's trigger refuses this if the attempt was never written down, which
  // is the point: recovering a visit must not erase that it happened.
  const { error } = await admin
    .from("jobs")
    .update({
      date: newDateISO,
      no_show_at: null,
      no_show_reason: null,
      stood_down_at: null,
      stood_down_reason: null,
      recovery_state: "rescheduled",
      reschedule_deadline: null,
      status: "requested",   // re-dispatch: the old crew may not be free now
      vendor_id: null,
      vendor_cost: null,
      margin: null,
    })
    .eq("id", jobId)
    .eq("recovery_state", "awaiting_customer");   // no double-reschedule
  if (error) return { ok: false, error: error.message };

  try {
    await autoAssignJob(jobId);
  } catch {
    /* Left as requested; the nightly sweeps hunt for a crew. */
  }

  revalidatePath("/requests");
  // Spelled out, never "2026-08-20". A date a person reads is a date in words
  // — the T12:00:00 keeps a UTC-midnight parse from reading as the day before
  // in Indiana.
  const pretty = new Date(`${newDateISO}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
  return { ok: true, signal: `Booked in for ${pretty}. Nothing has been charged. 🌊` };
}

// ==========================================================================
// A THANK-YOU FOR THE CREW
// ==========================================================================

export interface TipView {
  canTip: boolean;
  why?: string;
  options: number[];
  typical: number;
  maxCustom: number;
  basis: string;
  /** Already given, if they have. */
  given: number | null;
  /** Days left in the window. Null when the visit has no date to run it from. */
  daysLeft: number | null;
}

/**
 * What to offer on a finished job.
 *
 * The suggestion is built from TIME ON SITE, never from the bill — at 20% of
 * the price, the implied tip per hour across our own services runs from $9.60
 * to $126.67, which is nearly random with respect to effort. See src/lib/tips.ts.
 */
export async function getTipView(jobId: string): Promise<TipView> {
  const blank: TipView = {
    canTip: false, options: [], typical: 0, maxCustom: 0, basis: "", given: null,
    daysLeft: null,
  };
  const loaded = await loadOwnJob(jobId);
  // A failed read means no tip is offered — the one place on this page where
  // silence is the honest outcome, because a tip is optional and the design is
  // that it is asked once and never nudged. `why` carries the reason for the
  // log; the card renders nothing either way, and nothing false is claimed.
  if (loadFailed(loaded)) return { ...blank, why: readFailedMessage("this visit", loaded.error) };
  if (!loaded) return blank;

  const admin = createServiceClient();
  const rowRes = await admin
    .from("jobs")
    .select("status, date, est_minutes, group_id, tip_amount, no_show_at, stood_down_at, services(est_minutes), job_items(services(est_minutes))")
    .eq("id", jobId)
    .maybeSingle();
  if (rowRes.error) return { ...blank, why: readFailedMessage("this visit", rowRes.error) };
  const row = rowRes.data;
  if (!row) return blank;

  const today = todayLakeDate();
  const gate = canTip({
    status: row.status as string,
    tip_amount: row.tip_amount == null ? null : Number(row.tip_amount),
    no_show_at: (row.no_show_at as string) ?? null,
    stood_down_at: (row.stood_down_at as string) ?? null,
    date: (row.date as string) ?? null,
  }, today);
  const daysLeft = tipDaysLeft((row.date as string) ?? null, today);

  // A PACKAGE VISIT IS THE LONGEST VISIT OF THE YEAR AND WAS STAMPED WITH
  // NOTHING. Only the two standalone write paths call `serviceMinutes`; both
  // group-job creators insert with no est_minutes. Reading the column alone
  // therefore handed `suggestTip` a null for a full fall haul-out — wrap,
  // rack, the lot — and null takes the SMALLEST band, $5/$10/$20.
  //
  // So fall back to the sum of the legs, which is what the visit actually is:
  // one truck, one driveway, all the work.
  const stamped = Number((row.est_minutes as number | null) ?? 0);
  let minutes: number | null = stamped > 0 ? stamped : null;
  if (minutes == null) {
    const legs = ((row as { job_items?: Array<{ services?: unknown }> }).job_items ?? [])
      .map((it) => {
        const sv = Array.isArray(it.services) ? it.services[0] : it.services;
        return Number((sv as { est_minutes?: number } | null)?.est_minutes ?? 0);
      })
      .filter((n) => n > 0);
    if (legs.length > 0) {
      minutes = legs.reduce((a, b) => a + b, 0);
    } else {
      const sv = Array.isArray(row.services) ? row.services[0] : row.services;
      const flat = Number((sv as { est_minutes?: number } | null)?.est_minutes ?? 0);
      minutes = flat > 0 ? flat : null;
    }
  }
  const s = suggestTip(minutes);

  return {
    canTip: gate.ok,
    why: gate.why,
    options: s.options,
    typical: s.typical,
    maxCustom: s.maxCustom,
    basis: s.basis,
    given: row.tip_amount == null ? null : Number(row.tip_amount),
    daysLeft,
  };
}

/**
 * Add it. Zero is a real answer and is recorded as one — it stops us asking
 * again, and it is the commonest reply.
 *
 * THE CHARGE COMES FIRST, then the payout — the same order the late-cancel
 * path uses. The crew is never promised money we have not collected, and
 * 0091's trigger refuses any tip payout that does not equal what the homeowner
 * actually gave, so skimming a thank-you is impossible rather than merely
 * discouraged.
 */
export async function addTip(
  jobId: string,
  raw: string | number,
): Promise<{ ok: boolean; error?: string; signal?: string }> {
  const loaded = await loadOwnJob(jobId);
  if (loadFailed(loaded)) return { ok: false, error: readFailedMessage("this visit", loaded.error, { money: true }) };
  if (!loaded) return { ok: false, error: "That visit isn't yours." };

  const admin = createServiceClient();
  const rowRes = await admin
    .from("jobs")
    .select("status, date, vendor_id, tip_amount, no_show_at, stood_down_at")
    .eq("id", jobId)
    .maybeSingle();
  // "That visit isn't yours" is a statement about their account, made from a
  // read that never came back. Every return here sits before the charge.
  if (rowRes.error) return { ok: false, error: readFailedMessage("this visit", rowRes.error, { money: true }) };
  const row = rowRes.data;
  if (!row) return { ok: false, error: "That visit isn't yours." };

  // The window is enforced HERE as well as on the screen — a stale tab is the
  // ordinary way a closed window gets tested, not an attack.
  const gate = canTip({
    status: row.status as string,
    tip_amount: row.tip_amount == null ? null : Number(row.tip_amount),
    no_show_at: (row.no_show_at as string) ?? null,
    stood_down_at: (row.stood_down_at as string) ?? null,
    date: (row.date as string) ?? null,
  }, todayLakeDate());
  if (!gate.ok) return { ok: false, error: gate.why };

  const v = validateTip(raw);
  if (!v.ok) return { ok: false, error: v.error };

  // DECLINING FIRST, because it moves no money and is the commonest answer.
  if (v.amount === 0) {
    const { error: zeroErr } = await admin
      .from("jobs")
      .update({ tip_amount: 0, tipped_at: new Date().toISOString() })
      .eq("id", jobId)
      .is("tip_amount", null);
    if (zeroErr) return { ok: false, error: zeroErr.message };
    revalidatePath("/requests");
    return { ok: true, signal: "Thanks — noted." };
  }

  // A TIP IS A CHARGE. The first version of this stamped the job, inserted the
  // crew's payout, and told the homeowner "Sent — all $50 goes to the crew"
  // while billing them NOTHING. LakeLife funded every tip out of margin, and
  // the month-end sweep paid it out the same evening. Five separate audit
  // passes found it independently, which is what a hole that size looks like.
  //
  // So the order is the same as the late-cancellation path 300 lines above:
  // invoice, card, payment row, and ONLY THEN the crew's payout. Nothing is
  // promised to the crew out of money we have not collected.
  if (!row.vendor_id) {
    // No crew on the job means nobody to pay. Better to refuse than to take
    // the money and have it land nowhere.
    return { ok: false, error: "We can't add a thank-you to this one — send us a message from your portal." };
  }

  const pmRes = await admin
    .from("payment_methods")
    .select("token, brand, last4")
    .eq("user_id", loaded.ownerId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // "Add a card in Billing first" is a fact about their account, and a failed
  // read had none to state — it sent people who have had a card on file for
  // years to a Billing page that already shows it. Still before the charge.
  if (pmRes.error) return { ok: false, error: readFailedMessage("your card on file", pmRes.error, { money: true }) };
  const pm = pmRes.data;
  if (!pm?.token) {
    return { ok: false, error: "Add a card in Billing first and we'll pass it straight on." };
  }

  // NO INVOICE. A tip is not money LakeLife earned — it is pass-through to the
  // crew, in full (0091) — so 0097 gives it a `payments` row hung off the job
  // instead, and `invoices` stays purely revenue.
  //
  // This also fixes a tip that could never be charged AT ALL. The old code
  // raised an invoice here, and `invoices_one_per_job` is UNIQUE: every
  // finished job already has one, so the insert came back 23505, supabase-js
  // handed it over as `{error, data:null}`, and the customer was told
  // "couldn't set that up — try again" every time, forever. Zero tips had ever
  // been recorded. The comment above claimed this mirrored the late-cancel
  // path; it copied that path's ORDER and not its lookup-first, which is the
  // part that made the order survivable.
  // HOW MANY TIMES A CARD HAS ALREADY BEEN REFUSED FOR THIS TIP. It is half
  // the idempotency key: a crash must REPLAY (no second debit) and a genuine
  // decline must RETRY (so a second card can be tried, rather than being
  // answered with a replay of yesterday's refusal). Read before the claim
  // below, because a failed read must leave the visit exactly as it found it.
  const failedRes = await admin
    .from("payments").select("id", { count: "exact", head: true })
    .eq("tip_job_id", jobId).eq("status", "failed");
  if (failedRes.error) return { ok: false, error: readFailedMessage("this visit's card attempts", failedRes.error, { money: true }) };

  // CLAIM THE VISIT BEFORE TOUCHING THE CARD.
  //
  // The stamp used to happen AFTER the charge, guarded by `.is("tip_amount",
  // null)` — which meant two tabs, or one impatient retry, each charged the
  // card and only the second stamp found nothing to update. The customer was
  // debited twice for one thank-you and the ledger held two captures with
  // nothing to distinguish them. `cancelRequest` has always claimed first;
  // this is the same order.
  //
  // The UPDATE is the lock: `tip_amount IS NULL` is checked by the database
  // in the same statement that sets it, so exactly one caller can win.
  const { data: claimed, error: claimErr } = await admin
    .from("jobs")
    .update({ tip_amount: v.amount, tipped_at: new Date().toISOString() })
    .eq("id", jobId)
    .is("tip_amount", null)
    .select("id");
  if (claimErr) return { ok: false, error: claimErr.message };
  if (!claimed || claimed.length === 0) {
    // Somebody — probably them, a second ago — already answered this one.
    return { ok: false, error: "A thank-you is already recorded for this visit." };
  }

  /** Hand the visit back, so another card can be tried. */
  const releaseClaim = async () => {
    const { error } = await admin
      .from("jobs").update({ tip_amount: null, tipped_at: null }).eq("id", jobId);
    // Nothing to unwind but the stamp itself. If even that fails the visit
    // reads as "already tipped" with no payment behind it — wrong, but a
    // screen can say so; a double charge cannot be talked back.
    if (error) console.error("[write failed] releasing an unpaid tip claim:", error.code ?? "", error.message ?? error);
  };

  const charge = await takePayment({
    token: pm.token as string,
    amountCents: Math.round(v.amount * 100),
    description: statementDescriptor("tip"),
    // KEYED ON THE JOB, NOT AN INVOICE. A tip has no invoice by design (0097)
    // and `payments_one_captured_tip_per_job` makes the visit the unit that
    // may be tipped once. Handing a real processor an invoice key for an
    // amount it never saw gets the replay rejected outright.
    idempotencyKey: chargeKey("tip", jobId, failedRes.count ?? 0),
  });

  // A NON-ATTEMPT IS NOT A DECLINE. The claim above is released by the
  // declined branch, so the visit is free to be tipped again once a processor
  // exists — filing a phantom `failed` row here would leave the tip looking
  // attempted and refused.
  if (!charge.ok && charge.reason === NO_PROCESSOR_REASON) {
    await releaseClaim();
    return { ok: false, error: "Card payments aren't switched on yet, so nothing was charged." };
  }
  const { error: payErr } = await admin.from("payments").insert({
    tip_job_id: jobId,
    amount: v.amount,
    status: charge.ok ? "captured" : "failed",
    processor_ref: charge.ref ?? null,
  });

  // THE PROCESSOR TOOK IT AND THE LEDGER REFUSED TO RECORD IT.
  //
  // ANY insert failure here, not just a duplicate. The first version of this
  // checked `payErr?.code === "23505"` alone and let every other error fall
  // through — so a constraint we hadn't thought of, or a dropped connection,
  // meant the customer's card was charged, no payments row existed, and the
  // code went straight on to release the crew's payout. Money out of a
  // customer, money to a crew, and nothing in the books joining them.
  //
  // Under the old tips-as-invoices code an invoice row at least survived to
  // hint at it. A tip's `payments` row is now the ONLY artifact of the charge,
  // which makes this the one branch that must not be optimistic. So: stop.
  // Nothing is stamped, no payout is released, and a human hears about it
  // tonight — only a person can hand the money back.
  if (charge.ok && payErr) {
    // THE CLAIM STAYS. Money has left this customer, so the visit must not
    // come back up for tipping — a second attempt would be a second charge for
    // the same thank-you. It is stamped, unpaid to the crew, and on a person's
    // desk tonight.
    await alertOpsDoubleCharge(admin, jobId, v.amount, charge.ref ?? null, "tip");
    return {
      ok: false,
      error: "Your card was charged but we couldn't record it — we've flagged it and someone will make it right today. Please don't try again.",
    };
  }

  if (!charge.ok) {
    // The claim goes back so they can try another card. The failed row stays:
    // a declined attempt is a record of trying, it is what moves the
    // idempotency key on for the next attempt, and 0097 only makes the
    // CAPTURED one unique.
    await releaseClaim();
    return { ok: false, error: "That card was declined — nothing has been sent." };
  }

  // Now, and only now, the crew's share — which is all of it.
  //
  // FIRE-AND-FORGET WAS THE BUG: the customer is charged, the visit is stamped
  // immutable, and a refused insert here left the crew unpaid with nothing
  // retrying it and nobody told. The customer's receipt, two paragraphs below,
  // says every cent went to them.
  const { error: payoutErr } = await admin.from("payouts").insert({
    vendor_id: row.vendor_id,
    job_id: jobId,
    amount: tipSplit(v.amount).toCrew,
    original_amount: v.amount,
    status: "released",
    kind: "tip",
  });
  if (payoutErr) {
    console.error("[write failed] the crew's share of a tip:", payoutErr.code ?? "", payoutErr.message ?? payoutErr);
    await alertOpsCrewUnpaid(admin, jobId, tipSplit(v.amount).toCrew, "a thank-you for the crew");
  }

  // A RECEIPT, BECAUSE A TIP IS A CHARGE. Three screens promise "Receipts &
  // invoices always send by email so you never miss a charge", and `rcpt` is
  // the one notification type that is LOCKED always-on — yet this path sent
  // nothing at all. The customer's card moved and their only evidence was a
  // grey line on one job page.
  try {
    const ownerRes = await admin
      .from("users").select("email, name").eq("id", loaded.ownerId).maybeSingle();
    // Logged, not raised: the charge succeeded and the payout is released, so
    // there is nothing to undo. But a missing receipt address and an unreadable
    // one are different faults, and only the second is ours.
    if (ownerRes.error) console.error("[read failed, degraded] the receipt address:", ownerRes.error.code ?? "", ownerRes.error.message ?? ownerRes.error);
    const owner = ownerRes.data;
    const to = (owner?.email as string) ?? null;
    if (to) {
      const amt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v.amount);
      void sendEmail({
        to,
        subject: `Your LakeLife receipt — thank-you for the crew`,
        html:
          `<p>Hi ${(owner?.name as string) ?? "there"},</p>` +
          `<p>Thank you for the ${amt} you added for the crew who did your ` +
          `${loaded.svcName}${pm.brand ? `, charged to your ${pm.brand} ending ${pm.last4}` : ""}.</p>` +
          `<p><b>Every cent goes to them</b> — LakeLife takes no share of a thank-you.</p>` +
          `<p>🌊</p>`,
      });
    }
  } catch {
    /* a receipt must never unwind a charge that already succeeded */
  }

  revalidatePath("/requests");
  revalidatePath("/billing");
  return { ok: true, signal: `Sent — all $${v.amount.toFixed(2)} goes to the crew. 🌊` };
}
