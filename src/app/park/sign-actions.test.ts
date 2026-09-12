import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHAT `recordSigning` ACTUALLY WRITES, in order, and what it says when a
 * write fails. The planner is tested in sign-helpers.test.ts; this proves
 * the caller hands the plan to the table as three guarded writes and puts
 * the holdover back when the successor cannot land.
 *
 * An in-memory table with the real filter chain (`eq`, `in`, `gt`, `select`)
 * so the guards are exercised, not mocked away.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { lot_reservations: [], park_renters: [], parks: [], park_fees: [], park_members: [] };
/** Every write, in the order it happened. */
const writes: Array<{ table: string; op: "update" | "insert"; patch: Row; matched: string[] }> = [];
/** Make the next insert / update on a table fail. */
const failNext: { insert?: string; update?: string } = {};

class Q implements PromiseLike<{ data: Row[] | null; error: { code?: string; message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  private op: "select" | "update" | "insert" = "select";
  private ins: Row | null = null;
  private embed: string | null = null;
  constructor(private t: string) {}
  select(cols?: string) {
    if (cols && cols.includes("park_lots(")) this.embed = "park_lots";
    return this;
  }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  gt(c: string, v: number) { this.fs.push((r) => (r[c] as number) > v); return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  insert(row: Row) { this.op = "insert"; this.ins = row; return this; }
  private rows(): Row[] {
    return (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))).map((r) => {
      if (this.embed === "park_lots") {
        return { ...r, park_lots: { park_id: "park-1", rental_mode: "long_term" } };
      }
      return r;
    });
  }
  private run(): { data: Row[] | null; error: { code?: string; message: string } | null } {
    if (this.op === "insert") {
      if (failNext.insert) {
        const message = failNext.insert; delete failNext.insert;
        return { data: null, error: { code: message === "overlap" ? "23P01" : "XX", message } };
      }
      db[this.t].push({ id: `new-${db[this.t].length + 1}`, ...this.ins! });
      writes.push({ table: this.t, op: "insert", patch: this.ins!, matched: [] });
      return { data: [], error: null };
    }
    if (this.op === "update") {
      if (failNext.update) {
        const message = failNext.update; delete failNext.update;
        return { data: null, error: { message } };
      }
      const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
      for (const r of hit) Object.assign(r, this.patch);
      writes.push({ table: this.t, op: "update", patch: this.patch!, matched: hit.map((r) => r.id as string) });
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    return { data: this.rows(), error: null };
  }
  maybeSingle() {
    const r = this.run();
    return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error });
  }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { code?: string; message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

const USER = "user-owner";
/** Every route the action asked Next to re-render, in order. */
const revalidated: string[] = [];
/** The lakes' clock, settable per test — hoisted so the mock factory can see it. */
const clock = vi.hoisted(() => ({ today: "2027-01-01" }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => { revalidated.push(p); } }));
vi.mock("@/lib/booking", () => ({ todayLakeDate: () => clock.today }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { recordSigning } = await import("./sign-actions");

function seed(during = "[2027-01-01,2028-01-01)") {
  db.park_members = [{ park_id: "park-1", user_id: USER, role: "owner" }];
  db.parks = [{ id: "park-1", cutover_date: "2027-01-01", default_agreement_months: 1, max_agreement_months: 3 }];
  db.park_fees = [{ park_id: "park-1", active: true, amount: 142.53, cadence: "monthly", applies_to: "long_term" }];
  db.park_renters = [{ id: "file-14", park_id: "park-1", display_name: "Doris", email: null, phone_on_file_with_park: null }];
  db.lot_reservations = [{
    id: "res-14", park_lot_id: "lot-14", renter_id: "file-14", renter_unit_id: null,
    during, status: "active", origin: "grandfathered", term: "monthly", quoted_amount: 275,
    agreement_chain_id: "chain-14", agreement_seq: 1, due_day: null, tenancy_began_on: "2015-04-02",
    amount_source: "prior_roll", amount_source_at: null,
  }];
  writes.length = 0;
  revalidated.length = 0;
  delete failNext.insert; delete failNext.update;
  clock.today = "2027-01-01";
}

const INPUT = { signedOn: "2027-01-01", rent: "400", email: "doris@example.com", mobile: "(260) 555-0114" };

beforeEach(() => seed());

describe("recordSigning writes the plan, in order", () => {
  it("renter file, then the holdover, then the successor — and January bills $542.53", async () => {
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);
    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual([
      "park_renters:update", "lot_reservations:update", "lot_reservations:insert",
    ]);
    expect(writes[0].patch).toEqual({ email: "doris@example.com", phone_on_file_with_park: "+12605550114" });
    // An imported row signed on its first day never had a day: cancelled.
    expect(writes[1]).toMatchObject({ patch: { status: "cancelled" }, matched: ["res-14"] });
    expect(writes[2].patch).toMatchObject({
      renter_id: "file-14", during: "[2027-01-01,2027-02-01)", origin: "office",
      agreement_chain_id: "chain-14", agreement_seq: 2, status: "active", quoted_amount: 400,
    });
    expect(db.park_renters).toHaveLength(1);       // no second file
    expect(res.signal).toBe("On the new lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees).");
  });

  it("a holdover already running is trimmed, not ended — no moved_out_on", async () => {
    seed("[2026-12-20,2027-12-20)");
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2027-01-01" });
    expect(res.ok, res.error).toBe(true);
    expect(writes[1].patch).toEqual({ during: "[2026-12-20,2027-01-01)" });
    expect(writes[1].patch).not.toHaveProperty("status");
    expect(writes[1].patch).not.toHaveProperty("moved_out_on");
    expect(db.lot_reservations[0].status).toBe("active");
  });

  it("re-renders the screens that read the result — including the fees screen at its REAL route", async () => {
    // The 'this won't be charged to the N households you inherited' sentence
    // is rendered at /park/costs. This revalidated '/park/fees', a route that
    // does not exist, so the count stayed cached with the old number.
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);
    expect(revalidated).toEqual(["/park", "/park/today", "/park/rent", "/park/costs"]);
    expect(revalidated).not.toContain("/park/fees");
  });

  it("writes the successor's rent as the owner's, never the seller's roll, and paid monthly", async () => {
    // The holdover was imported at $275 'prior_roll' and filed yearly; the
    // lease is for $275 a month.
    db.lot_reservations[0].term = "annual";
    const res = await recordSigning("park-1", "res-14", { ...INPUT, rent: "275" });
    expect(res.ok, res.error).toBe(true);
    expect(writes[2].patch).toMatchObject({ quoted_amount: 275, amount_source: "owner_knowledge", term: "monthly" });
    expect(writes[2].patch.amount_source_at).toBeTruthy();
  });

  it("refuses before touching anything when the plan refuses", async () => {
    const res = await recordSigning("park-1", "res-14", { ...INPUT, email: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("No email yet.");
    expect(writes).toEqual([]);
  });

  it("a lease whose agreement would already be over lands NO write — the holdover stands", async () => {
    // The seeded 1 January, recorded on 15 February under the one-month
    // term. Before this the renter patch, the cancel and the insert all
    // landed: the successor was [1 Jan, 1 Feb) — over — and the holdover was
    // cancelled, so nothing held the lot and every later run billed nothing.
    clock.today = "2027-02-15";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "An agreement from January 1, 2027 under your one-month term would already be over by now — check the day the lease runs from.",
    );
    expect(writes).toEqual([]);
    expect(db.lot_reservations).toHaveLength(1);
    expect(db.lot_reservations[0]).toMatchObject({ status: "active", during: "[2027-01-01,2028-01-01)" });
    expect(db.park_renters[0]).toMatchObject({ email: null, phone_on_file_with_park: null });
    // Dated for the current month, the same day records.
    const feb = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2027-02-01" });
    expect(feb.ok, feb.error).toBe(true);
    expect(writes[2].patch).toMatchObject({ during: "[2027-02-01,2027-03-01)", status: "active" });
  });

  it("refuses somebody else's park before reading anything", async () => {
    db.park_members = [];
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe("when a write fails, the sentence is true", () => {
  it("a failed renter patch changes nothing else", async () => {
    failNext.update = "boom";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing was recorded/);
    expect(db.lot_reservations[0]).toMatchObject({ status: "active", during: "[2027-01-01,2028-01-01)" });
    expect(writes).toEqual([]);
  });

  it("a failed successor insert PUTS THE HOLDOVER BACK and says so", async () => {
    failNext.insert = "overlap";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/old arrangement was put back as it was/);
    expect(res.error).toMatch(/already holds that lot/);
    // The cancel, then the restore.
    expect(writes.map((w) => `${w.table}:${w.op}:${JSON.stringify(w.patch)}`)).toEqual([
      'park_renters:update:{"email":"doris@example.com","phone_on_file_with_park":"+12605550114"}',
      'lot_reservations:update:{"status":"cancelled"}',
      'lot_reservations:update:{"status":"active"}',
    ]);
    expect(db.lot_reservations).toHaveLength(1);
    expect(db.lot_reservations[0].status).toBe("active");
  });

  it("restores a TRIMMED holdover's whole range", async () => {
    seed("[2026-12-20,2027-12-20)");
    failNext.insert = "boom";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(db.lot_reservations[0].during).toBe("[2026-12-20,2027-12-20)");
    expect(res.error).toMatch(/nothing bills differently/);
  });

  it("a double-tap: the second recorder finds the holdover already changed", async () => {
    await recordSigning("park-1", "res-14", INPUT);
    writes.length = 0;
    const again = await recordSigning("park-1", "res-14", INPUT);
    expect(again.ok).toBe(false);
    // The plan refuses first: the row is cancelled now, so nothing is written.
    expect(again.error).toBe("That tenancy is already closed.");
    expect(writes).toEqual([]);
  });
});
