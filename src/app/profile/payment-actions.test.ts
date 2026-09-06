import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * WHAT MAY BE WRITTEN INTO payment_methods.token.
 *
 * CLAUDE.md rule 4: card data never touches our database. The shape guard
 * lived ONLY in this server action, while production granted `authenticated`
 * INSERT/UPDATE/DELETE under `pm_owner` with no CHECK and no trigger — so a
 * browser could PUT its own row straight past it. 0156 revokes those grants
 * and adds the CHECK; this file holds the action's half of the same rule.
 *
 * And the guard itself was wrong in the other direction: it required the
 * MOCK's `tok_` prefix, so a Stripe `pm_…` token could never be saved and no
 * card could be added at all the day the SDK is swapped in.
 */

type Row = Record<string, unknown>;
const inserted: Row[] = [];
const deleted: Array<Record<string, unknown>> = [];
/** Which client each write went through. The revoke makes this load-bearing. */
const writeClients: string[] = [];

class Q {
  private fs: Record<string, unknown> = {};
  constructor(private t: string, private client: string) {}
  select(_c?: string, _o?: unknown) { return this; }
  eq(c: string, v: unknown) { this.fs[c] = v; return this; }
  order() { return this; }
  async insert(row: Row) { writeClients.push(this.client); inserted.push(row); return { error: null }; }
  delete() { writeClients.push(this.client); deleted.push(this.fs); return this; }
  then<A>(ok?: ((x: { data: Row[]; count: number; error: null }) => A) | null) {
    return Promise.resolve({ data: [] as Row[], count: 0, error: null }).then(ok);
  }
}

const USER = "user-1";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    from: (t: string) => new Q(t, "session"),
  }),
  createServiceClient: () => ({ from: (t: string) => new Q(t, "service") }),
}));

const { savePaymentMethod, removePaymentMethod } = await import("./payment-actions");

const CARD = { brand: "Visa", last4: "4242", exp_month: 12, exp_year: 2030 };

beforeEach(() => { inserted.length = 0; deleted.length = 0; writeClients.length = 0; });

describe("a vault token is judged by its shape, not by the mock's prefix", () => {
  it("saves the mock's own tok_ token, so nothing that works today stops working", async () => {
    const res = await savePaymentMethod({ ...CARD, token: "tok_mock_4242_xa1b2cxd3e4fxg5h6i" });
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  it("saves a Stripe-shaped pm_ token — the one the SDK will actually hand us", async () => {
    // The old guard was `!t.startsWith("tok_")`. That is the MOCK's format.
    // Stripe issues `pm_…`, Helcim issues its own; under the old rule the
    // first real card anybody tried to add was refused as invalid.
    const res = await savePaymentMethod({ ...CARD, token: "pm_1PqRsTuVwXyZaBcDeFgHiJkL" });
    expect(res.ok).toBe(true);
    expect(inserted[0].token).toBe("pm_1PqRsTuVwXyZaBcDeFgHiJkL");
  });

  it("REFUSES a bare 16-digit card number", async () => {
    const res = await savePaymentMethod({ ...CARD, token: "4242424242424242" });
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("refuses a PAN hidden inside something token-shaped", async () => {
    expect((await savePaymentMethod({ ...CARD, token: "pm_4242424242424242" })).ok).toBe(false);
    expect((await savePaymentMethod({ ...CARD, token: "tok_x_4242_4111111111111" })).ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("refuses an empty token and one longer than the column's guard", async () => {
    expect((await savePaymentMethod({ ...CARD, token: "" })).ok).toBe(false);
    expect((await savePaymentMethod({ ...CARD, token: "pm_" + "a".repeat(70) })).ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("records a funding type, so the column has a writer from day one", async () => {
    // 'unknown' until the real tokenize adapter reports it. A column read by
    // the surcharge gate and written by nothing is enforced by nothing.
    await savePaymentMethod({ ...CARD, token: "tok_mock_4242_xaaaaa" });
    expect(inserted[0].funding).toBe("unknown");
    inserted.length = 0;
    // Cast because `PaymentToken` (src/lib/payments.ts) is the MOCK's shape and
    // has no funding field yet — that field arrives with the real SDK, which is
    // the whole reason the action reads it defensively rather than typed.
    const withFunding = { ...CARD, token: "pm_realdebitcard", funding: "debit" };
    await savePaymentMethod(withFunding as unknown as Parameters<typeof savePaymentMethod>[0]);
    expect(inserted[0].funding).toBe("debit");
  });
});

describe("the write survives 0156 revoking the client's grants", () => {
  it("inserts through the service client, not the resident's session", async () => {
    await savePaymentMethod({ ...CARD, token: "tok_mock_4242_xaaaaa" });
    expect(writeClients).toEqual(["service"]);
  });

  it("deletes through the service client, still scoped to the owner", async () => {
    await removePaymentMethod("pm-row-1");
    expect(writeClients).toEqual(["service"]);
    expect(deleted[0]).toMatchObject({ id: "pm-row-1", user_id: USER });
  });
});

describe("0156 closes the door the action was guarding alone", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../../supabase/migrations/0156_a_debit_card_is_not_a_credit_card.sql", import.meta.url)),
    "utf8",
  ).toLowerCase();

  it("revokes client writes on payment_methods and keeps the read", () => {
    expect(sql).toMatch(/revoke[\s\S]{0,80}payment_methods from (anon, authenticated|authenticated, anon)/);
    expect(sql).toMatch(/grant select on public\.payment_methods to (anon, authenticated|authenticated, anon)/);
  });

  it("adds the funding column, defaulting to the one value that surcharges nothing", () => {
    expect(sql).toMatch(/add column if not exists funding text not null default 'unknown'/);
    expect(sql).toMatch(/'credit'[\s\S]{0,40}'debit'[\s\S]{0,40}'prepaid'[\s\S]{0,40}'unknown'/);
  });

  it("puts rule 4's intent on the token column, without pinning the mock's prefix", () => {
    expect(sql).toMatch(/check[\s\S]{0,200}\[0-9\]\{13,19\}/);
    expect(sql).not.toMatch(/like 'tok\\?_%'/);
  });
});
