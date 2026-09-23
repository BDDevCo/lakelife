import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { signedJobPhotos, type JobPhoto } from "@/lib/photos";
import { mustRead, mustCount, softRead } from "@/lib/must-read";
import { NO_FIT_LABEL, canEverDo, capabilityNoFit } from "@/lib/dispatch";
import { hasRealRate } from "@/app/vendor/rates-helpers";
import type { PricingParams } from "@/lib/pricing";
import { todayLakeDate } from "@/lib/booking";

/**
 * THE ops job file (owner ask, 2026-07-26): click a job anywhere in the ops
 * console and get EVERYTHING about it in one place — the conversation, the
 * photos, and the whole money story, with the levers to act on it.
 *
 * Why a separate route/loader instead of another prop on /ops: the ops page
 * already loads ~15 datasets on every view. A per-job fan-out (invoice →
 * payments → refunds, payouts, credits, referrals, dispute, thread, photos)
 * belongs to ONE job and must not be paid for by every dashboard render.
 *
 * Rule 1: this is the ops surface, so vendor_cost and margin are allowed here
 * — and ONLY here. Never import this module (or its types, beyond `import
 * type`) into a customer or crew component.
 *
 * SECURITY: disputes.crew_token / customer_token are bearer credentials that
 * let the holder act AS that party. They are deliberately not selected below
 * and must never be added — a screenshot of an ops page would otherwise hand
 * someone the ability to resolve a dispute.
 */

type Embed<T> = T | T[] | null;
const first = <T,>(x: Embed<T> | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

const num = (x: unknown): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- shapes ----------------------------------------------------------------

export interface OpsJobHeader {
  id: string;
  status: string;
  date: string | null;
  slot: string | null;
  frequency: string | null;
  isRush: boolean;
  gapClaim: boolean;
  correctionOf: string | null; // this job IS the free return visit for that job
  priceFinalized: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  serviceId: string | null;
  serviceName: string | null;
  minPhotos: number;
  propertyId: string;
  address: string | null;
  nickname: string | null;
  lakeName: string | null;
  ownerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  vendorId: string | null;
  crewCompany: string | null;
  customerPrice: number | null;
  vendorCost: number | null;
  margin: number | null;
  marginPct: number | null;
}

export interface OpsJobItem {
  id: string;
  serviceName: string | null;
  customerPrice: number;
  vendorCost: number;
}

export interface OpsPayment {
  id: string;
  amount: number;
  status: string;
  processorRef: string | null;
  createdAt: string;
}

export interface OpsInvoice {
  id: string;
  amount: number;
  status: string;
  processorRef: string | null;
  createdAt: string;
  payments: OpsPayment[];
}

export interface OpsRefund {
  id: string;
  amount: number;
  crewClawback: number;
  reason: string;
  createdByName: string | null; // null = the policy engine refunded automatically
  processorRef: string | null;
  createdAt: string;
}

export interface OpsPayout {
  id: string;
  kind: string; // 'earning' | 'adjustment'
  amount: number;
  originalAmount: number | null;
  status: string; // 'pending' | 'released' | 'held' | 'clawed' | 'paid'
  batchId: string | null;
  batchStatus: string | null;
  createdAt: string;
}

export interface OpsCredit {
  id: string;
  amount: number; // negative = applied to this bill, positive = granted
  reason: string | null;
  userName: string | null;
  createdAt: string;
}

export interface OpsReferralEarning {
  id: string;
  kind: string;
  amount: number;
  status: string;
  beneficiaryName: string | null;
  accruedAt: string;
  maturedAt: string | null;
}

export interface OpsJobMessage {
  id: string;
  body: string;
  createdAt: string;
  from: "owner" | "ops";
  ai: boolean;
  aboutThisJob: boolean; // messages.job_id === this job (migration 0046)
}

export interface OpsDispute {
  id: string;
  status: string;
  customerNote: string | null;
  resolution: string | null;
  openedAt: string;
  respondBy: string | null;
  resolvedAt: string | null;
  correctionJobId: string | null;
  correction: { id: string; date: string | null; status: string; crewCompany: string | null } | null;
}

export interface OpsFlag {
  id: string;
  type: string | null;
  note: string | null;
  status: string;
  createdAt: string;
}

export interface OpsGroupLeg {
  id: string;
  serviceName: string | null;
  phase: string | null;
  date: string | null;
  status: string;
  customerPrice: number | null;
  vendorCost: number | null;
  isThisJob: boolean;
}

export interface OpsJobGroup {
  id: string;
  packageName: string | null;
  status: string;
  legs: OpsGroupLeg[];
}

export interface OpsMoneyTotals {
  billed: number; // invoice face value
  creditsApplied: number; // magnitude of service credit applied to the bill
  captured: number; // cash the processor actually took
  refunded: number;
  netCustomerCash: number; // captured − refunded
  crewOriginal: number; // what the crew was EVER owed (immutable anchor)
  crewNow: number; // earning rows as they stand after any reduction
  crewAdjustments: number; // negative: clawbacks netting against a future batch
  /**
   * Trip fees paid to the crew for this job — they drove out and could not get
   * in. Real take-home, and it was MISSING from crewNet: the page renders a
   * "Trip fee" payout line and then a "Crew take-home on this job" total that
   * did not contain it, so the totals contradicted the lines printed directly
   * above them. Unlike a tip (below), a trip fee IS ours to account for —
   * whether or not the customer was ever charged for it, we paid it.
   */
  crewTripFees: number;
  crewNet: number;
  referralAccrued: number; // non-void referral money this job generated
  lakelifeNet: number; // what LakeLife keeps once everyone else is paid
  /**
   * The tip, charged to the customer and passed to the crew in full (0091).
   *
   * DELIBERATELY OUTSIDE EVERY TOTAL ABOVE. It is not billed, not captured
   * revenue, and not LakeLife's — 0097 keeps it out of `invoices` for exactly
   * that reason, and `crewNet` counts earnings, adjustments and trip fees but
   * never this. It is
   * here so that when a customer rings up asking what we charged them, ops can
   * see the whole card statement instead of a number that is short by the tip.
   */
  tipCharged: number;
}

export interface OpsJobFile {
  header: OpsJobHeader;
  items: OpsJobItem[];
  invoices: OpsInvoice[];
  refunds: OpsRefund[];
  payouts: OpsPayout[];
  credits: OpsCredit[];
  referrals: OpsReferralEarning[];
  totals: OpsMoneyTotals;
  photos: JobPhoto[];
  photoCount: number;
  messages: OpsJobMessage[];
  disputes: OpsDispute[];
  flags: OpsFlag[];
  confirmation: { verdict: string | null; note: string | null; respondedAt: string | null } | null;
  group: OpsJobGroup | null;
  /**
   * WHY THIS JOB HAS NO CREW, when it has none.
   *
   * `decideDispatch` has always produced `no_crew_on_lake` for the geographic
   * dead end and for a long time NOTHING ANYWHERE READ IT — the only consumer
   * of `reasonNoFit` was `all_full_or_blocked`, in the two booking doors. So a
   * Haven job that found no lake-ticked crew left no trace on any screen. This
   * is the trace, on the file ops opens when they ask "why is this still
   * sitting there".
   *
   * FOUR VERDICTS REACH THIS FIELD, all from `NO_FIT_LABEL`, all decided by
   * the engine's own functions rather than a copy of them: the three
   * capability answers via `capabilityNoFit`, plus `no_routable_crew` (crews
   * are here, none can be SENT — paperwork) and `no_qualifying_rate` (a crew
   * is here and has not put a number on the work). The last is the one a new
   * crew actually lands in, and it had no reader anywhere before.
   *
   * `null` for a job that HAS a crew (there is nothing to explain), for a job
   * that is no longer looking for one — cancelled, expired, superseded — and
   * for a job whose crew list could not be read, because "no crew has ticked
   * this lake" said off a failed read is a recruiting errand for a crew who
   * may already be on it.
   */
  noCrewReason: string | null;
  /**
   * CREWS WHO HELD THIS JOB AND HANDED IT BACK (0177), newest first.
   *
   * `jobs.vendor_id` cannot answer this — it points at whoever has the job
   * NOW, or at nobody. Without the rows a release is indistinguishable from
   * "nobody ever claimed it", which is the difference between a scheduling
   * hiccup and a crew quietly handing back the same work every week.
   *
   * Empty when nothing has been handed back. Also empty, with a console line,
   * when the read fails — this is one list on a long file and is not worth
   * withholding somebody's money story over, but it is NOT allowed to read as
   * "we checked and there were none": `releasesChecked` carries the difference
   * and the page must render it.
   */
  releases: Array<{ company: string | null; on: string; reason: string }>;
  releasesChecked: boolean;
}

// ---- the loader ------------------------------------------------------------

/**
 * Everything ops can know about one job. assertOps-gated: returns null for a
 * non-ops session (the page renders the same "ops only" card /ops does) and
 * null for a job id that doesn't exist.
 */
export async function getOpsJobFile(jobId: string): Promise<OpsJobFile | null> {
  const ops = await assertOps();
  if (!ops) return null;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;

  const admin = createServiceClient();

  // `return null` below means "no such job" and the page renders exactly that.
  // It must not also mean "we couldn't look" — see lib/must-read.ts.
  const jobRow = mustRead(
    "this job",
    await admin
      .from("jobs")
      .select(
        "id, status, date, slot, frequency, is_rush, gap_claim, correction_of, price_finalized, " +
          "created_at, started_at, completed_at, customer_price, vendor_cost, margin, " +
          "property_id, service_id, vendor_id, group_id, " +
          "services(name, min_photos), " +
          "properties(id, address, nickname, owner_id, lake_id, lakes(name), users(id, name, email, phone)), " +
          "vendors(id, company)",
      )
      .eq("id", jobId)
      .maybeSingle(),
  );
  if (!jobRow) return null;

  const job = jobRow as unknown as {
    id: string;
    status: string;
    date: string | null;
    slot: string | null;
    frequency: string | null;
    is_rush: boolean | null;
    gap_claim: boolean | null;
    correction_of: string | null;
    price_finalized: boolean | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    customer_price: number | null;
    vendor_cost: number | null;
    margin: number | null;
    property_id: string;
    service_id: string | null;
    vendor_id: string | null;
    group_id: string | null;
    services: Embed<{ name: string | null; min_photos: number | null }>;
    properties: Embed<{
      id: string;
      address: string | null;
      nickname: string | null;
      owner_id: string | null;
      lake_id: string | null;
      lakes: Embed<{ name: string | null }>;
      users: Embed<{ id: string; name: string | null; email: string | null; phone: string | null }>;
    }>;
    vendors: Embed<{ id: string; company: string | null }>;
  };

  const svc = first(job.services);
  const prop = first(job.properties);
  const lake = first(prop?.lakes);
  const owner = first(prop?.users);
  const vendor = first(job.vendors);

  const customerPrice = job.customer_price == null ? null : num(job.customer_price);
  const margin = job.margin == null ? null : num(job.margin);

  const header: OpsJobHeader = {
    id: job.id,
    status: job.status,
    date: job.date,
    slot: job.slot,
    frequency: job.frequency,
    isRush: Boolean(job.is_rush),
    gapClaim: Boolean(job.gap_claim),
    correctionOf: job.correction_of ?? null,
    priceFinalized: job.price_finalized !== false,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    serviceId: job.service_id,
    serviceName: svc?.name ?? null,
    minPhotos: Number(svc?.min_photos ?? 0),
    propertyId: job.property_id,
    address: prop?.address ?? null,
    nickname: prop?.nickname ?? null,
    lakeName: lake?.name ?? null,
    ownerId: prop?.owner_id ?? null,
    customerName: owner?.name ?? null,
    customerEmail: owner?.email ?? null,
    customerPhone: owner?.phone ?? null,
    vendorId: job.vendor_id,
    crewCompany: vendor?.company ?? null,
    customerPrice,
    vendorCost: job.vendor_cost == null ? null : num(job.vendor_cost),
    margin,
    marginPct: margin != null && customerPrice ? Math.round((margin / customerPrice) * 1000) / 10 : null,
  };

  // One fan-out, all job-scoped (every one of these has an index as of 0046).
  const [itemsRes, invoiceRes, payoutRes, refundRes, referralRes, disputeRes, flagRes, confirmRes, msgRes, photos, photoCountRes] =
    await Promise.all([
      admin.from("job_items").select("id, customer_price, vendor_cost, services(name)").eq("job_id", jobId),
      admin.from("invoices").select("id, amount, status, processor_ref, created_at").eq("job_id", jobId),
      admin
        .from("payouts")
        .select("id, kind, amount, original_amount, status, batch_id, created_at")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
      admin
        .from("refunds")
        .select("id, amount, crew_clawback, reason, created_by, processor_ref, created_at")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
      admin
        .from("referral_earnings")
        .select("id, kind, amount, status, beneficiary, accrued_at, matured_at")
        .eq("source_job", jobId),
      // NEVER select crew_token / customer_token here — see the header note.
      admin
        .from("disputes")
        .select("id, status, customer_note, resolution, opened_at, respond_by, resolved_at, correction_job_id")
        .eq("job_id", jobId)
        .order("opened_at", { ascending: false }),
      admin.from("flags").select("id, type, note, status, created_at").eq("job_id", jobId).order("created_at", { ascending: true }),
      admin.from("job_confirmations").select("verdict, note, responded_at").eq("job_id", jobId).maybeSingle(),
      admin
        .from("messages")
        .select("id, body, created_at, from_user, ai, job_id")
        .eq("property_id", job.property_id)
        .order("created_at", { ascending: true })
        .limit(200),
      signedJobPhotos(jobId),
      // The photo GATE reads the true row count, not the signed count — a URL
      // that failed to sign is a display problem, not a missing photo.
      admin.from("job_photos").select("id", { count: "exact", head: true }).eq("job_id", jobId),
    ]);

  // EVERY ROW BELOW IS PART OF THE MONEY STORY. "No invoice", "no payouts",
  // "no refunds" are all sentences ops acts on — a customer gets told what we
  // charged, a crew gets told what they're owed — so none of them may be the
  // shape a dropped connection takes. Unwrapped through mustRead one by one so
  // the log names which read actually failed.
  const invoiceRows = (mustRead("this job's invoices", invoiceRes) ?? []) as unknown as {
    id: string; amount: number | null; status: string | null; processor_ref: string | null; created_at: string;
  }[];
  const invoiceIds = invoiceRows.map((i) => i.id);

  // Second wave: rows keyed off the invoice, the payout batch, and the user ids
  // we just learned about (names for refund authors / credit holders / referral
  // beneficiaries — one lookup instead of three embeds that confuse inference).
  const payoutRows = (mustRead("this job's crew payouts", payoutRes) ?? []) as unknown as {
    id: string; kind: string; amount: number | null; original_amount: number | null;
    status: string; batch_id: string | null; created_at: string;
  }[];
  const batchIds = [...new Set(payoutRows.map((p) => p.batch_id).filter(Boolean))] as string[];
  const refundRows = (mustRead("this job's refunds", refundRes) ?? []) as unknown as {
    id: string; amount: number | null; crew_clawback: number | null; reason: string | null;
    created_by: string | null; processor_ref: string | null; created_at: string;
  }[];
  const referralRows = (mustRead("this job's referral earnings", referralRes) ?? []) as unknown as {
    id: string; kind: string; amount: number | null; status: string; beneficiary: string;
    accrued_at: string; matured_at: string | null;
  }[];

  const [paymentRes, creditRes, batchRes, tipPayRes] = await Promise.all([
    invoiceIds.length
      ? admin
          .from("payments")
          .select("id, invoice_id, amount, status, processor_ref, created_at")
          .in("invoice_id", invoiceIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as unknown[], error: null }),
    invoiceIds.length
      ? admin.from("user_credits").select("id, amount, reason, user_id, created_at").in("invoice_id", invoiceIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    batchIds.length
      ? admin.from("payout_batches").select("id, status").in("id", batchIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    // A TIP HAS NO INVOICE (0097), so the payments fetch above — keyed on
    // invoiceIds, like every other read of this table in the codebase — can
    // never see it. Without this the tip is a card charge that appears on no
    // ops screen at all.
    admin
      .from("payments")
      .select("amount")
      .eq("tip_job_id", jobId)
      .eq("status", "captured"),
  ]);

  const creditRows = (mustRead("the credits applied to this bill", creditRes) ?? []) as unknown as {
    id: string; amount: number | null; reason: string | null; user_id: string; created_at: string;
  }[];

  const userIds = [
    ...new Set(
      [
        ...refundRows.map((r) => r.created_by),
        ...creditRows.map((c) => c.user_id),
        ...referralRows.map((r) => r.beneficiary),
      ].filter(Boolean) as string[],
    ),
  ];
  const userRows = mustRead(
    "the names behind this job's refunds, credits and referrals",
    userIds.length
      ? await admin.from("users").select("id, name").in("id", userIds)
      : { data: [] as { id: string; name: string | null }[], error: null },
  );
  const nameById = new Map((userRows ?? []).map((u) => [u.id as string, (u.name as string) ?? null]));

  const batchStatus = new Map(
    ((mustRead("the payout batches this job sits in", batchRes) ?? []) as unknown as { id: string; status: string }[]).map(
      (b) => [b.id, b.status],
    ),
  );

  const paymentRows = (mustRead("the card payments against this bill", paymentRes) ?? []) as unknown as {
    id: string; invoice_id: string; amount: number | null; status: string; processor_ref: string | null; created_at: string;
  }[];

  const invoices: OpsInvoice[] = invoiceRows.map((inv) => ({
    id: inv.id,
    amount: num(inv.amount),
    status: inv.status ?? "draft",
    processorRef: inv.processor_ref ?? null,
    createdAt: inv.created_at,
    payments: paymentRows
      .filter((p) => p.invoice_id === inv.id)
      .map((p) => ({
        id: p.id,
        amount: num(p.amount),
        status: p.status,
        processorRef: p.processor_ref ?? null,
        createdAt: p.created_at,
      })),
  }));

  const refunds: OpsRefund[] = refundRows.map((r) => ({
    id: r.id,
    amount: num(r.amount),
    crewClawback: num(r.crew_clawback),
    reason: r.reason ?? "",
    createdByName: r.created_by ? (nameById.get(r.created_by) ?? "an ops user") : null,
    processorRef: r.processor_ref ?? null,
    createdAt: r.created_at,
  }));

  const payouts: OpsPayout[] = payoutRows.map((p) => ({
    id: p.id,
    kind: p.kind,
    amount: num(p.amount),
    originalAmount: p.original_amount == null ? null : num(p.original_amount),
    status: p.status,
    batchId: p.batch_id ?? null,
    batchStatus: p.batch_id ? (batchStatus.get(p.batch_id) ?? null) : null,
    createdAt: p.created_at,
  }));

  const credits: OpsCredit[] = creditRows.map((c) => ({
    id: c.id,
    amount: num(c.amount),
    reason: c.reason ?? null,
    userName: nameById.get(c.user_id) ?? null,
    createdAt: c.created_at,
  }));

  const referrals: OpsReferralEarning[] = referralRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: num(r.amount),
    status: r.status,
    beneficiaryName: nameById.get(r.beneficiary) ?? null,
    accruedAt: r.accrued_at,
    maturedAt: r.matured_at ?? null,
  }));

  const items: OpsJobItem[] = ((mustRead("this job's line items", itemsRes) ?? []) as unknown as {
    id: string; customer_price: number | null; vendor_cost: number | null; services: Embed<{ name: string | null }>;
  }[]).map((i) => ({
    id: i.id,
    serviceName: first(i.services)?.name ?? null,
    customerPrice: num(i.customer_price),
    vendorCost: num(i.vendor_cost),
  }));

  // Disputes + the free return visit each one booked.
  const disputeRows = (mustRead("this job's disputes", disputeRes) ?? []) as unknown as {
    id: string; status: string; customer_note: string | null; resolution: string | null;
    opened_at: string; respond_by: string | null; resolved_at: string | null; correction_job_id: string | null;
  }[];
  const correctionIds = disputeRows.map((d) => d.correction_job_id).filter(Boolean) as string[];
  const correctionRows = mustRead(
    "the return visits those disputes booked",
    correctionIds.length
      ? await admin.from("jobs").select("id, date, status, vendors(company)").in("id", correctionIds)
      : { data: [] as unknown[], error: null },
  );
  const correctionById = new Map(
    ((correctionRows ?? []) as unknown as { id: string; date: string | null; status: string; vendors: Embed<{ company: string | null }> }[]).map(
      (c) => [c.id, { id: c.id, date: c.date, status: c.status, crewCompany: first(c.vendors)?.company ?? null }],
    ),
  );

  const disputes: OpsDispute[] = disputeRows.map((d) => ({
    id: d.id,
    status: d.status,
    customerNote: d.customer_note ?? null,
    resolution: d.resolution ?? null,
    openedAt: d.opened_at,
    respondBy: d.respond_by ?? null,
    resolvedAt: d.resolved_at ?? null,
    correctionJobId: d.correction_job_id ?? null,
    correction: d.correction_job_id ? (correctionById.get(d.correction_job_id) ?? null) : null,
  }));

  const flags: OpsFlag[] = ((mustRead("this job's flags", flagRes) ?? []) as unknown as {
    id: string; type: string | null; note: string | null; status: string; created_at: string;
  }[]).map((f) => ({ id: f.id, type: f.type ?? null, note: f.note ?? null, status: f.status, createdAt: f.created_at }));

  const confirmRow = mustRead("the customer's confirmation of this job", confirmRes) as
    | { verdict: string | null; note: string | null; responded_at: string | null }
    | null;
  const confirmation = confirmRow
    ? { verdict: confirmRow.verdict ?? null, note: confirmRow.note ?? null, respondedAt: confirmRow.responded_at ?? null }
    : null;

  // The property thread, with this job's own messages annotated (0046). Same
  // owner-vs-ops derivation groupThreads uses: from_user === owner ⇒ owner.
  const messages: OpsJobMessage[] = ((mustRead("this property's message thread", msgRes) ?? []) as unknown as {
    id: string; body: string | null; created_at: string; from_user: string | null; ai: boolean | null; job_id: string | null;
  }[]).map((m) => ({
    id: m.id,
    body: m.body ?? "",
    createdAt: m.created_at,
    from: header.ownerId != null && m.from_user === header.ownerId ? "owner" : "ops",
    ai: Boolean(m.ai),
    aboutThisJob: m.job_id === jobId,
  }));

  // Package visit: the whole season envelope, this leg marked.
  let group: OpsJobGroup | null = null;
  if (job.group_id) {
    const [groupRes, legsRes] = await Promise.all([
      admin.from("job_groups").select("id, status, service_packages(name)").eq("id", job.group_id).maybeSingle(),
      admin
        .from("jobs")
        .select("id, date, status, phase, customer_price, vendor_cost, services(name)")
        .eq("group_id", job.group_id)
        .order("date", { ascending: true, nullsFirst: true }),
    ]);
    const groupRow = mustRead("the package this visit belongs to", groupRes);
    // A failed legs read would show a season package with one leg in it.
    const legRows = mustRead("the other legs of that package", legsRes);
    if (groupRow) {
      const g = groupRow as unknown as { id: string; status: string; service_packages: Embed<{ name: string | null }> };
      group = {
        id: g.id,
        packageName: first(g.service_packages)?.name ?? null,
        status: g.status,
        legs: ((legRows ?? []) as unknown as {
          id: string; date: string | null; status: string; phase: string | null;
          customer_price: number | null; vendor_cost: number | null; services: Embed<{ name: string | null }>;
        }[]).map((l) => ({
          id: l.id,
          serviceName: first(l.services)?.name ?? null,
          phase: l.phase ?? null,
          date: l.date,
          status: l.status,
          customerPrice: l.customer_price == null ? null : num(l.customer_price),
          vendorCost: l.vendor_cost == null ? null : num(l.vendor_cost),
          isThisJob: l.id === jobId,
        })),
      };
    }
  }

  // ---- the ledger arithmetic ----------------------------------------------
  const billed = round2(invoices.reduce((s, i) => s + i.amount, 0));
  const captured = round2(
    invoices.reduce((s, i) => s + i.payments.filter((p) => p.status === "captured").reduce((t, p) => t + p.amount, 0), 0),
  );
  const refunded = round2(refunds.reduce((s, r) => s + r.amount, 0));
  // Credit applications are stored negative; show the magnitude that came off
  // this bill (a positive row here would be a grant, which we don't net in).
  const creditsApplied = round2(credits.filter((c) => c.amount < 0).reduce((s, c) => s + Math.abs(c.amount), 0));
  const earnings = payouts.filter((p) => p.kind === "earning");
  const crewOriginal = round2(earnings.reduce((s, p) => s + (p.originalAmount ?? p.amount), 0));
  const crewNow = round2(earnings.reduce((s, p) => s + p.amount, 0));
  const crewAdjustments = round2(payouts.filter((p) => p.kind === "adjustment").reduce((s, p) => s + p.amount, 0));
  const crewTripFees = round2(payouts.filter((p) => p.kind === "trip").reduce((s, p) => s + p.amount, 0));
  const crewNet = round2(crewNow + crewAdjustments + crewTripFees);
  const referralAccrued = round2(referrals.filter((r) => r.status !== "void").reduce((s, r) => s + r.amount, 0));
  const netCustomerCash = round2(captured - refunded);

  const totals: OpsMoneyTotals = {
    billed,
    creditsApplied,
    captured,
    refunded,
    netCustomerCash,
    crewOriginal,
    crewNow,
    crewAdjustments,
    crewTripFees,
    crewNet,
    referralAccrued,
    lakelifeNet: round2(netCustomerCash - crewNet - referralAccrued),
    // Not netted into anything above — see the field's comment. Passing it
    // through `lakelifeNet` would say we kept a thank-you.
    tipCharged: round2(
      ((mustRead("the tip charged on this job", tipPayRes) ?? []) as { amount: number | null }[])
        .reduce((s, p) => s + Number(p.amount ?? 0), 0),
    ),
  };

  // mustCount is here for its THROW: a head-count that errored must never read
  // as an unmet photo gate. Its own `?? 0` fallback would say exactly that,
  // though, so the non-error `{count: null}` case keeps the fallback this line
  // has always had — the photos we actually loaded.
  mustCount("this job's photo count", photoCountRes);
  const photoCount = photoCountRes.count ?? photos.length;

  // WHO HANDED THIS BACK, AND WHY (0177).
  const releaseRes = await admin
    .from("job_releases")
    .select("released_on, reason, vendors(company)")
    .eq("job_id", jobId)
    .order("released_on", { ascending: false });
  // A TABLE THAT DOES NOT EXIST YET IS NOT A FAILED READ. 0177 is written and
  // is applied by hand; until it lands, Postgres answers 42P01 and softRead
  // would put "We couldn't check whether a crew handed this one back" on EVERY
  // job in the system — a permanent false alarm about a feature nobody has
  // used. No table means no row can ever have been written, so zero releases
  // is the literal truth, and `releasesChecked` stays true.
  //
  // This is NOT the "a failed read is not an empty one" exemption creeping in:
  // it is scoped to the one error code that means "this relation has never
  // existed". Every other error still degrades loudly.
  const relMissing = (releaseRes.error as { code?: string } | null)?.code === "42P01";
  const [releaseRows, releasesFailed] = relMissing
    ? [[] as NonNullable<typeof releaseRes.data>, false as boolean]
    : softRead("who handed this job back", releaseRes, null);
  const releases = (releaseRows ?? []).map((r) => ({
    company: (first(r.vendors as Embed<{ company: string | null }>) ?? {}).company ?? null,
    on: r.released_on as string,
    reason: r.reason as string,
  }));

  // WHY NOBODY HAS THIS JOB — the reader `no_crew_on_lake` never had.
  //
  // Only asked for a job that is genuinely unassigned AND still looking; a job
  // with a crew has nothing to explain, and a cancelled one has nothing to fix.
  // EVERY TEST BELOW IS THE ENGINE'S OWN FUNCTION, not a copy of it:
  // `canEverDo` for the paperwork and leg gates, `capabilityNoFit` (which
  // wraps `noCrewOnLake`) for the three capability verdicts, and
  // `hasRealRate` for the rate card — the same predicate the crew's own
  // screens and the coverage board use. Fixture crews are fenced out for the
  // same reason the needs-attention board fences them — a test crew must never
  // make a real coverage hole look filled.
  let noCrewReason: string | null = null;
  // A CANCELLED JOB HAS NOBODY ON IT ON PURPOSE. This asked only
  // `!job.vendor_id`, so every cancelled, expired or superseded job in the
  // system — five of them in production the day this was written — opened with
  // a recruiting alarm under Crew telling ops to go and hire somebody for work
  // that is not happening. Only a job still LOOKING for a crew has a dead end
  // worth naming.
  const stillLooking = header.status === "requested" || header.status === "scheduled";
  if (!job.vendor_id && stillLooking && header.serviceName) {
    const crewRes = await admin
      .from("vendors")
      .select("id, company, status, service_types, service_lakes, coi_expiry, coi_named_insured, users!vendors_user_id_fkey!inner(is_fixture)")
      .eq("status", "active")
      .eq("users.is_fixture", false);
    // A FAILED READ IS NOT AN EMPTY CREW LIST. Empty reads as "nobody does
    // this work anywhere", which is a recruiting errand; `null` says nothing
    // and the card renders nothing.
    const [crews, crewsFailed] = softRead("the crews who could take this job", crewRes, null);
    if (!crewsFailed) {
      const today = todayLakeDate();
      // EVERY LEG OF THE VISIT, NOT THE HEADER'S ONE NAME. A grouped visit is
      // dispatched against `componentNames`; asking about `serviceName` alone
      // printed the lake-recruiting sentence on jobs where a crew on the lake
      // covers part of the work, which is a different problem with a different
      // cure. `items` is already loaded above.
      const legNames = items.map((i) => i.serviceName).filter((n): n is string => !!n);
      const componentNames = legNames.length > 1 ? legNames : undefined;
      const dispatchInput = {
        serviceName: header.serviceName as string,
        componentNames,
        lakeId: prop?.lake_id ?? null,
      };
      // THE ENGINE'S OWN PAPERWORK GATE, not a hand-rolled half of it. This
      // checked `status` and `coi_expiry` and stopped — `canEverDo` also
      // refuses a certificate that names somebody else's business (0152), so
      // a crew the engine will never send could be counted here as covering
      // the lake, and the real dead end would print nothing at all.
      const routable = (crews ?? [])
        .map((v) => ({
          id: v.id as string,
          status: (v.status as string) ?? "",
          coiExpiry: (v.coi_expiry as string | null) ?? null,
          coiNamedInsured: (v.coi_named_insured as string | null) ?? null,
          company: (v.company as string | null) ?? null,
          serviceTypes: (v.service_types as string[] | null) ?? [],
          serviceLakes: (v.service_lakes as string[] | null) ?? [],
        }))
        .filter((c) => canEverDo(c, { ...dispatchInput, todayISO: today }));
      // canEverDo has already applied the lake and leg tests, so a non-empty
      // `routable` means capability is not the problem. The pool handed to
      // capabilityNoFit is therefore the full active roster, judged on
      // capability alone — exactly what decideDispatch hands it.
      const capability = capabilityNoFit(
        (crews ?? []).map((v) => ({
          serviceTypes: (v.service_types as string[] | null) ?? [],
          serviceLakes: (v.service_lakes as string[] | null) ?? [],
        })),
        dispatchInput,
      );
      if (capability) {
        noCrewReason = NO_FIT_LABEL[capability];
      } else if (routable.length === 0) {
        // CREWS COVER THE WORK AND THE LAKE, AND NOT ONE OF THEM CAN BE SENT.
        // Every gate `canEverDo` applies beyond capability is date-independent
        // — still onboarding, suspended by ops, certificate lapsed or absent,
        // certificate naming somebody else's business — so the cure is
        // paperwork, never recruiting and never another date. This sentence
        // had no reader at all before; the board makes the same distinction
        // for the lapsed-COI half of it.
        noCrewReason = NO_FIT_LABEL.no_routable_crew;
      } else if (header.serviceId && !componentNames) {
        // THE RATE DEAD END, WHICH IS THE ONE JOSH WILL HIT. A crew who is
        // active, insured, ticked for the work and ticked for the lake is
        // still dropped by `decideDispatch` as `no_qualifying_rate` if their
        // card carries no positive number — and that sentence was written and
        // selected by nothing. It is NOT an hour-to-hour question like a full
        // day: a blank rate card stays blank until somebody fills it in.
        //
        // SINGLE-SERVICE JOBS ONLY. A package is priced leg by leg, so "has
        // anybody priced this" is a different question with a different
        // answer per leg — and guessing it off the header's one service would
        // be the hand-rolled shortcut this whole block was rewritten to stop.
        const rateRes = await admin
          .from("vendor_rates")
          .select("vendor_id, base, unit_rate, band_pricing")
          .eq("service_id", header.serviceId as string)
          .in("vendor_id", routable.map((c) => c.id));
        const [rateRows, ratesFailed] = softRead("what those crews charge for this work", rateRes, null);
        // An empty rate list reads as "nobody has priced this", which is the
        // whole sentence. A dropped read must not say it.
        if (!ratesFailed && !(rateRows ?? []).some((r) => hasRealRate(r as { base: number | null; unit_rate: number | null; band_pricing: PricingParams | null }))) {
          noCrewReason = NO_FIT_LABEL.no_qualifying_rate;
        }
      }
      // Anything else is a day or capacity question, which changes hour to
      // hour — this file does not guess at it.
    }
  }

  return {
    header,
    items,
    invoices,
    refunds,
    payouts,
    credits,
    referrals,
    totals,
    photos,
    photoCount,
    messages,
    disputes,
    flags,
    confirmation,
    group,
    noCrewReason,
    releases,
    releasesChecked: !releasesFailed,
  };
}
