import "server-only";
import { STATUS_PILL } from "@/lib/status-colors";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, mustCount } from "@/lib/must-read";
import { todayLakeDate } from "@/lib/booking";
import { signedJobPhotos, signedJobPhotosFor, type JobPhoto } from "@/lib/photos";
import { getPackageBreakdowns } from "@/app/requests/package-data";
import { computeScarcityOffer, type ScarcityOfferView } from "@/app/requests/offer-data";
import { customerStatusLabel, disputeViewForCustomer } from "@/lib/job-view";
import { longDate, longDay } from "@/lib/lake-time";

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
export // One product, one colour language — lib/status-colors is the only copy.
const JOB_STATUS_PILL: Record<string, string> = STATUS_PILL;

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
  /**
   * Is there actually a card to charge? The "Due" copy promised "we'll run
   * this on your card on file" unconditionally — including to the customers
   * who have no card, which is the exact group for whom the settle silently
   * did nothing at all. Telling someone it is handled when it is not is how
   * an unpaid job stays unpaid.
   */
  hasCardOnFile: boolean;
  /**
   * How many times the processor has refused this invoice's charge —
   * payments.status='failed' rows on THIS invoice, the same count both nightly
   * doors make before they decide whether to try again (lib/automation.ts,
   * reconcileUnsettledJobs and reconcileCancelledFees). At DECLINE_CAP they
   * stop, and nothing else ever runs the invoice: saving a new card does not
   * touch `payments`, and there is no ops button for a completion or fee
   * invoice. So this number decides whether "we'll run this on your card" is
   * a true sentence or a promise nobody is going to keep.
   */
  declines: number;
  refunds: JobDetailRefund[];
  refundedTotal: number;
  /**
   * The thank-you they added afterwards, and when.
   *
   * A SEPARATE CHARGE ON THE SAME CARD (0097), so leaving it off this card
   * meant the page printed "Your invoice — $340 · Paid" directly above the
   * words "no add-ons, no surprises" on a job where a second charge had hit
   * that card and was named nowhere on the page. Billing lists it; this is
   * the screen somebody actually opens when they are looking at a job.
   *
   * NULL means never asked or never answered; 0 means asked and declined,
   * which is a perfectly good answer and is shown as nothing at all.
   */
  tipAmount: number | null;
  tippedAt: string | null;
}

/**
 * THE NIGHTLY'S RETRY CAP. `(failCount ?? 0) >= 5` in both of automation.ts's
 * doors — card networks penalise a card re-attempted nightly forever, so after
 * five declines the invoice is left visibly 'due' and the card is left alone.
 * Named here, not imported, because automation.ts is not importable from a
 * page loader without dragging the whole runner in; the test that owns this
 * file reads the nightly's comparison and fails if the two ever disagree.
 */
export const DECLINE_CAP = 5;

/** What the invoice card says. Pure — the words come from `money` alone, so
 *  every state a customer can reach has a test that reads the sentence. */
export function invoiceCopy(money: JobDetailMoney): { pill: string; tone: string; note: string } {
  const s = money.invoiceStatus;
  if (s === "refunded") {
    return { pill: "↩ Refunded", tone: "slate", note: "We sent this one back to your card." };
  }
  if (s === "paid") {
    return {
      pill: "Paid",
      tone: "ok",
      note: money.paidAt
        ? `Charged to your card on file on ${longDate(money.paidAt)}.`
        : "Charged to your card on file.",
    };
  }
  if (s === "due") {
    // AFTER THE CAP, NOTHING WILL RUN THIS. Both nightly doors skip an invoice
    // with DECLINE_CAP failed payments, and no other door exists — not a new
    // card (saving one writes nothing to `payments`, so the count never
    // resets), not an ops control. The two sentences below this one each end
    // in a promise ("we'll run this", "we'll take care of it") that is false
    // on every night after the fifth decline, whether or not a card is on
    // file. So this branch comes first, and it promises nothing the code
    // cannot do: it says what happened, that it is still owed, where the card
    // lives, and that the one control on this screen which reaches a person
    // is the note box below — because a new card on its own changes nothing.
    if (money.declines >= DECLINE_CAP) {
      return {
        pill: "Card declined",
        tone: "warn",
        note:
          `We tried ${money.declines} times and your card was declined each time, so we've stopped running it — this is still owed. ` +
          `${money.hasCardOnFile ? "Update your card" : "Add a card"} on the Billing page, then leave us a note below: a new card doesn't restart this on its own.`,
      };
    }
    // The unconditional version of this told customers with NO card that we
    // would run it on their card on file — and those are exactly the ones the
    // settle silently did nothing for. Saying it's handled when it isn't is
    // how an unpaid job stays unpaid.
    return money.hasCardOnFile
      ? { pill: "Due", tone: "warn", note: "We'll run this on your card on file. Manage your card on the Billing page." }
      : {
          pill: "Needs a card",
          tone: "warn",
          note: "We don't have a card on file for you yet, so this hasn't been paid. Add one on the Billing page and we'll take care of it.",
        };
  }
  if (s === "draft") {
    return { pill: "Not billed yet", tone: "slate", note: "This invoice hasn't gone out yet." };
  }
  return {
    pill: "Nothing billed yet",
    tone: "slate",
    note: "You're charged only after the work is done and photo-verified — never before.",
  };
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
  /**
   * What was done versus what the crew found, when a correction was declined
   * and the visit went ahead at the booked scope (0088). The owner is promised
   * this in writing at the moment they decline — until now it was written to
   * the job and rendered nowhere, so the invoice said "Pier install" while
   * they looked at a pier ending in open water.
   */
  scopeNote: string | null;
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
  // A FAILED READ IS NOT A CANCELLED JOB. Returning null here makes
  // requests/[id]/page.tsx:71 tell the customer "It may have been cancelled, or
  // it belongs to another account" — two accusations about their own booking,
  // on a dropped connection. Confirmed by the season simulation. The sole
  // caller is that page, a server component under src/app/error.tsx.
  const job = mustRead("this job", await admin
    .from("jobs")
    // ONE string literal, not a concatenation — PostgREST's typings key off
    // the literal, and a `+` join degrades every field to `unknown`.
    .select("id, status, date, slot, customer_price, property_id, group_id, vendor_id, correction_of, scope_note, tip_amount, tipped_at, services(name, min_photos), properties(owner_id, nickname, address), vendors(company)")
    .eq("id", jobId)
    .maybeSingle());
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
  let declines = 0;
  if (invoice?.id) {
    // paidAt null renders as "not paid yet" — a swallowed error tells somebody
    // whose card was charged that it was not.
    const pay = mustRead("whether this was paid", await admin
      .from("payments").select("created_at, status").eq("invoice_id", invoice.id as string)
      .eq("status", "captured").order("created_at", { ascending: false }).limit(1).maybeSingle());
    paidAt = (pay?.created_at as string) ?? null;

    // HOW MANY TIMES THE CARD HAS SAID NO — the same shape the nightly counts
    // before it decides whether to try again. Per invoice, exactly as the
    // nightly's fee door and settleJob's own idempotency key count it.
    // FAILS OPEN IF SWALLOWED: a failed count is null, `null ?? 0` sits under
    // the cap, and the page prints "We'll run this on your card on file" to
    // the one customer for whom that sentence is false forever.
    declines = mustCount("how many times your card has declined", await admin
      .from("payments").select("id", { count: "exact", head: true })
      .eq("invoice_id", invoice.id as string).eq("status", "failed"));
  }

  // Only whether one EXISTS — never the token, brand or last four. This page
  // needs to know which sentence is true, not what the card is.
  // FAILS OPEN IF SWALLOWED: a failed count is null, so hasCardOnFile goes
  // false and the page says "We don't have a card on file for you yet, so the
  // $450.00 hasn't been paid yet" to somebody who has one.
  const cardCount = mustCount("whether you have a card on file", await admin
    .from("payment_methods")
    .select("id", { count: "exact", head: true })
    .eq("user_id", prop.owner_id as string));
  const hasCardOnFile = cardCount > 0;

  const refunds: JobDetailRefund[] = (refundRows ?? []).map((r) => ({
    amount: Number(r.amount ?? 0),
    at: r.created_at as string,
  }));

  // Package visit: the OTHER legs of the same season envelope (fall pull /
  // spring splash). Scoped to this property as well as this group — defence
  // in depth, so a mis-stamped group can never leak another home's photos.
  const siblings: JobDetailSibling[] = [];
  if (groupId) {
    const sibRows = mustRead("the other visits in this package", await admin
      .from("jobs")
      .select("id, date, services(name)")
      .eq("group_id", groupId)
      .eq("property_id", propertyId)
      .neq("id", jobId)
      .order("date", { ascending: true }));
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
      // The date of the free return visit. Null renders as no date at all,
      // which reads as "not booked" to somebody waiting for a crew.
      const fix = mustRead("the return visit", await admin.from("jobs").select("date").eq("id", dispute.correction_job_id as string).maybeSingle());
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
      ? longDay(date)
      : null,
    slot: (job.slot as string) ?? null,
    propertyNickname: prop?.nickname ?? null,
    propertyAddress: prop?.address ?? null,
    crewCompany: crew?.company ?? null, // company name ONLY — never a rate
    isCorrection: job.correction_of != null,
    scopeNote: (job.scope_note as string) ?? null,
    money: {
      customerPrice: Number(job.customer_price ?? 0),
      legs: breakdown?.legs ?? [],
      spring: breakdown?.spring ?? null,
      invoiceStatus: (invoice?.status as string) ?? null,
      invoiceAmount: invoice?.amount == null ? null : Number(invoice.amount),
      paidAt,
      hasCardOnFile,
      declines,
      refunds,
      refundedTotal: refunds.reduce((s, r) => s + r.amount, 0),
      tipAmount: job.tip_amount == null ? null : Number(job.tip_amount),
      tippedAt: (job.tipped_at as string) ?? null,
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
