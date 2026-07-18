import { describe, it, expect } from "vitest";
import { toE164, pullDeadline } from "./phone";

describe("toE164 — US mobile normalization", () => {
  it("formats a 10-digit number with punctuation", () => {
    expect(toE164("(260) 555-0100")).toBe("+12605550100");
  });
  it("formats a plain 10-digit number", () => {
    expect(toE164("2605550100")).toBe("+12605550100");
  });
  it("accepts an 11-digit number starting with 1", () => {
    expect(toE164("1 260 555 0100")).toBe("+12605550100");
  });
  it("passes through a valid +E.164 number", () => {
    expect(toE164("+12605550100")).toBe("+12605550100");
  });
  it("rejects a too-short number", () => {
    expect(toE164("555-0100")).toBeNull();
  });
  it("rejects empty input", () => {
    expect(toE164("")).toBeNull();
  });
});

describe("pullDeadline — freeze minus 8 days (CLAUDE.md rule 7)", () => {
  it("Big Long Lake: freeze Nov 22 -> pull deadline Nov 14", () => {
    const d = pullDeadline(new Date("2026-11-22"));
    expect(d.toISOString().slice(0, 10)).toBe("2026-11-14");
  });
  it("Pretty Lake: freeze Nov 20 -> pull deadline Nov 12", () => {
    const d = pullDeadline(new Date("2026-11-20"));
    expect(d.toISOString().slice(0, 10)).toBe("2026-11-12");
  });
  it("Big Turkey Lake: freeze Nov 24 -> pull deadline Nov 16", () => {
    const d = pullDeadline(new Date("2026-11-24"));
    expect(d.toISOString().slice(0, 10)).toBe("2026-11-16");
  });
});
