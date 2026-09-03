import {
  overlaps,
  type DateRange,
  type Term,
} from "@/lib/parks";
import { parseLot } from "@/lib/roll-parse";
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
  /**
   * ADDRESSES OF RECORD, carried through so the office does not retype them.
   * Neither is permission: the email is stored and only ever used for the one
   * invite the owner chooses to send, and the phone goes to
   * `phone_on_file_with_park`, which nothing in the app can send to.
   */
  email: string | null;
  phone: string | null;
  amount: number | null;
  term: Term;
  range: DateRange | null;
  /** He decided to leave this one out. Not a failure — an answer. */
  skipped: boolean;
  /** Why this row will not be written. Empty means it will. */
  blockers: ImportBlocker[];
  /** True things worth saying, that stop nothing. */
  flags: string[];
  /** Kept verbatim, read by no calculation. */
  notes: string[];
}

/** A lot and what it rents for, with nobody attached. */
export interface PlannedRate {
  lineNo: number;
  lotLabel: string;
  amount: number | null;
  createsLot: boolean;
}

export interface ImportPlan {
  rows: PlannedRow[];
  /** Rows that will be written. */
  ready: PlannedRow[];
  /** Rows that need an answer first. */
  needsYou: PlannedRow[];
  /** Lot labels that do not exist yet and would be created. */
  lotsToCreate: string[];
  /** The pads the roll named but did not bill, and whether each exists yet. */
  emptyLots?: EmptyLot[];
  /** What the rent roll will say, if he commits exactly this. */
  monthlyTotal: number;
  /**
   * Set when the sheet named nobody. `ready` and `needsYou` are both empty in
   * this mode — there are no tenancies to write — and `rates` carries the whole
   * import instead.
   */
  namelessRoll: boolean;
  rates: PlannedRate[];
}

export interface ExistingLot {
  id: string;
  lotNumber: string;
}

export interface LiveStay {
  lotId: string;
  range: DateRange;
}

/**
 * What he answered on the screen. Stored beside the parse, never over it —
 * what we proposed and what he confirmed are different facts, and the
 * difference is the provenance.
 */
export interface RowOverride {
  /** A name he typed for a row we refused to guess at. */
  name?: string;
  /** A rent he typed. `null` means "there isn't one", which is legitimate. */
  rent?: number | null;
  /** Leave this row out entirely. A real answer, not a failure. */
  skip?: boolean;
  /** Create the lot this row names. */
  createLot?: string;
  /** Of the rows claiming one lot, this is the one who lives there now. */
  current?: boolean;
}

export interface PlanInput {
  rows: ParsedRow[];
  lots: readonly ExistingLot[];
  liveStays: readonly LiveStay[];
  cutoverISO: string;
  season: SeasonWindow | null;
  /** Labels the owner explicitly asked us to create. */
  approvedNewLots?: readonly string[];
  /** Keyed by the row's first source line. */
  overrides?: Record<number, RowOverride>;
  /**
   * The sheet has no name column at all. Then this is an INVENTORY import: we
   * set up lots and what each one currently rents for, and we record nobody as
   * living anywhere, because the list does not say who does.
   */
  namelessRoll?: boolean;
  /**
   * EMPTY LOTS THE SHEET NAMES — declared vacant, or implied by a gap in the
   * numbering. They become real lots with nobody on them.
   *
   * They used to be recorded as import NOTES and nothing else, so The Haven
   * imported as 19 lots instead of 21 and the two empties did not exist. That
   * makes them invisible to the thing they matter most to: a cost is divided
   * by every RENTABLE lot, and the park carries the empties. A lot that was
   * never created cannot be carried, so the whole rule silently did nothing.
   */
  emptyLots?: readonly EmptyLot[];
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
  const overrides = input.overrides ?? {};
  const resolved = rows.map((r) => {
    const o = overrides[r.lines[0]] ?? {};
    const rawLabel = r.lot.value ?? o.createLot ?? readableLabel(r.lot.raw);
    const real = normaliseLotLabel(rawLabel, realLabels);
    return { row: r, rawLabel, real, o };
  });

  // ---- which rows are OUT. Two ways: he said skip, or he picked somebody
  // else as the current tenant of a lot two rows both claimed.
  const currentByLot = new Map<string, number>();
  for (const r of resolved) {
    const key = r.real ?? r.rawLabel;
    if (key && r.o.current) currentByLot.set(key, r.row.lines[0]);
  }

  const isSkipped = (r: (typeof resolved)[number]) => {
    if (r.o.skip) return true;
    const key = r.real ?? r.rawLabel;
    const winner = key ? currentByLot.get(key) : undefined;
    // Somebody else on this lot was named current, so this row steps aside.
    return winner != null && winner !== r.row.lines[0];
  };

  // Counted AFTER skips, so answering "Fry lives there now" actually unblocks
  // Fry's row instead of leaving both of them stuck forever.
  const timesUsed = new Map<string, number>();
  for (const r of resolved) {
    if (isSkipped(r)) continue;
    const key = r.real ?? r.rawLabel;
    if (key) timesUsed.set(key, (timesUsed.get(key) ?? 0) + 1);
  }

  // ---- pass 2: plan each row.
  const planned: PlannedRow[] = resolved.map((entry) => {
    const { row, rawLabel, real, o } = entry;
    const blockers: ImportBlocker[] = [];
    const label = real ?? rawLabel;
    const term = (row.term.value ?? "monthly") as Term;
    const range = rangeForTerm(term, cutoverISO, season);
    const skipped = isSkipped(entry);

    // What he typed wins over what we read, always.
    const name = o.name?.trim() || row.name.value;
    const amount = o.rent !== undefined ? o.rent : row.rent.value;

    if (!label) blockers.push("no_lot");
    else if (label.length > MAX_LOT_LABEL) blockers.push("label_too_long");

    if (!name) blockers.push("no_name");

    // A lot we do not have. NOT an error — people rent two things, and a
    // storage row for lot 34B is a real row. It is a question, and it stops
    // being one the moment he says "create it".
    if (label && !real && !approved.has(label)) blockers.push("lot_unknown");

    // Two rows on one lot: the common real shape is a mid-year turnover, and
    // the answer is a question, not a rejection.
    if (label && (timesUsed.get(label) ?? 0) > 1) blockers.push("lot_twice_in_paste");

    // Present-and-refused is NOT absent. Absent rent is fine forever; a rent we
    // read and could not convert must stop the row, or "4l0.00" imports as no
    // rent at all and $410 quietly vanishes from the roll. Answered, it clears.
    if (
      o.rent === undefined &&
      row.rent.confidence === "unknown" &&
      row.rent.raw.trim() !== ""
    ) {
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
      name,
      // Only a value we are confident in. A field the parser came back unsure
      // about (two addresses in one cell, a nine-digit "phone") arrives null
      // and stays the office's to fill in by hand.
      email: row.email.value ?? null,
      phone: row.phone.value ?? null,
      amount,
      term,
      range,
      skipped,
      blockers,
      // The parser's own reasons, carried verbatim. They are already sentences.
      flags: [...row.askReasons],
      notes: [...row.notes],
    };
  });

  // A skipped row is neither ready nor a question. It is a decision he made,
  // and it still appears in `rows` so the accounting never loses it.
  // ---- THE NAMELESS ROLL. No name column means no people, and we will not
  // invent any. What the sheet DOES tell us is real and useful: which lots
  // exist and what each one currently brings in. Import that, say so plainly,
  // and let the names arrive as he meets them.
  //
  // The alternative — 20 rows each asking "who lives here?" — is 20 questions
  // he cannot answer from the document in front of him, which is the same as
  // importing nothing.
  if (input.namelessRoll) {
    const rates: PlannedRate[] = planned
      .filter((p) => !p.skipped && p.lotLabel && !p.blockers.includes("label_too_long"))
      .map((p) => ({
        lineNo: p.lineNo,
        lotLabel: p.lotLabel!,
        amount: p.amount,
        createsLot: p.createsLot,
      }));

    return {
      rows: planned,
      ready: [],
      needsYou: [],
      lotsToCreate: [...new Set([
        ...rates.filter((r) => r.createsLot).map((r) => r.lotLabel),
        ...(input.emptyLots ?? []).map((e) => e.label),
      ])],
      monthlyTotal: rates.reduce((sum, r) => sum + (r.amount ?? 0), 0),
      namelessRoll: true,
      emptyLots: [...(input.emptyLots ?? [])],
      rates,
    };
  }

  const ready = planned.filter((p) => !p.skipped && p.blockers.length === 0);
  const needsYou = planned.filter((p) => !p.skipped && p.blockers.length > 0);

  // The empties are lots too. See PlanInput.emptyLotLabels: without them the
  // denominator for every split cost is wrong by exactly the vacancy the park
  // is supposed to carry.
  const lotsToCreate = [
    ...new Set([
      ...ready.filter((p) => p.createsLot && p.lotLabel).map((p) => p.lotLabel!),
      ...(input.emptyLots ?? []).map((e) => e.label),
    ]),
  ];

  // Only monthly rows, only rows that will actually be written. Adding a season
  // to a week to a month produces a number that means nothing, and the screen
  // says so rather than printing it.
  const monthlyTotal = ready
    .filter((p) => p.term === "monthly" && p.amount != null)
    .reduce((sum, p) => sum + p.amount!, 0);

  // A NAMED ROLL CARRIES RATES TOO.
  //
  // This returned `rates: []`, so importing a roll WITH names wrote 21 lots
  // and 21 tenancies and not one rate card. The consequences were all over the
  // app: the pre-closing checklist read "Rate cards 0 of 21", stream readiness
  // said "Set what a lot rents for", and every lot on the public page read
  // "Ask the park about rates" with no way to apply — for a park whose sheet
  // stated a rent on every single line.
  //
  // Only MONTHLY rows with an amount. A lot's rate card is what the lot asks;
  // the household's own figure goes on their tenancy either way, and 0059's
  // `amount_source` keeps recording that it came off the seller's sheet. The
  // owner can edit any of these afterwards — but starting from his own
  // document beats starting from nothing.
  const rates: PlannedRate[] = ready
    .filter((p) => p.lotLabel && p.term === "monthly" && p.amount != null)
    .map((p) => ({
      lineNo: p.lineNo,
      lotLabel: p.lotLabel!,
      amount: p.amount,
      createsLot: p.createsLot,
    }));

  return { rows: planned, ready, needsYou, lotsToCreate, monthlyTotal, namelessRoll: false, emptyLots: [...(input.emptyLots ?? [])], rates };
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
  lotsWithNoAmount: string[];
  /**
   * The lot the gap almost certainly belongs to — set ONLY when the shortfall
   * genuinely looks like one missing rent. Null the rest of the time, and null
   * is the honest answer.
   *
   * Saying "that's exactly one lot's rent" about a $100 gap, on a sheet whose
   * rents are all $370-$410, is a confident lie that sends him to the wrong
   * lot. The claim has to be earned by the arithmetic.
   */
  oneMissingRent: string | null;
  /**
   * A likelier explanation when his total is LOWER than his own rows: a lot
   * appears twice, so we are counting somebody he counted once.
   */
  doubleCountedLots: string[];
}

/**
 * The number the seller wrote at the bottom of his own sheet.
 *
 * Evidence, never authority — it is the one figure on the page we can check
 * HIS arithmetic against, and a total that ties proves his spreadsheet adds up
 * and nothing more. Takes the LARGEST amount on the totals lines, because a
 * totals row often carries a lot count and a column of subtotals beside the
 * figure that matters.
 */
export function statedTotalFrom(lines: readonly string[]): number | null {
  let best: number | null = null;
  for (const line of lines) {
    for (const m of line.matchAll(/\$?\s*(\d[\d,]*(?:\.\d{1,2})?)/g)) {
      const n = Number(m[1].replace(/,/g, ""));
      // Below this it is a lot count or a page number, not a rent roll total.
      if (Number.isFinite(n) && n >= 100 && (best == null || n > best)) best = n;
    }
  }
  return best;
}

export function checkTotals(
  stated: number | null,
  rows: readonly PlannedRow[],
): TotalsCheck | null {
  if (stated == null) return null;
  const computed = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const difference = Math.round((stated - computed) * 100) / 100;
  const ties = Math.abs(difference) < 0.005;

  const lotsWithNoAmount = rows
    .filter((r) => r.amount == null && r.lotLabel)
    .map((r) => r.lotLabel!);

  const amounts = rows.map((r) => r.amount).filter((n): n is number => n != null);

  // BOTH conditions, or we say nothing: the sheet is SHORT, and short by an
  // amount that actually sits inside the range of rents on this very sheet.
  let oneMissingRent: string | null = null;
  if (!ties && difference > 0 && lotsWithNoAmount.length === 1 && amounts.length > 0) {
    const lo = Math.min(...amounts);
    const hi = Math.max(...amounts);
    if (difference >= lo && difference <= hi) oneMissingRent = lotsWithNoAmount[0];
  }

  // A lot listed twice inflates OUR sum above his, which is the usual reason a
  // total comes out "over" rather than short.
  const perLot = new Map<string, number>();
  for (const r of rows) {
    if (r.lotLabel && r.amount != null) perLot.set(r.lotLabel, (perLot.get(r.lotLabel) ?? 0) + 1);
  }
  const doubleCountedLots =
    difference < 0 ? [...perLot.entries()].filter(([, n]) => n > 1).map(([lot]) => lot) : [];

  return {
    stated, computed, difference, ties,
    lotsWithNoAmount, oneMissingRent, doubleCountedLots,
  };
}


/**
 * THE LOT LABEL INSIDE A LINE THE ROLL DID NOT BILL.
 *
 * "Lot 22", "Lot 22 — vacant", "#7", a bare "3" — all of them name a pad that
 * exists and has nobody on it. Anything with no readable number is skipped
 * rather than guessed at: inventing a lot is worse than missing one, because
 * a phantom lot silently dilutes every resident's utility share.
 */
export interface EmptyLot {
  label: string;
  /**
   * Is this a pad that EXISTS and is empty, or one that does not exist yet?
   *
   * The difference is money. An existing empty lot belongs in the denominator
   * and the park carries its share. A future one must not: on The Haven's real
   * roll, lots 22-25 are pads he has not built, and counting them would divide
   * every resident's water bill by 25 instead of 21 — cutting each share 16%
   * and handing the park roughly $217 a month it does not owe.
   */
  rentable: boolean;
}

/**
 * THE PADS THE ROLL DID NOT BILL.
 *
 * "Lot 22", "Lot 22 — vacant", "#7", a bare "3" — all name a pad with nobody
 * on it. Anything with no readable number is skipped rather than guessed at:
 * a phantom lot silently dilutes every resident's share, so missing one is
 * better than inventing one.
 *
 * IN-RANGE OR BEYOND. A silent lot numbered BELOW the highest lot the roll
 * actually billed is a gap in a real row of pedestals — Lot 3 sitting between
 * a billed 2 and a billed 4. One numbered above it is inventory that does not
 * exist yet. Both are created, so he can see and correct them; only the
 * in-range ones are rentable.
 *
 * A non-numeric label (an "A" block) cannot be placed on that line, so it is
 * treated as EXISTING — the conservative reading, since a lot he has to
 * un-tick is safer than one he never sees.
 */
/**
 * One key for every way a roll can write the same pad.
 *
 * "Lot 6", "LOT6", "lot 6", "#6" and "6" are one pedestal with one bill. The
 * dedupe compared raw strings, so a stored "6" and a sheet's "Lot 6" read as
 * two lots and the park grew inventory it does not have.
 */
export function lotKey(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^LOT(?=.)/, "");
}

export function emptyLotsFrom(
  lines: readonly { text: string }[],
  existing: readonly { lotNumber: string }[] = [],
  billedLabels: readonly string[] = [],
): EmptyLot[] {
  const numOf = (label: string): number | null => {
    const m = /(\d{1,4})/.exec(label);
    return m ? Number(m[1]) : null;
  };
  const billedNums = billedLabels.map(numOf).filter((n): n is number => n != null);
  const highestBilled = billedNums.length ? Math.max(...billedNums) : null;

  const have = new Set(existing.map((l) => lotKey(l.lotNumber)));
  const out: EmptyLot[] = [];
  const seen = new Set<string>();

  for (const { text } of lines) {
    const m = /^\s*((?:#\s*|(?:lot|site|space|unit|stall|pad)\s+)?([A-Za-z]{0,2}\d{1,4}[A-Za-z]?))\b/i
      .exec(text ?? "");
    if (!m) continue;

    // THE SAME LABEL THIS TEXT WOULD GET AS A BILLED ROW.
    //
    // This used to force `LOT` onto the front of every empty pad, on the
    // stated grounds that it matched "the shape the parser emits for a billed
    // lot". That is true of The Haven's roll, whose every line reads "Lot 4",
    // and false of every roll that writes a bare number — including the one
    // in this app's own paste-box placeholder. parseLot("Lot 4") is "LOT4";
    // parseLot("4") is "4".
    //
    // So a bare-number roll produced billed lots 1..21 and empty pads LOT6 and
    // LOT19, and the park ended up with 23 lots for 21 pads. Occupancy read
    // 18/23, and — the reason this file exists at all — every shared cost was
    // divided by 23 rentable lots instead of 21, quietly absorbing the
    // difference on pads that do not exist.
    //
    // Asking parseLot means the two sides cannot disagree again: whatever a
    // billed row would be called, an empty one with the same text is called.
    // The fallback covers what parseLot declines to read ("Site 9"), where the
    // bare number is the honest answer rather than an invented prefix.
    const label = parseLot(m[1].trim()).value ?? m[2].trim().toUpperCase();

    // CANONICAL, so "Lot 6" on the sheet cannot re-create a stored "6".
    const key = lotKey(label);
    if (have.has(key) || seen.has(key)) continue;
    seen.add(key);

    const n = numOf(label);
    const rentable = highestBilled == null || n == null || n <= highestBilled;
    out.push({ label, rentable });
  }
  return out;
}

/**
 * ============ IS THIS FILE SOMETHING WE CAN READ AS TEXT? ============
 *
 * The roll intake had exactly one door: a textarea. That door was designed for
 * a real moment — him on his phone at a closing table, reading a list off a
 * page — and it is the wrong door for the one that actually matters, which is
 * a file arriving from the seller by email.
 *
 * His standing rule is verbatim: "I dont ever want to copy paste. I will screw
 * something up." Selecting a spreadsheet and pasting it into a box on a phone
 * is precisely the act he asked never to have to perform, and the failure mode
 * is silent — a truncated selection reads as a shorter roll, not as an error.
 *
 * `readPaste` takes TEXT, so a file door needs no change to any parsing. It
 * needs only this: refuse, in words, the files that are not text, rather than
 * filling the box with binary and letting the parser find nothing in it.
 *
 * A .xlsx is a ZIP (starts "PK") and a .pdf starts "%PDF". Read as text they
 * produce line noise, and line noise in a paste box looks like our bug.
 */
export function whyNotReadable(fileName: string, head: string): string | null {
  const name = fileName.toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));

  // SNIFFED, NOT MERELY NAMED: a spreadsheet saved with the wrong extension is
  // still a spreadsheet, and a .txt that is really a PDF is still a PDF.
  if (head.startsWith("PK")) {
    return "That's an Excel or Numbers file. Open it and choose File \u2192 Save As \u2192 CSV, "
         + "then pick the CSV \u2014 or ask for it as a CSV in the first place.";
  }
  if (head.startsWith("%PDF")) {
    return "That's a PDF, and a PDF has no columns we can read. If it's a "
         + "spreadsheet printed to PDF, ask for the spreadsheet itself as a CSV.";
  }
  if (ext === ".xls" || ext === ".xlsx" || ext === ".numbers" || ext === ".ods") {
    return "Spreadsheet files need saving as CSV first \u2014 open it and choose "
         + "File \u2192 Save As \u2192 CSV, then pick that.";
  }
  if (ext === ".pdf" || ext === ".doc" || ext === ".docx" || ext === ".pages") {
    return "We can only read a CSV, a TSV or a plain text list. If this came "
         + "from a spreadsheet, ask for it as a CSV.";
  }
  if (ext === ".heic" || ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
    return "That's a photo. We can't read a picture of a roll \u2014 ask for the "
         + "list as a CSV, or type what you can into the box below.";
  }
  // A NUL byte means binary whatever the name says.
  if (head.includes("\u0000")) {
    return "That file isn't text we can read. A CSV works best.";
  }
  if (!head.trim()) {
    return "That file is empty.";
  }
  return null;
}
