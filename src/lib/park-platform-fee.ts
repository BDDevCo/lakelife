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
 * WHEN THE LOTS WERE COUNTED, AND WHETHER THAT NEEDS SAYING.
 *
 * 0182 added `counted_at` for one stated reason: "Without it a void-and-re-raise
 * of a closed month silently resamples today's lots: the same month, no dial
 * moved, a different number, and nothing on the row able to explain it."
 *
 * The column was then written, selected into two view types, carried as
 * `countedAt` — and rendered by nothing. `feeSentence` even takes it as a
 * parameter and never reads it. A column whose entire purpose is to be read,
 * read by nobody: the fifth shape, and the one this repo named last.
 *
 * `late` IS DERIVED, NOT A GUESS AT A WINDOW. A month is raised once it is
 * over, so the count is expected in the month AFTER the period. Anything later
 * than that is a catch-up or a re-raise — which is exactly the case 0182 wrote
 * the column for — so the threshold is the period's own following month rather
 * than an invented number of days.
 */
export function countedNote(input: {
  periodMonth: string;
  countedAt: string | null | undefined;
}): { day: string; late: boolean } | null {
  const at = (input.countedAt ?? "").trim();
  // THE SHAPE, NOT A PARSE. `new Date("nonsense")` is Invalid Date and
  // `.toISOString()` on it throws, so a malformed stamp would take a screen
  // down rather than simply say nothing.
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.exec(at);
  if (!m) return null;
  const countedMonth = `${m[1]}-${m[2]}`;

  const period = /^(\d{4})-(0[1-9]|1[0-2])$/.exec((input.periodMonth ?? "").trim());
  // No period to compare against — the dial's preview asks "what would a month
  // raised today say", which has no period at all. Report the day, claim
  // nothing about timing.
  const late = period
    ? countedMonth > monthAfter(`${period[1]}-${period[2]}`)
    : false;

  return { day: dayInWordsShort(at.slice(0, 10)), late };
}

/** The month after this one, as 'YYYY-MM'. Rolls the year. */
function monthAfter(periodMonth: string): string {
  const [y, mm] = periodMonth.split("-").map(Number);
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
}

/** '3 March 2027'. Its own, because this module has no date formatter. */
function dayInWordsShort(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const i = Number(m[2]) - 1;
  return i >= 0 && i < 12 ? `${Number(m[3])} ${names[i]} ${m[1]}` : iso;
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
  // THE PARAMETER THIS FUNCTION HAS ALWAYS TAKEN AND NEVER READ. See
  // `countedNote`: the day only earns a place when it is later than the month
  // the count was expected in, because on an ordinary raise it tells a reader
  // nothing they could not work out.
  const counted = countedNote({ periodMonth: input.periodMonth, countedAt: input.countedAt });
  const when2 = counted?.late
    ? ` Counted ${counted.day}, after the month it bills for — a re-raise samples the lots as they are that day.`
    : "";

  if (excluded.length === 0) return `${head}${when2}`;
  const why = excluded.map((e) => `Lot ${e.lotNumber} (${e.because})`).join(", ");
  return `${head} Not counted: ${why}.${when2}`;
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
  /**
   * TODAY, BECAUSE A MONTH STILL RUNNING HAS NOT FINISHED BEING WHAT IT WILL
   * BE BILLED FOR.
   *
   * This rule existed in `unbilledMonths` (through `lastClosedMonth`) and
   * NOWHERE ELSE — so the task list would never name the current month while
   * the raise door would happily freeze it, or any month in the future. At
   * The Haven, whose fee starts 2027-06, that meant June 2027 could be raised
   * in October 2026: a lot count sampled eight months early, frozen onto the
   * row, with `counted_at` the only clue and nothing rendering it.
   *
   * REQUIRED, not optional with a default of "now". A default would make the
   * gate silently skippable from a caller that forgot it, which is the shape
   * this whole rule exists to close. An empty string is read as "we do not
   * know what day it is", and refuses rather than waving the month through.
   */
  today: string;
}): string | null {
  const period = (input.periodMonth ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return "That isn't a month we can invoice.";

  // THE MONTH HAS TO HAVE FINISHED. `lastClosedMonth` is the one derivation,
  // shared with the gap list, and it returns "" for a date it cannot read —
  // which refuses here rather than letting an unknown today open the gate.
  const closed = lastClosedMonth(input.today);
  if (!closed) {
    return "We can't tell what month it is today, so nothing is being raised.";
  }
  if (period > closed) {
    return `${feeMonthWords(period)} hasn't finished yet — a month is raised once it is over. The latest you can raise is ${feeMonthWords(closed)}.`;
  }

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

/**
 * THE MONTHS A PARK OWES AND NOBODY HAS RAISED.
 *
 * LakeLife's only revenue from a park is this fee, and raising it is a manual
 * act on a tab somebody has to remember to open. Nothing anywhere reminded
 * anyone — verified on 17 Oct 2026: no reference to the platform invoice in
 * the nightly, the ops task list or the park reconciler. A monthly act with no
 * reminder is a monthly act that silently never happens, and a year of that is
 * a year of revenue nobody noticed was missing.
 *
 * TAKES THE SAME TWO GATES `invoiceRefusal` DOES, and must: a month this says
 * is owed but the raise door would refuse is a task nobody can complete.
 *   - before `startMonth` — the park is not being billed from then
 *   - before the first billable period — we do not bill a month that began
 *     before we took the park over
 *
 * `throughMonth` is the last month that may be raised, which the caller
 * decides. It is exclusive of the current month on purpose: a month still
 * running has not finished being what it will be billed for.
 */
export function unbilledMonths(input: {
  startMonth: string | null;
  cutoverDate: string | null;
  /** Months already raised, in any order. Status is the caller's filter. */
  raised: readonly string[];
  /** The newest month that may be raised, "YYYY-MM". */
  throughMonth: string;
}): string[] {
  const start = (input.startMonth ?? "").trim();
  // No start month is not "nothing is owed" — it is a park that CANNOT be
  // invoiced at all, which is a different problem with a different fix, and
  // the caller has to tell them apart.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)) return [];
  const through = (input.throughMonth ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(through)) return [];

  const first = firstBillablePeriod(input.cutoverDate);
  let from = start;
  if (first && first > from) from = first;
  if (from > through) return [];

  const already = new Set(input.raised.map((m) => (m ?? "").trim()));
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  // A cap, so a bad start month cannot spin: twenty years of months is far
  // past anything actionable and the caller shows a count either way.
  for (let guard = 0; guard < 240; guard++) {
    const period = `${y}-${String(m).padStart(2, "0")}`;
    if (period > through) break;
    if (!already.has(period)) out.push(period);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The month before this one, "YYYY-MM" — the newest that may be raised. */
export function lastClosedMonth(today: string): string {
  // THE SHAPE, NOT `Number.isFinite`. `Number("")` is 0 and 0 is finite, so a
  // blank date produced the month "-1-12" and handed it on as a real answer.
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}/.test((today ?? "").trim())) return "";
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, "0")}`;
}
