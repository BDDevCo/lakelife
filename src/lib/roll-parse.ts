/**
 * THE RENT-ROLL PARSER — PURE, no I/O, fully unit-testable.
 *
 * Spec: docs/park-importer.md. The principle it exists to serve:
 *
 *   AUTOMATE WHAT FAILS LOUDLY. HAND OVER WHAT FAILS QUIETLY.
 *
 * A wrong lot number fails loudly — the lot shows nobody on it and he walks it
 * on Saturday. A wrong name fails loudly — it prints on the week-one letter.
 * A wrong RENT fails quietly: $465 and $485 look equally authoritative and
 * nobody finds out for eighteen months. So rent gets one reading or none, and
 * the screen says "we read 24 of the 31 lines" instead of a green tick.
 *
 * That matters because seller rent rolls in this industry commonly run 10–20%
 * inflated. A confident-looking import manufactures certainty in precisely the
 * number most likely to be wrong.
 *
 * TWO GUARANTEES:
 *   1. NEVER DROP A LINE. Every source line is accounted for exactly once, and
 *      the accounting is COMPUTED, not promised. A dropped line is a tenant who
 *      does not exist and nobody notices until he does not pay.
 *   2. NEVER INVENT A VALUE. `unknown` means null, always. A defaulted rent is
 *      a wrong rent that looks confident.
 */

import type { Term } from "@/lib/parks";

// ------------------------------------------------------------- the field ---

export type Confidence = "stated" | "inferred" | "unknown";

export interface Field<T> {
  value: T | null;
  confidence: Confidence;
  /** The cell exactly as pasted. Always — it is the evidence. */
  raw: string;
  /** Only when unknown AND we found more than one reading. Renders as chips. */
  candidates?: T[];
  why?: string;
}

const unknownField = <T,>(raw = "", why?: string, candidates?: T[]): Field<T> => ({
  value: null, confidence: "unknown", raw, ...(why ? { why } : {}),
  ...(candidates && candidates.length > 1 ? { candidates } : {}),
});
const stated = <T,>(value: T, raw: string): Field<T> => ({ value, confidence: "stated", raw });
const inferred = <T,>(value: T, raw: string, why: string): Field<T> =>
  ({ value, confidence: "inferred", raw, why });

// --------------------------------------------------------------- shapes ----

export type Delimiter = "tab" | "multispace" | "comma" | "pipe" | "none";
export type Verdict = "import" | "ask";

export type Target = "lot" | "name" | "rent" | "term" | "dueDay" | "moveIn" | "email" | "phone";

/**
 * WHAT A RENT HEADER SAYS ABOUT HOW OFTEN IT IS PAID.
 *
 * Wider than `Term` on purpose: "Quarterly Rent" is a real header on a real
 * roll and there is no quarterly term — rent bills monthly, there will never
 * be a quarterly one — so the header has to be readable as a cadence the
 * importer REFUSES rather than one it cannot see.
 */
export type HeaderCadence = "monthly" | "weekly" | "annual" | "quarterly";

export interface ColumnMap {
  /** One entry per column, in order. */
  roles: ({ kind: "field"; target: Target; cadence?: HeaderCadence }
        | { kind: "carry"; label: string }
        | { kind: "refused"; label: string }
        | { kind: "unrecognised"; label: string })[];
  index: Partial<Record<Target, number>>;
  unrecognised: string[];
  /**
   * Columns dropped on purpose — SSNs, dates of birth, bank details. Named so
   * the screen can say "we did not import this", because silently discarding
   * data somebody pasted is its own kind of lie.
   */
  refused: string[];
}

export interface ParsedRow {
  /** 1-based source lines. Always at least one. */
  lines: number[];
  source: string[];
  lot: Field<string>;
  name: Field<string>;
  rent: Field<number>;
  term: Field<Term>;
  /**
   * THE SHEET GIVES TWO CADENCES. The rent header names one ("Annual Rent",
   * "Monthly Rent") and this row's term cell names another, and neither is
   * trusted: `term` is unknown with the cell as its raw, and the plan reads
   * this shape as a sheet that contradicts itself rather than "we couldn't
   * tell". Set only when both name a cadence and they disagree.
   */
  cadenceConflict?: { header: string; cell: string };
  /**
   * THE CADENCE THE RENT HEADER NAMED, carried as the signal it is. The plan
   * used to re-read it from the header label that a quarterly column leaves
   * in `term.raw` — and "Rent Each Quarter" is two words once the filler is
   * gone, which the one-word cell reader cannot read, so eighteen rows said
   * "we couldn't tell" under a top card that said quarterly. Set on every
   * row under a rent header that names one; absent under a bare "Rent".
   */
  headerCadence?: HeaderCadence;
  /**
   * AN ADDRESS OF RECORD, NOT PERMISSION.
   *
   * `email` was already a recognised header — it landed in `columns.index` and
   * the VALUE was then dropped on the floor, because ParsedRow had nowhere to
   * put it. A target with no field.
   *
   * `phone` used to be carried to `notes` as free text, deliberately: a number
   * off somebody else's sheet written to `mobile_e164` is a text message to a
   * stranger who never agreed to one. That reasoning stands. It now lands in
   * `park_renters.phone_on_file_with_park` instead — a column that exists for
   * exactly this and which the reminder engine is built never to send to — so
   * the office can SEE the number without the software being able to use it.
   */
  email: Field<string>;
  phone: Field<string>;
  /** Balances, deposits, marginalia — carried, never mapped. */
  notes: string[];
  verdict: Verdict;
  askReasons: string[];
}

export interface OtherLine { lines: number[]; text: string; why?: string }

export interface BlockQuestion { code: string; question: string }

export interface LineAccounting {
  totalLines: number;
  accounted: number;
  /** MUST be empty. A non-empty one is a hard block question, not a field
   *  nobody reads. */
  unaccounted: number[];
  duplicated: number[];
}

export interface ParseResult {
  shape: {
    delimiter: Delimiter;
    headerLine: number | null;
    columnCount: number;
    /** FNV-1a over the normalised blob — re-paste detection. */
    contentHash: string;
    /**
     * FALSE when the sheet carries no name column AT ALL — not merely a row
     * with a blank name. A roll of lots and rents with nobody on it is a real
     * and common shape (it is exactly what the Pretty Lake proforma is), and it
     * is worth importing as inventory even though it names no tenants.
     */
    hasNameColumn: boolean;
  };
  columns: ColumnMap;
  rows: ParsedRow[];
  /** Declared empty by the seller. The column that catches inflation. */
  vacantDeclared: OtherLine[];
  /** A lot number and nothing else. NOT the same as declared-vacant. */
  silentLots: OtherLine[];
  /** OFFICE, SHOP, LAUNDRY — neither tenancy nor vacancy. */
  facilities: OtherLine[];
  /** Evidence, never authority. */
  totals: OtherLine[];
  skipped: OtherLine[];
  unparsed: OtherLine[];
  blockQuestions: BlockQuestion[];
  accounting: LineAccounting;
  stats: { readable: number; toImport: number; toAsk: number };
}

export interface ParseOptions {
  knownLots?: readonly string[];
  sourceLabel?: string;
}

// ------------------------------------------------------------- synonyms ----

const SYN: Record<Target, string[]> = {
  lot:    ["lot", "lot #", "lot no", "lot number", "site", "site #", "space", "space #", "unit #", "#", "pad", "stall"],
  name:   ["name", "tenant", "tenant name", "resident", "occupant", "renter", "lessee", "customer", "who"],
  rent:   ["rent", "lot rent", "monthly rent", "rent/mo", "rent amount", "lot rent amount", "amount", "monthly", "weekly rent", "rate", "base rent", "site rent"],
  // NOT "paid". A "Paid" column on a rent roll is Y/N or a date, never how
  // often the rent is due — and as a term synonym it turned an ordinary
  // roll with a Paid column into eighteen held rows under a header that
  // said Monthly. It carries to notes now, like any column we do not map.
  term:   ["term", "frequency", "cadence", "billing", "period"],
  dueDay: ["due", "due day", "due date", "rent due"],
  moveIn: ["move in", "move-in", "moved in", "start", "start date", "lease start", "since"],
  email:  ["email", "e-mail", "email address"],
  phone:  ["phone", "cell", "mobile", "telephone", "phone number", "cell phone",
           "contact number", "tel"],
};

/**
 * COLUMNS WE REFUSE OUTRIGHT.
 *
 * A rent roll assembled from lease documents often carries a social security
 * number or a date of birth. We are an administrator and never a screening
 * bureau, and the safest place to hold data like that is nowhere. Refusing the
 * whole column — rather than quietly carrying it to notes, which is where every
 * unrecognised column goes — keeps that a property of the software instead of a
 * habit somebody has to remember.
 */
const REFUSE = [
  "ssn", "social security", "social", "sin", "tax id", "tin",
  "dob", "date of birth", "birth date", "birthdate", "birthday",
  "drivers license", "driver s license", "license number", "passport",
  "bank account", "routing", "account number", "card number",
];

/** Columns we deliberately carry to notes rather than map — they are real data
 *  the owner may want, but nothing here writes them to a field of their own. */
const CARRY = [
  "balance", "past due", "deposit",
  "security", "pet", "pets", "notes", "note", "comment", "status", "address",
  "meter", "water", "electric", "utility", "vehicle", "make", "model",
  // A YEAR IS ONLY A VEHICLE YEAR NEXT TO A VEHICLE. A bare "year" sat here
  // and swallowed "Yearly Rent" whole — the rent column carried off to notes,
  // NO_RENT_COLUMN raised, eighteen households filed with no rent at all.
  // "Annual Rent" took the other road and imported a year as a month. The
  // cadence words now belong to the rent matcher (rentCadence); a year is
  // carried only when the header says what it is the year OF.
  "vin", "home year", "unit year", "rv year", "year built", "yr built",
  "lease", "paid thru", "paid through", "last paid",
];

/**
 * THE CADENCE A RENT HEADER STATES. "Monthly Rent" and "Weekly Rent" become
 * the row's inferred term. "Annual Rent", "Rent/Yr", "Quarterly Rent" become
 * a cadence the plan REFUSES: rent is filed by the month and the parser never
 * invents a value, and dividing by twelve is inventing one — a roster does
 * not say the year was twelve equal months. Word-bounded on the normalised
 * header, so "yr" cannot hide inside another word.
 */
const YEARLY_RE = /\b(annual|annually|annum|yearly|year|yr)\b/;
const QUARTERLY_RE = /\b(quarterly|quarter|qtr)\b/;
export function rentCadence(normalisedHeader: string): HeaderCadence | undefined {
  const h = normalisedHeader;
  if (h.includes("month")) return "monthly";
  if (h.includes("week")) return "weekly";
  if (YEARLY_RE.test(h)) return "annual";
  if (QUARTERLY_RE.test(h)) return "quarterly";
  return undefined;
}

/** Words a cell puts around its cadence — not part of it. */
const CADENCE_FILLER = new Set([
  "rent", "lot", "site", "space", "per", "amount", "figure", "rate", "base",
  "paid", "billing", "billed", "term", "period",
]);

/**
 * WHAT A TERM CELL SAYS, read the one way the parser and the plan both use.
 *
 * ONE word, once the filler is gone: a real term by its first five letters
 * or whole ("Month", "Monthly", "Annua", "Seasonal"); a cadence word the
 * term list does not spell ("Yearly", "Per annum", "Qtr"); "mo" as the
 * abbreviation everybody writes. Undefined is a cell that names no cadence
 * we can read — a lease length, a date range, a tick — and also one that
 * names MORE than a cadence: "Bi-monthly", "Semi-annual", "Every 3 months"
 * used to read as a stated month or a stated year by substring, and neither
 * is true.
 */
const TERMS: readonly Term[] = ["nightly", "weekly", "monthly", "seasonal", "annual"];
export function cellCadence(text: string): Term | "quarterly" | undefined {
  const words = norm(text).split(" ").filter((w) => w && !CADENCE_FILLER.has(w));
  if (words.length !== 1) return undefined;
  const w = words[0];
  const found = TERMS.find((x) => w === x || w.startsWith(x.slice(0, 5)));
  if (found) return found;
  const said = rentCadence(w);
  if (said) return said;
  if (w.includes("mo")) return "monthly";
  return undefined;
}

/**
 * A CELL THAT SAYS YES OR NO IS NOT A CADENCE. A tick in a "Billing" column
 * states nothing about how often the rent is due; treating it as a cadence
 * we could not read held the whole roll.
 */
const YES_NO_RE = /^(?:y|n|yes|no|x|✓|✔|paid|unpaid|true|false|t|f|-|—|n\/?a)$/i;

/**
 * TARGETS NOTHING READS.
 *
 * `cellAt` is called for lot, name, rent, term, email and phone — and for
 * nothing else. `moveIn` and `dueDay` were matched by header, consumed their
 * column, and were then dropped: the value never reached a field, and because
 * the column counted as a mapped FIELD it was skipped by the notes loop too.
 * So a sheet with "Move-in" and "Past Due" columns lost both, in silence, with
 * the refused-columns card on screen naming only the ones we refuse on purpose.
 *
 * A column with no reader must not consume a column. Until something reads
 * them, they carry to notes like any other column we cannot map — the owner
 * keeps his tenancy start dates and his arrears as text on the household file
 * instead of losing them.
 *
 * DELETE A NAME FROM HERE the day it gets a reader; `roll-parse.test.ts`
 * checks this list against the actual `cellAt` calls, so it cannot rot.
 */
const NO_READER: Target[] = ["moveIn", "dueDay"];

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function targetFor(header: string): { target: Target; cadence?: HeaderCadence } | "carry" | "refuse" | null {
  const h = norm(header);
  if (!h) return null;

  // FIRST, before any synonym can claim it. "SSN" must never fall through to
  // the carry list and end up in a notes field.
  if (REFUSE.some((r) => h.includes(norm(r)))) return "refuse";

  // A synonym that normalises to nothing — "#" is the one — would make
  // `h.includes("")` true for EVERY header, so the first line of the paste
  // becomes the header and the park's title becomes a tenant. Found by the
  // line-classification test doing exactly that.
  const usable = (syn: string) => { const n = norm(syn); return n.length >= 2 ? n : null; };

  for (const t of Object.keys(SYN) as Target[]) {
    for (const syn of SYN[t]) {
      // Exact match may still use the short forms — "#" as a whole header is a
      // real lot column. It is only CONTAINMENT that has to be protected.
      if (h === norm(syn)) {
        // A rent header often states the cadence. That is INFERRED, not stated
        // by a cell, and the row records it as such.
        if (t === "rent") {
          const cadence = rentCadence(h);
          return cadence ? { target: "rent", cadence } : { target: "rent" };
        }
        return NO_READER.includes(t) ? "carry" : { target: t };
      }
    }
  }
  // AN EXPLICIT CARRY BEATS A FUZZY HIT, and this used to be the other way
  // round. CARRY names "past due" deliberately — it is money the owner is owed
  // and wants to keep — but the containment pass ran first and `dueDay`'s
  // synonym "due" is a substring of it, so "Past Due" was claimed by a
  // due-day mapper and the arrears figure vanished without a note. A list that
  // says "keep this" should not lose to a substring.
  if (CARRY.some((c) => c.length >= 2 && h.includes(c))) return "carry";

  // Looser containment pass, after exact — so "Lot Rent" maps to rent, not lot.
  for (const t of ["rent", "name", "lot", "moveIn", "email", "term", "dueDay"] as Target[]) {
    if (SYN[t].some((syn) => { const n = usable(syn); return n != null && h.includes(n); })) {
      if (t === "rent") {
        const cadence = rentCadence(h);
        return cadence ? { target: "rent", cadence } : { target: "rent" };
      }
      return NO_READER.includes(t) ? "carry" : { target: t };
    }
  }
  return null;
}


// ------------------------------------------------- headerless inference ----

/**
 * WHEN THERE IS NO HEADER ROW.
 *
 * Real rolls often have none. The Pretty Lake proforma is two columns —
 * "Lot 1" and "325.00 $" — under a single merged label that does not survive
 * the paste. Without inference every one of its 20 rows came back unreadable,
 * which is a loud failure but an unhelpful one: the shape is obvious to a
 * human at a glance.
 *
 * The rule stays conservative, because the F9 trap is real: on a two-column
 * sheet of bare numbers you cannot tell a lot from a rent. So a column only
 * becomes the RENT if it actually looks like money — a currency symbol, a
 * decimal, or a thousands separator — and never merely because it is numeric.
 * When it is ambiguous we infer nothing and keep asking.
 */
function looksLikeMoney(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (!/\d/.test(t)) return false;
  // Must carry a money TELL. A bare "12" is a lot number far more often than
  // it is a rent, and guessing wrong puts the rent in the lot column.
  return /[$]/.test(t) || /\d[.,]\d{2}\b/.test(t) || /\d,\d{3}/.test(t);
}

function looksLikeLotLabel(s: string): boolean {
  const t = s.trim().replace(/^#\s*/, "").replace(/^(lot|site|space|unit|stall|pad)\s+/i, "");
  return /^[A-Za-z]{0,2}\d{1,4}[A-Za-z]?$/.test(t);
}

function looksLikeName(s: string): boolean {
  const t = s.trim();
  if (t.length < 3) return false;
  if (looksLikeMoney(t) || looksLikeLotLabel(t)) return false;
  if (isPlaceholderName(t)) return false;
  // Two words, or "Surname, Given" — the two shapes a roll writes people in.
  return /[A-Za-z]{2}/.test(t) && (/\s/.test(t) || t.includes(","));
}

export interface InferredColumns {
  index: Partial<Record<Target, number>>;
  why: string;
}

/**
 * Infer the column map from the BODY of the sheet. Returns null when the shape
 * is not clear enough to act on — null means "keep asking", which is always an
 * available and honest answer.
 */
export function inferColumns(bodyRows: readonly string[][]): InferredColumns | null {
  const width = Math.max(0, ...bodyRows.map((r) => r.length));
  if (width < 2 || bodyRows.length < 3) return null;

  const frac = (col: number, pred: (s: string) => boolean) => {
    const cells = bodyRows.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    if (cells.length === 0) return 0;
    return cells.filter(pred).length / cells.length;
  };

  const score = Array.from({ length: width }, (_, c) => ({
    col: c,
    money: frac(c, looksLikeMoney),
    lot: frac(c, looksLikeLotLabel),
    name: frac(c, looksLikeName),
  }));

  const pick = (key: "money" | "lot" | "name", taken: Set<number>) => {
    const best = score
      .filter((s) => !taken.has(s.col))
      .sort((a, b) => b[key] - a[key])[0];
    return best && best[key] >= 0.6 ? best.col : undefined;
  };

  const taken = new Set<number>();
  const index: Partial<Record<Target, number>> = {};

  const rentCol = pick("money", taken);
  if (rentCol !== undefined) { index.rent = rentCol; taken.add(rentCol); }

  const lotCol = pick("lot", taken);
  if (lotCol !== undefined) { index.lot = lotCol; taken.add(lotCol); }

  const nameCol = pick("name", taken);
  if (nameCol !== undefined) { index.name = nameCol; taken.add(nameCol); }

  // A lot column is the ONE thing worth inferring on its own. Without it there
  // is no join key and nothing downstream works.
  if (index.lot === undefined) return null;

  const parts: string[] = [`column ${index.lot + 1} is the lot`];
  if (index.name !== undefined) parts.push(`column ${index.name + 1} is the name`);
  if (index.rent !== undefined) parts.push(`column ${index.rent + 1} is the rent`);

  return { index, why: parts.join(", ") };
}

// ------------------------------------------------------------ line kinds ---

const TOTALS_RE = /^\s*(total|totals|sum|grand total|subtotal)\b/i;
const PAGE_RE = /^\s*(page\s+\d+\s+of\s+\d+|page\s+\d+)\s*$/i;
const VACANT_RE = /\b(vacant|empty|available|open|unoccupied|no tenant|for rent)\b/i;
const FACILITY_RE = /\b(office|shop|laundry|clubhouse|storage|maintenance|shed|pool|dumpster|common)\b/i;

/**
 * A lot number with nothing else on the line. NOT the same as declared-vacant:
 * silence means the seller told us nothing, which is the number worth walking.
 *
 * ACCEPTS THE WORD IN FRONT OF IT. The first version matched a bare "3" but not
 * "Lot 3" — and "Lot 3" is how a human actually writes it. Checked against the
 * real Pretty Lake roll, where lots 3 and 22-25 are each written exactly that
 * way: every one of them fell through to `unparsed` and THE WALK LIST CAME BACK
 * EMPTY. The walk list is the one output he could not have produced himself,
 * so losing it silently is the worst failure this parser has.
 */
const BARE_LOT_RE =
  /^\s*(?:#\s*|(?:lot|site|space|unit|stall|pad)\s+)?([A-Za-z]{0,2}\d{1,4}[A-Za-z]?)\s*$/i;

/**
 * A row that is just money — the last line of a column of amounts, with no
 * "TOTAL" label in front of it. Spreadsheets produce this constantly: the
 * label lives in a merged cell one column over and does not survive the paste.
 * Without this the seller's own arithmetic is never checked.
 */
const BARE_MONEY_RE = /^[\s\t]*\$?\s*[\d,]+(?:\.\d{1,2})?\s*\$?\s*$/;

// --------------------------------------------------------------- helpers ---

/** Is every remaining line blank? Used to tell a trailing total from a row we
 *  simply could not read. */
function isLastContentLine(lines: readonly string[], idx: number): boolean {
  for (let j = idx + 1; j < lines.length; j++) if (lines[j].trim()) return false;
  return true;
}

/** FNV-1a over the normalised blob. Cheap, deterministic, and enough to catch
 *  the same list pasted twice — which without it creates 158 tenant files. */
export function contentHash(blob: string): string {
  const s = blob.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function detectDelimiter(lines: string[]): Delimiter {
  const sample = lines.filter((l) => l.trim()).slice(0, 60);
  if (sample.length === 0) return "none";

  // Score each candidate over the lines that HAVE it, then take the best.
  //
  // A fixed threshold across all lines does not work, and the line-
  // classification test proved it: in a real roll, "VACANT", a bare lot
  // number, "OFFICE" and "TOTAL" legitimately carry no delimiter at all, so a
  // perfectly good tab-separated paste scored 0.5 and fell through to "none" —
  // at which point every line became a tenant.
  const share = (re: RegExp) => sample.filter((l) => re.test(l)).length / sample.length;

  const scores: [Delimiter, number][] = [
    ["tab", share(/\t/)],
    ["pipe", share(/\|/)],
    // Multi-space BEFORE comma at equal score: a PDF paste is space-aligned and
    // often contains commas inside names ("Reyes, Donna"), and splitting on the
    // comma cuts a person in half.
    ["multispace", share(/ {2,}/)],
    ["comma", share(/,/)],
  ];

  let best: Delimiter = "none";
  let bestScore = 0;
  for (const [d, sc] of scores) {
    if (sc > bestScore) { best = d; bestScore = sc; }
  }
  // A third of the lines is enough — the rest are the vacants, the totals and
  // the bare lot numbers, which are supposed to look different.
  return bestScore >= 0.34 ? best : "none";
}

/**
 * ============ A NAME WITH A COMMA IN IT ============
 *
 * Rent rolls write names "Wexler, Donna". A spreadsheet saving that to CSV
 * quotes the field — `1,"Wexler, Donna",385,300,4/1/15` — and a naive split on
 * commas turns one row into six cells instead of five:
 *
 *   lot  "1"          correct
 *   name '"Wexler'    truncated
 *   rent 'Donna"'     -> null, "We couldn't read that as an amount"
 *   ...and EVERY COLUMN AFTER THE NAME SHIFTS BY ONE. Her $385 rent lands in
 *   the deposit note and her $300 deposit lands in the move-in date.
 *
 * It is silent. The row still parses, still shows a lot number, and still has
 * a name that looks nearly right. Twenty-one of those is a rent roll that is
 * wrong in a way nobody would catch by glancing at it.
 *
 * This never bit before because the screen only took a PASTE, and pasting from
 * a spreadsheet gives TAB-separated cells, which are not quoted. Adding a file
 * door made real CSV reachable for the first time.
 *
 * RFC 4180, and only where it is unambiguous: a quote opens a field ONLY as
 * that field's first character, `""` inside a quoted field is a literal quote,
 * and an unterminated quote falls back to the old naive split for that line —
 * so a stray `"` in somebody's note can never make a line worse than it was.
 */
function splitQuoted(line: string, sep: string): string[] {
  const out: string[] = [];
  let cell = "";
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { out.push(cell); break; }
    const ch = line[i];
    if (ch === '"' && cell === "") {
      // A quoted field. Read to the closing quote, "" meaning one quote.
      let j = i + 1;
      let val = "";
      let closed = false;
      while (j < line.length) {
        if (line[j] === '"') {
          if (line[j + 1] === '"') { val += '"'; j += 2; continue; }
          closed = true; j += 1; break;
        }
        val += line[j]; j += 1;
      }
      // Unbalanced: give up on the whole line rather than guess.
      if (!closed) return line.split(sep);
      cell = val;
      // Anything between the closing quote and the next separator is junk we
      // keep, so nothing is silently dropped.
      while (j < line.length && line[j] !== sep) { cell += line[j]; j += 1; }
      i = j;
      continue;
    }
    if (ch === sep) { out.push(cell); cell = ""; i += 1; continue; }
    cell += ch; i += 1;
  }
  return out;
}

export function splitLine(line: string, d: Delimiter): string[] {
  switch (d) {
    // Tab and pipe get the same treatment: Excel quotes a TSV field too when
    // it contains a quote or a newline, and the rule is a no-op otherwise.
    case "tab":        return splitQuoted(line, "\t");
    case "pipe":       return splitQuoted(line, "|");
    case "multispace": return line.split(/ {2,}/);
    case "comma":      return splitQuoted(line, ",");
    case "none":       return [line];
  }
}

/**
 * Money, with the distinction the attack run said mattered most:
 * PRESENT-BUT-REFUSED is not the same as ABSENT. An absent rent is fine and
 * silent; a rent we saw and could not read must stop the row, or the receipt
 * quietly reads $0 and the owner believes the seller lied.
 */
export function parseMoney(raw: string): Field<number> {
  const s = (raw ?? "").trim();
  if (!s || /^(n\/?a|-|—|none|tbd|\?)$/i.test(s)) return unknownField<number>(s);

  // A European decimal comma changes the number by a factor of 100. Refuse it
  // rather than pick — 1.250,00 and 1,250.00 are the same glyphs.
  if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(s)) {
    return unknownField<number>(s, "This looks like it uses a comma for the decimal — is it 1,250.00?");
  }
  // Phone-shaped. A phone parsed as money is a rent of $2,605,550,142.
  if (/^\+?\d{3}[-. ]\d{3}[-. ]\d{4}$/.test(s) || /^\(\d{3}\)/.test(s)) {
    return unknownField<number>(s, "That looks like a phone number, not a rent.");
  }
  if (/e\+?\d+$/i.test(s)) {
    return unknownField<number>(s, "Excel turned this into scientific notation — the original digits are gone.");
  }

  const cleaned = s.replace(/[$\s,]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    return unknownField<number>(s, "We couldn't read that as an amount.");
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return unknownField<number>(s, "We couldn't read that as an amount.");
  if (n < 0) return unknownField<number>(s, "That amount is negative.");
  // $0 is a REAL answer (a manager's lot, a family arrangement) and must not
  // block. Absurd is different.
  if (n > 100_000) return unknownField<number>(s, "That rent looks like a typo.");
  return stated(n, s);
}

/** A lot number, normalised but never invented. Leading zeros are ambiguous —
 *  "01" and "1" are different keys and only the owner knows which his park uses. */
/**
 * THE WORD A SELLER WRITES IN FRONT OF THE NUMBER.
 *
 * The Haven's own roll reads "Lot 4" on every line — `emptyLotsFrom` says so
 * in its comment, from a previous look at the real due-diligence packet. And
 * "Lot 26" matched none of his lots, because this function collapsed the
 * whitespace FIRST ("LOT26") and then compared that against "26".
 *
 * `normaliseLotLabel` in import-helpers has always known about the word — it
 * strips it before removing the space, so its `\b` fires. Two matchers, one
 * of which knew "Lot" was a word. Every row of a "Lot n" roll came back
 * `lot_unknown`, and the only control the review screen offers for that is
 * "Create lot LOT26" — twenty-one times, leaving 42 lots where 21 exist, and
 * halving the denominator every shared cost is divided by.
 *
 * Stripped BEFORE the shape check too: that check allowed three leading
 * letters, so "Lot 6" squeaked through and "Space 6" did not.
 */
// NOT `\b` after the word. There is no word boundary between "t" and "2", so
// `\b` strips "Lot 26" and leaves "Lot26" — which is exactly how the old
// matcher failed. A lookahead for the digit does both, and refuses to strip
// anything that is not a lot label ("Lotus" keeps its Lot).
export const LOT_WORDS = ["lot", "site", "space", "unit", "stall", "pad"] as const;
export const LOT_WORD = new RegExp(`^(?:${LOT_WORDS.join("|")})[\\s.:#-]*(?=\\d)`, "i");

export function parseLot(raw: string, knownLots?: readonly string[]): Field<string> {
  const s = (raw ?? "").trim().replace(/^#\s*/, "");
  if (!s) return unknownField<string>(raw ?? "");

  const bare = s.replace(LOT_WORD, "").trim();
  if (!/^[A-Za-z]{0,3}[-\s]?\d{1,4}[A-Za-z]?$/.test(bare)) {
    return unknownField<string>(s, "We couldn't tell if that's a lot number.");
  }
  const tidy = bare.replace(/\s+/g, "").toUpperCase();

  if (knownLots && knownLots.length > 0) {
    // THE WHOLE LABEL FIRST. A park that has genuinely stored a lot as "LOT26"
    // must still win against its own spelling before we try the stripped form.
    const whole = s.replace(/\s+/g, "").toUpperCase();
    const exact = knownLots.find((k) => k.toUpperCase() === whole)
               ?? knownLots.find((k) => k.toUpperCase() === tidy);
    if (exact) return stated(exact, s);
    // A leading zero is the classic ambiguity: 01 vs 1.
    const loose = knownLots.filter((k) => k.replace(/^0+/, "").toUpperCase() === tidy.replace(/^0+/, ""));
    if (loose.length === 1) return inferred(loose[0], s, `Matched lot ${loose[0]}.`);
    if (loose.length > 1) return unknownField<string>(s, "More than one lot could match this.", loose);
    return unknownField<string>(s, "There's no lot with that number in your park yet.");
  }
  return stated(tidy, s);
}

/**
 * THINGS THAT ARE NOT PEOPLE BUT SATISFY `display_name text not null`.
 *
 * This is the trap the whole name column sits on: the database will accept
 * "SEE NOTE" as a tenant and then it is a person forever, on a lease, in a
 * rent-due text, on the wall of the office. Every one of these appears in real
 * seller rolls.
 *
 * MATCHED AGAINST THE WHOLE CELL, never as a substring — "Sameer" contains
 * "same" and "Seenath" contains "see", and refusing a real person's name is a
 * worse failure than accepting a placeholder.
 */
const NOT_A_PERSON = new Set([
  "same", "same as above", "ditto", "do", "as above", "see note", "see notes",
  "n/a", "na", "n.a.", "none", "no name", "unknown", "unk", "tbd", "tba",
  "vacant lot", "blank", "empty", "?", "??", "???", "-", "--", "---", ".",
  "total", "totals", "subtotal", "sub total", "grand total", "total lot rent",
  "tenant", "renter", "resident", "name", "occupant", "lessee",
  "deceased", "estate", "owner", "mgmt", "management", "park", "rental",
]);

/** Excel's own error values, which paste as text and look authoritative. */
const EXCEL_POISON_RE = /^#(ref|n\/a|value|div\/0|name|null|num|spill|calc)[!?]?$/i;

/** "SEE NOTE — son living in home, mother in nursing home since Feb". */
const SEE_SOMETHING_RE = /^see\s+(note|notes|above|below|attached|attachment|lease|file|memo|comment)\b/i;

/**
 * A UNIT THE PARK ITSELF OWNS IS NOT A HOUSEHOLD.
 *
 * The Haven's Lot 11 is the park-owned home, and "PARK OWNED HOME" walked
 * straight through this guard: NOT_A_PERSON matches the WHOLE cell, and it
 * holds "park" and "owner" but not the phrase. So the roll filed a household
 * called PARK OWNED HOME, on a lease, on a rent-due text, on the office wall —
 * which is the precise failure this guard exists to prevent.
 *
 * REQUIRES A SEPARATOR AND A NOUN, not a loose prefix. "Park" is a surname:
 * "Park, Owen" and "Park Owens" must both survive, and they do — the comma
 * fails `[\s-]+`, and "owen" is not "own".
 */
const PARK_OWNED_RE =
  /^(park|company|corporate|landlord|management|mgmt)[\s-]+(owned|own|model|unit|home|house|trailer|rental)\b/i;

export function isPlaceholderName(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
  if (!t) return true;
  if (NOT_A_PERSON.has(t)) return true;
  if (EXCEL_POISON_RE.test(t)) return true;
  if (SEE_SOMETHING_RE.test(t)) return true;
  if (PARK_OWNED_RE.test(t)) return true;
  return false;
}

/** A name is taken VERBATIM. We never reorder "Reyes, Donna" — guessing which
 *  half is the surname is how a whole park imports backwards. */
/**
 * AN EMAIL, OR NOTHING.
 *
 * No cleverness: an address we half-guessed is an invite sent to a stranger, or
 * to nobody. Anything that does not read as an address comes back unknown with
 * the raw text preserved, and the reconcile screen shows it to the owner.
 */
export function parseEmail(raw: string): Field<string> {
  const s = (raw ?? "").trim();
  if (!s || /^(n\/?a|-|—|none|tbd|\?)$/i.test(s)) return unknownField<string>(s);

  // Rolls exported from park software often carry two, comma-separated. Taking
  // the first silently would pick a spouse at random; ask instead.
  const parts = s.split(/[,;/]| or /i).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    const valid = parts.filter((x) => EMAIL_RE.test(x));
    return unknownField<string>(s, "There's more than one address here — which one?", valid);
  }

  if (!EMAIL_RE.test(s)) {
    return unknownField<string>(s, "That doesn't look like an email address.");
  }
  return stated(s.toLowerCase(), s);
}

/**
 * A PHONE NUMBER THE PARK HAS ON FILE.
 *
 * Stored so the office can read it. NEVER normalised into `mobile_e164` and
 * never dialled or texted by anything — see `phone_on_file_with_park`. Kept as
 * ten digits so two spellings of the same number are one number.
 */
export function parsePhone(raw: string): Field<string> {
  const s = (raw ?? "").trim();
  if (!s || /^(n\/?a|-|—|none|tbd|\?)$/i.test(s)) return unknownField<string>(s);

  const digits = s.replace(/\D/g, "");
  // A leading 1 is the country code, not an area code.
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

  if (ten.length !== 10) {
    return unknownField<string>(s, "That doesn't look like a ten-digit phone number.");
  }
  return stated(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`, s);
}

const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[a-z]{2,}$/i;
/** A whole cell that is nine digits grouped 3-2-4, separators optional. */
const SSN_RE = /^\d{3}[-. ]?\d{2}[-. ]?\d{4}$/;

/**
 * SSN-shaped runs ANYWHERE IN A LINE, for redaction before storage.
 *
 * Both separators are required here, unlike the whole-cell test. A bare nine
 * digits inside a longer line is too often a zip+4 or an account number, and a
 * ZIP written 46703-1234 matches a lax 3-2-4 pattern — redacting addresses
 * would make the reconcile screen useless.
 */
const SSN_IN_LINE = /\b\d{3}[-. ]\d{2}[-. ]\d{4}\b/g;

/**
 * WHAT WE REFUSE TO KEEP, REMOVED BEFORE ANYTHING IS WRITTEN DOWN.
 *
 * Refusing the SSN COLUMN was not enough. `park_import_batches.raw_text` stores
 * the pasted blob verbatim and every row keeps its own source line, so a social
 * security number was dropped from the parsed fields and then filed twice in
 * full. A rule that only removes a value from the tidy copy, while the untidy
 * copy is what actually gets stored, is not a rule.
 *
 * Applied to every line as it is read and to the blob before it is saved.
 */
export function redactSensitive(text: string): string {
  return text.replace(SSN_IN_LINE, "[not imported]");
}

export function parseName(raw: string): Field<string> {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return unknownField<string>(raw ?? "");
  if (VACANT_RE.test(s) || FACILITY_RE.test(s)) {
    return unknownField<string>(s, "That doesn't look like a person's name.");
  }
  // Placeholders satisfy every other test we could write — they are the right
  // length, they are made of letters, and they are not people.
  if (isPlaceholderName(s)) {
    return unknownField<string>(s, `"${s}" isn't a person, so we won't file it as one.`);
  }
  if (!/[A-Za-z]{2}/.test(s)) return unknownField<string>(s, "That doesn't look like a name.");
  return stated(s, s);
}

// ---------------------------------------------------------------- parse ----

export function parseRentRoll(blob: string, opts: ParseOptions = {}): ParseResult {
  const rawLines = (blob ?? "").replace(/\r\n?/g, "\n").split("\n");
  const total = rawLines.length;

  const rows: ParsedRow[] = [];
  const vacantDeclared: OtherLine[] = [];
  const silentLots: OtherLine[] = [];
  const facilities: OtherLine[] = [];
  const totals: OtherLine[] = [];
  const skipped: OtherLine[] = [];
  const unparsed: OtherLine[] = [];
  const blockQuestions: BlockQuestion[] = [];

  const delimiter = detectDelimiter(rawLines);

  // --- header ---
  let headerLine: number | null = null;
  let headerCells: string[] = [];
  for (let i = 0; i < Math.min(rawLines.length, 15); i++) {
    const cells = splitLine(rawLines[i], delimiter).map((c) => c.trim());
    const hits = cells.filter((c) => targetFor(c) !== null).length;
    // A title line above the header is common; require two recognised columns
    // so "Pretty Lake MHP — Rent Roll" does not become the header.
    if (hits >= 2) { headerLine = i + 1; headerCells = cells; break; }
  }

  // --- column map ---
  const roles: ColumnMap["roles"] = [];
  const index: Partial<Record<Target, number>> = {};
  const unrecognised: string[] = [];
  const refused: string[] = [];
  /**
   * EVERY COLUMN THAT CLAIMS THE NAME, in order.
   *
   * "First Name" and "Last Name" both hit the `name` synonym list, only the
   * first index was kept, and the second column's role was still `field` — so
   * the notes loop skipped it too. A roll in that very ordinary shape imported
   * twenty-one households called "Donna", "Ray", "Ana", with verdict READY and
   * nothing asked. Those first names are what would print on the 1 January
   * leases and every letter after them.
   */
  const nameCols: { i: number; label: string }[] = [];

  headerCells.forEach((label, i) => {
    const t = targetFor(label);
    if (t === null) { roles.push({ kind: "unrecognised", label }); unrecognised.push(label); return; }
    // Not carried, not mapped, not kept. The cell is never read again.
    if (t === "refuse") { roles.push({ kind: "refused", label }); refused.push(label); return; }
    if (t === "carry") { roles.push({ kind: "carry", label }); return; }

    if (t.target === "name") nameCols.push({ i, label });

    // A SECOND COLUMN CLAIMING A TAKEN TARGET IS NOT A FIELD. Left as one it
    // is read by nothing and skipped by the notes loop — the cell simply
    // disappears. The name pair is the exception: it is composed below rather
    // than carried, so it does not arrive twice.
    if (index[t.target] !== undefined) {
      if (t.target !== "name") { roles.push({ kind: "carry", label }); return; }
      roles.push({ kind: "field", target: t.target, ...(t.cadence ? { cadence: t.cadence } : {}) });
      return;
    }

    roles.push({ kind: "field", target: t.target, ...(t.cadence ? { cadence: t.cadence } : {}) });
    index[t.target] = i;
  });
  // NO HEADER? Infer the shape from the body rather than giving up. Reported,
  // never silent — the screen says what we guessed and lets him correct it.
  let inferredWhy: string | null = null;
  if (headerLine === null) {
    const body = rawLines
      .map((l) => splitLine(l, delimiter).map((c) => c.trim()))
      .filter((cells) => cells.some((c) => c) && cells.length > 1);
    const guess = inferColumns(body);
    if (guess) {
      inferredWhy = guess.why;
      for (const [target, col] of Object.entries(guess.index)) {
        if (index[target as Target] === undefined) index[target as Target] = col as number;
      }
    }

    /**
     * AND GIVE EVERY COLUMN A ROLE, which is what makes the rest of this file
     * work.
     *
     * `roles` is built from header cells, so a headerless roll left it EMPTY.
     * The per-cell loop below — the one that carries unmapped columns to notes
     * AND infers an email or a phone from an unnamed column — iterates
     * `roles`, so on a headerless roll it did nothing at all. Every column
     * past the inferred three was discarded in silence, including every email
     * and every phone number.
     *
     * That loop's own comment says it is there for rolls that "arrive with
     * 'Contact', 'Info', or no header at all". It was written for this case
     * and could not reach it.
     *
     * Email plus phone is the stated prerequisite for the 1 January leases,
     * and a headerless roll — a printout, a phone list, anything without a
     * title row — is exactly the shape a seller's own list arrives in.
     */
    const widest = rawLines
      .map((l) => splitLine(l, delimiter).map((c) => c.trim()))
      .reduce((n, cells) => Math.max(n, cells.length), 0);
    const byIndex = new Map<number, Target>();
    for (const [target, col] of Object.entries(index)) byIndex.set(col as number, target as Target);
    for (let i = 0; i < widest; i += 1) {
      const t = byIndex.get(i);
      roles.push(t ? { kind: "field", target: t } : { kind: "unrecognised", label: "" });
    }
  }

  const columns: ColumnMap = { roles, index, unrecognised, refused };

  // THE BLOCK QUESTIONS. Asked ONCE for the whole paste, not silently per row.
  // The attack run's worst finding: a header reading "Unit" instead of "Lot"
  // produced 79 rows with no lot number, all rendered green, all silently
  // discarded at commit. A missing REQUIRED column makes every row an ask.
  const noLotColumn = index.lot === undefined;
  const noNameColumn = index.name === undefined;
  if (headerLine === null) {
    blockQuestions.push(
      inferredWhy
        ? {
            code: "COLUMNS_INFERRED",
            // Not a blocker — a disclosure. He can see the paste beside this
            // and correct it in one look.
            question: `This list has no header row, so we went by what the columns look like: ${inferredWhy}. Change it if that's not right.`,
          }
        : {
            code: "NO_HEADER",
            question: "We couldn't find a header row. Which column is the lot number, and which is the name?",
          },
    );
  }
  if (noLotColumn) {
    blockQuestions.push({
      code: "NO_LOT_COLUMN",
      question: "None of these columns look like a lot number. Which one is it?",
    });
  }
  if (noNameColumn) {
    blockQuestions.push({
      code: "NO_NAME_COLUMN",
      question: "None of these columns look like a tenant name. Which one is it?",
    });
  }
  if (index.rent === undefined) {
    // NOT a block: a roll with no rent column is a real thing, and rent is
    // allowed to stay blank forever. But say so, or the receipt reads $0 and
    // he thinks the seller lied.
    blockQuestions.push({
      code: "NO_RENT_COLUMN",
      question: "We didn't find a rent column, so nobody will have a rent. Is that right?",
    });
  }

  const rentRole = roles.find((r) => r.kind === "field" && r.target === "rent");
  const headerCadence = rentRole && rentRole.kind === "field" ? rentRole.cadence : undefined;
  const rentHeaderLabel = index.rent !== undefined ? (headerCells[index.rent] ?? "").trim() : "";
  const termHeaderLabel = index.term !== undefined
    ? ((headerCells[index.term] ?? "").trim() || `column ${index.term + 1}`)
    : "";
  /** The term cells we could not read as a cadence, with a figure beside them. */
  const termUnread: { first: string; rows: number } = { first: "", rows: 0 };
  /** Term cells that contradict a monthly or weekly rent header, with a figure
   *  beside them — and the header's own word, so the card says which. */
  const termConflicts: { first: string; word: string; rows: number } = { first: "", word: "", rows: 0 };
  /** Term cells saying yearly or quarterly under a rent header that says nothing. */
  const termNotMonthly: { first: string; word: string; rows: number } = { first: "", word: "", rows: 0 };

  // A RENT COLUMN THAT IS NOT MONTHLY IS SAID ONCE, AT THE TOP. Rent is filed
  // by the month; a yearly or quarterly column is a figure we will not divide,
  // because his sheet does not say the year was twelve equal months. Every row
  // under it is held for the monthly rent, and this is where he learns why
  // before he reaches eighteen identical questions. Not a "try again": the
  // column is read fine, and the answer is a number only he has.
  if (headerCadence === "annual" || headerCadence === "quarterly") {
    const word = headerCadence === "annual" ? "yearly" : "quarterly";
    blockQuestions.push({
      code: "RENT_NOT_MONTHLY",
      question:
        `The rent column is a ${word} figure ("${rentHeaderLabel}"). Rent is filed by the month ` +
        `and we won't divide a ${word} number into one — nothing from that column goes in ` +
        `until you give each household's monthly rent.`,
    });
  }

  // --- lines ---
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = rawLines[i];
    const text = line.trim();

    if (headerLine !== null && lineNo === headerLine) { skipped.push({ lines: [lineNo], text, why: "header" }); continue; }
    if (!text) { skipped.push({ lines: [lineNo], text: line, why: "blank" }); continue; }
    if (PAGE_RE.test(text)) { skipped.push({ lines: [lineNo], text, why: "page marker" }); continue; }
    if (TOTALS_RE.test(text)) { totals.push({ lines: [lineNo], text }); continue; }
    // A bare amount, and it is the LAST thing on the sheet: a totals row that
    // lost its label. Only at the end — a bare amount in the middle is a row we
    // failed to read, and calling that a total would hide it.
    if (BARE_MONEY_RE.test(text) && isLastContentLine(rawLines, i)) {
      totals.push({ lines: [lineNo], text, why: "an unlabelled total" });
      continue;
    }
    // A repeated header mid-data (PDF page breaks).
    if (headerLine !== null && norm(text) === norm(rawLines[headerLine - 1])) {
      skipped.push({ lines: [lineNo], text, why: "repeated header" }); continue;
    }
    if (headerLine !== null && lineNo < headerLine) {
      skipped.push({ lines: [lineNo], text, why: "title" }); continue;
    }

    const bare = BARE_LOT_RE.exec(text);
    if (bare) { silentLots.push({ lines: [lineNo], text }); continue; }

    const cells = splitLine(line, delimiter).map((c) => c.trim());
    const cellAt = (t: Target) => (index[t] !== undefined ? (cells[index[t]!] ?? "") : "");

    /**
     * The whole name, however many columns the seller split it across.
     *
     * Joined in COLUMN ORDER, unless the first of them says it is the
     * surname — "Last Name, First Name" is as common on a rent roll as the
     * other way round, and "Wexler Donna" is not a person's name.
     */
    const nameCell = (): string => {
      if (nameCols.length < 2) return cellAt("name");
      const parts = nameCols.map((c) => (cells[c.i] ?? "").trim());
      const given = parts.filter(Boolean);
      if (given.length < 2) return given[0] ?? "";
      const surnameFirst = /\b(last|sur)/i.test(nameCols[0].label);
      return surnameFirst ? `${given[0]}, ${given[1]}` : given.join(" ");
    };

    if (FACILITY_RE.test(text) && !cellAt("name")) {
      facilities.push({ lines: [lineNo], text }); continue;
    }
    if (VACANT_RE.test(text)) {
      vacantDeclared.push({ lines: [lineNo], text }); continue;
    }

    // Not enough structure to be a row.
    if (cells.filter(Boolean).length < 2 && delimiter !== "none") {
      unparsed.push({ lines: [lineNo], text, why: "We couldn't split this into columns." });
      continue;
    }

    const lot = noLotColumn ? unknownField<string>("") : parseLot(cellAt("lot"), opts.knownLots);
    const name = noNameColumn ? unknownField<string>("") : parseName(nameCell());
    const rent = index.rent === undefined ? unknownField<number>("") : parseMoney(cellAt("rent"));

    /**
     * THE TERM: the cell, the header, or neither — and the header is the
     * stronger evidence.
     *
     * A cell we cannot read as a cadence ("12", "Jan-Mar", a tick) used to
     * beat a header that said "Monthly Rent" and hold the row; a cell that
     * said "Monthly" used to beat a header that said "Annual Rent" and file
     * the year as a month. Now: a yes/no states nothing; a cell that names a
     * cadence is read, unless it contradicts a yearly or quarterly header, in
     * which case neither is trusted and the row asks; a cell that names none
     * takes the header's cadence and is kept in the notes; and only a cell
     * that names none under a header that says none is held as unreadable —
     * said once at the top, as well as on the row.
     */
    let term: Field<Term> = unknownField<Term>("");
    let cadenceConflict: ParsedRow["cadenceConflict"];
    const rawTerm = cellAt("term").trim();
    const termCell = YES_NO_RE.test(rawTerm) ? "" : rawTerm;
    /** A term-cell reading that is kept as a note rather than obeyed. */
    let termCellNote = false;
    const cadenceWordOf = (c: HeaderCadence | Term) =>
      c === "annual" ? "yearly" : c === "quarterly" ? "quarterly" : c;
    const said = termCell ? cellCadence(termCell) : undefined;
    if (termCell && said) {
      const shortSide = (c: HeaderCadence | Term) => c === "monthly" || c === "weekly" || c === "nightly";
      const longSide = (c: HeaderCadence | Term) => c === "annual" || c === "quarterly";
      // Under a yearly or quarterly header ANY cell that is not itself yearly
      // or quarterly disagrees — "Seasonal" included. It is neither short nor
      // long, and sorting only those two let it through as a STATED season:
      // on a park with a season set the row went in as a seasonal tenancy at
      // the yearly figure, under a card promising nothing from that column
      // would. Under a monthly or weekly header only a long cell disagrees;
      // a seasonal or weekly cell there is the cell's own term, as before.
      const disagree = headerCadence !== undefined
        && ((longSide(headerCadence) && !longSide(said)) || (shortSide(headerCadence) && longSide(said)));
      if (disagree) {
        // The header says a year and the cell says a month, or the other
        // way round. One of them is wrong and the sheet does not say which;
        // the row asks for the monthly rent, and the plan reads this shape
        // as a sheet that contradicts itself — never as "we couldn't tell".
        const h = cadenceWordOf(headerCadence!);
        term = unknownField<Term>(termCell, `The column header says ${h} but this cell says ${cadenceWordOf(said)}.`);
        cadenceConflict = { header: rentHeaderLabel, cell: termCell };
        // THE WORD SURVIVES. Once he types the monthly rent this row files
        // as a monthly tenancy, and `term.raw` is written nowhere — so
        // "Seasonal" under a yearly header reached no column at all, and
        // the office could not see on the file why the seller called the
        // household seasonal while it was billed through the winter. The
        // cell is kept in the notes, in the column's own words, as the
        // unreadable-cell path below already keeps its cell.
        termCellNote = true;
        if (shortSide(headerCadence!) && rent.value != null) {
          if (!termConflicts.first) { termConflicts.first = termCell; termConflicts.word = h; }
          termConflicts.rows += 1;
        }
      } else {
        if (said === "quarterly") {
          // No quarterly term exists and never will (rent goes monthly). The
          // cell is the raw; the plan reads an unknown term WITH a raw as
          // "we saw a cadence and could not file it".
          term = unknownField<Term>(termCell, "This cell says these are quarterly figures.");
        } else if (norm(termCell).startsWith(said.slice(0, 5))) {
          // "Monthly", "Month", "Annually": the term's own word.
          term = stated(said, termCell);
        } else {
          // "Yearly", "Per mo", "Qtr rent": a synonym we read into a term.
          term = inferred(said, termCell, `Read as ${said}.`);
        }
        // A yearly or quarterly CELL under a header that says nothing is the
        // yearly-column case arriving one row at a time; counted so it is
        // said once at the top, as the header case is.
        if (longSide(said) && headerCadence === undefined && rent.value != null) {
          if (!termNotMonthly.first) { termNotMonthly.first = termCell; termNotMonthly.word = cadenceWordOf(said); }
          termNotMonthly.rows += 1;
        }
      }
    } else if (termCell && (headerCadence === "monthly" || headerCadence === "weekly" || headerCadence === "annual")) {
      term = inferred(
        headerCadence, termCell,
        `The rent column said "${headerCadence}"; we couldn't read "${termCell}" as how often it's paid.`,
      );
      termCellNote = true;
    } else if (termCell && headerCadence === "quarterly") {
      term = unknownField<Term>(rentHeaderLabel, "The rent column says these are quarterly figures.");
      termCellNote = true;
    } else if (termCell) {
      term = unknownField<Term>(termCell, "We couldn't tell how often that's paid.");
      if (rent.value != null) {
        if (!termUnread.first) termUnread.first = termCell;
        termUnread.rows += 1;
      }
    } else if (headerCadence === "monthly" || headerCadence === "weekly" || headerCadence === "annual") {
      term = inferred(headerCadence, "", `The rent column said "${headerCadence}".`);
    } else if (headerCadence === "quarterly") {
      // The header is the evidence, so it is the raw.
      term = unknownField<Term>(rentHeaderLabel, "The rent column says these are quarterly figures.");
    }

    let email = index.email === undefined
      ? unknownField<string>("") : parseEmail(cellAt("email"));
    let phone = index.phone === undefined
      ? unknownField<string>("") : parsePhone(cellAt("phone"));

    // Everything mapped to carry, plus every unrecognised cell, becomes a note.
    // Nothing is thrown away silently — EXCEPT a refused column, which is
    // dropped on purpose and never touches a note.
    const notes: string[] = [];
    // A term cell the header overrode is still something the office wrote
    // down — a lease length, a period. Kept, in the column's own words.
    if (termCellNote) notes.push(`${termHeaderLabel}: ${termCell}`);
    roles.forEach((r, ci) => {
      const v = (cells[ci] ?? "").trim();
      if (!v) return;
      if (r.kind === "refused") return;

      // AN SSN CAN ARRIVE IN A COLUMN CALLED ANYTHING. The header list catches
      // "SSN"; this catches the one pasted under "Notes" or "Ref". Nine digits
      // grouped 3-2-4 is not a rent, a lot, or a phone, and we would rather
      // lose a genuine reference number than keep somebody's social.
      if (SSN_RE.test(v.trim())) {
        const where = r.kind === "field" ? `column ${ci + 1}` : (r.label || `column ${ci + 1}`);
        notes.push(`${where}: [not imported]`);
        return;
      }

      // A HEADER WE DIDN'T RECOGNISE STILL HAS A SHAPE. Rolls arrive with
      // "Contact", "Info", or no header at all, and an address or a ten-digit
      // number in an unnamed column is not ambiguous. Inferred, never stated,
      // so the screen shows it as a guess the owner can undo.
      if (r.kind === "unrecognised") {
        if (email.value == null && EMAIL_RE.test(v)) {
          email = inferred(v.toLowerCase(), v, `Read as an email address from "${r.label || `column ${ci + 1}`}".`);
          return;
        }
        if (phone.value == null) {
          const p = parsePhone(v);
          if (p.value != null) {
            phone = inferred(p.value, v, `Read as a phone number from "${r.label || `column ${ci + 1}`}".`);
            return;
          }
        }
      }

      if (r.kind === "carry") notes.push(`${r.label}: ${v}`);
      else if (r.kind === "unrecognised") notes.push(`${r.label || `column ${ci + 1}`}: ${v}`);
    });

    rows.push({
      lines: [lineNo], source: [redactSensitive(line)],
      lot, name, rent, term, email, phone, notes,
      ...(cadenceConflict ? { cadenceConflict } : {}),
      // The one writer of headerCadence: the header's own reading, on every
      // row under it, whether or not the row has a figure.
      ...(headerCadence ? { headerCadence } : {}),
      verdict: "import", askReasons: [],
    });
  }

  // A TERM COLUMN WE COULD NOT READ, WITH NO HEADER TO FALL BACK ON, is said
  // ONCE at the top — naming the column and the cell — so eighteen identical
  // row questions are not the only explanation on the screen. Only rows with
  // a figure are held, so only they are counted. Not raised beside
  // RENT_NOT_MONTHLY: a yearly header already answered the cadence.
  if (termUnread.rows > 0) {
    const n = termUnread.rows;
    blockQuestions.push({
      code: "TERM_NOT_READ",
      question:
        `We tried to read "${termUnread.first}" in the ${termHeaderLabel} column as how often rent is ` +
        `paid, and couldn't. Rent is filed by the month, so ${n === 1 ? "that row is" : `${n} rows are`} ` +
        `held until you give the monthly rent.`,
    });
  }
  // A TERM COLUMN SAYING YEARLY OR QUARTERLY under a bare "Rent" header is the
  // RENT_NOT_MONTHLY case by another route, and is said once the same way.
  if (termNotMonthly.rows > 0) {
    const n = termNotMonthly.rows;
    const word = termNotMonthly.word;
    blockQuestions.push({
      code: "TERM_NOT_MONTHLY",
      question:
        `The ${termHeaderLabel} column says the rent is ${word} ("${termNotMonthly.first}"). Rent is filed ` +
        `by the month and we won't divide a ${word} number into one — ` +
        `${n === 1 ? "that row is" : `${n} rows are`} held until you give the monthly rent.`,
    });
  }
  // AND A TERM COLUMN THAT CONTRADICTS A MONTHLY OR WEEKLY RENT HEADER,
  // likewise once — in the header's own word, since a weekly sheet's card
  // used to say "beside a monthly header" while the row's why said weekly.
  // (Under a yearly or quarterly header RENT_NOT_MONTHLY has already said
  // the column is held; a second card would be the same sentence twice.)
  if (termConflicts.rows > 0) {
    const n = termConflicts.rows;
    blockQuestions.push({
      code: "TERM_CONFLICTS",
      question:
        `The rent column ("${rentHeaderLabel}") and the ${termHeaderLabel} column disagree about how ` +
        `often rent is paid — "${termConflicts.first}" beside a ${termConflicts.word} header. We won't pick one: ` +
        `${n === 1 ? "that row is" : `${n} rows are`} held until you give the monthly rent.`,
    });
  }

  // --- duplicate LOTS, not duplicate names ---
  // The prototype grouped by name, so it caught the same person twice and never
  // the same lot twice. Two different people on lot 7 is the more common real
  // shape (a mid-year turnover), and both rows imported clean before the
  // exclusion constraint rejected one essentially at random.
  const byLot = new Map<string, ParsedRow[]>();
  for (const r of rows) {
    if (!r.lot.value) continue;
    const list = byLot.get(r.lot.value);
    if (list) list.push(r); else byLot.set(r.lot.value, [r]);
  }

  // --- verdicts ---
  for (const r of rows) {
    const why: string[] = [];
    if (noLotColumn) why.push("We don't know which column is the lot number.");
    if (noNameColumn) why.push("We don't know which column is the name.");
    if (!noNameColumn && r.name.value === null) why.push(r.name.why ?? "We couldn't read a name.");
    if (!noLotColumn && r.lot.value === null) why.push(r.lot.why ?? "We couldn't match this to a lot.");
    if ((r.lot.candidates?.length ?? 0) > 1) why.push("More than one lot could match.");
    // Rent PRESENT and refused is different from rent absent. Absent is fine.
    if (r.rent.value === null && r.rent.raw.trim() !== "") {
      why.push(r.rent.why ?? "We couldn't read the rent.");
    }
    if (r.lot.value && (byLot.get(r.lot.value)?.length ?? 0) > 1) {
      why.push(`Two rows land on lot ${r.lot.value}. Which one is current?`);
    }
    // A CADENCE WE CANNOT FILE, with a figure beside it. Rent goes monthly;
    // "annual" is a real term the biller does not read, and an unreadable
    // term cell ("Quarterly", "Twice yearly") was a why-text nothing looked at.
    // Neither becomes a monthly rent by default — the row asks for one.
    if (r.rent.value != null) {
      if (r.term.value === "annual") {
        why.push("That's a yearly figure. What's the monthly rent?");
      } else if (r.term.value === null && r.term.raw.trim() !== "") {
        why.push(`${r.term.why ?? "We couldn't tell how often that's paid."} What's the monthly rent?`);
      }
    }
    if (why.length > 0) { r.verdict = "ask"; r.askReasons = why; }
  }

  // --- the never-drop accounting, COMPUTED ---
  const seen = new Map<number, number>();
  const bump = (ls: number[]) => ls.forEach((l) => seen.set(l, (seen.get(l) ?? 0) + 1));
  rows.forEach((r) => bump(r.lines));
  [vacantDeclared, silentLots, facilities, totals, skipped, unparsed].forEach((g) => g.forEach((o) => bump(o.lines)));

  const unaccounted: number[] = [];
  const duplicated: number[] = [];
  for (let l = 1; l <= total; l++) {
    const n = seen.get(l) ?? 0;
    if (n === 0) unaccounted.push(l);
    else if (n > 1) duplicated.push(l);
  }
  if (unaccounted.length > 0) {
    // A hard question, not a field nobody reads. If we cannot account for a
    // line, the screen says so — a dropped line is a tenant who does not exist.
    blockQuestions.push({
      code: "LINES_UNACCOUNTED",
      question: `We couldn't place ${unaccounted.length} line${unaccounted.length === 1 ? "" : "s"} from your list. Nothing will be imported until you look.`,
    });
  }

  return {
    shape: {
      delimiter,
      headerLine,
      hasNameColumn: index.name !== undefined,
      columnCount: headerCells.length,
      contentHash: contentHash(blob ?? ""),
    },
    columns,
    rows,
    vacantDeclared, silentLots, facilities, totals, skipped, unparsed,
    blockQuestions,
    accounting: { totalLines: total, accounted: seen.size, unaccounted, duplicated },
    stats: {
      readable: rows.length,
      toImport: rows.filter((r) => r.verdict === "import").length,
      toAsk: rows.filter((r) => r.verdict === "ask").length,
    },
  };
}
