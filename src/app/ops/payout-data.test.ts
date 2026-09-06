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
  /**
   * TWO READS HIT `payout_batches` — the queue and the returned list — so a
   * failure keyed on the table alone cannot say which one it broke. Without
   * this, the "fails on a dropped read" test below passed by failing the
   * OTHER query and proved nothing about the one it names.
   */
  private statusEq: string | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) {
    if (c === "status" && typeof v === "string") this.statusEq = v;
    this.fs.push((r) => r[c] === v);
    return this;
  }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, _op: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] != null : r[c] !== v)); return this; }
  order() { return this; }
  limit() { return this; }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const forced = (this.statusEq ? errors[`${this.t}:${this.statusEq}`] : null) ?? errors[this.t];
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

/**
 * A RETURNED PAYOUT WAS INVISIBLE, WHICH MADE THE FIX UNREACHABLE.
 *
 * 0158 gave a returned batch somewhere to land and `markBatchesReturned`
 * writes it. But this query asked for `status in ('queued','exported')`, so
 * the moment a batch went to 'failed' it vanished from the only screen that
 * shows payouts — taking `returned_reason`, the one thing that tells anybody
 * what to fix, with it.
 */
function returnedBatch(id: string, company: string, net: number, when: string, reason: string | null) {
  db.payout_batches.push({
    id,
    kind: "monthly",
    net,
    status: "failed",
    created_at: "2027-01-31T00:00:00Z",
    returned_at: when,
    returned_reason: reason,
    vendors: { company },
    users: { name: null },
  });
}

describe("payouts the bank sent back", () => {
  it("names the crew, the money and what the bank said", async () => {
    returnedBatch("b-1", "Twin Lakes Crew", 640, "2027-02-04T00:00:00Z", "R02 account closed");

    const q = await getPayoutQueue();

    expect(q.returned, "a returned payout is invisible on every screen").toHaveLength(1);
    expect(q.returned[0].payee).toBe("Twin Lakes Crew");
    expect(q.returned[0].net).toBe(640);
    expect(q.returned[0].reason).toBe("R02 account closed");
  });

  it("keeps a returned batch out of the queued and exported totals", async () => {
    // The money is back in the un-batched pool the moment it is marked
    // returned. Counting it here as well would show it twice and overstate
    // what is in flight to the bank.
    returnedBatch("b-1", "Twin Lakes Crew", 640, "2027-02-04T00:00:00Z", "R02 account closed");
    const q = await getPayoutQueue();
    expect(q.queuedCount).toBe(0);
    expect(q.exportedCount).toBe(0);
    expect(q.queuedTotal).toBe(0);
    expect(q.exportedTotal).toBe(0);
    expect(q.rows).toEqual([]);
  });

  it("says so plainly when an old row carries no reason", async () => {
    // The action refuses a blank reason, so this can only be a row written
    // before it existed. Rendering nothing would read as "no problem here".
    returnedBatch("b-1", "Twin Lakes Crew", 640, "2027-02-04T00:00:00Z", "   ");
    const q = await getPayoutQueue();
    expect(q.returned[0].reason).toBe("No reason was recorded.");
  });

  it("fails rather than reporting nothing came back on a dropped read", async () => {
    // Keyed to the RETURNED read specifically, and asserted on WHICH read
    // threw. On the bare table key this passed by breaking the queue read
    // instead — green, and proving nothing about the line it names.
    errors["payout_batches:failed"] = "connection reset";
    await expect(getPayoutQueue()).rejects.toThrow(/the payouts the bank sent back/);
  });
});
