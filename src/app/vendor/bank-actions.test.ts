import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE 2% BOUGHT NOTHING.
 *
 * "Get it now" charges the early_payout_fee_pct dial — 2% today — and then
 * queues a batch that waits for exactly the same thing a free month-end batch
 * waits for: a human opening /ops and clicking Download ACH batch. Nobody was
 * ever told one was waiting. A crew could pay $4 on $200 for speed that
 * depended entirely on somebody happening to look at a screen.
 *
 * This is the repo's own "a switch is a wish, a processor is a rail" pattern.
 * There is no automated payout rail, so the capability the fee is sold against
 * is a PERSON — and the honest version of that is: tell the person, the moment
 * it queues, and refuse to take the fee when there is no person to tell.
 *
 * It deliberately does NOT change the fee, waive it, or hide the button on a
 * guess. What to charge for an early pull is the owner's dial.
 */
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { vendors: [], payout_accounts: [], payout_batches: [], payouts: [], users: [] };
let seq = 0;

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" | "delete" = "select";
  private patch: Row | null = null;
  private ins: Row[] = [];
  constructor(private t: string) {}
  select() { return this; }
  update(p: Row) { this.op = "update"; this.patch = p; return this; }
  insert(v: Row | Row[]) { this.op = "insert"; this.ins = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Row) { this.op = "insert"; this.ins = [v]; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, _op: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] != null : r[c] !== v)); return this; }
  order() { return this; }
  private run(): { data: Row[] | null; error: { message: string } | null } {
    if (this.op === "insert") {
      const made = this.ins.map((r) => ({ id: `gen-${++seq}`, ...r }));
      (db[this.t] ??= []).push(...made);
      return { data: made, error: null };
    }
    const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.op === "update" && this.patch) for (const r of hit) Object.assign(r, this.patch);
    if (this.op === "delete") db[this.t] = (db[this.t] ?? []).filter((r) => !hit.includes(r));
    return { data: hit.map((r) => ({ ...r })), error: null };
  }
  single() {
    const r = this.run();
    return Promise.resolve({ data: r.data?.[0] ?? null, error: r.data?.length ? null : { message: "no rows" } });
  }
  maybeSingle() { return Promise.resolve({ data: this.run().data?.[0] ?? null, error: null }); }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

const USER_ID = "u-crew";
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) } }),
}));

vi.mock("@/lib/settings", () => ({
  getPlatformSettings: async () => ({ earlyPayoutFeePct: 0.02 }),
}));

interface Told { what: string; to: { phone?: string | null; email?: string | null }; msg: { sms: string; subject: string; body?: string } }
const told: Told[] = [];
vi.mock("@/lib/notify", () => ({
  notify: async (what: string, to: Told["to"], msg: Told["msg"]) => {
    told.push({ what, to, msg });
    return { reached: true, bySms: false, byEmail: true };
  },
}));

const { requestEarlyPayout } = await import("./bank-actions");

beforeEach(() => {
  told.length = 0;
  db.vendors = [{ id: "v-1", company: "Twin Lakes Crew", user_id: USER_ID }];
  db.payout_accounts = [{ user_id: USER_ID, account_last4: "6633" }];
  db.payout_batches = [];
  db.payouts = [
    { id: "p-1", vendor_id: "v-1", status: "released", batch_id: null, amount: 200, kind: "earning" },
  ];
  db.users = [
    { id: USER_ID, phone: "+15745551212", email: "crew@example.com", role: "vendor" },
    { id: "ops-1", phone: null, email: "ops@lakelife.co", role: "ops" },
  ];
});

describe("somebody is told the moment an early batch queues", () => {
  it("tells ops the file needs pulling, naming the crew and the amount", async () => {
    const res = await requestEarlyPayout();
    expect(res.ok).toBe(true);

    const toOps = told.find((t) => t.to.email === "ops@lakelife.co");
    expect(toOps, "the crew paid 2% for speed and nobody was asked to hurry").toBeTruthy();
    expect(toOps!.msg.sms).toContain("Twin Lakes Crew");
    expect(toOps!.msg.sms).toContain("196.00"); // 200 − 2%
    expect(`${toOps!.msg.sms} ${toOps!.msg.subject}`).toMatch(/early/i);

    // And the crew still gets their own receipt — this adds a door, it does
    // not move one.
    expect(told.find((t) => t.to.email === "crew@example.com")).toBeTruthy();
  });

  it("never puts a bank number in the ops alert", async () => {
    await requestEarlyPayout();
    const toOps = told.find((t) => t.to.email === "ops@lakelife.co")!;
    expect(JSON.stringify(toOps)).not.toContain("6633");
  });

  it("takes no fee at all when there is nobody who could pull the file", async () => {
    // Not a hypothetical: ops with no email and a dead SMS channel is exactly
    // where this product is today.
    db.users = db.users.filter((u) => u.role !== "ops");

    const res = await requestEarlyPayout();

    expect(res.ok, "2% was charged for speed nobody could deliver").toBe(false);
    expect(db.payout_batches, "a batch was queued that nobody knows about").toHaveLength(0);
    expect(db.payouts[0].batch_id, "the crew's pay was stranded in a batch that never happened").toBeNull();
    expect(db.payouts[0].status).toBe("released");
    expect(told).toHaveLength(0);
  });

  it("still charges the dial, and still spares the tip", async () => {
    db.payouts.push({ id: "p-2", vendor_id: "v-1", status: "released", batch_id: null, amount: 50, kind: "tip" });
    const res = await requestEarlyPayout();
    expect(res.gross).toBe(250);
    expect(res.fee).toBe(4); // 2% of the earned 200 — never of the $50 tip
    expect(res.net).toBe(246);
  });
});
