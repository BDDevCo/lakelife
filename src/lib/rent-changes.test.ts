import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AN APPLIED INCREASE FOLLOWS THE CHAIN, NOT THE LINK.
 *
 * A rent change is pinned to ONE lot_reservations row — the one covering its
 * effective date when it was scheduled. But a chain rolls: on 17 March Today
 * lists the Feb–May row (May 1 is within 45 days) and the owner writes the
 * May–Aug successor. On 1 April the nightly applies $425 to the Feb–May row
 * only. April bills $425; May bills the successor at $400, and nothing on any
 * screen says the increase was lost.
 *
 * The successor doors now resolve the rent in force at their start, which
 * covers the served-then-renewed ordering. This covers the other one:
 * scheduled, renewed, THEN noticed — where the change was not history yet
 * when the successor was written. Applying it must carry it onto every later
 * link of the same chain that is still at the old number.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, op: string, v: unknown) {
    if (op === "is" && v === null) this.fs.push((r) => r[c] != null);
    return this;
  }
  gt(c: string, v: unknown) { this.fs.push((r) => (r[c] as number) > (v as number)); return this; }
  lte(c: string, v: unknown) { this.fs.push((r) => (r[c] as string) <= (v as string)); return this; }
  private sortBy: string | null = null;
  order(c: string) { this.sortBy = c; return this; }
  private rows(): Row[] {
    const out = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.sortBy) out.sort((a, b) => String(a[this.sortBy!]).localeCompare(String(b[this.sortBy!])));
    return out;
  }
  maybeSingle() { const rows = this.rows(); return Promise.resolve({ data: rows[0] ?? null, error: null }); }
  update(patch: Row) { this.patch = patch; return this; }
  then<A, B>(
    ok?: ((x: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const rows = this.rows();
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
  todayLakeDate: () => "2027-04-01",
}));

const { applyDueRentChangesFor } = await import("./rent-changes");

const res = (id: string, chain: string, seq: number, during: string, quoted: number, status = "approved"): Row => ({
  id, park_lot_id: "lot-7", agreement_chain_id: chain, agreement_seq: seq, during,
  quoted_amount: quoted, status, amount_source: "tenant_confirmed", amount_source_at: "2027-02-01T00:00:00Z",
});

beforeEach(() => {
  db.lot_rent_changes = [{
    id: "c1", park_id: "park-1", reservation_id: "res-feb",
    effective_on: "2027-04-01", from_amount: 400, to_amount: 425,
    notice_given_on: "2027-03-20", applied_at: null, cancelled_at: null,
  }];
  db.lot_reservations = [
    res("res-jan", "chain-a", 1, "[2027-01-01,2027-02-01)", 400, "active"),
    res("res-feb", "chain-a", 2, "[2027-02-01,2027-05-01)", 400, "active"),
    // Renewed on Mar 17 at "the same rent" — before notice was recorded.
    res("res-may", "chain-a", 3, "[2027-05-01,2027-08-01)", 400),
    // Renewed later at a number he typed himself: not the old rent, so not ours to move.
    res("res-aug", "chain-a", 4, "[2027-08-01,2027-11-01)", 450),
    // Another household at the same old number: a different chain, untouched.
    res("res-other", "chain-b", 2, "[2027-02-01,2027-05-01)", 400),
    // A link in the chain that is no longer live.
    res("res-dead", "chain-a", 5, "[2027-11-01,2028-02-01)", 400, "cancelled"),
  ];
});

const byId = (id: string) => db.lot_reservations.find((r) => r.id === id)!;

describe("applyDueRentChangesFor carries the increase down the chain", () => {
  it("moves the pinned row AND every later link still at the old rent", async () => {
    const out = await applyDueRentChangesFor("park-1");
    expect(out).toEqual({ applied: 1, skipped: 0, errors: [] });

    expect(byId("res-feb").quoted_amount).toBe(425);
    expect(byId("res-may").quoted_amount).toBe(425);
    expect(byId("res-may").amount_source).toBe("owner_knowledge");
    expect(db.lot_rent_changes[0].applied_at).toBeTruthy();
  });

  it("leaves alone a later link he re-rated himself, an earlier link, another chain, a dead link", async () => {
    await applyDueRentChangesFor("park-1");
    expect(byId("res-aug").quoted_amount).toBe(450);
    expect(byId("res-aug").amount_source).toBe("tenant_confirmed");
    expect(byId("res-jan").quoted_amount).toBe(400);
    expect(byId("res-other").quoted_amount).toBe(400);
    expect(byId("res-dead").quoted_amount).toBe(400);
  });

  it("two changes due on one row after a missed nightly land in date order, not arbitrary order", async () => {
    // Today is 1 April and the nightly has been down since the 9th of March:
    // $400→$425 from 10 March and $425→$450 from 25 March are both due.
    // Seeded LATER-FIRST so an unordered read applies $425→$450 before
    // $400→$425 and the row ends at $425.
    db.lot_rent_changes = [
      {
        id: "c2", park_id: "park-1", reservation_id: "res-feb",
        effective_on: "2027-03-25", from_amount: 425, to_amount: 450,
        notice_given_on: "2027-02-20", applied_at: null, cancelled_at: null,
      },
      {
        id: "c1", park_id: "park-1", reservation_id: "res-feb",
        effective_on: "2027-03-10", from_amount: 400, to_amount: 425,
        notice_given_on: "2027-02-05", applied_at: null, cancelled_at: null,
      },
    ];
    const { todayLakeDate } = await import("@/lib/booking");
    expect(todayLakeDate()).toBe("2027-04-01");
    const out = await applyDueRentChangesFor("park-1");
    expect(out.applied).toBe(2);
    expect(byId("res-feb").quoted_amount).toBe(450);
    expect(byId("res-may").quoted_amount).toBe(450);
  });

  it("carries nothing when the change recorded no 'from' — there is nothing to match", async () => {
    db.lot_rent_changes[0].from_amount = null;
    await applyDueRentChangesFor("park-1");
    expect(byId("res-feb").quoted_amount).toBe(425);
    expect(byId("res-may").quoted_amount).toBe(400);
  });
});
