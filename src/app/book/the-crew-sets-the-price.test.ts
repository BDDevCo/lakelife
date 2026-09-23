import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE DOORWAY WHERE A CREW'S QUOTE BECOMES A CUSTOMER'S PRICE (0174).
 *
 * `platform-fee.ts` proves the arithmetic and `lib/dispatch.ts` proves the
 * ranking. Neither of them can prove the thing that actually bills a person:
 * that `autoAssignJob` writes all five money columns, from the decision, in
 * one statement, and that they tie. 0174's jobs_crew_price_all_or_nothing
 * CHECK refuses a half-frozen row — a constraint is where you find out you
 * forgot a column, not where you plan to.
 *
 * And the other half, which is the one that can quietly cheat a real person:
 * a job that has ALREADY been quoted and confirmed must never have its price
 * rewritten by a crew swap. Four paths drop a crew and come back through this
 * function — the nightly self-heal (whose own comment says "silent"), both
 * capacity backstops and the custody release. Under a menu price they were
 * harmless. Under crew pricing, the cheapest crew on the lake taking a
 * Tuesday off rewrites a number the customer said yes to, at night.
 *
 * Driven through the REAL function with only the database and the two
 * settings faked, because every defect here is a disagreement between the
 * decision and the UPDATE — a source scan would have to guess at it.
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
      // A returned row = "the write stuck", which is what autoAssignJob's
      // optimistic-assign check reads.
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
  return { createServiceClient: () => ({ from: (name: string) => table(name) }) };
});

const settings = {
  marginFloor: 0.2,
  platformFeeCustomerPct: 0.12,
  platformFeeCrewPct: 0.12,
  sameDaySurchargePct: 0.25,
  sameDayCutoffHour: 12,
  sameDayFillDiscountPct: 0.1,
};
vi.mock("@/lib/settings", () => ({ getPlatformSettings: async () => settings }));
vi.mock("@/lib/scoring-data", () => ({ getVendorScores: async () => new Map() }));
// A lake house, not a park's grounds. The park fence is exercised by its own
// case below, which turns this back on.
let isPark = false;
vi.mock("@/app/park/rate-data", () => ({
  groundsFor: async () => (isPark ? { parkId: "park-1", lots: 21 } : null),
  loadParkRatesChecked: async () => ({ rates: new Map(), failed: false }),
}));

import { autoAssignJob } from "./dispatch";

/** A crew who does this work, on this lake, with an open Tuesday. */
const crew = (id: string, over: Row = {}) => ({
  id,
  status: "active",
  coi_expiry: "2027-06-01",
  coi_named_insured: null,
  company: "A Crew LLC",
  service_types: ["Window Washing"],
  service_lakes: ["lake-1"],
  work_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  daily_capacity: 4,
  base_lat: null,
  base_lng: null,
  storage_capacity_feet: 0,
  storage_types: [],
  garagekeepers_expiry: null,
  ...over,
});

/** That crew's own rate card for this service — a flat number they typed. */
const card = (vendorId: string, base: number) => ({
  vendor_id: vendorId, service_id: "svc-1", base, unit_rate: 0, band_pricing: null,
});

const job = (over: Row = {}) => ({
  id: "job-1",
  property_id: "prop-1",
  service_id: "svc-1",
  date: "2026-10-06", // a Tuesday
  status: "requested",
  customer_price: null,
  vendor_id: null,
  group_id: null,
  est_minutes: 60,
  pickup_lat: null,
  pickup_lng: null,
  crew_quote: null,
  fee_customer_pct: null,
  fee_crew_pct: null,
  services: {
    name: "Window Washing",
    pricing_model: "flat",
    est_minutes: 60,
    takes_custody: false,
    band_pricing: null,
    crew_priced: true,
  },
  ...over,
});

/** The UPDATE that assigns a crew — the only write that decides money. */
const assignWrite = () =>
  writes.find((w) => w.table === "jobs" && w.op === "update" && w.payload.vendor_id != null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
  isPark = false;
  for (const k of Object.keys(rows)) delete rows[k];
  writes.length = 0;
  rows.properties = [{ sqft: 0, beds: 0, baths: 0, preferred_vendor: null, lake_id: "lake-1", lat: null, lng: null }];
  rows.property_profile = [{ pier_sections: 0, boat_lifts: 0, panes: 12 }];
  rows.boats = [];
  rows.toys = [];
  rows.vendor_availability = [];
  rows.crew_units = [];
  rows.storage_stays = [];
  rows.vendor_rates = [];
  rows.vendors = [];
  rows.jobs = [job()];
});
afterEach(() => vi.useRealTimers());

describe("a crew-priced booking writes five money columns that tie", () => {
  it("the $50 crew wins over the $70 one, and the customer pays $56 while the crew is paid $44", async () => {
    // THE IDS ARE CHOSEN SO THE OLD KEY CANNOT PASS. A crew-priced service has
    // no menu price, so the caller passes menuPrice 0; marginPct(0, rate)
    // returns 0 for every crew, the old "higher margin first" key ties, and
    // the winner falls through to the stable vendorId tie-break — "aaa-dear",
    // the $70 crew. Under crew pricing the old key does not rank wrong, it
    // goes DEAD and the winner becomes alphabetical.
    rows.vendors = [crew("aaa-dear"), crew("zzz-cheap")];
    rows.vendor_rates = [card("aaa-dear", 70), card("zzz-cheap", 50)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(true);
    expect(out.vendorId).toBe("zzz-cheap");

    const w = assignWrite();
    expect(w, "no crew was assigned at all").toBeTruthy();
    const p = (w as { payload: Row }).payload;

    // The five, together, in ONE statement — 0174's CHECK refuses a row that
    // carries some of them.
    expect(p.crew_quote).toBe(50);
    expect(p.fee_customer_pct).toBe(0.12);
    expect(p.fee_crew_pct).toBe(0.12);
    expect(p.customer_price).toBe(56);
    expect(p.vendor_cost).toBe(44); // what we PAY — payouts.amount ties to this
    expect(p.margin).toBe(12);

    // AND THEY TIE. Not recomputed from the percentages — subtracted from the
    // two numbers this write actually put on the row, which is the identity
    // every invoice and payout reader depends on.
    expect(Number(p.customer_price) - Number(p.vendor_cost)).toBeCloseTo(Number(p.margin), 10);

    // The price the caller hands the confirmation email is the price on the row.
    expect(out.customerPrice).toBe(56);
  });

  it("carries the cents rather than rounding to dollars — $416 is $465.92, not $466", async () => {
    // Seeded, not recomputed: 416 × 1.12 = 465.92 and 416 × 0.88 = 366.08 are
    // arithmetic a person can check on a calculator, which is now BOTH sides
    // of this transaction.
    rows.vendors = [crew("v1")];
    rows.vendor_rates = [card("v1", 416)];
    await autoAssignJob("job-1");
    const p = (assignWrite() as { payload: Row }).payload;
    expect(p.customer_price).toBe(465.92);
    expect(p.vendor_cost).toBe(366.08);
    expect(p.margin).toBe(99.84);
  });
});

describe("the menu path is untouched", () => {
  it("a service that is not crew-priced freezes nothing and pays the crew their rate", async () => {
    rows.jobs = [job({
      customer_price: 200,
      services: { name: "Window Washing", pricing_model: "flat", est_minutes: 60, takes_custody: false, band_pricing: null, crew_priced: false },
    })];
    rows.vendors = [crew("v1")];
    rows.vendor_rates = [card("v1", 50)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(true);
    const p = (assignWrite() as { payload: Row }).payload;
    expect(p.vendor_cost).toBe(50); // their rate, in full — not 44
    expect(p.margin).toBe(150);
    expect(p).not.toHaveProperty("crew_quote");
    expect(p).not.toHaveProperty("fee_customer_pct");
    expect(p).not.toHaveProperty("customer_price"); // the caller wrote it
    expect(out.customerPrice).toBeUndefined();
  });

  it("PARK GROUNDS TAKE THE MENU PATH even when the service says crew_priced", async () => {
    // The Haven's mow is $125 Mike negotiated. 0174's CHECK stops a park_only
    // service being crew-priced; nothing stops a park's grounds booking an
    // ordinary one, and a stranger's card must not quote work a park has its
    // own rate for. Park rates never combine.
    isPark = true;
    rows.jobs = [job({ customer_price: 125 })]; // crew_priced: true on the service
    rows.vendors = [crew("v1")];
    rows.vendor_rates = [card("v1", 50)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(true);
    const p = (assignWrite() as { payload: Row }).payload;
    expect(p).not.toHaveProperty("crew_quote");
    expect(p).not.toHaveProperty("customer_price");
    expect(p.vendor_cost).toBe(50);
    expect(p.margin).toBe(75); // 125 − 50, the park's price less the crew's rate
  });
});

describe("a crew swap cannot rewrite a price the customer agreed to", () => {
  /** A job already quoted at $50 and confirmed to the customer at $56. */
  const agreed = (over: Row = {}) =>
    job({ crew_quote: 50, fee_customer_pct: 0.12, fee_crew_pct: 0.12, customer_price: 56, ...over });

  it("the only crew left quotes $70 — the job is NOT reassigned and NOT repriced", async () => {
    rows.jobs = [agreed()];
    rows.vendors = [crew("v-dear")];
    rows.vendor_rates = [card("v-dear", 70)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(false);
    expect(assignWrite(), "a crew was assigned at a price nobody agreed to").toBeUndefined();
    // And nothing at all was written to the row: not the new price, not the
    // new quote, not a status change.
    expect(writes.filter((w) => w.table === "jobs" && w.op === "update")).toHaveLength(0);
  });

  it("a crew who quotes the SAME $50 still takes it, and the frozen three are left alone", async () => {
    // Nothing the customer agreed to has changed, so this swap is invisible
    // and harmless — which is the whole reason the guard compares the PRICE
    // rather than refusing every re-assignment.
    rows.jobs = [agreed()];
    rows.vendors = [crew("v-new")];
    rows.vendor_rates = [card("v-new", 50)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(true);
    const p = (assignWrite() as { payload: Row }).payload;
    expect(p.vendor_id).toBe("v-new");
    expect(p.vendor_cost).toBe(44);
    expect(p.margin).toBe(12);
    // Re-freezing would be the doorway through which a dial change reprices
    // sold work, so the already-frozen three are not rewritten.
    expect(p).not.toHaveProperty("crew_quote");
    expect(p).not.toHaveProperty("fee_customer_pct");
    expect(p).not.toHaveProperty("customer_price");
    expect(out.customerPrice).toBeUndefined();
  });

  it("reprices against the job's OWN frozen percentages, never tonight's dials", async () => {
    // The dials move to 20/20 after this job was sold. The crew's quote is
    // unchanged at $50, so the agreed price must still be $56 — at the live
    // dial it would be $60 and the guard would refuse the crew outright.
    settings.platformFeeCustomerPct = 0.2;
    settings.platformFeeCrewPct = 0.2;
    try {
      rows.jobs = [agreed()];
      rows.vendors = [crew("v-new")];
      rows.vendor_rates = [card("v-new", 50)];

      const out = await autoAssignJob("job-1");
      expect(out.assigned).toBe(true);
      const p = (assignWrite() as { payload: Row }).payload;
      expect(p.vendor_cost).toBe(44); // 50 × (1 − 0.12), the frozen crew side
      expect(p.margin).toBe(12); // 56 − 44, the frozen customer side
    } finally {
      settings.platformFeeCustomerPct = 0.12;
      settings.platformFeeCrewPct = 0.12;
    }
  });
});

describe("why there is no price, when there is none", () => {
  it("cards exist and every one prices this property at $0 — that is not a wait for a crew", async () => {
    // A pier crew's card is $30 a section against a property with no pier.
    // Nobody will ever quote it, so telling this customer we are finding them
    // a crew would be a wait that can never end.
    rows.jobs = [job({
      services: { name: "Pier Removal", pricing_model: "per_section", est_minutes: 60, takes_custody: false, band_pricing: null, crew_priced: true },
    })];
    rows.vendors = [crew("v1", { service_types: ["Pier Removal"] })];
    rows.vendor_rates = [{ vendor_id: "v1", service_id: "svc-1", base: 0, unit_rate: 30, band_pricing: null }];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(false);
    expect(out.pricedToZero).toBe(true);
    expect(out.decision.reasonNoFit).toBe("no_qualifying_rate");
  });

  it("nobody has set a rate for this work yet — that IS an honest wait", async () => {
    // Same empty result from the engine, opposite cause and opposite sentence:
    // the crew is capable and available, they simply have no card for it. That
    // is real demand and a recruiting signal, so the booking stays.
    rows.vendors = [crew("v1")];
    rows.vendor_rates = []; // no card at all

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(false);
    expect(out.pricedToZero).toBe(false);
    expect(out.decision.reasonNoFit).toBe("no_qualifying_rate");
  });

  it("no crew on the lake leaves the job unpriced and unassigned, never at $0", async () => {
    rows.vendors = [];
    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(false);
    expect(out.pricedToZero).toBe(false);
    expect(writes.filter((w) => w.table === "jobs" && w.op === "update")).toHaveLength(0);
  });
});
