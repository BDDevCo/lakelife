"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate, dayStatus } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";
import { cancellationQuote, type CancelQuote } from "@/lib/cancellation";
import { planRecovery } from "@/lib/recovery";
import { suggestTip, validateTip, tipSplit, canTip } from "@/lib/tips";
import { revalidatePath } from "next/cache";
import { autoAssignJob } from "@/app/book/dispatch";
import { getAvailability } from "@/app/book/actions";
import { LakeLifePayments } from "@/lib/payments";
import { alertOpsDoubleCharge } from "@/lib/automation";
import { sendSms } from "@/lib/sms";

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

/** Load a job + verify the signed-in user owns its property. Null = not theirs. */
async function loadOwnJob(jobId: string): Promise<LoadedJob | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !jobId) return null;
  const admin = createServiceClient();
  const { data: job } = await admin
    .from("jobs")
    .select("id, status, date, slot, customer_price, vendor_cost, vendor_id, property_id, group_id, no_show_at, stood_down_at, recovery_state, reschedule_deadline, services(name, is_water_work), properties(owner_id, address)")
    .eq("id", jobId)
    .maybeSingle();
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
  if (!l) return { allowed: false, free: false, fee: 0, policyNote: "That request isn't yours to cancel." };
  const q = await quoteFor(l);
  if (!q.allowed) return { allowed: false, free: false, fee: 0, policyNote: "A crew is already on this one — text or call us and we'll sort it out." };
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
  if (!l) return { ok: false, error: "That request isn't yours to cancel." };
  const q = await quoteFor(l);
  if (!q.allowed) {
    return { ok: false, error: "A crew is already on this one — text or call us and we'll sort it out." };
  }

  const admin = createServiceClient();
  const groupId = (l.job as { group_id?: string | null }).group_id ?? null;

  // A boat already IN winter storage never self-serve-cancels its splash —
  // that's a release conversation, not a booking cancel. This guard runs
  // BEFORE either path (the fee path flips first, so a late check would
  // cancel the job and strand the boat with no billing rail).
  if (groupId) {
    const { data: custody } = await admin
      .from("storage_stays").select("id").eq("group_id", groupId).eq("status", "in_storage").limit(1);
    if (custody && custody.length > 0) {
      return { ok: false, error: "Your boat is in winter storage — text or call us to arrange the splash or a release instead." };
    }
  }

  // Package fall visit (S2): the cancel must also close the season
  // envelope and free the barn's reserved feet — otherwise the vendor
  // carries phantom feet all winter and S4 births spring work for a
  // package whose fall never happened. A boat already IN storage never
  // self-serve-cancels (that's a release flow, not a booking cancel).
  const cascadePackage = async (): Promise<string | null> => {
    if (!groupId) return null;
    const { data: stay } = await admin
      .from("storage_stays").select("id, status").eq("group_id", groupId).maybeSingle();
    if (stay?.status === "in_storage") {
      return "Your boat is already in winter storage — text or call us to arrange a release instead.";
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
  const { data: flipped } = await admin
    .from("jobs")
    .update({ status: "cancelled", route_id: null, sequence: null })
    .eq("id", jobId)
    .eq("status", "scheduled")
    .select("id");
  if (!flipped || flipped.length === 0) {
    return { ok: false, error: "This job just changed — refresh and try again." };
  }
  if (groupId) await cascadePackage(); // envelope + reserved feet close with the job

  // Fee invoice + charge (mirrors settleJob; invoice stays 'due' if the card fails).
  let { data: invoice } = await admin.from("invoices").select("id, status").eq("job_id", jobId).maybeSingle();
  if (!invoice) {
    const { data: created } = await admin
      .from("invoices")
      .insert({ job_id: jobId, property_id: l.job.property_id, amount: q.fee, status: "due" })
      .select("id, status")
      .single();
    invoice = created;
  }
  let charged = false;
  if (invoice && invoice.status !== "paid" && l.ownerId) {
    const { data: pm } = await admin
      .from("payment_methods")
      .select("token, last4, brand")
      .eq("user_id", l.ownerId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // NEVER CHARGE A CARD FOR AN INVOICE THAT IS ALREADY PAID.
    //
    // `payments_one_capture_per_invoice` (0024) allows exactly one captured
    // row per invoice. The card used to be charged FIRST and the insert's
    // error then discarded — so if anything else had already collected this
    // fee, the second charge went through the processor and its record was
    // silently rejected. Money taken, nothing on file, and `processor_ref`
    // overwritten on top.
    const { data: alreadyCaptured } = await admin
      .from("payments").select("id").eq("invoice_id", invoice.id)
      .eq("status", "captured").limit(1);
    if (alreadyCaptured && alreadyCaptured.length > 0) {
      await admin.from("invoices").update({ status: "paid" }).eq("id", invoice.id);
      charged = true;
    } else if (pm?.token) {
      const charge = await LakeLifePayments.charge({
        token: pm.token as string,
        amountCents: Math.round(q.fee * 100),
        description: `LakeLife — late cancellation, ${l.svcName}`,
      });
      const { error: payErr } = await admin.from("payments").insert({
        invoice_id: invoice.id, amount: q.fee, status: charge.ok ? "captured" : "failed", processor_ref: charge.ref ?? null,
      });
      // A 23505 here means the processor took the money and the ledger refused
      // to record it. That is the one case a human has to hear about the same
      // night, because only a human can give it back.
      if (payErr?.code === "23505" && charge.ok) {
        await alertOpsDoubleCharge(admin, invoice.id as string, q.fee, charge.ref ?? null);
      }
      if (charge.ok) await admin.from("invoices").update({ status: "paid", processor_ref: charge.ref ?? null }).eq("id", invoice.id);
      charged = charge.ok;
    }
  }

  // Crew share — paid from the fee actually COLLECTED (roadmap §2). If the
  // charge failed, the invoice sits 'due' and no payout releases: LakeLife
  // never fronts crew pay against an uncollected fee. One per job.
  if (charged && l.job.vendor_id && q.crewShare > 0) {
    const { data: existing } = await admin.from("payouts").select("id").eq("job_id", jobId).eq("kind", "earning").maybeSingle();
    if (!existing) {
      await admin.from("payouts").insert({
        vendor_id: l.job.vendor_id, job_id: jobId, amount: q.crewShare, original_amount: q.crewShare, status: "released",
      });
    }
  }

  // Tell both sides. Crew: slot freed + what they're paid. Owner: confirmation.
  if (l.job.vendor_id) {
    const { data: v } = await admin.from("vendors").select("user_id").eq("id", l.job.vendor_id).maybeSingle();
    if (v?.user_id) {
      const { data: cu } = await admin.from("users").select("phone").eq("id", v.user_id).maybeSingle();
      if (cu?.phone) {
        const payLine = charged && q.crewShare > 0
          ? `you're paid $${q.crewShare.toFixed(2)} for holding the slot`
          : "your slot share releases once the fee settles";
        void sendSms(cu.phone as string, `LakeLife: the ${l.svcName} at ${l.address ?? "a stop"} on ${l.job.date} was cancelled late — ${payLine}. Your route will update tonight. 🌊`);
      }
    }
  }
  const { data: ou } = await admin.from("users").select("phone").eq("id", l.ownerId ?? "").maybeSingle();
  if (ou?.phone) {
    void sendSms(ou.phone as string, `LakeLife: your ${l.svcName} is cancelled. A ${Math.round(q.feePct * 100)}% late fee of $${q.fee.toFixed(2)} ${charged ? "was charged to your card on file" : "will appear on your next bill"} — cancelling more than ${l.isWaterWork ? "7 days" : "48 hours"} ahead is always free. 🌊`);
  }

  return { ok: true, feeCharged: q.fee };
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
}

/** What the customer is looking at, and what they're being asked. */
export async function getRescheduleView(jobId: string): Promise<RescheduleView> {
  const empty: RescheduleView = {
    needed: false, outcome: null, reason: null, ask: "", ifNothingHappens: "",
    deadline: null, feeEligible: false,
  };
  const loaded = await loadOwnJob(jobId);
  if (!loaded) return empty;

  const { job, svcName } = loaded;
  if (job.recovery_state !== "awaiting_customer") return empty;

  const outcome: "no_access" | "stood_down" = job.stood_down_at ? "stood_down" : "no_access";
  const attemptedOn = (job.no_show_at ?? job.stood_down_at ?? "").slice(0, 10) || todayLakeDate();
  const plan = planRecovery(outcome, attemptedOn, { serviceName: svcName });

  return {
    needed: true,
    outcome,
    reason: null, // the crew's words live on the job; the customer already got them
    ask: plan.ask,
    ifNothingHappens: plan.ifNothingHappens,
    deadline: job.reschedule_deadline,
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
  const [{ data: svcRow }, { data: propRow }] = await Promise.all([
    admin0.from("services").select("id, is_water_work").eq("name", svcName).maybeSingle(),
    admin0.from("properties").select("lakes(ice_out_actual, pull_deadline)")
      .eq("id", job.property_id).maybeSingle(),
  ]);
  const lake = one(propRow?.lakes) as { ice_out_actual?: string; pull_deadline?: string } | null;
  const { fullDates } = svcRow?.id
    ? await getAvailability(
        svcRow.id as string,
        Number(newDateISO.slice(0, 4)),
        Number(newDateISO.slice(5, 7)) - 1,
        job.property_id,
      )
    : { fullDates: [] as string[] };

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
  };
  const loaded = await loadOwnJob(jobId);
  if (!loaded) return blank;

  const admin = createServiceClient();
  const { data: row } = await admin
    .from("jobs")
    .select("status, est_minutes, group_id, tip_amount, no_show_at, stood_down_at, services(est_minutes), job_items(services(est_minutes))")
    .eq("id", jobId)
    .maybeSingle();
  if (!row) return blank;

  const gate = canTip({
    status: row.status as string,
    tip_amount: row.tip_amount == null ? null : Number(row.tip_amount),
    no_show_at: (row.no_show_at as string) ?? null,
    stood_down_at: (row.stood_down_at as string) ?? null,
  });

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
  if (!loaded) return { ok: false, error: "That visit isn't yours." };

  const admin = createServiceClient();
  const { data: row } = await admin
    .from("jobs")
    .select("status, vendor_id, tip_amount, no_show_at, stood_down_at")
    .eq("id", jobId)
    .maybeSingle();
  if (!row) return { ok: false, error: "That visit isn't yours." };

  const gate = canTip({
    status: row.status as string,
    tip_amount: row.tip_amount == null ? null : Number(row.tip_amount),
    no_show_at: (row.no_show_at as string) ?? null,
    stood_down_at: (row.stood_down_at as string) ?? null,
  });
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
    return { ok: false, error: "We can't add a thank-you to this one — give us a call." };
  }

  const { data: pm } = await admin
    .from("payment_methods")
    .select("token")
    .eq("user_id", loaded.ownerId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!pm?.token) {
    return { ok: false, error: "Add a card in Billing first and we'll pass it straight on." };
  }

  const { data: invoice } = await admin
    .from("invoices")
    .insert({ job_id: jobId, property_id: loaded.job.property_id, amount: v.amount, status: "due" })
    .select("id")
    .single();
  if (!invoice) return { ok: false, error: "Couldn't set that up — try again." };

  const charge = await LakeLifePayments.charge({
    token: pm.token as string,
    amountCents: Math.round(v.amount * 100),
    description: `LakeLife — thank-you for the crew, ${loaded.svcName}`,
  });

  const { error: payErr } = await admin.from("payments").insert({
    invoice_id: invoice.id,
    amount: v.amount,
    status: charge.ok ? "captured" : "failed",
    processor_ref: charge.ref ?? null,
  });
  // The processor took it and the ledger refused to record it — the one case
  // a human has to hear about tonight, because only a human can give it back.
  if (payErr?.code === "23505" && charge.ok) {
    await alertOpsDoubleCharge(admin, invoice.id as string, v.amount, charge.ref ?? null);
  }

  if (!charge.ok) {
    // Nothing is stamped on the job, so they can try again with another card.
    return { ok: false, error: "That card was declined — nothing has been sent." };
  }

  await admin.from("invoices").update({ status: "paid", processor_ref: charge.ref ?? null })
    .eq("id", invoice.id);

  const { error } = await admin
    .from("jobs")
    .update({ tip_amount: v.amount, tipped_at: new Date().toISOString() })
    .eq("id", jobId)
    .is("tip_amount", null);          // never twice
  if (error) return { ok: false, error: error.message };

  // Now, and only now, the crew's share — which is all of it.
  await admin.from("payouts").insert({
    vendor_id: row.vendor_id,
    job_id: jobId,
    amount: tipSplit(v.amount).toCrew,
    original_amount: v.amount,
    status: "released",
    kind: "tip",
  });

  revalidatePath("/requests");
  revalidatePath("/billing");
  return { ok: true, signal: `Sent — all $${v.amount.toFixed(2)} goes to the crew. 🌊` };
}
