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

export type Target = "lot" | "name" | "rent" | "term" | "dueDay" | "moveIn" | "email";

export interface ColumnMap {
  /** One entry per column, in order. */
  roles: ({ kind: "field"; target: Target; term?: Term }
        | { kind: "carry"; label: string }
        | { kind: "unrecognised"; label: string })[];
  index: Partial<Record<Target, number>>;
  unrecognised: string[];
}

export interface ParsedRow {
  /** 1-based source lines. Always at least one. */
  lines: number[];
  source: string[];
  lot: Field<string>;
  name: Field<string>;
  rent: Field<number>;
  term: Field<Term>;
  /** Phones, balances, deposits, marginalia — carried, never mapped. */
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
  term:   ["term", "frequency", "cadence", "billing", "paid", "period"],
  dueDay: ["due", "due day", "due date", "rent due"],
  moveIn: ["move in", "move-in", "moved in", "start", "start date", "lease start", "since"],
  email:  ["email", "e-mail", "email address"],
};

/** Columns we deliberately carry to notes rather than map — they are real data
 *  the owner may want, but nothing here writes them to a field. A phone written
 *  to mobile_e164 is a text message to a stranger who never consented. */
const CARRY = [
  "phone", "cell", "mobile", "telephone", "balance", "past due", "deposit",
  "security", "pet", "pets", "notes", "note", "comment", "status", "address",
  "meter", "water", "electric", "utility", "vehicle", "make", "model", "year",
  "lease", "paid thru", "paid through", "last paid",
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function targetFor(header: string): { target: Target; term?: Term } | "carry" | null {
  const h = norm(header);
  if (!h) return null;

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
          if (h.includes("month")) return { target: "rent", term: "monthly" };
          if (h.includes("week")) return { target: "rent", term: "weekly" };
        }
        return { target: t };
      }
    }
  }
  // Looser containment pass, after exact — so "Lot Rent" maps to rent, not lot.
  for (const t of ["rent", "name", "lot", "moveIn", "email", "term", "dueDay"] as Target[]) {
    if (SYN[t].some((syn) => { const n = usable(syn); return n != null && h.includes(n); })) {
      if (t === "rent") {
        if (h.includes("month")) return { target: "rent", term: "monthly" };
        if (h.includes("week")) return { target: "rent", term: "weekly" };
      }
      return { target: t };
    }
  }
  if (CARRY.some((c) => c.length >= 2 && h.includes(c))) return "carry";
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

function splitLine(line: string, d: Delimiter): string[] {
  switch (d) {
    case "tab":        return line.split("\t");
    case "pipe":       return line.split("|");
    case "multispace": return line.split(/ {2,}/);
    case "comma":      return line.split(",");
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
export function parseLot(raw: string, knownLots?: readonly string[]): Field<string> {
  const s = (raw ?? "").trim().replace(/^#\s*/, "");
  if (!s) return unknownField<string>(raw ?? "");
  if (!/^[A-Za-z]{0,3}[-\s]?\d{1,4}[A-Za-z]?$/.test(s)) {
    return unknownField<string>(s, "We couldn't tell if that's a lot number.");
  }
  const tidy = s.replace(/\s+/g, "").toUpperCase();

  if (knownLots && knownLots.length > 0) {
    const exact = knownLots.find((k) => k.toUpperCase() === tidy);
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

export function isPlaceholderName(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
  if (!t) return true;
  if (NOT_A_PERSON.has(t)) return true;
  if (EXCEL_POISON_RE.test(t)) return true;
  if (SEE_SOMETHING_RE.test(t)) return true;
  return false;
}

/** A name is taken VERBATIM. We never reorder "Reyes, Donna" — guessing which
 *  half is the surname is how a whole park imports backwards. */
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
  headerCells.forEach((label, i) => {
    const t = targetFor(label);
    if (t === null) { roles.push({ kind: "unrecognised", label }); unrecognised.push(label); return; }
    if (t === "carry") { roles.push({ kind: "carry", label }); return; }
    roles.push({ kind: "field", target: t.target, ...(t.term ? { term: t.term } : {}) });
    if (index[t.target] === undefined) index[t.target] = i;
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
  }

  const columns: ColumnMap = { roles, index, unrecognised };

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

  const headerTerm = roles.find((r) => r.kind === "field" && r.target === "rent" && r.term);
  const impliedTerm = headerTerm && headerTerm.kind === "field" ? headerTerm.term : undefined;

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
    const name = noNameColumn ? unknownField<string>("") : parseName(cellAt("name"));
    const rent = index.rent === undefined ? unknownField<number>("") : parseMoney(cellAt("rent"));

    let term: Field<Term> = unknownField<Term>("");
    const rawTerm = cellAt("term");
    if (rawTerm) {
      const t = norm(rawTerm);
      const found = (["nightly", "weekly", "monthly", "seasonal", "annual"] as Term[])
        .find((x) => t.startsWith(x.slice(0, 5)) || t.includes(x));
      if (found) term = stated(found, rawTerm);
      else if (t.includes("mo")) term = inferred("monthly" as Term, rawTerm, "Read as monthly.");
      else term = unknownField<Term>(rawTerm, "We couldn't tell how often that's paid.");
    } else if (impliedTerm) {
      term = inferred(impliedTerm, "", `The rent column said "${impliedTerm}".`);
    }

    // Everything mapped to carry, plus every unrecognised cell, becomes a note.
    // Nothing is thrown away silently.
    const notes: string[] = [];
    roles.forEach((r, ci) => {
      const v = (cells[ci] ?? "").trim();
      if (!v) return;
      if (r.kind === "carry") notes.push(`${r.label}: ${v}`);
      else if (r.kind === "unrecognised") notes.push(`${r.label || `column ${ci + 1}`}: ${v}`);
    });

    rows.push({
      lines: [lineNo], source: [line],
      lot, name, rent, term, notes,
      verdict: "import", askReasons: [],
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
