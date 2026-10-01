import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The house helpers, local because they are three lines and importing across
 * test files couples them. `stripComments` matters most: the strings this file
 * scans for are QUOTED in the comments that explain them, so a raw scan would
 * match its own explanation and prove nothing — the same false alarm the
 * one-household rehearsal hit today on charge-edits.ts.
 */
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("a toast may not claim a crew", () => {

/**
 * ONE DOORWAY OF TWO, AGAIN. book/actions.ts:884-890 records why the booking
 * EMAIL stopped saying "You're booked": with no routable crew the job survives
 * unassigned (no_crew_for_service is not one of the three back-out reasons at
 * :772,:779,:791), and a customer who read the mail believed somebody was
 * coming. `assignedCrew` is returned for exactly this purpose (:171-186).
 * The toast ignored it.
 */

  it("the toast reads assignedCrew before it says booked", () => {
    const src = flat(stripComments(read("../../components/BookingGrid.tsx")));
    expect(src, "the toast still says 'booked' off its own list")
      .not.toMatch(/toast\(\s*asked === 1 \? `\$\{service\.name\} booked/);
    expect(src, "the toast does not consult the assignment at all")
      .toContain("res.assignedCrew");
  });

  it("and the batch door stopped claiming it too", () => {
    // ONE DOORWAY OF TWO. The single toast could consult `assignedCrew`; the
    // batch caller tracks dates and prices and never asks per date whether a
    // crew was found, so it cannot. The wording therefore asserts the thing
    // that is true either way — the visits are on the customer's list — and
    // claims nothing about who is coming.
    const src = flat(stripComments(read("../../lib/batch-booking.ts")));
    expect(src, "the batch headline says booked again").not.toContain("visits booked");
    expect(src).toContain("on your list");
  });

  it("proves the scanner finds the two strings it is aimed at", () => {
    // Source scans that pin a shape must be shown to fail. These are the two
    // literals as of 30 Sep 2026; if neither is findable the scan is inert.
    expect(flat(read("../../components/BookingGrid.tsx"))).toContain("My requests");
    expect(flat(read("../../lib/batch-booking.ts"))).toContain("on your list — see");
  });
});
