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
 * The fake models the two triggers that matter — paid_total follows the
 * payments and allocations, the 0167 view says what is on account — and
 * nothing else.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; patch: Row }> = [];
const failNext: { update?: string; insert?: string } = {};

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const liveAlloc = (a: Row) => a.removed_at == null;
const stands = (p: Row | undefined) => !!p && p.reversed_at == null && p.returned_at == null;
function remainingOf(p: Row): number {
  const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && liveAlloc(a)).reduce((s, a) => s + cents(a.amount), 0);
  return Math.max(0, cents(p.amount) - allocated) / 100;
}
function onAccountView(): Row[] {
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.charge_id == null && stands(p))
    .map((p) => ({ payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id, amount: p.amount, received_on: p.received_on, created_at: null, remaining: remainingOf(p) }));
}
function recompute(chargeId: string) {
  const c = (db.park_charges ?? []).find((x) => x.id === chargeId);
  if (!c) return;
  const direct = (db.park_payments ?? []).filter((p) => p.charge_id === chargeId && stands(p)).reduce((s, p) => s + cents(p.amount), 0);
  const applied = (db.park_payment_allocations ?? []).filter((a) => a.charge_id === chargeId && liveAlloc(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  const paid = (direct + applied) / 100;
  c.paid_total = paid;
  if (c.status !== "void") c.status = paid >= Number(c.amount) ? "paid" : "open";
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
      for (const r of hit) Object.assign(r, this.patch);
      writes.push({ table: this.t, op: "update", patch: this.patch! });
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
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
  db.park_charges = []; db.park_payments = []; db.park_payment_allocations = []; db.lot_cost_shares = []; db.park_costs = [];
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
    expect(r.voided).toEqual([{ id: "chg-jan", reservationId: "jan", month: "2027-01", amount: 542.53 }]);
    expect(r.skipped).toEqual([{ id: "chg-feb", reservationId: "jan", month: "2027-02", amount: 542.53, paidTotal: 50 }]);
    expect(r.failed).toEqual([]);
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
