import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE MONTH THAT GOES DARK FOR A REASON NOBODY IS TOLD.
 *
 * `getServiceAvailability` decides two things about a lake: whether we are
 * cold-starting (no crew yet — keep every date open, show the honest "finding
 * you a crew" banner, let the booking become a waitlist row) and, if not,
 * which dates are full. Cold start used to be decided on `status === "active"`
 * alone, while the per-date loop underneath went through the router's own
 * canEverDo — so ONE active crew with a lapsed certificate passed the first
 * test and failed every date of the month. The customer got a wall of grey
 * squares, each one titled "Crew at capacity" when nothing was at capacity,
 * the banner suppressed, and no sentence anywhere explaining it.
 *
 * Nothing in the product flips `status` when a certificate runs out — no
 * trigger, no cron — so "active with a lapsed COI" is the designed steady
 * state, and certificates lapse every year. The first real crew on a lake is
 * the ONLY crew on that lake, which is exactly the case that goes dark.
 *
 * Driven through the real function with only the database faked, because the
 * defect is the disagreement between two questions asked in one file — a
 * source scan would have to guess at it.
 */

const rows: Record<string, Array<Record<string, unknown>>> = {};

vi.mock("@/lib/supabase/server", () => {
  // One chainable stub: every builder method returns itself, and awaiting it
  // yields that table's rows. The real client's filters are irrelevant here —
  // the test supplies exactly the pool the query would have returned.
  const table = (name: string) => {
    const result = { data: rows[name] ?? [], error: null };
    const chain: Record<string | symbol, unknown> = {};
    const proxy: unknown = new Proxy(chain, {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(ok, bad);
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return { createServiceClient: () => ({ from: (name: string) => table(name) }) };
});

import { getServiceAvailability } from "./dispatch";

/** A crew who does this work, on this lake, with an open week. */
const greenEdge = (over: Record<string, unknown> = {}) => ({
  id: "v1",
  status: "active",
  coi_expiry: "2027-06-01",
  coi_named_insured: null,
  company: "GreenEdge Lawn Co.",
  service_types: ["Lawn Mowing"],
  service_lakes: ["lake-1"],
  work_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  daily_capacity: 4,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T17:00:00Z")); // a Tuesday on the lake
  for (const k of Object.keys(rows)) delete rows[k];
  rows.vendor_availability = [];
  rows.jobs = [];
  rows.crew_units = [];
});
afterEach(() => vi.useRealTimers());

const october = () => getServiceAvailability("Lawn Mowing", 2026, 9, "lake-1");

describe("a certificate that lapsed is not a calendar that is full", () => {
  it("the only crew's COI has lapsed — the month is NOT a wall of full dates", async () => {
    rows.vendors = [greenEdge({ coi_expiry: "2026-01-01" })];
    const a = await october();
    expect(a.fullDates).toEqual([]);
    expect(a.findingCrew).toBe(true);
    // And the capacity we quote is the capacity we could actually send.
    expect(a.capacity).toBe(0);
  });

  it("no certificate at all, and a certificate in someone else's name, read the same way", async () => {
    rows.vendors = [greenEdge({ coi_expiry: null })];
    expect((await october()).findingCrew).toBe(true);
    rows.vendors = [greenEdge({ coi_named_insured: "Somebody Else LLC" })];
    expect((await october()).findingCrew).toBe(true);
  });

  it("an invited or suspended crew is not a full calendar either", async () => {
    rows.vendors = [greenEdge({ status: "invited" })];
    expect((await october()).findingCrew).toBe(true);
    rows.vendors = [greenEdge({ status: "suspended" })];
    expect((await october()).findingCrew).toBe(true);
  });

  /* THE OTHER HALF OF THE BRANCH. Collapse the condition the other way — treat
     everybody as unroutable — and this fails, so the assertions above cannot
     be satisfied by a stub frozen on the safe side. */
  it("a crew in good standing still gets a real calendar, with weekends full", async () => {
    rows.vendors = [greenEdge()];
    const a = await october();
    expect(a.findingCrew).toBe(false);
    expect(a.capacity).toBe(4);
    // Saturdays and Sundays are outside their work days; weekdays are open.
    expect(a.fullDates).toContain("2026-10-03"); // Saturday
    expect(a.fullDates).toContain("2026-10-04"); // Sunday
    expect(a.fullDates).not.toContain("2026-10-05"); // Monday
    expect(a.fullDates.length).toBe(9); // every weekend day left in October
  });

  it("a genuinely full week is still reported full, not as cold start", async () => {
    rows.vendors = [greenEdge({ daily_capacity: 1 })];
    rows.jobs = [{ vendor_id: "v1", date: "2026-10-05" }];
    const a = await october();
    expect(a.findingCrew).toBe(false);
    expect(a.fullDates).toContain("2026-10-05");
  });
});

/**
 * WHICH GAP IS IT? The banner says one of two very different things: "new
 * water for us" (nobody works this lake) or "crews work your lake, but none of
 * them takes this service yet". That second sentence is false about a crew who
 * takes exactly this service and simply cannot be sent — so the lake question
 * has to apply the same standing-and-insurance rule the cold-start test does.
 */
describe("the gap it names", () => {
  it("a lapsed crew who does THIS service does not make it a service gap", async () => {
    rows.vendors = [greenEdge({ coi_expiry: "2026-01-01" })];
    const a = await october();
    expect(a.crewGap).toBe("lake");
  });

  it("a routable crew on the lake doing other work is still a service gap", async () => {
    rows.vendors = [greenEdge({ service_types: ["Housekeeping"] })];
    const a = await october();
    expect(a.findingCrew).toBe(true);
    expect(a.crewGap).toBe("service");
  });

  it("nobody on this lake at all is a lake gap", async () => {
    rows.vendors = [greenEdge({ service_lakes: ["lake-9"] })];
    expect((await october()).crewGap).toBe("lake");
  });
});
