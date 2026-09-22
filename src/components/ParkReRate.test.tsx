import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planReRate, reRateSkipGroups, type ReRateTarget } from "@/app/park/rerate-helpers";

/**
 * THE SENTENCE UNDER THE PREVIEW, on the screen where he decides what every
 * household in the park pays.
 *
 * It read "{n} left alone — already at that rent, not monthly, or nobody on
 * the lot": three reasons, where the planner has four. The fourth — the
 * agreement runs out before the new rent would start — is the reason for
 * nearly every lot at a park whose house style is a one-month agreement,
 * because any date the notice period allows is already past the end of one.
 * So he scheduled a park-wide increase, most lots quietly kept the old rent,
 * and the only explanation on screen said "nobody on the lot" about
 * households living there.
 *
 * The honest per-lot sentence already existed — `reRateProblemText`, in the
 * planner's own module — with no caller anywhere in src outside its own test.
 * It is `reRateProblemSentence` now, plural-aware and grouped, and this pins
 * that the screen calls it.
 */
const SRC = readFileSync(fileURLToPath(new URL("./ParkReRate.tsx", import.meta.url)), "utf8")
  // Comments quote the old sentence on purpose; the scan must not see them.
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the re-rate preview's skip line", () => {
  it("scans the real component, with its comments stripped", () => {
    // Non-vacuous: the scanner is looking at a file that still has the rest
    // of the screen in it.
    expect(SRC).toContain("Change the rent on everyone");
    expect(SRC).toContain("Schedule it for");
    expect(SRC.length).toBeGreaterThan(2000);
  });

  it("no longer explains a skip with three reasons out of four", () => {
    expect(SRC).not.toMatch(/already at that rent, not/);
    expect(SRC).not.toMatch(/nobody on the lot/);
  });

  it("renders the planner's own reasons instead", () => {
    expect(SRC).toContain("reRateSkipGroups");
    expect(SRC).toMatch(/skipGroups\.map/);
    // In BOTH branches — when nothing changes, this is the only thing on the
    // screen that says why, and the Schedule button is disabled beside it.
    const preview = SRC.slice(SRC.indexOf("reRateSummary(plan)"));
    expect(preview).toContain("skipGroups.map");
    expect(preview.indexOf("skipGroups.map")).toBeLessThan(preview.indexOf("Schedule it for"));
  });

  it("the grouped reasons the screen would print for a one-month park", () => {
    // What he actually sees: eighteen households on one-month agreements, one
    // empty lot, an increase for the earliest date his notice period allows.
    const lived: ReRateTarget[] = Array.from({ length: 18 }, (_, i) => ({
      reservationId: `res-${i}`, lotLabel: String(i + 1),
      currentAmount: 400, term: "monthly", endsOn: "2027-05-01",
    }));
    const plan = planReRate({
      targets: [...lived, { reservationId: "", lotLabel: "27", currentAmount: null, term: "", endsOn: null }],
      toAmount: 425, effectiveOn: "2027-05-02", noticeGivenOn: "2027-04-01", noticeDays: 30,
    });
    const lines = reRateSkipGroups(plan).map((g) => g.text);
    expect(lines).toHaveLength(2);
    expect(lines.join(" ")).toContain("run out before the new rent would start");
    // The eighteen are never described as empty lots.
    expect(lines.filter((l) => /Nobody is on/.test(l))).toHaveLength(1);
  });
});
