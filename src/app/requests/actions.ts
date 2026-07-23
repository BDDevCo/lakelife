"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";
import { cancellationQuote, type CancelQuote } from "@/lib/cancellation";
import { LakeLifePayments } from "@/lib/payments";
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
    .select("id, status, date, slot, customer_price, vendor_cost, vendor_id, property_id, group_id, services(name, is_water_work), properties(owner_id, address)")
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
    if (pm?.token) {
      const charge = await LakeLifePayments.charge({
        token: pm.token as string,
        amountCents: Math.round(q.fee * 100),
        description: `LakeLife — late cancellation, ${l.svcName}`,
      });
      await admin.from("payments").insert({
        invoice_id: invoice.id, amount: q.fee, status: charge.ok ? "captured" : "failed", processor_ref: charge.ref ?? null,
      });
      if (charge.ok) await admin.from("invoices").update({ status: "paid", processor_ref: charge.ref ?? null }).eq("id", invoice.id);
      charged = charge.ok;
    }
  }

  // Crew share — paid from the fee actually COLLECTED (roadmap §2). If the
  // charge failed, the invoice sits 'due' and no payout releases: LakeLife
  // never fronts crew pay against an uncollected fee. One per job.
  if (charged && l.job.vendor_id && q.crewShare > 0) {
    const { data: existing } = await admin.from("payouts").select("id").eq("job_id", jobId).maybeSingle();
    if (!existing) {
      await admin.from("payouts").insert({
        vendor_id: l.job.vendor_id, job_id: jobId, amount: q.crewShare, status: "released",
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
