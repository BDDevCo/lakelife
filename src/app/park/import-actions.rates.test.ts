import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * "HIS NUMBER WINS" LIVED IN ONE OF THE TWO DOORWAYS.
 *
 * The NAMED path read `lot_rates` first and skipped any lot that already had
 * a monthly card, under its own comment "NEVER OVERWRITES. If the owner has
 * already set a rate on a lot, his number wins". The NAMELESS path — the
 * shape a seller's proforma actually is, and the shape of the one The Haven
 * came with — did a bare upsert onConflict park_lot_id,term with no read at
 * all. One paste against the twenty-one cards the owner had typed himself
 * replaced all twenty-one, and nothing on the receipt said so.
 *
 * That figure is what the January bills are raised from, what the public park
 * page quotes and what an applicant is told, and there is no undo for a rate
 * card: `undoImport` removes tenancies, renter files and lots it created, and
 * never puts a card back.
 *
 * So these run the REAL `commitImport` against a fake of the tables it
 * touches, once down each doorway, and hold both to the same rule.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Every write the commit attempted, in order, so the assertions are about
 *  what reached the database and not about what the code looks like. */
const rateUpserts: Array<{ lot: string; amount: unknown }> = [];
/**
 * Which `lot_rates` read to break. There are two, and they fail closed in
 * different places: the plan's ("park_lot_id, amount") throws out of
 * `loadBatch` before a single write, and the commit's own ("park_lot_id")
 * leaves every card alone and names each lot it could not check.
 */
let breakRateRead: "none" | "plan" | "commit" = "none";

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  private ins: Row | null = null;
  private ups: Row | null = null;
  private failRead = false;
  constructor(private t: string) {}
  select(c?: string) {
    if (this.t === "lot_rates" && !this.ins && !this.ups) {
      const which = (c ?? "").includes("amount") ? "plan" : "commit";
      if (breakRateRead === which) this.failRead = true;
    }
    return this;
  }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  order() { return this; }
  update(patch: Row) { this.patch = patch; return this; }
  insert(row: Row) { this.ins = row; return this; }
  upsert(row: Row, _o?: unknown) { this.ups = row; return this; }

  private resolve(): Promise<{ data: Row[] | null; error: unknown }> {
    if (this.failRead) return Promise.resolve({ data: null, error: { message: "boom" } });
    if (this.ins) {
      const row = { id: `${this.t}-${(db[this.t] ?? []).length + 1}`, ...this.ins };
      (db[this.t] ??= []).push(row);
      return Promise.resolve({ data: [row], error: null });
    }
    if (this.ups) {
      const row = this.ups;
      if (this.t === "lot_rates") {
        const lot = (db.park_lots ?? []).find((l) => l.id === row.park_lot_id);
        rateUpserts.push({ lot: (lot?.lot_number as string) ?? "?", amount: row.amount });
      }
      const rows = (db[this.t] ??= []);
      const hit = rows.find((r) => r.park_lot_id === row.park_lot_id && r.term === row.term);
      if (hit) Object.assign(hit, row);
      else rows.push({ id: `${this.t}-${rows.length + 1}`, ...row });
      return Promise.resolve({ data: [row], error: null });
    }
    const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: hit, error: null });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  single() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("./data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => new Q(t) }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
const { commitImport } = await import("./import-actions");

const PARK = "park-haven";
/** His own cards. Four lots, all at $400, none of them off anybody's sheet. */
const HIS_LOTS = ["1", "2", "6", "7"];

/** A seller's proforma: lot, tab, figure. NO NAME COLUMN anywhere on it. */
const NAMELESS = [
  "Current Monthly",
  "Lot 1\t325.00 $",
  "Lot 2\t250.00 $",
  "Lot 6\t275.00 $",
  "Lot 7\t275.00 $",
].join("\n");

/** The same four lots and the same four figures, with the households named. */
const NAMED = [
  "Lot\tName\tRent",
  "Lot 1\tEarl Dowd\t325.00",
  "Lot 2\tMarva Klee\t250.00",
  "Lot 6\tRay Buss\t275.00",
  "Lot 7\tOpal Trent\t275.00",
].join("\n");

function seed(rawText: string, opts?: { cards?: boolean }) {
  for (const k of Object.keys(db)) delete db[k];
  rateUpserts.length = 0;
  breakRateRead = "none";
  db.parks = [{ id: PARK, name: "The Haven", park_type: "mh", cutover_date: "2026-12-15" }];
  db.park_lots = HIS_LOTS.map((n, i) => ({ id: `lot-${n}`, park_id: PARK, lot_number: n, _i: i }));
  db.lot_rates = (opts?.cards ?? true)
    ? HIS_LOTS.map((n) => ({ id: `rate-${n}`, park_lot_id: `lot-${n}`, term: "monthly", amount: 400 }))
    : [];
  db.lot_reservations = [];
  db.park_renters = [];
  db.park_import_rows = rawText.split("\n").map((line, i) => ({
    batch_id: "b1", line_no: i + 1, raw_line: line, verdict: "import",
    flags: [], resolved: {}, commit_error: null,
    matched_lot_id: null, created_lot_id: null,
  }));
  db.park_import_batches = [{
    id: "b1", park_id: PARK, raw_text: rawText, cutover_date: "2026-12-15",
    lines_total: rawText.split("\n").length, lines_read: 4,
    committed_at: null, undone_at: null, counts: {},
  }];
}

const batch = () => db.park_import_batches[0];
const countsOf = () => (batch().counts ?? {}) as Record<string, unknown>;
const cardFor = (lot: string) =>
  (db.lot_rates ?? []).find((r) => r.park_lot_id === `lot-${lot}` && r.term === "monthly")?.amount;

describe("a roll pasted over cards the owner already set", () => {
  beforeEach(() => seed(NAMELESS));

  it("NAMELESS: leaves every card he set alone, and says which", async () => {
    const res = await commitImport("b1");
    expect(res.ok).toBe(true);
    // Nothing reached lot_rates at all — not one upsert, not one $325.
    expect(rateUpserts).toEqual([]);
    for (const n of HIS_LOTS) expect(cardFor(n)).toBe(400);
    // And it is SAID, by lot, in the receipt and in the sentence he reads.
    expect(res.ratesKept?.map((k) => k.lot)).toEqual(HIS_LOTS);
    expect(res.ratesKept?.[0].message).toBe(
      "Lot 1 already had a rent set, so we left it alone. Change it on Lots & rates.",
    );
    expect(res.signal).toContain("4 lots already had a rent you'd set");
    expect(countsOf().kept).toBe(4);
  });

  it("NAMELESS: a lot with no card of his own still takes the sheet's figure", async () => {
    db.lot_rates = db.lot_rates.filter((r) => r.park_lot_id !== "lot-6");
    const res = await commitImport("b1");
    expect(rateUpserts).toEqual([{ lot: "6", amount: 275 }]);
    expect(cardFor("6")).toBe(275);
    expect(cardFor("1")).toBe(400);
    expect(countsOf().rates).toBe(1);
    expect(res.ratesKept?.map((k) => k.lot)).toEqual(["1", "2", "7"]);
  });

  it("NAMELESS: a park with no cards yet imports all four, exactly as before", async () => {
    seed(NAMELESS, { cards: false });
    const res = await commitImport("b1");
    expect(rateUpserts).toEqual([
      { lot: "1", amount: 325 }, { lot: "2", amount: 250 },
      { lot: "6", amount: 275 }, { lot: "7", amount: 275 },
    ]);
    expect(countsOf().rates).toBe(4);
    expect(res.ratesKept).toEqual([]);
    expect(res.signal).not.toContain("already had a rent");
  });

  it("NAMELESS: a failed read writes NO card and names every lot it couldn't check", async () => {
    breakRateRead = "commit";
    const res = await commitImport("b1");
    expect(rateUpserts).toEqual([]);
    for (const n of HIS_LOTS) expect(cardFor(n)).toBe(400);
    expect(res.failures?.map((f) => f.lot)).toEqual(HIS_LOTS);
    expect(res.failures?.[0].message).toBe(
      "We couldn't check whether lot 1 already had a rent set, so we left it alone. Set it on Lots & rates.",
    );
    expect(res.ratesKept).toEqual([]);
  });

  it("NAMELESS: the row record is written even for a lot whose rent we keep", async () => {
    // It carries matched_lot_id and created_lot_id, and created_lot_id is the
    // only thing that tells undo which pads this import brought into being.
    // Written after the upsert, behind a `continue`, a kept card stranded it.
    await commitImport("b1");
    const linked = (db.park_import_rows ?? []).filter((r) => r.matched_lot_id != null);
    expect(linked.map((r) => r.matched_lot_id).sort()).toEqual(
      HIS_LOTS.map((n) => `lot-${n}`).sort(),
    );
  });

  it("NAMELESS: a failed read on the PLAN's rates refuses the whole commit", async () => {
    // The outer half of the same rule. `loadBatch` throws rather than
    // planning against "this park has no cards", and the button answers
    // before a single row is written.
    breakRateRead = "plan";
    const res = await commitImport("b1");
    expect(res.ok).toBe(false);
    expect(rateUpserts).toEqual([]);
    expect(batch().committed_at).toBeNull();
  });

  it("NAMED: the same rule, the same sentence, out of the same helper", async () => {
    seed(NAMED);
    const res = await commitImport("b1");
    expect(res.ok).toBe(true);
    expect(rateUpserts).toEqual([]);
    for (const n of HIS_LOTS) expect(cardFor(n)).toBe(400);
    expect(res.ratesKept?.map((k) => k.lot)).toEqual(HIS_LOTS);
    expect(res.ratesKept?.[0].message).toBe(
      "Lot 1 already had a rent set, so we left it alone. Change it on Lots & rates.",
    );
    expect(res.signal).toContain("4 lots already had a rent you'd set");
  });
});
