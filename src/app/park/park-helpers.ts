/**
 * The park owner's rent roll, as PURE functions — no I/O, no database, fully
 * testable. Same convention as rates-helpers.ts / earnings-helpers.ts.
 *
 * "Rent roll" here means the RECORD of who is on which lot and until when.
 * Phase 1 collects nothing: there is no invoice, no charge, no payout. The
 * amounts below are the park owner's own rate card echoed back at them so the
 * page can say what a stay is worth — never a number LakeLife invented, and
 * never anything that touches the money rails. See docs/park-module-design.md.
 */

import {
  isAvailable, overlaps, parseDaterange, quoteStay, nightsIn,
  type DateRange, type Lot, type Term, type RateCard,
  parkOpenFor,
  type ParkSeason,
} from "@/lib/parks";
// The agreement cap lives here already, and it clamps short months correctly.
import { addMonths } from "./agreement-helpers";

// ------------------------------------------------------------ rent roll ----

/** A reservation as it comes off the wire, before we make sense of it. */
export interface RawReservation {
  id: string;
  park_lot_id: string;
  renter_id: string;
  renter_unit_id: string | null;
  during: string | null; // Postgres daterange text
  term: string;
  quoted_amount: number | null;
  /** Optional: rows written before 0059 carry neither. */
  due_day?: number | null;
  /** WHERE THE NUMBER CAME FROM. The rent roll shows its work with this. */
  amount_source?: string | null;
  status: string;
  decided_at: string | null;
  created_at: string | null;
}

export interface Stay {
  id: string;
  lotId: string;
  /** The park's FILE on this person — NOT an account id. May belong to
   *  someone who has never logged in and never will. */
  renterId: string;
  renterUnitId: string | null;
  range: DateRange | null;
  term: Term;
  quotedAmount: number | null;
  dueDay: number | null;
  amountSource: string | null;
  status: string;
  decidedAt: string | null;
  createdAt: string | null;
}

export function toStay(r: RawReservation): Stay {
  return {
    id: r.id,
    lotId: r.park_lot_id,
    renterId: r.renter_id,
    renterUnitId: r.renter_unit_id,
    range: parseDaterange(r.during),
    term: r.term as Term,
    quotedAmount: r.quoted_amount,
    dueDay: r.due_day ?? null,
    amountSource: r.amount_source ?? null,
    status: r.status,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

/** What a lot is doing right now. Ordered by how much the owner cares. */
export type LotState = "inactive" | "occupied" | "reserved" | "vacant";

export interface RollRow {
  lot: Lot;
  state: LotState;
  /** The stay covering today, if any. */
  current: Stay | null;
  /** The next decided stay that has not started yet. */
  next: Stay | null;
  /** Undecided applications waiting on this lot — the owner's to-do list. */
  pending: Stay[];
  /** Nights until `current` ends. Null when nothing is on the lot. */
  nightsLeft: number | null;
}

const HOLDS = new Set(["approved", "active"]);

/** Does this stay cover `today`? Half-open: the end date is checkout morning,
 *  so a stay ending today is already over. */
export function coversDay(range: DateRange | null, todayISO: string): boolean {
  if (!range) return false;
  return range.start <= todayISO && todayISO < range.end;
}

/**
 * One row per lot: who is on it, who is coming, and who is asking. This is the
 * whole park on one screen, which is the entire pitch to the park owner —
 * today they keep it in a spiral notebook.
 *
 * A lot with no rate card and no stays is still listed. Silence about an empty
 * lot is the expensive kind of silence: an unrented lot is the thing the owner
 * most needs to see.
 */
export function buildRentRoll(
  lots: Lot[],
  stays: Stay[],
  todayISO: string,
): RollRow[] {
  const byLot = new Map<string, Stay[]>();
  for (const s of stays) {
    const list = byLot.get(s.lotId);
    if (list) list.push(s);
    else byLot.set(s.lotId, [s]);
  }

  return lots.map((lot) => {
    const mine = byLot.get(lot.id) ?? [];
    const held = mine.filter((s) => HOLDS.has(s.status));

    const current = held.find((s) => coversDay(s.range, todayISO)) ?? null;
    const next =
      held
        .filter((s) => s.range && s.range.start > todayISO)
        .sort((a, b) => (a.range!.start < b.range!.start ? -1 : 1))[0] ?? null;
    const pending = mine
      .filter((s) => s.status === "applied")
      .sort((a, b) => (a.createdAt ?? "") < (b.createdAt ?? "") ? -1 : 1);

    const state: LotState = !lot.active
      ? "inactive"
      : current
        ? "occupied"
        : next
          ? "reserved"
          : "vacant";

    return {
      lot,
      state,
      current,
      next,
      pending,
      nightsLeft: current?.range ? nightsIn({ start: todayISO, end: current.range.end }) : null,
    };
  });
}

export interface RollSummary {
  lots: number;        // active lots only — an inactive lot is not inventory
  occupied: number;
  reserved: number;
  vacant: number;
  inactive: number;
  pending: number;     // applications awaiting a decision, across the park
  /** Occupied / active lots, 0-100, rounded. Null when there are no active
   *  lots — a brand-new park is not "0% full", it has nothing to be full of,
   *  and showing 0% on setup day is a discouraging lie. */
  occupancyPct: number | null;

  /**
   * NOT YET REAL. Homes being bought, lots being cleared, numbers on a
   * proforma. Counted apart and EXCLUDED from `lots` and from occupancy —
   * four unbuilt homes would take a true 91% down to 77%, and that number
   * goes in front of a lender.
   */
  planned: number;
  renovating: number;
  /**
   * Rented by the night, not lived on. Occupancy means a different thing for
   * these — 19 nights of 30, not "somebody lives there" — so they are kept
   * out of the long-term percentage rather than averaged into nonsense.
   */
  shortTermLots: number;
}

export function summarise(rows: RollRow[]): RollSummary {
  const s: RollSummary = {
    lots: 0, occupied: 0, reserved: 0, vacant: 0, inactive: 0, pending: 0,
    occupancyPct: null,
    planned: 0, renovating: 0, shortTermLots: 0,
  };
  for (const r of rows) {
    s.pending += r.pending.length;

    // Inventory that does not exist yet is not inventory. It is counted, and
    // said out loud, but it never touches occupancy — a home nobody has
    // bought cannot be "vacant".
    const life = r.lot.lifecycle ?? "live";
    if (life === "planned")    { s.planned++;    continue; }
    if (life === "renovating") { s.renovating++; continue; }
    if (life === "retired")    { continue; }

    // A nightly home's occupancy is nights booked, not "somebody lives here".
    if (r.lot.rentalMode === "short_term") { s.shortTermLots++; continue; }

    if (r.state === "inactive") { s.inactive++; continue; }
    s.lots++;
    if (r.state === "occupied") s.occupied++;
    else if (r.state === "reserved") s.reserved++;
    else s.vacant++;
  }
  if (s.lots > 0) s.occupancyPct = Math.round((s.occupied / s.lots) * 100);
  return s;
}

// ----------------------------------------------------- decision guards -----

export type DecideProblem =
  | "not_pending"      // already decided — a double-tap, or two managers at once
  | "no_dates"         // the range never parsed; refuse rather than guess
  | "out_of_season"    // the lot is closed for part of those dates
  | "lot_taken";       // another decided stay already holds these dates

/**
 * May this application be approved? The DATABASE is the real guard (the
 * exclusion constraint), and it stays the real guard — this exists so the
 * owner gets "Lot 12 is already taken those nights" instead of a raw
 * constraint violation, and so the UI can grey the button before they tap it.
 *
 * Deliberately NOT a fit check. A park owner may put whoever they like on
 * whichever lot they like; the fit warnings are advice on the way in, not a
 * veto over the owner's own property.
 */
export function canApprove(
  application: Stay,
  otherStays: Stay[],
  lot: Lot,
  /** The lot's EFFECTIVE season (its own, else the park's). */
  season?: ParkSeason,
): { ok: boolean; problem?: DecideProblem } {
  if (application.status !== "applied") return { ok: false, problem: "not_pending" };
  if (!application.range) return { ok: false, problem: "no_dates" };

  const conflict = otherStays.some(
    (s) =>
      s.id !== application.id &&
      s.lotId === application.lotId &&
      HOLDS.has(s.status) &&
      s.range != null &&
      overlaps(s.range, application.range!),
  );
  if (conflict) return { ok: false, problem: "lot_taken" };

  // Belt and braces: isAvailable also refuses an inactive lot and a nonsense
  // range, so the two answers can never disagree.
  // A stay that runs outside the lot's season is refused with its own reason —
  // "the slips are out of the water" is a better answer than "lot taken".
  if (season && !parkOpenFor(season, application.range)) {
    return { ok: false, problem: "out_of_season" };
  }

  if (!isAvailable(lot, application.range, otherStays
    .filter((s) => s.id !== application.id && s.lotId === application.lotId)
    .map((s) => ({ during: s.range ?? { start: "", end: "" }, status: s.status })), season)) {
    return { ok: false, problem: "lot_taken" };
  }
  return { ok: true };
}

export function decideProblemText(p: DecideProblem): string {
  switch (p) {
    case "not_pending": return "This application has already been decided.";
    case "no_dates":    return "This application has no usable dates — ask the renter to re-apply.";
    case "out_of_season": return "That spot is closed for part of those dates — check the season on the lot.";
    case "lot_taken":   return "That lot is already taken for some of those nights.";
  }
}

// ------------------------------------------------------------ lot form -----

export interface LotFormInput {
  lotNumber: string;
  siteType: string;
  maxLengthFt: string;
  amperage: string;
  hasWater: boolean;
  hasSewer: boolean;
  slipIncluded: boolean;
  notes: string;
  active: boolean;
  /** What it is WORTH, independent of what it IS. */
  tier?: string;
  /** WHY it is worth more. Allowlisted — never free text. */
  features?: string[];
  /**
   * This lot's OWN season, as "MM-DD" strings. Blank on both = inherit the
   * park's window. A slip is Apr-Oct while the pads beside it are year-round.
   */
  seasonOpen?: string;
  seasonClose?: string;
}

export interface LotFormResult {
  ok: boolean;
  error?: string;
  row?: {
    lot_number: string;
    site_type: string;
    max_length_ft: number | null;
    amperage: number | null;
    has_water: boolean;
    has_sewer: boolean;
    slip_included: boolean;
    notes: string | null;
    active: boolean;
    season_open_month: number | null;
    season_open_day: number | null;
    season_close_month: number | null;
    season_close_day: number | null;
    tier: string;
    features: string[];
  };
}

const SITE_TYPES = ["rv_site", "mh_single", "mh_double", "tent", "slip"];
const TIERS = ["standard", "premium"];
const FEATURES = [
  "waterfront", "water_view", "corner", "shade", "pull_through",
  "extra_parking", "concrete_pad", "fenced", "near_amenities", "private",
];
const AMPS = [20, 30, 50, 100];

/**
 * What a site type comes with, before anyone touches it.
 *
 * This exists because the two halves of the lot form used to disagree: a new
 * lot defaulted to `rv_full` with `hasSewer: false`, and buildLotRow REFUSES a
 * mobile-home pad without sewer. So an owner setting up a mobile-home park —
 * a park with seventy-nine pads in it — got that refusal on every single lot,
 * caused entirely by a default they never chose. The validation rule is right;
 * it was firing on our own bad starting point.
 *
 * A pad has sewer. A full-hookup RV site has sewer. A water-and-electric site
 * does not, which is what the name says. Pick the honest default per type and
 * the rule stops arguing with the form.
 */
export const SITE_DEFAULTS: Record<string, { hasWater: boolean; hasSewer: boolean }> = {
  // An RV site defaults to FULL hookup because that is what most parks build
  // and what an owner means when they say "RV lot" — they uncheck sewer for
  // the water-and-electric row, which is the smaller number.
  rv_site:   { hasWater: true,  hasSewer: true  },
  mh_single: { hasWater: true,  hasSewer: true  },
  mh_double: { hasWater: true,  hasSewer: true  },
  tent:      { hasWater: false, hasSewer: false },
  slip:      { hasWater: false, hasSewer: false },
};

/**
 * Validate and shape one lot. Every value the park owner types is re-checked
 * here against the same rules the database CHECK constraints hold, so a
 * mistake comes back as a sentence instead of a Postgres error string.
 */
export function buildLotRow(input: LotFormInput): LotFormResult {
  const lotNumber = input.lotNumber.trim();
  if (!lotNumber) return { ok: false, error: "Give the lot a number or name." };
  if (lotNumber.length > 24) return { ok: false, error: "That lot number is too long (24 characters max)." };

  if (!SITE_TYPES.includes(input.siteType)) {
    return { ok: false, error: "Pick what kind of site this is." };
  }

  let maxLengthFt: number | null = null;
  const rawLen = input.maxLengthFt.trim();
  if (rawLen) {
    const n = Number(rawLen);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: "Max length must be a whole number of feet." };
    }
    if (n > 120) return { ok: false, error: "That length looks wrong — 120 ft is the longest we'll take." };
    maxLengthFt = n;
  }

  let amperage: number | null = null;
  const rawAmp = input.amperage.trim();
  if (rawAmp) {
    const n = Number(rawAmp);
    if (!AMPS.includes(n)) return { ok: false, error: "Power must be 20, 30, 50 or 100 amp." };
    amperage = n;
  }

  // A mobile-home pad without sewer is almost always a typo, not a park with
  // no sewer — flag it rather than let the fit rules quietly hide the lot from
  // every mobile home that searches.
  if ((input.siteType === "mh_single" || input.siteType === "mh_double") && !input.hasSewer) {
    return { ok: false, error: "A mobile-home pad needs sewer. Turn sewer on, or pick a different site type." };
  }

  const notes = input.notes.trim();

  const season = parseLotSeason(input.seasonOpen, input.seasonClose);
  if (!season.ok) return { ok: false, error: season.error };
  if (notes.length > 500) return { ok: false, error: "Notes are a bit long — keep it under 500 characters." };

  const tier = (input.tier ?? "standard").trim() || "standard";
  if (!TIERS.includes(tier)) {
    return { ok: false, error: "A lot is either standard or premium." };
  }

  // Unrecognised features are DROPPED rather than rejected, matching how the
  // park profile handles utilities: a stale value from an older client should
  // not block an owner from saving a lot. The database allowlist is the real
  // guard, and it exists because free text on a housing listing is where a
  // fair-housing problem gets typed.
  const features = (input.features ?? []).filter((f) => FEATURES.includes(f));

  return {
    ok: true,
    row: {
      tier,
      features,
      ...season.row,
      lot_number: lotNumber,
      site_type: input.siteType,
      max_length_ft: maxLengthFt,
      amperage,
      has_water: input.hasWater,
      has_sewer: input.hasSewer,
      slip_included: input.slipIncluded,
      notes: notes || null,
      active: input.active,
    },
  };
}

/**
 * A lot's own season, from two "MM-DD" strings.
 *
 * HALF A SEASON IS WORSE THAN NONE — an open date with no close reads as
 * year-round and quietly sells a slip in February — so it is both or neither,
 * and the database holds the same line.
 */
export interface LotSeasonRow {
  season_open_month: number | null;
  season_open_day: number | null;
  season_close_month: number | null;
  season_close_day: number | null;
}

export function parseLotSeason(
  open: string | undefined,
  close: string | undefined,
): { ok: boolean; error?: string; row: LotSeasonRow } {
  const blankRow: LotSeasonRow = {
    season_open_month: null, season_open_day: null,
    season_close_month: null, season_close_day: null,
  };
  const o = (open ?? "").trim();
  const c = (close ?? "").trim();
  if (!o && !c) return { ok: true, row: blankRow };
  if (!o || !c) {
    return { ok: false, error: "Give the season both an opening and a closing date, or leave both blank.", row: blankRow };
  }

  const parse = (v: string) => {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(v);
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { month, day };
  };

  const po = parse(o);
  const pc = parse(c);
  if (!po || !pc) {
    return { ok: false, error: "Season dates look like MM-DD — 04-01 for April 1st.", row: blankRow };
  }

  return {
    ok: true,
    row: {
      season_open_month: po.month, season_open_day: po.day,
      season_close_month: pc.month, season_close_day: pc.day,
    },
  };
}

// ----------------------------------------------------- the lot generator ---

export interface LotRangeInput {
  /** Optional leading text: "A" gives A1, A2, A3. */
  prefix: string;
  from: string;
  to: string;
  siteType: string;
  /** Applied to every lot in the range; individuals get edited afterwards. */
  maxLengthFt: string;
  amperage: string;
  /** Applied to every lot in the range — a row of premium waterfront sites is
   *  one action, not seventy-nine. */
  tier?: string;
}

export interface LotRangeResult {
  ok: boolean;
  error?: string;
  /** Ready to insert, minus park_id. NonNullable so callers do not have to
   *  narrow every element — a row that failed validation aborts the whole
   *  range instead of landing here as undefined. */
  rows?: NonNullable<ReturnType<typeof buildLotRow>["row"]>[];
  /** Lot numbers that already exist and were skipped, so the owner is told
   *  rather than hitting a unique-violation wall. */
  skipped?: string[];
}

/** Hard ceiling. Not a business rule — a fat-finger guard. Typing 1 to 7900
 *  instead of 1 to 79 should be a sentence, not ninety seconds of inserts and
 *  a park nobody can scroll. */
export const MAX_LOTS_PER_RANGE = 500;

/**
 * Make a whole park's worth of lots in one go.
 *
 * THE PROBLEM THIS SOLVES. The importer's join key is `park_lots.lot_number`,
 * and on closing morning that table is EMPTY. Without this, an owner adds lots
 * one form at a time — five interactions and a page refresh, seventy-nine
 * times — before the importer has anything to import into. Tested on a real
 * owner, that is where they quit: at lot 22, having never reached the part
 * that helps them.
 *
 * Existing lot numbers are SKIPPED, not rejected. Re-running "1 to 79" after
 * adding lot 80 by hand should quietly do nothing rather than fail on the
 * first collision and leave the park half-built.
 */
export function buildLotRange(input: LotRangeInput, existingLotNumbers: string[] = []): LotRangeResult {
  const prefix = input.prefix.trim();
  if (prefix.length > 8) return { ok: false, error: "That prefix is too long — 8 characters max." };

  const from = Number(input.from.trim());
  const to = Number(input.to.trim());
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return { ok: false, error: "Give a first and last lot number, like 1 and 79." };
  }
  if (from < 0 || to < 0) return { ok: false, error: "Lot numbers can't be negative." };
  if (to < from) return { ok: false, error: "The last lot number needs to be bigger than the first." };

  const count = to - from + 1;
  if (count > MAX_LOTS_PER_RANGE) {
    return {
      ok: false,
      error: `That would make ${count.toLocaleString()} lots. Did you mean a smaller range? (${MAX_LOTS_PER_RANGE} at a time is the limit.)`,
    };
  }

  if (!SITE_TYPES.includes(input.siteType)) {
    return { ok: false, error: "Pick what kind of sites these are." };
  }
  const defaults = SITE_DEFAULTS[input.siteType] ?? { hasWater: true, hasSewer: false };

  const existing = new Set(existingLotNumbers.map((n) => n.trim()));
  const rows: NonNullable<ReturnType<typeof buildLotRow>["row"]>[] = [];
  const skipped: string[] = [];

  for (let n = from; n <= to; n++) {
    const lotNumber = `${prefix}${n}`;
    if (existing.has(lotNumber)) { skipped.push(lotNumber); continue; }

    // Each row goes through the SAME validator a hand-typed lot does. If the
    // generator could produce a row the form would reject, the two paths would
    // drift and only one of them would be right.
    const built = buildLotRow({
      lotNumber,
      siteType: input.siteType,
      maxLengthFt: input.maxLengthFt,
      amperage: input.amperage,
      hasWater: defaults.hasWater,
      hasSewer: defaults.hasSewer,
      slipIncluded: false,
      notes: "",
      active: true,
      tier: input.tier,
    });
    if (!built.ok || !built.row) {
      return { ok: false, error: built.error };
    }
    rows.push(built.row);
  }

  if (rows.length === 0) {
    return { ok: false, error: "Every lot in that range already exists.", skipped };
  }
  return { ok: true, rows, skipped };
}

// ------------------------------------------------------ bulk rate card -----

export interface BulkRateTarget {
  lotId: string;
  siteType: string;
  tier?: string;
  /** How many priced terms this lot already has. */
  existingRateCount: number;
}

export interface BulkRatePlan {
  ok: boolean;
  error?: string;
  /** Lots that will get the card. */
  lotIds?: string[];
  /** Lots deliberately left alone because they already have rates. */
  skippedPriced?: number;
  /** Lots outside the chosen site type. */
  skippedType?: number;
  rows?: { term: Term; amount: number }[];
}

/**
 * Price a whole park in one action.
 *
 * The generator solved "79 lots, one form". This solves the identical problem
 * one step later: without it, setting rates means opening a panel per lot,
 * seventy-nine times, which is the same wall the owner already quit at.
 *
 * DEFAULT IS FILL, NOT OVERWRITE. A bulk write that clobbers rates the owner
 * tuned lot by lot is unrecoverable — there is no undo on a rate card, and the
 * damage is silent until a renter is quoted the wrong number. So lots that
 * already have a price are SKIPPED and counted, and replacing them is a
 * separate, deliberate choice.
 */
export function planBulkRates(
  targets: BulkRateTarget[],
  rates: Record<string, string>,
  opts: { siteType?: string; tier?: string; replaceExisting?: boolean } = {},
): BulkRatePlan {
  const built = buildRateRows(rates);
  if (!built.ok || !built.rows) return { ok: false, error: built.error };
  if (built.rows.length === 0) {
    return { ok: false, error: "Fill in at least one rate before applying it." };
  }

  let skippedType = 0;
  let skippedPriced = 0;
  const lotIds: string[] = [];

  for (const t of targets) {
    if (opts.siteType && t.siteType !== opts.siteType) { skippedType++; continue; }
    // Premium exists precisely so it can be priced differently; scoping by it
    // is the second-most useful axis after site type.
    if (opts.tier && (t.tier ?? "standard") !== opts.tier) { skippedType++; continue; }
    if (!opts.replaceExisting && t.existingRateCount > 0) { skippedPriced++; continue; }
    lotIds.push(t.lotId);
  }

  if (lotIds.length === 0) {
    return {
      ok: false,
      error: skippedPriced > 0
        ? "Every one of those lots already has rates. Tick “replace existing” if you meant to change them."
        : "No lots match that.",
      skippedPriced,
      skippedType,
    };
  }
  return { ok: true, lotIds, skippedPriced, skippedType, rows: built.rows };
}

// ------------------------------------------------- the sitting tenant -----

export interface TenantInput {
  displayName: string;
  /** The park-scoped number. No account needed — this is what buys her rent
   *  receipts and freeze warnings without installing anything. */
  mobile: string;
  email: string;
  /** Blank means "already here", which is the common case. */
  movedInOn: string;
  term: string;
  rent: string;
  /** Where the fact came from, so the roll can later show its work. */
  source: string;
}

export interface TenantResult {
  ok: boolean;
  error?: string;
  renter?: {
    display_name: string;
    mobile_e164: string | null;
    email: string | null;
    contact_pref: string;
    source: string;
  };
  tenancy?: { start: string; end: string; term: Term; quoted_amount: number | null };
}

const TENANT_SOURCES = ["seller_roll", "owner_knowledge", "tenant_confirmed", "document"];

/**
 * How far out a sitting tenancy is written.
 *
 * UNBOUNDED RANGES ARE FORBIDDEN (phase 2 design §1h) and the reasoning is
 * load-bearing: parseDaterange returns null for `[2019-05-01,)`, a null range
 * makes coversDay false, and THE RENT ROLL WOULD REPORT THE LOT VACANT WHILE
 * SOMEONE IS LIVING ON IT. His park is full of exactly this shape. An unbounded
 * row would also block the lot forever under the exclusion constraint —
 * including for that same renter's next term.
 *
 * So month-to-month is a rolling finite range. A year is long enough that
 * nobody trips over it and short enough to force an annual touch, which is
 * where renewal and compliance live anyway.
 */
export const TENANCY_HORIZON_DAYS = 365;

/** Add days to an ISO date without touching local time. */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Shape a tenant the park owner types in — the person who was already living
 * there when he bought the place.
 *
 * NEVER ASKS FOR A MOVE-OUT DATE. He does not have one, the tenant does not
 * have one, and demanding it is how an import becomes a three-hour session.
 * The finite range is written silently.
 *
 * The ONLY required field is a name. Everything else can arrive later — a rent
 * roll that holds a name and a lot is already more than a notebook, and a form
 * that demands rent and a date before it will save anything is a form that
 * gets abandoned at lot 9.
 */
export function buildTenant(
  input: TenantInput,
  todayISO: string,
  /**
   * The park's agreement cap, when it has one.
   *
   * WITHOUT THIS, TURNING THE CAP ON BREAKS ADDING A TENANT. The silent range
   * written below used to be a flat 365 days, while 0062's trigger refuses
   * anything longer than `cap * 31 + 1` — so the moment the owner sets his
   * three-month rule, every "add a tenant" failed on a database trigger and
   * surfaced as "Couldn't put them on that lot — try again."
   *
   * A cap is a statement about how long ONE agreement runs, not about how long
   * somebody may stay. So it shortens the range; it never refuses the person.
   */
  maxAgreementMonths: number | null = null,
): TenantResult {
  const displayName = input.displayName.trim();
  if (!displayName) return { ok: false, error: "Who lives here? A name is enough to start." };
  if (displayName.length > 120) return { ok: false, error: "That name is too long." };

  const source = input.source.trim() || "owner_knowledge";
  if (!TENANT_SOURCES.includes(source)) {
    return { ok: false, error: "Where did this come from?" };
  }

  // A blank move-in date means "already here", which is the common case and a
  // true answer. Today is the honest stand-in: it says when the RECORD starts,
  // not when the person did.
  const start = input.movedInOn.trim() || todayISO;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return { ok: false, error: "That move-in date doesn't look right." };
  }
  if (start > todayISO) {
    return { ok: false, error: "That move-in date is in the future — use the booking flow for someone arriving later." };
  }

  const term = (input.term.trim() || "monthly") as Term;
  if (!["nightly", "weekly", "monthly", "seasonal", "annual"].includes(term)) {
    return { ok: false, error: "Pick how they pay — usually monthly." };
  }

  let quoted: number | null = null;
  const rawRent = input.rent.trim();
  if (rawRent) {
    const n = Number(rawRent.replace(/[$,]/g, ""));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Rent needs to be a dollar amount." };
    if (n > 100_000) return { ok: false, error: "That rent looks like a typo." };
    quoted = Math.round(n * 100) / 100;
  }

  const mobile = input.mobile.replace(/[^0-9+]/g, "");
  if (mobile && mobile.replace(/\D/g, "").length < 10) {
    return { ok: false, error: "That phone number looks short." };
  }

  const email = input.email.trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "That email doesn't look right." };
  }

  return {
    ok: true,
    renter: {
      display_name: displayName,
      mobile_e164: mobile || null,
      email: email || null,
      // PAPER, ALWAYS, until THEY say otherwise.
      //
      // This used to be `mobile ? "sms" : "paper"` — so typing in a number the
      // owner read off a seller's roll silently marked that household as
      // wanting texts, and a nightly job then texted them. A number somebody
      // else wrote down is not consent from the person it belongs to. The
      // preference changes when the renter changes it, never as a side effect
      // of the office having a phone number.
      contact_pref: "paper",
      source,
    },
    tenancy: {
      start,
      // The cap when there is one, the horizon when there is not. `addMonths`
      // clamps a short month properly — Jan 31 plus one month is Feb 28, not
      // an invalid date.
      end: maxAgreementMonths == null
        ? addDays(start, TENANCY_HORIZON_DAYS)
        : addMonths(start, maxAgreementMonths),
      term,
      quoted_amount: quoted,
    },
  };
}

// -------------------------------------------------------- park profile -----

export interface ParkProfileInput {
  name: string;
  address: string;
  parkType: string;
  ageRestricted: boolean;
  approvalRequired: boolean;
  seasonOpen: string;   // "MM-DD" or ""
  seasonClose: string;  // "MM-DD" or ""
  includedUtilities: string[];
  houseRules: string;
}

export interface ParkProfileResult {
  ok: boolean;
  error?: string;
  row?: {
    name: string;
    address: string | null;
    park_type: string;
    age_restricted: boolean;
    approval_required: boolean;
    season_open_month: number | null;
    season_open_day: number | null;
    season_close_month: number | null;
    season_close_day: number | null;
    included_utilities: string[];
    house_rules: string | null;
  };
}

const PARK_TYPES = ["mh", "rv", "mixed"];
const UTILITIES = ["water", "sewer", "electric", "trash", "wifi", "lawn", "snow"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** "MM-DD" -> [month, day], or null for blank. Throws nothing; returns
 *  undefined for malformed so the caller can say which field is wrong. */
function parseMonthDay(raw: string): [number, number] | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12) return undefined;
  // Feb 29 is allowed: a season boundary is a (month, day) pair, not a date in
  // any one year, and a park that opens Feb 29 in a leap year still opens.
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return undefined;
  return [month, day];
}

/**
 * The setup interview, validated. This is the park owner telling us how their
 * park runs — every answer becomes a dial, none becomes an assumption
 * (rule 8).
 */
export function buildParkProfileRow(input: ParkProfileInput): ParkProfileResult {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "What's the park called?" };
  if (name.length > 120) return { ok: false, error: "That name is too long (120 characters max)." };

  if (!PARK_TYPES.includes(input.parkType)) {
    return { ok: false, error: "Pick whether this is a mobile-home park, an RV park, or both." };
  }

  const open = parseMonthDay(input.seasonOpen);
  if (open === undefined) return { ok: false, error: "Season open date should look like 05-01 (month-day)." };
  const close = parseMonthDay(input.seasonClose);
  if (close === undefined) return { ok: false, error: "Season close date should look like 10-15 (month-day)." };

  // Both or neither. One half of a season is not a season, and the engine
  // reads "either is null" as year-round — so a half-filled answer would
  // silently mean the opposite of what the owner typed.
  if ((open && !close) || (!open && close)) {
    return { ok: false, error: "Give both an open and a close date, or leave both blank for year-round." };
  }

  const utilities = input.includedUtilities.filter((u) => UTILITIES.includes(u));

  const rules = input.houseRules.trim();
  if (rules.length > 4000) return { ok: false, error: "House rules are too long — keep it under 4,000 characters." };

  return {
    ok: true,
    row: {
      name,
      address: input.address.trim() || null,
      park_type: input.parkType,
      age_restricted: input.ageRestricted,
      approval_required: input.approvalRequired,
      season_open_month: open?.[0] ?? null,
      season_open_day: open?.[1] ?? null,
      season_close_month: close?.[0] ?? null,
      season_close_day: close?.[1] ?? null,
      included_utilities: utilities,
      house_rules: rules || null,
    },
  };
}

// ----------------------------------------------------------- park dials ----

/**
 * HOW THIS PARK RUNS — the numbers the rest of the module has been reading all
 * along and nothing has ever been able to write.
 *
 * Every one of these columns existed. `max_agreement_months` carries the
 * owner's three-month rule and is read by a database trigger (0062, 0065);
 * `rent_notice_days` gates every rent increase (0061); `rent_due_day` sets
 * every bill's due date; `office_recording_lag_days` decides who is called
 * late. Three of them sat on defaults and two sat on NULL, because the setup
 * form writes twelve columns and none of them are these.
 *
 * So the cap trigger was skipping — `cap_months is null` means "no cap" — and
 * the most explicitly stated rule in this whole project was enforced by
 * nothing. A rule the software knows about but cannot be told is worse than no
 * rule, because everyone assumes it is running.
 */
export interface ParkDialsInput {
  /** "" clears it — a park with no cap is legitimate. */
  maxAgreementMonths: string;
  depositAmount: string;
  rentDueDay: string;
  officeRecordingLagDays: string;
  rentNoticeDays: string;
  /** The day he takes over. "" until a contract says otherwise. */
  cutoverOn: string;
}

export interface ParkDialsResult {
  ok: boolean;
  error?: string;
  row?: Record<string, unknown>;
}

function wholeNumber(
  raw: string,
  label: string,
  min: number,
  max: number,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: `${label} needs to be a whole number.` };
  const n = Number(s);
  if (n < min || n > max) {
    return { ok: false, error: `${label} should be between ${min} and ${max}.` };
  }
  return { ok: true, value: n };
}

export function buildParkDialsRow(input: ParkDialsInput): ParkDialsResult {
  const cap = wholeNumber(input.maxAgreementMonths, "The agreement cap", 1, 120);
  if (!cap.ok) return { ok: false, error: cap.error };

  const due = wholeNumber(input.rentDueDay, "The rent due day", 1, 28);
  if (!due.ok) return { ok: false, error: due.error };

  const lag = wholeNumber(input.officeRecordingLagDays, "The catch-up window", 0, 30);
  if (!lag.ok) return { ok: false, error: lag.error };

  const notice = wholeNumber(input.rentNoticeDays, "The notice period", 0, 365);
  if (!notice.ok) return { ok: false, error: notice.error };

  let deposit: number | null = null;
  const rawDeposit = input.depositAmount.trim();
  if (rawDeposit) {
    const n = Number(rawDeposit.replace(/[$,]/g, ""));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "The deposit needs to be a dollar amount." };
    if (n > 100_000) return { ok: false, error: "That deposit looks like a typo." };
    deposit = Math.round(n * 100) / 100;
  }

  const cutover = input.cutoverOn.trim();
  if (cutover && !/^\d{4}-\d{2}-\d{2}$/.test(cutover)) {
    return { ok: false, error: "That takeover date doesn't look right." };
  }

  // NOT NULL columns with defaults keep their default rather than being
  // nulled — clearing the box means "leave it alone", not "have no due day".
  const row: Record<string, unknown> = {
    max_agreement_months: cap.value,
    deposit_amount: deposit,
    cutover_date: cutover || null,
  };
  if (due.value != null) row.rent_due_day = due.value;
  if (lag.value != null) row.office_recording_lag_days = lag.value;
  if (notice.value != null) row.rent_notice_days = notice.value;

  return { ok: true, row };
}

/**
 * WHAT A NOTICE PERIOD ACTUALLY COSTS YOU, in dates rather than a number.
 *
 * "45 days" is abstract and unarguable. "Tell them by Aug 26 for a rent that
 * starts Oct 10" is a thing he can hold against his own calendar, and it is the
 * only honest way to answer "is 45 too long?" — the answer depends entirely on
 * how it lands against the agreement cycle.
 *
 * THE INTERACTION THAT MATTERS: inside a fixed agreement the rent is the rent.
 * A cap of three months means increases land at renewal, roughly every 90 days,
 * so a 45-day notice is served around the halfway point of the current term and
 * costs nothing at all. It only bites on month-to-month tenancies — which at
 * The Haven is the nineteen grandfathered households, and that is exactly the
 * group facing the largest increase.
 */
export function noticeShape(
  noticeDays: number,
  capMonths: number | null,
  todayISO: string,
): { earliest: string; line: string; fitsInTerm: boolean } {
  const earliest = addDays(todayISO, noticeDays);
  const termDays = capMonths == null ? null : capMonths * 30;
  const fitsInTerm = termDays == null ? true : noticeDays <= termDays;

  const base =
    `If you told everyone today, the earliest a new rent could start is ` +
    `${earliest}.`;

  if (termDays == null) {
    return { earliest, fitsInTerm, line: base };
  }
  if (fitsInTerm) {
    return {
      earliest,
      fitsInTerm,
      line:
        `${base} With ${capMonths}-month agreements that sits inside the term, ` +
        `so increases land at renewal and this costs you nothing. It only bites ` +
        `on month-to-month households.`,
    };
  }
  return {
    earliest,
    fitsInTerm,
    line:
      `${base} That is LONGER than a ${capMonths}-month agreement, so you could ` +
      `never raise a rent within one term — every increase would slip a whole ` +
      `cycle.`,
  };
}

/**
 * What setting a cap actually does to the roll, said before he saves.
 *
 * The cap is enforced by a trigger, so an existing tenancy longer than the new
 * cap is not rewritten — it is simply refused the next time anything touches
 * it. He should hear that from a sentence, not from a failed edit weeks later.
 */
export function dialsWarning(
  capMonths: number | null,
  longestExistingStayDays: number | null,
): string | null {
  if (capMonths == null || longestExistingStayDays == null) return null;
  const capDays = capMonths * 31 + 1;
  if (longestExistingStayDays <= capDays) return null;
  return (
    `Some tenancies on your roll already run longer than ${capMonths} ` +
    `${capMonths === 1 ? "month" : "months"}. They stay exactly as they are — ` +
    `the cap applies to agreements you write from now on.`
  );
}

// --------------------------------------------------------- rate parsing ----

const TERMS: Term[] = ["nightly", "weekly", "monthly", "seasonal", "annual"];

/**
 * The park's rate card, from the owner's form. A blank is "we don't sell that
 * term" and is DROPPED, not stored as 0 — quoteStay returns null for a term
 * with no card, which is the honest answer, while a stored 0 would quote a
 * free stay.
 */
export function buildRateRows(
  input: Record<string, string>,
): { ok: boolean; error?: string; rows?: { term: Term; amount: number }[] } {
  const rows: { term: Term; amount: number }[] = [];
  for (const term of TERMS) {
    const raw = (input[term] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw.replace(/[$,]/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `The ${term} rate needs to be a dollar amount.` };
    }
    if (n === 0) continue; // blank and zero mean the same thing: not for sale
    if (n > 100_000) return { ok: false, error: `That ${term} rate looks like a typo.` };
    rows.push({ term, amount: Math.round(n * 100) / 100 });
  }
  return { ok: true, rows };
}

/** What the owner would collect for a stay, using their own card. Null when
 *  they don't sell that term — the UI says "not offered", never "$0". */
export function previewStayValue(
  rates: RateCard[],
  term: Term,
  range: DateRange | null,
): number | null {
  if (!range) return null;
  return quoteStay(rates, term, range);
}

// ------------------------------------------------------- editing a tenant ---

/**
 * Correcting a tenant already on the roll.
 *
 * WHY THIS EXISTS, beyond fixing a typo. The importer writes 79 names straight
 * off a seller's spreadsheet and the receipt tells him the truth about them:
 *
 *   $9,965  expected each month
 *       $0  confirmed by tenants
 *   $9,965  from the seller's roll only
 *
 *   "As you confirm them at the window over the next month, this splits."
 *
 * Nothing could make that split happen. `amount_source` went in as
 * 'seller_roll' and there was no path to any other value, so the bottom line
 * would have read $9,965 forever and the promise on the receipt was one the
 * software could not keep. This is that path.
 */
export interface TenantEditInput {
  displayName: string;
  rent: string;
  dueDay: string;
  /** He has stood in front of this person and checked the number. */
  confirmedWithTenant: boolean;
}

export interface TenantEditResult {
  ok: boolean;
  error?: string;
  renter?: { display_name: string; confirmed_at: string | null };
  tenancy?: {
    quoted_amount: number | null;
    due_day: number | null;
    /** Only set when the amount actually MOVED. */
    amount_source?: string;
  };
}

/**
 * The rent's provenance follows who last touched it, and it is never upgraded
 * for free:
 *
 *   he retyped it            -> 'owner_knowledge'   (better than the seller)
 *   he confirmed it with her -> 'tenant_confirmed'  (the only one that counts)
 *   he changed neither       -> left exactly as it was
 *
 * That last line is the important one. Opening a row, changing the spelling of
 * a name and saving must NOT promote a seller's number to a confirmed one —
 * otherwise the "still exposed on" figure decays to zero by accident and the
 * one honest number on the rent roll becomes decorative.
 */
export function buildTenantEdit(
  input: TenantEditInput,
  current: { rent: number | null; dueDay: number | null },
  todayISO: string,
): TenantEditResult {
  const displayName = input.displayName.trim();
  if (!displayName) return { ok: false, error: "A tenant needs a name." };
  if (displayName.length > 120) return { ok: false, error: "That name is too long." };

  const rentRaw = input.rent.trim();
  let quoted: number | null = current.rent;
  if (rentRaw === "") {
    // Clearing a rent is legitimate — "I don't actually know what she pays" is
    // a truer state than a number he made up.
    quoted = null;
  } else {
    const n = Number(rentRaw.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n)) return { ok: false, error: "That rent isn't a number." };
    if (n < 0) return { ok: false, error: "A rent can't be negative." };
    if (n > 100000) return { ok: false, error: "That rent looks like a typo." };
    quoted = Math.round(n * 100) / 100;
  }

  const dayRaw = input.dueDay.trim();
  let dueDay: number | null = current.dueDay;
  if (dayRaw === "") {
    dueDay = null;
  } else {
    const d = Number(dayRaw);
    if (!Number.isInteger(d) || d < 1 || d > 31) {
      return { ok: false, error: "Rent is due on a day between 1 and 31." };
    }
    dueDay = d;
  }

  const amountMoved = quoted !== current.rent;

  const tenancy: TenantEditResult["tenancy"] = { quoted_amount: quoted, due_day: dueDay };
  if (input.confirmedWithTenant) {
    // The only value that reduces what he is exposed on. Requires him to say
    // he checked, and applies whether or not the number changed — confirming
    // that the seller was RIGHT is exactly as valuable as correcting him.
    tenancy.amount_source = "tenant_confirmed";
  } else if (amountMoved) {
    tenancy.amount_source = "owner_knowledge";
  }

  return {
    ok: true,
    renter: {
      display_name: displayName,
      confirmed_at: input.confirmedWithTenant ? todayISO : null,
    },
    tenancy,
  };
}
