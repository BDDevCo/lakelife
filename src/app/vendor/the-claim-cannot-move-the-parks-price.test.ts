import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE OPEN BOARD IS A DOORWAY THAT WRITES `customer_price`, AND IT HAD NEVER
 * HEARD OF A PARK.
 *
 * `park-precedence.test.ts` proves the RULE: a park's own negotiated rate beats
 * a crew's card, so flipping `Park grounds mowing & trim` to crew_priced does
 * not move The Haven's $125. That is a pure-function argument, and until this
 * file it was the whole safety case for 0176 dropping 0174's CHECK.
 *
 * It was not enough. `claimJob` decided the platform fee from `svc.crew_priced`
 * alone, and when a fee is in force its guarded UPDATE writes
 * `customer_price = round2(card x 1.12)` over whatever the row held. So the
 * mow could not move at the three doorways the brief named — and could move at
 * the fourth, where a real crew on Pretty Lake taps Claim. (The Haven's grounds
 * property carries `lake_id` = Pretty Lake, `is_fixture` false: verified on
 * production, it is on the real board.)
 *
 * Driven through the REAL `claimJob` with the database faked, because the
 * defect is a disagreement between a decision and an UPDATE — the money is in
 * the payload, not in the return value.
 *
 * SEEDED, NEVER RECOMPUTED: the park's row prices the mow at $125 (base 20 +
 * $5 x 21 live lots, Mike's Advantage Lawn Care arrangement); the claiming
 * crew's own card says $100. Both are typed.
 */

type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; payload: Row }> = [];

vi.mock("@/lib/supabase/server", () => {
  const MUTATIONS = ["insert", "update", "delete", "upsert"];
  const resolve = (table: string, calls: Array<[string, unknown[]]>) => {
    const names = calls.map((c) => c[0]);
    const mut = calls.find((c) => MUTATIONS.includes(c[0]));
    if (mut) {
      writes.push({ table, op: mut[0], payload: (mut[1][0] ?? {}) as Row });
      return { data: [{ id: "job-1" }], error: null };
    }
    const data = rows[table] ?? [];
    if (names.includes("maybeSingle") || names.includes("single")) {
      return { data: data[0] ?? null, error: null };
    }
    return { data, error: null };
  };
  const table = (name: string) => {
    const calls: Array<[string, unknown[]]> = [];
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve(resolve(name, calls)).then(ok, bad);
        }
        return (...args: unknown[]) => { calls.push([String(prop), args]); return proxy; };
      },
    });
    return proxy;
  };
  return {
    createServiceClient: () => ({ from: (name: string) => table(name) }),
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    }),
  };
});

const settings = {
  marginFloor: 0.2,
  platformFeeCustomerPct: 0.12,
  platformFeeCrewPct: 0.12,
  sameDaySurchargePct: 0.25,
  sameDayCutoffHour: 12,
  sameDayFillDiscountPct: 0.1,
  gapMinOffer: 0,
  lakeDemotionCooldownDays: 30,
};
vi.mock("@/lib/settings", () => ({ getPlatformSettings: async () => settings }));
vi.mock("@/lib/notify", () => ({ notify: async () => undefined }));
vi.mock("./open-data", () => ({ loadGapAnchor: async () => null }));

/** Is the claimed job on a park's grounds, and does that park hold a rate? */
let isPark = false;
let parkHasOwnRate = false;
let parkRateReadFailed = false;

vi.mock("@/app/book/dispatch", () => ({
  loadPricingProfileById: async () => ({
    sqft: 0, beds: 0, baths: 0, pier_sections: 0, boat_lifts: 0, toy_lifts: 0,
    jet_skis: 0, pwc_lifts: 0, panes: 0, lawn_band: "medium", drive_band: null,
    boats: [], toys: [],
    // 21 live lots and WHICH park — the two facts `groundsFor` puts on the
    // profile, and the second is the one precedence turns on.
    ...(isPark ? { lots: 21, parkId: "park-1" } : {}),
  }),
}));

vi.mock("@/app/park/rate-data", () => ({
  parkRatesForProfile: async () => ({
    rates: isPark
      // base 20 + $5 x 21 lots = $125. Typed, not recomputed.
      ? (parkHasOwnRate ? new Map([["svc-mow", { base: 125, unit_rate: 0, note: "Advantage Lawn Care" }]]) : new Map())
      : null,
    failed: parkRateReadFailed,
  }),
}));

import { claimJob } from "./open-actions";

const claimWrite = () =>
  writes.find((w) => w.table === "jobs" && w.op === "update" && w.payload.vendor_id != null);

const job = (over: Row = {}) => ({
  id: "job-1",
  property_id: "prop-1",
  service_id: "svc-mow",
  date: "2026-10-06", // a Tuesday
  status: "requested",
  customer_price: 125,
  vendor_id: null,
  group_id: null,
  is_rush: false,
  created_at: "2026-10-01T12:00:00Z",
  est_minutes: 60,
  services: {
    name: "Park grounds mowing & trim",
    pricing_model: "flat",
    est_minutes: 60,
    takes_custody: false,
    // THE FLIP. Nothing in production is crew_priced today; this file is the
    // answer to "what if somebody flips the mow tomorrow".
    crew_priced: true,
  },
  properties: { lake_id: "lake-1", address: "9085 E 500 S" },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
  isPark = false;
  parkHasOwnRate = false;
  parkRateReadFailed = false;
  for (const k of Object.keys(rows)) delete rows[k];
  writes.length = 0;
  rows.vendors = [{
    id: "crew-1", status: "active", coi_expiry: "2027-06-01", coi_named_insured: null,
    service_types: ["Park grounds mowing & trim"], service_lakes: ["lake-1"],
    work_days: ["Mon", "Tue", "Wed", "Thu", "Fri"], daily_capacity: 4,
    base_lat: null, base_lng: null, company: "A Crew LLC",
  }];
  // The claiming crew's own card: $100 flat for this service.
  rows.vendor_rates = [{ base: 100, unit_rate: 0, band_pricing: null }];
  rows.vendor_availability = [];
  rows.crew_units = [];
  rows.jobs = [job()];
});
afterEach(() => vi.useRealTimers());

describe("THE MOW MUST NOT MOVE — at the doorway that writes the price", () => {
  it("a park with its own rate keeps its $125: no fee, no quote, no new price", async () => {
    isPark = true;
    parkHasOwnRate = true;

    const out = await claimJob("job-1");
    expect(out.ok, out.error).toBe(true);

    const w = claimWrite();
    expect(w, "nothing was claimed at all").toBeTruthy();
    const p = (w as { payload: Row }).payload;

    // THE ASSERTION THIS FILE EXISTS FOR. On the crew-card path this write
    // carries customer_price; here it must not carry it at all, because the
    // park's $125 is the price and nobody on the board may re-set it.
    expect(p).not.toHaveProperty("customer_price");
    expect(p).not.toHaveProperty("crew_quote");
    expect(p).not.toHaveProperty("fee_customer_pct");
    expect(p).not.toHaveProperty("fee_crew_pct");
    // The menu path, byte for byte: the crew's card IS their take-home, and
    // margin is what is left of the park's number.
    expect(p.vendor_cost).toBe(100);
    expect(p.margin).toBe(25); // 125 − 100, both seeded
  });

  it("a park with NO rate takes the crew's card, which is the whole correction", async () => {
    // Snow, the two common-area cleanups, the dock: no park rate, and for snow
    // no crew and no plow either. A contractor onboarding with their own number
    // is how The Haven gets cleared, and this is that path.
    isPark = true;
    parkHasOwnRate = false;
    // Born unpriced, exactly as createBooking writes it on the crew-card path.
    rows.jobs = [job({ customer_price: null })];

    const out = await claimJob("job-1");
    expect(out.ok, out.error).toBe(true);
    const p = (claimWrite() as { payload: Row }).payload;

    // 100 x 1.12 = 112, 100 x 0.88 = 88, and the two ends tie to the margin.
    expect(p.crew_quote).toBe(100);
    expect(p.customer_price).toBe(112);
    expect(p.vendor_cost).toBe(88);
    expect(p.margin).toBe(24);
    expect(Number(p.customer_price) - Number(p.vendor_cost)).toBeCloseTo(Number(p.margin), 10);
  });

  it("a lake house on a crew-priced service is untouched by any of this", async () => {
    isPark = false;
    rows.jobs = [job({ customer_price: null })];

    const out = await claimJob("job-1");
    expect(out.ok, out.error).toBe(true);
    const p = (claimWrite() as { payload: Row }).payload;
    expect(p.crew_quote).toBe(100);
    expect(p.customer_price).toBe(112);
    expect(p.vendor_cost).toBe(88);
  });

  it("a FAILED read of what the park pays claims nothing, rather than guessing", async () => {
    // An unread rate map says "this park has no rate", which is the crew-card
    // answer — and the crew-card answer here overwrites a negotiated number.
    // A failed read is not an empty one, so the claim is refused and the job
    // stays on the board.
    isPark = true;
    parkHasOwnRate = true;
    parkRateReadFailed = true;

    const out = await claimJob("job-1");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/couldn't|could not/i);
    expect(claimWrite(), "a claim landed on a failed read").toBeFalsy();
  });
});
