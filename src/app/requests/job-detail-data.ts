import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { signedJobPhotos, signedJobPhotosFor, type JobPhoto } from "@/lib/photos";
import { getPackageBreakdowns } from "@/app/requests/package-data";
import { computeScarcityOffer, type ScarcityOfferView } from "@/app/requests/offer-data";
import { customerStatusLabel, disputeViewForCustomer } from "@/lib/job-view";

/**
 * THE CUSTOMER'S JOB FILE (job detail, 2026-07-26).
 *
 * Until now a homeowner could see a ROW for their job and nothing else — no
 * photos (the completion SMS promised them "in your portal" against a surface
 * that did not exist), no invoice, no way to answer the 👍/👎 except from a
 * text they may have deleted, and no idea where a Make-It-Right dispute stood.
 * This loader assembles all of it for ONE job.
 *
 * OWNERSHIP GATE (house standard — see loadOwnJob in requests/actions.ts):
 * identity comes from the session client, data from the service-role client,
 * and a strict `properties.owner_id === user.id` gate stands between them.
 * Every service-role read below happens AFTER that gate; an id from the
 * browser is never trusted. `signedJobPhotos` signs but does not authorize —
 * this is the authorization it depends on.
 *
 * RULE 1 (absolute): vendor_cost, margin and crew rates are never selected
 * here, never derived here, and never returned. Columns are listed explicitly
 * on every read — `select("*")` on jobs or job_items would carry BOTH prices
 * on the same row. The only crew fact the customer gets is a company name.
 *
 * BEARER TOKENS: disputes.crew_token / customer_token are deliberately absent
 * from every select below. The crew token would let a customer act AS the crew
 * (book a $0 correction, close their own dispute); neither belongs in HTML.
 */

const one = <T,>(x: T | T[] | null | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

/** Pill COLOUR only — the words come from customerStatusLabel (src/lib/job-view,
 *  under test) so one implementation serves every customer surface. */
export const JOB_STATUS_PILL: Record<string, string> = {
  requested: "warn", scheduled: "teal", in_progress: "teal", complete: "ok", paid: "slate", cancelled: "slate",
};

export interface JobDetailLeg {
  name: string;
  price: number; // customer price — job_items.vendor_cost is never read
}

export interface JobDetailSibling {
  jobId: string;
  serviceName: string;
  date: string | null;
  photos: JobPhoto[];
}

export interface JobDetailRefund {
  amount: number;
  at: string;
}

export interface JobDetailMoney {
  customerPrice: number;           // the ONE all-in price
  legs: JobDetailLeg[];            // package visit: what's inside
  spring: { names: string[]; quote: number } | null;
  invoiceStatus: string | null;    // draft | due | paid | refunded
  invoiceAmount: number | null;
  paidAt: string | null;
  refunds: JobDetailRefund[];
  refundedTotal: number;
}

/** Customer-safe Make-It-Right state. The internal status name is deliberately
 *  NOT carried across — `disputeViewForCustomer` is the only thing that maps
 *  it, and it's under test so 'crew_review' can never reach a screen. */
export interface JobDetailDispute {
  pill: string;
  line: string;
  /** True only while we're waiting on the CUSTOMER (verifying / talk). */
  needsCustomer: boolean;
}

export interface JobDetailMessage {
  id: string;
  body: string;
  created_at: string;
  from: "owner" | "ops";
}

export interface JobDetailView {
  id: string;
  status: string;
  statusLabel: string;
  statusPill: string;
  serviceName: string;
  date: string | null;
  prettyDate: string | null;
  slot: string | null;
  propertyNickname: string | null;
  propertyAddress: string | null;
  crewCompany: string | null;
  isCorrection: boolean;
  money: JobDetailMoney;
  photos: JobPhoto[];
  siblings: JobDetailSibling[];
  minPhotos: number;
  pendingConfirmationId: string | null; // non-null ⇒ show the 👍/👎 inline
  verdict: "good" | "issue" | null;
  dispute: JobDetailDispute | null;
  messages: JobDetailMessage[];
  cancellable: boolean;
  offer: ScarcityOfferView | null;
}

/** Results the client panel reads back. Declared HERE, not in the "use server"
 *  actions file — exporting a type from a server-actions chunk breaks
 *  Turbopack's loader at runtime (every action in the chunk 500s). */
export interface JobVerdictResult {
  ok: boolean;
  /** true when THIS tap won the once-ever flip. */
  recorded?: boolean;
  /** true when a 👎 opened the Make-It-Right dispute. */
  disputeOpened?: boolean;
  error?: string;
}

export interface JobMessageResult {
  ok: boolean;
  error?: string;
}

/**
 * Load ONE job's full customer-facing file, or null when the signed-in user
 * doesn't own its property (missing job and someone else's job are the same
 * answer on purpose — the page must not confirm a stranger's job exists).
 */
export async function loadCustomerJobDetail(jobId: string): Promise<JobDetailView | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !jobId) return null;

  const admin = createServiceClient();
  // Explicit columns only. vendor_cost / margin are absent by construction.
  const { data: job } = await admin
    .from("jobs")
    // ONE string literal, not a concatenation — PostgREST's typings key off
    // the literal, and a `+` join degrades every field to `unknown`.
    .select("id, status, date, slot, customer_price, property_id, group_id, vendor_id, correction_of, services(name, min_photos), properties(owner_id, nickname, address), vendors(company)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return null;

  // ---- THE GATE ------------------------------------------------------------
  const prop = one(job.properties) as { owner_id?: string; nickname?: string; address?: string } | null;
  if (prop?.owner_id !== user.id) return null;
  // Everything below this line is authorized.

  const svc = one(job.services) as { name?: string; min_photos?: number } | null;
  const crew = one(job.vendors) as { company?: string } | null;
  const propertyId = job.property_id as string;
  const groupId = (job.group_id as string) ?? null;
  const status = job.status as string;
  const date = (job.date as string) ?? null;

  const [
    { data: invoice },
    { data: refundRows },
    { data: conf },
    { data: dispute },
    { data: messageRows },
    photos,
    breakdowns,
  ] = await Promise.all([
    // limit(1), not a bare maybeSingle(): there is NO unique index on
    // invoices(job_id) (only 0046's plain index), and a job that somehow
    // carries two — e.g. a late-cancel fee invoice alongside a completion
    // invoice — would make maybeSingle() THROW and 500 the whole page. A
    // read-only surface must degrade, not explode.
    admin.from("invoices").select("id, amount, status, created_at").eq("job_id", jobId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("refunds").select("amount, created_at").eq("job_id", jobId).order("created_at", { ascending: true }),
    admin.from("job_confirmations").select("id, verdict").eq("job_id", jobId).maybeSingle(),
    // NEVER crew_token / customer_token — bearer credentials, not page data.
    admin.from("disputes").select("id, status, correction_job_id").eq("job_id", jobId)
      .order("opened_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("messages").select("id, body, created_at, from_user")
      .eq("property_id", propertyId).eq("job_id", jobId).order("created_at", { ascending: true }),
    signedJobPhotos(jobId),
    getPackageBreakdowns([jobId]),
  ]);

  // Invoice → was it actually collected? (payments hangs off the invoice.)
  let paidAt: string | null = null;
  if (invoice?.id) {
    const { data: pay } = await admin
      .from("payments").select("created_at, status").eq("invoice_id", invoice.id as string)
      .eq("status", "captured").order("created_at", { ascending: false }).limit(1).maybeSingle();
    paidAt = (pay?.created_at as string) ?? null;
  }

  const refunds: JobDetailRefund[] = (refundRows ?? []).map((r) => ({
    amount: Number(r.amount ?? 0),
    at: r.created_at as string,
  }));

  // Package visit: the OTHER legs of the same season envelope (fall pull /
  // spring splash). Scoped to this property as well as this group — defence
  // in depth, so a mis-stamped group can never leak another home's photos.
  const siblings: JobDetailSibling[] = [];
  if (groupId) {
    const { data: sibRows } = await admin
      .from("jobs")
      .select("id, date, services(name)")
      .eq("group_id", groupId)
      .eq("property_id", propertyId)
      .neq("id", jobId)
      .order("date", { ascending: true });
    const sibs = (sibRows ?? []) as Array<{ id: string; date: string | null; services: unknown }>;
    if (sibs.length > 0) {
      const byJob = await signedJobPhotosFor(sibs.map((s) => s.id));
      for (const s of sibs) {
        const shots = byJob.get(s.id) ?? [];
        if (shots.length === 0) continue; // an empty leg adds nothing to look at
        siblings.push({
          jobId: s.id,
          serviceName: (one(s.services) as { name?: string } | null)?.name ?? "Package leg",
          date: s.date ?? null,
          photos: shots,
        });
      }
    }
  }

  // Same cancel window /requests uses — one policy, two surfaces.
  const cancellable = status === "requested" || (status === "scheduled" && (!date || date > todayLakeDate()));

  // A stuck request may have a scarcity offer. Trust boundary: the id has
  // already cleared the ownership gate above (same as getScarcityOffers).
  const offer = status === "requested" ? await computeScarcityOffer(jobId) : null;

  const breakdown = breakdowns[jobId] ?? null;

  let disputeView: JobDetailDispute | null = null;
  if (dispute) {
    let correctionDate: string | null = null;
    if (dispute.correction_job_id) {
      const { data: fix } = await admin.from("jobs").select("date").eq("id", dispute.correction_job_id as string).maybeSingle();
      correctionDate = (fix?.date as string) ?? null;
    }
    const v = disputeViewForCustomer({ status: dispute.status as string, correctionDate });
    disputeView = { pill: v.pill, line: v.line, needsCustomer: v.needsCustomer };
  }

  const messages: JobDetailMessage[] = (messageRows ?? []).map((m) => ({
    id: m.id as string,
    body: (m.body as string) ?? "",
    created_at: m.created_at as string,
    // Same derivation as messages/data.ts: the owner's own id ⇒ "owner",
    // anyone else (dispatch, the AI reply, a crew note) ⇒ "ops".
    from: m.from_user === prop.owner_id ? "owner" : "ops",
  }));

  return {
    id: job.id as string,
    status,
    statusLabel: customerStatusLabel(status),
    statusPill: JOB_STATUS_PILL[status] ?? "slate",
    serviceName: svc?.name ?? "Service",
    date,
    prettyDate: date
      ? new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
      : null,
    slot: (job.slot as string) ?? null,
    propertyNickname: prop?.nickname ?? null,
    propertyAddress: prop?.address ?? null,
    crewCompany: crew?.company ?? null, // company name ONLY — never a rate
    isCorrection: job.correction_of != null,
    money: {
      customerPrice: Number(job.customer_price ?? 0),
      legs: breakdown?.legs ?? [],
      spring: breakdown?.spring ?? null,
      invoiceStatus: (invoice?.status as string) ?? null,
      invoiceAmount: invoice?.amount == null ? null : Number(invoice.amount),
      paidAt,
      refunds,
      refundedTotal: refunds.reduce((s, r) => s + r.amount, 0),
    },
    photos,
    siblings,
    minPhotos: Number(svc?.min_photos ?? 0),
    pendingConfirmationId: conf && !conf.verdict ? (conf.id as string) : null,
    verdict: (conf?.verdict as "good" | "issue" | null) ?? null,
    dispute: disputeView,
    messages,
    cancellable,
    offer,
  };
}
