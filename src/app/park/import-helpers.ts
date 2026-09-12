import {
  overlaps,
  type DateRange,
  type Term,
} from "@/lib/parks";
import { parseLot, splitLine, parseMoney, cellCadence } from "@/lib/roll-parse";
import type { Delimiter } from "@/lib/roll-parse";
import type { ParsedRow } from "@/lib/roll-parse";
import { median } from "@/lib/stats";
import { toE164 } from "@/lib/phone";

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
  /**
   * A figure in a cadence we will not file as a month — a yearly or quarterly
   * column, a term cell reading "Annual", or one we could not read at all.
   * Rent goes monthly, the biller reads the amount and never the term, and
   * the parser never invents a value: dividing by twelve IS inventing one,
   * because his sheet does not say the year was twelve equal months. Held
   * until he types the monthly rent.
   */
  | "bad_term"
  /**
   * A monthly figure that is many times what the lots are carded at. The one
   * guard that catches a bare "Rent" header carrying yearly figures — no
   * header rule can. A question, not a rejection: the figure he types is his
   * answer, even if it is the same one.
   */
  | "looks_yearly"
  | "no_season";

/**
 * How the sheet stated a figure the plan will not file as a monthly rent.
 * `conflicting` is a sheet that says two things — a yearly or quarterly rent
 * header over a term cell reading "Monthly" — and neither is trusted.
 */
export type CadenceOnSheet = "annual" | "quarterly" | "conflicting" | "unreadable";

/**
 * The rate card a figure was measured against — the lot's own when it has
 * one, otherwise the middle of the park's cards. Carried so the sentence can
 * say the number rather than "the rate card".
 */
export interface RateHint { amount: number; basis: "lot" | "park" }

/** What a blocker's sentence needs beyond the code and the lot. */
export interface BlockerDetail {
  cadenceOnSheet?: CadenceOnSheet | null;
  rateHint?: RateHint | null;
}

/** Money the way the review screen prints it — cents only when there are any. */
const money2 = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function importBlockerText(b: ImportBlocker, lotLabel?: string, detail?: BlockerDetail): string {
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
    case "bad_term": {
      // NO ÷12 HERE, EVEN AS A SUGGESTION. A number printed beside a box is a
      // number that gets typed into it, and then the software has divided by
      // twelve with his fingerprint on it. And no "on the lease": on The Haven
      // eleven of the eighteen leases understate what is actually collected,
      // so naming a document would point him at the wrong number. He knows
      // what the month is; the question is his to answer.
      const c = detail?.cadenceOnSheet ?? "unreadable";
      if (c === "annual") {
        return "This is a yearly figure, and rent is filed by the month. What's the monthly rent?";
      }
      if (c === "quarterly") {
        return "This is a quarterly figure, and rent is filed by the month. What's the monthly rent?";
      }
      if (c === "conflicting") {
        return "The rent column's header and this row's term cell disagree about how often it's paid — the sheet gives two answers. What's the monthly rent?";
      }
      return "We couldn't tell how often that's paid, so we won't file it as a month. What's the monthly rent?";
    }
    case "looks_yearly": {
      const hint = detail?.rateHint;
      const against = hint
        ? hint.basis === "lot"
          ? ` — the lot's rate card is ${money2(hint.amount)} a month`
          : ` — lots here are carded at about ${money2(hint.amount)} a month`
        : ", not a monthly rent";
      return `That looks like a yearly figure${against}. If it really is the monthly rent, type it in and it goes through as typed.`;
    }
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
      // Lookahead, not \b: there is no word boundary between "t" and "2", so
      // \b handles "lot 26" and leaves "lot26" untouched. parseLot uses the
      // same rule, and a test asserts the two agree.
      .replace(/^(lot|site|space|unit|stall|pad)[\s.:#-]*(?=\d)/, "")
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
  /**
   * The sheet gave this figure in a cadence the plan will not file as a
   * month. Set from the parse, so it survives his answer — once he types the
   * monthly rent the blocker clears, but the screen still knows the sheet's
   * own total is a yearly one and must not be checked against monthly rows.
   */
  cadenceOnSheet: CadenceOnSheet | null;
  /**
   * THE FIGURE ON THIS ROW IS HIS, NOT THE SELLER'S. The sheet printed one
   * the plan would not file as a month — in another cadence, or one that
   * looked yearly against the cards — and he typed a different figure over
   * it (or said there isn't one). The seller's total at the bottom of his
   * list is the sum of the figures he PRINTED, so from here on his total and
   * the rows no longer add up the same things, and `checkTotals` refuses.
   * The same figure typed back is still his figure, and is not this.
   */
  typedOver: boolean;
  /** What `looks_yearly` measured the figure against. Null when nothing did. */
  rateHint: RateHint | null;
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
  /**
   * The lot's monthly rate card, when it has one. The plan uses the park's
   * cards as the scale a sheet's figures are measured on: a "rent" of $3,600
   * against twenty-one cards at $400 is a year, not a month. Absent on a park
   * with no cards yet, and then nothing is measured.
   */
  monthlyRate?: number | null;
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

  // THE SCALE THE PARK'S OWN CARDS SET. The middle card, so one park-owned
  // home at $1,500 among twenty lots at $400 does not move it. Null on a park
  // with no cards, and then the check does not run — a guess would be worse.
  const cardMedian = median(
    lots.map((l) => l.monthlyRate).filter((n): n is number => typeof n === "number" && n > 0),
  );

  // ---- pass 2: plan each row.
  const planned: PlannedRow[] = resolved.map((entry) => {
    const { row, rawLabel, real, o } = entry;
    const blockers: ImportBlocker[] = [];
    const label = real ?? rawLabel;
    const skipped = isSkipped(entry);

    // A FIGURE IN A CADENCE WE WILL NOT FILE. Rent goes monthly and the
    // biller reads the amount, never the term, so "annual, $4,500" bills
    // $4,500 in January. The tenancy this row becomes is monthly; the figure
    // on it is the one he types.
    const cadenceOnSheet = cadenceOnSheetOf(row);
    const term = (cadenceOnSheet ? "monthly" : (row.term.value ?? "monthly")) as Term;
    const range = rangeForTerm(term, cutoverISO, season);

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

    // A figure the sheet gave by the year or the quarter, or under a cadence
    // we could not read, with no monthly rent typed over it. NEVER ÷12.
    if (cadenceOnSheet && o.rent === undefined && row.rent.value != null) {
      blockers.push("bad_term");
    }

    // The sheet's own figure against the park's cards. Only the sheet's — a
    // figure he typed is his answer, and refusing it would be a question with
    // no exit. Not raised beside bad_term: that row is already asking.
    const lotRate = real ? byLabel.get(real)?.monthlyRate ?? null : null;
    const rateHint: RateHint | null =
      typeof lotRate === "number" && lotRate > 0
        ? { amount: lotRate, basis: "lot" }
        : cardMedian != null ? { amount: cardMedian, basis: "park" } : null;
    const looksYearly =
      !cadenceOnSheet &&
      row.rent.value != null &&
      cardMedian != null &&
      row.rent.value > cardMedian * LOOKS_YEARLY_FACTOR;
    if (looksYearly && o.rent === undefined) blockers.push("looks_yearly");

    // Whether the figure now on the row is still the one the seller printed.
    // Only for a figure the plan would not have filed: a plain monthly rent
    // gets no box on the screen, and a rent we could not read ("4l0.00")
    // printed no figure to be typed over.
    const typedOver =
      (cadenceOnSheet != null || looksYearly) &&
      row.rent.value != null &&
      o.rent !== undefined &&
      o.rent !== row.rent.value;

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
      cadenceOnSheet,
      typedOver,
      rateHint: blockers.includes("looks_yearly") ? rateHint : null,
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
    // A yearly figure is no more a monthly rate card than a monthly rent. The
    // lot is still set up; its card stays empty, and RENT_NOT_MONTHLY at the
    // top of the screen says why.
    const notMonthly = (p: PlannedRow) =>
      p.blockers.includes("bad_term") || p.blockers.includes("looks_yearly");
    const rates: PlannedRate[] = planned
      .filter((p) => !p.skipped && p.lotLabel && !p.blockers.includes("label_too_long"))
      .map((p) => ({
        lineNo: p.lineNo,
        lotLabel: p.lotLabel!,
        amount: notMonthly(p) ? null : p.amount,
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

/**
 * A monthly figure this many times the park's middle rate card is read as a
 * yearly one. Four is deliberately loose: a park-owned double-wide at $1,500
 * among $400 lots is under it; a $3,600 "rent" against $400 cards is nine
 * times over.
 */
export const LOOKS_YEARLY_FACTOR = 4;

/**
 * How the sheet stated this row's figure, when it is not a month. The parser
 * carries it four ways, read in this order: `cadenceConflict` set — the
 * header and the cell each name a cadence and disagree, a sheet that
 * contradicts itself, and the card says so rather than "we couldn't tell";
 * a term value of "annual" (from a header or a cell); `headerCadence` — the
 * header's own reading, carried as a signal because "Rent Each Quarter" is
 * two words after the filler and the one-word cell reader cannot read it
 * back off the label the parser leaves in `term.raw`; and last, no value
 * with the cell it could not file as the raw — "Quarterly", "Twice yearly".
 */
export function cadenceOnSheetOf(
  row: Pick<ParsedRow, "term" | "cadenceConflict" | "headerCadence">,
): CadenceOnSheet | null {
  if (row.cadenceConflict) return "conflicting";
  if (row.term.value === "annual") return "annual";
  if (row.headerCadence === "quarterly") return "quarterly";
  if (row.headerCadence === "annual") return "annual";
  if (row.term.value === null && row.term.raw.trim() !== "") {
    const said = cellCadence(row.term.raw);
    if (said === "annual") return "annual";
    if (said === "quarterly") return "quarterly";
    return "unreadable";
  }
  return null;
}

/**
 * THE RENT HE TYPES, read as a figure or refused by name.
 *
 * The box under "This is a yearly figure… What's the monthly rent?" invites
 * arithmetic, and the loader used to read whatever landed there by stripping
 * everything but digits: "4500/12" became 450,012, "see lease" became 0, and
 * either cleared the hold as his answer with no question left on screen.
 * `parseMoney` is the parser's own reading of a money cell — the same one
 * that refused "4l0.00" on the sheet — so the answer box and the sheet are
 * held to one standard. `null` is the plan's "there isn't one".
 */
export type TypedRent = { ok: true; value: number | null } | { ok: false; error: string };
export function typedRent(raw: unknown): TypedRent {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 && raw <= 100_000
      ? { ok: true, value: raw }
      : { ok: false, error: "That isn't a figure we can file as a rent. Type the monthly amount as a number, like 375." };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "That isn't a figure we can file as a rent. Type the monthly amount as a number, like 375." };
  }
  const typed = raw.trim();
  const m = parseMoney(typed);
  if (m.value != null) return { ok: true, value: m.value };
  const named = typed ? `"${typed}" isn't a figure we can file as a rent.` : "That box is empty.";
  return { ok: false, error: `${named} Type the monthly amount as a number, like 375.` };
}

/**
 * A pasted phone, in the form the other two writers of
 * `phone_on_file_with_park` store it (buildTenant and the signing door both
 * go through `toE164`), so one column holds one format. The parser's pretty
 * form stays on the review screen, where a person reads it.
 */
export function phoneOnFile(pretty: string | null | undefined): string | null {
  if (!pretty) return null;
  return toE164(pretty);
}

/**
 * The cadence the SHEET gave its figures in, across the rows he has not stood
 * down — or null when they are monthly. The screen reads this to refuse the
 * tie check and to say why: a yearly total at the bottom of a sheet cannot be
 * checked against rows that are waiting for a monthly rent, and once they
 * have one it still cannot, because the total is a year and the rows are a
 * month. Reads the parse, not the blocker, so it holds after he answers.
 *
 * A MAJORITY OF THE FIGURES, OR NOTHING. This took the most frequent cadence
 * among the rows that had one and ignored the rest, so ONE row decided the
 * sheet: a single "Annual" cell on a monthly roll — or a blank-rent row whose
 * term cell said Annual, which held nothing at all — made the whole sheet
 * "conflicting", switched the seller's-arithmetic check off for good, and
 * printed a sentence about a monthly total that tied to the penny. Only rows
 * with a figure vote (a row with none is nothing to add up), and a cadence is
 * the sheet's only when more than half of them share it. A held minority
 * still refuses the tick on its own until answered — see `checkTotals`.
 */
export function sheetCadence(rows: readonly PlannedRow[]): CadenceOnSheet | null {
  const tally = new Map<CadenceOnSheet, number>();
  let figures = 0;
  for (const r of rows) {
    if (r.skipped || r.amount == null) continue;
    figures += 1;
    if (!r.cadenceOnSheet) continue;
    tally.set(r.cadenceOnSheet, (tally.get(r.cadenceOnSheet) ?? 0) + 1);
  }
  let best: CadenceOnSheet | null = null;
  let n = 0;
  for (const [c, count] of tally) if (count > n) { best = c; n = count; }
  return best !== null && n * 2 > figures ? best : null;
}

/**
 * What the rows still WAITING on a monthly rent were stated as — for the
 * sentence about them, which used to be derived from the sheet and so called
 * a lone conflicting row on a monthly sheet "figures that look yearly
 * against your rate cards" when nothing had measured it against a card.
 *
 * One kind when every held row is that kind; "mixed" when they differ, so
 * the screen claims nothing specific of all of them; null when none is held.
 * A `looks_yearly` row has no cadence on the sheet — it is held for looking
 * like a year against the cards — and is its own kind here.
 */
export type HeldCadence = CadenceOnSheet | "looks_yearly" | "mixed";
export function heldCadence(rows: readonly PlannedRow[]): HeldCadence | null {
  let found: HeldCadence | null = null;
  for (const r of rows) {
    if (r.skipped) continue;
    const kind: HeldCadence | null = r.blockers.includes("bad_term")
      ? (r.cadenceOnSheet ?? "unreadable")
      : r.blockers.includes("looks_yearly") ? "looks_yearly" : null;
    if (kind === null) continue;
    if (found === null) found = kind;
    else if (found !== kind) return "mixed";
  }
  return found;
}

/**
 * The rows he has ANSWERED with a figure that is not the seller's — the
 * sheet printed a yearly one, a quarterly one, one it gave two cadences for,
 * or one that looked yearly against the cards, and he typed the monthly rent
 * over it. Read the same way `heldCadence` reads the held rows: one kind when
 * they all share it, "mixed" when they differ, null when there are none. And
 * how many, for the sentence that says why his total is not checked: once
 * any such row exists, his total sums figures that are no longer on the rows.
 */
export function answeredCadence(rows: readonly PlannedRow[]): { kind: HeldCadence; count: number } | null {
  let found: HeldCadence | null = null;
  let count = 0;
  for (const r of rows) {
    if (r.skipped || !r.typedOver) continue;
    const kind: HeldCadence = r.cadenceOnSheet ?? "looks_yearly";
    count += 1;
    if (found === null) found = kind;
    else if (found !== kind) found = "mixed";
  }
  return found === null ? null : { kind: found, count };
}

// ------------------------------------------------------------- the money ----

export interface CadenceTotals {
  byTerm: { term: Term; count: number; total: number }[];
  /** True when more than one cadence is present — no single number is honest. */
  mixed: boolean;
  /**
   * Rows with a figure the plan will not read as any cadence — held on
   * `bad_term` or `looks_yearly` until he types the monthly rent. Left out of
   * every total above, and counted here so the screen can say so rather than
   * printing "$67,500 a month" over eighteen yearly figures.
   */
  heldForMonthly: number;
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
  let heldForMonthly = 0;
  for (const r of rows) {
    if (r.amount == null) continue;
    // A figure with no cadence we can name is not "a month" — it is the row's
    // question. Summing it as one is exactly how the review screen read
    // "$67,500 a month" off a yearly column.
    if (r.blockers.includes("bad_term") || r.blockers.includes("looks_yearly")) {
      heldForMonthly += 1;
      continue;
    }
    const cur = map.get(r.term) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += r.amount;
    map.set(r.term, cur);
  }
  const byTerm = [...map.entries()].map(([term, v]) => ({ term, ...v }));
  return { byTerm, mixed: byTerm.length > 1, heldForMonthly };
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
export function statedTotalFrom(
  lines: readonly string[],
  /**
   * How the sheet separates its columns, when the caller knows.
   *
   * WITHOUT IT THIS CANNOT BE RIGHT. "TOTAL,,800,600" is two whole-dollar
   * fields to a CSV and the single number 800,600 to anybody reading it as
   * prose — the two readings are indistinguishable, and the grouped one is a
   * perfectly valid thousands separator. Guessing lands on $800,600 and this
   * function takes the LARGEST figure it finds, so the guess wins and the
   * panel that checks the seller's arithmetic reports a number three orders
   * of magnitude out at the closing table.
   *
   * Splitting the fields first removes the ambiguity entirely. A quoted
   * "6,700.00" stays one cell and still reads as 6700.
   */
  delimiter?: Delimiter,
): number | null {
  let best: number | null = null;
  const scanLines = delimiter && delimiter !== "none"
    ? lines.flatMap((l) => splitLine(l, delimiter))
    : lines;
  for (const line of scanLines) {
    // A COMMA IS A THOUSANDS SEPARATOR ONLY WHEN IT SEPARATES THOUSANDS.
    //
    // `\d[\d,]*` ran straight through the CSV field separator, so a totals row
    // of whole dollars — "TOTAL,,6700,1200" — read as ONE number, 67,001,200,
    // and this function takes the LARGEST it finds, so that is what won. The
    // panel whose entire job is checking the seller's arithmetic against his
    // own rows would have told him at the closing table that his sheet claims
    // a figure seven orders of magnitude out. It behaved only when every
    // number in the row happened to carry cents.
    //
    // Grouped form first, so "6,700.00" is one number; plain digits second,
    // bounded by (?!\d) so a run cannot swallow the next field.
    const MONEY = /\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?!\d)/g;
    for (const m of line.matchAll(MONEY)) {
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
  // THE SELLER'S TOTAL IS THE SUM OF THE FIGURES HE PRINTED, so this is a
  // check on his arithmetic only while every figure it adds is his. Null —
  // and the screen says why — when:
  //
  // The sheet is not monthly. His yearly figures add up to his yearly total,
  // a tie that reads as a green tick over eighteen rents twelve times too
  // big; and once he has typed the monthly rents, a yearly total against
  // monthly rows is not a check either.
  //
  // Any row is still held for LOOKING yearly, or on its cadence. A minority
  // "Annual" row on a monthly sheet does not switch the sheet's cadence, so
  // it refuses the tick on its own: a tick above an open question about one
  // of the same figures answers it.
  //
  // Any row has been TYPED OVER. Two monthly rows at 400 and one yearly at
  // 4800, under the seller's honest total of 5600: once he types 400 over
  // the yearly figure the rows are 1200 and his total is still 5600. This
  // ran the check on that and printed "short $4,400" about a sheet that adds
  // up to the penny — and ticked only a 1200 the seller could have written
  // by dividing 4800 by 12 himself. No total he could have printed is a
  // check on rows that no longer carry his figures.
  //
  // Over the rows he has NOT stood down, throughout: the guards read that
  // way, and the sum did not, so a skipped row was refused a vote and then
  // added to the total anyway. The screen passes only the live rows and never
  // saw it; the function is held to its own rule regardless.
  const live = rows.filter((r) => !r.skipped);
  if (sheetCadence(live) != null) return null;
  if (live.some((r) => r.blockers.includes("looks_yearly"))) return null;
  if (live.some((r) => r.blockers.includes("bad_term"))) return null;
  if (live.some((r) => r.typedOver)) return null;
  const computed = live.reduce((s, r) => s + (r.amount ?? 0), 0);
  const difference = Math.round((stated - computed) * 100) / 100;
  const ties = Math.abs(difference) < 0.005;

  const lotsWithNoAmount = live
    .filter((r) => r.amount == null && r.lotLabel)
    .map((r) => r.lotLabel!);

  const amounts = live.map((r) => r.amount).filter((n): n is number => n != null);

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
  for (const r of live) {
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
    // lot". That was true of parseLot at the time — it collapsed "Lot 4" to
    // "LOT4" — and it was the wrong shape on BOTH sides: nobody paints "LOT4"
    // on a post, the lot is number 4. parseLot now strips the seller's word
    // and both sides read "4".
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
    // BOTH WORDINGS, because the menu is not the same on the two programs
    // this file opens in. Excel has File -> Save As -> CSV; Numbers, which is
    // what a spreadsheet opens in on a Mac, has File -> Export To -> CSV.
    // Naming only Excel's sends a Mac owner looking for a menu item that is
    // not there, which is a dead end dressed as help.
    return "That's a spreadsheet. Save a copy as CSV and pick that instead \u2014 "
         + "in Excel it's File \u2192 Save As \u2192 CSV, in Numbers it's "
         + "File \u2192 Export To \u2192 CSV. Or just ask for it as a CSV.";
  }
  if (head.startsWith("%PDF")) {
    return "That's a PDF, and a PDF has no columns we can read. A rent roll is "
         + "almost always printed from a spreadsheet \u2014 ask whoever sent it "
         + "for that file, saved as a CSV. If it's a scan of something written "
         + "by hand, there is no file behind it, and the box below is the way in.";
  }
  if (ext === ".xls" || ext === ".xlsx" || ext === ".numbers" || ext === ".ods") {
    return "Spreadsheet files need saving as CSV first \u2014 in Excel that's "
         + "File \u2192 Save As \u2192 CSV, in Numbers it's File \u2192 Export To "
         + "\u2192 CSV. Or ask for it as a CSV.";
  }
  if (ext === ".pdf" || ext === ".doc" || ext === ".docx" || ext === ".pages") {
    return "We can only read a CSV, a TSV or a plain text list. This was almost "
         + "certainly printed from a spreadsheet \u2014 ask whoever sent it for "
         + "that file, saved as a CSV.";
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


/**
 * ============ DOES THIS SHEET NUMBER THE PADS THE WAY THE PARK DOES? ============
 *
 * The single most likely way a takeover import goes wrong, and it produces a
 * screen that looks fine.
 *
 * The Haven's pads are 1, 2, 6, 7, 9, 10, 11, 14, 15-24, 26, 27, 28 — not
 * 1-21. A seller whose book simply numbers his tenants 1..21 produces a file
 * where FIFTEEN rows match a real pad by coincidence and six do not. The
 * fifteen import silently, with no blocker and nothing to answer: fifteen
 * households filed onto pads that are not theirs. The six become "Create lot
 * 3" buttons whose obvious answer is yes, and the park ends up with 27 lots —
 * which is the denominator every shared cost is divided by, so the $142.53 fee
 * built on 21 quietly dilutes and the park eats the difference.
 *
 * Matching by number is right when the numbering agrees, and the software
 * cannot tell whose numbering it is. What it CAN do is put both lists side by
 * side, which no screen has ever done in either direction.
 *
 * The tell is the shape, not either list alone: a file that names pads the
 * park does not have WHILE leaving pads the park does have unmentioned. One
 * of those is ordinary — a new pad, or a vacancy the seller omitted. Both at
 * once, several times over, is a numbering mismatch.
 */
export interface RollReconciliation {
  /** Pads the park already has. */
  parkLots: string[];
  /** Pads the file names that the park has. */
  matched: string[];
  /** Labels in the file that match no pad — importing creates these. */
  wouldCreate: string[];
  /** Pads the park has that the file never names at all. */
  neverMentioned: string[];
  /** Both lists non-trivially non-empty: the signature of a mismatch. */
  looksMisnumbered: boolean;
}

export function reconcileRoll(
  parkLots: readonly string[],
  fileLabels: readonly { matched: string | null; raw: string }[],
): RollReconciliation {
  const seen = new Set<string>();
  const wouldCreate: string[] = [];

  for (const f of fileLabels) {
    if (f.matched != null) { seen.add(f.matched); continue; }
    const raw = (f.raw ?? "").trim();
    if (!raw) continue;                       // a line with no lot at all

    // THE SAME MATCHER THE IMPORT ITSELF USES, not a second rule that happens
    // to agree today. `normaliseLotLabel` knows "Lot 6" and "07" are pads 6 and
    // 7 while "12A" is not pad 12; a card that predicted something else would
    // be a confident sentence about a different import than the one he is
    // about to run.
    const hit = normaliseLotLabel(raw, parkLots);
    if (hit != null) { seen.add(hit); continue; }
    if (!wouldCreate.some((w) => lotKey(w) === lotKey(raw))) wouldCreate.push(raw);
  }

  const matched = parkLots.filter((l) => seen.has(l));
  const neverMentioned = parkLots.filter((l) => !seen.has(l));

  // TWO IS THE THRESHOLD, deliberately. One unknown label and one quiet pad is
  // an ordinary Tuesday — a new site, a vacancy the seller left off. Several of
  // both at once is the only shape a numbering mismatch makes.
  const looksMisnumbered = wouldCreate.length >= 2 && neverMentioned.length >= 2;

  return { parkLots: [...parkLots], matched, wouldCreate, neverMentioned, looksMisnumbered };
}


/**
 * ============ DECODING THE SELLER'S FILE ============
 *
 * `File.text()` decodes UTF-8 unconditionally, and Excel on Windows does not
 * write UTF-8. "Save As -> CSV (Comma delimited)" writes windows-1252, where a
 * curly apostrophe is a single byte 0x92. Decoded as UTF-8 that is invalid, and
 * the browser substitutes U+FFFD — so O'Neil arrives as a name with a black
 * diamond in it, passes every check we have (it is not a NUL byte, it is not
 * empty, it parses as a stated name), and is filed against that household
 * permanently.
 *
 * Two decoders, in the only order that is safe:
 *
 *   UTF-8 FIRST, and STRICTLY. `fatal: true` throws on a byte sequence that is
 *   not valid UTF-8 rather than papering over it. A file that decodes cleanly
 *   as UTF-8 IS UTF-8 — the encodings agree byte-for-byte on plain ASCII, so
 *   the only files that reach the fallback are the ones UTF-8 genuinely cannot
 *   read.
 *
 *   THEN windows-1252, which has a definition for all 256 byte values and so
 *   never fails. Wrong only if the file was some third encoding, and then it
 *   is wrong in the same way `File.text()` already was.
 *
 * AND THE BYTE ORDER MARK, which is handled and needs no code. "CSV UTF-8
 * (Comma delimited)" — the option worth asking a seller for, because it is the
 * one that avoids everything above — writes a BOM, which would otherwise make
 * the first header "﻿Lot" and stop the first column being the lot column.
 * `TextDecoder` strips a leading UTF-8 BOM by default (it would keep it only
 * with `ignoreBOM: true`), so there is nothing to do here.
 *
 * I wrote a guard for it anyway and then could not make it fail: unreachable
 * defensive code with a comment claiming it mattered is worse than none, so it
 * is gone and `import-helpers.test.ts` pins the behaviour instead — a BOM'd
 * file's first column is still the lot column.
 */
export function decodeRoll(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("windows-1252").decode(buf);
  }
  return text;
}
