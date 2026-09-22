import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lotsSomebodyHolds } from "./onboard-occupancy";

/**
 * "WHO LIVES HERE" AND THE ROLL, ASKED THE SAME QUESTION.
 *
 * The screen read held lots by status alone, so a spent link of a move-out
 * chain kept its lot off the list for ever: "Every live lot already has
 * somebody on it. Nothing left to file." over a lot the rent roll called
 * Vacant. These run the real rule on the shapes a chain leaves behind, and
 * then check that both doorways of the screen actually ask it.
 *
 * Nothing here is a real park: three invented lots at Cedar Hollow.
 */

const TODAY = "2027-03-01";
const LOTS = [
  { id: "lot-a", lot_number: "9" },
  { id: "lot-b", lot_number: "10" },
  { id: "lot-c", lot_number: "11" },
];
const row = (over: Record<string, unknown>) => ({
  park_lot_id: "lot-a", during: "[2027-01-01,2027-02-01)", status: "active", term: "monthly", ...over,
});

describe("lotsSomebodyHolds — the rule the filing screen asks", () => {
  it("a household living there today holds the lot", () => {
    const held = lotsSomebodyHolds([row({ during: "[2027-02-01,2027-04-01)" })], LOTS, TODAY);
    expect(held.has("lot-a")).toBe(true);
  });

  it("a household still to arrive holds it too — the December roll, before go-live", () => {
    const held = lotsSomebodyHolds(
      [row({ during: "[2027-04-01,2028-04-01)", status: "approved" })],
      LOTS, "2026-12-16",
    );
    expect(held.has("lot-a")).toBe(true);
  });

  it("PAPERWORK RUN OUT with nobody closed out behind it still holds the lot — they never left", () => {
    // The naive repair ("covers today, or starts later") offers this lot as
    // empty, and the exclusion constraint cannot refuse the second filing:
    // the old range is wholly in the past.
    const held = lotsSomebodyHolds([row({ during: "[2027-01-01,2027-02-01)" })], LOTS, TODAY);
    expect(held.has("lot-a")).toBe(true);
  });

  it("A MOVE-OUT THROUGH A RENEWAL FREES THE LOT — the spent first link no longer holds it", () => {
    // planMoveOut ends only the link covering the last day; the seq-1 link is
    // left `active` with a range in the past, and by status alone it held the
    // lot off the screen for ever.
    const held = lotsSomebodyHolds(
      [
        row({ during: "[2027-01-01,2027-02-01)", status: "active" }),
        row({ during: "[2027-02-01,2027-02-11)", status: "ended" }),
      ],
      LOTS, TODAY,
    );
    expect(held.has("lot-a")).toBe(false);
  });

  it("without the ended rows the same chain reads lived-in — which is why the read asks for them", () => {
    // Collapsed the other way: drop the close-out and the spent link IS a
    // lapsed holdover. Both halves matter, so both are pinned.
    const held = lotsSomebodyHolds([row({ during: "[2027-01-01,2027-02-01)", status: "active" })], LOTS, TODAY);
    expect(held.has("lot-a")).toBe(true);
  });

  it("a cancelled row holds nothing, and a lot nobody ever touched is free", () => {
    const held = lotsSomebodyHolds([row({ status: "cancelled" })], LOTS, TODAY);
    expect(held.has("lot-a")).toBe(false);
    expect(held.has("lot-b")).toBe(false);
  });

  it("a row whose range will not parse is not evidence anybody is there, and no read at all holds nobody", () => {
    expect(lotsSomebodyHolds([row({ during: null })], LOTS, TODAY).size).toBe(0);
    expect(lotsSomebodyHolds(null, LOTS, TODAY).size).toBe(0);
  });

  it("one lot's chain never speaks for another", () => {
    const held = lotsSomebodyHolds(
      [row({ park_lot_id: "lot-b", during: "[2027-02-01,2027-04-01)" })],
      LOTS, TODAY,
    );
    expect([...held]).toEqual(["lot-b"]);
  });
});

/**
 * BOTH DOORWAYS, IN THE SAME COMMIT. A screen that offers a lot the save
 * refuses is an afternoon's typing answered with "Somebody is already on that
 * lot." — so the grid's read and the save's re-check must ask one rule.
 */
describe("the filing screen's two doorways ask this rule and no other", () => {
  const src = readFileSync(fileURLToPath(new URL("./onboard-actions.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("finds the two reads it is scanning", () => {
    // Three touches of the table: the grid's read, the save's re-check, and
    // the insert that files a household.
    expect(src.match(/\.from\("lot_reservations"\)/g)?.length,
      "the reads this scan measures are gone").toBe(3);
    expect(src).toMatch(/import \{ lotsSomebodyHolds \} from "\.\/onboard-occupancy";/);
  });

  it("each read asks for the columns the rule needs, ENDED rows included", () => {
    expect(src.match(/\.select\("park_lot_id, during, status, term"\)/g)?.length).toBe(2);
    expect(src.match(/\.in\("status", \["approved", "active", "ended"\]\)/g)?.length).toBe(2);
    // The old shape: statuses with no date test, and no ended rows.
    expect(src).not.toMatch(/\.select\("park_lot_id"\)/);
    expect(src).not.toMatch(/\.in\("status", \["approved", "active"\]\)/);
  });

  it("each doorway derives its held set from the rule, never inline", () => {
    expect(src.match(/const takenIds = lotsSomebodyHolds\(/g)?.length).toBe(2);
    // No second copy of the date test in the door.
    expect(src).not.toMatch(/coversDay\(/);
    expect(src).not.toMatch(/r\.start > today/);
    expect(src).not.toMatch(/new Set\(\(taken/);
  });
});
