import { describe, it, expect } from "vitest";
import { sanitiseDescriptor, statementDescriptor, DESCRIPTOR_MAX } from "./descriptor";

describe("every descriptor fits on a statement", () => {
  it("all four are within the limit", () => {
    for (const k of ["service", "tip", "cancel_fee", "visit_fee"] as const) {
      expect(statementDescriptor(k).length).toBeLessThanOrEqual(DESCRIPTOR_MAX);
    }
  });

  it("all four start with the business name, so the line is recognisable", () => {
    for (const k of ["service", "tip", "cancel_fee", "visit_fee"] as const) {
      expect(statementDescriptor(k).startsWith("LAKELIFE")).toBe(true);
    }
  });

  it("all four are DIFFERENT — two LakeLife lines must be tellable apart", () => {
    const all = (["service", "tip", "cancel_fee", "visit_fee"] as const).map(statementDescriptor);
    expect(new Set(all).size).toBe(4);
  });

  it("THE ONE THAT MATTERS: a tip says TIP", () => {
    // Two charges from one company is only calm if the second says what it is.
    // It is the whole reason Uber's separate tip charge doesn't generate a
    // dispute for every rider who tips.
    expect(statementDescriptor("tip")).toContain("TIP");
  });
});

describe("what the old descriptors would have become", () => {
  it("the tip one truncated to something unrecognisable", () => {
    const before = "LakeLife — thank-you for the crew, Pier Install / Removal";
    const after = sanitiseDescriptor(before);
    expect(after.length).toBeLessThanOrEqual(DESCRIPTOR_MAX);
    // The words a customer would need are gone by then — which is the bug.
    expect(after).not.toContain("TIP");
    expect(after).not.toContain("CREW");
  });

  it("the em dash does not survive, and leaves no double space behind", () => {
    expect(sanitiseDescriptor("LakeLife — service")).toBe("LAKELIFE SERVICE");
    expect(sanitiseDescriptor("LakeLife — service")).not.toContain("  ");
  });

  it("a slash is stripped too", () => {
    expect(sanitiseDescriptor("Pier Install / Removal")).toBe("PIER INSTALL REMOVAL");
  });
});

describe("truncation never reads as a glitch", () => {
  it("breaks on a word, not mid-word", () => {
    const s = sanitiseDescriptor("LAKELIFE SEASONAL OPENING SERVICE");
    expect(s).toBe("LAKELIFE SEASONAL");
    expect(s.endsWith(" ")).toBe(false);
  });

  it("but a single long word is still cut rather than emptied", () => {
    const s = sanitiseDescriptor("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(s).toBe("ABCDEFGHIJKLMNOPQRSTUV");
    expect(s.length).toBe(DESCRIPTOR_MAX);
  });

  it("survives junk without throwing", () => {
    expect(sanitiseDescriptor("")).toBe("");
    expect(sanitiseDescriptor("<<<***>>>")).toBe("");
  });
});
