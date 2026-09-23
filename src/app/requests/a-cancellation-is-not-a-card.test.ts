import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE CANCELLATION SUCCEEDED AND THE CUSTOMER WAS TOLD IT FAILED.
 *
 * `cancelRequest`'s fee path commits in this order: flip the job to
 * `cancelled` and clear its route stop, raise the fee invoice `due`, then ask
 * the card. With no processor connected the gate answers
 * `{ok:false, reason:"no_processor"}` — nobody's card was asked — and the
 * branch that read that RETURNED `{ok:false, "Card payments aren't switched on
 * yet … The office can take this one."}` over a cancellation that had already
 * happened.
 *
 * Three separate harms out of one early return, and this is production's
 * default state today: the processor is off, so this was the outcome of every
 * late cancellation by a customer with a card on file.
 *
 *   THE SENTENCE IS FALSE WHEN IT IS SHOWN. CancelRequestButton paints
 *   ok:false red and then refreshes the visit away, so the customer reads a
 *   failure while watching it succeed — and tapping Cancel again meets the
 *   `.eq("status","scheduled")` guard and earns a second red error they can
 *   never get past.
 *
 *   THE CREW IS NEVER TOLD. Their "your stop was cancelled late" notice sits
 *   below the return, and so does the owner's notice — the only place anybody
 *   is ever told a late fee is now on their bill. Text has delivered nothing
 *   since July, so email was the one live door and this branch opened neither.
 *
 *   IT NAMES A CONTROL NOBODY HAS. There is no door in /ops that collects a
 *   cancellation fee; the only ops charge button is the no-show visit fee.
 *
 * The fix skips the ONE thing that would be untrue — a `failed` payments row
 * for a card nobody presented — and lets everything else run. What must NOT
 * change: a real bank decline still files that row, and `charged` stays false
 * so the crew's payout is still gated on money actually arriving.
 */

// ------------------------------------------------------------- the mock db

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let seq = 0;

const OWNER = "owner-1";
const JOB = "job-1";
const VENDOR = "v1";
const CREW_USER = "crew-user-1";

/** What the mock processor should answer while payments are "live". */
let chargeAnswer: { ok: boolean; ref?: string; error?: string } = { ok: true, ref: "ch_mock_1" };

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private lim: number | null = null;
  private op: "update" | "insert" | "delete" | null = null;
  private payload: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  insert(p: Row) { this.op = "insert"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }

  private matched(): Row[] {
    const all = (db[this.t] ??= []).filter((r) => this.fs.every((f) => f(r)));
    return this.lim == null ? all : all.slice(0, this.lim);
  }
  /** Run whatever was asked and hand back the rows a real client would return. */
  private run(): Row[] {
    const table = (db[this.t] ??= []);
    if (this.op === "update") {
      const hit = this.matched();
      for (const r of hit) Object.assign(r, this.payload);
      return hit;
    }
    if (this.op === "insert") {
      const row = { id: `${this.t}-${++seq}`, ...(this.payload as Row) };
      table.push(row);
      return [row];
    }
    if (this.op === "delete") {
      const hit = this.matched();
      db[this.t] = table.filter((r) => !hit.includes(r));
      return hit;
    }
    return this.matched();
  }
  maybeSingle() {
    const rows = () => this.run();
    return { then<A>(ok: (x: { data: Row | null; error: null }) => A) { return Promise.resolve({ data: rows()[0] ?? null, error: null }).then(ok); } };
  }
  single() {
    const rows = () => this.run();
    return {
      then<A>(ok: (x: { data: Row | null; error: { message: string } | null }) => A) {
        const r = rows()[0] ?? null;
        return Promise.resolve({ data: r, error: r ? null : { message: "no rows" } }).then(ok);
      },
    };
  }
  then<A>(ok: (x: { data: Row[] | null; count: number | null; error: null }) => A) {
    const rows = this.run();
    return Promise.resolve({ data: rows, count: rows.length, error: null }).then(ok);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t), rpc: async () => ({ error: null }) }),
}));

// The REAL charge gate stays in the test — `NO_PROCESSOR_REASON` and the
// paymentsAreLive() switch are the thing under test. Only the processor behind
// it is stood in for, so a genuine bank refusal can be told apart from a
// non-attempt.
vi.mock("@/lib/payments-server", () => ({
  LakeLifePaymentsServer: {
    charge: async () => chargeAnswer,
    refund: async () => ({ ok: true, ref: "rf_1" }),
  },
}));

const notify = vi.fn(async () => ({ reached: true, bySms: false, byEmail: true }));
vi.mock("@/lib/notify", () => ({ notify: (...a: unknown[]) => notify(...(a as [])) }));
vi.mock("@/lib/automation", () => ({
  alertOpsDoubleCharge: vi.fn(async () => ({ notified: 1 })),
  alertOpsCrewUnpaid: vi.fn(async () => ({ notified: 1 })),
}));

const { cancelRequest } = await import("./actions");
const { todayLakeDate } = await import("@/lib/booking");

/** Tomorrow, in lake time — inside the 48-hour window, never outside it. */
function tomorrow(): string {
  const [y, m, d] = todayLakeDate().split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

const FEE = 112.5; // 25% of $450
const CREW_SHARE = 75; // the same 25% of the crew's $300

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  seq = 0;
  notify.mockClear();
  chargeAnswer = { ok: true, ref: "ch_mock_1" };
  delete process.env.LAKELIFE_PAYMENTS_LIVE;
  db.jobs = [{
    id: JOB, status: "scheduled", date: tomorrow(), slot: null,
    customer_price: 450, vendor_cost: 300, vendor_id: VENDOR, property_id: "prop-1",
    service_id: "svc-1", group_id: null, route_id: "route-1", sequence: 3,
    no_show_at: null, stood_down_at: null, recovery_state: null, reschedule_deadline: null,
    services: { name: "Pier removal", is_water_work: false },
    properties: { owner_id: OWNER, address: "12 Shore Rd" },
  }];
  db.invoices = [];
  db.payments = [];
  db.payouts = [];
  db.payment_methods = [{ id: "pm-1", user_id: OWNER, token: "tok_live_1", last4: "4242", brand: "visa", is_default: true }];
  db.vendors = [{ id: VENDOR, user_id: CREW_USER }];
  db.users = [{ id: CREW_USER, phone: null, email: "crew@example.test" }, { id: OWNER, phone: null, email: "owner@example.test" }];
  db.platform_settings = [];
});

afterEach(() => {
  delete process.env.LAKELIFE_PAYMENTS_LIVE;
});

const told = (fragment: string) =>
  notify.mock.calls.filter((c) => String((c as unknown as unknown[])[0]).includes(fragment));

// ------------------------------------------------------- the branch itself

describe("a late cancellation with no processor connected", () => {
  it("reports the cancellation that actually happened, rather than a card failure", async () => {
    const res = await cancelRequest(JOB);
    // ok:false here is the defect: the job is gone, the fee is on a bill, and
    // the only thing that did not happen is a charge nobody attempted.
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    // The fee DID land on a bill, so the button's "$112.50 late fee applied"
    // is the true sentence — the same one a customer with no card on file has
    // always got. Saying "no charge" over a due invoice would be the next lie.
    expect(res.feeCharged).toBe(FEE);
  });

  it("files no phantom decline against a card nobody presented", async () => {
    await cancelRequest(JOB);
    expect(db.payments).toHaveLength(0);
    // Load-bearing: chargeKey counts `failed` rows as prior declines and the
    // nightly caps at five, so a phantom decline burns the retry budget on a
    // processor that does not exist.
    expect(db.invoices[0]).toMatchObject({ amount: FEE, status: "due" });
  });

  it("still tells the crew their stop is gone, and the owner what it costs", async () => {
    await cancelRequest(JOB);
    expect(told("crew")).toHaveLength(1);
    expect(told("owner")).toHaveLength(1);
    const owner = told("owner")[0] as unknown as [string, unknown, { sms: string }];
    // Already correct copy for this case, and the early return is what stopped
    // it being sent: no card moved, so the fee is named as a bill, not a charge.
    expect(owner[2].sms).toMatch(/will appear on your next bill/);
    expect(owner[2].sms).not.toMatch(/was charged to your card/);
  });

  it("does not pay the crew out of a fee nobody has collected", async () => {
    await cancelRequest(JOB);
    expect(db.payouts).toHaveLength(0);
    const crew = told("crew")[0] as unknown as [string, unknown, { sms: string }];
    expect(crew[2].sms).toMatch(/releases once the fee settles/);
  });
});

// ------------------------------------------- what must NOT have changed

describe("a real bank decline is still a decline", () => {
  beforeEach(() => {
    process.env.LAKELIFE_PAYMENTS_LIVE = "true";
    chargeAnswer = { ok: false, error: "Your card was declined." };
  });

  it("files the failed row, leaves the invoice due, and tells both sides", async () => {
    const res = await cancelRequest(JOB);
    expect(res.ok).toBe(true);
    expect(db.payments).toHaveLength(1);
    expect(db.payments[0]).toMatchObject({ status: "failed" });
    expect(db.invoices[0]).toMatchObject({ status: "due" });
    expect(told("crew")).toHaveLength(1);
    expect(told("owner")).toHaveLength(1);
  });
});

describe("a charge that works still settles the fee", () => {
  beforeEach(() => {
    process.env.LAKELIFE_PAYMENTS_LIVE = "true";
    chargeAnswer = { ok: true, ref: "ch_mock_ok" };
  });

  it("captures, marks the invoice paid, and releases the crew's share", async () => {
    const res = await cancelRequest(JOB);
    expect(res).toEqual({ ok: true, feeCharged: FEE });
    expect(db.payments[0]).toMatchObject({ status: "captured", processor_ref: "ch_mock_ok" });
    expect(db.invoices[0]).toMatchObject({ status: "paid" });
    expect(db.payouts[0]).toMatchObject({ vendor_id: VENDOR, amount: CREW_SHARE, status: "released" });
    const owner = told("owner")[0] as unknown as [string, unknown, { sms: string }];
    expect(owner[2].sms).toMatch(/was charged to your card on file/);
  });
});

// --------------------------------------------------------- the shape of it

describe("the source says a non-attempt skips the row, not the rest", () => {
  const src = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("strips its own comments, so none of this passes on a paragraph", () => {
    // Proof the stripper works on THIS file: a heading that exists only in a
    // comment must survive the raw read and vanish from the stripped code.
    expect(src).toMatch(/AND IT IS NOT A FAILED CANCELLATION EITHER/);
    expect(code).not.toMatch(/AND IT IS NOT A FAILED CANCELLATION EITHER/);
  });

  it("leaves no live sentence sending a customer to an office with no button", () => {
    // /ops has exactly one charge door and it is the no-show visit fee.
    expect(code).not.toMatch(/office can take this one/i);
  });

  it("keeps one inline no-processor guard per failed-row writer", () => {
    // charge-gate.test.ts counts this exact expression against each
    // `status: charge.ok ? …` writer and will not match an import line, so the
    // guard may never be factored out into a helper.
    const writes = (code.match(/status: charge\.ok \? "captured" : "failed"/g) ?? []).length;
    const guards = (code.match(/charge\.reason === NO_PROCESSOR_REASON/g) ?? []).length;
    expect(writes).toBe(2);
    expect(guards).toBe(writes);
  });

  it("gates the insert on the cancellation door instead of returning", () => {
    expect(code).toMatch(/const nobodyWasAsked = !charge\.ok && charge\.reason === NO_PROCESSOR_REASON;/);
    const at = code.indexOf("const nobodyWasAsked");
    const after = code.slice(at, at + 400);
    expect(after).toMatch(/if \(!nobodyWasAsked\) \{/);
    // The tip door's early return is CORRECT where it stands — it releases the
    // claim and nothing else is committed — so this must stay a cancellation-
    // door change only.
    expect(after).not.toMatch(/return \{ ok: false/);
  });
});
