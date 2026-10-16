import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHAT ACTUALLY REACHES THE PROCESSOR WHEN THE SWITCH FLIPS.
 *
 * The scans in card-fee.test.ts prove `payRent` calls the gate. This proves
 * the number it hands the processor, because a resolver that is called and
 * then ignored is the same defect as one that was never called.
 *
 * The Haven's real figures: $542.53 due, `card_fee_pct = 3.00`,
 * `accepts_online_rent = true`.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {
  park_charges: [], park_renters: [], parks: [], park_payment_claims: [], payment_methods: [],
  processor_accounts: [],
};
const inserted: Row[] = [];
/** Every ChargeInput the action handed the gate. */
const charges: Array<{ token: string; amountCents: number; idempotencyKey?: string }> = [];

class Q implements PromiseLike<{ data: Row[] | null; count: number | null; error: null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private head = false;
  private cap: number | null = null;
  private sort: { col: string; asc: boolean } | null = null;
  constructor(private t: string) {}
  select(_c?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.head = true;
    return this;
  }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.sort = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.cap = n; return this; }
  private rows(): Row[] {
    let out = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.sort) {
      const { col, asc } = this.sort;
      out = [...out].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] as number) < (b[col] as number) ? -1 : 1) * (asc ? 1 : -1));
    }
    if (this.cap != null) out = out.slice(0, this.cap);
    return out;
  }
  maybeSingle() {
    const rows = this.rows();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }
  async insert(row: Row) { inserted.push({ ...row, __table: this.t }); return { error: null }; }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; count: number | null; error: null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const rows = this.rows();
    return Promise.resolve({
      data: this.head ? null : rows,
      count: rows.length,
      error: null,
    }).then(ok, bad);
  }
}

const USER = "user-resident";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/email", () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/charge-gate", () => ({
  paymentsAreLive: () => true,
  takePayment: async (input: { token: string; amountCents: number; idempotencyKey?: string }) => {
    charges.push(input);
    return { ok: true, ref: "ch_mock_test", amountCents: input.amountCents };
  },
}));

const { payRent } = await import("./pay-actions");

const CHARGE = "charge-1";
function seed(funding: unknown, feePct = 3) {
  db.park_charges = [{
    id: CHARGE, park_id: "park-1", renter_id: "renter-1",
    amount: 542.53, paid_total: 0, status: "open", period_month: "2027-01-01",
  }];
  db.park_renters = [{ id: "renter-1", user_id: USER, display_name: "A resident" }];
  db.parks = [{ id: "park-1", name: "The Haven", accepts_online_rent: true, card_fee_pct: feePct }];
  db.park_payment_claims = [];
  db.payment_methods = [{ user_id: USER, token: "tok_mock_4242_xaaaaa", last4: "4242", is_default: true, funding }];
  // THE PARK OWNER IS SET UP TO RECEIVE THE MONEY. Under Architecture A rent
  // settles to the owner's own merchant, so 0196 made this a precondition of
  // charging at all — without it `payRent` refuses, which is the point. These
  // tests are about what reaches the processor, so the fixture has to be a
  // park that can actually be paid.
  db.processor_accounts = [{
    park_id: "park-1", provider: "finix", provider_merchant_id: "MU_test",
    status: "active", can_accept_ach: true, can_accept_card: true,
    settlement_last4: "4471",
  }];
  inserted.length = 0;
  charges.length = 0;
}

beforeEach(() => seed("credit"));

describe("payRent surcharges only what it is allowed to", () => {
  it("takes rent plus 3% from a CREDIT card", async () => {
    seed("credit");
    const res = await payRent(CHARGE, "key-1");
    expect(res.ok).toBe(true);
    expect(charges[0].amountCents).toBe(55881); // 54253 + 1628
    expect(inserted[0].fee_amount).toBe(16.28);
    expect(res.signal).toMatch(/3% card fee/);
  });

  it("takes the rent and NOTHING MORE from a DEBIT card", async () => {
    seed("debit");
    const res = await payRent(CHARGE, "key-2");
    expect(res.ok).toBe(true);
    expect(charges[0].amountCents).toBe(54253);
    expect(inserted[0].fee_amount).toBeNull();
  });

  it("takes the rent and nothing more from a PREPAID card", async () => {
    seed("prepaid");
    await payRent(CHARGE, "key-3");
    expect(charges[0].amountCents).toBe(54253);
  });

  it("takes the rent and nothing more when the funding type is UNKNOWN", async () => {
    // Which is every card on file today: nothing writes this column until the
    // real tokenize adapter does. Failing safe is the whole point.
    seed("unknown");
    await payRent(CHARGE, "key-4");
    expect(charges[0].amountCents).toBe(54253);
  });

  it("takes the rent and nothing more when the column is NULL", async () => {
    seed(null);
    await payRent(CHARGE, "key-5");
    expect(charges[0].amountCents).toBe(54253);
  });

  it("still sends whole cents, and the idempotency key, to the processor", async () => {
    seed("credit");
    await payRent(CHARGE, "key-6");
    expect(Number.isInteger(charges[0].amountCents)).toBe(true);
    expect(charges[0].idempotencyKey).toBe("key-6");
  });
});

/**
 * THE THIRD CONDITION — who the money settles to.
 *
 * `accepts_online_rent` is the park's wish and `paymentsAreLive()` says
 * LakeLife has a processor. Neither answers whether THIS park's owner can
 * receive the money into their own account, and before 0196 nothing recorded
 * it. With no merchant on file the only one that exists is LakeLife's, so a
 * charge here would settle somebody else's rent into our balance — the pooled
 * model we rejected, arriving by omission.
 */
describe("a park whose owner cannot receive the money is not charged", () => {
  it("refuses when nobody has been set up to receive it", async () => {
    seed("credit");
    db.processor_accounts = [];
    const res = await payRent(CHARGE, "key-x1");
    expect(res.ok).toBe(false);
    expect(charges, "a card was charged with nowhere for the money to settle").toHaveLength(0);
  });

  it("refuses while the owner's setup is still with the processor", async () => {
    seed("credit");
    db.processor_accounts = [{
      park_id: "park-1", provider: "finix", provider_merchant_id: "MU_test",
      status: "submitted", can_accept_ach: false, can_accept_card: false,
      settlement_last4: null,
    }];
    const res = await payRent(CHARGE, "key-x2");
    expect(res.ok).toBe(false);
    expect(charges).toHaveLength(0);
  });

  it("refuses when the account was closed", async () => {
    seed("credit");
    db.processor_accounts = [{
      park_id: "park-1", provider: "finix", provider_merchant_id: "MU_test",
      status: "disabled", can_accept_ach: true, can_accept_card: true,
      settlement_last4: "4471",
    }];
    const res = await payRent(CHARGE, "key-x3");
    expect(res.ok).toBe(false);
    expect(charges).toHaveLength(0);
  });

  it("refuses when the merchant is live but approved for nothing", async () => {
    // A merchant approved only to be PAID can still not be paid BY a resident.
    seed("credit");
    db.processor_accounts = [{
      park_id: "park-1", provider: "finix", provider_merchant_id: "MU_test",
      status: "active", can_accept_ach: false, can_accept_card: false,
      settlement_last4: "4471",
    }];
    const res = await payRent(CHARGE, "key-x4");
    expect(res.ok).toBe(false);
    expect(charges).toHaveLength(0);
  });

  it("NEVER tells the resident whose paperwork is unfinished", async () => {
    seed("credit");
    db.processor_accounts = [];
    const res = await payRent(CHARGE, "key-x5");
    expect(res.error ?? "").not.toMatch(/merchant|processor|onboard|owner|approval/i);
    // She gets the one thing she can act on.
    expect(res.error ?? "").toMatch(/pay the office/i);
  });
});
