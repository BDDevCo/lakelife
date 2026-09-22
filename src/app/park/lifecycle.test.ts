import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { summarise, buildRentRoll, toStay, type RawReservation } from "./park-helpers";
import type { Lot } from "@/lib/parks";

// ---------------------------------------------------------------------------
// The second half of this file drives the REAL `endTenancy` against an
// in-memory table, so the mocks are declared up front (vitest hoists them).
// The pure-helper tests above are untouched by them.
//
// The fake is deliberately dumb: filters, inserts, updates, and the
// triggers that matter for a move-out inside a billed month — a charge's
// paid_total follows its payments and allocations (recompute_charge_paid), the
// 0167 view says what is still on account, and 0169's void guard: a bill with
// a live line from money on account refuses the void by name, a void bill
// holds 0, and a payment against a void bill is money on account (in the view,
// with the bill's month beside it). Nothing here is a copy of the code under
// test.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { lot_reservations: [], park_members: [], park_lots: [], parks: [], park_renters: [] };
const writes: Array<{ op: string; patch: Row; matched: string[] }> = [];
const failNext: { update?: boolean; select?: string } = {};

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const liveAlloc = (a: Row) => a.removed_at == null;
const stands = (p: Row | undefined) => !!p && p.reversed_at == null && p.returned_at == null;
/** The view's `refunded`: 0142 rows against the payment, money gone back through the processor. */
function refundedOf(p: Row): number {
  return (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((s, r) => s + cents(r.amount), 0) / 100;
}
/** park_payment_remaining (0168): amount − live allocations − refunds. */
function remainingOf(p: Row): number {
  const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && liveAlloc(a)).reduce((s, a) => s + cents(a.amount), 0);
  return Math.max(0, cents(p.amount) - allocated - cents(refundedOf(p))) / 100;
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
        created_at: p.created_at ?? null, refunded: refundedOf(p), remaining: remainingOf(p),
        released_from_charge_id: c?.id ?? null, released_from_month: c?.period_month ?? null, released_on: c?.voided_at ?? null,
      };
    });
}
/** recompute_charge_paid (0142: a payment counts net of its refunds), with 0169's park_charge_paid_total: a void bill holds 0. */
function recompute(chargeId: string) {
  const c = (db.park_charges ?? []).find((x) => x.id === chargeId);
  if (!c) return;
  if (c.status === "void") { c.paid_total = 0; return; }
  const direct = (db.park_payments ?? []).filter((p) => p.charge_id === chargeId && stands(p)).reduce((s, p) => s + cents(p.amount) - cents(refundedOf(p)), 0);
  const applied = (db.park_payment_allocations ?? []).filter((a) => a.charge_id === chargeId && liveAlloc(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  const paid = (direct + applied) / 100;
  c.paid_total = paid;
  c.status = paid >= Number(c.amount) ? "paid" : "open";
}
/** guard_park_charge_void (0169): refused by name while a live line from a standing payment is on it. */
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
  private op: "select" | "update" | "insert" | "delete" = "select";
  private ins: Row[] | null = null;
  private embed = false;
  private sort: { c: string; asc: boolean } | null = null;
  constructor(private t: string) {}
  select(cols?: string) { if (cols?.includes("park_lots(")) this.embed = true; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  gt(c: string, v: number) { this.fs.push((r) => Number(r[c]) > v); return this; }
  gte(c: string, v: unknown) { this.fs.push((r) => String(r[c]) >= String(v)); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, _op: string, v: unknown) { this.fs.push((r) => !(v === null ? r[c] == null : r[c] === v)); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.sort = { c, asc: o?.ascending !== false }; return this; }
  // gap-bills parkRanMonth asks for one standing bill of the month — enough to know the run happened.
  limit(_n: number) { return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  // The "Someone lives here" door inserts a renter file then a tenancy, and
  // deletes the file when the tenancy cannot land.
  insert(row: Row | Row[]) { this.op = "insert"; this.ins = Array.isArray(row) ? row : [row]; return this; }
  delete() { this.op = "delete"; return this; }
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
      const rows = this.ins!.map((r) => {
        const row: Row = { id: `${this.t}-${(db[this.t] ??= []).length + 1}`, ...r };
        if (this.t === "park_charges") { if (row.paid_total === undefined) row.paid_total = 0; if (row.status === undefined) row.status = "open"; }
        db[this.t].push(row);
        writes.push({ op: `insert:${this.t}`, patch: r, matched: [row.id as string] });
        if (this.t === "park_payment_allocations") recompute(row.charge_id as string);
        return row;
      });
      return { data: rows, error: null };
    }
    const hit = this.rows();
    if (this.op === "delete") {
      db[this.t] = (db[this.t] ?? []).filter((r) => !hit.includes(r));
      writes.push({ op: `delete:${this.t}`, patch: {}, matched: hit.map((r) => r.id as string) });
      return { data: [], error: null };
    }
    if (this.op === "update") {
      if (failNext.update) { delete failNext.update; return { data: null, error: { message: "boom" } }; }
      if (this.t === "park_charges") {
        for (const r of hit) { const refused = guardVoid(r, this.patch!); if (refused) return { data: null, error: refused }; }
      }
      for (const r of hit) Object.assign(r, this.patch);
      if (this.t === "park_charges") for (const r of hit) if (r.status === "void") r.paid_total = 0;
      if (this.t === "park_payment_allocations") for (const r of hit) recompute(r.charge_id as string);
      writes.push({ op: "update", patch: this.patch!, matched: hit.map((r) => r.id as string) });
      return { data: hit.map((r) => ({ id: r.id, during: r.during })), error: null };
    }
    if (failNext.select === this.t) { delete failNext.select; return { data: null, error: { message: "boom" } }; }
    return {
      data: hit.map((r) => (this.embed ? { ...r, park_lots: { park_id: "park-1" } } : r)),
      error: null,
    };
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); }
  single() { return this.maybeSingle(); }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> { return Promise.resolve(this.run()).then(ok, bad); }
}

/** The lakes' clock, settable per test — hoisted so the mock factory can see it. */
const clock = vi.hoisted(() => ({ today: "2027-01-27" }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/booking", () => ({ todayLakeDate: () => clock.today }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/rent-changes", () => ({
  servedRentHistory: async () => ({ byRes: new Map(), error: null }),
}));
const { endTenancy, addTenant } = await import("./actions");

const TODAY = "2027-06-15";

const lot = (over: Partial<Lot> & { id: string; lotNumber: string }): Lot => ({
  siteType: "mh_single", maxLengthFt: null, amperage: null,
  hasWater: true, hasSewer: true, slipIncluded: false, active: true,
  ...over,
} as Lot);

const stay = (lotId: string): RawReservation => ({
  id: `r-${lotId}`, park_lot_id: lotId, renter_id: `x-${lotId}`, renter_unit_id: null,
  during: "[2027-01-01,2027-12-31)", term: "monthly", quoted_amount: 400,
  status: "active", decided_at: null, created_at: null,
});

describe("THE NUMBER THAT GOES IN FRONT OF A LENDER", () => {
  it("keeps four unbuilt STR homes out of occupancy entirely", () => {
    // The Haven: 22 real lots, 20 of them occupied — and four short-term homes
    // he has not bought yet.
    const real = Array.from({ length: 22 }, (_, i) => lot({ id: `l${i}`, lotNumber: String(i + 1) }));
    const planned = Array.from({ length: 4 }, (_, i) =>
      lot({ id: `s${i}`, lotNumber: `H${i + 1}`, lifecycle: "planned", rentalMode: "short_term" }));
    const stays = real.slice(0, 20).map((l) => toStay(stay(l.id)));

    const rows = buildRentRoll([...real, ...planned], stays, TODAY);
    const s = summarise(rows);

    expect(s.lots).toBe(22);
    expect(s.occupied).toBe(20);
    expect(s.planned).toBe(4);
    // 20/22 = 91%, NOT 20/26 = 77%.
    expect(s.occupancyPct).toBe(91);
  });

  it("a home being renovated is not vacant either", () => {
    const rows = buildRentRoll(
      [lot({ id: "a", lotNumber: "1" }), lot({ id: "b", lotNumber: "H1", lifecycle: "renovating" })],
      [toStay(stay("a"))],
      TODAY,
    );
    const s = summarise(rows);
    expect(s.renovating).toBe(1);
    expect(s.vacant).toBe(0);
    expect(s.lots).toBe(1);
    expect(s.occupancyPct).toBe(100);
  });

  it("counts nightly homes apart once they ARE live", () => {
    // Occupancy for a nightly home is 19 nights of 30, not "somebody lives
    // here". Averaging the two describes neither.
    const rows = buildRentRoll(
      [
        lot({ id: "a", lotNumber: "1" }),
        lot({ id: "b", lotNumber: "H1", lifecycle: "live", rentalMode: "short_term" }),
      ],
      [toStay(stay("a"))],
      TODAY,
    );
    const s = summarise(rows);
    expect(s.shortTermLots).toBe(1);
    expect(s.lots).toBe(1);
    expect(s.occupancyPct).toBe(100);
  });

  it("a retired lot leaves the numbers without deleting its history", () => {
    const rows = buildRentRoll(
      [lot({ id: "a", lotNumber: "1" }), lot({ id: "b", lotNumber: "9", lifecycle: "retired" })],
      [toStay(stay("a"))],
      TODAY,
    );
    const s = summarise(rows);
    expect(s.lots).toBe(1);
    expect(rows).toHaveLength(2);   // still in the roll, just not in the maths
  });

  it("treats a lot with no lifecycle as live — every park that existed before", () => {
    const rows = buildRentRoll([lot({ id: "a", lotNumber: "1" })], [toStay(stay("a"))], TODAY);
    const s = summarise(rows);
    expect(s.lots).toBe(1);
    expect(s.occupied).toBe(1);
    expect(s.planned).toBe(0);
  });

  it("a brand-new park with only planned lots is not 0% full", () => {
    const rows = buildRentRoll(
      [lot({ id: "a", lotNumber: "H1", lifecycle: "planned" })], [], TODAY,
    );
    const s = summarise(rows);
    expect(s.lots).toBe(0);
    expect(s.planned).toBe(1);
    expect(s.occupancyPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A MOVE-OUT ENDS THE CHAIN. The February agreement is written on 5 January
// for all eighteen; Lot 9 leaves on the 27th. Before this, closing out the
// January row left its successor approved — billed for February, holding the
// lot until May, reachable from no screen. These drive the real action.
// ---------------------------------------------------------------------------
describe("closing one out withdraws what was written for after", () => {
  const link = (over: Row): Row => ({
    park_lot_id: "lot-9", renter_id: "file-9", agreement_chain_id: "chain-9",
    moved_out_on: null, term: "monthly", quoted_amount: 400, origin: "office", due_day: null, ...over,
  });
  beforeEach(() => {
    db.park_members = [{ park_id: "park-1", user_id: "user-owner", role: "owner" }];
    db.park_lots = [{ id: "lot-9", park_id: "park-1", lot_number: "9", rental_mode: "long_term", lifecycle: "live" }];
    db.parks = [{ id: "park-1", rent_due_day: 1, cutover_date: "2027-01-01", max_agreement_months: 6, default_agreement_months: 1 }];
    db.park_fees = [{ park_id: "park-1", active: true, label: "Grounds", amount: 142.53, cadence: "monthly", applies_to: "long_term" }];
    db.park_charges = []; db.park_payments = []; db.park_payment_allocations = []; db.lot_cost_shares = [];
    db.lot_reservations = [
      link({ id: "jan", during: "[2027-01-01,2027-02-01)", status: "active", agreement_seq: 1 }),
      link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }),
    ];
    writes.length = 0;
    delete failNext.update;
    clock.today = "2027-01-27";
  });

  it("Jan row ended on the 27th + a February successor → the successor is cancelled, and the signal says so", async () => {
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations.find((r) => r.id === "jan")).toMatchObject({
      status: "ended", during: "[2027-01-01,2027-01-28)", moved_out_on: "2027-01-27",
    });
    expect(db.lot_reservations.find((r) => r.id === "feb")).toMatchObject({
      status: "cancelled", during: "[2027-02-01,2027-05-01)",   // range left alone
    });
    expect(db.lot_reservations.find((r) => r.id === "feb")).not.toHaveProperty("moved_out_on", "2027-01-27");
    // Two writes: the trim, then ONE guarded cascade on the chain.
    expect(writes.map((w) => w.patch)).toEqual([
      { status: "ended", during: "[2027-01-01,2027-01-28)", moved_out_on: "2027-01-27" },
      { status: "cancelled" },
    ]);
    expect(writes[1].matched).toEqual(["feb"]);
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. Their final month bills for the days they were here. " +
      "Their February 2027 agreement was withdrawn too — nothing bills for it.",
    );
  });

  it("from the successor's own row — the 1 February screen — a January last day still closes January", async () => {
    // On 1 February `current` is the successor; the old code refused any
    // January date with "They moved in on 2027-02-01".
    const res = await endTenancy("feb", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations.find((r) => r.id === "jan")).toMatchObject({ status: "ended", moved_out_on: "2027-01-27" });
    expect(db.lot_reservations.find((r) => r.id === "feb")).toMatchObject({ status: "cancelled" });
    expect(res.error).toBeUndefined();
  });

  it("names every month withdrawn when more than one was written", async () => {
    db.lot_reservations.push(link({ id: "mar", during: "[2027-05-01,2027-06-01)", status: "approved", agreement_seq: 3 }));
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.signal).toMatch(/Their February 2027 and May 2027 agreements were withdrawn too — nothing bills for them\./);
  });

  it("a household with no successor reads exactly as before", async () => {
    db.lot_reservations = [link({ id: "jan", during: "[2027-01-01,2027-02-01)", status: "active", agreement_seq: 1 })];
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe("Closed out — last day January 27, 2027. Their final month bills for the days they were here.");
    expect(writes).toHaveLength(1);
  });

  it("'Withdraw the next agreement' is the cancelled branch, and it touches only that row", async () => {
    const res = await endTenancy("feb", "cancelled");
    expect(res.ok).toBe(true);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
    expect(db.lot_reservations.find((r) => r.id === "jan")!.status).toBe("active");
  });

  it("refuses a day before the record starts without claiming they moved in then", async () => {
    const res = await endTenancy("feb", "ended", "2026-12-30");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Their record here starts on January 1, 2027 — the last day can't be before that.");
    expect(writes).toEqual([]);
  });

  it("when the cascade fails after the trim, the sentence says the successor still bills", async () => {
    // The first update (the trim) lands; the failure is armed for the next.
    const orig = (Q.prototype as unknown as { run: () => unknown }).run;
    (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
      const out = orig.call(this);
      if (writes.length === 1 && !failNext.update) failNext.update = true;
      return out;
    };
    const res = await endTenancy("jan", "ended", "2027-01-27");
    (Q.prototype as unknown as { run: () => unknown }).run = orig;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Closed out — last day January 27, 2027 — but their next agreement couldn't be withdrawn and still bills/);
    expect(res.error).not.toMatch(/try again/i);
    // It points at a control the row now has — not at "get in touch". The
    // lot is left with no current link and a standing successor, which is
    // exactly the shape the roll offers 'Withdraw the next agreement' for.
    expect(res.error).toMatch(/Withdraw it from their row on the roll \('Withdraw the next agreement'\)/);
    expect(res.error).not.toMatch(/get in touch/);
    expect(db.lot_reservations.find((r) => r.id === "jan")!.status).toBe("ended");
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("approved");
  });

  it("and from that state, the withdrawal the sentence names is the cancelled branch, and it works", async () => {
    db.lot_reservations.find((r) => r.id === "jan")!.status = "ended";
    const res = await endTenancy("feb", "cancelled");
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
  });

  /** Arm the mock so the trim lands and the cascade after it fails. */
  async function withCascadeFailure<T>(run: () => Promise<T>): Promise<T> {
    const orig = (Q.prototype as unknown as { run: () => unknown }).run;
    (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
      const out = orig.call(this);
      if (writes.length === 1 && !failNext.update) failNext.update = true;
      return out;
    };
    try { return await run(); } finally { (Q.prototype as unknown as { run: () => unknown }).run = orig; }
  }

  it("a LATE close-out whose successor has already started names Move out, not a control the row lacks", async () => {
    // They left on 27 January; the office records it on 3 February. The
    // successor is `active` and covers today, so buildRentRoll makes it
    // `current` and the row offers Move out / Edit — 'Withdraw the next
    // agreement' is not there. The path that works is Move out on that row
    // with the same last day; the sentence has to say so.
    clock.today = "2027-02-03";
    db.lot_reservations.find((r) => r.id === "feb")!.status = "active";
    const res = await withCascadeFailure(() => endTenancy("jan", "ended", "2027-01-27"));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Closed out — last day January 27, 2027 — but their next agreement couldn't be withdrawn and still bills. " +
      "Withdraw it from their row on the roll (Move out, with the same last day).",
    );
    expect(res.error).not.toMatch(/Withdraw the next agreement/);
    expect(db.lot_reservations.find((r) => r.id === "jan")!.status).toBe("ended");
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("active");

    // The roll, on 3 February, from that state: the successor is current.
    const rows = buildRentRoll(
      [lot({ id: "lot-9", lotNumber: "9" })],
      db.lot_reservations.map((r) => toStay({
        id: r.id as string, park_lot_id: "lot-9", renter_id: "file-9", renter_unit_id: null,
        during: r.during as string, term: "monthly", quoted_amount: 400,
        status: r.status as string, decided_at: null, created_at: null,
      })),
      "2027-02-03",
    );
    expect(rows[0].current?.id).toBe("feb");
    expect(rows[0].next).toBeNull();
    expect(rows[0].state).toBe("occupied");
  });

  it("and from that state, Move out on the successor's row with the same last day withdraws it", async () => {
    clock.today = "2027-02-03";
    db.lot_reservations.find((r) => r.id === "jan")!.status = "ended";
    Object.assign(db.lot_reservations.find((r) => r.id === "jan")!, { during: "[2027-01-01,2027-01-28)", moved_out_on: "2027-01-27" });
    db.lot_reservations.find((r) => r.id === "feb")!.status = "active";
    const res = await endTenancy("feb", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
    expect(res.signal).toBe(
      "They were already closed out on January 27, 2027. Their February 2027 agreement was withdrawn too — nothing bills for it.",
    );
  });

  it("a successor still to start keeps naming 'Withdraw the next agreement'", async () => {
    // Same failure on the 27th itself: February has not begun, the row has
    // no current link and the successor is `next` — the control exists.
    const res = await withCascadeFailure(() => endTenancy("jan", "ended", "2027-01-27"));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/\('Withdraw the next agreement'\)\.$/);
    expect(res.error).not.toMatch(/Move out/);
  });

  it("a successor that has ALREADY LAPSED names no control — none reaches it — and does not say 'still bills'", async () => {
    // They left on 27 January; the office records it on 15 March, with the
    // February link [1 Feb, 1 Mar) run its course. The old two-way sentence
    // took 'started' for 'running' and sent him to Move out — but February
    // neither covers today nor is next: buildRentRoll reads the lot LAPSED
    // (asserted below), and the row's Move out on that link takes only a
    // day inside February, which is not the day they left, so the sentence
    // names no control; and 'still bills' was false of a link that billed
    // February and bills nothing now.
    clock.today = "2027-03-15";
    Object.assign(db.lot_reservations.find((r) => r.id === "feb")!, { status: "active", during: "[2027-02-01,2027-03-01)" });
    const res = await withCascadeFailure(() => endTenancy("jan", "ended", "2027-01-27"));
    expect(res.ok).toBe(false);
    // No live February bill in the fake: 'it already billed February' was a
    // claim about a bill nobody read. The standings ARE read now — a paid
    // one refuses before any write, a live one is cancelled first and named
    // (next test) — so with none the sentence says what is true of the link.
    expect(res.error).toBe(
      "Closed out — last day January 27, 2027 — but their next agreement couldn't be withdrawn: " +
      "it has run its course and nothing bills for it, but it still stands on their record for February 2027. " +
      "That's ours to fix — get in touch and we'll sort it.",
    );
    expect(res.error).not.toMatch(/already billed/);
    expect(res.error).not.toMatch(/still bills/);
    expect(res.error).not.toMatch(/Move out/);
    expect(res.error).not.toMatch(/Withdraw the next agreement/);
    expect(db.lot_reservations.find((r) => r.id === "jan")!.status).toBe("ended");
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("active");

    // The roll, on 15 March, from that state: nothing current, nothing next
    // — and the February link, held and behind today, is LAPSED, not vacant:
    // the row reads 'Ran out' and Move out is keyed on it, so the sentence
    // above stays true (the record stands) and the second-renter door
    // ("Someone lives here", vacant only) stays shut on a lot the failed
    // cascade left standing.
    const rows = buildRentRoll(
      [lot({ id: "lot-9", lotNumber: "9" })],
      db.lot_reservations.map((r) => toStay({
        id: r.id as string, park_lot_id: "lot-9", renter_id: "file-9", renter_unit_id: null,
        during: r.during as string, term: "monthly", quoted_amount: 400,
        status: r.status as string, decided_at: null, created_at: null,
      })),
      "2027-03-15",
    );
    expect(rows[0].current).toBeNull();
    expect(rows[0].next).toBeNull();
    expect(rows[0].state).toBe("lapsed");
    expect(rows[0].lapsed?.id).toBe("feb");
  });

  it("a lapsed link AND one still to come: the one still to come is withdrawable, so that control is named", async () => {
    clock.today = "2027-03-15";
    Object.assign(db.lot_reservations.find((r) => r.id === "feb")!, { status: "active", during: "[2027-02-01,2027-03-01)" });
    db.lot_reservations.push(link({ id: "apr", during: "[2027-04-01,2027-05-01)", status: "approved", agreement_seq: 3 }));
    const res = await withCascadeFailure(() => endTenancy("jan", "ended", "2027-01-27"));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/\('Withdraw the next agreement'\)\.$/);
  });
});

// ---------------------------------------------------------------------------
// THE CONTROL HAS TO BE THERE FOR THE SENTENCE TO BE TRUE. The roll used to
// offer 'Withdraw the next agreement' only behind a CURRENT link (same
// renter), so the state the failed cascade leaves — current ended, successor
// standing — had no control at all: from 28 January the lot read 'reserved',
// Move out was gone, and nothing could reach the February row.
// ---------------------------------------------------------------------------
describe("the roll offers the withdrawal for a lot whose current link has ended", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const page = strip(readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8"));
  const roll = strip(readFileSync(fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)), "utf8"));

  it("finds the rule it is scanning", () => {
    expect(page).toMatch(/const nextIsRenewal = /);
    expect(page).toMatch(/nextReservationId: nextIsRenewal \? r\.next!\.id : null/);
  });

  it("a SUCCESSOR still to start on a lot with NO current link is withdrawable — a household's ONLY record is not", () => {
    // Before go-live every imported row at The Haven has no current link and
    // a [1 January, …) holdover as `next`. `r.current == null ||` alone
    // offered 'Withdraw the next agreement' on all 21 rows, and one 'Yes'
    // cancelled the household's ONLY record with no undo. `!== 'grandfathered'`
    // still admitted an approved applicant (origin 'application', no
    // current) — a first agreement, not a 'next' one. Every successor is
    // written 'office' (successor-row.ts, from the renewal, extension and
    // signing doors), so 'office' is the test.
    const rule = page.match(/const nextIsRenewal = ([^;]+);/)?.[1] ?? "";
    expect(rule).toMatch(/r\.current == null \? r\.next\.origin === "office" : r\.next\.renterId === r\.current\.renterId/);
    expect(rule).not.toMatch(/r\.current == null \|\|/);
    expect(rule).not.toMatch(/!== "grandfathered"/);
  });

  it("the rule, run: an imported holdover or an approved applicant offers no withdrawal; a stranded successor does", () => {
    // The same expression the page evaluates, applied to the shapes.
    const rule = page.match(/const nextIsRenewal = ([^;]+);/)?.[1] ?? "";
    const evaluate = new Function("r", `return ${rule};`) as (r: unknown) => boolean;
    const imported = { current: null, next: { id: "hold", renterId: "f", origin: "grandfathered" } };
    const applicant = { current: null, next: { id: "app", renterId: "f", origin: "application" } };
    const stranded = { current: null, next: { id: "feb", renterId: "f", origin: "office" } };
    const renewal = { current: { renterId: "f" }, next: { id: "feb", renterId: "f", origin: "office" } };
    const stranger = { current: { renterId: "f" }, next: { id: "x", renterId: "g", origin: "application" } };
    expect(evaluate(imported)).toBe(false);
    expect(evaluate(applicant)).toBe(false);
    expect(evaluate(stranded)).toBe(true);
    expect(evaluate(renewal)).toBe(true);
    expect(evaluate(stranger)).toBe(false);
    expect(evaluate({ current: null, next: null })).toBe(false);
  });

  it("a DIFFERENT household's link behind a current one is still not this row's to withdraw", () => {
    const rule = page.match(/const nextIsRenewal = ([^;]+);/)?.[1] ?? "";
    expect(rule).toMatch(/^!!r\.next && \(/);
  });

  it("the screen refreshes the row when a close-out saved but its cascade did not", () => {
    // Otherwise the row keeps offering Move out for a tenancy already ended,
    // and a second tap gets "That one is already closed."
    const close = roll.slice(roll.indexOf("function close("), roll.indexOf("function notice("));
    expect(close, "close() is gone — this scan measures nothing").not.toBe("");
    const failure = close.match(/if \(!res\.ok\) \{[\s\S]*?return;\s*\}/)?.[0] ?? "";
    expect(failure).toMatch(/\/\^Closed out\/\.test\(res\.error/);
    expect(failure).toMatch(/router\.refresh\(\)/);
  });
});

// ---------------------------------------------------------------------------
// "SOMEONE LIVES HERE" WRITES THE LENGTH THE HOUSEHOLD CHOSE. The owner's
// decision: one, three or six months at signing. This door used to hand
// buildTenant the park's house style for every signed lease; the length is
// the form's now, judged against the park's dials, and said back in the toast.
// ---------------------------------------------------------------------------
describe("addTenant — the roll's one-at-a-time door — takes the chosen length", () => {
  const signed = (agreementMonths: number | null | undefined) => ({
    displayName: "Reyes, Donna", mobile: "(260) 555-0142", email: "donna@example.com",
    movedInOn: "", term: "monthly", rent: "400", source: "owner_knowledge",
    signedNewLease: true, agreementStartsOn: "2027-01-01", agreementMonths,
  });

  beforeEach(() => {
    clock.today = "2027-01-04";
    db.park_members = [{ park_id: "park-1", user_id: "user-owner", role: "owner" }];
    db.park_lots = [{ id: "lot-9", park_id: "park-1", lot_number: "9" }];
    // The Haven: a one-month house style under a three-month cap.
    db.parks = [{ id: "park-1", max_agreement_months: 3, default_agreement_months: 1, cutover_date: "2027-01-01" }];
    db.park_renters = [];
    db.lot_reservations = [];
    writes.length = 0;
  });

  const tenancy = () => db.lot_reservations[0];

  it("writes three months when three is chosen, and says so", async () => {
    const res = await addTenant("park-1", "lot-9", signed(3));
    expect(res.ok, res.error).toBe(true);
    expect(tenancy()).toMatchObject({ during: "[2027-01-01,2027-04-01)", origin: "application", status: "active" });
    expect(res.signal).toContain("on the new 3-month lease from January 1, 2027.");
  });

  it("writes one month when one is chosen — the house style is a choice like any other", async () => {
    const res = await addTenant("park-1", "lot-9", signed(1));
    expect(res.ok, res.error).toBe(true);
    expect(tenancy().during).toBe("[2027-01-01,2027-02-01)");
    expect(res.signal).toContain("on the new one-month lease from January 1, 2027.");
  });

  it("refuses six at a cap of three, reading the cap from the PARK, writing nothing — and files it once the cap is six", async () => {
    const six = await addTenant("park-1", "lot-9", signed(6));
    expect(six.ok).toBe(false);
    expect(six.error).toBe("This park writes agreements of 1 or 3 months — pick one of those.");
    expect(writes).toEqual([]);
    expect(db.park_renters).toEqual([]);

    db.parks[0].max_agreement_months = 6;
    const raised = await addTenant("park-1", "lot-9", signed(6));
    expect(raised.ok, raised.error).toBe(true);
    expect(tenancy().during).toBe("[2027-01-01,2027-07-01)");
  });

  it("refuses a signed lease with no length rather than filing the house style — before any write", async () => {
    const res = await addTenant("park-1", "lot-9", signed(null));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Pick how long the agreement runs — 1 or 3 months.");
    expect(writes).toEqual([]);
    // A form that never sent the field at all is the same missing choice.
    expect((await addTenant("park-1", "lot-9", signed(undefined))).ok).toBe(false);
  });

  it("a holdover has no length: the tick clear, whatever the field says, writes the rolling horizon — from the cutover, said back", async () => {
    // Filed on 4 January on the arrangement they already had: the window
    // starts where the ledger's claim on them starts (the cutover, 1 January
    // — they were there on the 1st), the horizon rolls a year from today,
    // and the toast says the day January bills them from.
    const res = await addTenant("park-1", "lot-9", { ...signed(3), signedNewLease: false, agreementStartsOn: "" });
    expect(res.ok, res.error).toBe(true);
    expect(tenancy()).toMatchObject({ during: "[2027-01-01,2028-01-04)", origin: "grandfathered", status: "active", tenancy_began_on: null });
    expect(res.signal).toContain("on the arrangement they already had, billed from January 1, 2027.");
  });

  it("a signed lease with the day left blank after go-live is refused — never filed from today", async () => {
    const res = await addTenant("park-1", "lot-9", { ...signed(1), agreementStartsOn: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Type the day the lease runs from — the day on the paper, not today.");
    expect(writes).toEqual([]);
    expect(db.park_renters).toEqual([]);
  });

  // A LEASE DATED INTO THE PAST BILLS THE MONTHS THE RUN WENT BY (decision 3).
  // The run visits a month once, when he presses Bill <month>, and keys
  // "already billed" per reservation — so a row written after the press is
  // never billed for it by anything. The door bills it, through the same
  // re-raise the signing and renew doors use, and the toast says so.
  const januaryRan = () => {
    db.park_lots[0].rental_mode = "long_term";
    db.park_lots[0].lifecycle = "live";
    db.parks[0].rent_due_day = 1;
    db.park_fees = [{ park_id: "park-1", active: true, label: "Grounds", amount: 142.53, cadence: "monthly", applies_to: "long_term" }];
    db.park_charges = [{ id: "chg-other", park_id: "park-1", park_lot_id: "lot-2", reservation_id: "res-2", renter_id: "file-2", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "open", lines: [] }];
    db.park_payments = []; db.park_payment_allocations = []; db.lot_cost_shares = [];
  };

  it("a signed lease from 1 January filed on the 4th, after January's run: January is billed on the new row, and the toast says so", async () => {
    januaryRan();
    const res = await addTenant("park-1", "lot-9", signed(1));
    expect(res.ok, res.error).toBe(true);
    const own = db.park_charges.filter((c) => c.reservation_id === tenancy().id);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ period_month: "2027-01", amount: 542.53, status: "open" });
    expect(res.signal).toContain("on the new one-month lease from January 1, 2027.");
    expect(res.signal).toContain("January 2027 is now billed — $542.53.");
  });

  it("…and before January's run, nothing is billed here — the run will raise it with everybody else's", async () => {
    januaryRan();
    db.park_charges = [];
    const res = await addTenant("park-1", "lot-9", signed(1));
    expect(res.ok, res.error).toBe(true);
    expect(db.park_charges).toEqual([]);
    expect(res.signal).not.toMatch(/now billed/);
  });

  it("a holdover filed after the run is left to the run — its window floors at the cutover and the next press bills it", async () => {
    januaryRan();
    const res = await addTenant("park-1", "lot-9", { ...signed(3), signedNewLease: false, agreementStartsOn: "" });
    expect(res.ok, res.error).toBe(true);
    expect(db.park_charges.filter((c) => c.reservation_id === tenancy().id)).toEqual([]);
    expect(res.signal).not.toMatch(/now billed/);
  });

  it("a failed read of whether January ran is SAID — never guessed either way — and the row still lands", async () => {
    januaryRan();
    failNext.select = "park_charges";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await addTenant("park-1", "lot-9", signed(1));
    spy.mockRestore();
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations).toHaveLength(1);
    expect(db.park_charges.filter((c) => c.reservation_id === tenancy().id)).toEqual([]);
    expect(res.signal).toContain(
      "⚠️ We couldn't read the bills already raised this month, so no earlier month was billed for them — bill it from the rent screen.",
    );
  });
});

// ---------------------------------------------------------------------------
// A MOVE-OUT INSIDE A MONTH ALREADY BILLED. January is raised on the 1st at
// $542.53; Lot 9 leaves on the 27th. The toast said "their final month bills
// for the days they were here" and nothing re-rated, voided or re-raised
// anything: the run is keyed on "already billed" and voidCharge refuses a
// paid bill. These drive the real action against the bill in each state.
// ---------------------------------------------------------------------------
describe("closing one out inside a month already billed", () => {
  const link = (over: Row): Row => ({
    park_lot_id: "lot-9", renter_id: "file-9", agreement_chain_id: "chain-9",
    moved_out_on: null, term: "monthly", quoted_amount: 400, origin: "office", due_day: null, ...over,
  });
  const janBill = (over: Row = {}): Row => ({
    id: "chg-jan", park_id: "park-1", park_lot_id: "lot-9", reservation_id: "jan", renter_id: "file-9",
    period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "open",
    lines: [{ label: "Lot rent", amount: 400, basis: "for the month" }, { label: "Grounds", amount: 142.53, basis: "for the month" }],
    ...over,
  });
  const liveCharges = () => (db.park_charges ?? []).filter((c) => c.status !== "void");

  beforeEach(() => {
    db.park_members = [{ park_id: "park-1", user_id: "user-owner", role: "owner" }];
    db.park_lots = [{ id: "lot-9", park_id: "park-1", lot_number: "9", rental_mode: "long_term", lifecycle: "live" }];
    db.parks = [{ id: "park-1", rent_due_day: 1, cutover_date: "2027-01-01", max_agreement_months: 6, default_agreement_months: 1 }];
    db.park_fees = [{ park_id: "park-1", active: true, label: "Grounds", amount: 142.53, cadence: "monthly", applies_to: "long_term" }];
    db.park_renters = [{ id: "file-9", park_id: "park-1", display_name: "Household 9" }];
    db.park_charges = []; db.park_payments = []; db.park_payment_allocations = []; db.lot_cost_shares = []; db.park_refunds = [];
    db.lot_reservations = [link({ id: "jan", during: "[2027-01-01,2027-02-01)", status: "active", agreement_seq: 1 })];
    writes.length = 0;
    delete failNext.update;
    delete failNext.select;
    clock.today = "2027-01-27";
  });

  it("an UNPAID whole-month bill is cancelled with the move-out as the reason and raised again for 27 of 31 days — $472.53", async () => {
    db.park_charges.push(janBill());
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    const old = db.park_charges.find((c) => c.id === "chg-jan")!;
    expect(old).toMatchObject({ status: "void", void_reason: "Moved out January 27, 2027 — billed again for the days they were here" });
    const now = liveCharges();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ reservation_id: "jan", period_month: "2027-01", amount: 472.53, status: "open" });
    // 27/31 of $400 = $348.39; 27/31 of $142.53 = $124.14 — each line rounded, as the run does.
    expect(now[0].lines).toEqual([
      { label: "Lot rent", amount: 348.39, basis: "27 of 31 days" },
      { label: "Grounds", amount: 124.14, basis: "27 of 31 days" },
    ]);
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled and " +
      "raised again for the 27 of 31 days they were here — $472.53.",
    );
    expect(res.signal).not.toMatch(/Their final month bills for the days they were here/);
  });

  it("a bill settled from MONEY ON ACCOUNT: the line comes off with the reason (never a reversal), the bill is cancelled and raised again, and the money settles the new one", async () => {
    // A quarter paid ahead on 28 December; the 1 January run took January off it.
    db.park_payments.push({ id: "pay-q", park_id: "park-1", renter_id: "file-9", amount: 1627.59, kind: "rent", charge_id: null, received_on: "2026-12-28", reversed_at: null, returned_at: null });
    db.park_charges.push(janBill());
    db.park_payment_allocations.push({ id: "al-jan", park_id: "park-1", payment_id: "pay-q", charge_id: "chg-jan", amount: 542.53, removed_at: null, applied_via: "run" });
    recompute("chg-jan");
    expect(db.park_charges[0]).toMatchObject({ paid_total: 542.53, status: "paid" });

    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    // The allocation SURVIVES as record, marked removed with the reason (R3).
    expect(db.park_payment_allocations.find((a) => a.id === "al-jan")).toMatchObject({
      removed_reason: "Moved out January 27, 2027 — the month is billed again for the days they were here",
    });
    expect(db.park_payment_allocations.find((a) => a.id === "al-jan")!.removed_at).toBeTruthy();
    // The cheque itself is exactly the row it was.
    expect(db.park_payments[0]).toMatchObject({ amount: 1627.59, reversed_at: null });
    expect(db.park_charges.find((c) => c.id === "chg-jan")!.status).toBe("void");
    const now = liveCharges();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ amount: 472.53, paid_total: 472.53, status: "paid" });
    // $1,627.59 − $472.53 still on account.
    expect(onAccountView()[0].remaining).toBe(1155.06);
    // ONE statement of what they hold — the view's (heldOnAccountFor), never
    // a subtraction here beside it: '$70.00 is back on account for them'
    // was cents un-applied minus what R1 put on the new bill, and R1 is
    // oldest-open-first, so with an older open bill that $70 would not have
    // been on account at all.
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled and " +
      "raised again for the 27 of 31 days they were here — $472.53, $472.53 of it settled from money on account. " +
      "They still hold $1,155.06 on account with you.",
    );
    expect(res.signal).not.toMatch(/back on account for them/);
  });

  it("PARTLY settled from money on account says the figure — '$100.00 of it' — and the bill stays open for the rest", async () => {
    // $100 on account, nothing applied yet; the whole-month bill unpaid.
    db.park_payments.push({ id: "pay-h", park_id: "park-1", renter_id: "file-9", amount: 100, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: null });
    db.park_charges.push(janBill());
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    const now = liveCharges();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ amount: 472.53, paid_total: 100, status: "open" });
    expect(onAccountView()[0].remaining).toBe(0);
    // '$472.53, settled from money on account' read as paid in full; $372.53 is owing.
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled and " +
      "raised again for the 27 of 31 days they were here — $472.53, $100.00 of it settled from money on account.",
    );
    expect(res.signal).not.toMatch(/They still hold/);
  });

  it("with TWO lines on the bill and the second refusing to come off, the toast names the line that stuck — never the first line, which did come off", async () => {
    // January settled from two payments on account: $100 (pay-a) and
    // $442.53 (pay-b). The first take-off lands; the second is refused.
    // The sentence said "$100.00 of money on account couldn't be taken off
    // it" — the $100 that HAD come off, and the very $100 the held sentence
    // names — while the $442.53 that stuck went unmentioned.
    db.park_payments.push({ id: "pay-a", park_id: "park-1", renter_id: "file-9", amount: 100, kind: "rent", charge_id: null, received_on: "2027-01-02", reversed_at: null, returned_at: null });
    db.park_payments.push({ id: "pay-b", park_id: "park-1", renter_id: "file-9", amount: 442.53, kind: "rent", charge_id: null, received_on: "2027-01-03", reversed_at: null, returned_at: null });
    db.park_charges.push(janBill());
    db.park_payment_allocations.push({ id: "al-a", park_id: "park-1", payment_id: "pay-a", charge_id: "chg-jan", amount: 100, removed_at: null, applied_via: "run" });
    db.park_payment_allocations.push({ id: "al-b", park_id: "park-1", payment_id: "pay-b", charge_id: "chg-jan", amount: 442.53, removed_at: null, applied_via: "run" });
    recompute("chg-jan");
    // Update 1 is the trim, 2 the first take-off, 3 the second: fail the third, once.
    const orig = (Q.prototype as unknown as { run: () => unknown }).run;
    const failUpdateAfter = (n: number) => {
      let armed = false;
      (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
        const out = orig.call(this);
        if (writes.length === n && !armed) { armed = true; failNext.update = true; }
        return out;
      };
    };
    failUpdateAfter(2);
    let res;
    try { res = await endTenancy("jan", "ended", "2027-01-27"); } finally { (Q.prototype as unknown as { run: () => unknown }).run = orig; }
    expect(res.ok, res.error).toBe(true);
    expect(db.park_payment_allocations.find((a) => a.id === "al-a")!.removed_at).toBeTruthy();
    expect(db.park_payment_allocations.find((a) => a.id === "al-b")!.removed_at).toBeNull();
    expect(db.park_charges[0]).toMatchObject({ status: "open", paid_total: 442.53 });
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill still stands for the whole month — " +
      "$442.53 of money on account couldn't be taken off it (Couldn't take that off — boom); $100.00 came off it first. Sort it out from the rent screen. " +
      "They still hold $100.00 on account with you.",
    );
    expect(res.signal).not.toMatch(/\$100\.00 of money on account couldn't/);
    // With the FIRST line stuck nothing came off first, and the sentence says only that.
    db.park_payment_allocations.forEach((a) => { a.removed_at = null; a.removed_reason = null; });
    db.lot_reservations = [link({ id: "jan", during: "[2027-01-01,2027-02-01)", status: "active", agreement_seq: 1 })];
    db.park_charges[0].status = "open"; recompute("chg-jan"); writes.length = 0; delete failNext.update;
    failUpdateAfter(1);
    let first;
    try { first = await endTenancy("jan", "ended", "2027-01-27"); } finally { (Q.prototype as unknown as { run: () => unknown }).run = orig; }
    expect(first.ok, first.error).toBe(true);
    expect(first.signal).toContain("$100.00 of money on account couldn't be taken off it (Couldn't take that off — boom). Sort it out from the rent screen.");
    expect(first.signal).not.toMatch(/came off it first/);
  });

  it("a bill paid straight against it: cancelled, the part month raised and settled from the released money, $70.00 still on account — the walked case", async () => {
    // A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT (0169). The $542.53
    // cheque stays exactly the row it was — same charge_id, standing — and
    // is money on account because its bill is void. R1 puts $472.53 of it
    // against the part month; the $70.00 left is theirs, named by the one
    // held sentence (the view's remaining), and the hand-back door is where
    // it goes back.
    db.park_charges.push(janBill());
    db.park_payments.push({ id: "pay-c", park_id: "park-1", renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-jan", method: "check", received_on: "2027-01-05", reversed_at: null, returned_at: null });
    recompute("chg-jan");
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled — the $542.53 paid on it is on account — " +
      "and raised again for the 27 of 31 days they were here — $472.53, all of it settled from that money. " +
      "They still hold $70.00 on account with you.",
    );
    expect(db.park_charges.find((c) => c.id === "chg-jan")).toMatchObject({ status: "void", paid_total: 0 });
    const now = liveCharges();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ amount: 472.53, paid_total: 472.53, status: "paid" });
    expect(db.park_payment_allocations).toEqual([expect.objectContaining({ payment_id: "pay-c", charge_id: now[0].id, amount: 472.53 })]);
    expect(db.park_payments[0]).toMatchObject({ charge_id: "chg-jan", reversed_at: null });
    expect(onAccountView()).toEqual([expect.objectContaining({ payment_id: "pay-c", remaining: 70, released_from_month: "2027-01" })]);
    expect(res.signal).not.toMatch(/theirs to have back|money on account\./);
    // The trim still lands: the days are what the arithmetic rests on.
    expect(db.lot_reservations[0]).toMatchObject({ status: "ended", during: "[2027-01-01,2027-01-28)", moved_out_on: "2027-01-27" });
  });

  it("…and when $50.00 of that card payment had already gone back, the sentence names all three figures and the part month still settles from what is left", async () => {
    // $542.53 by card, $50.00 refunded before the move-out: the view says
    // $492.53 is on account. "The $492.53 paid on it" would name the
    // remainder as the amount paid. R1 puts $472.53 of the $492.53 against
    // the part month; $20.00 is theirs, from the one held sentence.
    db.park_charges.push(janBill());
    db.park_payments.push({ id: "pay-c", park_id: "park-1", renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-jan", method: "card", reference: "ch_1", received_on: "2027-01-05", reversed_at: null, returned_at: null });
    db.park_refunds.push({ id: "rf-1", park_id: "park-1", payment_id: "pay-c", amount: 50, fee_amount: 0 });
    recompute("chg-jan");
    expect(db.park_charges[0]).toMatchObject({ paid_total: 492.53, status: "open" });
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled — " +
      "of the $542.53 paid on it, $50.00 was already refunded and the other $492.53 is on account — " +
      "and raised again for the 27 of 31 days they were here — $472.53, all of it settled from that money. " +
      "They still hold $20.00 on account with you.",
    );
    expect(res.signal).not.toMatch(/the \$492\.53 paid on it/);
    const now = liveCharges();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ amount: 472.53, paid_total: 472.53, status: "paid" });
    expect(onAccountView()).toEqual([expect.objectContaining({ payment_id: "pay-c", amount: 542.53, refunded: 50, remaining: 20, released_from_month: "2027-01" })]);
  });

  it("'from that money' is said only when every line that settled the part month came from the released row — a $57.47 sibling on account is not January's payment", async () => {
    // $600 split: $542.53 against January (released by the cancel) and
    // $57.47 on account since the 5th. R1 is oldest-money-first with the
    // same day for both, so the part month can be paid from BOTH rows; the
    // toast keeps the unattributed shape rather than crediting January's
    // payment with the sibling's dollars.
    db.park_charges.push(janBill({ id: "chg-dec", period_month: "2026-12", due_on: "2026-12-01", amount: 100 }));
    db.park_charges.push(janBill());
    db.park_payments.push({ id: "pay-c", park_id: "park-1", renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-jan", method: "check", received_on: "2027-01-05", reversed_at: null, returned_at: null, idempotency_key: "k" });
    db.park_payments.push({ id: "pay-s", park_id: "park-1", renter_id: "file-9", amount: 57.47, kind: "rent", charge_id: null, method: "check", received_on: "2027-01-05", reversed_at: null, returned_at: null, idempotency_key: "k:onaccount" });
    recompute("chg-jan");
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    // $100 of the released money went against December first (R1 is
    // oldest-open-bill-first), the rest and $30 of the sibling paid the part
    // month: two sources, so the figure is said and the older month named.
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled — the $542.53 paid on it is on account — " +
      "and raised again for the 27 of 31 days they were here — $472.53, $472.53 of it settled from money on account; $100.00 went against December 2026. " +
      "They still hold $27.47 on account with you.",
    );
    expect(res.signal).not.toMatch(/from that money/);
    expect(db.park_charges.find((c) => c.id === "chg-dec")).toMatchObject({ paid_total: 100, status: "paid" });
  });

  it("with no bill raised yet the sentence is the old one — the run will bill the part month", async () => {
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe("Closed out — last day January 27, 2027. Their final month bills for the days they were here.");
    expect(db.park_charges).toEqual([]);
  });

  it("the cascade cancels the withdrawn successor's bill first — money on account goes back — and says so", async () => {
    // The 1 February run raised February on the successor and spent the
    // household's $57.47 on it; the office records the 27 January move-out
    // on 3 February from the successor's own row.
    clock.today = "2027-02-03";
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "active", agreement_seq: 2 }));
    db.park_payments.push({ id: "pay-x", park_id: "park-1", renter_id: "file-9", amount: 57.47, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: null });
    db.park_charges.push(janBill({ id: "chg-jan", status: "paid", paid_total: 542.53 }));
    db.park_payments.push({ id: "pay-jan", park_id: "park-1", renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-jan", received_on: "2027-01-05", reversed_at: null, returned_at: null });
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payment_allocations.push({ id: "al-feb", park_id: "park-1", payment_id: "pay-x", charge_id: "chg-feb", amount: 57.47, removed_at: null, applied_via: "run" });
    recompute("chg-jan"); recompute("chg-feb");
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ paid_total: 57.47, status: "open" });

    const res = await endTenancy("feb", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "void", void_reason: "Withdrawn — moved out January 27, 2027" });
    expect(db.park_payment_allocations.find((a) => a.id === "al-feb")).toMatchObject({ removed_reason: "Withdrawn — moved out January 27, 2027" });
    expect(onAccountView().find((p) => p.payment_id === "pay-x")!.remaining).toBe(57.47);
    // January, paid by cheque, goes the walked way too (0169): its $542.53
    // is released, the part month settles from it, and the household holds
    // the $70.00 left of it plus the $57.47 that came back off February.
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled — the $542.53 paid on it is on account — " +
      "and raised again for the 27 of 31 days they were here — $472.53, all of it settled from that money. " +
      "Their February 2027 agreement was withdrawn too — their February 2027 bill of $542.53 was cancelled and $57.47 went back on account. " +
      "They still hold $127.47 on account with you.",
    );
    expect(res.signal).not.toMatch(/nothing bills for it|theirs to have back/);
  });

  it("the close-out cascade over a directly-paid February cancels it and says the money is on account — and the part month settles from it", async () => {
    // February was raised early on the successor and paid by cheque on the
    // 2nd; the office records the 27 January move-out on 3 February. The
    // cascade releases February's $542.53 (0169) BEFORE the final month is
    // re-done, so the January part month is settled from it — and the
    // toast says so without crediting January's own payment, which there
    // was none of.
    clock.today = "2027-02-03";
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "active", agreement_seq: 2 }));
    db.park_charges.push(janBill());
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payments.push({ id: "pay-f", park_id: "park-1", renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-feb", method: "check", received_on: "2027-02-02", reversed_at: null, returned_at: null });
    recompute("chg-feb");
    const res = await endTenancy("feb", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "void", paid_total: 0, void_reason: "Withdrawn — moved out January 27, 2027" });
    expect(db.park_payments[0]).toMatchObject({ id: "pay-f", charge_id: "chg-feb", reversed_at: null });
    const jan = db.park_charges.filter((c) => c.period_month === "2027-01" && c.status !== "void");
    expect(jan[0]).toMatchObject({ amount: 472.53, paid_total: 472.53, status: "paid" });
    expect(onAccountView()).toEqual([expect.objectContaining({ payment_id: "pay-f", remaining: 70, released_from_month: "2027-02" })]);
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled and " +
      "raised again for the 27 of 31 days they were here — $472.53, $472.53 of it settled from money on account. " +
      "Their February 2027 agreement was withdrawn too — their February 2027 bill of $542.53 was cancelled — the $542.53 paid on it went on their account. " +
      "They still hold $70.00 on account with you.",
    );
    expect(res.signal).not.toMatch(/from that money|taken against it|disappear/);
    // PAST TENSE: the withdrawal ran BEFORE the final month was re-done and
    // $472.53 of the released money settled the part month, so "is on
    // account for them now" beside "They still hold $70.00" was a toast
    // contradicting itself. What they hold is the held sentence's alone.
    expect(res.signal).not.toMatch(/is on account for them now/);
    // The order: February's void (releasing the money) before January's.
    const voids = writes.filter((w) => w.op === "update" && w.patch.status === "void").map((w) => w.matched[0]);
    expect(voids).toEqual(["chg-feb", "chg-jan"]);
  });

  it("a month after the last day's, raised early and paid, is cancelled with nothing to raise again — and the sentence still says where the money went", async () => {
    // February raised by hand on the January link and paid; they left on
    // 27 January. No days of February to bill; the released $542.53 is on
    // account and the toast must say so — 'they weren't here for any of
    // it' alone would leave $542.53 unmentioned.
    db.park_charges.push(janBill({ id: "chg-feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payments.push({ id: "pay-f", park_id: "park-1", renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-feb", method: "check", received_on: "2027-01-20", reversed_at: null, returned_at: null });
    recompute("chg-feb");
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. February 2027's $542.53 bill was cancelled — they weren't here for any of it, and the $542.53 paid on it is on account. " +
      "They still hold $542.53 on account with you.",
    );
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "void", paid_total: 0 });
    expect(liveCharges()).toEqual([]);
  });

  it("'Withdraw the next agreement' cancels the successor's unpaid bill first, and the sentence is the server's", async () => {
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }));
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    clock.today = "2027-01-28";
    const res = await endTenancy("feb", "cancelled");
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "void", void_reason: "Agreement withdrawn on January 28, 2027" });
    expect(res.signal).toBe("Reservation cancelled. Their February 2027 bill of $542.53 was cancelled.");
    // The bill is voided BEFORE the link is cancelled.
    const ops = writes.map((w) => `${w.op}:${JSON.stringify(w.patch.status ?? "")}`);
    expect(ops.indexOf('update:"void"')).toBeLessThan(ops.indexOf('update:"cancelled"'));
  });

  it("withdrawing a successor whose bill was paid directly cancels it and says the money is on account", async () => {
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }));
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payments.push({ id: "pay-f", park_id: "park-1", renter_id: "file-9", amount: 100, kind: "rent", charge_id: "chg-feb", method: "cash", received_on: "2027-01-28", reversed_at: null, returned_at: null });
    recompute("chg-feb");
    clock.today = "2027-01-28";
    const res = await endTenancy("feb", "cancelled");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe("Reservation cancelled. Their February 2027 bill of $542.53 was cancelled — the $100.00 paid on it went on their account.");
    expect(res.signal).not.toMatch(/taken against it|disappear|sort that payment/i);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "void", paid_total: 0, void_reason: "Agreement withdrawn on January 28, 2027" });
    expect(db.park_payments[0]).toMatchObject({ charge_id: "chg-feb", reversed_at: null });
    expect(onAccountView()).toEqual([expect.objectContaining({ payment_id: "pay-f", remaining: 100, released_from_month: "2027-02" })]);
  });

  // THE THREE FIGURES (0169 + 0142). "The $300.00 paid on it" named the
  // view's remainder as the amount paid when $400.00 was paid by card and
  // $100.00 had already gone back to it — the office would go looking for
  // a $300.00 payment that never existed. With a refunded part each door
  // says what was paid, what went back, and what is on account; with none,
  // the plain sentence above is unchanged (pinned there).
  it("withdrawing a successor whose card payment was part-refunded names all three figures — paid, refunded, and what went on account", async () => {
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }));
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payments.push({ id: "pay-f", park_id: "park-1", renter_id: "file-9", amount: 400, kind: "rent", charge_id: "chg-feb", method: "card", reference: "ch_1", received_on: "2027-01-28", reversed_at: null, returned_at: null });
    db.park_refunds.push({ id: "rf-1", park_id: "park-1", payment_id: "pay-f", amount: 100, fee_amount: 0 });
    recompute("chg-feb");
    expect(db.park_charges[0]).toMatchObject({ paid_total: 300, status: "open" });
    clock.today = "2027-01-28";
    const res = await endTenancy("feb", "cancelled");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "Reservation cancelled. Their February 2027 bill of $542.53 was cancelled — of the $400.00 paid on it, $100.00 was already refunded and the other $300.00 went on their account.",
    );
    expect(res.signal).not.toMatch(/the \$300\.00 paid on it/);
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "void", paid_total: 0 });
    expect(onAccountView()).toEqual([expect.objectContaining({ payment_id: "pay-f", amount: 400, refunded: 100, remaining: 300, released_from_month: "2027-02" })]);
  });

  // THE FIGURE THE VIEW COULDN'T GIVE (0169). The void releases the money;
  // the view (park_on_account_payments) is what says how much. When that
  // read fails the money IS on account all the same, so each door says so
  // as a failed read — never "$0.00", never silence about $542.53. These
  // pin the two doors' sentences verbatim: collapse either branch to the
  // `released > 0` shape and the toast goes quiet about money that exists.
  it("move-out over a directly-paid January whose released figure couldn't be read says so — and the part month still settles from it", async () => {
    db.park_charges.push(janBill());
    db.park_payments.push({ id: "pay-c", park_id: "park-1", renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-jan", method: "check", received_on: "2027-01-05", reversed_at: null, returned_at: null });
    recompute("chg-jan");
    failNext.select = "park_on_account_payments";
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    // The flag was consumed: the view WAS read, and it was that read that failed.
    expect(failNext.select).toBeUndefined();
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled — " +
      "what was paid on it is on account, though the figure couldn't be read — check \"Money not against a bill\" — " +
      "and raised again for the 27 of 31 days they were here — $472.53, all of it settled from that money. " +
      "They still hold $70.00 on account with you.",
    );
    expect(res.signal).not.toMatch(/\$0\.00/);
    expect(db.park_charges.find((c) => c.id === "chg-jan")).toMatchObject({ status: "void", paid_total: 0 });
    const now = liveCharges();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ amount: 472.53, paid_total: 472.53, status: "paid" });
    expect(db.park_payments[0]).toMatchObject({ charge_id: "chg-jan", reversed_at: null });
  });

  it("withdrawing a directly-paid successor whose released figure couldn't be read says so — never '$0.00', never nothing", async () => {
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }));
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payments.push({ id: "pay-f", park_id: "park-1", renter_id: "file-9", amount: 542.53, kind: "rent", charge_id: "chg-feb", method: "check", received_on: "2027-01-28", reversed_at: null, returned_at: null });
    recompute("chg-feb");
    clock.today = "2027-01-28";
    failNext.select = "park_on_account_payments";
    const res = await endTenancy("feb", "cancelled");
    expect(res.ok, res.error).toBe(true);
    expect(failNext.select).toBeUndefined();
    expect(res.signal).toBe(
      "Reservation cancelled. Their February 2027 bill of $542.53 was cancelled — " +
      "what was paid on it went on their account, though the figure couldn't be read; check \"Money not against a bill\".",
    );
    expect(res.signal).not.toMatch(/\$0\.00/);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "void", paid_total: 0, void_reason: "Agreement withdrawn on January 28, 2027" });
    expect(db.park_payments[0]).toMatchObject({ charge_id: "chg-feb", reversed_at: null });
    // The money is there for the view to show once it reads again.
    expect(onAccountView()).toEqual([expect.objectContaining({ payment_id: "pay-f", remaining: 542.53, released_from_month: "2027-02" })]);
  });

  it("…and with BOTH kinds of money on it, the line comes off first and the sentence carries both", async () => {
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }));
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payments.push({ id: "pay-x", park_id: "park-1", renter_id: "file-9", amount: 57.47, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: null });
    db.park_payment_allocations.push({ id: "al-feb", park_id: "park-1", payment_id: "pay-x", charge_id: "chg-feb", amount: 57.47, removed_at: null, applied_via: "run" });
    db.park_payments.push({ id: "pay-f", park_id: "park-1", renter_id: "file-9", amount: 485.06, kind: "rent", charge_id: "chg-feb", method: "check", received_on: "2027-01-28", reversed_at: null, returned_at: null });
    recompute("chg-feb");
    expect(db.park_charges[0]).toMatchObject({ paid_total: 542.53, status: "paid" });
    clock.today = "2027-01-28";
    const res = await endTenancy("feb", "cancelled");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "Reservation cancelled. Their February 2027 bill of $542.53 was cancelled — the $485.06 paid on it went on their account and $57.47 went back on account.",
    );
    expect(db.park_payment_allocations[0]).toMatchObject({ removed_reason: "Agreement withdrawn on January 28, 2027" });
    expect(onAccountView().map((v) => [v.payment_id, v.remaining])).toEqual([["pay-x", 57.47], ["pay-f", 485.06]]);
  });

  it("a live line the door could not take off still refuses the void — by the database's name — and nothing is withdrawn", async () => {
    // The unapply fails (the fake's next update), the line stands, and the
    // void is refused by 0169's guard rather than skipped on paid_total.
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }));
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payments.push({ id: "pay-x", park_id: "park-1", renter_id: "file-9", amount: 57.47, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: null });
    db.park_payment_allocations.push({ id: "al-feb", park_id: "park-1", payment_id: "pay-x", charge_id: "chg-feb", amount: 57.47, removed_at: null, applied_via: "run" });
    recompute("chg-feb");
    failNext.update = true;
    const res = await endTenancy("feb", "cancelled");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Couldn't take \$57\.47 off their February 2027 bill \(/);
    // The roll has no "take it off the bill" control, so the door is named.
    expect(res.error).toMatch(/Nothing was withdrawn — sort the bill out from the rent screen, then withdraw it again\.$/);
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("approved");
    expect(db.park_charges[0].status).toBe("open");
  });

  it("the database's own refusal reaches the withdraw toast — a line that lands between the take-off and the void is named, not 'couldn't be cancelled.'", async () => {
    // The race 0169's guard exists for: the successor's February bill is
    // clean when the door reads it, a $100 line from money on account
    // lands before the void, and the guard refuses by name. voidCharge
    // printed that sentence; this door printed "couldn't be cancelled."
    // with neither the reason nor a door.
    db.lot_reservations.push(link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }));
    db.park_charges.push(janBill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payments.push({ id: "pay-x", park_id: "park-1", renter_id: "file-9", amount: 100, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: null });
    clock.today = "2027-01-28";
    const line = () => db.park_payment_allocations.push({ id: "al-late", park_id: "park-1", payment_id: "pay-x", charge_id: "chg-feb", amount: 100, removed_at: null, applied_via: "run" });
    const orig = (Q.prototype as unknown as { run: () => unknown }).run;
    /** Land the line on the Nth park_charges read (after the door's own standing read), or on the void's write itself. */
    const landOn = (when: { select: number } | "update") => {
      let seen = 0;
      (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
        const q = this as unknown as { t: string; op: string };
        if (q.t === "park_charges" && db.park_payment_allocations.length === 0) {
          if (when === "update" ? q.op === "update" : q.op === "select" && ++seen === when.select) line();
        }
        return orig.call(this);
      };
    };
    try {
      // Between the door's read of what is on the bill and the void's own:
      // the void is not attempted (skipped), and the line is what stands
      // in the way.
      landOn({ select: 2 });
      const res = await endTenancy("feb", "cancelled");
      expect(res.ok).toBe(false);
      expect(res.error).toBe(
        "Their February 2027 bill of $542.53 couldn't be cancelled — a line from money on account is still against it, and it has to come off the bill first (with a reason). " +
        "Nothing was withdrawn — sort the bill out from the rent screen, then withdraw it again.",
      );
      expect(res.error).not.toMatch(/park_charges:|couldn't be cancelled\. /);
      expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("approved");
      expect(db.park_charges[0].status).toBe("open");
      // Between the void's own read and its write: the database refuses by
      // name (0169), and its sentence is the toast's.
      db.park_payment_allocations = [];
      landOn("update");
      const refused = await endTenancy("feb", "cancelled");
      expect(refused.ok).toBe(false);
      expect(refused.error).toBe(
        "Their February 2027 bill of $542.53 couldn't be cancelled — 100.00 of money on account is against this bill — take it off the bill first (with a reason), then cancel it. " +
        "Nothing was withdrawn — sort the bill out from the rent screen, then withdraw it again.",
      );
      expect(refused.error).not.toMatch(/park_charges:/);
    } finally {
      (Q.prototype as unknown as { run: () => unknown }).run = orig;
    }
    // And a plain write failure carries the database's words too.
    db.park_payment_allocations = [];
    failNext.update = true;
    const plain = await endTenancy("feb", "cancelled");
    expect(plain.ok).toBe(false);
    expect(plain.error).toBe(
      "Their February 2027 bill of $542.53 couldn't be cancelled — boom. Nothing was withdrawn — sort the bill out from the rent screen, then withdraw it again.",
    );
  });

  it("a failed cancel of the final month's bill is SAID — never a toast that claims it bills for the days", async () => {
    db.park_charges.push(janBill());
    // The trim lands; the next update — the void — fails.
    const orig = (Q.prototype as unknown as { run: () => unknown }).run;
    (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
      const out = orig.call(this);
      if (writes.length === 1 && !failNext.update) failNext.update = true;
      return out;
    };
    const res = await endTenancy("jan", "ended", "2027-01-27");
    (Q.prototype as unknown as { run: () => unknown }).run = orig;
    expect(res.ok, res.error).toBe(true);
    // WHY, in the database's words — "is still open — cancel it" said
    // neither the reason nor which of three things happened.
    expect(res.signal).toContain("⚠️ January 2027's $542.53 bill for the whole month is still open — boom. Cancel it from the rent screen, then bill January 2027 again.");
    expect(res.signal).not.toMatch(/final month bills for the days/);
    expect(db.park_charges[0].status).toBe("open");
  });

  it("…and a line that lands on the final month's bill before its void names the line, and the database's refusal names itself", async () => {
    db.park_charges.push(janBill());
    db.park_payments.push({ id: "pay-x", park_id: "park-1", renter_id: "file-9", amount: 100, kind: "rent", charge_id: null, received_on: "2027-01-05", reversed_at: null, returned_at: null });
    const line = () => db.park_payment_allocations.push({ id: "al-late", park_id: "park-1", payment_id: "pay-x", charge_id: "chg-jan", amount: 100, removed_at: null, applied_via: "run" });
    const orig = (Q.prototype as unknown as { run: () => unknown }).run;
    const landOn = (when: { select: number } | "update") => {
      let seen = 0;
      (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
        const q = this as unknown as { t: string; op: string };
        if (q.t === "park_charges" && db.park_payment_allocations.length === 0) {
          if (when === "update" ? q.op === "update" : q.op === "select" && ++seen === when.select) line();
        }
        return orig.call(this);
      };
    };
    try {
      // After the door's standing read (1), on the void's own (2): skipped.
      landOn({ select: 2 });
      const skipped = await endTenancy("jan", "ended", "2027-01-27");
      expect(skipped.ok, skipped.error).toBe(true);
      expect(skipped.signal).toContain(
        "⚠️ January 2027's $542.53 bill for the whole month is still open — a line from money on account is still against it, and it has to come off the bill first (with a reason). Cancel it from the rent screen, then bill January 2027 again.",
      );
      // On the write: refused by the guard, in its words.
      db.park_payment_allocations = [];
      db.lot_reservations = [link({ id: "jan", during: "[2027-01-01,2027-02-01)", status: "active", agreement_seq: 1 })];
      landOn("update");
      const refused = await endTenancy("jan", "ended", "2027-01-27");
      expect(refused.ok, refused.error).toBe(true);
      expect(refused.signal).toContain(
        "⚠️ January 2027's $542.53 bill for the whole month is still open — 100.00 of money on account is against this bill — take it off the bill first (with a reason), then cancel it. Cancel it from the rent screen, then bill January 2027 again.",
      );
      expect(refused.signal).not.toMatch(/park_charges:/);
    } finally {
      (Q.prototype as unknown as { run: () => unknown }).run = orig;
    }
    expect(db.park_charges[0].status).toBe("open");
  });

  it("a deposit still held is named on the way out", async () => {
    db.park_payments.push({ id: "dep", park_id: "park-1", renter_id: "file-9", amount: 500, kind: "deposit", charge_id: null, received_on: "2026-12-20", reversed_at: null, returned_at: null, returned_on: null });
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok).toBe(true);
    expect(res.signal).toMatch(/They still hold a \$500\.00 deposit with you\.$/);
  });
});

// ---------------------------------------------------------------------------
// A HOUSEHOLD FILED BY HAND FOR 1 JANUARY could not be corrected or taken off
// until it started: every control was gated on the current link or on
// `nextIsRenewal`, while editTenancy and endTenancy('cancelled') both
// accepted the row. The page now derives a SEPARATE flag for it.
// ---------------------------------------------------------------------------
describe("the roll offers Edit and 'Filed by mistake' for a first agreement the office filed ahead of its day", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const page = strip(readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8"));
  const roll = strip(readFileSync(fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)), "utf8"));

  it("finds the rule it is scanning — and nextIsRenewal is untouched", () => {
    expect(page).toMatch(/const filedByHand = /);
    expect(page).toMatch(/filedByHandId: filedByHand\?\.id \?\? null/);
    expect(page).toMatch(/const nextIsRenewal = !!r\.next && \(r\.current == null \? r\.next\.origin === "office" : r\.next\.renterId === r\.current\.renterId\);/);
  });

  it("the rule, run on all four shapes: office-filed yes; approved applicant, grandfathered holdover, office successor no", () => {
    const rule = page.match(/const filedByHand = ([^;]+);/)?.[1] ?? "";
    const evaluate = new Function("r", `return ${rule};`) as (r: unknown) => unknown;
    const officeFiled = { current: null, next: { id: "hand", renterId: "f", origin: "application", decidedAt: null } };
    const applicant = { current: null, next: { id: "app", renterId: "f", origin: "application", decidedAt: "2026-12-01T00:00:00Z" } };
    const holdover = { current: null, next: { id: "hold", renterId: "f", origin: "grandfathered", decidedAt: null } };
    const successor = { current: null, next: { id: "feb", renterId: "f", origin: "office", decidedAt: null } };
    const running = { current: { id: "jan" }, next: { id: "hand", renterId: "f", origin: "application", decidedAt: null } };
    expect(evaluate(officeFiled)).toEqual(officeFiled.next);
    expect(evaluate(applicant)).toBeNull();
    expect(evaluate(holdover)).toBeNull();
    expect(evaluate(successor)).toBeNull();
    // Behind a current link it is not this flag's shape: Edit is on current.
    expect(evaluate(running)).toBeNull();
    expect(evaluate({ current: null, next: null })).toBeNull();
  });

  it("Edit is gated on the server's editReservationId; Move out stays on the lot, Gave notice on current", () => {
    // `onLot` is the current link, else the lapsed one — a household whose
    // paperwork ran out is still there (park-helpers RollRow.lapsed). Never
    // the hand-filed row for Move out: nobody has lived in it.
    //
    // EDIT IS WIDER THAN `onLot`, and the widening is the server's: the page
    // picks ONE id (editable → editReservationId) covering the hand-filed row
    // and an undecided successor standing alone. Move out is still keyed on
    // `onLot` alone, which is what the slice below pins.
    expect(roll).toMatch(/const onLot = r\.currentReservationId \?\? r\.lapsedReservationId;/);
    expect(roll).toMatch(/\{r\.editReservationId && \(/);
    const moveOut = roll.slice(roll.indexOf('"Move out"') - 500, roll.indexOf('"Move out"'));
    expect(moveOut).toMatch(/\{onLot && \(/);
    expect(moveOut).not.toMatch(/filedByHandId/);
    const notice = roll.slice(roll.indexOf('"Gave notice"') - 600, roll.indexOf('"Gave notice"'));
    expect(notice).toMatch(/r\.currentReservationId && !r\.expectedMoveOut/);
  });

  it("'Filed by mistake — take them off' is the cancelled branch, with its own toast — never the withdraw control's words", () => {
    const takeOff = roll.slice(roll.indexOf("function takeOff("), roll.indexOf("function unnotice("));
    expect(takeOff, "takeOff() is gone — this scan measures nothing").not.toBe("");
    expect(takeOff).toMatch(/endTenancy\(id, "cancelled"\)/);
    expect(takeOff).not.toMatch(/"ended"/);
    expect(takeOff).toMatch(/is open again on Who lives here/);
    expect(takeOff).not.toMatch(/next agreement/);
    // THE FIRST SENTENCE IS THE SERVER'S — a row filed ahead can already be
    // billed (a typed ?month= raises January in December), and the cancelled
    // branch's signal is where 'Their January 2027 bill of $542.53 was
    // cancelled' lives. A client-authored 'Taken off —' dropped it.
    expect(takeOff).toMatch(/toast\.ok\(`\$\{res\.signal \?\? "Taken off\."\} Lot \$\{lotNumber\} is open again on Who lives here\.`\)/);
    expect(takeOff).not.toMatch(/`Taken off — lot/);
    // And the confirm does not claim 'Nothing has billed' — it cannot know.
    expect(roll).toMatch(/off lot \{r\.lotNumber\}\? If it&apos;s already billed, that bill is cancelled; the lot opens again on Who lives here\./);
    expect(roll).not.toMatch(/Nothing has billed/);
    expect(roll).toMatch(/Filed by mistake — take them off/);
    // Offered only when nothing is current — a running household is not "filed by mistake".
    expect(roll).toMatch(/r\.filedByHandId && !r\.currentReservationId && \(/);
  });

  it("the notice is read from whichever held link carries it, and 'They're staying' clears THAT link — the sibling doorway of the resident's screen", () => {
    expect(page).toMatch(/expectedMoveOut: r\.noticed\?\.expectedMoveOut \?\? null/);
    expect(page).toMatch(/noticeReservationId: r\.noticed\?\.id \?\? null/);
    expect(page).not.toMatch(/expectedMoveOut: r\.current\?\.expectedMoveOut/);
    const staying = roll.slice(roll.indexOf("They&apos;re staying") - 700, roll.indexOf("They&apos;re staying"));
    expect(staying, "the 'They're staying' control is gone — this scan measures nothing").not.toBe("");
    expect(staying).toMatch(/unnotice\(\(r\.noticeReservationId \?\? r\.currentReservationId\)!\)/);
    expect(staying).not.toMatch(/unnotice\(r\.currentReservationId!\)/);
  });

  it("the Edit panel's fields come from the stay it edits", () => {
    expect(page).toMatch(/const onLot = r\.current \?\? r\.lapsed;/);
    expect(page).toMatch(/const editable = onLot \?\? filedByHand \?\? \(r\.next\?\.decidedAt == null \? r\.next : null\);/);
    expect(page).toMatch(/currentRent: editable\?\.quotedAmount \?\? null/);
    expect(page).toMatch(/currentTerm: editable\?\.term \?\? null/);
    // The occupancy fields stay on `current` alone.
    expect(page).toMatch(/currentReservationId: r\.current\?\.id \?\? null/);
    expect(page).toMatch(/currentRenter: r\.current \? /);
  });
});

// ---------------------------------------------------------------------------
// EVERY FIXED-LENGTH LEASE READ "month-to-month". The page now asks
// agreementSpan, which the roll renders; this pins the assembly.
// ---------------------------------------------------------------------------
describe("the roll names the agreement, not 'month-to-month', for a lease with an end", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const page = strip(readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8"));
  const roll = strip(readFileSync(fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)), "utf8"));

  it("the page asks the one helper, with the park's cap, and passes both answers", () => {
    expect(page).toMatch(/const span = agreementSpan\(/);
    expect(page).toMatch(/max_agreement_months as number \| null\) \?\? null,\s*\);/);
    expect(page).toMatch(/rolling: span\.rolling,/);
    expect(page).toMatch(/agreementWords: span\.words,/);
    expect(page).not.toMatch(/rolling: !!r\.current && r\.current\.term !== "nightly"/);
  });

  it("the roll renders the words before falling back to 'through' — and the fallback is a day in words, with its year", () => {
    expect(roll).toMatch(/r\.rolling\s*\?\s*" · month-to-month"\s*:\s*r\.agreementWords\s*\?\s*` · \$\{r\.agreementWords\}`/);
    // agreementSpan says nothing for a span under a month, and the row fell
    // back to pretty(), which drops the year ('Apr 1').
    expect(roll).toMatch(/` · through \$\{r\.currentUntil \? dayInWords\(r\.currentUntil\) : "—"\}`/);
    expect(roll).not.toMatch(/through \$\{pretty\(r\.currentUntil\)\}/);
    // The same guard, widened: every single day a person reads on the roll
    // carries its year. pretty() is left to the two ends of an application's
    // range alone.
    expect(roll).toMatch(/arrives \{r\.nextFrom \? dayInWords\(r\.nextFrom\) : "—"\}/);
    expect(roll).toMatch(/Leaving \{dayInWords\(r\.expectedMoveOut\)\}/);
    expect(roll.match(/pretty\(/g)).toHaveLength(3);
  });

  it("the signing form no longer defers a December signing to 1 January", () => {
    expect(roll).not.toMatch(/recordableFrom/);
    expect(roll).not.toMatch(/can be recorded from/);
    expect(page).not.toMatch(/recordableFrom/);
  });
});

// ---------------------------------------------------------------------------
// A SIGNING RECORDED AHEAD OF ITS DAY leaves the holdover `current` (trimmed
// to end on the lease day, grandfathered, covering today) with the signed
// successor as `next`. Judged on origin alone the row kept offering 'They
// signed the new lease' for twelve days — and a second tap got 'that's after
// it, so there's nothing to carry on from' about a household who had signed.
// ---------------------------------------------------------------------------
describe("the roll offers no signing control once the household's own signing stands behind the holdover", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const page = strip(readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8"));
  const roll = strip(readFileSync(fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)), "utf8"));
  const rule = page.match(/const signedAhead = ([^;]+);/)?.[1] ?? "";
  const gate = page.match(/const holdover = ([^;]+);/)?.[1] ?? "";

  it("finds the rule it is scanning", () => {
    expect(rule, "signedAhead is gone — this scan measures nothing").not.toBe("");
    // The second half is the holdover whose paperwork RAN OUT (RollRow.lapsed,
    // set only when nothing is current or next) — Today's "haven't signed"
    // card sends him to this control for exactly that row.
    expect(gate).toBe('(slipFor?.origin === "grandfathered" && !signedAhead ? slipFor : null) ?? (r.lapsed?.origin === "grandfathered" ? r.lapsed : null)');
  });

  it("the rule, run: a holdover alone → the control; a holdover with its OWN successor recorded → none; a different household's next → the control; before go-live → the control", () => {
    const evaluate = new Function("r", "slipFor", `const signedAhead = ${rule}; return ${gate};`) as (r: unknown, slipFor: unknown) => unknown;
    const hold = { id: "hold", renterId: "f", origin: "grandfathered", range: { start: "2026-12-20", end: "2027-01-01" } };
    const succ = { id: "succ", renterId: "f", origin: "office", range: { start: "2027-01-01", end: "2027-04-01" } };
    const stranger = { id: "x", renterId: "g", origin: "application", range: { start: "2027-02-01", end: "2027-03-01" } };
    // 20 December, the signing recorded: holdover current, successor next.
    expect(evaluate({ current: hold, next: succ }, hold)).toBeNull();
    // The same holdover with nothing behind it.
    expect(evaluate({ current: hold, next: null }, hold)).toBe(hold);
    // Somebody else's agreement behind it is not this household's signing.
    expect(evaluate({ current: hold, next: stranger }, hold)).toBe(hold);
    // Before go-live: nothing current, the imported holdover is `next` and
    // the stay the row is about.
    const imported = { id: "imp", renterId: "f", origin: "grandfathered", range: { start: "2027-01-01", end: "2028-01-01" } };
    expect(evaluate({ current: null, next: imported }, imported)).toBe(imported);
    // A signed lease running today with a renewal behind it is not a holdover at all.
    const lease = { id: "jan", renterId: "f", origin: "office", range: { start: "2027-01-01", end: "2027-02-01" } };
    expect(evaluate({ current: lease, next: succ }, lease)).toBeNull();
    // A holdover that RAN OUT — nothing current, nothing next, the lapsed
    // row grandfathered: the control, so the signing can be recorded from
    // the arrangement's end. A lapsed OFFICE lease gets nothing here (its
    // door is Today's Agreements-to-write list).
    const lapsedHold = { id: "imp", renterId: "f", origin: "grandfathered", range: { start: "2027-01-01", end: "2027-06-01" } };
    expect(evaluate({ current: null, next: null, lapsed: lapsedHold }, null)).toBe(lapsedHold);
    expect(evaluate({ current: null, next: null, lapsed: lease }, null)).toBeNull();
    expect(evaluate({ current: null, next: null, lapsed: null }, null)).toBeNull();
  });

  it("the same shape gets the withdrawal — and the confirm says what withdrawing the signing leaves behind", () => {
    // The successor IS this household's next link, so 'Withdraw the next
    // agreement' is offered; withdrawing it cancels the successor and
    // nothing restores the trimmed holdover's horizon — the lot reads open
    // from the lease day. The page passes that day; the confirm prints it.
    expect(page).toMatch(/withdrawUncoversFrom: signedAhead \? r\.current!\.range\?\.end \?\? null : null,/);
    const confirm = roll.slice(roll.indexOf("Withdraw their {r.nextFrom"), roll.indexOf("Withdraw the next agreement"));
    expect(confirm, "the withdraw confirm is gone — this scan measures nothing").not.toBe("");
    expect(confirm).toMatch(/r\.withdrawUncoversFrom && \(/);
    expect(confirm).toMatch(/The arrangement they had still ends on \{dayInWords\(r\.withdrawUncoversFrom\)\} — record the signing again from this row, or the lot reads open from that day\./);
  });
});

// ---------------------------------------------------------------------------
// THE CASCADE'S FAILURE PATHS carry the final month's sentence too. Both used
// to return before finalMonthBill ran, leaving January's whole-month bill
// standing and unmentioned under a panel promising the close-out re-does it.
// ---------------------------------------------------------------------------
describe("a close-out whose cascade fails still re-does the final month's bill, and says so", () => {
  const link = (over: Row): Row => ({
    park_lot_id: "lot-9", renter_id: "file-9", agreement_chain_id: "chain-9",
    moved_out_on: null, term: "monthly", quoted_amount: 400, origin: "office", due_day: null, ...over,
  });
  const bill = (over: Row = {}): Row => ({
    id: "chg-jan", park_id: "park-1", park_lot_id: "lot-9", reservation_id: "jan", renter_id: "file-9",
    period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "open",
    lines: [{ label: "Lot rent", amount: 400, basis: "for the month" }, { label: "Grounds", amount: 142.53, basis: "for the month" }],
    ...over,
  });
  /** Fail the Nth update after the trim (1 = the very next one) — once. */
  async function failingUpdate<T>(nthAfterTrim: number, run: () => Promise<T>): Promise<T> {
    const orig = (Q.prototype as unknown as { run: () => unknown }).run;
    let armed = false;
    (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
      const out = orig.call(this);
      if (writes.length === nthAfterTrim && !armed) { armed = true; failNext.update = true; }
      return out;
    };
    try { return await run(); } finally { (Q.prototype as unknown as { run: () => unknown }).run = orig; }
  }

  beforeEach(() => {
    db.park_members = [{ park_id: "park-1", user_id: "user-owner", role: "owner" }];
    db.park_lots = [{ id: "lot-9", park_id: "park-1", lot_number: "9", rental_mode: "long_term", lifecycle: "live" }];
    db.parks = [{ id: "park-1", rent_due_day: 1, cutover_date: "2027-01-01", max_agreement_months: 6, default_agreement_months: 1 }];
    db.park_fees = [{ park_id: "park-1", active: true, label: "Grounds", amount: 142.53, cadence: "monthly", applies_to: "long_term" }];
    db.park_renters = [{ id: "file-9", park_id: "park-1", display_name: "Household 9" }];
    db.park_charges = []; db.park_payments = []; db.park_payment_allocations = []; db.lot_cost_shares = [];
    db.lot_reservations = [
      link({ id: "jan", during: "[2027-01-01,2027-02-01)", status: "active", agreement_seq: 1 }),
      link({ id: "feb", during: "[2027-02-01,2027-05-01)", status: "approved", agreement_seq: 2 }),
    ];
    writes.length = 0;
    delete failNext.update;
    clock.today = "2027-01-28";
  });

  it("the successor's bill cannot be cancelled: January is still re-rated and the sentence carries both", async () => {
    db.park_charges.push(bill());
    db.park_charges.push(bill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    // The trim lands; the next update — the void of February's bill — fails.
    const res = await failingUpdate(1, () => endTenancy("jan", "ended", "2027-01-27"));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled and " +
      "raised again for the 27 of 31 days they were here — $472.53. But their next agreement couldn't be withdrawn: " +
      "Their February 2027 bill of $542.53 couldn't be cancelled — boom. It still stands and still bills; " +
      "sort the bill out from the rent screen, then withdraw it from their row on the roll.",
    );
    // January's bill WAS re-done — not left whole under a sentence about February.
    expect(db.park_charges.find((c) => c.id === "chg-jan")!.status).toBe("void");
    const jan = db.park_charges.filter((c) => c.period_month === "2027-01" && c.status !== "void");
    expect(jan).toHaveLength(1);
    expect(jan[0]).toMatchObject({ amount: 472.53, reservation_id: "jan" });
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "open" });
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("approved");
  });

  it("the link cancel fails AFTER its bill was cancelled: the sentence names the cancelled bill, never 'it already billed'", async () => {
    // They left on 27 January; recorded on 15 March with February lapsed and
    // its unpaid bill still open. The void lands (write 2), the share release
    // (3), then the cancel of the link (4) fails.
    clock.today = "2027-03-15";
    Object.assign(db.lot_reservations.find((r) => r.id === "feb")!, { status: "active", during: "[2027-02-01,2027-03-01)" });
    db.park_charges.push(bill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    const res = await failingUpdate(3, () => endTenancy("jan", "ended", "2027-01-27"));
    expect(res.ok).toBe(false);
    expect(db.park_charges.find((c) => c.id === "chg-feb")).toMatchObject({ status: "void", void_reason: "Withdrawn — moved out January 27, 2027" });
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("active");
    expect(res.error).toBe(
      "Closed out — last day January 27, 2027 — but their next agreement couldn't be withdrawn: " +
      "their February 2027 bill of $542.53 was cancelled, but the agreement itself still stands on their record. " +
      "That's ours to fix — get in touch and we'll sort it.",
    );
    expect(res.error).not.toMatch(/already billed/);
  });

  it("…and for a successor still to come, the cancelled bill is named and the control is still the roll's", async () => {
    db.park_charges.push(bill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    const res = await failingUpdate(3, () => endTenancy("jan", "ended", "2027-01-27"));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Closed out — last day January 27, 2027 — but their next agreement couldn't be withdrawn: " +
      "their February 2027 bill of $542.53 was cancelled, but the agreement itself still stands and the next run bills it again. " +
      "Withdraw it from their row on the roll ('Withdraw the next agreement').",
    );
  });

  it("the final month runs AFTER the cascade on the ordinary path — R1 would otherwise settle the successor's open bill a moment before the cascade tried to cancel it", async () => {
    // $600 on account: January took $542.53 on the 1st, February took the
    // $57.47 left. Move out 27 January, recorded 3 February.
    clock.today = "2027-02-03";
    db.lot_reservations.find((r) => r.id === "feb")!.status = "active";
    db.park_payments.push({ id: "pay-6", park_id: "park-1", renter_id: "file-9", amount: 600, kind: "rent", charge_id: null, received_on: "2026-12-28", reversed_at: null, returned_at: null });
    db.park_charges.push(bill());
    db.park_charges.push(bill({ id: "chg-feb", reservation_id: "feb", period_month: "2027-02", due_on: "2027-02-01" }));
    db.park_payment_allocations.push({ id: "al-jan", park_id: "park-1", payment_id: "pay-6", charge_id: "chg-jan", amount: 542.53, removed_at: null, applied_via: "run" });
    db.park_payment_allocations.push({ id: "al-feb", park_id: "park-1", payment_id: "pay-6", charge_id: "chg-feb", amount: 57.47, removed_at: null, applied_via: "run" });
    recompute("chg-jan"); recompute("chg-feb");
    const res = await endTenancy("jan", "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    // February cancelled and its link withdrawn; January re-raised at $472.53
    // and settled in full; $127.47 left on account — none of it on February.
    expect(db.park_charges.find((c) => c.id === "chg-feb")!.status).toBe("void");
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("cancelled");
    const jan = db.park_charges.filter((c) => c.period_month === "2027-01" && c.status !== "void");
    expect(jan[0]).toMatchObject({ amount: 472.53, paid_total: 472.53, status: "paid" });
    expect(onAccountView()[0].remaining).toBe(127.47);
    expect(db.park_payment_allocations.filter((a) => a.charge_id === "chg-feb" && a.removed_at == null)).toEqual([]);
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. January 2027's $542.53 bill for the whole month was cancelled and " +
      "raised again for the 27 of 31 days they were here — $472.53, $472.53 of it settled from money on account. " +
      "Their February 2027 agreement was withdrawn too — their February 2027 bill of $542.53 was cancelled and $57.47 went back on account. " +
      "They still hold $127.47 on account with you.",
    );
    // The order, from the writes: February's void before January's.
    const voids = writes.filter((w) => w.op === "update" && w.patch.status === "void").map((w) => w.matched[0]);
    expect(voids).toEqual(["chg-feb", "chg-jan"]);
  });

  it("'Gave notice' says the day in words", async () => {
    const { giveNotice } = await import("./actions");
    const res = await giveNotice("jan", "2027-02-15", "2027-01-28");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe("Noted — they plan to leave on February 15, 2027.");
    expect(res.signal).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
