import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE REHEARSAL: TWO HOUSEHOLDS, ONE PARK, ONE LOGIN.
 *
 * On 1 January 2027 eighteen real families get logins. Until today the only
 * thing standing between Ann's screen and Bud's ledger was a reading of the
 * source — every guard IS built (park_renters.user_id = auth.uid() in the
 * loader, the same file re-derived in payRent and sayIPaid, park_members for
 * the park area, users.role for ops, vendors.user_id for a crew, RLS in 0055,
 * the column grants in 0073, the four SECURITY DEFINER doors in 0129) and
 * NOT ONE OF THEM HAD A TEST. Worse: nine park test files mock
 * `assertMyPark: async () => true`, so the suite assumes away the boundary it
 * ought to be proving.
 *
 * This file stands the two households up side by side and signs in as one.
 *
 * WHY AN IN-MEMORY DATABASE AND NOT PRODUCTION. Production holds The Haven,
 * twenty-one lots and zero households; there is no neighbour there to read,
 * and manufacturing one would put a fake family in the roll a fortnight before
 * the real one lands. The fixture fence (users.is_fixture, lakes.is_fixture)
 * and the hex-prefixed-id convention are honoured in the seed below so the
 * same rows could be replayed against a live database unchanged.
 *
 * WHAT THIS FAKE CANNOT DO IS RLS. It answers every query as the service role,
 * which is exactly how the app reads (see the note at the top of
 * src/app/park/data.ts). So these tests pin the APPLICATION guard, and the
 * database half is pinned separately, at the bottom, against the migration
 * files themselves.
 *
 * ABSENCE PINS NOTHING, SO EVERY GUARD IS COLLAPSED BOTH WAYS. `BLIND` makes
 * the fake silently ignore the ownership filters — the precise shape of
 * somebody deleting `.eq("user_id", user.id)`. Each refusal below is followed
 * by a test that requires the collapse to LEAK. If a collapse ever stops
 * leaking, the pin has moved off the thing it was pinning and this file says
 * so rather than passing quietly.
 */

// ------------------------------------------------------------- the fake ---

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Every table this render actually opened, in order. */
const opened: string[] = [];

/** Who is signed in. Read on every call, so one file can be several people. */
let SIGNED_IN: string | null = null;

/**
 * THE COLLAPSE. When true, the fake drops every OWNERSHIP filter and keeps
 * every other one — a database that has forgotten whose row is whose.
 */
let BLIND = false;
const OWNERSHIP = new Set([
  "user_id",
  "renter_id",
  "owner_id",
  "park_payments.renter_id",
]);

/** "park_payments.renter_id" reaches into the embedded row, as PostgREST does. */
const dig = (r: Row, col: string): unknown =>
  col.split(".").reduce<unknown>((v, k) => (v == null ? v : (v as Row)[k]), r);

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private counting = false;
  constructor(private t: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.counting = true;
    return this;
  }
  eq(c: string, v: unknown) {
    if (BLIND && OWNERSHIP.has(c)) return this;
    this.fs.push((r) => dig(r, c) === v);
    return this;
  }
  in(c: string, vs: readonly unknown[]) {
    if (BLIND && OWNERSHIP.has(c)) return this;
    this.fs.push((r) => vs.includes(dig(r, c)));
    return this;
  }
  is(c: string, v: unknown) {
    this.fs.push((r) => (v === null ? dig(r, c) == null : dig(r, c) === v));
    return this;
  }
  gt(c: string, v: number) { this.fs.push((r) => Number(dig(r, c)) > v); return this; }
  gte(c: string, v: string) { this.fs.push((r) => String(dig(r, c)) >= String(v)); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => dig(r, c) !== v); return this; }
  not() { return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() {
    return this.resolve().then((r) => ({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }));
  }
  private resolve() {
    const rows = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    return Promise.resolve(
      this.counting
        ? { data: null as Row[] | null, count: rows.length, error: null }
        : { data: rows as Row[] | null, count: null as number | null, error: null },
    );
  }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; count: number | null; error: unknown }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ) {
    return this.resolve().then(ok, bad);
  }
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: SIGNED_IN ? { id: SIGNED_IN } : null } }) },
  from: (t: string) => { opened.push(t); return new Q(t); },
});

const CLOCK = "2027-01-15";
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => CLOCK,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/email", () => ({ sendEmail: async () => ({ ok: true }) }));
// takePayment THROWS on purpose: reaching the processor with a stranger's bill
// is not a softer failure than rendering it, and a test that let it through
// silently would be measuring nothing.
vi.mock("@/lib/charge-gate", () => ({
  paymentsAreLive: () => false,
  takePayment: async () => { throw new Error("a bill reached the processor without passing the ownership gate"); },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => client(),
  createServiceClient: () => client(),
}));

const { getRenterHome } = await import("@/app/parks/my-data");
const { payRent, sayIPaid } = await import("@/app/parks/pay-actions");
const { getMyPark, assertMyPark } = await import("@/app/park/data");
const { assertOps } = await import("@/app/ops/data");
const { getMyVendorId } = await import("@/app/vendor/data");

// ---------------------------------------------------------- the fixtures --
//
// Hex-prefixed ids and is_fixture on the lake and on every account, which is
// the fence this repo already uses for anything that must never be mistaken
// for a person. Ann and Bud are neighbours on ONE park; a second park exists
// with an owner who is neither of them.

const FIX = "f1x7";
const USER_A = `${FIX}-user-ann`;
const USER_B = `${FIX}-user-bud`;
const USER_OPS = `${FIX}-user-ops`;
const USER_P2 = `${FIX}-user-otherpark`;
const PARK_ONE = `${FIX}-park-one`;
const PARK_TWO = `${FIX}-park-two`;
const FILE_A = `${FIX}-renter-ann`;
const FILE_B = `${FIX}-renter-bud`;
const LOT_ROW_A = `${FIX}-lot-ann`;
const LOT_ROW_B = `${FIX}-lot-bud`;
const LOT_A = "14";
const LOT_B = "19B";
const BILL_A = `${FIX}-charge-ann`;
const BILL_B = `${FIX}-charge-bud`;
const RECEIPT_A = 7001;
const RECEIPT_B = 9002;
const VENDOR_B = `${FIX}-vendor-bud`;
const STAY_A = `${FIX}-stay-ann`;
const STAY_B = `${FIX}-stay-bud`;

function seed() {
  for (const k of Object.keys(db)) delete db[k];
  opened.length = 0;
  BLIND = false;
  SIGNED_IN = USER_A;

  db.lakes = [{ id: `${FIX}-lake`, name: "zz Fixture Lake", slug: "zz-fixture-lake", is_fixture: true }];
  db.users = [
    { id: USER_A, name: "Ann Fixture", role: "homeowner", is_fixture: true },
    { id: USER_B, name: "Bud Fixture", role: "homeowner", is_fixture: true },
    { id: USER_OPS, name: "Ops Fixture", role: "ops", is_fixture: true },
    { id: USER_P2, name: "Other Park Owner", role: "homeowner", is_fixture: true },
  ];
  db.parks = [
    { id: PARK_ONE, name: "Fixture Park One", slug: "zz-fixture-park-one", address: "1 Fixture Row", accepts_online_rent: true, card_fee_pct: 0, active: true, lake_id: `${FIX}-lake`, notices_held_at: "2026-08-25T00:00:00Z", notices_held_reason: "fixture", cutover_date: "2027-01-01", park_type: "mh", age_restricted: false, approval_required: true, season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null, included_utilities: [], house_rules: null },
    { id: PARK_TWO, name: "Fixture Park Two", slug: "zz-fixture-park-two", address: "2 Fixture Row", accepts_online_rent: true, card_fee_pct: 0, active: true, lake_id: `${FIX}-lake`, notices_held_at: "2026-08-25T00:00:00Z", notices_held_reason: "fixture", cutover_date: "2027-01-01", park_type: "mh", age_restricted: false, approval_required: true, season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null, included_utilities: [], house_rules: null },
  ];
  // ANN IS A MEMBER OF NOTHING. Only the other park has an owner.
  db.park_members = [{ park_id: PARK_TWO, user_id: USER_P2, role: "owner" }];
  db.vendors = [{ id: VENDOR_B, user_id: USER_B, status: "active", company: "Bud's Crew" }];

  db.park_renters = [
    { id: FILE_A, park_id: PARK_ONE, user_id: USER_A, display_name: "Ann Fixture", mobile_e164: null, sms_consent_operational_at: null },
    { id: FILE_B, park_id: PARK_ONE, user_id: USER_B, display_name: "Bud Fixture", mobile_e164: null, sms_consent_operational_at: null },
  ];
  db.park_lots = [
    { id: LOT_ROW_A, park_id: PARK_ONE, lot_number: LOT_A, qr_token: null },
    { id: LOT_ROW_B, park_id: PARK_ONE, lot_number: LOT_B, qr_token: null },
  ];
  // BUD'S TENANCY IS FIRST IN THE TABLE, deliberately. The fake's `.order()`
  // is a no-op, so insertion order is what a collapsed filter hands back —
  // and the collapse must produce BUD'S lot, not Ann's by luck.
  db.lot_reservations = [
    { id: STAY_B, park_lot_id: LOT_ROW_B, renter_id: FILE_B, during: "[2026-12-01,2027-12-01)", term: "monthly", status: "active", expected_move_out: null, tenancy_began_on: "2026-12-01", moved_out_on: null, created_at: "2026-11-01T00:00:00Z" },
    { id: STAY_A, park_lot_id: LOT_ROW_A, renter_id: FILE_A, during: "[2026-12-01,2027-12-01)", term: "monthly", status: "active", expected_move_out: null, tenancy_began_on: "2026-12-01", moved_out_on: null, created_at: "2026-11-02T00:00:00Z" },
  ];
  db.park_charges = [
    { id: BILL_A, park_id: PARK_ONE, renter_id: FILE_A, reservation_id: STAY_A, period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "open", lines: [{ label: "Lot rent", amount: 400 }, { label: "Shared costs", amount: 142.53 }] },
    { id: BILL_B, park_id: PARK_ONE, renter_id: FILE_B, reservation_id: STAY_B, period_month: "2027-01", due_on: "2027-01-01", amount: 611.11, paid_total: 0, status: "open", lines: [{ label: "Lot rent", amount: 611.11 }] },
  ];
  db.park_payments = [
    { id: `${FIX}-pay-ann`, renter_id: FILE_A, amount: 542.53, fee_amount: null, method: "check", received_on: "2026-12-02", receipt_no: RECEIPT_A, kind: "rent", returned_on: null, returned_amount: null, reversed_at: null, reversed_reason: null, returned_at: null, return_code: null },
    { id: `${FIX}-pay-bud`, renter_id: FILE_B, amount: 611.11, fee_amount: null, method: "cash", received_on: "2026-12-03", receipt_no: RECEIPT_B, kind: "rent", returned_on: null, returned_amount: null, reversed_at: null, reversed_reason: null, returned_at: null, return_code: null },
  ];
  // Bud has an open "I already paid this" against HIS bill. It is the sentence
  // the collapse below produces, which is what makes that assertion exact.
  db.park_payment_claims = [{ charge_id: BILL_B, claimed_paid_on: "2027-01-04", resolved_at: null }];
  db.park_on_account_payments = [
    { payment_id: `${FIX}-pay-bud`, renter_id: FILE_B, remaining: 611.11, released_from_month: null },
  ];
  db.park_payment_allocations = [
    { charge_id: BILL_B, payment_id: `${FIX}-pay-bud`, amount: 611.11, removed_at: null, park_payments: { renter_id: FILE_B, reversed_at: null, returned_at: null } },
  ];
  db.park_requests = [
    { park_lot_id: LOT_ROW_B, note: "Bud's riser is leaking", status: "open", resolution_note: null, created_at: "2027-01-05T00:00:00Z" },
  ];
  db.payment_methods = [];
  db.properties = [];
}

beforeEach(() => {
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --------------------------------------------------------------------------

describe("the rehearsal stands two households up, and fences both", () => {
  it("has two of everything worth confusing", () => {
    expect(db.park_renters).toHaveLength(2);
    expect(db.lot_reservations).toHaveLength(2);
    expect(db.park_charges).toHaveLength(2);
    expect(db.park_payments).toHaveLength(2);
    expect(db.parks).toHaveLength(2);
  });

  it("flags every account and the lake as a fixture, so none of this could be mistaken for a person", () => {
    expect(db.lakes[0].is_fixture).toBe(true);
    for (const u of db.users) expect(u.is_fixture, `${u.id} is not fenced`).toBe(true);
  });
});

describe("signed in as Ann, the resident screen is Ann's", () => {
  it("shows HER lot, HER bill and HER receipt", async () => {
    const home = await getRenterHome();
    expect(home).not.toBeNull();
    expect(home!.lotNumber).toBe(LOT_A);
    expect(home!.displayName).toBe("Ann Fixture");
    expect(home!.bill?.id).toBe(BILL_A);
    expect(home!.bill?.amount).toBeCloseTo(542.53, 2);
    expect(home!.payments.map((p) => p.receiptNo)).toEqual([RECEIPT_A]);
  });

  it("carries nothing of Bud's anywhere in the payload", async () => {
    const home = await getRenterHome();
    const s = JSON.stringify(home);
    // Positively non-empty first: an assertion about absence over an empty
    // object is an assertion about nothing.
    expect(s).toContain("Ann Fixture");
    expect(s, "a neighbour's name reached her screen").not.toMatch(/bud/i);
    expect(s, "a neighbour's rent reached her screen").not.toContain("611.11");
    expect(s, "a neighbour's receipt reached her screen").not.toContain(String(RECEIPT_B));
    expect(s, "a neighbour's lot reached her screen").not.toContain(LOT_B);
    expect(s, "a neighbour's bill id reached her screen").not.toContain(BILL_B);
  });

  it("never opens a documents table at all — the park's papers are not on this screen", async () => {
    opened.length = 0;
    await getRenterHome();
    expect(opened, "the loader did not run, so the absences below mean nothing").toContain("park_renters");
    expect(opened).not.toContain("park_documents");
    expect(opened).not.toContain("park_document_deliveries");
  });

  it("COLLAPSED: drop the ownership filter and Bud's lot is what she reads", async () => {
    BLIND = true;
    const home = await getRenterHome();
    expect(home!.lotNumber, "the collapse no longer leaks — this pin has moved off the filter it was pinning").toBe(LOT_B);
    expect(JSON.stringify(home)).toContain("611.11");
  });
});

describe("Ann cannot pay, or claim to have paid, a bill that is not hers", () => {
  it("payRent on Bud's bill is refused in those words", async () => {
    expect(await payRent(BILL_B, `${FIX}-idem-1`)).toEqual({ ok: false, error: "That isn't your bill." });
  });

  it("sayIPaid on Bud's bill is refused in those words", async () => {
    expect(await sayIPaid(BILL_B, { paidOn: "2027-01-04", method: "check" }))
      .toEqual({ ok: false, error: "That isn't your bill." });
  });

  it("and her OWN bill gets past that gate, so the refusal is about ownership and not about everything", async () => {
    const r = await payRent(BILL_A, `${FIX}-idem-2`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Add a payment method first.");
  });

  it("COLLAPSED: with the ownership filter gone, Bud's bill walks through the gate", async () => {
    BLIND = true;
    const r = await payRent(BILL_B, `${FIX}-idem-3`);
    expect(r.error, "the ownership filter is no longer what refuses a stranger's bill")
      .toBe("You've told the office you've already paid this, so we're not taking payment until they've confirmed it.");
  });

  it("COLLAPSED: and so does a claim that she already paid it", async () => {
    BLIND = true;
    const r = await sayIPaid(BILL_B, { paidOn: "2027-01-04", method: "check" });
    expect(r.error).toBe("You've already told the office about this bill. They'll confirm once they've checked.");
  });
});

describe("Ann is a resident and nothing else", () => {
  it("runs no park — not the other one, and not her own", async () => {
    expect(await getMyPark()).toBeNull();
    expect(await assertMyPark(PARK_TWO)).toBeNull();
    expect(await assertMyPark(PARK_ONE)).toBeNull();
  });

  it("and the refusal is MEMBERSHIP: the other park's owner gets into his, and only his", async () => {
    SIGNED_IN = USER_P2;
    expect((await getMyPark())?.id).toBe(PARK_TWO);
    expect(await assertMyPark(PARK_TWO)).toEqual({ role: "owner" });
    expect(await assertMyPark(PARK_ONE)).toBeNull();
  });

  it("COLLAPSED: with the ownership filter gone, Ann runs the other man's park", async () => {
    BLIND = true;
    expect(await assertMyPark(PARK_TWO)).toEqual({ role: "owner" });
  });

  it("is not ops", async () => {
    expect(await assertOps()).toBeNull();
  });

  it("and the refusal is the ROLE COLUMN, not the reader: the ops fixture gets in", async () => {
    // assertOps branches on users.role rather than filtering by it, so the
    // collapse is the seeded value, flipped.
    SIGNED_IN = USER_OPS;
    expect((await assertOps())?.id).toBe(USER_OPS);
    SIGNED_IN = USER_A;
    db.users = db.users.map((u) => (u.id === USER_A ? { ...u, role: "ops" } : u));
    expect((await assertOps())?.id, "role is no longer what decides this").toBe(USER_A);
  });

  it("is not a crew", async () => {
    expect(await getMyVendorId()).toBeNull();
  });

  it("and the refusal is the user_id: Bud's crew answers to Bud", async () => {
    SIGNED_IN = USER_B;
    expect(await getMyVendorId()).toBe(VENDOR_B);
  });

  it("COLLAPSED: with the ownership filter gone, Ann is handed Bud's crew", async () => {
    BLIND = true;
    expect(await getMyVendorId()).toBe(VENDOR_B);
  });
});

// --------------------------------------------------------------------------
//
// THE DATABASE HALF. The fake above answers as the service role, which is how
// the app reads — so nothing above touches RLS or a grant. These read the
// migration files, because the failure mode is an omission and there is no
// behavioural test for a policy nobody wrote.

describe("the database does not take the app's word for it", () => {
  const sql = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../../supabase/migrations/${rel}`, import.meta.url)), "utf8");

  it("0055 fences a household's file behind their own account, and shuts anon out entirely", () => {
    const m = sql("0055_park_renters.sql");
    expect(m).toContain("alter table public.park_renters enable row level security");
    expect(m).toContain("create policy park_renters_read on public.park_renters");
    expect(m).toContain("user_id = auth.uid() or public.ll_manages_park(park_id) or public.ll_is_ops()");
    expect(m).toContain("revoke insert, update, delete, truncate on public.park_renters from authenticated, anon");
    expect(m).toContain("revoke select on public.park_renters from anon");
  });

  it("0073 takes the park's private writing about a person back off every client role", () => {
    const m = sql("0073_park_reads_are_narrow.sql");
    expect(m).toContain("revoke select on public.park_renters from authenticated");
    expect(m).toContain("revoke select on public.park_lots from authenticated");
    // The narrowed grant is the whole point: these columns must NOT be in it.
    const grant = m.slice(
      m.indexOf("grant select (", m.indexOf("revoke select on public.park_renters from authenticated")),
      m.indexOf(") on public.park_renters to authenticated"),
    );
    expect(grant.length, "the grant this test measures was not found").toBeGreaterThan(40);
    for (const col of ["notes", "claim_code", "phone_on_file_with_park", "merged_into"]) {
      expect(grant, `${col} is readable by a signed-in stranger again`).not.toContain(col);
    }
  });

  it("0129's four doors take the person from auth.uid(), never from the wire", () => {
    const m = sql("0129_the_four_doors_and_who_may_knock.sql");
    for (const fn of ["claim_park_file", "issue_park_claim_code", "release_park_claim", "decline_park_claim", "park_claim_code_status"]) {
      expect(m, `${fn} is missing`).toContain(`public.${fn}(`);
      expect(m, `${fn} is callable by anon`).toContain(`revoke execute on function public.${fn}(`);
    }
    // The claim door takes park + lot + code and NO identity at all.
    const door = m.slice(m.indexOf("create or replace function public.claim_park_file"), m.indexOf("comment on function public.claim_park_file"));
    expect(door.length).toBeGreaterThan(400);
    expect(door).toContain("v_user   uuid := auth.uid()");
    expect(door).toContain("security definer");
    expect(door, "a user id on the wire is a user id somebody can forge").not.toMatch(/p_user_id/);
    // Releasing somebody's file is theirs, their park's, or ops'.
    expect(m).toContain("if not (v_file.user_id = v_user or public.ll_is_ops() or exists (");
  });
});

// --------------------------------------------------------------------------

describe("the two park modules that carry unguarded, park-scoped exports", () => {
  /**
   * charge-edits.ts exports six park-scoped functions and gap-bills.ts two,
   * NONE of which asserts the park — correctly, because today they are
   * internal helpers called from actions that already did. Add "use server"
   * to either file and every export in it becomes a POST endpoint taking a
   * parkId from a browser with nothing checking it. That is the shape of the
   * recordCost hole from the 0106-0115 sweep, and it is one line away.
   */
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  /**
   * STRIP THE COMMENTS FIRST, and this file learned why the hard way.
   *
   * The first version of this scan read raw source and went red immediately —
   * on charge-edits.ts:18, which says "this is NOT a \"use server\" module".
   * The sentence explaining that the file is not an action door was what the
   * tripwire for it becoming one caught. A scan that matches its own subject
   * inside prose is measuring nothing, and half the value of this repo's
   * source scans comes from stripping first.
   */
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /**
   * AND A DIRECTIVE IS THE FIRST STATEMENT, not a string anywhere in the file.
   * "use server" inside a template literal, a test fixture or an error message
   * does not turn a module into an action door; only the prologue does.
   */
  const isActionModule = (code: string) =>
    /^\s*(?:["']use strict["'];?\s*)?["']use server["']/.test(code);

  it("are still plain modules, not action doors", () => {
    for (const rel of ["../park/charge-edits.ts", "../park/gap-bills.ts"]) {
      const code = strip(src(rel));
      expect(code, `${rel} was not found`).toContain("export");
      expect(
        isActionModule(code),
        `${rel} became a "use server" file — every export in it is now a POST endpoint, and not one of them asserts the park. Give each one assertMyPark, or keep it an internal helper.`,
      ).toBe(false);
    }
  });

  it("and the scan bites — it catches a real directive and ignores a mention", () => {
    // BOTH WAYS. An absence-only assertion would pass against a scanner that
    // had been quietly broken, which is exactly what the first version was.
    expect(isActionModule(strip('"use server";\nexport async function x() {}'))).toBe(true);
    expect(isActionModule(strip('"use strict";\n"use server";\nexport const y = 1;'))).toBe(true);
    // The shape that produced the false alarm: the words, in prose.
    expect(isActionModule(strip('/** this is NOT a "use server" module */\nexport const z = 1;'))).toBe(false);
    // And the words in a string that is not the prologue.
    expect(isActionModule(strip('import x from "y";\nconst msg = "use server";'))).toBe(false);
  });
});
