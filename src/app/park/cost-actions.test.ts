import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SECOND ID.
 *
 * `recordCost` proves the PARK is yours on its first line. It said nothing
 * about `sourceJobId`, and 0111 makes that column unique across the whole
 * table — so attaching another park's job id spent that job's only slot, and
 * the victim could never bill their own mow again.
 *
 * A source check, because the failure is a guard nobody wrote: there is no
 * behavioural test that can observe a check which is absent, and every path
 * here needs a live Postgres with two parks, two properties and a job.
 */
describe("recordCost scopes the job id to the park", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
  const code = (p: string) =>
    read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const body = () => {
    const src = code("app/park/cost-actions.ts");
    const fn = src.match(/export async function recordCost[\s\S]*?\n}/)?.[0] ?? "";
    // A regex that can match nothing is a test that passes vacuously.
    expect(fn.length, "recordCost not found — the scan is measuring nothing").toBeGreaterThan(400);
    return fn;
  };

  it("checks the park owns the job before writing anything", () => {
    const fn = body();
    expect(fn, "recordCost must validate sourceJobId").toMatch(/if \(sourceJobId\)/);
    // The job must be matched against the park's own service property.
    expect(fn).toMatch(/service_property_id/);
    expect(fn).toMatch(/\.eq\("property_id"/);
  });

  it("runs that check BEFORE any park_costs insert", () => {
    const fn = body();
    const guard = fn.indexOf("if (sourceJobId)");
    const firstInsert = fn.indexOf('.from("park_costs")');
    expect(guard, "no sourceJobId guard at all").toBeGreaterThan(-1);
    expect(firstInsert, "no park_costs insert found — scan is stale").toBeGreaterThan(-1);
    expect(guard, "the guard must precede every write, including the early-return branches")
      .toBeLessThan(firstInsert);
  });

  it("still asserts park membership on the first line", () => {
    // The guard added here must not have displaced the one added before it.
    const fn = body();
    const park = fn.indexOf("assertMyPark");
    const job = fn.indexOf("if (sourceJobId)");
    expect(park).toBeGreaterThan(-1);
    expect(park, "park membership is still checked first").toBeLessThan(job);
  });

  /**
   * Every branch that writes a cost row must sit behind both guards. recordCost
   * has three inserts on three different paths — park-carries, fee-covered, and
   * the ordinary split — and the fee-covered branch is the one that returned
   * early past the membership check last time.
   */
  it("no park_costs insert escapes in front of the guards", () => {
    const fn = body();
    const guards = Math.max(fn.indexOf("assertMyPark"), fn.indexOf("if (sourceJobId)"));
    const inserts = [...fn.matchAll(/\.from\("park_costs"\)\s*\n?\s*\.insert/g)].map((m) => m.index ?? -1);
    expect(inserts.length, "expected the write paths to be found").toBeGreaterThan(0);
    for (const at of inserts) {
      expect(at, "a park_costs insert sits before the guards").toBeGreaterThan(guards);
    }
  });

  it("and the go-live boundary is read in front of every one of them too", () => {
    // The behavioural tests below prove what each branch does with it; this
    // pins the shape, so a fourth branch added later cannot land in front of
    // the read — or decide the boundary for itself with a second read.
    const fn = body();
    const gate = fn.indexOf("goLiveBoundary(");
    expect(gate, "recordCost does not read the go-live boundary").toBeGreaterThan(-1);
    expect((fn.match(/goLiveBoundary\(/g) ?? []).length, "read once, decided per branch").toBe(1);
    const inserts = [...fn.matchAll(/\.from\("park_costs"\)\s*\n?\s*\.insert/g)].map((m) => m.index ?? -1);
    expect(inserts.length).toBe(3);
    for (const at of inserts) expect(at, "a park_costs insert precedes the go-live read").toBeGreaterThan(gate);
    // Two branches refuse on it (park-carries, split); the third records
    // evidence. Exactly two refusals, and the evidence signal on the third.
    expect((fn.match(/if \(notOurs\)/g) ?? []).length).toBe(2);
    expect(fn).toMatch(/preCutoverEvidenceSignal\(/);
    // And the preview refuses on the same comparison, so "Show me the split"
    // reads the reason before the save button does.
    const src = code("app/park/cost-actions.ts");
    const preview = src.match(/export async function previewCostSplit[\s\S]*?\n}/)?.[0] ?? "";
    expect(preview.length).toBeGreaterThan(200);
    expect(preview).toMatch(/goLiveBoundary\(/);
    expect(preview).toMatch(/preCutoverCostRefusal\(/);
    // AND THE FEES, because "Show me the split" is the only screen door to the
    // fee-covered branch: a pre-go-live period is refused only when no fee
    // covers it, and a failed fee read refuses rather than guessing "no fee".
    expect(preview).toMatch(/feeCovering\(/);
    expect(preview).toMatch(/covering\.failed/);
    expect(preview).toMatch(/if \(notOurs && !covering\.label\) return/);
  });

  it("recordCost reads the fees once, before the park-carries branch, so its refusal can say where a covered bill goes", () => {
    const fn = body();
    expect((fn.match(/feeCovering\(/g) ?? []).length, "read once").toBe(1);
    const fees = fn.indexOf("feeCovering(");
    const carries = fn.indexOf("if (parkCarries)");
    expect(carries).toBeGreaterThan(-1);
    expect(fees, "the fee read must precede the park-carries branch").toBeLessThan(carries);
    // Read, not applied: the park-carries branch still records park_only.
    const branch = fn.slice(carries, fn.indexOf("allocation_method: \"park_only\""));
    expect(branch).not.toMatch(/covering\.label\s*\)\s*\{/);
  });

  it("a failed fee read refuses exactly the two writes that go on its answer — after the park-carries branch, before the fee-covered insert", () => {
    // The behavioural tests below prove each branch's answer to a failed
    // read; this pins WHERE the refusal sits, so it cannot drift back in
    // front of a write it does not inform.
    const fn = body();
    const carries = fn.indexOf("if (parkCarries)");
    const parkOnly = fn.indexOf('allocation_method: "park_only"');
    const feeCovered = fn.indexOf('allocation_method: "fee_covered"');
    const refuse = fn.indexOf("if (covering.failed) {");
    expect(refuse, "the failed-read refusal is missing").toBeGreaterThan(-1);
    expect(parkOnly, "the park-carries write is missing — the scan measures nothing").toBeGreaterThan(-1);
    expect(feeCovered, "the fee-covered write is missing — the scan measures nothing").toBeGreaterThan(-1);
    expect((fn.match(/if \(covering\.failed\) \{/g) ?? []).length, "one refusal, for the two writes").toBe(1);
    expect(refuse, "it must sit after the park-carries write").toBeGreaterThan(parkOnly);
    expect(refuse, "and before the fee-covered write").toBeLessThan(feeCovered);
    // And the park-carries branch words its own refusal with the fee unknown
    // rather than guessing "no fee": the label is withheld on a failed read,
    // and the sentence says the check could not be made.
    const branch = fn.slice(carries, parkOnly);
    expect(branch).toMatch(/covering\.failed \? null : covering\.label/);
    expect(branch).toMatch(/couldn't be checked just now/);
  });
});

// ---------------------------------------------------------------------------
// A BILL FOR A MONTH THAT WAS NEVER OURS.
//
// The rent run refuses a month that began before go-live (ledger-actions,
// preCutoverRefusal). The cost door did not: on closing day the Today screen
// told him "Property tax for 2026 still isn't entered — enter it and it
// splits across the lots", /park/costs took it, and the seller's tax — a
// credit at the closing table, by decision never a park_costs row — would
// have been split across twenty-one lots and billed on the residents' first
// statement. Three branches write a cost row; every one of them has to refuse.
//
// Run against the real action with the database mocked: The Haven's park row
// (cutover 2027-01-01), its Grounds fee (covers sewer), and its lots.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const inserted: Row[] = [];
/** Tables whose next read comes back as a failure, not as an empty list. */
const failing = new Set<string>();

class InsertQ {
  constructor(private t: string, private row: Row | Row[]) {}
  select() { return this; }
  single() { return this.go().then((r) => ({ data: r.error ? null : { id: `${this.t}-1` }, error: r.error })); }
  private async go(): Promise<{ error: { code: string; message: string } | null }> {
    if (failing.has(this.t)) return { error: { code: "XX000", message: "mock: insert failed" } };
    for (const r of Array.isArray(this.row) ? this.row : [this.row]) inserted.push({ ...r, __table: this.t });
    return { error: null };
  }
  then<A, B>(ok?: ((x: { error: unknown }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.go().then(ok, bad);
  }
}

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  not(c: string, op: string, v: unknown) {
    // Only the shape the code uses: `.not(col, "is", null)`.
    if (op !== "is" || v !== null) throw new Error(`mock: unsupported not(${c}, ${op})`);
    this.fs.push((r) => r[c] != null);
    return this;
  }
  order() { return this; }
  limit() { return this; }
  delete() { return this; }
  insert(row: Row | Row[]) { return new InsertQ(this.t, row); }
  private rows(): Row[] { return (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))); }
  private result() {
    return failing.has(this.t)
      ? { data: null, error: { code: "XX000", message: `mock: ${this.t} read failed` } }
      : { data: this.rows(), error: null };
  }
  maybeSingle() {
    const r = this.result();
    return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error });
  }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.result()).then(ok, bad);
  }
}

const OWNER = "user-owner";
const PARK = "park-haven";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { recordCost, previewCostSplit, getBillableParkJobs } = await import("./cost-actions");
const { costCategoryForService } = await import("./cost-helpers");

function seedHaven(cutover: string | null) {
  inserted.length = 0;
  failing.clear();
  db.park_members = [{ park_id: PARK, user_id: OWNER, role: "owner" }];
  db.parks = [{ id: PARK, cutover_date: cutover, service_property_id: null }];
  db.park_fees = [{
    park_id: PARK, label: "Grounds fee", active: true,
    covers: ["water", "sewer", "trash", "common_electric", "grounds", "other"],
  }];
  db.park_lots = [
    { id: "l1", park_id: PARK, lot_number: "1", active: true, lifecycle: "live", park_owned_home: false },
    { id: "l2", park_id: PARK, lot_number: "2", active: true, lifecycle: "live", park_owned_home: false },
  ];
  db.lot_reservations = [
    { id: "r1", park_lot_id: "l1", during: "[2027-01-01,2028-01-01)", status: "approved" },
  ];
  db.park_costs = [];
  db.lot_cost_shares = [];
  db.jobs = [];
}
const costRows = () => inserted.filter((r) => r.__table === "park_costs");
const shareRows = () => inserted.filter((r) => r.__table === "lot_cost_shares");

describe("recordCost refuses a bill for a month that began before go-live", () => {
  beforeEach(() => seedHaven("2027-01-01"));

  it("the park-carries branch: the seller's December electric on the park-owned home", async () => {
    const res = await recordCost(PARK, "other", "2026-12-01", "2027-01-01", 88.4, "Lot 11 electric", null, true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/closing statement/);
    expect(res.error).toMatch(/period starts in December 2026/);
    // `other` is covered by the seed's Grounds fee, so the refusal says where
    // the bill CAN go — and names every press on the screen that gets it
    // there: the toggle, the preview, and the button the preview then offers.
    expect(res.error).toContain('"Grounds fee" fee');
    expect(res.error).toContain('"Split it across the lots"');
    expect(res.error).toContain('"Show me the split"');
    expect(res.error).toContain('"Record it"');
    expect(costRows()).toEqual([]);
  });

  it("the park-carries branch for a category no fee covers: refused, and no evidence door is promised", async () => {
    const res = await recordCost(PARK, "snow", "2026-12-20", "2026-12-21", 165, "plough", null, true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/period starts in December 2026/);
    expect(res.error).not.toMatch(/evidence/i);
    expect(res.error).not.toMatch(/Split it across the lots/);
    expect(costRows()).toEqual([]);
  });

  it("the split branch: the 2026 property tax, which the closing notes say is never a park_costs row", async () => {
    const res = await recordCost(PARK, "tax", "2026-01-01", "2027-01-01", 3517.96, "25pay26");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/closing statement/);
    // A yearly bill is not "for January 2026"; what is compared is where its
    // period STARTS, and that is what the sentence says.
    expect(res.error).toMatch(/period starts in January 2026/);
    expect(res.error).not.toMatch(/bill is for January 2026/);
    expect(costRows()).toEqual([]);
    expect(shareRows()).toEqual([]);
  });

  it("and 'Show me the split' refuses first, so he reads the reason before the save button", async () => {
    const res = await previewCostSplit(PARK, "tax", "2026-01-01", "2027-01-01", 3517.96);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/closing statement/);
    // Tax is covered by no fee, so the sentence must not promise the evidence
    // door — that bill counts as nothing here, and the save agrees.
    expect(res.error).not.toMatch(/evidence/i);
    const save = await recordCost(PARK, "tax", "2026-01-01", "2027-01-01", 3517.96, "25pay26");
    expect(save.error).toBe(res.error);
  });

  it("a period that STRADDLES go-live is still not ours — the rule is where it begins", async () => {
    // On both branches that reach a bill or the park's books.
    const split = await recordCost(PARK, "tax", "2026-12-15", "2027-01-15", 700, "");
    expect(split.ok).toBe(false);
    expect(split.error).toMatch(/December 2026/);
    const mine = await recordCost(PARK, "other", "2026-12-15", "2027-01-15", 700, "", null, true);
    expect(mine.ok).toBe(false);
    expect(mine.error).toMatch(/December 2026/);
    expect(costRows()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE FEE-COVERED BRANCH IS NOT GATED, AND SAYS WHAT IT TOOK.
  //
  // It reaches nobody's bill and nothing in the ledger — its only reader is
  // the fee-coverage check, which is built entirely from rows like these: The
  // Haven's four June 2026 baselines, all fee_covered, all before go-live.
  // Refusing them would have emptied the check to protect a bill that was
  // never going to be raised.
  // -------------------------------------------------------------------------
  it("the fee-covered branch: a June 2026 baseline goes in as evidence, and the signal says so", async () => {
    const res = await recordCost(PARK, "sewer", "2026-06-01", "2026-07-01", 1405.36, "annual ÷ 12 — BASELINE, NOT A BILL");
    expect(res.ok, res.error).toBe(true);
    expect(costRows()).toHaveLength(1);
    expect(costRows()[0].allocation_method).toBe("fee_covered");
    expect(costRows()[0].period_start).toBe("2026-06-01");
    expect(shareRows()).toEqual([]);
    expect(res.signal).toMatch(/evidence only/);
    expect(res.signal).toMatch(/June 2026/);
    expect(res.signal).toMatch(/January 1, 2027/);
    expect(res.signal).toMatch(/"Grounds fee"/);
    expect(res.signal).toMatch(/never a bill/);
    expect(res.signal).not.toMatch(/closing statement/);
  });

  it("the fee-covered branch: the December sewer, likewise — evidence, never a share", async () => {
    const res = await recordCost(PARK, "sewer", "2026-12-01", "2027-01-01", 1405.36, "LaGrange County");
    expect(res.ok, res.error).toBe(true);
    expect(costRows()[0].allocation_method).toBe("fee_covered");
    expect(Number(costRows()[0].park_absorbed)).toBe(1405.36);
    expect(shareRows()).toEqual([]);
    expect(res.signal).toMatch(/evidence only/);
  });

  it("but the same December bill, ticked as the park's own, is refused — the branch decides, not the category", async () => {
    const res = await recordCost(PARK, "sewer", "2026-12-01", "2027-01-01", 1405.36, "", null, true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/closing statement/);
    expect(costRows()).toEqual([]);
  });

  it("and a fee-covered bill from a month that IS ours gets the ordinary signal, not the evidence one", async () => {
    const res = await recordCost(PARK, "sewer", "2027-01-01", "2027-02-01", 1405.36, "LaGrange County");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toMatch(/already covers this/);
    expect(res.signal).not.toMatch(/evidence only/);
  });

  it("an empty period is refused in words on every branch — never 'try again' for a shape that cannot save", async () => {
    // The fee-covered branch had no period check at all, so end <= start
    // reached the insert, hit park_costs_period_real, and came back as
    // "Couldn't save that bill — try again."
    for (const args of [
      ["sewer", "2027-02-01", "2027-02-01", 10, "", null, false],
      ["other", "2027-02-01", "2027-01-31", 10, "", null, true],
      ["tax", "2027-02-01", "2027-02-01", 10, "", null, false],
    ] as const) {
      const res = await recordCost(PARK, args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/has to end after it starts/);
      expect(res.error).not.toMatch(/try again/);
    }
    expect(costRows()).toEqual([]);
  });

  it("takes the first bill that is ours — January 2027 sewer, fee-covered", async () => {
    const res = await recordCost(PARK, "sewer", "2027-01-01", "2027-02-01", 1405.36, "LaGrange County");
    expect(res.ok, res.error).toBe(true);
    expect(costRows()).toHaveLength(1);
    expect(costRows()[0].allocation_method).toBe("fee_covered");
    expect(costRows()[0].period_start).toBe("2027-01-01");
  });

  it("takes a January bill the park carries, and a January split", async () => {
    const mine = await recordCost(PARK, "other", "2027-01-01", "2027-02-01", 88.4, "Lot 11 electric", null, true);
    expect(mine.ok, mine.error).toBe(true);
    const split = await recordCost(PARK, "tax", "2027-01-01", "2028-01-01", 3600, "26pay27");
    expect(split.ok, split.error).toBe(true);
    expect(costRows()).toHaveLength(2);
    expect(inserted.filter((r) => r.__table === "lot_cost_shares")).toHaveLength(1);
  });

  it("is no restriction at all for a park with no go-live date", async () => {
    seedHaven(null);
    const res = await recordCost(PARK, "other", "2026-06-01", "2026-07-01", 140, "baseline", null, true);
    expect(res.ok, res.error).toBe(true);
    expect(costRows()).toHaveLength(1);
  });

  it("a failed read of the go-live date is not 'no go-live date'", async () => {
    // {data:null, error} on the parks row would read exactly like a park with
    // no restriction, and the seller's tax would go in. It must refuse, say
    // nothing moved, and write nothing.
    failing.add("parks");
    const res = await recordCost(PARK, "sewer", "2026-12-01", "2027-01-01", 1405.36, "");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't check/i);
    expect(res.error).not.toMatch(/closing statement/);
    expect(costRows()).toEqual([]);
  });

  it("still refuses a stranger's park before reading anything", async () => {
    db.park_members = [];
    const res = await recordCost(PARK, "sewer", "2027-01-01", "2027-02-01", 1405.36, "");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("You don't manage that park.");
  });

  // -------------------------------------------------------------------------
  // THE FEE READ GUARDS TWO WRITES AND ONE SENTENCE.
  //
  // The fee-covered and split branches write on the fee's answer — a dropped
  // read there is a second bill for the same water — so a failed read refuses
  // both. The park-carries branch writes park_only whatever the fee says; the
  // read only shapes its refusal on a period from before go-live (the clause
  // naming the evidence door). Refusing that write on a month that IS ours
  // was a refusal on a write the read does not inform.
  // -------------------------------------------------------------------------
  it("a failed fee read does not refuse the park's own cost for a month that is ours — the write never asks the fee", async () => {
    failing.add("park_fees");
    const res = await recordCost(PARK, "other", "2027-01-01", "2027-02-01", 88.4, "Lot 11 electric", null, true);
    expect(res.ok, res.error).toBe(true);
    expect(costRows()).toHaveLength(1);
    expect(costRows()[0].allocation_method).toBe("park_only");
    expect(shareRows()).toEqual([]);
  });

  it("but on a period from before go-live the park-carries refusal stands, and says the door could not be checked — never 'try again' for a write that can never work", async () => {
    failing.add("park_fees");
    const res = await recordCost(PARK, "other", "2026-12-01", "2027-01-01", 88.4, "Lot 11 electric", null, true);
    expect(res.ok).toBe(false);
    // Every fact of the refusal, which does not depend on the fee.
    expect(res.error).toMatch(/period starts in December 2026/);
    expect(res.error).toMatch(/closing statement/);
    expect(res.error).toMatch(/Your books here start with January 2027/);
    // Not the covered clause — a door it cannot vouch for is not named —
    // and not silence about it either: a failed read is not "no fee".
    expect(res.error).not.toMatch(/Split it across the lots/);
    expect(res.error).toMatch(/couldn't be checked/);
    expect(res.error).not.toMatch(/try again/i);
    expect(costRows()).toEqual([]);
  });

  it("and still refuses the two branches whose write depends on the fee, either side of go-live", async () => {
    failing.add("park_fees");
    for (const [from, to] of [["2026-12-01", "2027-01-01"], ["2027-01-01", "2027-02-01"]]) {
      const res = await recordCost(PARK, "sewer", from, to, 1405.36, "LaGrange County");
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/couldn't check/i);
      expect(res.error).not.toMatch(/closing statement/);
    }
    expect(costRows()).toEqual([]);
    expect(shareRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// "SHOW ME THE SPLIT" IS THE ONLY SCREEN DOOR TO THE FEE-COVERED BRANCH.
//
// In the manual form the save button for a non-carried bill renders only
// after a successful preview, and the preview used to refuse every pre-go-live
// period without reading the fees. So the branch the round before opened on
// the server — a covered bill from before go-live goes in as evidence — could
// not be reached from the screen: the two missing Haven baselines (water,
// trash) and the December sewer the January card asks for all ended at a
// 367-character refusal with no button under it. Only ParkCosts.tsx calls
// previewCostSplit and recordCost (grep), so there was no other door.
//
// And the preview lied the other way too: for a covered category in a month
// that IS ours it showed per-lot rows and "Save it and split it", and the save
// then recorded it fee_covered with no split at all.
// ---------------------------------------------------------------------------
describe("previewCostSplit is the screen door to the fee-covered branch", () => {
  beforeEach(() => seedHaven("2027-01-01"));

  it("a June 2026 sewer baseline (covered, before go-live): ok, evidence only, names the fee, no per-lot rows", async () => {
    const res = await previewCostSplit(PARK, "sewer", "2026-06-01", "2026-07-01", 1405.36);
    expect(res.ok, res.error).toBe(true);
    expect(res.preview?.coveredBy).toBe("Grounds fee");
    expect(res.preview?.evidenceOnly).toBe(true);
    expect(res.preview?.allocation).toBeNull();
    expect(res.preview?.amountPaid).toBe(1405.36);
    expect(res.preview?.category).toBe("sewer");
  });

  it("the December sewer the January card asks for: the same — reachable at last", async () => {
    const res = await previewCostSplit(PARK, "sewer", "2026-12-01", "2027-01-01", 1405.36);
    expect(res.ok, res.error).toBe(true);
    expect(res.preview?.coveredBy).toBe("Grounds fee");
    expect(res.preview?.evidenceOnly).toBe(true);
  });

  it("and what that preview's save does is exactly what it said: recorded fee_covered, no shares, the evidence signal", async () => {
    // Driven as the screen drives it: the Record button calls recordCost
    // with parkCarries false and no job id.
    const pre = await previewCostSplit(PARK, "sewer", "2026-12-01", "2027-01-01", 1405.36);
    expect(pre.ok).toBe(true);
    const res = await recordCost(PARK, "sewer", "2026-12-01", "2027-01-01", 1405.36, "LaGrange County", null, false);
    expect(res.ok, res.error).toBe(true);
    expect(costRows()).toHaveLength(1);
    expect(costRows()[0].allocation_method).toBe("fee_covered");
    expect(shareRows()).toEqual([]);
    expect(res.signal).toMatch(/evidence only/);
    expect(res.signal).toMatch(/"Grounds fee"/);
  });

  it("a covered bill from a month that IS ours: ok, covered, NOT evidence-only — never 'save it and split it'", async () => {
    const res = await previewCostSplit(PARK, "sewer", "2027-01-01", "2027-02-01", 1405.36);
    expect(res.ok, res.error).toBe(true);
    expect(res.preview?.coveredBy).toBe("Grounds fee");
    expect(res.preview?.evidenceOnly).toBe(false);
    expect(res.preview?.allocation).toBeNull();
  });

  it("a category no fee covers, from before go-live, is still refused — and never as evidence", async () => {
    const res = await previewCostSplit(PARK, "tax", "2026-01-01", "2027-01-01", 3517.96);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/period starts in January 2026/);
    expect(res.error).not.toMatch(/evidence/i);
    expect(res.preview).toBeUndefined();
  });

  it("a category no fee covers, from a month that is ours, previews the split as before", async () => {
    const res = await previewCostSplit(PARK, "tax", "2027-01-01", "2028-01-01", 3600);
    expect(res.ok, res.error).toBe(true);
    expect(res.preview?.coveredBy).toBeNull();
    expect(res.preview?.evidenceOnly).toBe(false);
    expect(res.preview?.allocation?.shares).toHaveLength(1);
    expect(res.preview?.allocation?.denominatorLots).toBe(2);
  });

  it("a failed park_fees read refuses — it is not 'no fee covers this'", async () => {
    // Either way it fell would be wrong: "no fee" on a pre-go-live period
    // shows the refusal for a bill the save would take; "no fee" on a month
    // that is ours previews a split the save would never make.
    failing.add("park_fees");
    for (const [from, to] of [["2026-12-01", "2027-01-01"], ["2027-01-01", "2027-02-01"]]) {
      const res = await previewCostSplit(PARK, "sewer", from, to, 1405.36);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/couldn't check/i);
      expect(res.error).not.toMatch(/closing statement/);
      expect(res.preview).toBeUndefined();
    }
  });

  it("a covered preview does not depend on the lots being readable — the save never reads them", async () => {
    // The fee-covered branch of recordCost writes without a lots read, so a
    // preview that refused on one would refuse a save that works.
    failing.add("park_lots");
    const res = await previewCostSplit(PARK, "sewer", "2027-01-01", "2027-02-01", 1405.36);
    expect(res.ok, res.error).toBe(true);
    expect(res.preview?.coveredBy).toBe("Grounds fee");
    // ...and an uncovered one still refuses on it, because that save does.
    const split = await previewCostSplit(PARK, "tax", "2027-01-01", "2028-01-01", 3600);
    expect(split.ok).toBe(false);
  });

  it("preview and save agree on every branch — 7 cases, both halves", async () => {
    const cases: Array<[string, string, string, number]> = [
      ["sewer", "2026-06-01", "2026-07-01", 1405.36],   // covered, pre-go-live → evidence
      ["sewer", "2027-01-01", "2027-02-01", 1405.36],   // covered, ours → fee_covered
      ["tax",   "2026-01-01", "2027-01-01", 3517.96],   // uncovered, pre-go-live → refused
      ["tax",   "2027-01-01", "2028-01-01", 3600],      // uncovered, ours → split
      ["snow",  "2026-12-20", "2026-12-21", 165],       // uncovered, pre-go-live → refused
      ["snow",  "2027-01-05", "2027-01-06", 165],       // uncovered, ours → split
      ["unit_electric", "2027-01-01", "2027-02-01", 50], // never split (0069) → refused on both doors
    ];
    let refused = 0;
    for (const [cat, from, to, amt] of cases) {
      inserted.length = 0;
      const pre = await previewCostSplit(PARK, cat as never, from, to, amt);
      const res = await recordCost(PARK, cat as never, from, to, amt, "", null, false);
      expect(res.ok, `${cat} ${from}: preview ${pre.ok} save ${res.ok} — ${res.error ?? ""}`).toBe(pre.ok);
      if (!pre.ok) { refused += 1; expect(res.error).toBe(pre.error); continue; }
      expect(costRows()).toHaveLength(1);
      expect(costRows()[0].allocation_method).toBe(pre.preview?.coveredBy ? "fee_covered" : "per_lot");
      expect(shareRows().length > 0).toBe(pre.preview?.allocation != null);
    }
    expect(refused, "both halves exercised").toBe(3);
  });
});

// ---------------------------------------------------------------------------
// THE COSTS SCREEN RENDERS THE COVERED PREVIEW WITH ITS OWN BUTTON.
//
// A source pin, because the branch is a JSX conditional: the covered preview
// must render a save button that does not hang off `shares` or `problem` —
// there is no allocation to have either.
// ---------------------------------------------------------------------------
describe("ParkCosts renders a covered preview as recorded-not-split, with a Record button", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
  const tsx = () => read("components/ParkCosts.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

  const covered = () => {
    // To the function's own closing brace at column 0 — the props type
    // closes with `}) {`, which `\n}\n` does not match.
    const fn = tsx().match(/function CoveredPreview[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(fn.length, "CoveredPreview not found — this scan measures nothing").toBeGreaterThan(200);
    return fn;
  };

  it("says the fee covers it and that it is recorded, not split — and the evidence sentence only when it is", () => {
    const fn = covered();
    expect(fn).toMatch(/fee already covers this/);
    expect(fn).toMatch(/recorded, not split/);
    expect(fn).toMatch(/evidenceOnly &&/);
    expect(fn).toMatch(/evidence for the fee comparison only/);
  });

  it("has a Record button wired to the save, gated on nothing but busy", () => {
    const fn = covered();
    expect(fn).toMatch(/<button[^>]*onClick=\{onSave\}[^>]*disabled=\{busy\}/);
    expect(fn).toMatch(/Record it/);
    expect(fn).not.toMatch(/shares|problem|allocation/);
  });

  it("is what the screen renders when the preview has no allocation, and the split view is what it renders when it does", () => {
    const src = tsx();
    expect(src).toMatch(/preview\.allocation\s*\?/);
    expect(src).toMatch(/<CoveredPreview[\s\S]*?coveredBy=\{preview\.coveredBy\}[\s\S]*?onSave=\{save\}/);
    // And the per-lot view no longer reads a bare `preview.shares` — the
    // allocation is one level down now, so the old shape cannot compile.
    expect(src).not.toMatch(/preview\.shares/);
  });
});

// ---------------------------------------------------------------------------
// THE ONE-TAP LIST MUST NEVER OFFER A REFUSAL.
//
// getBillableParkJobs feeds the "File as …" buttons, which submit the job's
// own month as the period with no chance to edit it. A plough on 20 December
// at a park going live 1 January would sit there with a button that always
// refuses — the same dead button the file's own 23505 comment describes, one
// screen over from the Today card this diff already fixed.
// ---------------------------------------------------------------------------
describe("getBillableParkJobs and the go-live boundary", () => {
  // CATALOGUE NAMES, because that is what costCategoryForService matches on.
  // The Haven's fee covers `grounds` and not `snow`, so a plough and a mow
  // from the same December go different ways at the door.
  const PLOUGH = "Snow clearing — roads & common drives";   // → snow, no fee
  const MOW = "Park grounds mowing & trim";                 // → grounds, covered
  const job = (id: string, date: string, name: string) => ({
    id, date, customer_price: 165, status: "complete", property_id: "prop-haven",
    services: { name },
  });

  beforeEach(() => {
    seedHaven("2027-01-01");
    db.parks = [{ id: PARK, cutover_date: "2027-01-01", service_property_id: "prop-haven" }];
    db.jobs = [
      job("j-dec-plough", "2026-12-20", PLOUGH),
      job("j-dec-mow", "2026-12-02", MOW),
      job("j-jan-plough", "2027-01-05", PLOUGH),
    ];
  });

  it("lists a pre-go-live job no fee covers WITHOUT a button, and says why", async () => {
    const rows = await getBillableParkJobs(PARK);
    const dec = rows.find((r) => r.jobId === "j-dec-plough");
    expect(dec, "the job he paid for must not vanish from the list").toBeDefined();
    expect(dec!.notOurs).toMatch(/December 2026/);
    expect(dec!.notOurs).toMatch(/January 1, 2027/);
    expect(dec!.notOurs).toMatch(/not ours to split/);
    expect(dec!.notOurs).not.toMatch(/\b2026-12\b/);
  });

  it("keeps the button on a pre-go-live job a fee covers — that tap records evidence, not a refusal", async () => {
    const rows = await getBillableParkJobs(PARK);
    expect(rows.find((r) => r.jobId === "j-dec-mow")?.notOurs).toBeNull();
  });

  it("offers the first job that is ours", async () => {
    const rows = await getBillableParkJobs(PARK);
    const jan = rows.find((r) => r.jobId === "j-jan-plough");
    expect(jan?.notOurs).toBeNull();
    expect(jan?.periodStart).toBe("2027-01-01");
  });

  it("agrees with recordCost — what the list withholds, the action refuses; what it offers, the action takes", async () => {
    // Driven exactly as the button drives it: the job's own dates and the
    // category the screen derives from the service name.
    const rows = await getBillableParkJobs(PARK);
    expect(rows).toHaveLength(3);
    let withheld = 0;
    for (const r of rows) {
      inserted.length = 0;
      const res = await recordCost(
        PARK, costCategoryForService(r.service), r.periodStart, r.periodEnd, r.amount, r.note, r.jobId,
      );
      expect(res.ok, `${r.jobId}: ${res.error ?? res.signal}`).toBe(r.notOurs === null);
      if (r.notOurs !== null) withheld += 1;
      if (r.jobId === "j-dec-mow") {
        expect(costRows()[0]?.allocation_method).toBe("fee_covered");
        expect(res.signal).toMatch(/evidence only/);
      }
    }
    expect(withheld, "both halves exercised").toBe(1);
  });

  it("is no restriction at all for a park with no go-live date", async () => {
    db.parks = [{ id: PARK, cutover_date: null, service_property_id: "prop-haven" }];
    const rows = await getBillableParkJobs(PARK);
    expect(rows.map((r) => r.notOurs)).toEqual([null, null, null]);
  });

  it("a fee that can't be read is not 'no fee covers this' — the list refuses to guess, like the door", async () => {
    // The door refuses on a failed fee read (a second bill is the failure
    // mode). The list has no button to refuse with, so the whole read fails
    // loudly rather than withholding — or offering — on a guess.
    failing.add("park_fees");
    await expect(getBillableParkJobs(PARK)).rejects.toThrow();
  });
});
