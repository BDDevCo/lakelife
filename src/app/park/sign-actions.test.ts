import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHAT `recordSigning` ACTUALLY WRITES, in order, and what it says when a
 * write fails. The planner is tested in sign-helpers.test.ts; this proves
 * the caller hands the plan to the table as guarded writes, puts the holdover
 * back when the successor cannot land — and, since the January that was
 * billed twice, what it does to the bills already raised on the arrangement
 * they had.
 *
 * An in-memory table with the real filter chain (`eq`, `neq`, `in`, `gte`,
 * `is`, `select`) so the guards are exercised, not mocked away. The two
 * triggers that matter are modelled: a charge's paid_total follows its
 * payments and allocations, and the 0167 view says what is still on account.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Every write, in the order it happened. */
const writes: Array<{ table: string; op: "update" | "insert"; patch: Row; matched: string[] }> = [];
/** Make the next insert / update / read on a table fail. */
const failNext: { insert?: string; update?: { table: string; message: string }; select?: { table: string; message: string } } = {};

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const live = (a: Row) => a.removed_at == null;
const stands = (p: Row | undefined) => !!p && p.reversed_at == null && p.returned_at == null;
function remainingOf(p: Row): number {
  const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && live(a)).reduce((s, a) => s + cents(a.amount), 0);
  return Math.max(0, cents(p.amount) - allocated) / 100;
}
function onAccountView(): Row[] {
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.charge_id == null && stands(p))
    .map((p) => ({
      payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id, amount: p.amount, received_on: p.received_on,
      created_at: p.created_at ?? null, remaining: remainingOf(p),
    }));
}
/** recompute_charge_paid: direct standing rows plus allocations from standing payments. */
function recompute(chargeId: string) {
  const c = (db.park_charges ?? []).find((x) => x.id === chargeId);
  if (!c) return;
  const direct = (db.park_payments ?? []).filter((p) => p.charge_id === chargeId && stands(p)).reduce((s, p) => s + cents(p.amount), 0);
  const applied = (db.park_payment_allocations ?? []).filter((a) => a.charge_id === chargeId && live(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  const paid = (direct + applied) / 100;
  c.paid_total = paid;
  if (c.status !== "void") c.status = paid >= Number(c.amount) ? "paid" : "open";
}

class Q implements PromiseLike<{ data: Row[] | null; error: { code?: string; message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  private op: "select" | "update" | "insert" = "select";
  private ins: Row[] | null = null;
  private sel = "";
  private sort: { c: string; asc: boolean } | null = null;
  private cap: number | null = null;
  constructor(private t: string) {}
  select(cols?: string) { this.sel = cols ?? ""; return this; }
  limit(n: number) { this.cap = n; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  gt(c: string, v: number) { this.fs.push((r) => Number(r[c]) > v); return this; }
  gte(c: string, v: unknown) { this.fs.push((r) => String(r[c]) >= String(v)); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, _op: string, v: unknown) { this.fs.push((r) => !(v === null ? r[c] == null : r[c] === v)); return this; }
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
    if (this.sel.includes("park_lots(")) {
      out = out.map((r) => ({ ...r, park_lots: { park_id: "park-1", rental_mode: "long_term" } }));
    }
    if (this.cap != null) out = out.slice(0, this.cap);
    return out;
  }
  private run(): { data: Row[] | null; error: { code?: string; message: string } | null } {
    if (this.op === "insert") {
      if (failNext.insert) {
        const message = failNext.insert; delete failNext.insert;
        return { data: null, error: { code: message === "overlap" ? "23P01" : "XX", message } };
      }
      const written = this.ins!.map((r) => {
        const w: Row = { id: `${this.t}-${(db[this.t] ??= []).length + 1}`, ...r };
        if (this.t === "park_charges") { if (w.paid_total === undefined) w.paid_total = 0; if (w.status === undefined) w.status = "open"; }
        db[this.t].push(w);
        writes.push({ table: this.t, op: "insert", patch: r, matched: [w.id as string] });
        if (this.t === "park_payment_allocations") recompute(w.charge_id as string);
        return w;
      });
      return { data: written, error: null };
    }
    if (this.op === "update") {
      if (failNext.update && failNext.update.table === this.t) {
        const message = failNext.update.message; delete failNext.update;
        return { data: null, error: { message } };
      }
      const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
      for (const r of hit) Object.assign(r, this.patch);
      if (this.t === "park_payment_allocations") for (const r of hit) recompute(r.charge_id as string);
      writes.push({ table: this.t, op: "update", patch: this.patch!, matched: hit.map((r) => r.id as string) });
      return { data: hit.map((r) => ({ id: r.id, during: r.during })), error: null };
    }
    if (failNext.select && failNext.select.table === this.t) {
      const message = failNext.select.message; delete failNext.select;
      return { data: null, error: { message } };
    }
    return { data: this.rows(), error: null };
  }
  maybeSingle() {
    const r = this.run();
    return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error });
  }
  single() { return this.maybeSingle(); }
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
vi.mock("@/lib/rent-changes", () => ({
  servedRentHistory: async () => ({ byRes: new Map(), error: null }),
}));

const { recordSigning } = await import("./sign-actions");

function seed(during = "[2027-01-01,2028-01-01)") {
  for (const k of Object.keys(db)) delete db[k];
  db.park_members = [{ park_id: "park-1", user_id: USER, role: "owner" }];
  db.parks = [{ id: "park-1", cutover_date: "2027-01-01", default_agreement_months: 1, max_agreement_months: 3, rent_due_day: 1 }];
  db.park_fees = [{ park_id: "park-1", active: true, label: "Grounds", amount: 142.53, cadence: "monthly", applies_to: "long_term" }];
  db.park_lots = [{ id: "lot-14", park_id: "park-1", lot_number: "14", rental_mode: "long_term", lifecycle: "live" }];
  db.park_renters = [{ id: "file-14", park_id: "park-1", display_name: "Doris", email: null, phone_on_file_with_park: null }];
  db.lot_reservations = [{
    id: "res-14", park_lot_id: "lot-14", renter_id: "file-14", renter_unit_id: null,
    during, status: "active", origin: "grandfathered", term: "monthly", quoted_amount: 275,
    agreement_chain_id: "chain-14", agreement_seq: 1, due_day: null, tenancy_began_on: "2015-04-02",
    amount_source: "prior_roll", amount_source_at: null, moved_out_on: null,
  }];
  db.park_charges = []; db.park_payments = []; db.park_payment_allocations = []; db.lot_cost_shares = [];
  writes.length = 0;
  revalidated.length = 0;
  delete failNext.insert; delete failNext.update; delete failNext.select;
  clock.today = "2027-01-01";
}

/** January raised on the holdover — as the 1 January run does at $400. */
function januaryBilled(amount = 400, reservationId = "res-14") {
  db.park_charges.push({
    id: `chg-${reservationId}-jan`, park_id: "park-1", park_lot_id: "lot-14", reservation_id: reservationId, renter_id: "file-14",
    period_month: "2027-01", due_on: "2027-01-01", amount, paid_total: 0, status: "open",
    lines: [{ label: "Lot rent", amount, basis: "for the month" }],
  });
}
const liveCharges = () => db.park_charges.filter((c) => c.status !== "void");
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The form as it opens at The Haven: the one-month house style already picked. */
const INPUT = { signedOn: "2027-01-01", rent: "400", email: "doris@example.com", mobile: "(260) 555-0114", agreementMonths: 1 };

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
    expect(res.signal).toBe("On the new one-month lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees).");
  });

  // THE LENGTH IS THE HOUSEHOLD'S CHOICE — the owner's decision, one, three
  // or six months. This door used to write the house style for everybody.
  it("writes the successor for the length the household chose, and says it back", async () => {
    const res = await recordSigning("park-1", "res-14", { ...INPUT, agreementMonths: 3 });
    expect(res.ok, res.error).toBe(true);
    expect(writes[2].patch).toMatchObject({ during: "[2027-01-01,2027-04-01)", status: "active", origin: "office" });
    expect(res.signal).toBe("On the new 3-month lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees).");
  });

  it("refuses a length the park does not offer, reading the cap from the PARK, and writes nothing", async () => {
    // The Haven today: cap 3, so six is refused. Nothing is assumed about
    // any park's cap — raise this one's to six and the same call files.
    const six = await recordSigning("park-1", "res-14", { ...INPUT, agreementMonths: 6 });
    expect(six.ok).toBe(false);
    expect(six.error).toBe("This park writes agreements of 1 or 3 months — pick one of those.");
    expect(writes).toEqual([]);

    db.parks[0].max_agreement_months = 6;
    const raised = await recordSigning("park-1", "res-14", { ...INPUT, agreementMonths: 6 });
    expect(raised.ok, raised.error).toBe(true);
    expect(writes[2].patch).toMatchObject({ during: "[2027-01-01,2027-07-01)" });
    expect(raised.signal).toMatch(/^On the new 6-month lease from January 1, 2027/);
  });

  it("refuses a form that sends no length — the house style is never filed for them", async () => {
    const res = await recordSigning("park-1", "res-14", { ...INPUT, agreementMonths: null });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Pick how long the agreement runs — 1 or 3 months.");
    expect(writes).toEqual([]);
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

  // ONE RULE FOR BOTH DOORS. "Who lives here" files a lease in his hand on
  // 20 December for 1 January as `approved`; this door refused the same
  // paper with "that hasn't come yet" until 1 January — and the wait put the
  // signing after January's bills.
  it("a lease in his hand on 20 December for 1 January is recorded that day — approved, the holdover trimmed to it", async () => {
    seed("[2026-12-20,2027-12-20)");
    clock.today = "2026-12-20";
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2027-01-01" });
    expect(res.ok, res.error).toBe(true);
    expect(writes[1].patch).toEqual({ during: "[2026-12-20,2027-01-01)" });
    expect(writes[2].patch).toMatchObject({ during: "[2027-01-01,2027-02-01)", status: "approved", origin: "office" });
    expect(res.signal).toBe("On the new one-month lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees).");
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

// ---------------------------------------------------------------------------
// THE MONTH ALREADY BILLED ON THE ARRANGEMENT THEY HAD. January is raised on
// the 1st at $400 on the holdover; the signing is recorded on the 2nd. The
// $400 bill sat on a row that now covers no day of January, and the next run
// raised a second January bill on the successor — one household, $942.53.
// ---------------------------------------------------------------------------
describe("the bills already raised on the arrangement they had", () => {
  it("January billed on the holdover, signed on the 2nd: the $400 bill is cancelled with the reason and January raised again at $542.53 on the new lease — ONE live January bill", async () => {
    januaryBilled();
    clock.today = "2027-01-02";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);

    const old = db.park_charges.find((c) => c.id === "chg-res-14-jan")!;
    expect(old).toMatchObject({ status: "void", void_reason: "Replaced by the new lease from January 1, 2027" });
    expect(old.voided_at).toBeTruthy();
    // The successor's January — the same statement the run would write.
    const succ = db.lot_reservations.find((r) => r.agreement_seq === 2)!;
    const jan = liveCharges();
    expect(jan).toHaveLength(1);
    expect(jan[0]).toMatchObject({ reservation_id: succ.id, period_month: "2027-01", amount: 542.53, due_on: "2027-01-01", status: "open" });
    expect(jan[0].lines).toEqual([
      { label: "Lot rent", amount: 400, basis: "for the month" },
      { label: "Grounds", amount: 142.53, basis: "for the month" },
    ]);
    // Said in the toast, after the plan's own sentence.
    expect(res.signal).toBe(
      "On the new one-month lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees). " +
      "January 2027's $400.00 bill on the old arrangement is cancelled; January 2027 now bills $542.53.",
    );
    // The void came AFTER the successor landed — a failed successor must not
    // leave the month unbilled.
    const order = writes.map((w) => `${w.table}:${w.op}`);
    expect(order.indexOf("lot_reservations:insert")).toBeLessThan(order.indexOf("park_charges:update"));
  });

  it("with no bill raised yet, nothing is cancelled and the toast is the plan's sentence alone", async () => {
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(true);
    expect(res.signal).not.toMatch(/cancelled/);
    expect(db.park_charges).toEqual([]);
    expect(writes.filter((w) => w.table === "park_charges")).toEqual([]);
  });

  it("a lease from the 15th on a holdover from 20 December: January is raised again in BOTH halves — the old arrangement to the 14th, the lease from the 15th", async () => {
    seed("[2026-12-20,2027-12-20)");
    januaryBilled();
    clock.today = "2027-01-16";
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2027-01-15" });
    expect(res.ok, res.error).toBe(true);
    const jan = liveCharges().sort((a, b) => Number(a.amount) - Number(b.amount));
    expect(jan).toHaveLength(2);
    // 14 of 31 days of the $275 they were paying, on the trimmed holdover:
    // its own rent, and no fee on the arrangement they had.
    expect(jan[0]).toMatchObject({ reservation_id: "res-14", amount: 124.19 });
    expect(jan[0].lines).toEqual([{ label: "Lot rent", amount: 124.19, basis: "14 of 31 days" }]);
    // 17 of 31 days of $400 + $142.53 on the successor.
    expect(jan[1]).toMatchObject({ amount: 297.51, due_on: "2027-01-15" });
    expect(jan[1].lines).toEqual([
      { label: "Lot rent", amount: 219.35, basis: "17 of 31 days" },
      { label: "Grounds", amount: 78.16, basis: "17 of 31 days" },
    ]);
    expect(res.signal).toContain(
      "January 2027's $400.00 bill on the old arrangement is cancelled; January 2027 now bills " +
      "$124.19 to January 14, 2027 on the arrangement they had and $297.51 on the new lease.",
    );
  });

  it("money the household holds on account settles the re-raised bill the moment it lands (R1), and the toast says so", async () => {
    januaryBilled();
    db.park_payments.push({ id: "pay-1", park_id: "park-1", renter_id: "file-14", amount: 600, kind: "rent", charge_id: null, received_on: "2026-12-28", reversed_at: null, returned_at: null });
    clock.today = "2027-01-02";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);
    const jan = liveCharges();
    expect(jan).toHaveLength(1);
    expect(jan[0]).toMatchObject({ amount: 542.53, paid_total: 542.53, status: "paid" });
    expect(db.park_payment_allocations).toHaveLength(1);
    expect(db.park_payment_allocations[0]).toMatchObject({ payment_id: "pay-1", charge_id: jan[0].id, amount: 542.53, applied_via: "office" });
    expect(res.signal).toContain("January 2027 now bills $542.53, $542.53 of it settled from money on account.");
  });

  it("a bill with money TAKEN against it refuses the signing before any write — in voidCharge's words, naming the month, never a way out the paper lacks", async () => {
    januaryBilled();
    db.park_payments.push({ id: "pay-1", park_id: "park-1", renter_id: "file-14", amount: 400, kind: "rent", charge_id: "chg-res-14-jan", received_on: "2027-01-02", reversed_at: null, returned_at: null });
    recompute("chg-res-14-jan");
    clock.today = "2027-01-04";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "You've already taken $400.00 against January 2027's bill on the arrangement they had — " +
      "this door doesn't cancel a paid bill. " +
      "Nothing was recorded. Cancel January 2027's bill from the rent screen first (\"Cancel this bill\" on the January 2027 line) — " +
      "the $400.00 goes on their account and the new lease is billed from it — then record the signing.",
    );
    // The door it names is the figure it names: $400.00 is what was taken,
    // not the $542.53 the new lease bills — and "needs sorting out" named
    // no door at all.
    expect(res.error).not.toMatch(/needs sorting out/);
    expect(res.error).not.toMatch(/\$542\.53/);
    // 'or record the new lease from February 1, 2027' dated the paper to a
    // day it does not carry — every new lease runs from 1 January — and made
    // the owner's decision (what a month paid at the old rate owes under a
    // lease effective that month) for him. Neither is offered now — the
    // one door named is the rent screen's, which decides nothing.
    expect(res.error).not.toMatch(/record the new lease from/);
    expect(res.error).not.toMatch(/Sort that payment out/);
    expect(writes).toEqual([]);
    expect(db.lot_reservations).toHaveLength(1);
    expect(db.park_renters[0].email).toBeNull();
    expect(db.park_charges[0].status).toBe("paid");
  });

  it("a bill settled from money on account refuses too, naming the door that takes it off — and a reversed cheque's line is not money on the bill", async () => {
    januaryBilled();
    db.park_payments.push({ id: "pay-1", park_id: "park-1", renter_id: "file-14", amount: 400, kind: "rent", charge_id: null, received_on: "2026-12-28", reversed_at: null, returned_at: null });
    db.park_payment_allocations.push({ id: "al-1", park_id: "park-1", payment_id: "pay-1", charge_id: "chg-res-14-jan", amount: 400, removed_at: null });
    recompute("chg-res-14-jan");
    clock.today = "2027-01-04";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "$400.00 of January 2027's bill on the arrangement they had was settled from money on account " +
      "(under \"Money not against a bill\", \"Take it off this bill\" on the January 2027 line). " +
      "Take that off it first, then record the signing.",
    );
    expect(res.error).not.toMatch(/record the new lease from/);
    expect(writes).toEqual([]);

    // The cheque bounced: its line survives as record but is not money on
    // the bill (0167's recompute), so the signing goes through and voids it.
    db.park_payments[0].reversed_at = "2027-01-03T00:00:00Z";
    recompute("chg-res-14-jan");
    const again = await recordSigning("park-1", "res-14", INPUT);
    expect(again.ok, again.error).toBe(true);
    expect(db.park_charges[0].status).toBe("void");
  });

  it("a bill for a month BEFORE the signing month is left alone — it was theirs", async () => {
    seed("[2026-12-20,2027-12-20)");
    januaryBilled();
    // The December bill on the same holdover, from a park whose ledger
    // started earlier: not this signing's business.
    db.park_charges.push({
      id: "chg-dec", park_id: "park-1", park_lot_id: "lot-14", reservation_id: "res-14", renter_id: "file-14",
      period_month: "2026-12", due_on: "2026-12-20", amount: 155, paid_total: 0, status: "open", lines: [],
    });
    db.parks[0].cutover_date = "2026-12-01";
    clock.today = "2027-01-02";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);
    expect(db.park_charges.find((c) => c.id === "chg-dec")!.status).toBe("open");
    expect(db.park_charges.find((c) => c.id === "chg-res-14-jan")!.status).toBe("void");
  });

  it("a failed cancel is SAID, never swallowed — and the successor stands", async () => {
    januaryBilled();
    clock.today = "2027-01-02";
    // The successor insert lands; the next update — the void — fails.
    failNext.update = { table: "park_charges", message: "boom" };
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toContain(
      "⚠️ January 2027's $400.00 bill on the old arrangement is still open — boom. Cancel it from the rent screen, then bill January 2027 again.",
    );
    expect(db.park_charges[0].status).toBe("open");
    // Nothing was raised on the successor — the live-per-month rule would
    // have been the double bill this exists to end.
    expect(liveCharges()).toHaveLength(1);
    expect(db.lot_reservations).toHaveLength(2);
  });

  it("a cost share on the cancelled bill that no re-raise takes up is SAID — a lease from the holdover's first day cancels the holdover, and its water split has nowhere to bill", async () => {
    januaryBilled();
    db.lot_cost_shares.push({ id: "sh-1", reservation_id: "res-14", cost_id: "c1", amount: 18.5, basis: "b", billed_on_charge_id: "chg-res-14-jan" });
    db.park_costs = [{ id: "c1", park_id: "park-1", category: "water", period_start: "2026-12-01", period_end: "2026-12-31" }];
    clock.today = "2027-01-02";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);
    // The void released it (0104), the holdover is cancelled, the successor
    // has no shares of its own: it is unbilled on a row the run never bills.
    expect(db.lot_cost_shares[0].billed_on_charge_id).toBeNull();
    expect(db.lot_reservations[0].status).toBe("cancelled");
    expect(res.signal).toContain(
      "⚠️ 1 cost share that was on that bill is back on the arrangement they had and won't bill from there — " +
      "remove that bill on the costs screen and split it again.",
    );
  });

  it("…and NOT said when the trimmed holdover's own re-raise takes the share up again", async () => {
    seed("[2026-12-20,2027-12-20)");
    januaryBilled();
    db.lot_cost_shares.push({ id: "sh-1", reservation_id: "res-14", cost_id: "c1", amount: 18.5, basis: "b", billed_on_charge_id: "chg-res-14-jan" });
    db.park_costs = [{ id: "c1", park_id: "park-1", category: "water", period_start: "2026-12-01", period_end: "2026-12-31" }];
    clock.today = "2027-01-16";
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2027-01-15" });
    expect(res.ok, res.error).toBe(true);
    const onHoldover = liveCharges().find((c) => c.reservation_id === "res-14")!;
    expect(db.lot_cost_shares[0].billed_on_charge_id).toBe(onHoldover.id);
    expect(onHoldover.lines).toContainEqual({ label: "Water — your share", amount: 18.5, basis: "for December 1, 2026 to December 31, 2026" });
    expect(res.signal).not.toMatch(/cost share/);
  });

  it("when the month cannot be raised again, the toast says to bill it from the rent screen rather than claiming it bills", async () => {
    januaryBilled();
    clock.today = "2027-01-02";
    // The successor lands, the void lands, then the re-raise's insert fails.
    const origRun = (Q.prototype as unknown as { run: () => unknown }).run;
    let inserts = 0;
    (Q.prototype as unknown as { run: () => unknown }).run = function (this: Q) {
      if ((this as unknown as { op: string }).op === "insert" && ++inserts === 2) failNext.insert = "boom";
      return origRun.call(this);
    };
    const res = await recordSigning("park-1", "res-14", INPUT);
    (Q.prototype as unknown as { run: () => unknown }).run = origRun;
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toContain(
      "January 2027's $400.00 bill on the old arrangement is cancelled, but January 2027 couldn't be billed again on the new lease",
    );
    expect(res.signal).toContain("bill January 2027 from the rent screen.");
    expect(res.signal).not.toMatch(/now bills/);
    expect(liveCharges()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE MONTHS THE RUN HAS PASSED (decision 3, 16 Sep: "it's billed at the new
// rent, if there is any"). A lease recorded after the 1st's run — or after
// the arrangement ran out — writes a row the run has already gone past; the
// run keys "already billed" per reservation and visits a month once, so the
// door bills those months itself, on the new lease.
// ---------------------------------------------------------------------------
describe("the months the run has already passed are billed on the new lease", () => {
  /** The 1 January run at another lot — the month's run has happened. */
  function ranMonth(month: string) {
    db.park_lots.push({ id: "lot-9", park_id: "park-1", lot_number: "9", rental_mode: "long_term", lifecycle: "live" });
    db.park_charges.push({
      id: `chg-9-${month}`, park_id: "park-1", park_lot_id: "lot-9", reservation_id: "res-9", renter_id: "file-9",
      period_month: month, due_on: `${month}-01`, amount: 400, paid_total: 0, status: "open", lines: [],
    });
  }

  it("an arrangement that RAN OUT: the successor is written from its end, the holdover is left as it is, and the month since is billed on the lease", async () => {
    // Lapsed 1 January 2028; the lease says the 15th; recorded on the 20th,
    // after January's run. Before this the door refused ("nothing to carry
    // on from"), and had it written the row, January 2028 would have sat
    // unbilled for this household forever.
    clock.today = "2028-01-20";
    ranMonth("2028-01");
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-01-15", agreementMonths: 3 });
    expect(res.ok, res.error).toBe(true);
    // No update on the holdover: it already ends where the successor starts.
    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual([
      "park_renters:update", "lot_reservations:insert", "park_charges:insert",
    ]);
    expect(db.lot_reservations[0]).toMatchObject({ status: "active", during: "[2027-01-01,2028-01-01)" });
    expect(writes[1].patch).toMatchObject({ during: "[2028-01-01,2028-04-01)", status: "active", origin: "office", agreement_seq: 2 });
    const succ = db.lot_reservations.find((r) => r.agreement_seq === 2)!;
    const jan = liveCharges().filter((c) => c.reservation_id === succ.id);
    expect(jan).toHaveLength(1);
    expect(jan[0]).toMatchObject({ period_month: "2028-01", amount: 542.53, due_on: "2028-01-01", status: "open" });
    expect(res.signal).toBe(
      "Their arrangement ran out on January 1, 2028, so the new 3-month lease is recorded from that day — " +
      "January 2028 bills $542.53 ($400.00 rent + $142.53 fees). January 2028 is now billed — $542.53.",
    );
  });

  it("before the month's run, the current month is left to the run — nothing is raised here", async () => {
    clock.today = "2028-01-20";
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-01-15", agreementMonths: 3 });
    expect(res.ok, res.error).toBe(true);
    expect(writes.filter((w) => w.table === "park_charges")).toEqual([]);
    expect(res.signal).not.toMatch(/now billed/);
  });

  it("several months behind: each is billed, oldest first, and the toast names them all", async () => {
    // Lapsed 1 January 2028, recorded 20 March under the three-month term
    // (1 Jan – 1 Apr reaches past today). January and February are behind;
    // March's run has happened too.
    clock.today = "2028-03-20";
    ranMonth("2028-03");
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-03-10", agreementMonths: 3 });
    expect(res.ok, res.error).toBe(true);
    const succ = db.lot_reservations.find((r) => r.agreement_seq === 2)!;
    const months = writes.filter((w) => w.table === "park_charges").map((w) => w.patch.period_month);
    expect(months).toEqual(["2028-01", "2028-02", "2028-03"]);
    expect(liveCharges().filter((c) => c.reservation_id === succ.id).map((c) => c.amount)).toEqual([542.53, 542.53, 542.53]);
    expect(res.signal).toContain(
      "January 2028, February 2028 and March 2028 are now billed — $542.53, $542.53 and $542.53 ($1,627.59 in all).",
    );
  });

  it("a legitimate PAID bill on the arrangement's own last days neither refuses the signing nor is cancelled", async () => {
    // A hand-filed holdover [4 March 2027, 4 March 2028) lapsed; the run on
    // 1 March 2028 raised its three days ($26.61) and they paid it. The
    // lease says 10 March, recorded on the 20th: the row runs from the 4th.
    // Step 0 used to refuse this — 'You've already taken $26.61 against
    // March's bill' — over a bill that is right as it stands.
    seed("[2027-03-04,2028-03-04)");
    clock.today = "2028-03-20";
    db.park_charges.push({
      id: "chg-res-14-mar", park_id: "park-1", park_lot_id: "lot-14", reservation_id: "res-14", renter_id: "file-14",
      period_month: "2028-03", due_on: "2028-03-01", amount: 26.61, paid_total: 0, status: "open",
      lines: [{ label: "Lot rent", amount: 26.61, basis: "3 of 31 days" }],
    });
    db.park_payments.push({ id: "pay-1", park_id: "park-1", renter_id: "file-14", amount: 26.61, kind: "rent", charge_id: "chg-res-14-mar", received_on: "2028-03-05", reversed_at: null, returned_at: null });
    recompute("chg-res-14-mar");
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-03-10", agreementMonths: 1 });
    expect(res.ok, res.error).toBe(true);
    expect(db.park_charges.find((c) => c.id === "chg-res-14-mar")).toMatchObject({ status: "paid" });
    expect(db.park_charges.find((c) => c.id === "chg-res-14-mar")).not.toHaveProperty("void_reason");
    expect(writes.filter((w) => w.table === "park_charges" && w.op === "update")).toEqual([]);
    // The lease's own March: the 4th to the 31st, rent plus the fee.
    const succ = db.lot_reservations.find((r) => r.agreement_seq === 2)!;
    expect(succ.during).toBe("[2028-03-04,2028-04-04)");
    const mar = liveCharges().find((c) => c.reservation_id === succ.id)!;
    expect(mar).toMatchObject({ period_month: "2028-03" });
    expect(mar.lines).toEqual([
      { label: "Lot rent", amount: 361.29, basis: "28 of 31 days" },
      { label: "Grounds", amount: 128.74, basis: "28 of 31 days" },
    ]);
    expect(res.signal).toContain("March 2028 is now billed — $490.03.");
    expect(res.signal).not.toMatch(/cancelled/);
  });

  it("the owner's own second tap on a lapsed arrangement says the lease is already recorded, and writes nothing", async () => {
    clock.today = "2028-01-20";
    ranMonth("2028-01");
    const first = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-01-15", agreementMonths: 3 });
    expect(first.ok, first.error).toBe(true);
    writes.length = 0;
    const again = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-01-15", agreementMonths: 3 });
    expect(again.ok).toBe(false);
    // Not 'Something else already holds that lot' — it is his own lease.
    expect(again.error).toBe("That lease is already recorded from January 1, 2028.");
    expect(writes).toEqual([]);
    expect(db.lot_reservations).toHaveLength(2);
  });

  it("a lapsed arrangement at a length that is over from its end is refused naming a length that reaches — never the day box", async () => {
    // Lapsed 1 January 2028, recorded 15 February at one month.
    clock.today = "2028-02-15";
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-02-10", agreementMonths: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Their arrangement ran out on January 1, 2028, and from that day 1 month would be over already — pick 3 months.");
    expect(writes).toEqual([]);
  });

  it("when whether this month ran cannot be read, the toast says so and no earlier month is guessed at", async () => {
    clock.today = "2028-01-20";
    failNext.select = { table: "park_charges", message: "boom" };
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-01-15", agreementMonths: 3 });
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations).toHaveLength(2);
    expect(writes.filter((w) => w.table === "park_charges")).toEqual([]);
    expect(res.signal).toContain(
      "⚠️ We couldn't read the bills already raised this month, so no earlier month was billed for the new lease — bill them from the rent screen.",
    );
    expect(res.signal).not.toMatch(/now billed/);
  });

  it("a lease from mid-month recorded after that month ran: the lease's months on the successor, and the arrangement's own days before it in the lease's month", async () => {
    // A holdover filed on 10 January (after the 1 January run, so nothing
    // was ever raised on it); the lease says 15 January; recorded 20
    // February, after February's run. January 15–31 and all of February on
    // the lease; 10–14 January on the arrangement they had.
    seed("[2027-01-10,2028-01-10)");
    clock.today = "2027-02-20";
    ranMonth("2027-02");
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2027-01-15", agreementMonths: 3 });
    expect(res.ok, res.error).toBe(true);
    expect(db.lot_reservations[0].during).toBe("[2027-01-10,2027-01-15)");
    const succ = db.lot_reservations.find((r) => r.agreement_seq === 2)!;
    const onLease = liveCharges().filter((c) => c.reservation_id === succ.id).map((c) => `${c.period_month}:${c.amount}`);
    expect(onLease).toEqual(["2027-01:297.51", "2027-02:542.53"]);
    const onHoldover = liveCharges().filter((c) => c.reservation_id === "res-14");
    expect(onHoldover).toHaveLength(1);
    // 5 of 31 days of the $275 they were paying, no fee.
    expect(onHoldover[0]).toMatchObject({ period_month: "2027-01", amount: 44.35 });
    expect(res.signal).toBe(
      "On the new 3-month lease from January 15, 2027 — January 2027 bills the arrangement they had to January 14, 2027, " +
      "then the new lease from January 15, 2027 — $542.53 a month after that ($400.00 rent + $142.53 fees). " +
      "January 2027 and February 2027 are now billed — $297.51 and $542.53 ($840.04 in all). " +
      "On the arrangement they had, to January 14, 2027: January 2027 is now billed — $44.35.",
    );
  });

  it("a lease from the 1st: the trimmed arrangement covers no day of that month, and nothing false is said about it", async () => {
    seed("[2027-01-10,2028-01-10)");
    clock.today = "2027-02-20";
    ranMonth("2027-02");
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2027-02-01", agreementMonths: 1 });
    expect(res.ok, res.error).toBe(true);
    expect(liveCharges().filter((c) => c.reservation_id === "res-14")).toEqual([]);
    expect(res.signal).toContain("February 2027 is now billed — $542.53.");
    // '⚠️ February 2027 couldn't be billed — the run wouldn't raise it' was
    // printed for a row with no days in February.
    expect(res.signal).not.toMatch(/couldn't be billed|arrangement they had, to/);
  });

  it("a month step 4 already raised again is silent here — one live bill per month", async () => {
    januaryBilled();
    clock.today = "2027-01-02";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);
    expect(liveCharges()).toHaveLength(1);
    expect(res.signal).not.toMatch(/is now billed/);
  });

  it("a month whose bill on the old arrangement still stands is NOT raised on the new lease — the double bill step 4 exists to end", async () => {
    // The void failed (tested above as SAID); the successor's January must
    // not be raised beside the standing one.
    januaryBilled();
    clock.today = "2027-01-02";
    failNext.update = { table: "park_charges", message: "boom" };
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok, res.error).toBe(true);
    expect(liveCharges()).toHaveLength(1);
    expect(liveCharges()[0].reservation_id).toBe("res-14");
    expect(res.signal).not.toMatch(/is now billed/);
  });
});

describe("when a write fails, the sentence is true", () => {
  it("a failed renter patch changes nothing else", async () => {
    failNext.update = { table: "park_renters", message: "boom" };
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

  it("a failed successor insert leaves the January bill on the holdover STANDING — the void never runs first", async () => {
    januaryBilled();
    clock.today = "2027-01-02";
    failNext.insert = "boom";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(db.park_charges[0].status).toBe("open");
    expect(writes.filter((w) => w.table === "park_charges")).toEqual([]);
  });

  it("restores a TRIMMED holdover's whole range", async () => {
    seed("[2026-12-20,2027-12-20)");
    failNext.insert = "boom";
    const res = await recordSigning("park-1", "res-14", INPUT);
    expect(res.ok).toBe(false);
    expect(db.lot_reservations[0].during).toBe("[2026-12-20,2027-12-20)");
    expect(res.error).toMatch(/nothing bills differently/);
  });

  it("a failed successor insert on an arrangement that ran out puts nothing back — there is nothing to put back — and says so", async () => {
    clock.today = "2028-01-20";
    failNext.insert = "overlap";
    const res = await recordSigning("park-1", "res-14", { ...INPUT, signedOn: "2028-01-15", agreementMonths: 3 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "The new agreement couldn't be written — they're still on the arrangement they had. " +
      "Something else already holds that lot from that day — check the roll.",
    );
    expect(res.error).not.toMatch(/put back/);
    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual(["park_renters:update"]);
    expect(db.lot_reservations).toHaveLength(1);
    expect(db.lot_reservations[0]).toMatchObject({ status: "active", during: "[2027-01-01,2028-01-01)" });
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

// The formatter the sentences above are checked with is the module's own.
void money;
