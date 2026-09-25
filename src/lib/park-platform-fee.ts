import { firstBillablePeriod } from "@/lib/billing-start";

/**
 * WHAT A PARK PAYS LAKELIFE — $ PER LOT, PER MONTH.
 *
 * Brendon, 24 September 2026, after weighing a percentage of gross rent against
 * a flat per-lot charge: "I like the per lot amount. $8 per lot per month? make
 * it a ops toggle".
 *
 * ============ THE DIRECTION OF THIS MONEY IS THE WHOLE RISK ============
 *
 * It runs LAKELIFE -> THE PARK OWNER. Every other park money table in this
 * codebase runs the other way (park -> resident: park_charges, park_fees,
 * park_payments, park_refunds) or records the park's own costs (park_costs,
 * which SPLITS across lots and lands on nineteen rent bills). The failure this
 * whole module is shaped to prevent is LakeLife's revenue appearing on a
 * resident's bill — so nothing here shares a table, a prefix, or a reader with
 * any of them, and `lakelife_park_invoices` carries no renter_id, no lot id and
 * no reservation id, so there is physically nowhere for a household to hang.
 *
 * ============ AND NOTHING HERE CHARGES ANYTHING ============
 *
 * There is no processor. "As LakeLife we do not handle cash. at all. hard
 * stop." A row is a record of what is owed for a month, frozen; it is not a
 * demand, it has not been sent, and no park can pay it. The status vocabulary
 * is deliberately draft | issued | void — there is no `paid` and no `sent`, so
 * no column is able to claim either.
 */

/** The dial band: $0 to $100 per lot per month, in whole cents. */
export const MIN_FEE_PER_LOT = 0;
export const MAX_FEE_PER_LOT = 100;

/**
 * ONE LOT, WITH EVERY FIELD THE RULE READS — AND ALL OF THEM REQUIRED.
 *
 * `src/lib/parks.ts` already has a `Lot` type whose `parkOwnedHome` is
 * OPTIONAL, and the ops board's own select
 * (`src/app/ops/parks-data.ts`) does not fetch the column at all. Hand that
 * type to a rule that excludes park-owned homes and `undefined !== true`
 * silently passes: Lot 11 — the park's own house — joins the count, and The
 * Haven is invoiced $168 instead of $160 with nothing red anywhere.
 *
 * So this is its OWN type with no optional fields, and `fetchFeeLots` is the
 * only thing that builds it. A caller who forgets a column now fails to
 * compile, which is the whole point of not reusing `Lot`.
 */
export interface FeeLot {
  lotNumber: string;
  active: boolean;
  lifecycle: string;
  parkOwnedHome: boolean;
  siteType: string;
}

/** Why a lot was left off the bill, in words the bill itself can print. */
export interface ExcludedLot {
  lotNumber: string;
  because: string;
}

export interface CountedLots {
  count: number;
  lotNumbers: string[];
  excluded: ExcludedLot[];
}

/** Inventory a park rents out but LakeLife administers no household on. */
const NOT_A_LOT_WE_ADMINISTER = new Set(["slip", "storage"]);

/**
 * WHICH LOTS THE FEE COUNTS. Live, in service, not the park's own home, and
 * not a boat slip or a storage space.
 *
 * ============ OCCUPANCY IS DELIBERATELY NOT PART OF IT ============
 *
 * It is the obvious rule and it is the wrong one here, for three reasons that
 * are all facts about this codebase rather than opinions:
 *
 *   IT READS ZERO TODAY. `park_renters` holds no rows — the roll names nobody
 *   — so every occupancy rule invoices $0.00 while eighteen households live
 *   at The Haven, and then jumps to $160 overnight on 1 January with nobody
 *   having touched a dial.
 *
 *   FOUR EXISTING HELPERS DISAGREE ABOUT IT. `listFees` drops grandfathered
 *   tenancies; `getSharedCostBaseline` has no date test at all and counts a
 *   lease filed in December as a January payer. On 1 January they would answer
 *   18, 19, 20 or 21 — a $24/month spread decided by which file the code was
 *   copied from.
 *
 *   IT MOVES WITHOUT A DECISION. A bill that changes every time somebody moves
 *   out is a bill the owner has to be talked through every month.
 *
 * ============ `active` IS IN THE RULE, AND THAT IS THE OPPOSITE OF allocateCost
 *
 * Filtering shared costs on `active` was a real bug (`cost-actions.ts`): a lot
 * switched off for repairs still has a tap and a sewer line, so excluding it
 * made the denominator wrong and overcharged everybody else. THIS IS THE OTHER
 * QUESTION AND IT TAKES THE OTHER ANSWER — LakeLife's software genuinely does
 * nothing for a lot the owner has taken out of service. Do not "fix" this to
 * match the cost rule; they disagree on purpose.
 *
 * The consequence is real and is handled elsewhere rather than here: unticking
 * "In service" lowers what the park owes, and any park manager can do it. The
 * raise screen therefore shows what MOVED since the last issued month, so a
 * count that fell is a sentence somebody reads rather than a number nobody
 * notices.
 */
export function countableLots(lots: FeeLot[]): CountedLots {
  const lotNumbers: string[] = [];
  const excluded: ExcludedLot[] = [];

  for (const lot of lots ?? []) {
    const because =
      lot.lifecycle !== "live" ? `not live yet (${lot.lifecycle})`
      : !lot.active ? "taken out of service"
      : lot.parkOwnedHome ? "the park's own home"
      : NOT_A_LOT_WE_ADMINISTER.has(lot.siteType) ? `a ${lot.siteType}, not a lot`
      : null;
    if (because) excluded.push({ lotNumber: lot.lotNumber, because });
    else lotNumbers.push(lot.lotNumber);
  }

  return { count: lotNumbers.length, lotNumbers, excluded };
}

/**
 * THE RATE FOR ONE PARK, IN CENTS.
 *
 * A park's own negotiated rate REPLACES the list price outright — it never
 * blends with it, because park rates never combine. `null` means this park has
 * no negotiated rate and pays the list price.
 *
 * `??`, NEVER `||`. An override of 0 is a park held free — a pilot, or one
 * paused while a conversation is open — and it is a real, deliberate value. `||`
 * treats it as absent and silently invoices them the list price instead, which
 * is the falsy-versus-null mistake this codebase has already paid for.
 */
export function rateCentsFor(dialDollars: number, parkOverrideCents: number | null | undefined): number {
  if (parkOverrideCents != null && Number.isFinite(parkOverrideCents) && parkOverrideCents >= 0) {
    return Math.round(parkOverrideCents);
  }
  const d = Number(dialDollars);
  if (!Number.isFinite(d) || d < MIN_FEE_PER_LOT) return 0;
  return Math.round(Math.min(d, MAX_FEE_PER_LOT) * 100);
}

export interface Fee {
  count: number;
  lotNumbers: string[];
  excluded: ExcludedLot[];
  rateCents: number;
  amountCents: number;
}

/**
 * THE NUMBER. The only thing in this product allowed to produce it.
 *
 * `raiseParkPlatformInvoice` must CALL this rather than rebuild the
 * multiplication — a rebuilt expression passes its own test with the real one
 * deleted, and a second implementation of a money line is how two screens come
 * to disagree about what a park owes.
 */
export function feeFor(lots: FeeLot[], rateCents: number): Fee {
  const counted = countableLots(lots);
  const rate = Math.max(0, Math.round(rateCents));
  return {
    count: counted.count,
    lotNumbers: counted.lotNumbers,
    excluded: counted.excluded,
    rateCents: rate,
    amountCents: counted.count * rate,
  };
}

/** "$160.00" — cents to money, never a bare rounded dollar. */
export function money(cents: number): string {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** "January 2027" — a month a person reads is never "2027-01". */
export function feeMonthWords(periodMonth: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec((periodMonth ?? "").trim());
  if (!m) return periodMonth ?? "";
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const i = Number(m[2]) - 1;
  return i >= 0 && i < 12 ? `${names[i]} ${m[1]}` : periodMonth;
}

/**
 * WHAT THE BILL SAYS IT COUNTED — built from the row's own columns, never from
 * a live re-read.
 *
 * IT SAYS "20 OF 21 LOTS COUNTED", NOT "20 LOTS IN SERVICE". "In service" is
 * the owner-facing label of `park_lots.active`, and at The Haven twenty-one
 * lots carry that tick. A bill claiming "20 lots in service" disagrees by one
 * lot and $8 with the lots screen, and the bill is the one asserting money.
 *
 * Every exclusion is named, so the difference between the two numbers is on the
 * bill rather than in somebody's head.
 */
export function feeSentence(input: {
  parkName: string;
  periodMonth: string;
  count: number;
  rateCents: number;
  amountCents: number;
  excluded?: ExcludedLot[];
  countedAt?: string | null;
}): string {
  const excluded = input.excluded ?? [];
  const total = input.count + excluded.length;
  // NO MONTH MEANS NO MONTH CLAUSE. The dial's per-park preview asks this
  // question without one — it is "what a month raised today would say", not a
  // month — and interpolating an empty string left the sentence opening on a
  // dangling " — ", which reads as a figure whose period went missing.
  const when = feeMonthWords(input.periodMonth);
  const head =
    `${when ? `${when} — ` : ""}${input.parkName}. ` +
    `${input.count} of ${total} lot${total === 1 ? "" : "s"} counted × ${money(input.rateCents)} = ${money(input.amountCents)}.`;
  if (excluded.length === 0) return head;
  const why = excluded.map((e) => `Lot ${e.lotNumber} (${e.because})`).join(", ");
  return `${head} Not counted: ${why}.`;
}

/**
 * MAY THIS MONTH BE INVOICED AT ALL? Returns the refusal, or null to proceed.
 *
 * THREE REFUSALS, AND THE THIRD IS A PROMISE ALREADY MADE. The park section of
 * the terms in force says, unqualified as to whose bill: "Once you tell us the
 * day you took the park over, it will not bill for any month that began before
 * it." A LakeLife invoice for a month before the park's cutover contradicts a
 * sentence the owner has already accepted — so the boundary is asked of
 * `firstBillablePeriod`, the function that already encodes it, rather than
 * re-derived here where the two could drift.
 */
export function invoiceRefusal(input: {
  periodMonth: string;
  startMonth: string | null;
  cutoverDate: string | null;
}): string | null {
  const period = (input.periodMonth ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return "That isn't a month we can invoice.";

  const start = (input.startMonth ?? "").trim();
  if (!start) {
    return "This park isn't being billed yet — set the month its fee starts before raising anything.";
  }
  if (period < start) {
    return `${feeMonthWords(period)} is before this park's fee starts (${feeMonthWords(start)}).`;
  }

  const first = firstBillablePeriod(input.cutoverDate);
  if (first && period < first) {
    return `${feeMonthWords(period)} began before this park was taken over, and we don't bill a month that started before us. The first month we can is ${feeMonthWords(first)}.`;
  }
  return null;
}
