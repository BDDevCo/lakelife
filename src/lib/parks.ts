/**
 * Park inventory rules — PURE, no I/O, fully unit-testable, same pattern as
 * pricing.ts / refunds.ts / fleet.ts. Every decision about whether a lot can
 * be offered to a renter lives here so it can be tested without a database.
 *
 * The park owner dictates the money (rule 8: rates live in `lot_rates`, which
 * they tune). This module never invents a price — it only reads their card.
 *
 * Design: docs/park-module-design.md
 */

export type SiteType = "mh_pad" | "rv_full" | "rv_we" | "tent" | "slip_only";
export type Term = "nightly" | "weekly" | "monthly" | "seasonal" | "annual";
export type UnitType =
  | "mobile_home" | "park_model" | "travel_trailer" | "fifth_wheel" | "motorhome" | "rv";

export interface Lot {
  id: string;
  lotNumber: string;
  siteType: SiteType;
  maxLengthFt: number | null;
  amperage: number | null;
  hasWater: boolean;
  hasSewer: boolean;
  slipIncluded: boolean;
  active: boolean;
}

export interface RenterUnit {
  unitType: UnitType;
  lengthFt: number | null;
  /** 50A service is common on larger rigs; null means "we don't know". */
  needsAmps?: number | null;
}

/** A held date range. Half-open [start, end) — the same shape as a Postgres
 *  daterange, so the TS and the exclusion constraint agree on what "touching"
 *  means: a stay ending the day another begins is NOT an overlap. */
export interface DateRange {
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD exclusive
}

export type FitProblem =
  | "inactive"
  | "too_short"
  | "not_enough_power"
  | "wrong_site_type"
  | "needs_sewer";

export interface FitResult {
  fits: boolean;
  problems: FitProblem[];
}

/** Which site types can physically host which units. A park model or mobile
 *  home needs a pad — it is not going on a tent site — and a slip is water,
 *  not land. */
const SITE_FOR_UNIT: Record<UnitType, SiteType[]> = {
  mobile_home:    ["mh_pad"],
  park_model:     ["mh_pad", "rv_full"],
  travel_trailer: ["rv_full", "rv_we"],
  fifth_wheel:    ["rv_full", "rv_we"],
  motorhome:      ["rv_full", "rv_we"],
  rv:             ["rv_full", "rv_we"],
};

/**
 * Can this unit go on this lot? Returns every reason it cannot, not just the
 * first — a renter who fixes one problem and hits another immediately is a
 * support conversation, and the park owner is the one who fields it.
 *
 * Unknown values do NOT block. A renter who has not told us their length is
 * shown the lot; the park owner confirms on arrival. Refusing on missing data
 * would empty the map for anyone who skipped a field.
 */
export function lotFits(lot: Lot, unit: RenterUnit): FitResult {
  const problems: FitProblem[] = [];
  if (!lot.active) problems.push("inactive");

  const allowed = SITE_FOR_UNIT[unit.unitType] ?? [];
  if (allowed.length > 0 && !allowed.includes(lot.siteType)) problems.push("wrong_site_type");

  if (lot.maxLengthFt != null && unit.lengthFt != null && unit.lengthFt > lot.maxLengthFt) {
    problems.push("too_short");
  }
  if (lot.amperage != null && unit.needsAmps != null && unit.needsAmps > lot.amperage) {
    problems.push("not_enough_power");
  }
  // A mobile home is not moving to a dump station every week.
  if (!lot.hasSewer && (unit.unitType === "mobile_home" || unit.unitType === "park_model")) {
    problems.push("needs_sewer");
  }
  return { fits: problems.length === 0, problems };
}

/** Plain-English reason, for the renter-facing "why can't I book this?" line. */
export function fitProblemText(p: FitProblem, lot: Lot): string {
  switch (p) {
    case "inactive":          return "This lot isn't available right now.";
    case "too_short":         return `This lot takes up to ${lot.maxLengthFt} ft.`;
    case "not_enough_power":  return `This lot has ${lot.amperage}-amp service.`;
    case "wrong_site_type":   return "This lot isn't set up for your type of unit.";
    case "needs_sewer":       return "This lot has no sewer hookup.";
  }
}

// ---------------------------------------------------------------- dates ----

const DAY = 86_400_000;

function parse(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function fmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function isRealRange(r: DateRange): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.start) || !/^\d{4}-\d{2}-\d{2}$/.test(r.end)) return false;
  return parse(r.end) > parse(r.start);
}
export function nightsIn(r: DateRange): number {
  return Math.round((parse(r.end) - parse(r.start)) / DAY);
}

/**
 * Do two stays collide? Half-open, so back-to-back is FINE: one renter leaving
 * on the 1st and the next arriving on the 1st is a normal changeover day, and
 * treating it as a conflict would strand a night on every turnover.
 *
 * This mirrors the `during && during` exclusion constraint in migration 0052
 * exactly — if these two ever disagree, the database wins and the UI lies.
 */
export function overlaps(a: DateRange, b: DateRange): boolean {
  return parse(a.start) < parse(b.end) && parse(b.start) < parse(a.end);
}

/** Only a DECIDED reservation holds dates. Two people may both apply for the
 *  same lot — the park owner picks. Mirrors 0052's `where (status in
 *  ('approved','active'))`. */
export const HOLDING_STATUSES = ["approved", "active"] as const;
export type HoldingStatus = (typeof HOLDING_STATUSES)[number];

export interface Held {
  during: DateRange;
  status: string;
}

export function isAvailable(lot: Lot, want: DateRange, held: Held[]): boolean {
  if (!lot.active || !isRealRange(want)) return false;
  return !held.some(
    (h) => (HOLDING_STATUSES as readonly string[]).includes(h.status) && overlaps(h.during, want),
  );
}

// --------------------------------------------------------------- pricing ---

export interface RateCard {
  term: Term;
  amount: number;
}

/** Nights each term is understood to cover, for comparing like with like. */
const TERM_NIGHTS: Record<Term, number> = {
  nightly: 1,
  weekly: 7,
  monthly: 30,
  seasonal: 180,
  annual: 365,
};

/**
 * What the park owner charges for this stay. Their card, their number — this
 * only multiplies whole periods and never invents a rate the park has not set.
 *
 * Returns null when the park does not sell that term, which is a real answer:
 * a park that only does annual leases should not be quietly quoted a week.
 */
export function quoteStay(rates: RateCard[], term: Term, want: DateRange): number | null {
  if (!isRealRange(want)) return null;
  const card = rates.find((r) => r.term === term);
  if (!card) return null;
  const nights = nightsIn(want);
  const per = TERM_NIGHTS[term];
  // Always round UP to a whole period: a park sells months, not part-months.
  const periods = Math.max(1, Math.ceil(nights / per));
  return Math.round(card.amount * periods * 100) / 100;
}

/** The cheapest term the park actually sells, for the "from $X" line on the
 *  public park page. Null when the park has priced nothing yet. */
export function fromPrice(rates: RateCard[]): { term: Term; amount: number } | null {
  const priced = rates.filter((r) => r.amount > 0);
  if (priced.length === 0) return null;
  return priced.reduce((lo, r) => (r.amount < lo.amount ? r : lo));
}

// ------------------------------------------------------------- seasonality -

export interface ParkSeason {
  openMonth: number | null;
  openDay: number | null;
  closeMonth: number | null;
  closeDay: number | null;
}

/**
 * Is the park open across this whole stay? A seasonal park that shuts for the
 * winter must not sell a January week.
 *
 * Null dates mean YEAR-ROUND — open. This is the opposite of the lake
 * water-season gate, which fails closed on an unknown window, and deliberately
 * so: an unknown LAKE season means we cannot tell if there is ice, while an
 * unconfigured PARK season means the park owner never told us they close.
 */
export function parkOpenFor(season: ParkSeason, want: DateRange): boolean {
  const { openMonth, openDay, closeMonth, closeDay } = season;
  if (openMonth == null || openDay == null || closeMonth == null || closeDay == null) return true;
  if (!isRealRange(want)) return false;

  const inWindow = (iso: string): boolean => {
    const [, m, d] = iso.split("-").map(Number);
    const md = m * 100 + d;
    const open = openMonth * 100 + openDay;
    const close = closeMonth * 100 + closeDay;
    // A window that wraps the New Year (e.g. open Nov, close Mar) is two arcs.
    return open <= close ? md >= open && md <= close : md >= open || md <= close;
  };

  // Check every night of the stay — the LAST night is end-1 because `end` is
  // exclusive, and a stay that ends the morning the park closes is fine.
  for (let t = parse(want.start); t < parse(want.end); t += DAY) {
    if (!inWindow(fmt(t))) return false;
  }
  return true;
}
