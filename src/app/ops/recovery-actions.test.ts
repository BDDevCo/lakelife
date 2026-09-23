import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE FIRST CLICK ON A PROPOSED FEE BRICKED IT, AND SAID THE OPPOSITE.
 *
 * `chargeProposedFee` claims the row into `recovery_state = 'fee_charging'`
 * before any money moves, so that two ops tabs cannot both charge. Every
 * refusal after that claim puts the row back to 'fee_proposed' — a failed
 * invoice read, a failed invoice insert, a failed card read, a failed
 * decline-count read, and the terminal return. One did not: the branch that
 * fires when no card processor is connected.
 *
 * That branch is not an edge case today, it is the ONLY outcome:
 * `paymentsAreLive()` is opt-in and unset, so `takePayment` returns
 * `no_processor` before any network call. The row stayed at 'fee_charging' —
 * the state 0092 built for a charge the processor might have half-completed —
 * so ProposedFees drew the mid-flight alarm ("a charge was started and we never
 * heard back"), `decidable` went false and took both Charge and Waive with it,
 * the gate at the top of this function answered "There's no fee waiting on that
 * one" forever, waiveProposedFee's own gate would not accept it either, and the
 * nightly only ever revisits rows at 'awaiting_customer'. Recovery was
 * hand-written SQL. And the sentence it returned said the fee was still
 * proposed, which was false the moment it was shown.
 *
 * There was no test on this function at all.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/settings", () => ({ getPlatformSettings: async () => ({}) }));
vi.mock("@/lib/automation", () => ({ alertOpsDoubleCharge: async () => {} }));

let chargeResult: { ok: boolean; reason?: string; ref?: string | null } = {
  ok: false,
  reason: "no_processor",
};
vi.mock("@/lib/charge-gate", () => ({
  NO_PROCESSOR_REASON: "no_processor",
  chargeKey: () => "k",
  takePayment: async () => chargeResult,
}));

let isOps = true;
vi.mock("./data", () => ({ assertOps: async () => (isOps ? { id: "ops-1" } : null) }));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { jobs: [], invoices: [], payment_methods: [], payments: [], payouts: [] };

/**
 * A small stand-in for the query builder, in the shape payout-actions.test.ts
 * already uses: filters accumulate, `update` patches the rows that match, and
 * the terminals return what supabase-js returns. It keeps the REAL function
 * under test — only the database is faked.
 */
class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  update(p: Row) { this.op = "update"; this.patch = p; return this; }
  insert(p: Row) { this.op = "insert"; this.patch = p; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  order() { return this; }
  limit() { return this; }
  private hit(): Row[] {
    return (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
  }
  private run(): { data: Row[] | null; error: { message: string } | null; count?: number } {
    if (this.op === "insert") {
      const row = { id: `${this.t}-${(db[this.t] ?? []).length + 1}`, ...(this.patch ?? {}) };
      (db[this.t] ??= []).push(row);
      return { data: [{ ...row }], error: null };
    }
    const hit = this.hit();
    if (this.op === "update" && this.patch) for (const r of hit) Object.assign(r, this.patch);
    return { data: hit.map((r) => ({ ...r })), error: null, count: hit.length };
  }
  async maybeSingle() { const r = this.run(); return { data: r.data?.[0] ?? null, error: r.error }; }
  async single() { const r = this.run(); return { data: r.data?.[0] ?? null, error: r.error }; }
  then<A>(ok?: ((x: { data: Row[] | null; error: { message: string } | null; count?: number }) => A) | null) {
    return Promise.resolve(this.run()).then(ok);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { chargeProposedFee } = await import("./recovery-actions");

const JOB = "job-1";
function proposedFee() {
  db.jobs = [{
    id: JOB, recovery_state: "fee_proposed", fee_proposed_amount: 151,
    vendor_id: "v-1", vendor_cost: 40, property_id: "p-1", service_id: "s-1",
    properties: { owner_id: "u-1" },
  }];
  db.invoices = [];
  db.payments = [];
  db.payouts = [];
  db.payment_methods = [{ id: "pm-1", user_id: "u-1", token: "tok_x", is_default: true, created_at: "2026-01-01" }];
}
const state = () => db.jobs[0].recovery_state;

beforeEach(() => {
  isOps = true;
  chargeResult = { ok: false, reason: "no_processor" };
  proposedFee();
});

describe("a proposed fee clicked with no processor connected", () => {
  it("charges nothing and says so", async () => {
    const res = await chargeProposedFee(JOB);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("aren't switched on yet");
    expect(db.payments).toHaveLength(0);
  });

  it("leaves the fee proposed, not stranded mid-charge", async () => {
    await chargeProposedFee(JOB);
    // 'fee_charging' is the state a crash between us and the processor leaves.
    // Nothing left the building, so nothing may claim that state.
    expect(state()).toBe("fee_proposed");
    expect(state()).not.toBe("fee_charging");
  });

  it("stays clickable — the same fee can be charged the day a processor is wired in", async () => {
    await chargeProposedFee(JOB);
    // The second click used to hit the gate at the top and be refused with
    // "There's no fee waiting on that one" about a fee sitting right there.
    const second = await chargeProposedFee(JOB);
    expect(second.error).not.toContain("no fee waiting");

    chargeResult = { ok: true, ref: "ref_1" };
    const third = await chargeProposedFee(JOB);
    expect(third.ok).toBe(true);
    expect(state()).toBe("fee_charged");
  });

  it("tells ops about the invoice it left behind, like the decline path does", async () => {
    const res = await chargeProposedFee(JOB);
    expect(db.invoices).toHaveLength(1);
    expect(db.invoices[0].status).toBe("due");
    expect(res.error).toContain("still due");
  });

  it("refuses anyone who is not ops, before it claims anything", async () => {
    isOps = false;
    const res = await chargeProposedFee(JOB);
    expect(res).toEqual({ ok: false, error: "Ops only." });
    expect(state()).toBe("fee_proposed");
  });
});
