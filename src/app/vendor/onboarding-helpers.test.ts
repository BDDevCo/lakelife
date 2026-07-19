import { describe, it, expect } from "vitest";
import { validExpiry, safeExt } from "./onboarding-helpers";

const today = "2026-07-19";

describe("validExpiry", () => {
  it("accepts a future YYYY-MM-DD date", () => {
    expect(validExpiry("2026-12-31", today)).toBe("2026-12-31");
    expect(validExpiry("2027-01-01", today)).toBe("2027-01-01");
  });

  it("trims surrounding whitespace", () => {
    expect(validExpiry("  2026-12-31  ", today)).toBe("2026-12-31");
  });

  it("rejects today and past dates (an expired COI is no COI)", () => {
    expect(validExpiry(today, today)).toBeNull();
    expect(validExpiry("2026-07-18", today)).toBeNull();
    expect(validExpiry("2020-01-01", today)).toBeNull();
  });

  it("rejects malformed strings", () => {
    expect(validExpiry("12/31/2026", today)).toBeNull();
    expect(validExpiry("2026-7-1", today)).toBeNull();
    expect(validExpiry("2026-12-31T00:00:00", today)).toBeNull();
    expect(validExpiry("", today)).toBeNull();
    expect(validExpiry("not-a-date", today)).toBeNull();
  });

  it("rejects impossible calendar dates", () => {
    expect(validExpiry("2026-02-31", today)).toBeNull();
    expect(validExpiry("2026-13-01", today)).toBeNull();
    expect(validExpiry("2026-00-10", today)).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(validExpiry(null, today)).toBeNull();
    expect(validExpiry(undefined, today)).toBeNull();
    expect(validExpiry(20261231, today)).toBeNull();
  });
});

describe("safeExt", () => {
  it("extracts and lowercases the extension", () => {
    expect(safeExt("policy.PDF")).toBe("pdf");
    expect(safeExt("scan.jpeg")).toBe("jpeg");
  });

  it("strips unsafe characters", () => {
    expect(safeExt("weird.p d f")).toBe("pdf");
  });

  it("falls back when there is no extension", () => {
    expect(safeExt("noext")).toBe("noext");
    expect(safeExt("")).toBe("pdf");
  });
});
