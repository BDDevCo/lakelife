import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AN ACH RETURN OF A PAYOUT HAD NOWHERE TO LAND.
 *
 * A payout leaves as a line in a bank file. Three to five business days later
 * the bank can hand it straight back — closed account, wrong routing number, a
 * digit transposed on a cheque. `markBatchesPaid` was the only thing that
 * could move a batch, and it moves it one way. So a returned payout left the
 * batch sitting at 'paid' or 'exported' forever AND left the crew's payout
 * rows stamped with `batch_id`, which is what every re-batch query filters on.
 *
 * The consequence is not paperwork. Those rows can never be claimed into
 * another batch, so a crew whose bank details were wrong by one digit is owed
 * money the product can no longer pay them, and no screen says so.
 *
 * `payout_batches.status` has permitted 'failed' since 0039 (verified against
 * production) and nothing had ever written it.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { payout_batches: [], payouts: [] };
const errors: Record<string, string | null> = {};

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" = "select";
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  update(p: Row) { this.op = "update"; this.patch = p; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  order() { return this; }
  private run(): { data: Row[] | null; error: { message: string } | null } {
    const forced = errors[`${this.op}:${this.t}`];
    if (forced) return { data: null, error: { message: forced } };
    const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.op === "update" && this.patch) for (const r of hit) Object.assign(r, this.patch);
    return { data: hit.map((r) => ({ ...r })), error: null };
  }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

let isOps = true;
vi.mock("./data", () => ({ assertOps: async () => (isOps ? { id: "ops-1", name: "Brendon" } : null) }));

const { markBatchesReturned, markBatchesPaid } = await import("./payout-actions");

function batch(id: string, status: string) {
  db.payout_batches.push({ id, status, net: 224, vendor_id: `v-${id}`, paid_at: status === "paid" ? "2026-09-30T00:00:00Z" : null });
  db.payouts.push({ id: `p-${id}`, vendor_id: `v-${id}`, batch_id: id, status: "released", amount: 224 });
}

beforeEach(() => {
  db.payout_batches = [];
  db.payouts = [];
  for (const k of Object.keys(errors)) delete errors[k];
  isOps = true;
});

describe("a payout the bank handed back", () => {
  it("marks the batch failed, with when and why", async () => {
    batch("b-1", "paid");
    const res = await markBatchesReturned(["b-1"], "R03 no account / unable to locate");

    expect(res.ok).toBe(true);
    const b = db.payout_batches[0];
    expect(b.status).toBe("failed");
    expect(b.returned_at, "nothing records when the money came back").toBeTruthy();
    expect(b.returned_reason).toBe("R03 no account / unable to locate");
  });

  it("frees the crew's payouts so they re-batch next run", async () => {
    batch("b-1", "exported");
    await markBatchesReturned(["b-1"], "R02 account closed");
    expect(db.payouts[0].batch_id, "the crew's money is still stuck to a batch that failed").toBeNull();
    expect(db.payouts[0].status).toBe("released");
  });

  it("refuses without a reason — a returned payout nobody can explain is a mystery", async () => {
    batch("b-1", "paid");
    const res = await markBatchesReturned(["b-1"], "   ");
    expect(res.ok).toBe(false);
    expect(db.payout_batches[0].status).toBe("paid");
  });

  it("will not touch a batch that has never been in a file", async () => {
    batch("b-1", "queued");
    const res = await markBatchesReturned(["b-1"], "R03");
    expect(res.ok).toBe(false);
    expect(db.payout_batches[0].status).toBe("queued");
    expect(db.payouts[0].batch_id).toBe("b-1");
  });

  it("is ops-only", async () => {
    isOps = false;
    batch("b-1", "paid");
    const res = await markBatchesReturned(["b-1"], "R03");
    expect(res.ok).toBe(false);
    expect(db.payout_batches[0].status).toBe("paid");
  });

  it("says so loudly when the batch failed but the money is still stuck to it", async () => {
    // The unclaim is the half that lets the crew be paid again. If it fails,
    // "returned" is true and "re-batches next month" is not — and the crew is
    // the one who finds out.
    batch("b-1", "paid");
    errors["update:payouts"] = "connection reset";
    const res = await markBatchesReturned(["b-1"], "R03");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/still/i);
  });
});

describe("marking paid still works", () => {
  it("closes an exported batch", async () => {
    batch("b-1", "exported");
    const res = await markBatchesPaid(["b-1"]);
    expect(res.ok).toBe(true);
    expect(db.payout_batches[0].status).toBe("paid");
  });
});
