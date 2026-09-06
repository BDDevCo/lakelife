import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A CREW WHO OWES US MONEY DISAPPEARS.
 *
 * A clawback after a batch has gone out — a refunded job, a reversed trip fee
 * — lands as a NEGATIVE released payout, and the only way it is ever recovered
 * is out of the crew's future earnings. Until those earnings arrive their
 * released-and-unbatched sum is below zero, and `runMonthlyPayoutBatches`
 * skips them with a bare `if (sum <= 0) continue` — no batch, no line in the
 * run's skipped list, nothing on any screen.
 *
 * So a crew can sit in the red for months while every month-end run reports a
 * clean night. The debt is real, it is being collected silently from work they
 * have not done yet, and the one person who could pick up the phone about it
 * cannot see it exists.
 *
 * The payout queue is the screen that answers "who is owed what". This makes
 * it answer the other half.
 */
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { payout_batches: [], payouts: [] };
const errors: Record<string, string | null> = {};

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, _op: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] != null : r[c] !== v)); return this; }
  order() { return this; }
  limit() { return this; }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const forced = errors[this.t];
    const res = forced
      ? { data: null, error: { message: forced } }
      : { data: (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))), error: null };
    return Promise.resolve(res).then(ok, bad);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("./data", () => ({ assertOps: async () => ({ id: "ops-1", name: "Brendon" }) }));

const { getPayoutQueue } = await import("./payout-data");

/** A released, un-batched payout row — what a month-end run sums per crew. */
function owed(vendorId: string, company: string, amount: number, fixture = false) {
  db.payouts.push({
    vendor_id: vendorId,
    amount,
    status: "released",
    batch_id: null,
    vendors: { company, users: { is_fixture: fixture } },
  });
}

beforeEach(() => {
  db.payout_batches = [];
  db.payouts = [];
  for (const k of Object.keys(errors)) delete errors[k];
});

describe("crews who owe", () => {
  it("names the crew and the amount they are in the red for", async () => {
    owed("v-1", "Twin Lakes Crew", -180);
    owed("v-1", "Twin Lakes Crew", 40);

    const q = await getPayoutQueue();

    expect(q.owing, "a crew in the red is invisible on every screen").toHaveLength(1);
    expect(q.owing[0].payee).toBe("Twin Lakes Crew");
    // Money is cents: -180 + 40 = -140, and the screen shows what is owed.
    expect(q.owing[0].amount).toBe(-140);
  });

  it("leaves out a crew who is merely owed nothing", async () => {
    owed("v-1", "Harbor Dock Co.", 0);
    owed("v-2", "Twin Lakes Crew", 60);
    const q = await getPayoutQueue();
    expect(q.owing).toEqual([]);
  });

  it("leaves out a crew we invented ourselves", async () => {
    // Same fence as dispatch and the ACH export: a fixture is not a person to
    // ring about a debt.
    owed("v-fake", "GreenEdge Lawn Co.", -224, true);
    const q = await getPayoutQueue();
    expect(q.owing).toEqual([]);
  });

  it("fails rather than reporting nobody in the red on a dropped read", async () => {
    errors.payouts = "connection reset";
    await expect(getPayoutQueue()).rejects.toThrow();
  });
});
