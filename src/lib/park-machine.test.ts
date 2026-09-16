import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE NIGHTLY, DRIVEN — the real runParkNightly over a fake admin, so what
 * is asserted is the sentence the owner reads, not a rebuilt copy of the
 * rule that makes it. Three doorways answer "is this lot lived on with its
 * paperwork run out" (the roll, Today, this), and this was the one that
 * answered it from ANY held row behind today: a checked-out weekend guest
 * was "a household living here with no agreement that has not run out",
 * every night, until somebody hand-closed the row; a family closed out of
 * their successor read the same; and a lot that WAS lapsed had its unbilled
 * months skipped, because "occupied" here was the current link alone.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let TODAY = "2027-03-16";

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private ins: Row[] | null = null;
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gte(c: string, v: unknown) { this.fs.push((r) => r[c] != null && (r[c] as string) >= (v as string)); return this; }
  limit() { return this; }
  insert(row: Row | Row[]) { this.ins = Array.isArray(row) ? row : [row]; return this; }
  update(patch: Row) { this.patch = patch; return this; }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string; code?: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    if (this.ins) {
      for (const r of this.ins) (db[this.t] ??= []).push({ ...r });
      return Promise.resolve({ data: this.ins, error: null }).then(ok, bad);
    }
    const rows = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.patch) for (const r of rows) Object.assign(r, this.patch);
    return Promise.resolve({ data: rows, error: null }).then(ok, bad);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => TODAY,
}));

const { runParkNightly } = await import("./park-machine");

/** One live lot 9 at a park that went live on 1 January 2027. */
function seed(reservations: Row[], charges: Row[] = []) {
  for (const k of Object.keys(db)) delete db[k];
  db.parks = [{ id: "park-1", name: "Probe Park", cutover_date: "2027-01-01" }];
  db.park_lots = [{ id: "L9", lot_number: "9", park_id: "park-1", lifecycle: "live" }];
  db.lot_reservations = reservations.map((r) => ({ park_lot_id: "L9", quoted_amount: 542.53, term: "monthly", ...r }));
  db.park_charges = charges.map((c) => ({ park_id: "park-1", park_lot_id: "L9", status: "open", amount: 542.53, ...c }));
  db.park_payment_claims = [];
  db.park_machine_runs = [];
}

const urgentOf = async () => (await runParkNightly()).urgent;
const EXPIRED = /living here with no agreement that has not run out/;

beforeEach(() => { TODAY = "2027-03-16"; });

describe("the nightly reads the roll's own lapsed rule", () => {
  it("a lapsed monthly household IS named — and its unbilled months with it", async () => {
    // January billed on the lapsed row; the row runs to 1 March, so
    // February is a hole the rent screen's Bill button would raise.
    seed(
      [{ id: "r9", during: "[2027-01-01,2027-03-01)", status: "active" }],
      [{ id: "c-jan", reservation_id: "r9", period_month: "2027-01" }],
    );
    const urgent = await urgentOf();
    expect(urgent.some((u) => EXPIRED.test(u) && u.includes("lot 9"))).toBe(true);
    // The line "names every unbilled month" — this lot was the one it skipped.
    expect(urgent.some((u) => u.includes("lot 9 (February 2027)"))).toBe(true);
    // Not a rent nobody set: nothing is current to read a rent from.
    expect((await runParkNightly()).urgent.join(" ")).not.toMatch(/I don't know what lot 9 should pay/);
  });

  it("a checked-out stay by the night or the week is not a household with paperwork run out; the same dates paid monthly are", async () => {
    for (const term of ["nightly", "weekly"]) {
      seed([{ id: "r9", during: "[2027-03-05,2027-03-07)", status: "approved", term, quoted_amount: 80 }]);
      expect((await urgentOf()).join(" "), term).not.toMatch(EXPIRED);
    }
    seed([{ id: "r9", during: "[2027-03-05,2027-03-07)", status: "approved", term: "monthly" }]);
    expect((await urgentOf()).join(" ")).toMatch(EXPIRED);
  });

  it("a household closed out of its successor has left — the expired prior is not lapsed", async () => {
    // January held and run out; the family moved out on 10 February inside
    // the successor, which is the only link the move-out marks `ended`.
    seed([
      { id: "jan", during: "[2027-01-01,2027-02-01)", status: "active" },
      { id: "feb", during: "[2027-02-01,2027-02-11)", status: "ended", moved_out_on: "2027-02-10" },
    ]);
    const urgent = await urgentOf();
    expect(urgent.join(" ")).not.toMatch(EXPIRED);
    expect(urgent.join(" ")).not.toMatch(/Somebody lives there/);
    // Collapsed the other way: the successor WITHDRAWN, and January is lapsed.
    seed([
      { id: "jan", during: "[2027-01-01,2027-02-01)", status: "active" },
      { id: "feb", during: "[2027-02-01,2027-02-11)", status: "cancelled" },
    ]);
    expect((await urgentOf()).join(" ")).toMatch(EXPIRED);
  });

  it("a lot with a later link still to start is not lapsed either", async () => {
    seed([
      { id: "jan", during: "[2027-01-01,2027-02-01)", status: "active" },
      { id: "apr", during: "[2027-04-01,2027-05-01)", status: "approved" },
    ]);
    expect((await urgentOf()).join(" ")).not.toMatch(EXPIRED);
  });

  it("the ended rows never reach the rows the run would bill — a moved-out part month is not named here", async () => {
    // The move-out's February (1st–10th) has no bill; that question is the
    // move-out's, not this read's, and the file says so.
    seed([
      { id: "jan", during: "[2027-01-01,2027-02-01)", status: "active" },
      { id: "feb", during: "[2027-02-01,2027-02-11)", status: "ended", moved_out_on: "2027-02-10" },
    ], [{ id: "c-jan", reservation_id: "jan", period_month: "2027-01" }]);
    expect((await urgentOf()).join(" ")).not.toMatch(/February 2027/);
  });
});
