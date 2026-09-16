import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { balanceOf } from "./ledger-helpers";

/**
 * THE LIST BEHIND TAP TWO OF ⊕ TAKE A PAYMENT.
 *
 * Calls the REAL paymentTargets against a fake of the six tables it reads,
 * because the thing that matters is the shape it hands the window: the
 * oldest OPEN bill per household with the database's own balance, void and
 * paid bills left out, what of theirs the office already holds, whether
 * anything more will ever bill for them, the lot order a person reads, and —
 * above all — that a failed read comes back as a sentence and never as
 * "nothing owed" (or "nothing held") for everybody, which would send every
 * payment at the window on account, or take a rent the office already had.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let nextReadError: { table: string; error: { code: string; message: string } } | null = null;
const fromSpy = vi.fn();

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gt(c: string, v: number) { this.fs.push((r) => Number(r[c]) > v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  order() { return this; }
  limit() { return this; }
  private resolve() {
    if (nextReadError && nextReadError.table === this.t) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e });
    }
    return Promise.resolve({ data: (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))), error: null });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}

// assertMyPark is mocked; compareLotNumbers must be the REAL one, because
// the order the window shows is the order the roll shows. data.ts pulls in
// lib/booking, lib/parks and park-helpers, all pure, so importOriginal is
// safe here; were it ever not, copy compareLotNumbers' four lines INTO this
// mock — never move it out of data.ts to make a test easier.
const assertMyPark = vi.fn(async (_parkId: string) => ({ role: "owner" }) as { role: string } | null);
vi.mock("@/app/park/data", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/park/data")>();
  return { ...real, assertMyPark: (parkId: string) => assertMyPark(parkId) };
});
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => { fromSpy(t); return new Q(t); } }),
}));
const { paymentTargets } = await import("./pos-actions");
const { todayLakeDate } = await import("@/lib/booking");

const PARK = "park-1";
const READ_FAILED = "We couldn't load something just now, so nothing has been changed. Try again in a moment.";

const renter = (id: string, name: string | null = `Household ${id.replace("renter-", "")}`, merged: string | null = null): Row =>
  ({ id, park_id: PARK, display_name: name, merged_into: merged });
const lot = (id: string, n: string): Row => ({ id, park_id: PARK, lot_number: n });
const stay = (lotId: string, renterId: string, status = "active"): Row =>
  ({ id: `stay-${lotId}-${renterId}`, park_lot_id: lotId, renter_id: renterId, status });
/** A household who moved out — the link tenancyFactsFor reads the last day off. */
const left = (renterId: string, movedOutOn: string): Row => ({
  id: `left-${renterId}`, park_lot_id: "lot-gone", renter_id: renterId, status: "ended",
  moved_out_on: movedOutOn, during: `[2026-06-01,${movedOutOn})`, term: "monthly",
});
/** Money of theirs on account, as 0167's view answers: what is STILL unspent. */
const held = (id: string, renterId: string, remaining: number, receivedOn = "2027-01-03"): Row =>
  ({ payment_id: id, park_id: PARK, renter_id: renterId, remaining, received_on: receivedOn, created_at: `${receivedOn}T12:00:00Z` });
const charge = (id: string, renterId: string, month: string, amount: number, paid: number, status = "open", due = `${month}-01`): Row =>
  ({ id, park_id: PARK, renter_id: renterId, period_month: month, due_on: due, amount, paid_total: paid, status });

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  nextReadError = null;
  fromSpy.mockClear();
  assertMyPark.mockReset();
  assertMyPark.mockResolvedValue({ role: "owner" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("paymentTargets", () => {
  it("is refused before any read when the park is not theirs", async () => {
    assertMyPark.mockResolvedValue(null);
    const r = await paymentTargets(PARK);
    expect(r).toEqual({ ok: false, error: "You don't manage that park.", retryable: false });
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("hands the window each household's OLDEST open bill with the database's own balance", async () => {
    db.park_renters = [renter("renter-9")];
    db.park_lots = [lot("lot-9", "9")];
    db.lot_reservations = [stay("lot-9", "renter-9")];
    // February inserted FIRST — the order the bills come back in must not be the order they were raised.
    db.park_charges = [
      charge("feb", "renter-9", "2027-02", 542.53, 0),
      charge("jan", "renter-9", "2027-01", 542.53, 200),
    ];
    const r = await paymentTargets(PARK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toEqual([{
      renterId: "renter-9", lotNumber: "9", name: "Household 9", openCount: 2,
      oldestOpen: { chargeId: "jan", month: "2027-01", balance: 342.53, disputed: false },
      onAccount: 0, nothingMoreBills: false,
    }]);
    // The same subtraction the rent screen makes, to the cent.
    expect(r.targets[0].oldestOpen!.balance).toBe(balanceOf({
      id: "jan", lotNumber: "9", renterName: null, periodMonth: "2027-01", dueOn: "2027-01-01",
      amount: 542.53, paidTotal: 200, status: "open",
    }));
  });

  it("leaves void and paid bills out", async () => {
    db.park_renters = [renter("renter-9")];
    db.park_lots = [];
    db.park_charges = [
      charge("dec", "renter-9", "2026-12", 542.53, 0, "void"),
      charge("nov", "renter-9", "2026-11", 542.53, 542.53, "paid"),
      charge("jan", "renter-9", "2027-01", 542.53, 0),
    ];
    let r = await paymentTargets(PARK);
    expect(r.ok && r.targets[0].oldestOpen?.chargeId).toBe("jan");
    expect(r.ok && r.targets[0].openCount).toBe(1);

    db.park_charges = db.park_charges.filter((c) => c.id !== "jan");
    r = await paymentTargets(PARK);
    expect(r.ok && r.targets[0].oldestOpen).toBeNull();
    expect(r.ok && r.targets[0].openCount).toBe(0);
  });

  it("orders two bills for one month by due date — oldestFirst's own tie-break", async () => {
    db.park_renters = [renter("renter-9")];
    db.park_lots = [];
    db.park_charges = [
      charge("renewal", "renter-9", "2027-01", 542.53, 0, "open", "2027-01-15"),
      charge("part", "renter-9", "2027-01", 180.84, 0, "open", "2027-01-01"),
    ];
    const r = await paymentTargets(PARK);
    expect(r.ok && r.targets[0].oldestOpen?.chargeId).toBe("part");
  });

  it("lists lots in the order a person reads them, and households on no lot last", async () => {
    db.park_renters = [renter("renter-14"), renter("renter-2"), renter("renter-9"), renter("renter-x", "Left owing")];
    db.park_lots = [lot("lot-14", "14"), lot("lot-2", "2"), lot("lot-9", "9")];
    db.lot_reservations = [stay("lot-14", "renter-14"), stay("lot-2", "renter-2"), stay("lot-9", "renter-9", "approved")];
    db.park_charges = [];
    const r = await paymentTargets(PARK);
    expect(r.ok && r.targets.map((t) => t.lotNumber)).toEqual(["2", "9", "14", "—"]);
    expect(r.ok && r.targets[3]).toEqual({
      renterId: "renter-x", lotNumber: "—", name: "Left owing", openCount: 0, oldestOpen: null, onAccount: 0, nothingMoreBills: false,
    });
  });

  it("does not count an ended tenancy as the lot on the row", async () => {
    db.park_renters = [renter("renter-9")];
    db.park_lots = [lot("lot-9", "9")];
    db.lot_reservations = [stay("lot-9", "renter-9", "ended")];
    db.park_charges = [];
    const r = await paymentTargets(PARK);
    expect(r.ok && r.targets[0].lotNumber).toBe("—");
  });

  it("a merged file is a duplicate, not a household", async () => {
    db.park_renters = [renter("renter-9"), renter("renter-dup", "Household 9 (dup)", "renter-9")];
    db.park_lots = [];
    db.park_charges = [];
    const r = await paymentTargets(PARK);
    expect(r.ok && r.targets.map((t) => t.renterId)).toEqual(["renter-9"]);
  });

  it("a failed read of the roll is a sentence, never an empty list", async () => {
    nextReadError = { table: "park_renters", error: { code: "08006", message: "connection dropped" } };
    const r = await paymentTargets(PARK);
    expect(r).toEqual({ ok: false, error: READ_FAILED, retryable: true });
    expect("targets" in r).toBe(false);
  });

  it("a failed read of the bills is never 'nothing owed' for everybody", async () => {
    db.park_renters = [renter("renter-9"), renter("renter-14")];
    db.park_lots = [];
    db.park_charges = [charge("jan", "renter-9", "2027-01", 542.53, 0)];
    nextReadError = { table: "park_charges", error: { code: "08006", message: "connection dropped" } };
    const r = await paymentTargets(PARK);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.retryable).toBe(true);
    expect(r.ok === false && r.error).toBe(READ_FAILED);
    // Prove the fixture WOULD have produced a target had the read worked — so
    // the assertion above is about the failure, not an empty park.
    const again = await paymentTargets(PARK);
    expect(again.ok && again.targets.some((t) => t.oldestOpen != null)).toBe(true);
  });

  it("a failed read of the lots or the claims is a sentence too", async () => {
    db.park_renters = [renter("renter-9")];
    db.park_lots = [lot("lot-9", "9")];
    db.lot_reservations = [stay("lot-9", "renter-9")];
    db.park_charges = [charge("jan", "renter-9", "2027-01", 542.53, 0)];
    nextReadError = { table: "park_lots", error: { code: "08006", message: "x" } };
    expect(await paymentTargets(PARK)).toEqual({ ok: false, error: READ_FAILED, retryable: true });
    nextReadError = { table: "lot_reservations", error: { code: "08006", message: "x" } };
    expect(await paymentTargets(PARK)).toEqual({ ok: false, error: READ_FAILED, retryable: true });
    nextReadError = { table: "park_payment_claims", error: { code: "08006", message: "x" } };
    expect(await paymentTargets(PARK)).toEqual({ ok: false, error: READ_FAILED, retryable: true });
  });

  it("marks the oldest bill disputed only while its claim is unresolved, and only its own claim", async () => {
    db.park_renters = [renter("renter-9")];
    db.park_lots = [];
    db.park_charges = [
      charge("jan", "renter-9", "2027-01", 542.53, 0),
      charge("feb", "renter-9", "2027-02", 542.53, 0),
    ];
    db.park_payment_claims = [{ id: "c1", charge_id: "jan", resolved_at: null }];
    let r = await paymentTargets(PARK);
    expect(r.ok && r.targets[0].oldestOpen?.disputed).toBe(true);

    db.park_payment_claims = [{ id: "c1", charge_id: "jan", resolved_at: "2027-01-05T00:00:00Z" }];
    r = await paymentTargets(PARK);
    expect(r.ok && r.targets[0].oldestOpen?.disputed).toBe(false);

    db.park_payment_claims = [{ id: "c2", charge_id: "feb", resolved_at: null }];
    r = await paymentTargets(PARK);
    expect(r.ok && r.targets[0].oldestOpen?.disputed).toBe(false);
  });

  it("carries what of theirs the office already holds — the view's remaining, summed, never deposits", async () => {
    db.park_renters = [renter("renter-9"), renter("renter-14")];
    db.park_lots = [];
    // The reachable state: an open bill AND their own money beside it, after
    // a line was taken off a bill or a paid month cancelled (no auto-settle).
    db.park_charges = [charge("feb", "renter-9", "2027-02", 542.53, 0)];
    db.park_on_account_payments = [
      held("acct-1", "renter-9", 342.53),
      held("acct-2", "renter-9", 200, "2027-01-20"),
      // Spent in full: the view answers remaining 0 and the read asks > 0.
      held("acct-3", "renter-9", 0),
      held("acct-4", "renter-14", 57.47),
    ];
    // A deposit held for renter-9 — must not read as money that covers rent.
    db.park_payments = [{ id: "dep", park_id: PARK, renter_id: "renter-9", kind: "deposit", amount: 500 }];
    const r = await paymentTargets(PARK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nine = r.targets.find((t) => t.renterId === "renter-9")!;
    expect(nine.oldestOpen?.balance).toBe(542.53);
    expect(nine.onAccount).toBe(542.53);
    expect(r.targets.find((t) => t.renterId === "renter-14")!.onAccount).toBe(57.47);
    expect(fromSpy).not.toHaveBeenCalledWith("park_payments");
    // Both ways: with the held money gone the row says zero, not the deposit.
    db.park_on_account_payments = [];
    const again = await paymentTargets(PARK);
    expect(again.ok && again.targets.find((t) => t.renterId === "renter-9")!.onAccount).toBe(0);
  });

  it("a failed read of the money on account is a sentence, never 'nothing held' for everybody", async () => {
    db.park_renters = [renter("renter-9")];
    db.park_lots = [];
    db.park_charges = [charge("feb", "renter-9", "2027-02", 542.53, 0)];
    db.park_on_account_payments = [held("acct-1", "renter-9", 542.53)];
    nextReadError = { table: "park_on_account_payments", error: { code: "08006", message: "connection dropped" } };
    expect(await paymentTargets(PARK)).toEqual({ ok: false, error: READ_FAILED, retryable: true });
    const again = await paymentTargets(PARK);
    expect(again.ok && again.targets[0].onAccount).toBe(542.53);
  });

  it("says whether anything more bills for them — both ways, and unknown on a failed read", async () => {
    db.park_renters = [renter("renter-gone"), renter("renter-going"), renter("renter-9")];
    db.park_lots = [lot("lot-9", "9")];
    db.lot_reservations = [
      // Moved out 20 January; January is billed on the link they left from.
      left("renter-gone", "2027-01-20"),
      // Moved out 2 February; February's part month is not raised yet.
      left("renter-going", "2027-02-02"),
      stay("lot-9", "renter-9"),
    ];
    db.park_charges = [
      { ...charge("jan-gone", "renter-gone", "2027-01", 542.53, 542.53, "paid"), reservation_id: "left-renter-gone" },
      { ...charge("jan-going", "renter-going", "2027-01", 542.53, 542.53, "paid"), reservation_id: "left-renter-going" },
    ];
    const r = await paymentTargets(PARK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = new Map(r.targets.map((t) => [t.renterId, t.nothingMoreBills]));
    expect(by.get("renter-gone")).toBe(true);
    expect(by.get("renter-going")).toBe(false);
    expect(by.get("renter-9")).toBe(false);

    // A void January is not a billed one: the run raises it again.
    db.park_charges[0] = { ...db.park_charges[0], status: "void" };
    const voided = await paymentTargets(PARK);
    expect(voided.ok && voided.targets.find((t) => t.renterId === "renter-gone")!.nothingMoreBills).toBe(false);
  });

  it("a failed read of whether they are still here makes NO promise — null, never false", async () => {
    db.park_renters = [renter("renter-gone")];
    // No lots on file, so the first read of lot_reservations is the tenancy one.
    db.park_lots = [];
    db.lot_reservations = [left("renter-gone", "2027-01-20")];
    db.park_charges = [
      { ...charge("jan-gone", "renter-gone", "2027-01", 542.53, 542.53, "paid"), reservation_id: "left-renter-gone" },
    ];
    nextReadError = { table: "lot_reservations", error: { code: "08006", message: "connection dropped" } };
    const r = await paymentTargets(PARK);
    // The list still opens — what is owed and held is right — but with no promise.
    expect(r.ok).toBe(true);
    expect(r.ok && r.targets[0].nothingMoreBills).toBeNull();
    const again = await paymentTargets(PARK);
    expect(again.ok && again.targets[0].nothingMoreBills).toBe(true);
  });

  it("a household with no name gets the picker's own dash", async () => {
    db.park_renters = [renter("renter-9", null)];
    db.park_lots = [];
    db.park_charges = [];
    const r = await paymentTargets(PARK);
    expect(r.ok && r.targets[0].name).toBe("—");
  });

  it("today is the lake date, as YYYY-MM-DD", async () => {
    db.park_renters = [];
    const r = await paymentTargets(PARK);
    expect(r.ok && r.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.ok && r.today).toBe(todayLakeDate());
    expect(r.ok && r.targets).toEqual([]);
  });
});

describe("pos-actions.ts, read as source", () => {
  const src = readFileSync(fileURLToPath(new URL("./pos-actions.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("is a server action file that guards before it reads", () => {
    expect(src.trimStart().startsWith('"use server"')).toBe(true);
    const guard = src.indexOf("assertMyPark(parkId)");
    const firstRead = src.indexOf(".from(");
    expect(guard).toBeGreaterThan(0);
    expect(firstRead).toBeGreaterThan(guard);
  });

  it("borrows the settlement door's definition of open, of oldest and of on account — and the void door's of 'nothing more bills'", () => {
    expect(src).toMatch(/import \{ openBillsFor, oldestFirst, onAccountSources \} from "@\/lib\/allocations"/);
    expect(src).toMatch(/openBillsFor\(admin, parkId, renterIds\)/);
    expect(src).toMatch(/oldestFirst\(list\)/);
    expect(src).toMatch(/onAccountSources\(admin, parkId, renterIds\)/);
    // Never heldOnAccountFor: that sums deposits too, and a deposit does not cover a rent bill.
    expect(src).not.toMatch(/heldOnAccountFor/);
    expect(src).toMatch(/tenancyFactsFor\(admin, renterIds, today\)/);
    expect(src).toMatch(/nothingMoreBills\(facts\.get\(r\.id\)\)/);
    expect(src).not.toMatch(/\.from\("park_charges"\)/);
    expect(src).not.toMatch(/\.from\("park_on_account_payments"\)/);
    expect(src).not.toMatch(/\.from\("park_payments"\)/);
  });

  it("never throws a failed read at the browser — every read is checked", () => {
    expect(src).not.toMatch(/mustRead\(/);
    const reads = [...src.matchAll(/\.from\("/g)];
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const m of reads) {
      const after = src.slice(m.index!, m.index! + 400);
      expect(after, `read at ${m.index} is unchecked`).toMatch(/\.error/);
    }
    // The denial is the ONE non-retryable answer.
    expect(src.match(/retryable: false/g)).toHaveLength(1);
  });
});
