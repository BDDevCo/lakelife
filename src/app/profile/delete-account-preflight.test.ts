import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DELETING A LOGIN IS NOT ALWAYS DELETING ONE PERSON'S DATA.
 *
 * auth.users cascades. park_members.user_id is ON DELETE CASCADE, so a park
 * owner tapping "Delete my account" used to remove the only row that makes a
 * park reachable and leave the lots, leases and rent standing with nobody
 * able to open them. vendors.user_id is the same shape, and payouts cascaded
 * from vendors.
 *
 * park_renters.user_id is ON DELETE SET NULL and was ALWAYS correct (0055).
 * The last test here exists so nobody "fixes" that by making it a blocker.
 */

type Row = Record<string, unknown>;

/** Rows each table answers with, and whether that read fails. */
let tables: Record<string, { rows: Row[]; error?: { message: string; code?: string } }>;
let fetched: string[];

class Q {
  constructor(private t: string) {}
  select(_c?: string) { return this; }
  eq(_c: string, _v: unknown) { return this; }
  limit(_n: number) { return this; }
  maybeSingle() {
    const t = tables[this.t] ?? { rows: [] };
    return Promise.resolve({ data: t.error ? null : (t.rows[0] ?? null), error: t.error ?? null });
  }
  upsert(_r: Row, _o?: unknown) { return Promise.resolve({ error: null }); }
  then<A>(ok?: ((x: { data: Row[] | null; error: unknown }) => A) | null) {
    const t = tables[this.t] ?? { rows: [] };
    return Promise.resolve({ data: t.error ? null : t.rows, error: t.error ?? null }).then(ok);
  }
}

const USER = "user-1";
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => {} }) }));
vi.mock("./data", () => ({ getActivePropertyId: async () => null }));
vi.mock("@/lib/env", () => ({ supabaseUrl: () => "https://example.supabase.co" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    from: (t: string) => new Q(t),
  }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { deleteAccount, accountDeletionBlocker } = await import("./account-actions");

beforeEach(() => {
  fetched = [];
  tables = {
    users: { rows: [{ name: "A", email: "a@example.com", phone: null }] },
    properties: { rows: [] },
    park_members: { rows: [] },
    vendors: { rows: [] },
    marketing_contacts: { rows: [] },
  };
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(String(url));
    return { ok: true, status: 200, text: async () => "" } as unknown as Response;
  });
});

describe("a login that carries a park is not one person's to erase", () => {
  it("refuses, names the park, and never reaches the admin delete", async () => {
    tables.park_members = { rows: [{ park_id: "p1", parks: { name: "The Haven" } }] };
    const res = await deleteAccount();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("The Haven");
    expect(res.error).toContain("hello@lakelife.ai");
    expect(fetched).toHaveLength(0);
  });

  it("tells the screen the same thing, so the control is not offered dead", async () => {
    tables.park_members = { rows: [{ park_id: "p1", parks: { name: "The Haven" } }] };
    const res = await accountDeletionBlocker();
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("The Haven");
  });
});

describe("a login that is a crew is not one person's to erase either", () => {
  it("refuses and never reaches the admin delete", async () => {
    tables.vendors = { rows: [{ id: "v1", company: "Advantage" }] };
    const res = await deleteAccount();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Advantage");
    expect(fetched).toHaveLength(0);
  });
});

describe("the guard is not simply 'refuse everybody'", () => {
  it("a plain household login still deletes", async () => {
    const res = await deleteAccount();
    expect(res.ok).toBe(true);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain(`/auth/v1/admin/users/${USER}`);
  });

  it("a resident's park_renters file does NOT block — 0055 already unclaims it", async () => {
    // park_renters.user_id is ON DELETE SET NULL. Making this a blocker would
    // trap every resident in an account they cannot close.
    tables.park_renters = { rows: [{ id: "r1" }] };
    const res = await deleteAccount();
    expect(res.ok).toBe(true);
    expect(fetched).toHaveLength(1);
  });
});

describe("a failed read is not an empty one", () => {
  it("a park_members read that errors REFUSES, and deletes nothing", async () => {
    tables.park_members = { rows: [], error: { message: "connection reset", code: "XX000" } };
    const res = await deleteAccount();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing has been changed/i);
    expect(fetched).toHaveLength(0);
  });

  it("a vendors read that errors REFUSES too", async () => {
    tables.vendors = { rows: [], error: { message: "connection reset", code: "XX000" } };
    const res = await deleteAccount();
    expect(res.ok).toBe(false);
    expect(fetched).toHaveLength(0);
  });
});
