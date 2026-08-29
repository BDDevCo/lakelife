import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CUSTODY IS NOT A FIRST-TAP PRIZE — ON THE CLAIM BOARD TOO.
 *
 * `canClaim` has refused every custody visit since S2, and 0145 gave custody a
 * named column (`services.takes_custody`) so a job could say so directly. The
 * ROUTING path was wired to it. The CLAIM BOARD was not: neither caller passed
 * `storage`, so the first line of `canClaim` — the one holding the owner's
 * rule — had never executed in production. The board's only custody-adjacent
 * filter is `.is("group_id", null)`, and the three active custody services are
 * standalone, so they carry no group and sailed straight through it.
 *
 * These are BEHAVIOURAL, not source scans, for one reason: the pure-function
 * test for this rule already passes, and passed all the way through the bug.
 * What was broken was the wiring between two callers and a function, and only
 * running the callers can prove that wiring exists. Delete either `storage:`
 * line from open-data.ts / open-actions.ts and the two refusal tests below go
 * red while everything else in the suite stays green.
 *
 * The pairing matters as much as the refusal: each custody case has a
 * non-custody twin with identical numbers, crew, date and rate. The twin
 * proves the gate closed on custody and not on the whole board.
 */
vi.mock("server-only", () => ({}));

const TODAY = "2026-09-14"; // a Monday
const JOB_DATE = "2026-09-16"; // Wednesday — inside the crew's work days

vi.mock("@/lib/booking", async () => {
  const real = await vi.importActual<typeof import("@/lib/booking")>("@/lib/booking");
  return { ...real, todayLakeDate: () => TODAY };
});

vi.mock("@/lib/settings", () => ({
  getPlatformSettings: vi.fn(async () => ({
    marginFloor: 0.25,
    lakeDemotionCooldownDays: 30,
    sameDayFillDiscountPct: 0.15,
    sameDayCutoffHour: 14,
    gapAnchorPct: 0.95,
    gapMinOffer: 20,
  })),
}));

// The pricing profile is not what's under test here; every price below is a
// `flat` rule, which reads none of these fields.
vi.mock("@/app/book/dispatch", () => ({
  loadPricingProfileById: vi.fn(async () => ({
    sqft: 2000, beds: 3, baths: 2, pier_sections: 0, boat_lifts: 0,
    toy_lifts: 0, jet_skis: 0, pwc_lifts: 0, lawn_band: "medium",
    boats: [], toys: [],
  })),
}));

const notified = vi.fn(async () => {});
vi.mock("@/lib/notify", () => ({ notify: (...a: unknown[]) => notified(...(a as [])) }));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {
  services: [], jobs: [], vendors: [], vendor_rates: [],
  vendor_availability: [], vendor_lake_demotions: [], crew_units: [],
  vendor_rate_history: [],
};

/**
 * Enough of PostgREST to run these two functions honestly: the filters they
 * actually use, and an `update()` that MUTATES the fake rows — so "the claim
 * was refused" can be asserted against the job row, not only the return value.
 */
class Q implements PromiseLike<{ data: Row[] | null; error: null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private cap: number | null = null;
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  update(p: Row) { this.patch = p; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gte(c: string, v: string) { this.fs.push((r) => String(r[c] ?? "") >= v); return this; }
  order() { return this; }
  limit(n: number) { this.cap = n; return this; }
  private rows(): Row[] {
    const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    return this.cap == null ? hit : hit.slice(0, this.cap);
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
  }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const hit = this.rows();
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: hit, error: null }).then(ok, bad);
  }
}

const USER_ID = "user-1";
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  }),
}));

const { getOpenJobs } = await import("./open-data");
const { claimJob } = await import("./open-actions");

const CUSTODY = "Boat storage & winterize"; // active + takes_custody in prod
const MOW = "Weekly mow";

const vendor = {
  id: "v1",
  company: "Twin Lakes Crew",
  status: "active" as const,
  coi_url: null,
  coi_expiry: "2027-01-01",
  w9_url: null,
  service_types: [CUSTODY, MOW],
  work_days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  service_lakes: ["lake-1"],
  daily_capacity: 5,
  base_lat: null,
  base_lng: null,
};

/** Two jobs identical in every way that can block a claim, except custody. */
const job = (id: string, serviceId: string, name: string, takesCustody: boolean): Row => ({
  id,
  date: JOB_DATE,
  status: "requested",
  vendor_id: null,
  group_id: null, // STANDALONE — this is why the board's group filter misses it
  customer_price: 100,
  service_id: serviceId,
  property_id: "prop-1",
  is_rush: false,
  est_minutes: 120,
  created_at: `${TODAY}T09:00:00Z`,
  services: { name, pricing_model: "flat", est_minutes: 120, takes_custody: takesCustody },
  properties: { lake_id: "lake-1", lat: 41.6, lng: -85.4, address: "9 Cove Ln", lakes: { name: "Big Long" }, users: { phone: null, email: null } },
});

beforeEach(() => {
  notified.mockClear();
  db.services = [
    { id: "svc-custody", name: CUSTODY },
    { id: "svc-mow", name: MOW },
  ];
  db.jobs = [
    job("j-custody", "svc-custody", CUSTODY, true),
    job("j-mow", "svc-mow", MOW, false),
  ];
  db.vendors = [{ ...vendor, user_id: USER_ID }];
  // 70 against a 100 menu = 30% margin, comfortably over the 25% floor: both
  // jobs are claimable on every gate except the one under test.
  db.vendor_rates = [
    { vendor_id: "v1", service_id: "svc-custody", base: 70, unit_rate: 0, band_pricing: null },
    { vendor_id: "v1", service_id: "svc-mow", base: 70, unit_rate: 0, band_pricing: null },
  ];
  db.vendor_availability = [];
  db.vendor_lake_demotions = [];
  db.crew_units = [];
  db.vendor_rate_history = [];
});

const board = async () => {
  const rows = await getOpenJobs(vendor);
  return new Map(rows.map((r) => [r.id, r]));
};

describe("the claim board refuses custody (0145, the second doorway)", () => {
  it("shows a standalone custody job as unclaimable, with the custody reason", async () => {
    const b = await board();
    const row = b.get("j-custody");
    expect(row, "the custody job never reached the board — this test proves nothing").toBeDefined();
    expect(row!.claimable).toBe(false);
    // The board carries the blocker OpenJobsBoard already has copy for
    // ("Storage jobs are routed, never claimed") — copy that could not render
    // before this, because nothing ever produced the value.
    expect(row!.blocker).toBe("custody_job");
  });

  it("leaves the identical non-custody job claimable", async () => {
    const b = await board();
    const row = b.get("j-mow");
    expect(row).toBeDefined();
    expect(row!.claimable).toBe(true);
    expect(row!.blocker).toBeNull();
  });

  it("refuses the claim ACTION, not just the listing", async () => {
    // The board hiding a row is a courtesy. A POST straight at the action —
    // a stale board, a replayed request — is the boundary that matters.
    const res = await claimJob("j-custody");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Storage jobs are routed/);
  });

  it("writes NOTHING when it refuses — the job stays on the board", async () => {
    await claimJob("j-custody");
    const row = db.jobs.find((j) => j.id === "j-custody")!;
    expect(row.vendor_id, "a crew took custody of the boat").toBeNull();
    expect(row.status).toBe("requested");
    expect(row.vendor_cost ?? null).toBeNull();
    expect(notified, "the owner was told a crew picked it up").not.toHaveBeenCalled();
  });

  it("still lets the identical non-custody claim through", async () => {
    const res = await claimJob("j-mow");
    expect(res).toEqual({ ok: true });
    const row = db.jobs.find((j) => j.id === "j-mow")!;
    expect(row.vendor_id).toBe("v1");
    expect(row.status).toBe("scheduled");
    expect(row.vendor_cost).toBe(70);
  });
});
