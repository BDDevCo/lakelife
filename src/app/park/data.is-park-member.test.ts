import { describe, it, expect, vi } from "vitest";

/**
 * ONE HELPER, TWO FRONT DOORS. /portal and /welcome both need "does this
 * person own or manage a park" before they decide where he lands, and the
 * answer must FAIL CLOSED: a failed read that reads as "no park" sends a
 * park owner down the homeowner path — and at /portal into a role rewrite.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const failing = new Set<string>();

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in() { return this; }
  order() { return this; }
  limit() { return this; }
  private result() {
    if (failing.has(this.t)) return { data: null, error: { code: "XX000", message: `mock: ${this.t} read failed` } };
    return { data: (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))), error: null };
  }
  maybeSingle() {
    const r = this.result();
    return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error });
  }
  then<A, B>(ok?: ((x: unknown) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.result()).then(ok, bad);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { isParkMember } = await import("./data");

describe("isParkMember", () => {
  it("a membership row → true; none → false", async () => {
    db.park_members = [{ park_id: "p1", user_id: "u1", role: "manager" }];
    expect(await isParkMember("u1")).toBe(true);
    expect(await isParkMember("u2")).toBe(false);
  });
  it("a failed read REJECTS rather than answering 'no park'", async () => {
    failing.add("park_members");
    await expect(isParkMember("u1")).rejects.toThrow(/Couldn't read whether you own or manage a park/);
    failing.clear();
  });
});
