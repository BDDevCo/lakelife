import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * RETIRING A LOT OUT FROM UNDER A HOUSEHOLD WHOSE LEASE RAN OUT.
 *
 * `setLotLifecycle` has had an occupancy guard since it was written, and its
 * comment states the harm exactly: "taking the lot out from under a live
 * tenancy would leave them billable but off every screen." It asked
 * `today < r.end` — the fourth doorway to answer "is anybody on this lot"
 * inline, and the fourth to answer it differently.
 *
 * `lapsedRowOf` is the one rule, and its own docstring says so: "the roll
 * (buildRentRoll), Today's occupancy (today-actions) and the nightly's
 * `tenancy_expired` (park-machine)" all decide `lapsed` through it. A LAPSED
 * household — a monthly tenancy that ran out with nothing current, nothing
 * coming and no close-out behind it — has `end <= today` on every held row by
 * definition. So `held` was false, the retire was accepted with "Its history
 * and money stay put.", and `lotOccupancy` went on counting that lot occupied
 * while the roll printed "Ran out". This door alone thought it was empty.
 *
 * WHAT IT COSTS, which is why this is not cosmetic. The rent preview and the
 * charge run both filter `lifecycle = 'live'`, so no bill is ever raised for
 * that household again — and with no bill there is nothing for them to dispute
 * and no money to record against them. They also drop off "Agreements to
 * write", the one list that would renew them, and out of the nightly's scope,
 * so `tenancy_expired` stops firing for the household whose tenancy expired.
 *
 * A monthly Haven lease signed 1 January 2027 that runs out un-renewed is this
 * row exactly.
 *
 * BOTH DIRECTIONS ARE COLLAPSED HERE. A guard that refused every retirement
 * would pass the first test on its own, so a lot whose household properly moved
 * out must still retire — which is why the read includes 'ended' rows.
 */

// `park_id` is read by actions.ts's own assertLotIsMine (actions:74), which
// resolves the lot to its park before membership is asserted.
const lots = [{ id: "lot-9", park_id: "park-1", lot_number: "9", lifecycle: "live" }];
let stays: Array<{ during: string; status: string; term: string }> = [];
let staysError: unknown = null;
const updates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === "park_lots") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: lots[0], error: null }) }),
          }),
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              updates.push(row);
              return { error: null };
            },
          }),
        };
      }
      if (table === "lot_reservations") {
        return {
          select: () => ({
            eq: () => ({ in: async () => ({ data: staysError ? null : stays, error: staysError }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("./data", () => ({ assertMyPark: async () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  todayLakeDate: () => "2027-03-05",
}));

const { setLotLifecycle } = await import("./actions");

/** A held row, written the way lot_reservations stores one: a daterange. */
const stay = (start: string, end: string, status = "active", term = "monthly") =>
  ({ during: `[${start},${end})`, status, term });

beforeEach(() => {
  stays = [];
  staysError = null;
  updates.length = 0;
});

describe("retiring a lot whose household is still there", () => {
  it("refuses when the paperwork ran out and nobody renewed or closed it", async () => {
    // January–February, monthly, never renewed. Nobody moved out: still 'active'.
    stays = [stay("2027-01-01", "2027-03-01")];

    const res = await setLotLifecycle("park-1", "lot-9", "retired");

    expect(res.ok, "a lapsed household was retired out from under").toBe(false);
    // NAMES THE STATE AND THE REMEDY. There is no tenancy to end here, so
    // "End that first" would send him looking for a control that does not
    // apply — there is paperwork to finish.
    expect(res.error).toMatch(/still there on paperwork that ran out/i);
    expect(res.error).toMatch(/Renew them or close them out first/i);
    // A day a person reads, never 2027-03-01.
    expect(res.error).toMatch(/March 1, 2027/);
    expect(res.error).not.toMatch(/2027-03-01/);
    // AND NOTHING WAS WRITTEN. A refusal that still retired the lot would have
    // done the damage and then said it had not.
    expect(updates).toEqual([]);
  });

  it("still refuses a tenancy that is live today, in the words it always used", async () => {
    stays = [stay("2027-03-01", "2027-04-01")];

    const res = await setLotLifecycle("park-1", "lot-9", "retired");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Somebody is on lot 9, or is booked onto it/);
    expect(updates).toEqual([]);
  });

  it("and one booked to arrive later", async () => {
    stays = [stay("2027-06-01", "2027-07-01", "approved")];

    const res = await setLotLifecycle("park-1", "lot-9", "retired");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Somebody is on lot 9, or is booked onto it/);
  });

  it("LETS A PROPERLY CLOSED-OUT LOT RETIRE — the branch collapsed the other way", async () => {
    // Without the 'ended' row in the read, lapsedRowOf would call this lapsed
    // and no tidy lot could ever be retired again: a worse bug than the one
    // being fixed, and one this test exists to catch.
    stays = [
      stay("2027-01-01", "2027-03-01", "active"),
      stay("2027-01-01", "2027-03-01", "ended"),
    ];

    const res = await setLotLifecycle("park-1", "lot-9", "retired");

    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toMatch(/Lot 9 is retired/);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ lifecycle: "retired" });
  });

  it("lets an empty lot retire", async () => {
    stays = [];

    const res = await setLotLifecycle("park-1", "lot-9", "retired");

    expect(res.ok, res.error).toBe(true);
    expect(updates[0]).toMatchObject({ lifecycle: "retired" });
  });

  it("refuses rather than retiring blind when the read fails", async () => {
    staysError = { code: "57P01", message: "terminating connection due to administrator command" };

    const res = await setLotLifecycle("park-1", "lot-9", "retired");

    expect(res.ok, "a dropped read retired the lot").toBe(false);
    expect(updates).toEqual([]);
  });

  it("does not stand in the way of putting a lot BACK to live", async () => {
    // The guard is for taking a lot out of service. A lapsed household is the
    // very reason you might set it live again.
    stays = [stay("2027-01-01", "2027-03-01")];

    const res = await setLotLifecycle("park-1", "lot-9", "live");

    expect(res.ok, res.error).toBe(true);
    expect(updates[0]).toMatchObject({ lifecycle: "live" });
  });
});
