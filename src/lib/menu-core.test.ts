import { describe, it, expect, vi } from "vitest";

// menu-core is a server-only module (every export of the old "use server"
// home was a network endpoint; see its header). The two imports it carries
// for that posture are inert here — the executor takes its admin client as a
// parameter, so the logic under test is reachable with a stub.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => null }));

import { executeMenuUpdate, type ApplyMenuSuggestionInput } from "./menu-core";

type Row = { id: string; name: string; base: number; unit_rate: number; band_pricing: unknown };

/**
 * The two calls executeMenuUpdate makes: one read of the services row, one
 * update. `writes` records what would have hit the database.
 */
function stubAdmin(row: Row | null) {
  const writes: Array<Record<string, unknown>> = [];
  const admin = {
    from() {
      return {
        select() {
          return { eq() { return { maybeSingle: async () => ({ data: row }) }; } };
        },
        update(patch: Record<string, unknown>) {
          writes.push(patch);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { admin: admin as never, writes };
}

const LAWN: Row = {
  id: "svc-lawn",
  name: "Lawn mowing & trim",
  base: 0,
  unit_rate: 0,
  band_pricing: { small: 65, medium: 85, large: 110 },
};

const CLEAN: Row = {
  id: "svc-clean",
  name: "Housekeeping",
  base: 0,
  unit_rate: 0,
  band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] },
};

const apply = (row: Row | null, input: Omit<ApplyMenuSuggestionInput, "serviceId">) => {
  const { admin, writes } = stubAdmin(row);
  return executeMenuUpdate(admin, { serviceId: row?.id ?? "svc-lawn", ...input }).then((res) => ({ res, writes }));
};

// ── Audit bug 6: a one-tap price raise can invert the ladder ────────────
// Margin Health only ever proposes the MIDDLE rung, and the 40% cap is
// measured against that rung's own current value — never the rung above.
// 85 × 1.4 = 119 clears the cap and lands above the $110 large band; the
// profile wizard then shows a medium lawn costing more than a large one.
// 185 of 1,100 simulated properties were exposed.
describe("executeMenuUpdate — the band ladder can never invert", () => {
  it("refuses a medium band that would cost more than large, and writes nothing", async () => {
    const { res, writes } = await apply(LAWN, { field: "band:medium", newValue: 118 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/large/i);
    expect(res.error).toMatch(/110/);
    expect(writes).toEqual([]);
  });

  it("refuses a medium band that would drop below small", async () => {
    const { res, writes } = await apply(LAWN, { field: "band:medium", newValue: 60 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/small/i);
    expect(writes).toEqual([]);
  });

  it("allows a raise that keeps small ≤ medium ≤ large", async () => {
    const { res, writes } = await apply(LAWN, { field: "band:medium", newValue: 105 });
    expect(res.ok).toBe(true);
    expect(writes).toEqual([{ band_pricing: { small: 65, medium: 105, large: 110 } }]);
  });

  it("equal rungs are a legal ladder (non-decreasing, not strictly increasing)", async () => {
    const { res } = await apply(LAWN, { field: "band:medium", newValue: 110 });
    expect(res.ok).toBe(true);
  });

  it("a band with no large rung on file has no ceiling to violate", async () => {
    const row: Row = { ...LAWN, band_pricing: { small: 65, medium: 85 } };
    const { res } = await apply(row, { field: "band:medium", newValue: 115 });
    expect(res.ok).toBe(true);
  });

  it("the 40% cap still bites before the ladder check", async () => {
    const row: Row = { ...LAWN, band_pricing: { small: 65, medium: 85, large: 400 } };
    const { res } = await apply(row, { field: "band:medium", newValue: 200 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/40% cap/);
  });
});

describe("executeMenuUpdate — the sqft tier ladder can never invert", () => {
  it("refuses a mid tier priced above the tier above it, and writes nothing", async () => {
    // 133 ≤ 95 × 1.4 clears the cap; the top tier is 120.
    const { res, writes } = await apply(CLEAN, { field: "tier:mid", newValue: 133 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/120/);
    expect(writes).toEqual([]);
  });

  it("refuses a mid tier priced below the tier below it", async () => {
    const { res, writes } = await apply(CLEAN, { field: "tier:mid", newValue: 70 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/80/);
    expect(writes).toEqual([]);
  });

  it("allows a mid tier that stays inside its neighbours", async () => {
    const { res, writes } = await apply(CLEAN, { field: "tier:mid", newValue: 115 });
    expect(res.ok).toBe(true);
    expect(writes).toEqual([{
      band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 115 }, { max: null, price: 120 }] },
    }]);
  });

  it("a two-tier service still respects the tier below the mid index", async () => {
    const row: Row = { ...CLEAN, band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: null, price: 120 }] } };
    // midIdx = 1 (the top tier): nothing above it, but 70 < 80 below it.
    const { res } = await apply(row, { field: "tier:mid", newValue: 70 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/80/);
  });

  it("a single-tier service has no ladder to break", async () => {
    const row: Row = { ...CLEAN, band_pricing: { tiers: [{ max: null, price: 100 }] } };
    const { res } = await apply(row, { field: "tier:mid", newValue: 130 });
    expect(res.ok).toBe(true);
  });
});

describe("executeMenuUpdate — untouched paths", () => {
  it("base and unit_rate have no ladder and still apply under the cap", async () => {
    const row: Row = { ...LAWN, base: 430, unit_rate: 48 };
    expect((await apply(row, { field: "base", newValue: 480 })).res.ok).toBe(true);
    expect((await apply(row, { field: "unit_rate", newValue: 60 })).res.ok).toBe(true);
  });
  it("a missing service is still refused", async () => {
    const { res } = await apply(null, { field: "band:medium", newValue: 90 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });
  it("a non-positive value is still refused", async () => {
    const { res } = await apply(LAWN, { field: "band:medium", newValue: 0 });
    expect(res.ok).toBe(false);
  });
});
