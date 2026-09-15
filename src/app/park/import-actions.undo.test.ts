import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE ROLL-UNDO GUARD FOLLOWS `remaining`, NOT `charge_id` (0167).
 *
 * Applying money on account never moves the payment row — `charge_id` stays
 * null forever and the allocation is a separate fact. The guard counted
 * charge-less payments and said "Apply or give that money back first, then
 * undo": for a cheque the run had already spent that instruction could not
 * be followed (applying it changes nothing the count can see), and the only
 * exit was a reversal recording the money as never having arrived.
 *
 * Two facts, two sentences now. Money STILL HELD (the view's remaining > 0,
 * or a deposit not yet returned) can be put against a bill or given back,
 * and that clears it. Money already applied, given back or taken back is a
 * record — and 0102's anchor means the household file cannot be deleted
 * while any charge-less payment row hangs off it — so the guard says so and
 * points at the roll, the same door the bills guard points at. The real
 * undoImport, against a fake of the tables it touches.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const deleted: Array<{ table: string; ids: unknown[] }> = [];
const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
function onAccountView(): Row[] {
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.charge_id == null && p.reversed_at == null && p.returned_at == null)
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && a.removed_at == null).reduce((t, a) => t + cents(a.amount), 0);
      return { payment_id: p.id, renter_id: p.renter_id, amount: p.amount, remaining: Math.max(0, cents(p.amount) - allocated) / 100 };
    });
}
class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private head = false;
  private patch: Row | null = null;
  private del = false;
  constructor(private t: string) {}
  select(_c?: string, o?: { count?: string; head?: boolean }) { this.head = !!o?.head; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  update(patch: Row) { this.patch = patch; return this; }
  delete() { this.del = true; return this; }
  private source(): Row[] { return this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []); }
  private resolve() {
    const hit = this.source().filter((r) => this.fs.every((f) => f(r)));
    if (this.del) {
      deleted.push({ table: this.t, ids: hit.map((r) => r.id) });
      db[this.t] = (db[this.t] ?? []).filter((r) => !hit.includes(r));
      return Promise.resolve({ data: null, error: null, count: null });
    }
    if (this.patch) { for (const r of hit) Object.assign(r, this.patch); }
    return Promise.resolve({ data: this.head ? null : hit, error: null, count: hit.length });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown; count: number | null }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => new Q(t) }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
const { undoImport } = await import("./import-actions");

const PARK = "park-haven";
beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  deleted.length = 0;
  db.park_import_batches = [{ id: "b1", park_id: PARK, committed_at: "2026-09-01T00:00:00Z", undone_at: null }];
  db.park_import_rows = [{ batch_id: "b1", created_reservation_id: "stay-9", created_renter_id: "renter-9", created_lot_id: null }];
  db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9" }];
  db.park_renters = [{ id: "renter-9", park_id: PARK }];
  db.park_charges = [];
  db.park_payments = [];
  db.park_payment_allocations = [];
});

describe("undoImport and the money a household on the import has handed over", () => {
  it("nothing recorded: the undo goes through", async () => {
    const res = await undoImport("b1");
    expect(res.ok).toBe(true);
    expect(deleted.map((d) => d.table)).toEqual(["lot_reservations", "park_renters"]);
  });

  it("a cheque still on account (remaining > 0) blocks it, with an instruction the office can follow", async () => {
    db.park_payments = [{ id: "q", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, reversed_at: null, returned_at: null, returned_on: null }];
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "You're holding money from a household on this import — 1 payment is still on account or held as a deposit. Put it against a bill or give it back first, then undo.",
    );
    expect(deleted).toEqual([]);
  });

  it("a deposit still held blocks it the same way; one already returned does not count as held", async () => {
    db.park_payments = [
      { id: "d1", renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, reversed_at: null, returned_at: null, returned_on: null },
    ];
    expect((await undoImport("b1")).error).toMatch(/1 payment is still on account or held as a deposit/);
    db.park_payments[0].returned_on = "2026-09-02";
    const res = await undoImport("b1");
    expect(res.error).not.toMatch(/still on account/);
    expect(res.error).toMatch(/can't be removed/);
  });

  it("a cheque the run has spent in full (remaining 0) is NOT 'apply it first' — it is a record, and the file cannot be removed", async () => {
    db.park_payments = [{ id: "q", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, reversed_at: null, returned_at: null, returned_on: null }];
    db.park_charges = [{ id: "jan", park_lot_id: "lot-9", renter_id: "renter-9" }];
    db.park_payment_allocations = [{ id: "al-1", payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null }];
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Money has been recorded for a household on this import — 1 payment that has since been put against bills, given back, or taken back — " +
      "so that household's file can't be removed. Fix each household from its row on the rent roll instead.",
    );
    expect(res.error).not.toMatch(/Apply or give/);
    expect(res.error).not.toMatch(/Put it against a bill/);
    expect(deleted, "nothing half-undone").toEqual([]);
  });

  it("an allocation taken back off its bill puts the money back on account — and the instruction follows", async () => {
    db.park_payments = [{ id: "q", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, reversed_at: null, returned_at: null, returned_on: null }];
    db.park_payment_allocations = [{ id: "al-1", payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: "2027-01-09T00:00:00Z", removed_reason: "wrong month" }];
    const res = await undoImport("b1");
    expect(res.error).toMatch(/1 payment is still on account or held as a deposit\. Put it against a bill or give it back first, then undo\./);
  });

  it("a reversed or bank-returned payment is a record too — never 'apply it', and the undo does not run into the anchor constraint half-way", async () => {
    db.park_payments = [
      { id: "q", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, reversed_at: "2027-01-09T00:00:00Z", returned_at: null, returned_on: null },
      { id: "r", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "ach", reversed_at: null, returned_at: "2027-01-10T00:00:00Z", returned_on: null },
    ];
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/2 payments that have since been put against bills, given back, or taken back/);
    expect(deleted).toEqual([]);
  });

  it("the guard reads the view for what is still held, and never instructs 'apply' about money that is applied", () => {
    const src = readFileSync(fileURLToPath(new URL("./import-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const at = src.indexOf("export async function undoImport");
    const fn = src.slice(at, src.indexOf("\nexport ", at + 1));
    expect(fn.length).toBeGreaterThan(1000);
    expect(fn).toMatch(/\.from\("park_on_account_payments"\)/);
    expect(fn).toMatch(/Number\(r\.remaining \?\? 0\) > 0/);
    expect(fn).not.toMatch(/Apply or give that money back/);
  });
});
