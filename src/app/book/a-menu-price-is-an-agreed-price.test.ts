import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE JOB THAT WAS SOLD ON THE MENU AND WOKE UP CREW-PRICED.
 *
 * `services.crew_priced` got its writer this week (setServiceCrewPriced, the
 * ops card). Before that the flag could only be hand-edited, so the gap this
 * file pins was a theory. It is now a nightly job.
 *
 * THE CHAIN, WHICH IS ENTIRELY MADE OF THINGS THAT WERE INDIVIDUALLY RIGHT:
 *
 *   1. A menu booking is born `requested` with `customer_price` set to the
 *      number the customer was shown and `crew_quote` NULL (book/actions.ts).
 *      If no crew fits, it SITS there — the documented "Finding a crew"
 *      waitlist row. With zero real crews in production, that is every
 *      booking on the platform.
 *   2. Ops flips that service to crew-priced.
 *   3. The nightly cron self-heals: revalidateAssignments → revalidateJob →
 *      "a requested job just needs assignment" → autoAssignJob.
 *   4. `crew_priced` is read LIVE off `services`, never off the job — so this
 *      job is now on the crew-priced path.
 *   5. `agreedQuote` read `job.crew_quote`, which is null. It collapsed to 0,
 *      `agreedPrice` collapsed with it, and the anti-silent-reprice guard —
 *      `if (agreedPrice > 0 && …)` — was DISARMED on exactly the jobs it
 *      exists for.
 *   6. `wroteFreeze` went true, and `moneyCols` overwrote `customer_price`
 *      with the winning crew's quote × 1.12.
 *
 * The customer's agreed price, rewritten by cron, with nobody told — while the
 * ops card that caused it promised in as many words that booked work never
 * reprices.
 *
 * THE FIX IS THAT THE DURABLE SIGNAL IS THE PRICE, NOT THE QUOTE BESIDE IT. A
 * crew-priced booking is born with `customer_price` NULL — never 0, the
 * convention this file's own release path and the claim board both keep — so a
 * positive `customer_price` means somebody was told this number, whichever
 * model sold it. The claim board already read it that way
 * (`unpriced = job.customer_price == null`); this is the same rule in the
 * other doorway.
 *
 * DRIVEN THROUGH THE REAL FUNCTION. Every defect here is a disagreement
 * between the decision and the UPDATE; a source scan would have to guess.
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
vi.mock("@/app/park/rate-data", () => ({
  groundsFor: async () => null,
  loadParkRatesChecked: async () => ({ rates: new Map(), failed: false }),
}));

import { autoAssignJob } from "./dispatch";

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

const card = (vendorId: string, base: number) => ({
  vendor_id: vendorId, service_id: "svc-1", base, unit_rate: 0, band_pricing: null,
});

/**
 * THE JOB AT THE HEART OF THIS FILE: sold on the menu at a price the customer
 * was shown, still waiting for a crew, on a service that has since been
 * flipped. `crew_quote` null and `customer_price` positive is the combination
 * that used to disarm the guard.
 */
const job = (over: Row = {}) => ({
  id: "job-1",
  property_id: "prop-1",
  service_id: "svc-1",
  date: "2026-10-06", // a Tuesday
  status: "requested",
  customer_price: 200, // what the menu charged, and what the customer said yes to
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
    crew_priced: true, // ops flipped it after this job was sold
  },
  ...over,
});

const assignWrite = () =>
  writes.find((w) => w.table === "jobs" && w.op === "update" && w.payload.vendor_id != null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
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

describe("a job sold at the menu price keeps it when the service is flipped", () => {
  it("the nightly does NOT rewrite the customer's $200 to the crew's $56", async () => {
    // $50 × 1.12 = $56. Every figure here is a seeded input or typed-out
    // arithmetic over one: never recomputed from the expression under test.
    rows.vendors = [crew("v-1")];
    rows.vendor_rates = [card("v-1", 50)];

    const out = await autoAssignJob("job-1");

    expect(out.assigned, "a crew was assigned at a price nobody agreed to").toBe(false);
    expect(out.priceHeld).toBe(true);
    expect(assignWrite()).toBeUndefined();
    // Not the price, not a quote, not a status change. Nothing.
    expect(writes.filter((w) => w.table === "jobs" && w.op === "update")).toHaveLength(0);
  });

  it("and the held job's own row is never touched, so the waitlist copy stays true", async () => {
    rows.vendors = [crew("v-1")];
    rows.vendor_rates = [card("v-1", 50)];
    await autoAssignJob("job-1");
    const touched = writes.filter((w) => w.table === "jobs");
    expect(touched, JSON.stringify(touched)).toHaveLength(0);
  });

  it("a crew whose number lands on the SAME $200 takes it, and the price is left alone", async () => {
    // Collapsed the other way on purpose. A guard that refused every crew
    // would pass the test above while making the service unbookable, and the
    // absence-only version of this file could not tell the two apart.
    // 200 / 1.12 = 178.571…, which does not round to a clean quote, so the
    // fee dials are moved to 0 for this case and the crew's $200 is the
    // customer's $200.
    settings.platformFeeCustomerPct = 0;
    settings.platformFeeCrewPct = 0;
    try {
      rows.vendors = [crew("v-1")];
      rows.vendor_rates = [card("v-1", 200)];

      const out = await autoAssignJob("job-1");
      expect(out.assigned, "a matching crew was refused, which makes the service unbookable").toBe(true);
      const p = (assignWrite() as { payload: Row }).payload;
      expect(p.vendor_id).toBe("v-1");
      // THE ROW KEEPS THE NUMBER IT WAS SOLD AT. Re-freezing it would write
      // $200 over $200 harmlessly — and then hand the release paths below a
      // set of columns to CLEAR, which nulls the price of a job a customer
      // was quoted. That is the same money bug from the other end.
      expect(p).not.toHaveProperty("customer_price");
      expect(p).not.toHaveProperty("crew_quote");
      expect(p).not.toHaveProperty("fee_customer_pct");
      expect(p).not.toHaveProperty("fee_crew_pct");
    } finally {
      settings.platformFeeCustomerPct = 0.12;
      settings.platformFeeCrewPct = 0.12;
    }
  });
});

describe("the two shapes this must NOT break", () => {
  it("a genuine crew-priced booking — price NULL, nobody told yet — still gets priced", async () => {
    // This is the freeze path 0174 built, and the branch that would be lost
    // if "has a customer_price" were read as "has been agreed" without the
    // null convention behind it. $50 × 1.12 = $56; $50 × 0.88 = $44.
    rows.jobs = [job({ customer_price: null })];
    rows.vendors = [crew("v-1")];
    rows.vendor_rates = [card("v-1", 50)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(true);
    const p = (assignWrite() as { payload: Row }).payload;
    expect(p.crew_quote).toBe(50);
    expect(p.customer_price).toBe(56);
    expect(p.fee_customer_pct).toBe(0.12);
    expect(p.fee_crew_pct).toBe(0.12);
    expect(p.vendor_cost).toBe(44);
  });

  it("a MENU service is byte-for-byte unchanged — the new branch is fenced on crew_priced", async () => {
    // Same job, same positive price, service NOT flipped. The menu path never
    // freezes anything and never held anything, and must not start.
    rows.jobs = [job({ services: { ...job().services as Row, crew_priced: false } })];
    rows.vendors = [crew("v-1")];
    rows.vendor_rates = [card("v-1", 50)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(true);
    expect(out.priceHeld).toBeUndefined();
    const p = (assignWrite() as { payload: Row }).payload;
    expect(p.vendor_cost).toBe(50); // the crew's rate IS their take-home on the menu
    expect(p).not.toHaveProperty("customer_price");
    expect(p).not.toHaveProperty("crew_quote");
  });

  it("a crew-priced job carrying a real quote is still guarded by the quote", async () => {
    // The original 0174 case, unchanged: quote $50, agreed $56, a crew who
    // wants $70 is refused.
    rows.jobs = [job({ crew_quote: 50, fee_customer_pct: 0.12, fee_crew_pct: 0.12, customer_price: 56 })];
    rows.vendors = [crew("v-dear")];
    rows.vendor_rates = [card("v-dear", 70)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(false);
    expect(out.priceHeld).toBe(true);
  });

  it("a price of 0 is not an agreed price — zero is the platform's word for 'none'", async () => {
    // The convention the whole fix rests on, stated as a test. A 0 must not
    // arm the guard, or a legitimately unpriced job would be held forever.
    rows.jobs = [job({ customer_price: 0 })];
    rows.vendors = [crew("v-1")];
    rows.vendor_rates = [card("v-1", 50)];

    const out = await autoAssignJob("job-1");
    expect(out.assigned).toBe(true);
    const p = (assignWrite() as { payload: Row }).payload;
    expect(p.customer_price).toBe(56);
  });
});
