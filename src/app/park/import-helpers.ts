import {
  overlaps,
  type DateRange,
  type Term,
} from "@/lib/parks";
import type { ParsedRow } from "@/lib/roll-parse";

/**
 * THE PLAN — everything the commit will do, decided before a single write.
 *
 * Pure, so it is tested without a database, and so the screen and the commit
 * cannot disagree about what is about to happen. The screen renders this; the
 * commit executes this; nothing else decides anything.
 *
 * The point of planning ahead is the exclusion constraint. `lot_no_double_booking`
 * (0052) will refuse an overlapping tenancy and there is no talking it out of
 * that. Catching a collision here means the owner reads a sentence with a name
 * in it; catching it at write time means he reads "23P01". We do both, because
 * he may have approved an application in another tab thirty seconds ago — but
 * this is the one that produces an explanation.
 */

// --------------------------------------------------------------- blockers ---

/**
 * A closed union, each with a plain-English sentence — the `decideProblemText`
 * convention. A blocker means "this row will not be written", never "this row
 * is bad". Most of them are questions we are refusing to answer for him.
 */
export type ImportBlocker =
  | "no_name"
  | "no_lot"
  | "lot_unknown"
  | "lot_ambiguous"
  | "lot_taken"
  | "lot_twice_in_paste"
  | "label_too_long"
  | "bad_amount"
  | "no_season";

export function importBlockerText(b: ImportBlocker, lotLabel?: string): string {
  const lot = lotLabel ? `Lot ${lotLabel}` : "This row";
  switch (b) {
    case "no_name":
      return `${lot} needs a name. We won't file a placeholder as a person.`;
    case "no_lot":
      return "We couldn't tell which lot this line is about.";
    case "lot_unknown":
      return `You don't have a lot called ${lotLabel ?? "that"} yet.`;
    case "lot_ambiguous":
      return "More than one of your lots could be the one on this line.";
    case "lot_taken":
      return `Somebody's already on ${lot.toLowerCase()} for those dates. Nothing was changed there.`;
    case "lot_twice_in_paste":
      return `Two people are listed on ${lot.toLowerCase()}. We hold one tenancy on a lot at a time — who lives there now?`;
    case "label_too_long":
      return "That lot name is too long to be a lot name.";
    case "bad_amount":
      return "We read a rent on this line but couldn't turn it into a number.";
    case "no_season":
      return "This is a seasonal tenancy and the park has no season set, so we don't know the dates.";
  }
}

// ------------------------------------------------------------- lot labels ---

/** Longer than this is a sentence someone pasted, not a lot number. */
export const MAX_LOT_LABEL = 12;

/**
 * Match a pasted label against REAL INVENTORY, once, in one place.
 *
 * Loose enough to survive the ways people write the same lot ("7", "07",
 * "Lot 7", "#7", "7 "), strict enough that it never invents a lot. Returns the
 * REAL lot_number as it exists in the database — never the pasted spelling —
 * so everything downstream joins on one string.
 *
 * Returns null when there is no match, and null is a question for the owner,
 * not a licence to create.
 */
export function normaliseLotLabel(
  raw: string | null | undefined,
  realLots: readonly string[],
): string | null {
  if (!raw) return null;
  const key = (s: string) =>
    s
      .toLowerCase()
      .replace(/^(lot|site|space|unit|stall|pad)\b/, "")
      .replace(/[^a-z0-9]/g, "");

  const k = key(raw);
  if (!k) return null;

  // Exact first — the common case, and it must never be beaten by a fuzzy hit.
  for (const real of realLots) if (key(real) === k) return real;

  // Then leading-zero equivalence, numeric part only: "07" is "7". Deliberately
  // NOT a general fuzzy match — "12A" must never resolve to "12".
  const num = (s: string) => {
    const m = /^0*(\d+)$/.exec(s);
    return m ? m[1] : null;
  };
  const n = num(k);
  if (n) for (const real of realLots) if (num(key(real)) === n) return real;

  return null;
}

/**
 * A raw cell the parser declined to match, kept only when it actually looks
 * like a lot label. "34B" becomes a lot he can create; "son living in home"
 * does not, and must fall through to `no_lot` rather than becoming a lot named
 * after a sentence.
 */
function readableLabel(raw: string): string | null {
  const s = (raw ?? "").trim().replace(/^#\s*/, "").replace(/\s+/g, "");
  if (!s) return null;
  // Deliberately NOT length-capped here. Something label-SHAPED but absurdly
  // long should reach the plan and be refused by name ("that lot name is too
  // long"), not vanish into the vaguer "we couldn't tell which lot this is".
  return /^[A-Za-z]{0,3}-?\d{1,20}[A-Za-z]?$/.test(s) ? s.toUpperCase() : null;
}

// ----------------------------------------------------------------- ranges ---

export interface SeasonWindow {
  start: string;
  end: string;
}

/**
 * The date range a grandfathered tenancy gets.
 *
 * The database needs a finite range; nobody's actual move-in date is known and
 * we never invent one (that is what `tenancy_began_on` is for). So every
 * tenancy starts at the CUTOVER — the day the park changed hands, the one date
 * that is actually true — and runs a year, matching the rolling horizon the
 * extend mechanism already rolls forward.
 *
 * Seasonal is the exception: a season has real dates, and if the park has not
 * configured one we return null and HOLD THE ROW rather than guess. A guessed
 * season window is a lot that reads vacant all winter with somebody living on it.
 */
export function rangeForTerm(
  term: Term,
  cutoverISO: string,
  season: SeasonWindow | null,
): DateRange | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoverISO)) return null;

  if (term === "seasonal") {
    if (!season) return null;
    return { start: season.start, end: season.end };
  }

  return { start: cutoverISO, end: addYear(cutoverISO) };
}

/** One year on, calendar-correctly, with Feb 29 landing on Mar 1. */
function addYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y + 1, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

// ------------------------------------------------------------- the plan -----

export interface PlannedRow {
  /** 1-based source lines. A wrapped row carries more than one. */
  lines: number[];
  /** The first source line — what `park_import_rows.line_no` keys on. */
  lineNo: number;
  source: string[];
  /** The REAL lot number, resolved against inventory — or the raw label. */
  lotLabel: string | null;
  /** Set when this label matched a lot that already exists. */
  matchedLotId: string | null;
  /** True when committing this row will create the lot. */
  createsLot: boolean;
  name: string | null;
  amount: number | null;
  term: Term;
  range: DateRange | null;
  /** Why this row will not be written. Empty means it will. */
  blockers: ImportBlocker[];
  /** True things worth saying, that stop nothing. */
  flags: string[];
  /** Kept verbatim, read by no calculation. */
  notes: string[];
}

export interface ImportPlan {
  rows: PlannedRow[];
  /** Rows that will be written. */
  ready: PlannedRow[];
  /** Rows that need an answer first. */
  needsYou: PlannedRow[];
  /** Lot labels that do not exist yet and would be created. */
  lotsToCreate: string[];
  /** What the rent roll will say, if he commits exactly this. */
  monthlyTotal: number;
}

export interface ExistingLot {
  id: string;
  lotNumber: string;
}

export interface LiveStay {
  lotId: string;
  range: DateRange;
}

export interface PlanInput {
  rows: ParsedRow[];
  lots: readonly ExistingLot[];
  liveStays: readonly LiveStay[];
  cutoverISO: string;
  season: SeasonWindow | null;
  /** Labels the owner explicitly asked us to create. */
  approvedNewLots?: readonly string[];
}

/**
 * Turn parsed lines into an executable plan.
 *
 * Order matters: resolve every lot label FIRST, so the in-paste duplicate check
 * groups by the real lot rather than by the pasted spelling. "7" and "Lot 07"
 * on two lines are the same collision, and grouping by the raw text would miss
 * it — which is exactly how the prototype let both rows through and let the
 * database reject one at random.
 */
export function planImport(input: PlanInput): ImportPlan {
  const { rows, lots, liveStays, cutoverISO, season } = input;
  const realLabels = lots.map((l) => l.lotNumber);
  const byLabel = new Map(lots.map((l) => [l.lotNumber, l]));
  const approved = new Set(input.approvedNewLots ?? []);

  // ---- pass 1: resolve lots, so duplicates group by the REAL lot.
  //
  // `lot.value` is null when the parser read a label it could not find in
  // inventory — it refuses to match against a park that has no such lot. The
  // LABEL is still there in `lot.raw`, and we need it: "you don't have a lot
  // called 34B" is a question with an answer ("create it"), while "we couldn't
  // find a lot on this line" is a different question entirely. Collapsing the
  // two would offer him "create lot " with nothing after it.
  const resolved = rows.map((r) => {
    const rawLabel = r.lot.value ?? readableLabel(r.lot.raw);
    const real = normaliseLotLabel(rawLabel, realLabels);
    return { row: r, rawLabel, real };
  });

  const timesUsed = new Map<string, number>();
  for (const r of resolved) {
    const key = r.real ?? r.rawLabel;
    if (key) timesUsed.set(key, (timesUsed.get(key) ?? 0) + 1);
  }

  // ---- pass 2: plan each row.
  const planned: PlannedRow[] = resolved.map(({ row, rawLabel, real }) => {
    const blockers: ImportBlocker[] = [];
    const label = real ?? rawLabel;
    const term = (row.term.value ?? "monthly") as Term;
    const range = rangeForTerm(term, cutoverISO, season);

    if (!label) blockers.push("no_lot");
    else if (label.length > MAX_LOT_LABEL) blockers.push("label_too_long");

    if (!row.name.value) blockers.push("no_name");

    // A lot we do not have. NOT an error — people rent two things, and a
    // storage row for lot 34B is a real row. It is a question, and it stops
    // being one the moment he says "create it".
    if (label && !real && !approved.has(label)) blockers.push("lot_unknown");

    // Two rows on one lot: the common real shape is a mid-year turnover, and
    // the answer is a question, not a rejection.
    if (label && (timesUsed.get(label) ?? 0) > 1) blockers.push("lot_twice_in_paste");

    // Present-and-refused is NOT absent. Absent rent is fine forever; a rent we
    // read and could not convert must stop the row, or "4l0.00" imports as no
    // rent at all and $410 quietly vanishes from the roll.
    if (row.rent.confidence === "unknown" && row.rent.raw.trim() !== "") {
      blockers.push("bad_amount");
    }

    if (term === "seasonal" && !range) blockers.push("no_season");

    // The parser found more than one lot this line could mean. Picking one is
    // a coin flip that puts a family on a stranger's lot.
    if ((row.lot.candidates?.length ?? 0) > 1) blockers.push("lot_ambiguous");

    // Against tenancies that ALREADY EXIST — the other tab, thirty seconds ago.
    const lotId = real ? (byLabel.get(real)?.id ?? null) : null;
    if (lotId && range) {
      const clash = liveStays.some((s) => s.lotId === lotId && overlaps(s.range, range));
      if (clash) blockers.push("lot_taken");
    }

    return {
      lines: [...row.lines],
      lineNo: row.lines[0],
      source: [...row.source],
      lotLabel: label,
      matchedLotId: lotId,
      createsLot: Boolean(label) && !real,
      name: row.name.value,
      amount: row.rent.value,
      term,
      range,
      blockers,
      // The parser's own reasons, carried verbatim. They are already sentences.
      flags: [...row.askReasons],
      notes: [...row.notes],
    };
  });

  const ready = planned.filter((p) => p.blockers.length === 0);
  const needsYou = planned.filter((p) => p.blockers.length > 0);

  const lotsToCreate = [
    ...new Set(ready.filter((p) => p.createsLot && p.lotLabel).map((p) => p.lotLabel!)),
  ];

  // Only monthly rows, only rows that will actually be written. Adding a season
  // to a week to a month produces a number that means nothing, and the screen
  // says so rather than printing it.
  const monthlyTotal = ready
    .filter((p) => p.term === "monthly" && p.amount != null)
    .reduce((sum, p) => sum + p.amount!, 0);

  return { rows: planned, ready, needsYou, lotsToCreate, monthlyTotal };
}

// ------------------------------------------------------------- the money ----

export interface CadenceTotals {
  byTerm: { term: Term; count: number; total: number }[];
  /** True when more than one cadence is present — no single number is honest. */
  mixed: boolean;
}

/**
 * What he actually collects, split by cadence.
 *
 * A grand total across cadences is the number every other platform prints and
 * it is meaningless — it adds four whole seasons to one month and one week.
 * This returns the parts and lets the screen refuse to sum them.
 */
export function cadenceTotals(rows: readonly PlannedRow[]): CadenceTotals {
  const map = new Map<Term, { count: number; total: number }>();
  for (const r of rows) {
    if (r.amount == null) continue;
    const cur = map.get(r.term) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += r.amount;
    map.set(r.term, cur);
  }
  const byTerm = [...map.entries()].map(([term, v]) => ({ term, ...v }));
  return { byTerm, mixed: byTerm.length > 1 };
}

/**
 * Reconcile the seller's own totals row against his own rows.
 *
 * When it ties, that proves his spreadsheet adds up and NOTHING MORE — not that
 * the rents are right. The screen says exactly that. When it does not tie, the
 * gap is often precisely one missing rent, and pointing at that lot is the most
 * useful thing on the page.
 */
export interface TotalsCheck {
  stated: number;
  computed: number;
  difference: number;
  ties: boolean;
  /** Lots with no amount — when the gap is one lot's rent, this is the culprit. */
  lotsWithNoAmount: string[];
}

export function checkTotals(
  stated: number | null,
  rows: readonly PlannedRow[],
): TotalsCheck | null {
  if (stated == null) return null;
  const computed = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const difference = Math.round((stated - computed) * 100) / 100;
  return {
    stated,
    computed,
    difference,
    ties: Math.abs(difference) < 0.005,
    lotsWithNoAmount: rows.filter((r) => r.amount == null && r.lotLabel).map((r) => r.lotLabel!),
  };
}
