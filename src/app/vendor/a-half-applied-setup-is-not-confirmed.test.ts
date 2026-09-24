import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A SETUP THAT ONLY HALF SAVED MUST NOT BE MARKED CONFIRMED.
 *
 * Settling the proposal removes the card — and the card is the ONLY screen that
 * knows anything is outstanding. A crew whose lakes saved but whose rate did
 * not, with the card gone, is a crew who believes they are set up, sitting
 * behind a gap they cannot see and will not be told about: dispatch simply
 * never offers them the work they have no price for, silently, forever.
 *
 * THIS IS A BEHAVIOURAL TEST ON PURPOSE. The first version of it pinned the
 * ORDER of two strings in the source — `left.length > 0` appearing before
 * `settled_as: "confirmed"` — and a deliberate break (`if (false && ...)`)
 * sailed straight past it, which is the definition of a test that pins
 * nothing. So it runs the real action against a stubbed database and watches
 * what it writes.
 */

const writes: Array<{ table: string; op: string; payload: unknown }> = [];
let proposalRow: { id: string } | null = { id: "prop-1" };
let lakesResult = { ok: true };
let rateResult = { ok: true };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-crew" } } }) },
  }),
  createServiceClient: () => {
    const chain = (table: string) => ({
      select: () => chain(table),
      eq: () => chain(table),
      is: () => chain(table),
      maybeSingle: async () => ({ data: proposalRow, error: null }),
      update: (payload: unknown) => {
        writes.push({ table, op: "update", payload });
        return { eq: () => ({ is: async () => ({ error: null }) }), is: async () => ({ error: null }) };
      },
    });
    return { from: (table: string) => chain(table) };
  },
}));

vi.mock("./data", () => ({ getMyVendorId: async () => "v-1" }));
vi.mock("./onboarding-actions", () => ({
  setServiceLakes: async () => lakesResult,
  setDailyCapacity: async () => ({ ok: true }),
}));
vi.mock("./rates-actions", () => ({ setMyRate: async () => rateResult }));

const { confirmMySetup } = await import("./setup-actions");

const INPUT = {
  proposalId: "prop-1",
  lakeIds: ["l-1"],
  workDays: ["Mon", "Tue"],
  dailyCapacity: 4,
  rates: [{ serviceId: "s-1", payload: { base: "0", unitRate: "50", band: {} } }],
};

/** Did the action mark the proposal settled? */
const settled = () =>
  writes.some(
    (w) =>
      w.table === "crew_setup_proposals" &&
      (w.payload as { settled_as?: string })?.settled_as != null,
  );

beforeEach(() => {
  writes.length = 0;
  proposalRow = { id: "prop-1" };
  lakesResult = { ok: true };
  rateResult = { ok: true };
});

describe("confirming a setup", () => {
  it("settles the proposal when everything saved", () => {
    // THE BASE CASE HAS TO PASS, or the failures below prove nothing: a test
    // that only ever asserts absence passes against an action that does nothing.
    return confirmMySetup(INPUT).then((res) => {
      expect(res.ok).toBe(true);
      expect(settled()).toBe(true);
      const row = writes.find((w) => w.table === "crew_setup_proposals")!
        .payload as { settled_as: string; settled_by: string };
      expect(row.settled_as).toBe("confirmed");
      // THE CREW, NEVER OPS. 0181's trigger refuses anything else, but the
      // action must not be the thing relying on that.
      expect(row.settled_by).toBe("u-crew");
    });
  });

  it("does NOT settle when a rate failed to save", async () => {
    rateResult = { ok: false, error: "Enter a valid dollar amount." } as typeof rateResult;
    const res = await confirmMySetup(INPUT);
    expect(res.ok).toBe(false);
    expect(res.partial).toContain("Enter a valid dollar amount.");
    expect(settled(), "a half-applied setup was marked confirmed").toBe(false);
  });

  it("does NOT settle when the lakes failed to save", async () => {
    // The worst of the three to lose silently: a crew with no lakes is never
    // offered anything, on any water, and nothing anywhere says why.
    lakesResult = { ok: false, error: "Big Long is paused for your crew right now." } as typeof lakesResult;
    const res = await confirmMySetup(INPUT);
    expect(res.ok).toBe(false);
    expect(res.partial).toContain("Big Long is paused for your crew right now.");
    expect(settled()).toBe(false);
  });

  it("says one thing once when three rates fail for the same reason", async () => {
    rateResult = { ok: false, error: "Enter a valid dollar amount." } as typeof rateResult;
    const res = await confirmMySetup({
      ...INPUT,
      rates: [
        { serviceId: "s-1", payload: {} },
        { serviceId: "s-2", payload: {} },
        { serviceId: "s-3", payload: {} },
      ],
    });
    expect(res.partial).toEqual(["Enter a valid dollar amount."]);
  });

  it("refuses a proposal id that is not the one waiting for this crew", async () => {
    // The id is a STALENESS CHECK, never a lookup key: the row is found by the
    // vendor id derived from the session, and the argument only has to agree.
    const res = await confirmMySetup({ ...INPUT, proposalId: "somebody-elses" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refresh/i);
    expect(writes).toHaveLength(0);
  });

  it("refuses when there is nothing waiting, and writes nothing", async () => {
    proposalRow = null;
    const res = await confirmMySetup(INPUT);
    expect(res.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
