import { describe, it, expect } from "vitest";
import { slotLabel, shotProgress } from "./shot-list";

/**
 * The sentence a crew reads with a boat on the trailer behind them. Every
 * case here is one they can actually be standing in.
 */

describe("a slot reads as English", () => {
  it("labels the slots 0146 seeded", () => {
    expect(slotLabel("port_side")).toBe("Port side");
    expect(slotLabel("cover_or_wrap")).toBe("Cover / wrap");
    expect(slotLabel("racked_position")).toBe("In the rack");
    expect(slotLabel("tag")).toBe("Registration tag");
  });

  it("de-slugs a slot it has never seen, rather than showing a column name", () => {
    // The list is DATA. A slot added to a service in the database must reach
    // the crew screen without a deploy — and must not arrive as "fuel_line".
    expect(slotLabel("fuel_line")).toBe("Fuel line");
    expect(slotLabel("TRAILER-TONGUE")).toBe("Trailer tongue");
    expect(slotLabel("  bilge  ")).toBe("Bilge");
  });

  it("never returns an empty label", () => {
    // An empty chip is a control nobody can tap and nobody can explain.
    expect(slotLabel("___")).not.toBe("");
    expect(slotLabel("")).toBe("");
  });
});

describe("what the crew is told", () => {
  const BOAT = ["port_side", "starboard_side", "bow", "stern", "hull", "engine", "interior"];

  it("names the shots that are missing instead of counting them", () => {
    // "5 more photos needed" is not an instruction. This is the whole point
    // of 0146 reaching the screen.
    const p = shotProgress(BOAT, ["port_side", "starboard_side"], 2, 7);
    expect(p.message).toBe("Still to shoot: Bow, Stern, Hull, Engine, Interior.");
    expect(p.canComplete).toBe(false);
    expect(p.missing).toHaveLength(5);
    expect(p.done).toEqual(["port_side", "starboard_side"]);
  });

  it("keeps the service's own order, not the order they were shot in", () => {
    const p = shotProgress(BOAT, ["interior", "engine"], 2, 7);
    expect(p.missing).toEqual(["port_side", "starboard_side", "bow", "stern", "hull"]);
  });

  it("says so when the walk-around is done", () => {
    const p = shotProgress(BOAT, BOAT, 7, 7);
    expect(p.message).toBe("Walk-around complete — all 7 shots.");
    expect(p.canComplete).toBe(true);
    expect(p.missing).toEqual([]);
  });

  it("tells the truth when the count is met but a shot is missing", () => {
    // Seven photos, two of them of the same fender, and no engine shot. The
    // DATABASE will accept this — 0146 left the gate a count on purpose. So
    // the screen must not pretend to block it, and must not stay silent
    // either. Both facts, in one sentence.
    const p = shotProgress(BOAT, ["port_side", "starboard_side", "bow", "stern", "hull"], 7, 7);
    expect(p.canComplete).toBe(true);
    expect(p.message).toBe("Enough photos to complete — but no shot yet of Engine, Interior.");
  });

  it("does not claim a block the server would not enforce", () => {
    // The failure mode this guards: someone reads the sentence above, decides
    // it looks untidy, and wires canComplete to `missing.length === 0`. The
    // crew then meets a button that will not press for a rule no trigger has.
    const p = shotProgress(BOAT, [], 9, 7);
    expect(p.canComplete, "the gate is min_photos — see 0146 on offline").toBe(true);
  });

  it("still works for a service with no list at all", () => {
    // Twenty of the twenty-six services have no walk-around and never will —
    // a mow does not get one.
    expect(shotProgress([], [], 0, 2).message).toBe("2 more photos needed to close this job.");
    expect(shotProgress(null, null, 1, 2).message).toBe("1 more photo needed to close this job.");
    expect(shotProgress(undefined, undefined, 3, 2).message).toBe("3 of 2 photos — ready to complete.");
  });

  it("handles a package visit, where the gate is the sum of the legs", () => {
    // Every named shot for THIS leg is in, but the visit owes more photos
    // because another leg on the same stop owes its own. Telling the crew
    // "walk-around complete" while the button stays dead would be a lie.
    const p = shotProgress(["racked_position", "overall"], ["racked_position", "overall"], 2, 5);
    expect(p.canComplete).toBe(false);
    expect(p.message).toBe("All 2 shots done — this visit needs 5 photos in total.");
  });
});

describe("the inputs are never trusted to be tidy", () => {
  it("ignores unlabelled photos when working out what is missing", () => {
    // Extra photos beyond the list carry slot = null and are welcome; they
    // just do not tick anything off.
    const p = shotProgress(["bow", "stern"], [null, undefined, "", "  "], 4, 2);
    expect(p.missing).toEqual(["bow", "stern"]);
    expect(p.canComplete).toBe(true);
  });

  it("counts a slot shot twice once", () => {
    const p = shotProgress(["bow", "stern"], ["bow", "bow", "bow"], 3, 2);
    expect(p.done).toEqual(["bow"]);
    expect(p.missing).toEqual(["stern"]);
  });

  it("drops a blank entry in the service's own list", () => {
    // A blank slug would render a chip with no name on it.
    const p = shotProgress(["bow", "", "  ", "stern"], [], 0, 2);
    expect(p.required).toEqual(["bow", "stern"]);
  });

  it("de-duplicates a list that repeats itself", () => {
    const p = shotProgress(["bow", "bow", "stern"], ["bow"], 1, 2);
    expect(p.required).toEqual(["bow", "stern"]);
    expect(p.missing).toEqual(["stern"]);
  });

  it("treats a zero gate as satisfied", () => {
    expect(shotProgress([], [], 0, 0).canComplete).toBe(true);
  });
});
