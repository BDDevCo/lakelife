import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A SECOND TAP ON RENEW.
 *
 * The owner with /park/today open in two tabs taps "Renew at the same rent"
 * twice. The first tap writes the successor. The second used to sail past the
 * planner, reach the insert, and be stopped only by the exclusion constraint
 * `lot_no_double_booking` — which the door reported as "Couldn't write that
 * one — check the dates don't overlap another tenancy on the same lot."
 *
 * There is no other tenancy. It is the successor his own first tap wrote, and
 * the sentence sent him to the rent roll hunting a double-booking that does
 * not exist. Nothing double-billed — that was always the good half — but from
 * 1 January he writes roughly nineteen of these a month, and the bad half is
 * the sentence.
 *
 * Every other doorway already answered it: the resident's link returns
 * `already_renewed`, "Agreements to write" filters on `hasLaterLink`, and so
 * does the nightly. This is the third doorway, and these tests pin the branch
 * BOTH ways — a held later link refuses, an ended one still says they moved
 * out, and a chain with nothing after it still renews.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const inserted: Row[] = [];

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  private rows(): Row[] { return (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))); }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
  single() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
  insert(rows: Row | Row[]) {
    const many = Array.isArray(rows) ? rows : [rows];
    for (const r of many) inserted.push(r);
    // The shape the caller reads back: .insert(...).select("id").single().
    return {
      select: () => ({ single: () => Promise.resolve({ data: { id: "res-new" }, error: null }) }),
    };
  }
  then<A, B>(
    ok?: ((x: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve({ data: this.rows(), error: null }).then(ok, bad);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("./data", () => ({ assertMyPark: async () => ({ role: "owner" }) }));
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => "2027-01-20",
}));
vi.mock("@/lib/rent-changes", () => ({
  servedRentHistory: async () => ({ byRes: new Map(), error: null }),
}));
vi.mock("./gap-bills", () => ({
  parkRanMonth: async () => false,
  billLostMonths: async () => ({ billed: [], already: [], refused: [] }),
  lostMonthsWords: () => "",
}));

const { previewRenewal, renewAgreement } = await import("./renew-actions");

/** The Haven's dials: one-month house style under a six-month ceiling. */
const PARK = {
  id: "park-1",
  max_agreement_months: 6,
  default_agreement_months: 1,
  deposit_amount: null,
  cutover_date: "2027-01-01",
  season_open_month: null, season_open_day: null,
  season_close_month: null, season_close_day: null,
};

const JAN: Row = {
  id: "res-jan", park_lot_id: "lot-7", renter_id: "r1", renter_unit_id: null,
  during: "[2027-01-01,2027-02-01)", quoted_amount: 400, term: "monthly",
  agreement_chain_id: null, agreement_seq: 1, status: "active", origin: "office",
  due_day: 1, tenancy_began_on: "2027-01-01", amount_source: null, amount_source_at: null,
};

/** The successor his first tap wrote. */
const feb = (status: string): Row => ({
  id: "res-feb", park_lot_id: "lot-7", renter_id: "r1", renter_unit_id: null,
  during: "[2027-02-01,2027-03-01)", quoted_amount: 400, term: "monthly",
  agreement_chain_id: "res-jan", agreement_seq: 2, status, origin: "office",
  due_day: 1, tenancy_began_on: "2027-01-01", amount_source: null, amount_source_at: null,
});

beforeEach(() => {
  inserted.length = 0;
  db.parks = [PARK];
  db.park_lots = [{ id: "lot-7", park_id: "park-1", lot_number: "7", season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null }];
  db.park_renters = [{ id: "r1", display_name: "Donna" }];
  db.lot_reservations = [JAN];
});

describe("the second tap on Renew", () => {
  it("is answered by the planner, not by the database, and names his own first tap", async () => {
    db.lot_reservations = [JAN, feb("approved")];
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.ok).toBe(true);
    expect(pre.preview!.plan.ok).toBe(false);
    expect(pre.preview!.plan.refusal).toBe("already_renewed");
    // The date is words, and it is the successor's own first morning.
    expect(pre.preview!.refusalText)
      .toBe("Lot 7's next agreement is already written, from February 1, 2027.");
    // Never the database's sentence about somebody else's tenancy.
    expect(pre.preview!.refusalText).not.toMatch(/overlap another tenancy/);
    // A refusal is true of every length, so there is nothing left to pick.
    expect(pre.preview!.lengths).toHaveLength(0);
  });

  it("stops the write before the insert — the row is refused, not attempted", async () => {
    db.lot_reservations = [JAN, feb("approved")];
    const res = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Lot 7's next agreement is already written, from February 1, 2027.");
    expect(inserted).toHaveLength(0);
  });

  it("counts an 'active' successor too, not only an approved one", async () => {
    db.lot_reservations = [JAN, feb("active")];
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.plan.refusal).toBe("already_renewed");
  });

  // ---- the branch, collapsed the other way -------------------------------

  it("a chain with nothing written after it still renews", async () => {
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.plan.ok).toBe(true);
    expect(pre.preview!.plan.start).toBe("2027-02-01");
    const res = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  it("a cancelled successor is not a renewal — the lot renews again", async () => {
    // A cancelled or declined successor is not a renewal. It is not even
    // read: `links` is queried .in('approved','active','ended'), so the
    // query is what excludes it, and that is what this pins. The predicate's
    // own 'not ended' clause is what makes `laterHeld` mean HELD; it cannot
    // be seen from outside, because an ended later link is overridden to
    // 'moved_out' one line below either way — which is the right answer.
    db.lot_reservations = [JAN, feb("cancelled")];
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.plan.ok).toBe(true);
  });

  it("an ENDED later link still says they moved out — the final fact, not 'already renewed'", async () => {
    db.lot_reservations = [JAN, feb("ended")];
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.plan.refusal).toBe("moved_out");
    expect(pre.preview!.refusalText).toMatch(/they moved out/);
  });

  it("a holdover is still sent to the rent roll — 'inherited' outranks it", async () => {
    db.lot_reservations = [{ ...JAN, origin: "grandfathered" }, feb("approved")];
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.plan.refusal).toBe("inherited");
    expect(pre.preview!.refusalText).toMatch(/They signed the new lease/);
  });
});
