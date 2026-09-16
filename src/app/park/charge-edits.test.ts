import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE VOID AND THE RE-RAISE — the primitives a signing and a move-out call
 * once a month is already billed. The doors are tested where they live
 * (sign-actions.test.ts, lifecycle.test.ts); this pins the rules the
 * primitives hold on their own: which money counts, what is never voided,
 * what the re-raise refuses, and that the run's own invariants (a stamped
 * share, R1 settlement) travel with it.
 *
 * The fake models the triggers that matter — paid_total follows the
 * payments and allocations, the 0167 view says what is on account, and
 * 0169's void guard: a bill with a live line from money on account refuses
 * the void by name, a void bill holds 0, and a payment against a void bill
 * is in the view with the bill's month beside it — and nothing else.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; patch: Row }> = [];
const failNext: { update?: string; insert?: string; read?: string } = {};

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const liveAlloc = (a: Row) => a.removed_at == null;
const stands = (p: Row | undefined) => !!p && p.reversed_at == null && p.returned_at == null;
/** The view's `refunded` (0142 rows against the payment). */
function refundedOf(p: Row): number {
  return (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((s, r) => s + cents(r.amount), 0) / 100;
}
/** park_payment_remaining (0168): amount − live allocations − refunds − handed back. */
function remainingOf(p: Row): number {
  const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && liveAlloc(a)).reduce((s, a) => s + cents(a.amount), 0);
  return Math.max(0, cents(p.amount) - allocated - cents(refundedOf(p)) - cents(p.returned_amount)) / 100;
}
/** The view (0169): rent, standing, and no bill OR a bill since cancelled; renter_id from the bill when the row has none. */
function onAccountView(): Row[] {
  const chargeOf = (p: Row) => (db.park_charges ?? []).find((c) => c.id === p.charge_id) ?? null;
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && stands(p) && (p.charge_id == null || chargeOf(p)?.status === "void"))
    .map((p) => {
      const c = chargeOf(p);
      return {
        payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id ?? c?.renter_id ?? null, amount: p.amount, received_on: p.received_on,
        created_at: null, refunded: refundedOf(p), remaining: remainingOf(p),
        released_from_charge_id: c?.id ?? null, released_from_month: c?.period_month ?? null, released_on: c?.voided_at ?? null,
      };
    });
}
/** recompute_charge_paid, with 0169's park_charge_paid_total: a void bill holds 0. */
function recompute(chargeId: string) {
  const c = (db.park_charges ?? []).find((x) => x.id === chargeId);
  if (!c) return;
  if (c.status === "void") { c.paid_total = 0; return; }
  const direct = (db.park_payments ?? []).filter((p) => p.charge_id === chargeId && stands(p)).reduce((s, p) => s + cents(p.amount), 0);
  const applied = (db.park_payment_allocations ?? []).filter((a) => a.charge_id === chargeId && liveAlloc(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  const paid = (direct + applied) / 100;
  c.paid_total = paid;
  c.status = paid >= Number(c.amount) ? "paid" : "open";
}
/** guard_park_charge_void (0169): refused by name while a live line from a standing payment is on it; paid_total 0 on the void. */
function guardVoid(c: Row, patch: Row): { message: string } | null {
  if (patch.status !== "void" || c.status === "void") return null;
  const held = (db.park_payment_allocations ?? []).filter((a) => a.charge_id === c.id && liveAlloc(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  if (held > 0) return { message: `park_charges: ${(held / 100).toFixed(2)} of money on account is against this bill — take it off the bill first (with a reason), then cancel it` };
  return null;
}

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  private op: "select" | "update" | "insert" = "select";
  private ins: Row[] | null = null;
  private sort: { c: string; asc: boolean } | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  gt(c: string, v: number) { this.fs.push((r) => Number(r[c]) > v); return this; }
  gte(c: string, v: unknown) { this.fs.push((r) => String(r[c]) >= String(v)); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.sort = { c, asc: o?.ascending !== false }; return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  insert(row: Row | Row[]) { this.op = "insert"; this.ins = Array.isArray(row) ? row : [row]; return this; }
  private rows(): Row[] {
    const source = this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []);
    let out = source.filter((r) => this.fs.every((f) => f(r)));
    if (this.sort) {
      const { c, asc } = this.sort;
      out = [...out].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
    }
    return out;
  }
  private run() {
    if (this.op === "insert") {
      if (failNext.insert) { const m = failNext.insert; delete failNext.insert; return { data: null, error: { message: m } }; }
      const rows = this.ins!.map((r) => {
        const row: Row = { id: `${this.t}-${(db[this.t] ??= []).length + 1}`, ...r };
        if (this.t === "park_charges") { if (row.paid_total === undefined) row.paid_total = 0; if (row.status === undefined) row.status = "open"; }
        db[this.t].push(row);
        writes.push({ table: this.t, op: "insert", patch: r });
        if (this.t === "park_payment_allocations") recompute(row.charge_id as string);
        return row;
      });
      return { data: rows, error: null };
    }
    if (this.op === "update") {
      if (failNext.update === this.t) { delete failNext.update; return { data: null, error: { message: "boom" } }; }
      const hit = this.rows();
      if (this.t === "park_charges") {
        for (const r of hit) { const refused = guardVoid(r, this.patch!); if (refused) return { data: null, error: refused }; }
      }
      for (const r of hit) Object.assign(r, this.patch);
      if (this.t === "park_charges") for (const r of hit) if (r.status === "void") r.paid_total = 0;
      writes.push({ table: this.t, op: "update", patch: this.patch! });
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (failNext.read === this.t) { delete failNext.read; return { data: null, error: { message: "boom" } }; }
    return { data: this.rows(), error: null };
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); }
  single() { return this.maybeSingle(); }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> { return Promise.resolve(this.run()).then(ok, bad); }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/rent-changes", () => ({
  servedRentHistory: async () => ({ byRes: new Map(), error: null }),
}));

const { chargeStandings, voidUnpaidChargesFor, reraiseMonth, statementFor, basisOf, feesFor, unbilledCostShares, strandedSharesSentence } = await import("./charge-edits");
const admin = { from: (t: string) => new Q(t) } as unknown as Parameters<typeof chargeStandings>[0];

const PARK = "park-1";
function seed() {
  for (const k of Object.keys(db)) delete db[k];
  writes.length = 0;
  delete failNext.update; delete failNext.insert;
  db.parks = [{ id: PARK, rent_due_day: 1 }];
  db.park_lots = [{ id: "lot-9", park_id: PARK, lot_number: "9", rental_mode: "long_term" }];
  db.park_fees = [{ park_id: PARK, active: true, label: "Grounds", amount: 142.53, cadence: "monthly", applies_to: "long_term" }];
  db.lot_reservations = [{
    id: "jan", park_lot_id: "lot-9", renter_id: "file-9", during: "[2027-01-01,2027-01-28)", quoted_amount: 400,
    status: "ended", moved_out_on: "2027-01-27", due_day: null, origin: "office", term: "monthly",
  }];
  db.park_charges = []; db.park_payments = []; db.park_payment_allocations = []; db.park_refunds = []; db.lot_cost_shares = []; db.park_costs = [];
}
const bill = (over: Row = {}): Row => ({
  id: "chg-jan", park_id: PARK, park_lot_id: "lot-9", reservation_id: "jan", renter_id: "file-9",
  period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "open", lines: [], ...over,
});

beforeEach(seed);

describe("chargeStandings — which money is on a bill", () => {
  it("nothing on it → none; money on account → on_account; a cheque against it → direct", async () => {
    db.park_charges.push(bill(), bill({ id: "chg-feb", period_month: "2027-02" }), bill({ id: "chg-mar", period_month: "2027-03" }));
    db.park_payments.push(
      { id: "pay-q", park_id: PARK, renter_id: "file-9", amount: 1000, kind: "rent", charge_id: null, received_on: "2026-12-28", reversed_at: null, returned_at: null },
      { id: "pay-c", park_id: PARK, renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-mar", received_on: "2027-03-02", reversed_at: null, returned_at: null },
    );
    db.park_payment_allocations.push({ id: "al-feb", park_id: PARK, payment_id: "pay-q", charge_id: "chg-feb", amount: 542.53, removed_at: null });
    recompute("chg-feb"); recompute("chg-mar");
    const r = await chargeStandings(admin, PARK, ["jan"]);
    if ("error" in r) throw new Error(r.what);
    const by = new Map(r.charges.map((c) => [c.id, c]));
    expect(by.get("chg-jan")).toMatchObject({ money: "none", paidTotal: 0, direct: 0, allocations: [] });
    expect(by.get("chg-feb")).toMatchObject({ money: "on_account", paidTotal: 542.53, direct: 0 });
    expect(by.get("chg-feb")!.allocations).toEqual([{ id: "al-feb", paymentId: "pay-q", amount: 542.53 }]);
    expect(by.get("chg-mar")).toMatchObject({ money: "direct", direct: 542.53, paidTotal: 542.53 });
  });

  it("a reversed or bank-returned payment is not money on the bill; a line already taken off is not either", async () => {
    db.park_charges.push(bill(), bill({ id: "chg-feb", period_month: "2027-02" }));
    db.park_payments.push(
      { id: "pay-b", park_id: PARK, renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-jan", received_on: "2027-01-05", reversed_at: "2027-01-09T00:00:00Z", returned_at: null },
      { id: "pay-r", park_id: PARK, renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: "2027-02-09T00:00:00Z" },
      { id: "pay-ok", park_id: PARK, renter_id: "file-9", amount: 100, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: null },
    );
    db.park_payment_allocations.push(
      { id: "al-r", park_id: PARK, payment_id: "pay-r", charge_id: "chg-feb", amount: 542.53, removed_at: null },
      { id: "al-off", park_id: PARK, payment_id: "pay-ok", charge_id: "chg-feb", amount: 100, removed_at: "2027-02-01T00:00:00Z" },
    );
    recompute("chg-jan"); recompute("chg-feb");
    const r = await chargeStandings(admin, PARK, ["jan"]);
    if ("error" in r) throw new Error(r.what);
    expect(r.charges.find((c) => c.id === "chg-jan")).toMatchObject({ money: "none", direct: 0 });
    expect(r.charges.find((c) => c.id === "chg-feb")).toMatchObject({ money: "none", allocations: [] });
  });

  it("paid_total with no row explaining it is treated as money taken — the ledger's figure is the one 0072 enforces", async () => {
    db.park_charges.push(bill({ paid_total: 12 }));
    const r = await chargeStandings(admin, PARK, ["jan"]);
    if ("error" in r) throw new Error(r.what);
    expect(r.charges[0].money).toBe("direct");
  });

  it("reads from a month on, never a void, and only this park's", async () => {
    db.park_charges.push(bill({ id: "dec", period_month: "2026-12" }), bill(), bill({ id: "v", status: "void" }), bill({ id: "other", park_id: "park-2" }));
    const r = await chargeStandings(admin, PARK, ["jan"], "2027-01");
    if ("error" in r) throw new Error(r.what);
    expect(r.charges.map((c) => c.id)).toEqual(["chg-jan"]);
    expect(await chargeStandings(admin, PARK, [])).toEqual({ charges: [] });
  });
});

describe("voidUnpaidChargesFor", () => {
  it("cancels the unpaid ones with the reason, releases their cost shares, and SKIPS a bill with money on it", async () => {
    db.park_charges.push(bill(), bill({ id: "chg-feb", period_month: "2027-02", paid_total: 50 }));
    db.lot_cost_shares.push({ id: "sh-1", reservation_id: "jan", cost_id: "c1", amount: 12, basis: "b", billed_on_charge_id: "chg-jan" });
    const r = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "Moved out January 27, 2027");
    if ("error" in r) throw new Error(r.what);
    expect(r.voided).toEqual([{ id: "chg-jan", reservationId: "jan", month: "2027-01", amount: 542.53, taken: 0, refunded: 0, released: 0, releasedPaymentIds: [] }]);
    expect(r.skipped).toEqual([{ id: "chg-feb", reservationId: "jan", month: "2027-02", amount: 542.53, paidTotal: 50 }]);
    expect(r.failed).toEqual([]);
    expect(r.releaseProblem).toBeNull();
    expect(r.sharesReleased).toBe(1);
    expect(db.park_charges[0]).toMatchObject({ status: "void", void_reason: "Moved out January 27, 2027" });
    expect(db.park_charges[0].voided_at).toBeTruthy();
    expect(db.park_charges[1].status).toBe("open");
    expect(db.lot_cost_shares[0].billed_on_charge_id).toBeNull();
  });

  it("a reason is required — 0070 refuses a void without one", async () => {
    db.park_charges.push(bill());
    const r = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "  ");
    expect("error" in r).toBe(true);
    expect(db.park_charges[0].status).toBe("open");
  });

  it("a refused update lands in `failed`, named — never swallowed", async () => {
    db.park_charges.push(bill());
    failNext.update = "park_charges";
    const r = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why");
    if ("error" in r) throw new Error(r.what);
    expect(r.failed).toEqual([{ id: "chg-jan", reservationId: "jan", month: "2027-01", amount: 542.53, message: "boom" }]);
    expect(r.voided).toEqual([]);
  });

  /**
   * A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT (0169). With
   * `releaseDirect` a bill paid straight against it is cancelled and the
   * money is the household's, on account — the payment row untouched; the
   * figure is the VIEW's remaining, read after the void. Without it (the
   * signing door's contract) the same bill is skipped exactly as before.
   */
  describe("releaseDirect — a bill paid straight against it", () => {
    const cheque = (over: Row = {}): Row => ({
      id: "pay-c", park_id: PARK, renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-jan", method: "check",
      received_on: "2027-01-05", reversed_at: null, returned_at: null, ...over,
    });

    it("voids a bill with a cheque against it and reports what was released; without it the bill is still skipped", async () => {
      db.park_charges.push(bill());
      db.park_payments.push(cheque());
      recompute("chg-jan");
      expect(db.park_charges[0]).toMatchObject({ paid_total: 542.53, status: "paid" });

      const kept = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why");
      if ("error" in kept) throw new Error(kept.what);
      expect(kept.voided).toEqual([]);
      expect(kept.skipped).toEqual([{ id: "chg-jan", reservationId: "jan", month: "2027-01", amount: 542.53, paidTotal: 542.53 }]);
      expect(db.park_charges[0].status).toBe("paid");
      // The default is the same as false: an explicit false skips too.
      const still = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why", { releaseDirect: false });
      expect("error" in still ? null : still.skipped).toHaveLength(1);

      const r = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "Moved out January 27, 2027", { releaseDirect: true });
      if ("error" in r) throw new Error(r.what);
      expect(r.skipped).toEqual([]);
      expect(r.voided).toEqual([{ id: "chg-jan", reservationId: "jan", month: "2027-01", amount: 542.53, taken: 542.53, refunded: 0, released: 542.53, releasedPaymentIds: ["pay-c"] }]);
      expect(r.releaseProblem).toBeNull();
      // The bill is void and holds nothing; the row never moved — same
      // charge_id, standing — and the view lists it with the month it
      // came from.
      expect(db.park_charges[0]).toMatchObject({ status: "void", paid_total: 0, void_reason: "Moved out January 27, 2027" });
      expect(db.park_payments[0]).toMatchObject({ charge_id: "chg-jan", reversed_at: null });
      expect(onAccountView()).toEqual([expect.objectContaining({ payment_id: "pay-c", remaining: 542.53, released_from_charge_id: "chg-jan", released_from_month: "2027-01" })]);
    });

    it("`released` is the view's remaining — net of a refund already given and of what is already applied — never amount minus something here; `taken` and `refunded` ride along so a door can name all three", async () => {
      db.park_charges.push(bill());
      db.park_payments.push(cheque({ method: "card", reference: "ch_1" }));
      db.park_refunds.push({ id: "rf-1", payment_id: "pay-c", park_id: PARK, amount: 100, fee_amount: 0 });
      recompute("chg-jan");
      const r = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why", { releaseDirect: true });
      if ("error" in r) throw new Error(r.what);
      // THREE FIGURES, ALL THE VIEW'S: $542.53 was taken against it, $100
      // had already gone back to the card, $442.53 is on account. A door
      // that had only `released` said "the $442.53 paid on it" — naming
      // the remainder as the amount paid.
      expect(r.voided[0]).toMatchObject({ taken: 542.53, refunded: 100, released: 442.53 });
      // The source: the figures come from park_on_account_payments — the
      // select names all three columns — and the body subtracts nothing
      // from an amount.
      const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const src = strip(readFileSync(fileURLToPath(new URL("./charge-edits.ts", import.meta.url)), "utf8"));
      const body = src.slice(src.indexOf("export async function voidUnpaidChargesFor("), src.indexOf("// ------------------------------------------------ the run's two readers ---"));
      expect(body, "voidUnpaidChargesFor is gone — this scan measures nothing").toMatch(/releaseDirect/);
      expect(body).toMatch(/from\("park_on_account_payments"\)[\s\S]*?\.select\("payment_id, released_from_charge_id, amount, refunded, remaining"\)[\s\S]*?\.in\("released_from_charge_id", releasedIds\)/);
      expect(body).not.toMatch(/park_refunds/);
      expect(body).not.toMatch(/amount\) - /);
    });

    it("a bill with a LIVE line from money on account is skipped either way, by name — the database refuses that void too", async () => {
      db.park_charges.push(bill(), bill({ id: "chg-feb", period_month: "2027-02" }));
      db.park_payments.push({ id: "pay-q", park_id: PARK, renter_id: "file-9", amount: 600, kind: "rent", charge_id: null, received_on: "2026-12-28", reversed_at: null, returned_at: null });
      db.park_payments.push(cheque({ charge_id: "chg-feb" }));
      db.park_payment_allocations.push({ id: "al-jan", park_id: PARK, payment_id: "pay-q", charge_id: "chg-jan", amount: 542.53, removed_at: null });
      recompute("chg-jan"); recompute("chg-feb");
      const r = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why", { releaseDirect: true });
      if ("error" in r) throw new Error(r.what);
      expect(r.skipped).toEqual([{ id: "chg-jan", reservationId: "jan", month: "2027-01", amount: 542.53, paidTotal: 542.53 }]);
      expect(r.voided.map((v) => [v.id, v.released])).toEqual([["chg-feb", 542.53]]);
      expect(db.park_charges[0].status).toBe("paid");
      expect(db.park_charges[1].status).toBe("void");
      // A line from a cheque that has since BOUNCED is record, not money on
      // the bill (the reader shared with chargeStandings): the void goes
      // through, and the bill released nothing because nothing stood on it.
      db.park_payments.find((p) => p.id === "pay-q")!.reversed_at = "2027-01-20T00:00:00Z";
      recompute("chg-jan");
      const bounced = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why", { releaseDirect: true });
      if ("error" in bounced) throw new Error(bounced.what);
      expect(bounced.voided.map((v) => [v.id, v.taken, v.refunded, v.released, v.releasedPaymentIds])).toEqual([["chg-jan", 0, 0, 0, []]]);
    });

    it("the database's own refusal of a void lands in `failed`, named — a line that landed between the read and the write", async () => {
      db.park_charges.push(bill());
      db.park_payments.push({ id: "pay-q", park_id: PARK, renter_id: "file-9", amount: 600, kind: "rent", charge_id: null, received_on: "2026-12-28", reversed_at: null, returned_at: null });
      // The line is not there when the standing is read, and is when the
      // update lands: the fake's guard sees it.
      const orig = (Q.prototype as unknown as { run: () => unknown }).run;
      let armed = false;
      (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
        if (!armed && (this as unknown as { t: string }).t === "park_charges" && (this as unknown as { op: string }).op === "update") {
          armed = true;
          db.park_payment_allocations.push({ id: "al-late", park_id: PARK, payment_id: "pay-q", charge_id: "chg-jan", amount: 100, removed_at: null });
        }
        return orig.call(this);
      };
      const r = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why", { releaseDirect: true });
      (Q.prototype as unknown as { run: () => unknown }).run = orig;
      if ("error" in r) throw new Error(r.what);
      expect(r.voided).toEqual([]);
      expect(r.failed).toEqual([{ id: "chg-jan", reservationId: "jan", month: "2027-01", amount: 542.53, message: "park_charges: 100.00 of money on account is against this bill — take it off the bill first (with a reason), then cancel it" }]);
      expect(db.park_charges[0].status).toBe("open");
    });

    it("a failed read of what the voids released is said as a failed read — the bills ARE cancelled, and `released` must not be believed", async () => {
      db.park_charges.push(bill());
      db.park_payments.push(cheque());
      recompute("chg-jan");
      failNext.read = "park_on_account_payments";
      const r = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why", { releaseDirect: true });
      if ("error" in r) throw new Error(r.what);
      expect(db.park_charges[0].status).toBe("void");
      expect(r.voided).toHaveLength(1);
      expect(r.releaseProblem?.what).toBe("what was paid on the cancelled bills");
      expect(r.voided[0].releasedPaymentIds).toEqual(["pay-c"]);
      // A bill nothing was paid on never reads the view at all.
      seed();
      db.park_charges.push(bill());
      failNext.read = "park_on_account_payments";
      const plain = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why", { releaseDirect: true });
      if ("error" in plain) throw new Error(plain.what);
      expect(plain.releaseProblem).toBeNull();
      expect(failNext.read, "the view was never read for a bill with nothing on it").toBe("park_on_account_payments");
      delete failNext.read;
    });
  });

  it("a null fromMonth means every month on those reservations; a month bounds it", async () => {
    db.park_charges.push(bill({ id: "dec", period_month: "2026-12" }), bill());
    const bounded = await voidUnpaidChargesFor(admin, ["jan"], "2027-01", "why");
    if ("error" in bounded) throw new Error(bounded.what);
    expect(bounded.voided.map((v) => v.id)).toEqual(["chg-jan"]);
    const all = await voidUnpaidChargesFor(admin, ["jan"], null, "why");
    if ("error" in all) throw new Error(all.what);
    expect(all.voided.map((v) => v.id)).toEqual(["dec"]);
  });
});

describe("reraiseMonth — the run's own arithmetic, for one tenancy", () => {
  it("raises the part month exactly as the run would — lines, basis, due day — and settles it from money on account (R1)", async () => {
    db.park_payments.push({ id: "pay-q", park_id: PARK, renter_id: "file-9", amount: 600, kind: "rent", charge_id: null, received_on: "2026-12-28", reversed_at: null, returned_at: null });
    const r = await reraiseMonth(admin, PARK, "jan", "2027-01");
    if ("error" in r) throw new Error(r.what);
    expect(r.raised).toMatchObject({ month: "2027-01", amount: 472.53, dueOn: "2027-01-01", basis: "27 of 31 days" });
    expect(r.fromOnAccount).toBe(472.53);
    expect(r.settleProblem).toBeNull();
    const c = db.park_charges[0];
    expect(c).toMatchObject({
      park_id: PARK, park_lot_id: "lot-9", reservation_id: "jan", renter_id: "file-9",
      period_month: "2027-01", amount: 472.53, paid_total: 472.53, status: "paid",
    });
    expect(c.lines).toEqual([
      { label: "Lot rent", amount: 348.39, basis: "27 of 31 days" },
      { label: "Grounds", amount: 124.14, basis: "27 of 31 days" },
    ]);
    expect(db.park_payment_allocations[0]).toMatchObject({ payment_id: "pay-q", charge_id: c.id, amount: 472.53, applied_via: "office" });
    // WHICH payment settled it, and nothing older: a caller that just
    // released money says "from that money" only from these lines.
    expect(r.settledFrom).toEqual([{ paymentId: "pay-q", amount: 472.53 }]);
    expect(r.toOlderBills).toEqual([]);
  });

  it("R1 is oldest-OPEN-BILL-first: with December still owing, the money goes there first and the outcome names it — and the part month's lines say which payment paid it", async () => {
    // A released $542.53 (a cancelled January, the row still against it)
    // and a $57.47 sibling on account, with $100 of December still owing.
    db.park_charges.push(bill({ id: "chg-dec", period_month: "2026-12", due_on: "2026-12-01", amount: 100, status: "open" }));
    db.park_charges.push(bill({ status: "void", voided_at: "2027-01-27T00:00:00Z", void_reason: "moved out" }));
    db.park_payments.push({ id: "pay-c", park_id: PARK, renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-jan", received_on: "2027-01-05", reversed_at: null, returned_at: null });
    db.park_payments.push({ id: "pay-sib", park_id: PARK, renter_id: "file-9", amount: 57.47, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: null });
    const r = await reraiseMonth(admin, PARK, "jan", "2027-01");
    if ("error" in r) throw new Error(r.what);
    expect(r.raised).toMatchObject({ amount: 472.53 });
    // $100 of the released money went against December; $442.53 of it and
    // the $57.47 sibling paid the part month — TWO sources, so a sentence
    // crediting "that money" with all of it would be false.
    expect(r.toOlderBills).toEqual([{ periodMonth: "2026-12", amount: 100 }]);
    expect(r.fromOnAccount).toBe(472.53);
    expect(r.settledFrom).toEqual([{ paymentId: "pay-c", amount: 442.53 }, { paymentId: "pay-sib", amount: 30 }]);
    expect(db.park_charges.find((c) => c.id === "chg-dec")).toMatchObject({ paid_total: 100, status: "paid" });
    // From splitApplied — never total minus fromOnAccount.
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const src = strip(readFileSync(fileURLToPath(new URL("./charge-edits.ts", import.meta.url)), "utf8"));
    const body = src.slice(src.indexOf("export async function reraiseMonth("), src.indexOf("export function strandedSharesSentence("));
    expect(body, "reraiseMonth is gone — this scan measures nothing").toMatch(/settleOnAccount\(/);
    expect(body).toMatch(/splitApplied\(settled\.applied, new Set\(\[chargeId\]\)/);
    expect(body).toMatch(/settled\.lines[\s\S]*?\.filter\(\(l\) => l\.key === chargeId\)/);
    expect(body).not.toMatch(/total - fromOnAccount|settled\.total -/);
  });

  it("raises nothing while a live bill for the month stands — the caller voids first", async () => {
    db.park_charges.push(bill());
    const r = await reraiseMonth(admin, PARK, "jan", "2027-01");
    if ("error" in r) throw new Error(r.what);
    expect(r.raised).toBeNull();
    expect(r.why).toBe("already");
    expect(db.park_charges).toHaveLength(1);
  });

  it("raises nothing for a month the (trimmed) window does not cover, a cancelled row, or an ended row with no move-out date", async () => {
    const feb = await reraiseMonth(admin, PARK, "jan", "2027-02");
    expect("error" in feb ? null : feb.raised).toBeNull();
    expect("error" in feb ? null : feb.why).toBe("movedOut");
    db.lot_reservations[0].status = "cancelled";
    const cancelled = await reraiseMonth(admin, PARK, "jan", "2027-01");
    expect("error" in cancelled ? null : cancelled.raised).toBeNull();
    db.lot_reservations[0].status = "ended";
    db.lot_reservations[0].moved_out_on = null;
    const undated = await reraiseMonth(admin, PARK, "jan", "2027-01");
    expect("error" in undated ? null : undated.raised).toBeNull();
    expect(db.park_charges).toEqual([]);
  });

  it("a grandfathered holdover is re-raised with no fee, and a rent nobody set raises nothing", async () => {
    db.lot_reservations[0].origin = "grandfathered";
    const r = await reraiseMonth(admin, PARK, "jan", "2027-01");
    if ("error" in r) throw new Error(r.what);
    expect(r.raised!.amount).toBe(348.39);
    expect(db.park_charges[0].lines).toEqual([{ label: "Lot rent", amount: 348.39, basis: "27 of 31 days" }]);
    seed();
    db.lot_reservations[0].quoted_amount = null;
    const none = await reraiseMonth(admin, PARK, "jan", "2027-01");
    expect("error" in none ? null : none.why).toBe("noRent");
    expect(db.park_charges).toEqual([]);
  });

  it("stamps the cost shares it billed, and takes the bill back when it cannot — the run's invariant", async () => {
    db.lot_cost_shares.push({ id: "sh-1", reservation_id: "jan", cost_id: "c1", amount: 18.5, basis: "b", billed_on_charge_id: null });
    db.park_costs.push({ id: "c1", park_id: PARK, category: "water", period_start: "2026-12-01", period_end: "2026-12-31" });
    const r = await reraiseMonth(admin, PARK, "jan", "2027-01");
    if ("error" in r) throw new Error(r.what);
    expect(r.raised!.amount).toBe(491.03);
    expect(db.park_charges[0].lines).toContainEqual({ label: "Water — your share", amount: 18.5, basis: "for 2026-12-01 to 2026-12-31" });
    expect(db.lot_cost_shares[0].billed_on_charge_id).toBe(db.park_charges[0].id);
    // Says how many it took up, so a caller that voided can tell what a
    // void released and nothing re-billed.
    expect(r.sharesStamped).toBe(1);

    seed();
    db.lot_cost_shares.push({ id: "sh-1", reservation_id: "jan", cost_id: "c1", amount: 18.5, basis: "b", billed_on_charge_id: null });
    db.park_costs.push({ id: "c1", park_id: PARK, category: "water", period_start: "2026-12-01", period_end: "2026-12-31" });
    failNext.update = "lot_cost_shares";
    const back = await reraiseMonth(admin, PARK, "jan", "2027-01");
    expect("error" in back).toBe(true);
    expect(db.park_charges[0]).toMatchObject({ status: "void" });
    expect(String(db.park_charges[0].void_reason)).toMatch(/Taken back automatically/);
  });

  it("a failed insert is a named read problem, not a silent success", async () => {
    failNext.insert = "boom";
    const r = await reraiseMonth(admin, PARK, "jan", "2027-01");
    expect("error" in r && r.what).toBe("the bill for that month");
  });
});

describe("statementFor and basisOf", () => {
  it("builds the month the way the run builds it, for one tenancy, and the basis is the lines' own", async () => {
    const r = await statementFor(admin, PARK, "jan", "2027-01");
    if ("error" in r) throw new Error(r.what);
    expect(r.candidate).toMatchObject({ reservationId: "jan", lotNumber: "9", amount: 472.53, term: "monthly", status: "ended" });
    expect(basisOf(r.statement)).toBe("27 of 31 days");
    db.lot_reservations[0].during = "[2027-01-01,2027-02-01)";
    const whole = await statementFor(admin, PARK, "jan", "2027-01");
    expect(basisOf("error" in whole ? null : whole.statement)).toBe("for the month");
  });

  it("refuses a lot that is not in this park", async () => {
    db.park_lots[0].park_id = "park-2";
    const r = await statementFor(admin, PARK, "jan", "2027-01");
    expect("error" in r && r.what).toBe("that lot");
  });
});

// ---------------------------------------------------------------------------
// THE RUN'S TWO READERS LIVE HERE NOW. statementFor carried its own copy of
// ledger-actions' private feesFor (the audience filter) and unbilledCostShares
// (the share label and basis) — a rule changed in one would have left the
// sign door and the move-out raising a different bill from the run's.
// ---------------------------------------------------------------------------
describe("feesFor and unbilledCostShares — one home, and statementFor asks them", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("feesFor keeps the audience the run honours and reports a failed read as a failed read", async () => {
    db.park_fees.push({ park_id: PARK, active: true, label: "Boat", amount: 25, cadence: "monthly", applies_to: "boat" });
    db.park_fees.push({ park_id: PARK, active: false, label: "Old", amount: 5, cadence: "monthly", applies_to: "all_lots" });
    const r = await feesFor(admin, PARK);
    expect(r.error).toBeNull();
    expect(r.fees).toEqual([{ label: "Grounds", amount: 142.53, cadence: "monthly" }]);
  });

  it("unbilledCostShares labels from the one category map, keys by reservation, and never bills another park's water", async () => {
    db.lot_cost_shares.push({ id: "sh-1", reservation_id: "jan", cost_id: "c1", amount: 18.5, basis: "b", billed_on_charge_id: null });
    db.lot_cost_shares.push({ id: "sh-2", reservation_id: "jan", cost_id: "c2", amount: 9, basis: "b", billed_on_charge_id: null });
    db.lot_cost_shares.push({ id: "sh-3", reservation_id: "jan", cost_id: "c1", amount: 1, basis: "b", billed_on_charge_id: "chg-old" });
    db.park_costs.push({ id: "c1", park_id: PARK, category: "water", period_start: "2026-12-01", period_end: "2026-12-31" });
    db.park_costs.push({ id: "c2", park_id: "park-2", category: "trash", period_start: null, period_end: null });
    const r = await unbilledCostShares(admin, PARK, ["jan"]);
    expect(r.error).toBeNull();
    expect(r.shares.get("jan")).toEqual([{ id: "sh-1", label: "Water — your share", amount: 18.5, basis: "for 2026-12-01 to 2026-12-31" }]);
    expect((await unbilledCostShares(admin, PARK, [])).shares.size).toBe(0);
  });

  it("statementFor calls the two readers — no second copy of the audience filter or the share label", () => {
    const src = strip(readFileSync(fileURLToPath(new URL("./charge-edits.ts", import.meta.url)), "utf8"));
    const body = src.slice(src.indexOf("export async function statementFor("), src.indexOf("export function basisOf("));
    expect(body, "statementFor is gone — this scan measures nothing").not.toBe("");
    expect(body).toMatch(/feesFor\(admin, parkId\)/);
    expect(body).toMatch(/unbilledCostShares\(admin, parkId, \[reservationId\]\)/);
    expect(body).not.toMatch(/\["all_lots", "long_term"\]/);
    expect(body).not.toMatch(/— your share/);
    expect(body).not.toMatch(/from\("park_fees"\)/);
    expect(body).not.toMatch(/from\("lot_cost_shares"\)/);
    // The one definition of each in this file.
    expect(src.match(/\["all_lots", "long_term"\]/g)).toHaveLength(1);
    expect(src.match(/— your share/g)).toHaveLength(1);
  });

  it("strandedSharesSentence: nothing when every released share was taken up, the count when not", () => {
    expect(strandedSharesSentence(0, 0, "x")).toBe("");
    expect(strandedSharesSentence(2, 2, "x")).toBe("");
    expect(strandedSharesSentence(1, 3, "x")).toBe("");
    expect(strandedSharesSentence(1, 0, "the arrangement they had")).toBe(
      "1 cost share that was on that bill is back on the arrangement they had and won't bill from there — remove that bill on the costs screen and split it again.",
    );
    expect(strandedSharesSentence(3, 1, "their closed-out agreement")).toBe(
      "2 cost shares that were on that bill are back on their closed-out agreement and won't bill from there — remove that bill on the costs screen and split it again.",
    );
  });
});
