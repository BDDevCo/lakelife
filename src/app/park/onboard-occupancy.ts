/**
 * WHO IS ON A LOT, for the "Who lives here" screen — a PURE module, so the
 * rule can be run in a test rather than inferred from the door that calls it.
 *
 * Both doorways of that screen ask the same question — the read that draws the
 * grid, and the re-check the save makes before it writes — and for a long time
 * they asked a fourth version of it: `status in (approved, active)` with no
 * date test at all, so any row ever written on a lot held it off the screen
 * for ever. See `lotsSomebodyHolds` for what that cost.
 *
 * Plain module: no supabase, no env. Its callers hand it the rows.
 */

import { lotOccupancy } from "./today-helpers";

/**
 * WHICH LOTS SOMEBODY IS ON — the rule both doorways of the screen ask, asked
 * once, and asked of the helper the rest of the park module already asks.
 *
 * A lot is held when a household's record covers today, when one is still to
 * start on it, or when their paperwork ran out with them still living there.
 * That is three tests, and each of them has been got wrong somewhere before,
 * which is why `lotOccupancy` exists and why this composes it rather than
 * restating it: the roll, Today, the readiness list and this screen must never
 * be able to disagree about whether a lot is empty.
 *
 * THE DEFECT THIS PREVENTS. A move-out ends only the link covering the last
 * day and cancels the ones behind it (planMoveOut); every earlier link of the
 * chain is left `approved` or `active` with a range wholly in the past. Asked
 * by status alone, a spent first link held its lot off the screen for ever:
 * "Every live lot already has somebody on it. Nothing left to file." while the
 * rent roll one pill away called that same lot Vacant. At a park writing
 * one-month agreements every household has a second link within two months, so
 * it fires on the first move-out after go-live.
 *
 * And the naive repair is worse than the bug: "covers today, or starts after
 * today" offers a LAPSED lot as empty — a household still living there whose
 * paperwork ran out — and the database cannot refuse the second filing,
 * because the old range no longer overlaps anything. Hence the whole rule,
 * from its one home, rather than the two-thirds of it that reads plausibly.
 *
 * `rows` must include the ENDED ones: `lapsedRowOf` needs them to see a
 * close-out standing behind an expired chain, or a household who moved out of
 * their successor reads as a holdover whose paperwork merely ran out.
 */
export function lotsSomebodyHolds(
  rows: readonly Record<string, unknown>[] | null,
  lots: readonly { id: string; lot_number: string }[],
  today: string,
): Set<string> {
  const occupancy = lotOccupancy(
    (rows ?? []).map((r) => ({
      park_lot_id: r.park_lot_id as string,
      // A row whose range will not parse is no evidence that anybody is on the
      // lot; lotOccupancy skips it, as every other reader of the rule does.
      during: (r.during as string | null) ?? "",
      status: r.status as string,
      term: r.term as string,
    })),
    lots,
    today,
  );
  return new Set([...occupancy.occupiedLotIds, ...occupancy.reservedLotIds]);
}
