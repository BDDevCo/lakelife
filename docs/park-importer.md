# The rent-roll importer — getting the seller's list into LakeLife

**Status:** design. Nothing built. Written 2026-08-08 after a parser prototype,
a 111-row test corpus, a garbage-input attack run, and an owner-side red team.

**Verified against the shipped repo**, not against the design docs. Every code
and schema claim below carries a `file:line` and was read. Where the corpus
documents contradict each other, or contradict the database, this file resolves
it and says which one was wrong.

---

## 1. The problem, and the one principle

The owner is buying a mobile-home / RV park on Pretty Lake. At closing he gets a
**rent roll** from the seller — who is on which lot, paying what. Until that list
is inside LakeLife and correct, he keeps using his notebook, and every other
thing we have built for parks is unreachable.

The list will not arrive as a clean CSV. It arrives as a PDF from a broker, a
printout, an emailed table from a paralegal, a text message thread, a
QuickBooks export, or a photograph of a notebook page. Often three of those at
once, disagreeing with each other.

And the mobile-home diligence literature is consistent on one point: **seller
rent rolls commonly run 10–20% inflated.** That is not an accusation, it is a
base rate. A roll can be arithmetically perfect and still describe two tenants
who moved out in April.

So the temptation — an importer that swallows the file and reports
**"79 rows imported ✓"** — is exactly the wrong product. It manufactures
confidence in the single number most likely to be wrong, and confidence is easy
to manufacture and impossible to withdraw.

### The principle

> **Automate what fails loudly. Hand over what fails quietly.**

A wrong **lot number** fails loudly: the lot shows nobody on it, he walks it
Saturday, he finds out. A wrong **name** fails loudly: it prints on the week-one
letter and he reads all 79. A wrong **rent** fails quietly — $465 and $485 look
equally authoritative, nothing downstream can tell them apart, and nobody
notices until a tenant disputes it eighteen months later.

That single sentence decides everything downstream. It is why rent gets one
candidate or none, why dates never become fields, why phone numbers are dropped
on the floor today, and why the screen says *"we read 24 of 31 lines"* instead
of showing a green tick.

**A screen that is 95% right trains you to skim.** Skimming is how the seller's
inflation survives into the database. A screen with visible, specific gaps forces
reading. The reading is the actual product; the parsing is the assistant.

### What "done" means

`park-experience-blueprint.md:882` — **four fields make a tenant useful: lot,
name, rent, due day.** Everything else is a 90-day drip, captured ten seconds at
a time at the office window by a man who is standing there talking to them
anyway. No completeness meter. No required-field wizard. No "your park is 40%
complete." Each of those converts fifteen nullable fields into fifteen
obligations, and that is how a 90-minute setup becomes a three-hour data-entry
session he abandons.

---

## 2. The owner's decisions

Three. Everything else in this document is an engineering consequence of them.

---

### Decision 1 — Build the lot generator first, before any of this

**Recommendation: yes. Two days. Nothing here works without it.**

This is the largest finding from both red teams and it is not about the parser at
all.

The importer's join key is `park_lots.lot_number`, unique per park
(`0052_parks_phase1.sql:101,117`). **On closing morning that table is empty.** A
park with no lots cannot reconcile anything — every single pasted row becomes a
question, and the promised screen (*"24 ready · 4 need you"*) renders as
*"0 ready · 79 need you"*.

And there is no way to fill it quickly. `src/components/ParkLots.tsx` adds lots
**one form at a time**. Worse for a mobile-home park: `blank()` at
`ParkLots.tsx:43-44` defaults to `siteType: "rv_full", hasSewer: false`, and
`buildLotRow` hard-refuses an MH pad without sewer
(`src/app/park/park-helpers.ts:293-295`):

> *"A mobile-home pad needs sewer. Turn sewer on, or pick a different site type."*

So every one of 79 lots costs: tap Add → type the number → open the select →
change to Mobile-home pad → tick Sewer → Save → a full `router.refresh()` →
the form closes → tap Add again. **Measured against the shipped component, that
is roughly 45 minutes of typing before he ever sees the paste box** — on a phone,
in a truck, with no progress indicator and no "22 of 79".

The owner red team quit at lot 22. He never saw the clever part.

The blueprint already knows this. `park-experience-blueprint.md:132` and `:2078`
both order the phase as **"lot generator + bulk rate apply + a paste importer"**,
and `:506` says plainly: *"The lot generator creates 79 pads with sensible
defaults and he never measures anything."* Neither the parser design nor the
reconcile design built it. That is a build-order defect, not a parser defect, and
it is the difference between a feature and a demo.

**What it is:** one form. `Lots [1] to [79]`, a site-type picker, a prefix box for
`R1…R10`, and an "these are mobile-home pads" checkbox that sets `has_sewer`
true. One `insert … on conflict (park_id, lot_number) do nothing`. It reuses
`buildLotRow`'s validators unchanged. Two days including the bulk-rate apply
(*"they're all $385, except 12, 34 and 51"*).

**Bonus, and it changes the parser's job:** with lots in place, the importer
stops guessing lot numbers in the abstract and starts **matching against real
inventory**, which is what makes the Excel-mangled cases (`5-Mar` → `3-5`)
resolvable at all.

---

### Decision 2 — Paste box, or white glove? Ship both, in that order

**Recommendation: build the parser and the reconcile screen, but point the
screen at an ops user first. Owner-facing paste ships in season two, written
from the transcripts of the first ten real imports.**

The owner red team made a real case and it deserves a real answer.

**The case for white glove.** For park #1 the trust artifact is a phone call, not
a screen: *"Mr. Ober's printout says lot 5 pays $410. His own June notebook says
$385. Which is it? And six lots aren't on his roll at all — 3, 7, 18, 24, 25,
28. Have you walked those?"* Twelve minutes, from a human who has now read his
seller's paperwork more carefully than his broker did. At 55, one week into
owning a business he has never run, that is the highest-trust object anyone can
hand him. It costs about 60–75 minutes of a $30/hour operator — roughly **$35 a
park** — against a park worth ~$18k of services a season. And the wall clock is
free: he pulls the roll at T−30 and cutover is the 1st, so 48 hours is nothing.

**The case against.** It does not scale past park #10, and *"send us your roll,
we'll have it Thursday"* is a service, not software.

**The resolution is that these are the same build.** The reconcile screen's ask
cards and walk list **are the agenda of that phone call.** The only difference is
who does the typing — and the typing is the worthless half. So:

- Build the parser, the batch tables, and the reconcile screen.
- `park_import_batches.source_kind` already allows `'typed'`, and `raw_text`
  holds the source verbatim. **An ops user, the same screen, his emailed PDF, and
  a ten-minute call is white glove with zero extra engineering.**
- Every ask card in this document is a *guess* about what an owner needs to be
  asked. Ten real imports replace those guesses with facts — the same discipline
  the blueprint already applies to the conversion curve.
- Turn the paste box on for owners when the ask cards stop surprising us.

**Cost of the wrong choice:** building owner-facing paste now spends 5–7
engineering weeks out of phase 2b, where the revenue is, to save an operator an
hour a park at a volume of one park.

---

### Decision 3 — Ship undo, not the re-import diff engine

**Recommendation: phase 2a gets the importer, the batch tables and undo. The
re-import merge engine waits.**

He imports **once**, before closing. The honest answer to a bad first import is
**undo the whole thing and paste again**, which is simple, obvious, and already
specified below (§7). A full re-import diff engine — matching rows to live
tenancies, deciding whether a fresh paste may overwrite a value he typed by
hand, protecting values a tenant confirmed at the window — is a real design and a
real two weeks, and it exists to serve a second import that happens next season.

Phase 2a already carries documents, the office window, receipts, the Today
screen, maintenance and the parks cron. Adding the merge engine breaks it.

**What must ship anyway, because it is three lines and it prevents the actual
disaster:** a content hash on the paste, so a second paste of the *same list*
is refused before the reconcile screen is ever drawn. Without it he pastes twice
and gets 158 tenant files — and `park_renters_one_claim_per_park`
(`0055_park_renters.sql:97-98`) is `where user_id is not null`, so **the database
happily permits two unclaimed files for the same person.** There is no backstop.

---

## 3. Three things the corpus got wrong, checked against the code

Stated up front because each one changes the spec.

**(a) `parseDaterange` is not a bug. Do not "fix" it.** The spreadsheet corpus
calls `src/lib/parks.ts:139-149` broken because `[2026-08-01,)` returns null,
and a month-to-month tenant then renders `vacant` through
`park-helpers.ts:83,97,122-127`. The diagnosis is right and the prescription is
backwards. `lot_no_double_booking` (`0052:190-197`) is
`exclude using gist (park_lot_id with =, during with &&) where (status in
('approved','active'))` — an unbounded upper bound **overlaps every future range
on that lot forever**, including that renter's own renewal. You could never write
a renewal, a transfer, or the next tenant. `park-module-phase2-design.md:505-522`
reaches the same conclusion for four reasons and adds
`lot_res_bounded check (lower_inf(during) = false and upper_inf(during) = false)`
at `:1736-1737`, which forbids that shape outright.

**Resolution: the importer writes a finite range, silently.**
`[cutover, cutover + 1 year)`, extended by cron. `parseDaterange` and its test at
`park-helpers.test.ts:38` stay exactly as they are. **The parser emits no
daterange at all** — it is not the parser's business.

**(b) The importer must never write `lot_rates`.** `lot_rates` is the park's
*asking* price (`0052:126-132`, unique on `(park_lot_id, term)`) and `fromPrice`
(`parks.ts:223`) feeds the "from $X" line on the **public** page. One fixture has
a tenant on a 1994 grandfathered $85. Writing imported rents into `lot_rates`
advertises that lot at $85 forever. The imported rent goes to
`lot_reservations.quoted_amount` (`0052:169`) and nowhere else.

**(c) `buildLotRow` will refuse every lot this importer creates in an MH park.**
Same sewer rule as Decision 1. The importer needs its own row builder that shares
the validators — the 24-character cap at `park-helpers.ts:264`, the amperage
list at `:255` — but sets `has_sewer: true` on any `mh_pad` it creates.
Otherwise `lotFits` (`parks.ts:77-93`) also hides every one of those lots from
every mobile home that ever searches.

**And four columns genuinely do not exist.** Verified by grep across
`supabase/migrations` and `src`: zero hits for `due_day`,
`phone_on_file_with_park`, `merged_into`, `tenancy_began_on`, `rent_due_day`,
`office_recording_lag_days`, `'grandfathered'`, or `park_import`. Migration 0057
below adds them. Until it lands, **the importer drops every pasted phone number
to a note and writes nothing to `mobile_e164`** — because `park_renters` carries
only `mobile_e164` + `mobile_verified_at` (`0055:59-60`), and those are the
columns the SMS rails read. A seller's phone list is not a verified mobile and is
not consent.

**One more, and it is a prerequisite.** `docs/ai-safety-fence.md:1430-1431`
quarantines `src/app/park*` and `src/lib/parks.ts` from importing any AI module.
`src/lib/ai-fields.ts` and `src/lib/ai-boundary.test.ts` **do not exist** — zero
hits. `src/lib/ai.ts` does, with exactly two importers. Nothing in the repo today
would stop someone wiring a "✨ read this for me" button onto the paste box and
shipping renter names, rents and delinquency into a prompt. **Land
`ai-boundary.test.ts` before this screen, not after.**

On the merits it would also be wrong. A regex that cannot read `Tony (Ochoa?)`
leaves it visibly uncertain. A model confidently writes `Anthony Ochoa` and the
question mark is gone forever. **The marginalia is the diligence.** Normalising
it away is the one thing this feature must never do.

---

## 4. The parser

Pure functions, no I/O, no `Date.now()`, deterministic. Lives at
`src/lib/rent-roll-parse.ts`, tested at `src/lib/rent-roll-parse.test.ts`. It
imports `Term` from `@/lib/parks` and nothing else.

### 4a. The confidence scale

```ts
export type Confidence = "stated" | "inferred" | "unknown";

export interface Field<T> {
  value: T | null;
  confidence: Confidence;
  raw: string;              // the cell exactly as pasted. Always.
  candidates?: T[];         // only when unknown AND we found more than one reading
  why?: string;             // one printable sentence for the reconcile row
}
```

- **`stated`** — a mapped cell said it, unambiguously. Import it.
- **`inferred`** — derived from structure, not from a cell: a cadence read off
  the header word `Monthly Rent`, a lot normalised from `#13`. Importable, but
  the screen shows the reasoning.
- **`unknown`** — `value` is `null`. **Always.** Never a default.

Three levels, not four, because `candidates` carries the fourth distinction for
free. An `unknown` **with** candidates renders as tappable chips
(*"$500 or $3,400?"*); an `unknown` **without** renders as an empty box. Those
are different amounts of the owner's attention and they cost one array instead of
a level nobody could act on.

### 4b. The row

```ts
export type Verdict = "import" | "ask";

export interface ParsedRow {
  lines: number[];          // 1-based source lines. Always at least one.
  source: string[];         // those lines, verbatim
  lot:  Field<string>;
  name: Field<string>;
  rent: Field<number>;
  term: Field<Term>;
  staging: {                // parsed, correct, and with nowhere to go until 0057
    dueDay:    Field<number>;
    moveIn:    Field<string>;
    termEnd:   Field<string>;
    email:     Field<string>;
    unitText:  Field<string>;
    siteClass: Field<string>;
  };
  notes: string[];          // phones, balances, deposits, add-ons, marginalia
  flags: Flag[];
  verdict: Verdict;
  askReasons: string[];     // printable sentences, one per reason
}
```

**There is no `phone` field and no `during`.** Both absences are structural, not
stylistic, and both follow the same trick used at
`park-module-phase2-design.md:1699`: *a field that does not exist cannot be
filled in by a refactor next spring.* A phone written to `mobile_e164` is a text
message to a stranger. A synthesised daterange is a fabricated move-in date,
which `blueprint:947` forbids.

### 4c. The result

```ts
export interface ParseResult {
  shape: {
    delimiter: Delimiter;
    headerLine: number | null;
    titleLines: number[];
    columnCount: number;
    contentHash: string;    // FNV-1a over the normalised blob. Re-paste detection.
    pageOf: { page: number; of: number } | null;   // "Page 1 of 3"
  };
  columns: ColumnMap;
  rows: ParsedRow[];
  vacantDeclared: VacantLine[];   // reconcile column 3 — the one that catches inflation
  silentLots: SilentLot[];        // a lot number and nothing else. NOT the same thing.
  facilities: FacilityLine[];     // OFFICE, SHOP — neither tenancy nor vacancy
  totals: TotalsLine[];           // evidence, never authority
  skipped: SkippedLine[];
  unparsed: UnparsedLine[];       // verbatim, with the reason
  blockQuestions: BlockQuestion[];// asked ONCE for the whole paste
  accounting: LineAccounting;
  stats: ParseStats;
}

export interface ParseOptions {
  knownLots?: readonly string[];
  parkType?: "mh" | "rv" | "mixed";
  sourceLabel?: string;           // "the seller's roll" — used in note strings
}

export function parseRentRoll(blob: string, opts?: ParseOptions): ParseResult;
```

### 4d. The never-drop guarantee, computed rather than promised

```ts
export interface LineAccounting {
  totalLines: number;
  accounted:  number;
  unaccounted: number[];   // MUST be empty
  duplicated:  number[];   // MUST be empty
}
```

Every line index `1..N` is walked across `rows[].lines`, `vacantDeclared`,
`silentLots`, `facilities`, `totals`, `skipped` and `unparsed`, and must appear
**exactly once**. A dropped line is a tenant who does not exist and nobody notices
until he does not pay.

**The attack run found this guarantee false in the prototype** — a lot note
wrapped under a `VACANT` row was consumed and never counted, and 1% of 3,000
random blobs broke the invariant. So two rules:

1. `vacantDeclared`, `silentLots` and `facilities` all carry `lines: number[]`
   and the continuation text becomes the lot note.
2. **`unaccounted.length > 0` is a hard `blockQuestion`**, not a field nobody
   reads. If the parser cannot account for a line, the screen says so.

### 4e. Delimiter detection

```ts
export type Delimiter = "tab" | "pipe" | "comma" | "multispace" | "none";
export function detectDelimiter(lines: string[]):
  { delimiter: Delimiter; scores: Record<Delimiter, number> };
export function splitCells(line: string, d: Delimiter): string[];
```

Scored by modal-field-count consistency, then resolved by a **ladder, not a
score**: tab ≥ 0.60, pipe ≥ 0.60, quoted comma ≥ 0.60, multispace ≥ 0.50, bare
comma ≥ 0.85. The thresholds are asymmetric because the failure modes are. A tab
and a pipe are never accidental. A comma and a run of spaces occur inside
ordinary English.

So bare comma and multispace carry two extra guards:

```ts
// A table's cells are short. If the median non-empty cell is a sentence,
// whatever we split on was punctuation inside prose.
prosey(rows)     → median non-empty cell ≥ 6 words   ⇒ score 0

// The "Wexler, Donna" signature: two adjacent cells that are each a bare word.
// Splitting there turns one tenant into a surname column and a given-name
// column, and the resulting grid looks perfect.
nameHazard(rows) → ≥ 25% of lines show the pair       ⇒ score × 0.5
```

The threshold is **25%, not 40%.** The attack run showed a single
`11,Kastner, Ray,385` in twelve clean rows is 8% and sails through — producing a
tenant named `Kastner` with no rent and no flag. So the real fix is the second
one: **`COLUMN_COUNT_MISMATCH` fires for every delimiter, not just multispace,
and it is an ask reason whenever the extra or missing cell falls at or before the
rent column.**

Quoting exempts comma from both guards — the exporter told you where the
boundaries are, which is as explicit as a tab.

**A one-row failure costs one row.** When a delimiter's modal share is ≥ 0.85 but
under 1.0, adopt it and route only the odd-width lines to `unparsed`. The
prototype threw away an entire 79-row paste because one home had a $1,150
unquoted thousands comma.

### 4f. Header detection

```ts
export function headerScore(cells: string[]): { score: number; hits: number };
// score = matched/live − moneyish/live.  A cell that parses as money is data.
```

Best-scoring line **anywhere in the blob** with `hits ≥ 2 && score ≥ 0.5`;
everything above it is `title`. *Anywhere*, not "the first 15 lines" — a
paralegal's sixteen-line cover note pushed the header past the prototype's scan
window and it fabricated nineteen tenants, sixteen of them named `"and more"`.

Below the header, a line is `repeated-header` (a new page) **only when its
normalised cells equal the header's.** The prototype also accepted any line that
independently scored ≥ 0.5, which silently deleted a real row on a lot labelled
`Space`.

**Headerless mode** is the most dangerous shape in the corpus, because a wrong
answer makes all thirty rows wrong, each internally consistent, with nothing
downstream able to detect it. So it is **one question asked once for the block**:

```ts
nameCol = argmax(alphaShare)
numeric = columns where numericShare ≥ 0.8, excluding nameCol
// A rent column repeats. A lot column does not. Demand real separation.
if (high.distinctRatio >= low.distinctRatio * 1.5) { rentCol = low; lotCol = high }
else → blockQuestion("column_role"): "These columns don't tell us apart.
        Which is the lot and which is the rent?"
```

And every field on every row is then **demoted `stated → inferred`**, because
confidence is about the whole path to a value: the cell said `308`, but nothing
said `308` was a lot.

### 4g. The column map — and the rule the attack run exposed

```ts
export type Target =
  | "lot" | "name" | "rent" | "term" | "siteClass"
  | "dueDay" | "moveIn" | "termEnd" | "email" | "unitText";

export type CarryAs =
  | "money_addon" | "balance" | "deposit" | "paid_thru"
  | "status" | "phone" | "address" | "note" | "consent_claim";

export type ColumnRole =
  | { kind: "field";  target: Target; term?: Term }
  | { kind: "carry";  label: string; as: CarryAs }     // → row note
  | { kind: "drop";   label: string; why: string }     // counted and shown, never silent
  | { kind: "unrecognised"; label: string };

export interface ColumnMap {
  roles: ColumnRole[];
  index: Partial<Record<Target, number>>;
  rentCols: { col: number; term?: Term }[];
  unrecognised: string[];
  dropped: { label: string; why: string }[];
}
export function buildColumnMap(header: string[] | null, body: string[][]): ColumnMap;
```

**Three blocking rules, all of them from the attack run, all of them the same
bug:**

> **A missing column has no row to flag.** The prototype blocked on a lot that
> *failed to match* and stayed silent about a lot it never looked for. Nine of the
> twelve worst failures were that one sentence.

1. **`index.lot` or `index.name` undefined ⇒ a blocking `blockQuestion`, and
   every row's verdict is `ask`.** A missing join key is not a per-row problem.
   Otherwise a header reading `Unit` or `Sp.` produces 79 rows that render green,
   are approved by the owner, and are then silently discarded by the committer.
2. **Two columns claiming one target ⇒ a `blockQuestion`, never first-wins.** A
   sheet with both `Lot` and `Site`, or both `Owner` and `Occupant`, is telling
   you something.
3. **No rent column mapped, but some column is ≥ 80% money-shaped ⇒ offer it, as
   a block question.** Do not silently emit 79 rentless tenancies.

**Matching is exact, against a normalised key** — lowercased, non-alphanumerics
stripped. **No fuzzy match, no Levenshtein, no substring fallback.** That is a
decision, not laziness: edit distance is precisely how `PET FEE` becomes `FEE`
becomes rent, and how `SiteID` becomes `SiteNo`. An unmatched header is a visible
question; a wrongly matched one is 79 wrong rows that all look right.

Two anchored (not fuzzy) pre-passes before lookup, because they are mechanical
and lossless: strip a trailing four-digit year (`Season 2026` → `season`), and
strip a trailing parenthetical (`Rent (monthly)` → `rent` + cadence `monthly`).

| Role | Normalised keys |
|---|---|
| `lot` | `lot · lotno · lotnumber · lotid · site · siteno · sitenumber · siteno# · space · spaceno · pad · stall · slip · unit · unitno · no · num · number` + a punctuation-only `#` |
| **`drop`** | **`siteid · sitekey · siterecid`** — the surrogate (1001, 1002…). Importing it renames every lot in the park to a number that looks entirely plausible. The single most likely catastrophic bug, and the one the owner cannot spot. |
| `name` | `tenant · tenantname · resident · residentname · occupant · name · who · lessee · renter · party · household · leaseholder · customer` |
| `rent` | `rent · lotrent · siterent · spacerent · padrent · baserent · monthlyrent · monthlyamount · monthlyrate · rentamount · lotrentamount · currentrent · amount · rate · charge` |
| `rent` + cadence | `nightly/daily · weekly/wk · monthly/mo · seasonal/season · annual/yearly` — standalone, or contained in a rent header (`Monthly Rent`, `Weekly`, `Season 2026`) |
| `term` | `term · leasetype · leasetypecd · frequency · billingcycle · period · cycle` |
| `siteClass` | `type · class · sitetype · category` — the `MH/RV/SLIP/STOR` column. **Deliberately not `term`**: conflating them prices a tenant annually. |
| `dueDay` | `due · dueday · when · rentdue · billday` |
| `moveIn` | `movein · moveindt · start · commenced · tenancystart · since · began` |
| `termEnd` | `leaseexpires · expires · leaseend · leaseexpdt · moveout · vacated · thru` |
| `email` | `email · emailaddress · emailaddr` |
| `unitText` | `rig · unittype · rvtype · hometype · make · model · coach` |
| **`carry:phone`** | `phone · phoneprimary · phonealt · cell · mobile · telephone · homephone` |
| `carry:money_addon` | `petfee · garage · carport · storage · addon · otherrecurring · utilities · trash` |
| `carry:balance` | `balance · baldue · balfwd · arrears · pastdue · delinqdays · aging` |
| `carry:deposit` | `deposit · secdep · securitydeposit · waterdep · prepaid` |
| `carry:paid_thru` | `paidthru · lastpaid · lastpmtdt · lastpmtamt` |
| `carry:status` | `status · statuscd · state` |
| `carry:note` | `notes · comments · remarks · noticecd · udf1 · udf2 · arrangement` |
| **`carry:consent_claim`** | `oktotext · textok · smsok · consent · optin · autopayflg` |
| `drop` | `rptid · parkcd · acctno · meterno · taxexemptflg` |

**`carry:consent_claim` writes nothing.** `contact_pref` stays at its `'paper'`
default (`0055:69-70`), both consent timestamps stay null — 0055 gives them
separate columns at `:61-64` precisely because operational and marketing consent
are **separate legal bases** — and `mobile_verified_at` stays null. The note
reads: *"Your sheet marks this one 'OK to text'. That is your belief about your
tenant, not her consent, so we've kept it as a note."* This is the highest-risk
column in the entire corpus because it is the one an eager parser most wants to
believe.

**And an `unrecognised` column's values are carried to notes, not discarded.**
The prototype recorded the column *label* and threw the *content* away — which
means a column headed `Arrangement` containing *"pays half in June half in Aug"*
and *"no charge — mows the common area"* vanished. Those side deals exist
nowhere else in the world.

### 4h. Money

```ts
export interface MoneyColumnProfile {
  numericShare: number;
  hasCurrencyMarkers: boolean;
  medianValue: number | null;   // the outlier baseline. NOT the mode.
  medianDigits: number;
  dashMeansZero: boolean;
  separatorConvention: "us" | "eu" | "mixed" | "unknown";
}
export function profileMoneyColumn(cells: string[]): MoneyColumnProfile;
export function parseMoney(raw: string, p?: MoneyColumnProfile):
  { field: Field<number>; flags: Flag[] };
```

A **column pre-pass**, because a single cell cannot be read alone: an isolated
`-` means **zero** in a column of dollars and **unknown** everywhere else.

Two corrections from the attack run, both load-bearing:

- **The baseline is the median, not the mode**, and nothing is flagged as an
  outlier until the column holds ≥ 5 numeric cells. A mode with a
  `larger-value-wins` tie-break made "the usual rent here" equal to the biggest
  number in the column: `$385` was flagged as anomalous against a "usual $3,850",
  and `$99,999` imported clean.
- **Profile per `(rent column × term value)`, not per column.** A sheet mixing
  `$395` pads, `$3,600` seasonals and `$185` weeklies in one column flagged every
  normal rent and cleared every seasonal. The `Term` column is already parsed.
  Use it.

| Input | Result |
|---|---|
| `$1,250.00` · `1250` · `1,250` · `$ 400.00` · `395` | value, `stated`. Currency detection is **per column**, so a `$`-free sheet works. Requiring `$` empties whole fixtures. |
| `""` · `n/a` · `--` · `?` · `TBD` | `null`, `unknown` |
| `-` | `0` when `dashMeansZero`, else `null` |
| `#REF!` `#N/A` `#VALUE!` | `null` + `CELL_ERROR` |
| `2.60556E+09` | `null` + `EXCEL_SCIENTIFIC_LOSSY`. **Never expanded.** The expansion is a valid, dialable, *wrong* phone number — the worst possible failure, because nothing downstream can detect it. |
| `(75.00)` | `null` + `ACCOUNTING_NEGATIVE`. A credit is not a rent, and `quoted_amount` has `check (>= 0)` at `0052:169`. |
| `$38500` in a $385 column | `null`, `candidates: [38500, 385]` + `DECIMAL_POINT_LOST`. This is the row that proves *strip-non-digits-then-parse* is catastrophic: it yields $38,500/month. |
| `384.615384615385` | `384.62`, `inferred` + `RENT_DERIVED`. `numeric(10,2)` (`0052:130`) forces two decimals — **and** × 13 = exactly $5,000, so it also emits `TERM_MAY_BE_FOUR_WEEKLY` and asks. Thirteen four-week periods billed monthly is 7.7% short a year. |
| `555.0142` | `null` + `PHONE_SHAPED`. **Refuse, never round.** Three integer digits with more than two decimal places is a phone number that reached the money column through a shift, and the `RENT_DERIVED` branch would launder it into a plausible `$555.01`. |
| `395,00` where the column has `,\d\d$` and no `\.\d\d$` | `null` + `EU_SEPARATOR`, and a **block question for the whole column**. Unconditional comma-stripping turns `395,00` into `39500`, `stated`, with no flag. Low probability in LaGrange County; unbounded consequence. |
| `$1,155` where the median is `$385` | `1155`, `stated` + `RENT_OUTLIER`, **imported verbatim**. Dividing by three invents a quarterly term the sheet never stated and silently drops $770. |
| `0.00` | `0` + `ZERO_RENT_TENANCY`. A free tenancy is a tenancy — if zero collapsed to null it would land on a chase list forever and he would be nagged about his brother-in-law every month. But if `0` appears in > 20% of a column, ask once for the block: *"Nineteen lots show $0. Is that free rent, or rent you don't have yet?"* |
| negative · `> 100_000` | `null` + `RENT_IMPLAUSIBLE`, **and it is an ask reason.** "Present and unreadable" is not the same as "absent", and the prototype conflated them into a silent import. Mirrors `buildRateRows` at `park-helpers.ts:437-439`. |

### 4i. Dates — and note that everything it refuses is computable

```ts
export function parseLooseDate(raw: string): { field: Field<string>; flags: Flag[] };
export function parseDueDay(raw: string): Field<number>;
export function excelSerialToIso(serial: number): string | null;  // 1899-12-30 epoch
```

| Input | Result |
|---|---|
| `2011-06-15` | `stated`. The only unambiguous form. |
| `4/15/2024` | `stated` — day > 12, so the order is forced |
| `3/12/2021` | `2021-03-12`, **`inferred`**, `why:` *"Read as US month/day. If your seller writes the day first, this is 12 March."* |
| `25/12/2020` | `null` + `DATE_AMBIGUOUS`. A sheet that mixes orders has other dates that are also wrong. A stop, not a silent flip. |
| `Jan 2015` · `1998` | `null` + `DATE_PRECISION` |
| `Mar-04` · `Aug-26` | `null` + `DATE_AMBIGUOUS` — March 2004, 4 March, or an Excel render |
| `45689` | `null`, `candidates: ["2025-02-01"]` + `EXCEL_SERIAL`. **Proposed, never written.** |
| `paid in full` · `MTM` · `??` | `null` |

`parseDueDay`: `1st`/`15th`/`5` → `1`/`15`/`5`. `Sundays` → `null`.

**A due day is never parsed out of a prose footer.** *"Weekly sites bill Sundays.
Monthlies bill the 1st. Seasonals paid in full at arrival"* is operational policy,
and reading policy out of an English sentence is where a rent roll starts lying
confidently. It surfaces as one park-level question with the sentence quoted.

**And an unreadable date is carried to notes verbatim**, not dropped. `8/1/2026`
in a `Due` column parsed to nothing and left no trace in the prototype.

### 4j. Lot matching — against real inventory, or not at all

```ts
export function matchLot(raw: string, knownLots: readonly string[]):
  { field: Field<string>; flags: Flag[] };
```

1. Exact, case-insensitive → **`stated`**. The only branch that is.
2. Decoration stripped — `#13`, `Lot 9`, `Space 4`, `No. 12`, trailing space →
   `inferred`.
3. Leading zeros, resolved against **every** real lot sharing the unpadded core.
   `lot_number` is `text` and unique per park (`0052:101,117`), so `1` and `01`
   are legitimately two different lots in some parks. If the family has more than
   one member, refuse and offer both as candidates.
4. `5-Mar` / `2-Oct` — Excel ate a lot number. **Not reversed in isolation:** both
   readings (`3-5`, `5-3`) are tested against real inventory and proposed only
   when exactly one exists. This is the strongest argument in the corpus for
   parsing against a real lot list rather than in the abstract.
5. No match ⇒ `LOT_NOT_FOUND`, reconcile column 2. **Never auto-created** —
   `unique (park_id, lot_number)` makes a guessed label permanent and it will
   collide with the real one later.
6. 24-character cap, matching `park-helpers.ts:264`.
7. **`knownLots` empty** ⇒ do *not* ask per row. One `blockQuestion`:
   *"This park has no lots yet. Create 30 lots from this list?"* (In practice
   Decision 1 means this is a fallback, not the normal path.)

**The stated non-rule, because it is the expensive one:** we never strip
non-digits. `R1`, `D-1`, `B-12` and `1` are four different lots and one fixture's
park holds all four. A digit-stripping normaliser collapses `R1` onto MH `1` and
puts one man's RV tenancy on another man's mobile-home pad.

### 4k. Names — verbatim, always

```ts
export type NameKind = "person" | "vacant" | "facility" | "not_a_person" | "empty";
export function readName(raw: string):
  { kind: NameKind; field: Field<string>; trailing: string | null; flags: Flag[] };
```

**Stored verbatim.** Not title-cased, not re-ordered from `Last, First`, not
split on `&`. Derive a sort key separately. The owner recognises his tenants by
the string he has been reading for twenty years, and a parser that "cleans" it
has spent trust it did not earn on a change nobody asked for.

The only judgement is whether the cell names a person **at all** — because
`display_name text not null` (`0055:50`) is perfectly satisfied by `SEE NOTE`,
`#REF!`, `SAME`, `TOTAL LOT RENT` and `NORTH LOOP`. That constraint is not the
enforcement; this function is.

Vocabulary is matched **whole-cell and per-role**, never as a global stoplist:
`n/a` in a name column is a vacancy, the same string in a phone column is an
unknown.

**Whole-cell, and that word is load-bearing.** The prototype used
`startsWith`, which filed `Officer, Dale`, `Shopbell, Ruth`, `Storage, Ann` and
`Laundry, Bo` as park facilities and deleted them from the rent roll.

**And a facility is only a facility if nobody pays for it.**
`SHOP / STORAGE BLDG` with no amount is park property. `STORAGE - Kastner
$45.00` is a storage tenancy, and filing it under facilities silently deletes
$45/month. **Money decides, not vocabulary.**

`VACANT (needs skirting)` → the vacant bucket with `trailing: "needs skirting"`
as a lot note. `SEE NOTE` / `SAME` / `#REF!` → the row is **kept** with
`name: null` and `verdict: "ask"` — never dropped, because that lot has a real
$385 rent on it and somebody lives there.

### 4l. Line classification

```ts
export type LineKind =
  | "blank" | "title" | "header" | "repeated-header"
  | "section" | "total" | "footer" | "continuation" | "data";

export function classifyLine(cells: string[], ctx: {
  headerCells: string[] | null; belowHeader: boolean; modalCols: number;
  map: ColumnMap | null; runningRentSum: number;
}): { kind: LineKind; why?: string };
```

**`total`** — three detectors, because the attack run beat all three of the
obvious ones:

1. **Keyword in any cell** (`TOTAL|TOTALS|SUBTOTAL|GRAND|SUM`), **never by column
   position** — four fixtures shift the label one or two columns right, and a
   column-A parser reads a nameless lot whose occupant is `TOTAL LOT RENT` and
   whose rent is $5,455. But the keyword is tested **only against the lot cell,
   the name cell and unmapped cells** — never a `carry:note` cell, because
   `Total owed 770 as of 7/1` in a notes column deleted a real tenant.
2. **Keyword-less, structural** — lot cell blank, name cell blank, ≤ 2 non-empty
   cells, all numeric. Catches `\t\t4785\t\t\t`.
3. **Keyword-less, arithmetic** — lot cell blank and the money cell equals, to
   the cent, the sum of the rent column above it. This is what catches
   `GROSS SCHEDULED RENT`, `INCOME`, `MONTHLY GROSS` and `RENT ROLL TOTAL`, all
   of which the keyword list misses and all of which the prototype imported as
   tenants — **double-counting the park's income**.

**And a totals line contributes amounts only from mapped rent columns.** The
prototype took `Math.max` over every number on the line, so a subtotal row whose
*lot number* was 31 became the sheet's claimed total and produced a fabricated
$385 discrepancy in the one box on the screen whose entire job is to be the
honest number.

**`section`** — first cell non-empty, all others empty, value not lot-shaped.
`NORTH LOOP`, `SOUTH ROW`. A parser that lot-matches first would try to create a
lot called `NORTH LOOP`, and `unique (park_id, lot_number)` would make that
permanent.

**`footer`** — `prepared by`, `page N of M`, `printed`, `no representation`,
`sent from my`, rule lines. `Page N of M` is also lifted into
`shape.pageOf`, which drives the warning in §5.

### 4m. Wrapped rows

**We join, but only under a rule short enough to say out loud, and every line
that fails it is surfaced verbatim rather than guessed at.**

> A line continues the row above it **if and only if** (a) its lot cell is empty,
> **and** (b) it carries no money-shaped cell, **and** (c) exactly one of its
> cells is non-empty, **and** (d) the line above was `data`.

**(b) is the discriminator.** A line with no lot that carries a rent *and* a term
*and* a phone is a **record whose lot number failed to scan**, not a wrapped
name. Joining it files one man's tenancy under another woman's name. Money
separates the two cleanly and cheaply.

Four refinements, three of them from the attack run:

- **A fragment that is itself a complete name is not a continuation.** `Jones,
  Marla` under `Smith, Alvin` emits both readings as candidates and asks. The
  prototype produced one tenant called `Smith, Alvin Jones, Marla`, verdict
  import.
- **Never join a fragment that starts with a digit into a name.** `8 Lakeview
  Ter Apt 2B` became part of a `display_name` that would have printed on the
  week-one letter.
- **A continuation never extends a cell that is not a person's name.**
  `SEE NOTE` plus a wrapped sentence is a lot with a comment, not a tenant called
  *"SEE NOTE son living in home"* — and the merged string sails straight past the
  not-a-person check. The trailing text becomes a note.
- **A hyphen at the wrap boundary stays ambiguous on purpose.**
  `Schoenherr-Vas-` + `quez, Adela` emits both readings (soft hyphen vs. real
  hyphen) and picks neither. Both are real surnames. Verdict `ask`.

Long-range joins across a page break are allowed **only** when the previous data
row ends in a hyphen — which earns `Ackermann, Rud-` / `olph` without licensing
arbitrary reordering.

**Performance:** build the map as `parent → continuation[]`, once. The prototype
walked the whole continuation map per data row, which is quadratic: 40,000 lines
took 3.4 seconds and a 5 MB paste extrapolates to roughly 70 seconds of blocked
main thread on a phone. Also cap the paste box and say the limit.

### 4n. The verdict rule

```ts
// A field being ABSENT never blocks (blueprint:885).
// A field being UNCERTAIN blocks only when it is lot, name or rent —
// the three that make a wrong row look like a right one.
function decide(row: ParsedRow, map: ColumnMap): { verdict: Verdict; askReasons: string[] }
```

Ask when **any** of:

- `name.value === null` — including a non-person string
- the paste has no `lot` column at all, or no `name` column *(block-level, applied
  to every row)*
- `lot.value === null` and a lot column existed — `LOT_NOT_FOUND`
- `lot.candidates.length > 1` — `01` vs `1`, `5-Mar` vs `3-5`
- `rent.candidates.length > 1` — two filled rate columns, or a lost decimal point
- **rent was present and refused** — `CELL_ERROR`, `RENT_IMPLAUSIBLE`,
  `EU_SEPARATOR`, `PHONE_SHAPED`, `EXCEL_SCIENTIFIC_LOSSY` in the money column
- `TERM_MAY_BE_FOUR_WEEKLY`
- `term === "seasonal"` and the park has no season configured — a seasonal
  tenancy needs a `during` and we will not invent one
- **two rows land on the same matched lot** — the prototype grouped duplicates by
  *name*, so it caught the same person twice and never the same lot twice. Two
  different people on lot 7 is the most common real shape (a mid-year turnover)
  and both rows imported clean, then one of them was rejected essentially at
  random by the exclusion constraint at commit time.

Do **not** ask for: a missing move-in date, a missing phone, a missing email, a
missing due day, a missing deposit, a missing lease, a balance, or a `$0` rent.

### 4o. Reporting

```ts
export function reconcileTotals(r: ParseResult):
  { claimed: number | null; computed: number; delta: number | null; reading: string } | null;
```

- **`stats.rentStated` counts only rows with `verdict === "import"`.** The
  prototype summed every row with a rent, including the totals row it had
  mistaken for a tenant, and then compared that inflated figure against the
  sheet's own claim.
- **`stats.rentByTerm` is per cadence**, with a `"unknown"` bucket for termless
  rows. A sheet mixing weekly, monthly and seasonal has **no single income
  number**, and a `$22,695/mo` tile would be the most damaging output this
  importer could produce.
- **`rowYield` is measured on lines with page furniture removed from the
  denominator.** Titles, headers, sections, footers and totals are lines we
  understood perfectly; counting them as failures makes a clean sheet look like a
  bad paste. Below 0.40, emit the `low_yield` block question and offer the attach
  rail instead of a reconcile grid.
- A paste with **no lot column, no term column and no vacancy vocabulary is not a
  rent roll.** Refuse it and say so. The prototype turned a payables list into
  three tenants named `Fischer Propane`, `Kosciusko REMC` and `Ace Hardware`, and
  a pasted Slack thread into two tenants named after the participants.

---

## 5. The reconcile screen

Four screens. He is on his phone, at a closing table, and it is loud.

```
/park/import  →  /park/import/read  →  (inline fixing)  →  /park  + the receipt
   PASTE             REVIEW                                   DONE + UNDO
```

### Screen 1 — Paste

Reached from the rent-roll empty state (`ParkRentRoll.tsx:226-234`, currently
offering only "Add lots" — that becomes secondary, after the lot generator has
run).

```
Your rent roll starts here

Paste whatever the seller gave you — his spreadsheet, the page from
the lawyer, the list you keep in your phone. We'll read what we can
and be straight with you about the rest.

┌────────────────────────────────────────────────────┐
│                                                    │
│  Paste here                                        │
│                                                    │
└────────────────────────────────────────────────────┘

Which month do you take over?
[ August 2026  ▾ ]
   Rent starts counting from the 1st. This isn't anybody's move-in
   date — nobody's history gets rewritten.

  [ Read it ]     Nothing is saved until you say so.

────────────────────────────────────────────────────────
Please don't paste credit reports, background checks, or anything
with a Social Security number on it. We have nowhere to put those
and no reason to.
```

That last line is required by `park-module-phase2-design.md:1124` and is backed
by structure: the document-kind allowlist has no slot for one.

The line about the cutover date was rewritten after the owner red team. The
original said *"We use the 1st as the bookkeeping start date on every tenancy."*
He would ask why a woman who has lived there since 2011 needs a date at all, and
the true answer is *"our database requires one"* — which is the worst sentence
available.

**The paste is stored verbatim in `park_import_batches.raw_text` before
parsing.** That one decision also delivers the blueprint's "attach the page"
rail for free: the source pins beside the form on the next screen and scrolls
with him.

### Screen 2 — Read

The order of this screen is the whole product, and the owner red team changed it.
The original put 79 tenant rows first and the walk list third. He would commit and
close the tab before reaching the only output he could not have produced himself.

**So: the walk list first. Then the questions. Then the boring part.**

```
We read 24 of the 31 lines.  Nothing is saved yet.
```

#### Section 1 — Walk these first (4)

```
┌─ Four lots have nobody on this list ───────────────┐
│                                                     │
│   Lot 3     his roll says VACANT                    │
│   Lot 7     VACANT (needs skirting)                 │
│   Lot 18    VACANT                                  │
│   Lot 25    VACANT                                  │
│                                                     │
│  His roll describes 24 tenancies. Your park has 30  │
│  lots. Walk these four on Saturday — an empty lot   │
│  and a cash tenant the seller forgot look exactly   │
│  the same on paper.                                 │
│                                                     │
│  [ Add them as empty lots ]  [ Leave them off ]     │
└─────────────────────────────────────────────────────┘
```

And when the roll is **silent** about a lot rather than calling it vacant — a lot
number and five empty cells — it gets its own line, because absence of
information is not information:

```
   Site A3   his roll says nothing at all about this one
```

#### Section 2 — The seller's own arithmetic

Renders whenever a totals row was found. When it does not tie:

```
┌─ The seller's total doesn't match his own rows ────┐
│                                                     │
│  His total says      $10,350                        │
│  His rows add up to   $9,965                        │
│                       ──────                        │
│                        $385 short                   │
│                                                     │
│  That's exactly one lot's rent. Lot 13 is the only  │
│  lot on this sheet with no amount next to it.       │
└─────────────────────────────────────────────────────┘
```

When it ties, it still renders, and it still says what that proves:

> **His total ties to the penny: $5,019.62.** That means his spreadsheet adds up.
> It doesn't mean the rents are right — 4 rows below still need you.

When the sheet mixes cadences, it refuses to give one number:

> **This sheet's grand total is $22,695 and that figure doesn't mean anything** —
> it adds four whole seasons to one month and one week. What he actually
> collects: **$3,760 a month, $185 a week, $18,750 for the season.**

#### Section 3 — Needs you (4)

> *We won't guess at these. Each one changes a number you'd be relying on.*

Every card states the problem in his words, shows the lines it came from, and
offers the smallest set of real choices. Never a free-form "fix this".

```
┌─ Lot 13 ────────────────────────── needs a name ──┐
│                                                    │
│  His sheet says:                                   │
│    13   SEE NOTE                                   │
│         son living in home, mother in nursing      │
│         home since Feb                             │
│                                                    │
│  "SEE NOTE" isn't a person, so we won't file it    │
│  as one. Who's on lot 13?                          │
│                                                    │
│  [ Name…                              ]            │
│  Rent $[      ]  (optional)                        │
│                                                    │
│  [ Save ]   [ Nobody's on it ]   [ Skip for now ]  │
└────────────────────────────────────────────────────┘

┌─ Lot 23 ───────────────────────── rent looks odd ─┐
│                                                    │
│  Ed Rademacher · $1,155.00                         │
│  That's three times what everyone else pays.       │
│                                                    │
│  Is he a quarterly payer, or is that three lots    │
│  on one bill?                                      │
│                                                    │
│  [ $1,155 is right, monthly ]                      │
│  [ Let me type it ]  [ Skip for now ]              │
│                                                    │
│  Whatever you pick, we file $1,155 exactly as      │
│  written unless you change it.                     │
└────────────────────────────────────────────────────┘

┌─ Lot 7 ────────────────────────── two people on it ┐
│                                                    │
│  Loren Fry      $385   month to month              │
│  Cheryl Newman  $410   month to month              │
│                                                    │
│  LakeLife holds one tenancy on a lot at a time.    │
│  Who lives there now?                              │
│                                                    │
│  [ Fry ]   [ Newman ]   [ Neither — let me type ]  │
└────────────────────────────────────────────────────┘

┌─ "34B" ───────────────────────── no lot like that ┐
│                                                    │
│  Junior Caraway · $60.00                           │
│  You don't have a lot called 34B. He's also on     │
│  lot 15, which is fine — people rent two things.   │
│                                                    │
│  [ Create lot 34B ]                                │
│  [ Put it on an existing lot ▾ ]                   │
│  [ Skip this row ]                                 │
└────────────────────────────────────────────────────┘
```

The lot-7 card is the one that matters most, and the prototype could not produce
it at all: it grouped duplicates by name, never by lot, so both rows imported
green and the database rejected one of them at random at commit time.

#### Section 4 — Ready to go in (24)

Collapsed to one line each, tap to expand, every field editable in place. This is
the boring section and it should look boring.

```
Ready to go in (24)                          [ Expand all ]

  Lot 1    Wexler, Donna         $385   monthly
  Lot 2    Kastner, Ray          $385   monthly
  Lot 4    Boecker, Marilyn      $370   monthly
  Lot 6    Delgado, T.           $400   monthly   ·  due 5th
  …
  Lot 30   STORAGE - Kastner     $ 45   monthly   ⚑ second file
```

Expanded:

```
┌─ Lot 6 ────────────────────────────────────────────┐
│  Name   [ Delgado, T.                          ]   │
│  Rent   [ $400.00 ]   per [ month ▾ ]              │
│  Due    [ 5 ] of the month                         │
│                                                    │
│  We're also keeping, as notes:                     │
│    · Phone on the seller's roll: (260) 555-0177    │
│    · Moved in 9/1/2023                             │
│                                                    │
│  [ Don't import this row ]                         │
└────────────────────────────────────────────────────┘
```

**Two marks, and only two,** because a third stops meaning anything:

| Mark | Means | Blocks? |
|---|---|---|
| A field shown as **placeholder grey with the raw text beside it** | We read something and refused to convert it: `Move-in: "Mar-04" — kept as a note` | No |
| A **⚑ chip** with a one-line reason | Something true he should know: `second file for this person`, `$0 rent`, `three times the usual` | No, unless the row is in Section 3 |

No colour system. No confidence percentages. A row with no marks is a row we are
confident about, and that has to stay rare enough to mean something.

#### Footer — Lines we skipped (7)

Never hidden. Any of them promotes to a row with one tap: `[ No, that's a tenant ]`.

```
Lines we skipped (7)                              [ Show ]

  Line 1   Title
  Line 3   Blank
  Line 25  "SOUTH ROW" — looks like a section heading
  Line 39  Total row
  Line 40  "Prepared by Dornbusch Realty Group. Buyer to verify."
```

#### The page warning

When `shape.pageOf` matched, above everything:

> **This is page 1 of 3.** Paste the other two before you trust the count.

This came out of the phone red team. iOS Quick Look has no Select All, and
dragging a PDF selection across a page break is a coin flip. He pastes 21 rows,
does not notice nine are missing, and reads the resulting $4,000 gap as his seller
lying.

#### The right rail

The paste itself, verbatim, in a scrolling panel, with the line the selected card
came from highlighted. On a phone it collapses to `[ Show the paste ]` and opens
as a sheet. This is the blueprint's "attach the page" mechanism and it costs one
`<pre>`.

#### The commit bar (sticky)

```
────────────────────────────────────────────────────
 24 ready · 4 need you · 4 empty lots
                              [ Put 24 tenants in ]
────────────────────────────────────────────────────
```

**The button never blocks on Section 3.** Leaving four rows unanswered is a
legitimate choice; the count just goes down. Tapping it opens a confirm sheet:

```
This adds 24 tenants, creates 3 lots, and marks 4 lots empty.

Nothing gets texted, emailed, or charged to anybody. Rent amounts
come in as the seller's numbers, not yours — the rent roll will
say so.

You can undo the whole thing afterwards.

  [ Put them in ]        [ Back ]
```

### Screen 3 — The receipt

Not a green tick. The number, and where it came from.

```
24 tenants are in. ✓

$9,965  expected each month
    $0  confirmed by tenants
$9,965  from the seller's roll only

Every one of those came off his spreadsheet. As you confirm them at
the window over the next month, this splits — and the bottom line is
the one you're still exposed on.

Next
  · Walk lots 3, 7, 18 and 25. Nothing on his roll says who's on them.
  · 4 rows are still waiting on you.   [ Finish them ]

  [ See my rent roll ]        [ Undo this import ]
```

The `$0 confirmed` line was challenged in the red team as a scolding delivered on
the one screen that was supposed to be his win. It stays, because it is the honest
version and it is the sentence that makes the walk happen — but the copy above it
does the work of explaining that zero is the expected value on day one.

Where it went sideways, per row, plainly:

```
2 lots didn't take

  Lot 16   Somebody's already on lot 16 for those dates.
           Nothing was changed there.       [ Look at lot 16 ]

  Lot 34B  Delmar Rumbaugh is on file, but he isn't on a lot.
           [ Put him on a lot ]  [ Remove this file ]
```

### What is required, and what may stay blank forever

**Two fields. A lot and a name.** Said out loud on the screen, once, above
Section 3:

> **A lot and a name. That's the whole requirement.** Rent, dates, phone numbers
> — put them in if you have them, leave them if you don't. You'll be standing in
> front of these people for the next month anyway.

| Field | Required | Why |
|---|---|---|
| **lot** | **Yes** | `lot_reservations.park_lot_id` is NOT NULL; `(park_id, lot_number)` is the join key (`0052:117`) |
| **name** | **Yes** | `park_renters.display_name text not null` (`0055:50`) — and the trap is that `#REF!`, `SEE NOTE`, `SAME`, `OFFICE` and `TOTAL LOT RENT` all satisfy it |
| rent | No | `quoted_amount` is nullable (`0052:169`). Renders **"Rent not set"** and joins the confirm list |
| term | Not of him | Schema requires it (`0052:166`). Defaults from the header word, **stated on screen** |
| `during` | Not of him | Schema requires it. Synthesised from cutover, silently |
| due day | No | One park-level dial plus a per-row override. Never asked 79 times |
| move-in | No | **Never synthesised** (`blueprint:947`). Text kept as a note |
| phone / email | No | Phone dropped to notes entirely until 0057 |
| balance, deposit, lease, paid-thru, status codes | No, and **never a field** | Carried verbatim, read by no calculation (`blueprint:906`) |

---

## 6. The commit

A server action on the service-role client — writes are revoked from
`authenticated` and `anon` on every table involved (`0055:198`). Membership
asserted through the existing `assertMyPark` before anything is touched.

**The single most important property: this is not one transaction.** 78 good rows
and one collision must never roll back to 79 zero rows and a man reaching for his
notebook. Three phases, per-row writes, errors collected and reported.

```
commitImport(batchId)

  0  assertMyPark(batch.park_id)                     → DENIED if not
     if batch.committed_at is not null               → "You already imported this one."
     load rows where verdict = 'import'
     drop rows missing lot or name — AND RECORD WHY on the receipt.
       (The prototype dropped them silently. A number he read on screen and
        approved must never fail to reach the database without a sentence.)

  1  LOTS
     for each distinct label he marked "create":
       insert park_lots {
         park_id, lot_number,
         site_type:  mh → 'mh_pad' | rv → 'rv_full' | mixed → the row's own hint
         has_sewer:  TRUE when site_type = 'mh_pad'   ← or lotFits hides it forever
         active: true,
         notes: the vacancy note if any ("needs skirting")
       }
       on 23505 → re-select the existing lot and use it (he added it in another tab)
       stamp created_lot_id on every row carrying that label

  2  RENTERS
     for each row:
       if he matched an existing file → use it
       else insert park_renters {
         park_id, display_name,             ← verbatim
         source: 'seller_roll',
         email: only when it has an @ and a TLD, else null + a note
         notes: the carried marginalia block, verbatim
         user_id:      null,                ← unclaimed. The whole point of 0055.
         mobile_e164:  null,                ← ALWAYS, until 0057
         contact_pref: unset                ← defaults to 'paper' (0055:69)
       }
       stamp created_renter_id

  3  TENANCIES
     for each row:
       during = seasonal ? the park's season window
                         : [cutover, cutover + 1 year)
                seasonal with no season configured → hold the row, never guess
       insert lot_reservations {
         park_lot_id, renter_id,            ← 0055:126 repointed this off users
         renter_unit_id: null,              ← we never guess a rig
         during, term, quoted_amount,
         status: 'active',                  ← so buildRentRoll renders "Occupied"
         origin: 'grandfathered',           ← 0057
         decided_by: null, decided_at: null,← no decision happened (phase2:1109)
         tenancy_began_on: parsed move-in or null,  ← 0057. NEVER lower(during).
         due_day: row value or the park default,    ← 0057
         amount_source: he typed over it ? 'owner_knowledge' : 'seller_roll',
         import_batch_id: batch.id
       }
       on 23P01 → row.commit_error = 'lot_taken'  ; continue
       on 23514 → row.commit_error = 'bad_value'  ; continue
       on trigger raise → row.commit_error = msg  ; continue

  4  batch.committed_at = now(); write counts
     revalidatePath('/park'); revalidatePath('/park/import')
```

### Degrading on the exclusion constraint

`lot_no_double_booking` (`0052:190-197`) will refuse an overlapping tenancy and
there is no way to talk it out of that. Two defences, in order:

**Pre-flight, so it usually never happens.** `planImport` calls `overlaps()` from
`parks.ts:165` — the same function `canApprove` uses at
`park-helpers.ts:188-204`, so the UI and the constraint cannot disagree. Both the
in-paste duplicate (two rows, one lot) and the already-live tenancy are caught
before a single write.

**Catch `23P01` per row anyway**, because he may have approved an application in
another tab thirty seconds ago. The row records `commit_error`, the loop
continues, and the receipt says:

> *Somebody's already on lot 16 for those dates. Nothing was changed there.*

That is the same shape as the existing collision message in
`src/app/park/actions.ts`. **Never a 500.** Never a rollback of 78 good rows.

### The orphan rule

**A phase-3 failure leaves the renter file in place, deliberately.** The existing
application path deletes an orphaned rig when its reservation fails — and that is
right, because a rig is inventory. **A name he typed is not.** An orphaned file
surfaces on the receipt as *"Delmar Rumbaugh is on file, but he isn't on a lot"*
with two buttons, and undo can still remove it.

### Pure functions to write first

In the `park-helpers.ts` convention — tested without a database.

```ts
// src/app/park/import-helpers.ts
planImport(rows, lots, liveStays, cutover) → ImportPlan
buildImportedLotRow(input)                 → LotFormResult   // shares validators, no mh_pad veto
rangeForTerm(term, cutover, season)        → DateRange | null
normaliseLotLabel(raw, realLots)           → string | null   // once, against inventory
```

`ImportPlan` blockers are a closed union, each with a plain-English sentence
exactly like `decideProblemText` (`park-helpers.ts:216-222`):

```ts
type ImportBlocker =
  | "no_name" | "no_lot" | "lot_unknown" | "lot_taken"
  | "lot_twice_in_paste" | "label_too_long" | "bad_amount" | "no_season";
```

### Migration 0057

```sql
create table public.park_import_batches (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),

  -- THE PASTE, VERBATIM. This is the attach-the-page rail and the only honest
  -- record of what he was actually looking at when he approved these rows.
  raw_text      text not null,
  content_hash  text not null,
  source_kind   text not null default 'paste'
                  check (source_kind in ('paste','typed','photo_note')),
  cutover_date  date not null,

  lines_total   int, lines_read int,      -- the honest yield, rendered on screen
  committed_at  timestamptz,
  undone_at     timestamptz,
  undone_by     uuid references public.users(id) on delete set null,
  counts        jsonb not null default '{}'::jsonb
);

create table public.park_import_rows (
  id        uuid primary key default gen_random_uuid(),
  batch_id  uuid not null references public.park_import_batches(id) on delete cascade,
  line_no   int  not null,
  raw_line  text not null,
  parsed    jsonb not null default '{}'::jsonb,   -- what we proposed
  resolved  jsonb not null default '{}'::jsonb,   -- what he confirmed
  verdict   text not null default 'ask'
              check (verdict in ('import','ask','skip','vacant','not_a_lot','unparsed')),
  flags     text[] not null default '{}',

  -- exactly what this row created, so undo is precise rather than clever
  created_lot_id         uuid references public.park_lots(id)        on delete set null,
  created_renter_id      uuid references public.park_renters(id)     on delete set null,
  created_reservation_id uuid references public.lot_reservations(id) on delete set null,
  matched_lot_id         uuid references public.park_lots(id)        on delete set null,
  matched_renter_id      uuid references public.park_renters(id)     on delete set null,
  commit_error  text,
  unique (batch_id, line_no)
);

alter table public.park_renters
  add column phone_on_file_with_park text,  -- NEVER a send target. Repo test.
  add column merged_into uuid references public.park_renters(id) on delete set null,
  add column confirmed_at timestamptz;

alter table public.lot_reservations
  add column origin text not null default 'application'
    check (origin in ('application','office','grandfathered','transfer')),
  add column tenancy_began_on date,
  add column due_day smallint check (due_day is null or due_day between 1 and 31),
  add column amount_source text not null default 'owner_knowledge'
    check (amount_source in ('seller_roll','owner_knowledge','tenant_confirmed','document','self_signup')),
  add column amount_source_at timestamptz,
  add column import_batch_id uuid references public.park_import_batches(id) on delete set null,
  -- phase2:1109 — a grandfathered tenancy cannot carry a decision, because no
  -- decision happened. Someone will ship "bulk approve all sitting tenants"
  -- because it looks tidy. The database refuses.
  add constraint lot_res_grandfathered_undecided
    check (origin <> 'grandfathered' or (decided_by is null and decided_at is null));

alter table public.parks
  add column rent_due_day smallint not null default 1 check (rent_due_day between 1 and 31),
  add column office_recording_lag_days smallint not null default 3,
  add column cutover_date date;
```

RLS on both import tables: read by `ll_manages_park` / `ll_is_ops` only,
`revoke insert, update, delete, truncate … from authenticated, anon`,
`revoke select … from anon`. **A batch holds a park's entire tenant list in
plaintext** — at least as sensitive as `park_renters` itself.

Post-conditions, in the 0052/0055 house style: assert the grandfathered-undecided
constraint landed; assert `anon` holds no SELECT on either import table; and
assert `phone_on_file_with_park` exists **before** any code path can write a
pasted number.

### `tenancy_began_on` is not `lower(during)`

The blueprint wants a grandfathered tenancy to render **"On file — began
2019-05-01"** (`phase2:1109`). `during` starts at the cutover date because the
database needs a finite range. **Reading the display string off `lower(during)`
would make every sitting tenant look like they moved in on closing day** — which
is not a guess, it is a fabrication, and it is exactly what `blueprint:947`
forbids. Two columns. When `tenancy_began_on` is null the string is **"On file"**
and nothing more.

---

## 7. Idempotency, re-import and undo

### Re-paste, blocked before the screen loads

`content_hash` over the normalised blob, checked at paste time:

> *This is the same list you imported on August 8th. Nothing in it has changed.*
> `[ Read it again anyway ]` · `[ Never mind ]`

Ships in phase 2a. It is three lines and it prevents 158 renter files — a state
the database will happily hold, because `park_renters_one_claim_per_park`
(`0055:97-98`) is `where user_id is not null`.

### Re-import merging — deferred, and here is the design when it lands

Match on `(park_id, lot_number)` → the lot's `active` tenancy → its renter file.

| State | Behaviour |
|---|---|
| Lot has no live tenancy | New row, normal treatment |
| Live tenancy, same name and rent | Silent. Collapsed under **"Already in LakeLife (71)"**. No re-write. |
| Live tenancy, something differs | A diff card — and the pre-selected answer depends on where the *current* value came from |

**The rule, in one line: a hand-edit always wins by default.**

```
┌─ Lot 4 ─────────────────────────── two answers ───┐
│  Marilyn Boecker                                   │
│                                                    │
│  In LakeLife   $370   ← you changed this Aug 8     │
│  New paste     $440                                │
│                                                    │
│  (•) Keep $370        You typed it. We'll assume   │
│                       you had a reason.            │
│  ( ) Take $440                                     │
│  ( ) Neither — [        ]                          │
└────────────────────────────────────────────────────┘
```

If `amount_source` is `owner_knowledge` or `tenant_confirmed`, "keep" is
pre-selected and the card says why. If it is still `seller_roll`, the new value is
pre-selected — nobody's work is at stake. A `tenant_confirmed` value gets a
stronger sentence still:

> *You confirmed $385 with Donna at the window on Aug 14. The new paste says
> $410. We're keeping $385 unless you say otherwise.*

Accepting a diff on a confirmed field drops it back to `owner_knowledge` and
clears `amount_source_at`, because it is no longer what she told you.

**A vacancy claim in a new paste, on a lot that now holds a tenancy, is a
conflict — not an instruction.** Nothing ever ends a tenancy on the strength of a
spreadsheet.

### Provenance, and how a field gets promoted

Row-level for the person (`park_renters.source`, already shipped at `0055:77-78`).
**Field-level for the money** (`lot_reservations.amount_source`, new) — because
the money is what the headline number is made of.

```
$27,200  expected each month
$24,100  confirmed by tenants
 $3,100  from the seller's roll only
```

One query: `sum(quoted_amount) group by amount_source` over active tenancies.
Tapping the third line lists the lots, which is the walk list.

| Event | Sets `amount_source` |
|---|---|
| Imported, untouched | `seller_roll` |
| **He types over it** — on the reconcile screen or later on the file | `owner_knowledge`. The act of editing flips it. Zero extra UI. |
| **He taps "Confirmed this with them"** | `tenant_confirmed` + `amount_source_at` |
| The tenant confirms it themselves | `tenant_confirmed` |

Rows two and three are different things and collapsing them would make the honest
line dishonest: his correction is better than the seller's number and worse than
the tenant's.

On the tenant's file, while unconfirmed — never "Missing", never amber, never a
badge:

```
Lot 6 · Delgado, T.
$400 a month · due the 5th
On file — from the seller's roll, not confirmed yet
No written agreement on file

                      [ Confirmed this with them ]
```

And per `phase2:1109`: **screening on a grandfathered tenancy renders as
nothing.** No colour, no dash, no grey pill.

### Undo

He will import garbage once. Probably the first time.

```
Undo this import

This takes back everything from August 8th at 2:14pm:

  24 tenancies
  24 renter files
   3 lots (12, 12A, 34B)

It leaves these alone:
  · Donna Wexler — she's claimed her file
  · Ray Kastner — you verified his mobile on Aug 12
  · Lot 6 — Delgado's rent has been confirmed with him
  · Lot 4 — you added a note to it

Nothing was ever texted, emailed or charged to any of these people,
so there's nothing to take back on their end.

Type the park's name to confirm:  [                    ]

  [ Undo it ]     [ Never mind ]
```

Deletion in reverse creation order, and only what this batch made:

```
1  lot_reservations where import_batch_id = batch AND not protected
2  park_renters    where id in (batch's created_renter_id)
                     AND user_id is null AND claimed_at is null
                     AND mobile_verified_at is null
                     AND zero remaining reservations
3  park_lots       where id in (batch's created_lot_id)
                     AND zero reservations, zero notes added since
4  batch.undone_at = now(), undone_by = user
   park_import_rows STAY. The record of what happened survives the undo.
```

**Protected — never deleted, listed by name instead:** a claimed file; a verified
mobile (`mobile_verified_at` — ten seconds at the window you cannot get back);
anything `tenant_confirmed`; a reservation with a `service_property_id` minted
(`0052:182`) or any job, payment or receipt attached; a lot with a hand-added
note or a second tenancy.

**No time fence.** A 24-hour window is arbitrary and expires exactly when he
finally gets round to looking. Undo stays available forever; what changes is the
confirm sheet, which grows its "leaves these alone" list as consequences
accumulate. When that list gets long, the copy says so directly:

> *This would leave 11 tenants behind that we can't remove. That's probably worse
> than fixing the rows you don't like.* **`[ Show me the rows instead ]`**

Once `parks.active` is true, typing the park's name is required — matching the
destructive-action convention already used for publishing.

---

## 8. The test fixtures

Ready to become `src/lib/rent-roll-parse.test.ts`. **Every separator in a `\t`
block is a literal tab.** Line numbers are 1-based within the fixture text.

```ts
interface Fixture {
  id: string;
  why: string;                  // the one thing this fixture exists to prove
  text: string;
  knownLots?: string[];
  expect: {
    delimiter?: Delimiter;
    headerLine?: number | null;
    rows?: number; import?: number; ask?: number;
    vacant?: number; facilities?: number; silentLots?: number;
    blockQuestions?: string[];   // codes, in any order
    mode?: "rows" | "attach_only" | "decline";
    rentStated?: number;
    claimedTotal?: number | null;
    delta?: number | null;
    at?: Array<{                 // assertions on one row, found by source line
      line: number;
      lot?: string | null; name?: string | null; rent?: number | null;
      term?: Term | null; dueDay?: number | null;
      verdict?: Verdict; flags?: Flag[]; noteContains?: string;
      candidates?: (string | number)[];
    }>;
  };
}
```

Universal invariants asserted for **every** fixture, including the empty string:

```ts
expect(r.accounting.unaccounted).toEqual([]);
expect(r.accounting.duplicated).toEqual([]);
expect(r.rows.every(x => x.verdict !== "import" || (x.lot.value && x.name.value))).toBe(true);
expect(r.rows.every(x => !("phone" in x))).toBe(true);          // no phone field exists
expect(JSON.stringify(r)).toBe(JSON.stringify(parseRentRoll(f.text, opts)));  // deterministic
```

---

### F1 — Broker's Excel export

*Proves: merged title cells, five date formats, a section header, a wrapped
comment under a non-person name, a rent outlier, and a hand-typed total that is
off by exactly one modal rent.*

```
Whispering Pines Mobile Home Court					
Rent Roll — as of 08/01/2026					

Lot	Tenant	Monthly Rent	Due	Move In	Phone
1	Wexler, Donna	$385.00 	1st	4/1/2019	(260) 555-0142
2	Kastner, Ray	$385.00	1st	Jan 2015	260-555-0188
3	VACANT	-	-	-	-
4	Boecker, Marilyn 	$370.00	1st	2011-06-15	
6	Delgado, T.	$ 400.00	5th	9/1/2023	(260) 555-0177
12	Brumbaugh, Earl	$340.00	10th	Mar-04	-
13	SEE NOTE					
	son living in home, mother in nursing home since Feb				

SOUTH ROW					
23	Rademacher, Ed	$ 1,155.00	1st	5/1/2016	260-555-0133
30	STORAGE - Kastner	$ 45.00	1st	-	-

TOTAL		$2,780.00			
Prepared by Dornbusch Realty Group. Buyer to verify.					
```

```
delimiter tab · headerLine 4 · rows 8 · import 6 · ask 2 · vacant 1
claimedTotal 2780 · rentStated 2695 · delta −85

line 5   lot "1"  name "Wexler, Donna"   rent 385  term monthly dueDay 1
         moveIn "2019-04-01"  verdict import
         noteContains "Phone on the seller's roll: (260) 555-0142"
line 6   moveIn null  flags [DATE_PRECISION]  note "'Jan 2015'"  verdict import
line 7   → vacantDeclared, lot "3"
line 8   name "Boecker, Marilyn"   ← trailing space trimmed, string otherwise verbatim
line 10  rent 340  dueDay 10  moveIn null  flags [DATE_AMBIGUOUS]  verdict import
line 11+12  ONE entry: lot "13", name null, verdict ask,
         askReasons ["\"SEE NOTE\" isn't a person…"]
         note contains "son living in home, mother in nursing home since Feb"
         → line 12 is NOT joined into display_name
line 14  skipped kind "section" text "SOUTH ROW"
line 15  rent 1155  flags [RENT_OUTLIER]  verdict ask
line 16  name "STORAGE - Kastner"  rent 45  verdict ask  flags [SECOND_FILE_SAME_PERSON]
         → NOT filed as a facility: it has money on it
line 18  totals · line 19 footer
```

**No `mobile_e164` is written for any row.** All six phones land in `notes`.

---

### F2 — Two rate columns, one row filled in both

*Proves: `rent@weekly` / `rent@monthly` / `rent@seasonal` cadence mapping; a
prose footer holding the due days; a genuinely ambiguous rate.*

```
Ridge & Reeds RV Park  -  2026 Season					

Site #	Name	Rig	Weekly	Monthly	Season 2026
A1	Hollenbeck, Gary	38' 5th wheel		$525.00	
A3					
A4	Schermerhorn, Bud	28' TT	$195.00		
A5	VACANT				
A6	Marchetti, Gina	31' TT		$500.00	$3,400.00
C3	Overmyer, Sue & Dell	Class C			$3,400.00

TOTALS			$195.00	$1,025.00	$6,800.00
Weekly sites bill Sundays. Monthlies bill the 1st. Seasonals paid in full at arrival.					
```

```
rows 4 · import 2 · ask 2 · vacant 1 · silentLots 1
blockQuestions ["due_day_in_prose"]

line 4   lot "A1"  rent 525  term monthly  dueDay null  verdict import
line 5   → silentLots, lot "A3", "this sheet says nothing at all about A3"
line 6   rent 195  term weekly  verdict import
line 8   rent null  term null  candidates [500, 3400]  flags [TERM_AMBIGUOUS]
         verdict ask     ← never sum them, never pick the bigger
line 9   term seasonal  verdict ask  askReasons ["no season configured for this park"]
rentByTerm { weekly: 195, monthly: 525, seasonal: 3400 }   ← never one number
```

The footer is quoted above the grid, verbatim, with one button: *"This sheet
states billing days in a footnote. Apply the 1st to your 2 monthly sites?"*
**`dueDay` stays null on every row until he taps it.**

---

### F3 — Extra money columns, and the totals row that disambiguates them

*Proves: `LOT RENT` is the rent and pet/garage are add-ons — proven by the sheet's
own two totals; shifted totals labels; bare integers as currency.*

```
SANDY BEACH ESTATES							
RENT ROLL 7/31/26							

SPACE	OCCUPANT	LOT RENT	WATER DEP	METER NO	PET FEE	GARAGE	LATE FEE
NORTH LOOP							
101	Garwood, Cheryl	395	100	8842119	25		
102	Seibold, Marv	395	100	8842120		40	
103	VACANT			8842121			
204	VACANT - HOME FOR SALE			n/a			
209	Owner's mother - no rent	0	0	8842209			

	TOTAL LOT RENT	790					
	TOTAL W/ ADD-ONS	855					
```

```
rows 3 · import 2 · ask 1 · vacant 2
map: LOT RENT→rent; PET FEE, GARAGE→carry:money_addon; WATER DEP, METER NO, LATE FEE→drop
claimedTotal 790 · rentStated 790 · delta 0

line 6   rent 395   noteContains "Pet fee 25/mo — not included in rent"
line 7   rent 395   noteContains "Garage 40/mo — not included in rent"
line 9   → vacantDeclared, lotNote "home on lot, for sale — occupied pad, no tenancy"
         ← a separate line from a bare VACANT, and it is a different fact
line 10  name "Owner's mother - no rent"  rent 0
         flags [ZERO_RENT_TENANCY, NAME_NOT_A_PERSON]  verdict ask
         ← kept, because the pad is occupied and belongs in the denominator
lines 12,13  totals, shiftedRight 1     ← detected by keyword anywhere, not column A
```

Currency detection is **per column**: no `$`, no decimals, and it still parses.
The secondary total (855 = 790 + 25 + 40) is what proves the add-ons are excluded.

---

### F4 — The paralegal's exhibit: name first, lot second

*Proves: column order is header-driven; `MTM` is a term not a date; balances are
notes; a facility is not a lot; two rows on one lot; a total that is short by one
row.*

```
EXHIBIT C  --  SCHEDULE OF TENANCIES				
Cedar Point Mobile Home Community				
Delivered by Seller 07/14/2026 pursuant to Section 5.2(b)				

Resident	Space No.	Monthly Amount	Lease Expires	Balance Due
Abramczyk, Teodor	22	$   340.00	month-to-month	$        -
Battaglia, Rose	8	$   340.00	12/31/2026	$   170.00
Caraway, Junior	15	$   325.00	month to month	$        -
Caraway, Junior	34B	$    60.00	month to month	$        -
Fandrich, Sue	19	$   315.00	MTM	$        -
(vacant)	9	$        -		$        -
OFFICE	OFFICE			
SHOP / STORAGE BLDG	SHOP			
Rumbaugh, Delmar	16	$   340.00	MTM	$        -
Rumbaugh, Delmar	16	$    35.00	MTM	$        -

	TOTAL	$ 1,125.00		$   170.00
Seller makes no representation as to collectability.				
```

```
rows 6 · import 3 · ask 3 · vacant 1 · facilities 2
claimedTotal 1125 · rentStated 1440 · delta +315
reading: "Your rows come to $315 MORE than his own total. That's Sue Fandrich,
          space 19, exactly. Either she was added after he struck the total, or
          she's deliberately left out. Both are questions for him."

line 6   lot "22"  name "Abramczyk, Teodor"  rent 340  term MONTHLY  verdict import
         ← "month-to-month" is a TERM, not a lease end. termEnd stays null.
line 7   termEnd "2026-12-31" but term still MONTHLY
         noteContains "Balance $170.00 on the seller's roll as of 07/14/2026 —
                       not imported as a charge"
line 9   lot null  flags [LOT_NOT_FOUND]  verdict ask   ← "34B" is not a lot; never create it
line 11  → vacantDeclared. The accounting dash IS zero here, because the column is money.
lines 12,13 → facilities. Neither tenancies nor vacancies. Own bucket, counted.
lines 14,15 → BOTH ask, paired, flags [TWO_ROWS_ONE_LOT]
         ← two overlapping monthly reservations on lot 16 are not expressible:
           lot_no_double_booking (0052:190-197) would refuse the second.
```

Zero of the $170 becomes a receivable. Line 16 is the seller telling you the same
thing.

---

### F5 — The owner's own sheet

*Proves: five spellings of a lot number; ditto marks; "OK to text?" is not
consent; a landline written in a cell column; a shifted total.*

```
turkey trot -- rents					

#	Who	Amount	When	Cell	OK to text?
01	Dee Ann Stoltzfus	300	1st	2605550311	y
03	empty				
4	Lucille Ottinger	300	1st	no cell - landline 2605550333	N
Lot 9	K. Vanderpool	300	1st	2605550388	y
11	Tonya Brubaker	300	1st	2605550399	y
12	SAME	"	"	2605550400	y
#13	Hershberger, Amos J	300	1st		no phone
19	the trailer my brother in law is in	0			
20 	Sherrie Uhrig	300	1st	2605550455	y

		1800			
```

```
knownLots ["1","3","4","9","11","12","13","19","20"]
rows 7 · import 5 · ask 2 · vacant 1
claimedTotal 1800 · rentStated 1500 · delta −300

lot normalisation: "01"→"1" · "4"→"4" · "Lot 9"→"9" · "#13"→"13" · "20 "→"20"
  all confidence "inferred", each with a printable why.
  If BOTH "1" and "01" existed in park_lots → refuse, candidates ["1","01"].

line 4   flags [CONSENT_NOT_CONSENT]  verdict import
         noteContains "Cell on your sheet: 2605550311"
         noteContains "You marked 'OK to text?' = y. That's your note, not her consent."
         → contact_pref UNSET (defaults 'paper'), mobile_verified_at null,
           both sms_consent columns null, mobile_e164 null.
line 6   flags [PHONE_NOT_MOBILE]  note "'no cell - landline 2605550333'"  verdict import
line 9   lot "12"  name null  rent null  flags [DITTO, NAME_NOT_A_PERSON]  verdict ask
         proposal { rent: 300, why: "the sheet's total of 1,800 only works if this row is 300" }
         noteContains "the cell number here differs from lot 11's"  ← evidence AGAINST "same person"
         ← proposing is honest; writing is not
line 11  name "the trailer my brother in law is in"  rent 0
         flags [ZERO_RENT_TENANCY, NAME_NOT_A_PERSON]  verdict ask
line 13  totals, shiftedRight 2
```

`the Kessinger boys` — had it been present — imports fine. A household nickname
is a working display name. Line 11 is flagged because a rent receipt addressed to
*"the trailer my brother in law is in"* is the moment he stops trusting the tool.

---

### F6 — Four inventory classes and a meaningless grand total

*Proves: a `Type` column is not a `Term` column; `R1`/`D-1`/`B-12`/`1` never
collapse; four vacancy vocabularies; and that a perfect total can be nonsense.*

```
PRETTY LAKE LANDING						
Combined Rent Roll -- MH / RV / Marina / Storage						

Type	Space	Tenant Name	Term	Rate	Paid Thru	Notes
MH	1	Krautkramer, Alvin	MO	$395.00	8/1/2026	
MH	3	VACANT				home removed 5/24
MH	7	Huguenard, Faye	MO	$350.00	Aug-26	long timer, never raised
RV	R1	Gossard, Chuck	SEAS	$3,600.00	paid in full	in by 5/1 out by 10/15
RV	R6	Pennycuff, Loretta	WK	$185.00	8/9/2026	weekly, pays Sundays
RV	R8	VACANT - 30A only					
SLIP	D-1	Gossard, Chuck	SEAS	$1,450.00	paid in full	with R1
SLIP	D-3	Open					
STOR	B-12	Beauchamp, Odette	MO	$45.00	8/1/2026	
STOR	B-15	n/a					

	GRAND TOTAL			$5,675.00		
```

```
termMap { MO: monthly, WK: weekly, SEAS: seasonal }
rows 6 · import 4 · ask 2 · vacant 4
rentByTerm { monthly: 790, weekly: 185, seasonal: 5050 }

line 5   lot "1"   ← matched as "1". NOT collapsed with "R1" or "B-12".
line 7   paidThru "Aug-26" → notes verbatim, flags [DATE_AMBIGUOUS], term stays MONTHLY
line 8   term seasonal, verdict ask (no season configured)
         noteContains "his own note: in by 5/1, out by 10/15 — the tenant's dates,
                       which need not be the park's season"
line 10  → vacantDeclared, lotProposal { amperage: 30 }   ← PROPOSED, never written
line 11  verdict ask, flags [SLIP_MAY_BE_BUNDLED]
         noteContains "'with R1' — this $1,450 may already be inside R1's $3,600"
line 14  → vacantDeclared. "n/a" in a NAME column is vacancy; in a phone column
           it would be unknown. The vocabulary is column-dependent.
line 16  totals — and the screen refuses to report $5,675 as one figure
peopleWithMultipleFiles ["Gossard, Chuck (R1, D-1)"]   ← shown, NOT linked (no merged_into)
```

---

### F7 — Excel poisons, every one of which produces a plausible value

*Proves: `5-Mar` resolved against real inventory or not at all; serials proposed
not written; `#REF!` keeps the row; scientific notation discarded entirely; the
fractional rent that may not be monthly.*

```
Lot ID	Name	Rent	Start	Phone	Email
1	Abernathy, Grace	385	1/1/2020	2605550501	gabernathy@example.com
2	Bickford, Lyle	385	3/1/2021	2.60556E+09	
5-Mar	Callendar, Dot	385	45689	2605550503	dcallendar@example.com 
4	Deitchman, Saul	384.615384615385	6/15/2022	2605550504	
5	#REF!	385			
6	Feltner, Arliss	385	2/1/2019	2605550506	mailto:afeltner@example.com
8	Hovenkamp, Rudy	400	9/1/2024	(260) 555-0508 x2	rudy.h@example.com
14	McQuistion, Sal	385	5/1/2025	2605550514	sal@example
	 	5,019.62			
```

```
knownLots ["1","2","3-5","4","5","6","8","14"]
rows 8 · import 5 · ask 3

line 3  rent 385, phone → note "Excel rounded this to six significant figures.
        The last four digits are gone. Re-collect it at the window."
        flags [EXCEL_SCIENTIFIC_LOSSY]  verdict import
        ← 2,605,560,000 → (260) 556-0000 is VALID, DIALABLE and WRONG. Never expand.
line 4  lot null, candidates ["3-5"], flags [EXCEL_DATE_COERCED_LOT, EXCEL_SERIAL]
        verdict ask
        why: "park_lots has a lot 3-5 and no lot 5-Mar; 45689 is a valid serial
              and would be 2025-02-01"
        moveIn null   ← proposed, never written (blueprint:947)
line 5  rent 384.62, flags [RENT_DERIVED, TERM_MAY_BE_FOUR_WEEKLY], verdict ask
        note "384.615384615385 × 13 = $5,000.00 exactly. This may be a four-weekly
              tenancy, not a monthly one. Billed monthly, the year is short 7.7%."
line 6  name null, rent 385, flags [CELL_ERROR, NAME_NOT_A_PERSON], verdict ask
        ← the row is KEPT. Somebody pays $385 on lot 5.
line 7  email "afeltner@example.com"   ← "mailto:" stripped. Mechanical, lossless.
line 8  phone → note "has an extension, cannot receive SMS", flags [PHONE_NOT_MOBILE]
line 9  email null + note "'sal@example' — not a deliverable address"
        flags [EMAIL_INVALID]  verdict import
        ← park_renters.email has no CHECK (0055:51), so it WOULD store. An address
          the schema accepts and no mail server will is worse than a blank.
claimedTotal 5019.62 · delta 0
reading: "$5,019.62 ties exactly. 5 rows are ready. 3 need you: one lot Excel
          destroyed, one name Excel destroyed, one rent that may not be monthly."
```

---

### F8 — OCR printout, two pages

*Proves: repeating page furniture mid-data; a row wrapped across a page break; an
`O` in the lot column; an `l` in the rent column; a name only detectable as wrong
by plausibility.*

```
PRETTY LAKE MOBILE HOME COURT
RENT ROLL - AS OF 08/01/2026                                  Page 1 of 2

LOT   TENANT                    MOVE-IN      RENT    DUE   BALANCE
----  ------------------------  ----------  -------  ---  ---------
9     Fye, Carol                02/14/2021   410.00   1      820.00
1O    Zimmer, Blaine            05/01/2018   410.00   1        0.00
11    Sowders, Kenneth          07/01/2013   385.00   1        0.00
17    Brumbaugh, Dale           05/15/2020   4l0.00   1        0.00
21    Ackermann, Rud-           09/01/2004   365.00   1        0.00

Prepared by C. Hostetter, Hostetter Realty - for informational purposes only

PRETTY LAKE MOBILE HOME COURT
RENT ROLL - AS OF 08/01/2026                                  Page 2 of 2

LOT   TENANT                    MOVE-IN      RENT    DUE   BALANCE
----  ------------------------  ----------  -------  ---  ---------
      olph
22    Ncwcomer, Elsie           04/01/2008   365.00   1        0.00

                                TOTAL MONTHLY RENT:  10,455.00
```

```
delimiter multispace · shape.pageOf { page: 1, of: 2 }
rows 6 · import 3 · ask 3
claimedTotal 10455 · rentStated 1160 · delta −9295
reading: "His footer claims $10,455 across 26 lots. What you pasted describes 6."
         ← the page warning fires first: "This is page 1 of 2."

line 6   lot "9"  rent 410  noteContains "Balance $820.00 — not imported as a charge"
line 7   lot null  raw "1O"  candidates ["10"]  verdict ask
         why: "the sequence runs 9 → ? → 11, and no other lot here uses a letter"
line 9   rent null  raw "4l0.00"  candidates [410]  verdict ask
         ← THE ONE THE PROTOTYPE GOT WRONG: it imported Dale Brumbaugh as a real
           tenant with NO RENT, silently, no flag. $410 vanished from the roll and
           the seller got blamed for it.
lines 10+18  ONE row: lot "21", name null, candidates ["Ackermann, Rudolph"], ask
         ← the long-range join is licensed ONLY by the trailing hyphen on line 10
line 19  name null, candidates ["Newcomer, Elsie"], verdict ask
         why: "'Ncw' is not a surname-opening trigram in English; cw ← ew is a
               standard misread"
         ← detectable by plausibility ONLY. It goes on the week-one mailed letter.
line 21  totals — and "OCCUPIED LOTS: 26", if present, must NOT become a tenant
         named "26" on a lot named "OCCUPIED LOTS:" (the prototype did exactly that)
```

---

### F9 — Headerless: is that a lot number or a rent?

*Proves: column identity is ONE question asked ONCE; a wrong answer makes all
thirty rows wrong and every one of them looks right.*

```
310  308  Kanouse, Freida
310  322  Vice, Delbert
310  331
340  305  Bowser, Loretta
375  301  Eberly, Lamar
375  311  Hartsough, Dean
385  302  Rupert, Chad
410  309  Blosser, Pauline
410  352  Coblentz, Emma
425  345  Nettrouer, Ivan
318  340  Yoder, Anna
```

```
headerLine null
blockQuestions ["column_role"]
  proposed { col1: "rent", col2: "lot", col3: "name" }, confidence "high"
  evidence:
    · col1 holds 6 distinct values across 11 lines; col2 holds 11
    · col1 is sorted ascending for lines 1-10 — rolls get sorted by rent, never by name
    · col1 contains 410 and 425, outside col2's entire observed range
    · col2 is dense and near-consecutive in 301-345, the shape of a pad-address sequence

EVERY field on EVERY row demoted stated → inferred.
rows 11 · ask 3

line 3   name null  verdict ask
         "display_name is text not null. There is no honest placeholder — you type
          it or you walk the lot."
line 9   lot "352"  note "every other lot here falls in 301-345"
         → reconcile column 2, not a parse problem
line 11  verdict ask, severity "unresolvable", flags [DUPLICATE_LOT, COLUMN_TRANSPOSED]
         all three readings spelled out for him:
           (a) it breaks col1's sort, so it was appended later as a correction
           (b) as read: rent 318 on lot 340 — but line 11 already puts Yoder on 340 at 385
           (c) transposed: lot 318 / rent 340 — but 318 belongs to someone else
```

---

### F10 — The notebook photograph: the correct parse is to decline

```
RENTS - JUNE
l  Donna W    385  pd 6/l    2l  Rudolph A   365 pd
2  Ray K      385  pd        22  Elsie N     365 pd MO#4471
3  --- OUT ---            23  Merle S   4l0  pd 6/3
4  Marilyn B  385  ~~pd~~ NO   24  (office)
l0 Blaine Z   4lO pd       3O  Katie Sue T  4l0 pd
ll Kenny S    385 pd            call Dennis re: tree lot l9
l2 Vernon D   3l0 pd  (l998 rate - do not raise)
                                   TOTAL IN  9,7[?]5
                                   2 SHORT
```

```
mode "decline" · rows 0 · blockQuestions ["photo_of_handwriting"]

declineTriggers:
  multi_record_lines       — two lot-shaped tokens at widely separated offsets with
                             a name between each. The OCR read ACROSS the page.
  lot_column_unreliable    — the lot column, the one field you can least afford to
                             be wrong about, is letters on 8 of 10 lines
  geometry_score 0.31 < floor 0.60
  non_data_lines_interleaved — a strikethrough, a money-order number, a phone
                             reminder, and a total illegible in the tens place

screen:
  "This looks like a photo of a handwritten page. We won't guess at it — a
   mistyped rent here would look exactly as authoritative as a right one. Attach
   the photo instead and it'll sit beside the form while you type."
```

**And say why it is still the most valuable page in the packet:** it is the
seller's own *collections* record, and it contradicts his printed roll. Lot 4's
`pd` is crossed out. Lot 12 corroborates a frozen 1998 rent. The footer says June
collections were about $9,700 against a roll claiming $10,455. Those are walk-list
items, not import rows.

---

### F11 — The seller's prose email: zero rows is the right answer

```
Kayla here is the rents like we talked about. Most everybody is 465 now,
I raised them all in 22 except a few of the old timers I left alone. Wanda
on 11 is 425 and Marilyn on 4 is 440 and I have not had the heart. Lot 6
Tony pays me cash every month, good as gold, been here 9 years. Lot 7 is a
situation, Barb passed and her boy Cody is in the home now, he pays but
theres nothing written down, I'd have a talk with him. The campers out back
are 2400 for the season May 1 to Oct 15, I have 6 of the 10 rented this year,
R3 R9 and two others are open, I'd have to look. Also Larry Sipe rents the
pole barn for 150 a month for his boat but thats not a lot really.
```

```
mode "attach_only" · rows 0 · rowYield 0.0
blockQuestions ["low_yield"]
screen:
  headline "We couldn't find rows in this."
  body "It reads like a letter, not a list. We've pinned it beside the form —
        type against it and it'll scroll with you."

lotMentions [11, 4, 6, 7, R3, R9]   ← each with its whole sentence, tappable
refusedToParse:
  "I raised them all in 22 except a few of the old timers I left alone"
    → worth more than the roll — it is where the below-market rents are — and it
      is a sentence, not a field. Park-level note.
  "Larry Sipe rents the pole barn for 150 a month … thats not a lot really"
    → real revenue attached to no lot. Nowhere to go in the schema, and it must
      not be forced into one.
  "I have 6 of the 10 rented … I'd have to look"
    → the seller himself is not sure. Walk-the-row item, not a number.
```

**The correct output is zero rows**, and this is the fixture that keeps it that
way. Every naive importer produces four confident rows from this and drops the
sentence about the 2022 increase, which is the most commercially valuable line in
the closing binder.

---

### F12 — QuickBooks Customer Balance Detail: people with no lots

```
Dale Ober Rentals
Customer Balance Detail
As of July 31, 2026

		Type	Date	Num	Account	Amount	Balance
Boecker, Marilyn				
	Invoice	06/01/2026	3311	Accounts Receivable	440.00	440.00
	Payment	06/14/2026	1109	Accounts Receivable	-440.00	0.00
Total Boecker, Marilyn					440.00	440.00
					
Sipe, Larry - POLE BARN				
	Invoice	07/01/2026	3352	Accounts Receivable	150.00	150.00
Total Sipe, Larry - POLE BARN					150.00	150.00
					
TOTAL					1,055.00	1,055.00
```

```
mode "rows_without_lots" · rows 2 · ask 2
blockQuestions ["no_lot_column"]
screen: "We found 2 people and no lot numbers. QuickBooks tracks customers, not
         lots. Tell us which lot each person is on — or skip this and use the roll."

droppedAsReportChrome (SHOWN, never silent):
  "Total Boecker, Marilyn …"  "Total Sipe, Larry - POLE BARN …"  "TOTAL … 1,055.00"

← THE BUG THIS FIXTURE EXISTS FOR: every naive importer ever written produces a
  tenant named TOTAL paying $1,055 a month, and two more named "Total Boecker,
  Marilyn" and "Total Sipe, Larry". All three of the totals detectors from §4l
  are needed here.

refusedToParse:
  balance    → note only. The ledger starts at zero on cutover (blueprint:906).
  invoice amount → NOT a lot rent. A $440 invoice may carry a late fee or a pet
                   fee, and folding either into rent makes it permanent.
```

---

### G1 — Garbage: an unrecognised lot header

```
Unit	Tenant	Monthly Rent
1	Wexler, Donna	385
2	Kastner, Ray	385
```

```
blockQuestions ["no_lot_column"]
ALL rows verdict "ask"

← The prototype mapped roles [unrecognised, name, rent], produced two rows with
  lot: null, verdict: IMPORT, zero flags, and the screen counted them under
  "Ready to go in". The committer would then discard both silently. A number he
  read on screen and approved never reaching the database is worse than an error.
  Headers that hit this today: Unit · Sp. · Site/Lot · and any SiteID-only export.
```

### G2 — Garbage: a totals row the keyword list misses

```
Lot	Tenant	Monthly Rent
1	Wexler, Donna	385
2	Kastner, Ray	385
	GROSS SCHEDULED RENT	770
```

```
line 5 → totals, detected ARITHMETICALLY (blank lot cell, money equals the sum above)
rows 2 · rentStated 770
← The prototype imported it as a tenant named GROSS SCHEDULED RENT paying $770,
  and reported rentStated 1540 — the park's income double-counted.
  Also caught by the same rule: INCOME · MONTHLY GROSS · RENT ROLL TOTAL.
```

### G3 — Garbage: two different people on one lot

```
Lot	Tenant	Rent
7	Fry, Loren D	385
7	Newman, Cheryl	410
```

```
BOTH rows verdict "ask", paired, flags [TWO_PEOPLE_ONE_LOT]
copy: "Two people on lot 7. Who lives there now?"
← The prototype grouped duplicates by NAME, so it caught the same person twice and
  never the same lot twice. Both imported clean; lot_no_double_booking then
  rejected whichever inserted second, essentially at random, and the receipt
  reported a database error instead of a question.
```

### G4 — Garbage: European decimal separators

```
Lot	Tenant	Rent
1	Wexler, Donna	1.250,00
2	Kastner, Ray	395,00
3	Boecker, Marilyn	370,00
```

```
blockQuestions ["separator_convention"]
ALL rents null, ALL rows ask
← Unconditional [$\s,] stripping gave 1.25 / 39500 / 37000 — all confidence
  "stated", rentStated $76,501.25, one stray outlier flag. This is the ONLY case
  in the whole corpus where a wrong number is written with full confidence.
  Detection: some cell matches ,\d\d$ and no cell matches \.\d\d$ ⇒ refuse the column.
```

### G5 — Garbage: not a rent roll at all

```
Customer	Amount	Status
Fischer Propane	412.90	Paid
Kosciusko REMC	1180.44	Paid
Ace Hardware	88.12	Open
```

```
rows 0 · mode "decline" · blockQuestions ["not_a_rent_roll"]
copy: "This doesn't look like a rent roll — there's no lot column and nothing
       that reads like a tenancy. Did you mean to paste something else?"
← The prototype produced three confident tenants named after utility companies,
  rowYield 1.00, so the low-yield rail never fired. A pasted Slack thread did the
  same thing with the participants' names.
```

### G6 — Garbage: a PDF table that lost its columns

```
Lot
Tenant
Rent
Status
1
Wexler, Donna
465.00
Current
3
VACANT
—
—
4
Boecker, Marilyn
440.00
30+
```

```
mode "offer_transform"
detected { shape: "column_collapse", headerCells: [Lot,Tenant,Rent,Status], cycle: 4 }
screen: "This looks like a table that lost its columns. Read it 4 lines per row?
         Here's what that gives us."  + a preview grid
primaryAction "Yes, read it that way"   secondaryAction "No, leave it as text"
rowsAfterTransform 3 (import 2, vacant 1)

← Safe to OFFER precisely because a misaligned cycle produces "Lot 465.00 /
  Tenant Current / Rent Wexler" — obvious garbage rather than plausible garbage.
  That distinction is the whole rule for what may be automated.
```

### G7 — Garbage: a continuation line that is actually a record

```
LOT  TENANT              MAILING ADDRESS       RENT    TERM    PHONE
B3   Applegate-Ruiz,     4471 W 500 N          395.00  MONTH   260-555-0188
     Consuelo Maria      Albion IN 46701
     Wenger, Harold      1140 N Turkey Creek   350.00  MONTH   260-555-0155
B5   Ferry, Sharon       same                  395.00  MONTH   260-555-0120 (h)
```

```
lines 2+3 → ONE row, name "Applegate-Ruiz, Consuelo Maria", verdict import
line 4    → its OWN row, lot null, name "Wenger, Harold", rent 350, verdict ask
            askReasons ["This line has no lot number."]
            candidates ["B4"] with the why spelled out

← THE DISCRIMINATOR IS MONEY. Line 4 carries a rent AND a term AND a phone, so it
  is a RECORD whose lot failed to scan, not a wrapped name. Joining it would file
  Harold Wenger's tenancy under Consuelo Applegate-Ruiz and delete a tenant.
line 5    → phone "(h)" is a home landline. Notes only. SMS capability is never
            inferred from a number.
```

### G8 — Garbage: nothing

```
(empty string, and whitespace-only)
```

```
rows 0 · blockQuestions []   ← short-circuit BEFORE emitting anything
accounting.unaccounted []
← The prototype answered a question nobody asked: "the columns do not tell us
  apart. Which is the lot and which is the rent?" on an empty paste.
```

---

## 9. What we deliberately do not parse

Every item here is derivable. That is the point — the gap between *we can compute
it* and *we may store it* is exactly where a rent roll stops being honest.

| We refuse to | Because |
|---|---|
| **Write a phone number to `mobile_e164`** | There is no non-sendable column today. `park_renters` carries only `mobile_e164` + `mobile_verified_at` (`0055:59-60`), and those are what the SMS rails read. One fixture's number belongs to a dead tenant's daughter. Silently dropping data is bad; texting her a rent reminder addressed to her late mother is unrecoverable. Lands in `notes` until 0057 adds `phone_on_file_with_park`. |
| **Read a checkbox as consent** | `OK to text? = y` is the landlord's belief about his tenant, not her consent, and it is not a verification. `contact_pref` stays `'paper'` (`0055:69`) — a real, permanent, respectable answer. The conversion is ten seconds at the window. |
| **Synthesise a move-in date** | `blueprint:947`. `Jan 2015`, `1998`, `Mar-04`, `45689` are all derivable and all stay null. A fabricated tenure becomes a claim inside a notice calculation. |
| **Emit a daterange** | `during` is `daterange not null` (`0052:165`), `lot_res_bounded` forbids unbounded (`phase2:1736`), and we may not invent a start. The importer composes it from cutover; the parser stays out of it. |
| **Import a balance as a charge** | `blueprint:906`. A seller's delinquent balance is a diligence artifact, not a substantiable receivable, and it is the first number a tenant disputes. The ledger starts at zero on cutover. |
| **Treat a deposit as a liability** | One fixture's own footer disclaims that the cash transfers. Render *"Seller's schedule shows $300 — not confirmed received."* Getting this wrong overstates his taxable income and costs him a call from his CPA. |
| **Split a name, re-order it, or title-case it** | `Ortiz, Manuel & Rosa` is one file. Splitting invents a second person, doubles the tenant count, and there is no way to know which of them signs. Store verbatim; derive a sort key separately. |
| **Link two files for the same person** | `merged_into` does not exist (`blueprint:836` wants it). A wrong link is unfixable. Show them grouped so he can spot a duplicate; link nothing. |
| **Create a lot we did not find** | `unique (park_id, lot_number)` (`0052:117`) makes a guessed label permanent and it will collide with the real lot later. |
| **Write into `lot_rates`** | It is the *asking* price and it feeds the public page. A grandfathered $85 would advertise that lot at $85 forever. |
| **Parse a due day out of a prose footer** | *"Monthlies bill the 1st"* is operational policy. Reading policy out of an English sentence is where a rent roll starts lying confidently. One park-level question instead. |
| **Convert a `Paid Thru` into a term or a move-in** | It is a collections fact. Two of its values in one fixture (`paid in full`) are not dates at all. |
| **Report one revenue number for a mixed sheet** | One fixture's grand total adds four whole seasons to a month and a week. A `$22,695/mo` tile is the most damaging thing this importer could produce. |
| **Interpret a notice code** | `LT-3` may mean a late notice was served. Carry the string, interpret nothing. A wrong guess about a served notice is a legal exposure, not a UX detail. |
| **Collect who else lives there** | Familial status. 0052 already gates age behind `age_restricted` for exactly this reason. Household composition gets no column at all. |
| **Accept a screening report** | The upload screen carries the unmissable line, and it is backed by structure: the document-kind allowlist has no slot for one (`phase2:1124`). **Chase documents. Never chase screening.** |
| **Send it to a model** | `ai-safety-fence.md:1430-1431` refuses `park*`, `lot_*`, `renter_*` by name and quarantines `src/app/park*` from importing an AI module. And on the merits: a regex that cannot read `Tony (Ochoa?)` leaves it visibly uncertain; a model writes `Anthony Ochoa` and the question mark is gone forever. |

---

## 10. Honest time estimate — 79 lots

The blueprint promises **"about 90 minutes of his time, plus whatever it takes him
to read 76 rows"** (`:509`) and warns two lines earlier what happens if we miss:
*"He will be told 90 minutes, discover it is two days, and then discount every
other number we give him."*

**With the lot generator (Decision 1), on a laptop:**

| Step | Minutes |
|---|---|
| Park setup interview | 6 |
| **Lot generator** — 1 to 79, all mobile-home pads, sewer on | **3** |
| Bulk rate apply, with three exceptions | 4 |
| Get the text out of the PDF, paste, pick the cutover month | 4 |
| **The walk list and the totals box** — the two things he came for | 3 |
| **~8 ask cards**, the hard ones taking 3–4 minutes | 18 |
| **Read 79 rows** — the blueprint's own requirement, and unavoidable | 20 |
| Commit, receipt, confirm sheet | 4 |
| **Total** | **≈ 62 minutes** |

Plus a Saturday walk of the four to six lots the roll does not account for. That
is outdoors, it is not our clock, and it is the highest-value hour in the whole
process.

**Without the lot generator: ≈ 107 minutes**, of which 45 are typing lot numbers
into a form one at a time, before the useful part ever loads. The owner red team
quit at lot 22 of 79. That is not a slower version of the same product; it is a
different product, and it does not get used.

**On a phone: add 5–15 minutes and a real risk of a partial paste**, because iOS
Quick Look has no Select All and a selection dragged across a PDF page break is a
coin flip. Hence the `Page N of M` warning in §5. The reconcile screen itself is
fine on a phone — sections rather than columns, one row per line, a collapsible
rail. The *lot forms* are not, which is another argument for Decision 1.

**What we tell him: "about an hour, and then a walk."** Not 90 minutes, not two
days. Under-promise by ten minutes and let the walk list be the surprise.

---

## 11. Files

| Path | New? | What |
|---|---|---|
| `src/lib/ai-boundary.test.ts` | **new, first** | The quarantine at `ai-safety-fence.md:1431`. Before the paste box, not after. |
| `src/components/ParkLotGenerator.tsx` + action | **new, first** | Decision 1. Two days. Nothing works without it. |
| `supabase/migrations/0057_park_import.sql` | new | Two tables, the six missing columns, the two park dials, the grandfathered-undecided constraint, post-conditions |
| `src/lib/rent-roll-parse.ts` | new | §4. Pure, deterministic, no I/O |
| `src/lib/rent-roll-parse.test.ts` | new | §8. Every fixture, every garbage case |
| `src/app/park/import-helpers.ts` | new | `planImport`, `buildImportedLotRow`, `rangeForTerm`, `normaliseLotLabel` |
| `src/app/park/import-helpers.test.ts` | new | The collision matrix, without a database |
| `src/app/park/import-actions.ts` | new | `startImport`, `saveRowResolution`, `commitImport`, `undoImport` — service-role, `assertMyPark` first |
| `src/components/ParkImport.tsx` · `ParkImportReview.tsx` | new | Screens 1 and 2 |
| `src/app/park/import/page.tsx` · `import/read/page.tsx` | new | Routes |
| `src/components/ParkNav.tsx` | edit | **A fourth tab pointing at a batch in progress.** He closes the tab at row 40 and today there is no route back. One line; its absence costs the whole session. |
| `src/components/ParkRentRoll.tsx:226-234` | edit | Empty state gains "Paste my rent roll" — *after* the generator has run |
| `src/app/park/park-helpers.ts` | edit | `buildRentRoll` reads `amount_source` for the three-line provenance block |
| `src/lib/parks.ts` | **unchanged** | `parseDaterange` stays exactly as it is. See §3(a). |

---

## 12. The one thing to hold the build to

Write this at the top of `rent-roll-parse.ts`:

> **Automate what fails loudly. Hand over what fails quietly.**
>
> A wrong lot fails loudly — the walk list catches it. A wrong name fails loudly —
> it prints on the week-one letter and he reads all 79. A wrong **rent** fails
> quietly: $465 and $485 look equally authoritative, nobody notices until a tenant
> disputes it, and the diligence literature already predicts 10–20% of them are
> wrong.
>
> That is why rent gets one candidate or none, why dates never become fields, and
> why a screen that says *"we read 24 of 31 lines"* is worth more than one that
> says *"79 rows imported ✓"*.
