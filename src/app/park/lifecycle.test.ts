import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { summarise, buildRentRoll, toStay, type RawReservation } from "./park-helpers";
import type { Lot } from "@/lib/parks";

// ---------------------------------------------------------------------------
// The second half of this file drives the REAL `endTenancy` against an
// in-memory table, so the mocks are declared up front (vitest hoists them).
// The pure-helper tests above are untouched by them.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { lot_reservations: [], park_members: [], park_lots: [] };
const writes: Array<{ op: string; patch: Row; matched: string[] }> = [];
const failNext: { update?: boolean } = {};

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  private op: "select" | "update" = "select";
  private embed = false;
  constructor(private t: string) {}
  select(cols?: string) { if (cols?.includes("park_lots(")) this.embed = true; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  gt(c: string, v: number) { this.fs.push((r) => (r[c] as number) > v); return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  private run() {
    const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.op === "update") {
      if (failNext.update) { delete failNext.update; return { data: null, error: { message: "boom" } }; }
      for (const r of hit) Object.assign(r, this.patch);
      writes.push({ op: "update", patch: this.patch!, matched: hit.map((r) => r.id as string) });
      return { data: hit.map((r) => ({ id: r.id, during: r.during })), error: null };
    }
    return {
      data: hit.map((r) => (this.embed ? { ...r, park_lots: { park_id: "park-1" } } : r)),
      error: null,
    };
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); }
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
const { endTenancy } = await import("./actions");

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
    moved_out_on: null, ...over,
  });
  beforeEach(() => {
    db.park_members = [{ park_id: "park-1", user_id: "user-owner", role: "owner" }];
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
    // neither covers today nor is next, so buildRentRoll reads the lot
    // vacant and the row offers neither control; and 'still bills' was
    // false of a link that billed February and bills nothing now.
    clock.today = "2027-03-15";
    Object.assign(db.lot_reservations.find((r) => r.id === "feb")!, { status: "active", during: "[2027-02-01,2027-03-01)" });
    const res = await withCascadeFailure(() => endTenancy("jan", "ended", "2027-01-27"));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Closed out — last day January 27, 2027 — but their next agreement couldn't be withdrawn: " +
      "it already billed February 2027 for a household who had left. That's ours to fix — get in touch and we'll sort it.",
    );
    expect(res.error).not.toMatch(/still bills/);
    expect(res.error).not.toMatch(/Move out/);
    expect(res.error).not.toMatch(/Withdraw the next agreement/);
    expect(db.lot_reservations.find((r) => r.id === "jan")!.status).toBe("ended");
    expect(db.lot_reservations.find((r) => r.id === "feb")!.status).toBe("active");

    // The roll, on 15 March, from that state: nothing current, nothing next.
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
    expect(rows[0].state).toBe("vacant");
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
