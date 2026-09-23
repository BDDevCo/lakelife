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
  // Dotted columns are EMBED paths ("properties.users.is_fixture"), which is
  // how PostgREST filters on a joined row — and how the claim board's owner
  // fence is written. Resolving only the flat name would silently drop every
  // row and read as "the board is empty".
  eq(c: string, v: unknown) {
    this.fs.push((r) => c.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Row)[k]), r) === v);
    return this;
  }
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
  coi_named_insured: "Twin Lakes Crew",
  coi_expiry_confirmed_at: null,
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
  properties: { lake_id: "lake-1", lat: 41.6, lng: -85.4, address: "9 Cove Ln", lakes: { name: "Big Long" }, users: { phone: null, email: null, is_fixture: false } },
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
  db.vendors = [{ ...vendor, user_id: USER_ID, users: { is_fixture: false } }];
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

/**
 * THE FENCE THAT ONLY EVER RAN ONE WAY — same two doorways, same harness.
 *
 * Five pools keep a test crew away from real work. Nothing kept a REAL crew
 * away from a test booking: the board listed every open job whoever booked it,
 * and the claim action re-gated on capacity, insurance, standing and custody
 * but never on whether the customer existed. The first real crew on the
 * platform could have been shown, and could have driven to, a job seeded to
 * rehearse the software.
 *
 * These live beside the custody tests because this is the only honest fake of
 * the two functions in the repo — and, as there, the pairing is the point:
 * each case has a twin that must still go through.
 */
describe("a real crew is never shown a test booking", () => {
  const fixtureOwned = (id: string): Row => {
    const j = job(id, "svc-mow", MOW, false);
    j.properties = { ...(j.properties as Row), users: { phone: null, email: null, is_fixture: true } };
    return j;
  };
  /** Same crew, same everything, except whose account stands behind it. */
  const asFixtureCrew = () => {
    db.vendors = [{ ...vendor, user_id: USER_ID, users: { is_fixture: true } }];
  };

  beforeEach(() => {
    db.jobs = [fixtureOwned("j-seeded"), job("j-mow", "svc-mow", MOW, false)];
  });

  it("the board hides the seeded job and keeps the real one", async () => {
    const b = await board();
    expect(b.get("j-seeded"), "a test booking reached a real crew's board").toBeUndefined();
    expect(b.get("j-mow"), "the fence took the real job with it").toBeDefined();
  });

  it("the claim refuses it, and says why in words that are true", async () => {
    const res = await claimJob("j-seeded");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/test booking/);
    expect(res.error, "nobody took it — it was never real").not.toMatch(/already taken/);
    const row = db.jobs.find((j) => j.id === "j-seeded")!;
    expect(row.vendor_id).toBeNull();
    expect(row.status).toBe("requested");
  });

  /* THE OTHER HALF. An unconditional fence would close the last path by which
     the owner's three test crews can take a job at all — ops refuses to
     hand-assign them and auto-dispatch excludes them — leaving no way to walk
     claim → complete → payout before a real crew ever arrives. Collapse the
     direction and these two go red. */
  it("a test crew still sees a test booking", async () => {
    asFixtureCrew();
    const b = await board();
    expect(b.get("j-seeded"), "the rehearsal path is closed").toBeDefined();
  });

  it("and can still claim it", async () => {
    asFixtureCrew();
    const res = await claimJob("j-seeded");
    expect(res).toEqual({ ok: true });
    expect(db.jobs.find((j) => j.id === "j-seeded")!.status).toBe("scheduled");
  });
});
