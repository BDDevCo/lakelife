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

/**
 * What a lot physically IS. Hookups are NOT here — has_water, has_sewer and
 * amperage carry those (migration 0057). rv_full and rv_we used to be separate
 * types even though they differed only by sewer, which meant the same fact
 * lived in two places and could disagree with itself.
 */
export type SiteType = "rv_site" | "mh_single" | "mh_double" | "tent" | "slip";

/** What a lot is WORTH, independent of what it is. Combines with any type, so
 *  "premium double-wide" is sayable. */
export type Tier = "standard" | "premium";

/** WHY it is worth more. An allowlist — free text on a housing listing is
 *  where a fair-housing problem gets typed. */
export type LotFeature =
  | "waterfront" | "water_view" | "corner" | "shade" | "pull_through"
  | "extra_parking" | "concrete_pad" | "fenced" | "near_amenities" | "private";
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
  tier?: Tier;
  features?: LotFeature[];
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
  // A mobile home fits either pad width. We do not capture whether the HOME is
  // single or double wide, so refusing a double pad to a single-wide would be
  // guessing — and the owner walks the lot anyway. Length still applies.
  mobile_home:    ["mh_single", "mh_double"],
  park_model:     ["mh_single", "mh_double", "rv_site"],
  travel_trailer: ["rv_site"],
  fifth_wheel:    ["rv_site"],
  motorhome:      ["rv_site"],
  rv:             ["rv_site"],
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
 * Postgres hands a `daterange` back as text — `[2026-07-01,2026-07-08)`. It
 * NORMALISES to `[)` on the way in, so the stored form is always
 * inclusive-start / exclusive-end no matter what we wrote. We still read the
 * brackets rather than assuming, because assuming is how an off-by-one night
 * gets billed, and we accept the `[]` form Postgres produces for a
 * single-day-precision range so an unexpected shape degrades to the right
 * answer instead of a wrong one.
 *
 * Returns null on anything unparseable — the caller shows "—", never a
 * fabricated date.
 */
export function parseDaterange(raw: string | null | undefined): DateRange | null {
  if (!raw) return null;
  const m = /^([[(])\s*(\d{4}-\d{2}-\d{2})\s*,\s*(\d{4}-\d{2}-\d{2})\s*([\])])$/.exec(raw.trim());
  if (!m) return null;
  const [, lo, rawStart, rawEnd, hi] = m;
  // Normalise to half-open [start, end).
  const start = lo === "(" ? fmt(parse(rawStart) + DAY) : rawStart;
  const end = hi === "]" ? fmt(parse(rawEnd) + DAY) : rawEnd;
  const range = { start, end };
  return isRealRange(range) ? range : null;
}

/** The literal Postgres expects. Always half-open, to match the exclusion
 *  constraint and `overlaps` below. */
export function toDaterange(r: DateRange): string {
  return `[${r.start},${r.end})`;
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

export function isAvailable(
  lot: Lot,
  want: DateRange,
  held: Held[],
  /** The lot's effective season. Omit for year-round. */
  season?: ParkSeason,
): boolean {
  if (!lot.active || !isRealRange(want)) return false;
  // A closed lot is not available, however empty it is. Checked BEFORE the
  // clash scan because "the slips are out of the water" is a better answer
  // than "somebody has it".
  if (season && !parkOpenFor(season, want)) return false;
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
/**
 * The season that actually governs a lot.
 *
 * A lot with no window of its own inherits the park's; a park with none is
 * year-round. Written as one function so the precedence lives in exactly one
 * place — the alternative is every caller remembering the fallback, and the
 * one that forgets sells a boat slip in January.
 */
export function effectiveSeason(
  lot: Partial<ParkSeason> | null | undefined,
  park: ParkSeason | null | undefined,
): ParkSeason {
  const complete = (s: Partial<ParkSeason> | null | undefined): s is ParkSeason =>
    s != null &&
    s.openMonth != null && s.openDay != null &&
    s.closeMonth != null && s.closeDay != null;

  if (complete(lot)) return lot;
  if (complete(park)) return park;
  return { openMonth: null, openDay: null, closeMonth: null, closeDay: null };
}

/** Does this season actually close, or is it year-round? */
export function isSeasonal(season: ParkSeason): boolean {
  return season.openMonth != null && season.openDay != null
    && season.closeMonth != null && season.closeDay != null;
}

/**
 * The first day AFTER the season, on or after `fromISO` — i.e. the checkout
 * morning a stay must not run past.
 *
 * Half-open to match everything else: a season closing Oct 31 returns Nov 1,
 * because the guest's last night is the 31st.
 *
 * Returns null for a year-round season, which means "nothing to clamp to".
 */
export function seasonEndAfter(fromISO: string, season: ParkSeason): string | null {
  if (!isSeasonal(season)) return null;
  const [y] = fromISO.split("-").map(Number);

  // Try this year and the next: a stay starting in December under a Nov-Mar
  // window closes in the FOLLOWING year.
  for (const year of [y, y + 1]) {
    const close = new Date(Date.UTC(year, season.closeMonth! - 1, season.closeDay!));
    // The morning after the last night.
    close.setUTCDate(close.getUTCDate() + 1);
    const iso = close.toISOString().slice(0, 10);
    if (iso > fromISO) return iso;
  }
  return null;
}

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
