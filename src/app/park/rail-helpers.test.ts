import { describe, it, expect } from "vitest";
import { canReverse, processorRail } from "./rail-helpers";
import { HAND_KEYED } from "./ledger-helpers";

/**
 * The rail test that Statements and the held-money panel each carried
 * inline, now one predicate: hand-keyed money can be un-recorded, processor
 * money can only be refunded (0142). Pinned both ways, and against the same
 * list handKeyedRefusal reads, so the two cannot drift apart.
 */
describe("canReverse", () => {
  it("refuses the two processor rails and nothing else", () => {
    expect(canReverse("card")).toBe(false);
    expect(canReverse("ach")).toBe(false);
    for (const m of HAND_KEYED) expect(canReverse(m), m).toBe(true);
  });
});

describe("processorRail", () => {
  it("names the rail as reversePayment names it, and nothing for hand-keyed money", () => {
    expect(processorRail("card")).toBe("by card");
    expect(processorRail("ach")).toBe("by bank transfer");
    for (const m of HAND_KEYED) expect(processorRail(m), m).toBeNull();
  });
});
