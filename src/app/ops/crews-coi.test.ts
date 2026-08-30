import { describe, it, expect } from "vitest";
import { coiState, daysBetween, docConfirmState } from "./crews-coi";

const TODAY = "2026-07-19";

describe("daysBetween", () => {
  it("counts whole days forward and backward", () => {
    expect(daysBetween(TODAY, "2026-07-19")).toBe(0);
    expect(daysBetween(TODAY, "2026-07-20")).toBe(1);
    expect(daysBetween(TODAY, "2026-07-18")).toBe(-1);
    expect(daysBetween(TODAY, "2026-08-18")).toBe(30);
  });
  it("returns NaN on a bad date", () => {
    expect(Number.isNaN(daysBetween(TODAY, "not-a-date"))).toBe(true);
  });
});

describe("coiState", () => {
  it("is 'missing' when the document is absent", () => {
    expect(coiState(null, "2026-12-01", TODAY)).toBe("missing");
    expect(coiState("", "2026-12-01", TODAY)).toBe("missing");
  });
  it("is 'missing' when the expiry is absent or unparseable", () => {
    expect(coiState("vendor/coi.pdf", null, TODAY)).toBe("missing");
    expect(coiState("vendor/coi.pdf", "garbage", TODAY)).toBe("missing");
  });
  it("is 'expired' when the expiry is before today", () => {
    expect(coiState("vendor/coi.pdf", "2026-07-18", TODAY)).toBe("expired");
    expect(coiState("vendor/coi.pdf", "2025-01-01", TODAY)).toBe("expired");
  });
  it("is 'expiring' when it lapses within 30 days (today counts as expiring)", () => {
    expect(coiState("vendor/coi.pdf", "2026-07-19", TODAY)).toBe("expiring"); // today
    expect(coiState("vendor/coi.pdf", "2026-08-17", TODAY)).toBe("expiring"); // 29 days
  });
  it("is 'ok' at exactly 30 days out and beyond", () => {
    expect(coiState("vendor/coi.pdf", "2026-08-18", TODAY)).toBe("ok"); // 30 days
    expect(coiState("vendor/coi.pdf", "2027-07-19", TODAY)).toBe("ok");
  });
});

describe("has anybody actually looked at the certificate (0152)", () => {
  it("is 'none' when there is no document to look at", () => {
    expect(docConfirmState(null, null)).toBe("none");
    expect(docConfirmState("", "2026-08-30T00:00:00Z")).toBe("none");
  });

  it("is 'unconfirmed' when a file is on file and nobody has opened it", () => {
    // This is the ordinary state on the day 0152 ships, for every crew.
    expect(docConfirmState("v1/coi.pdf", null)).toBe("unconfirmed");
  });

  it("is 'confirmed' only once somebody has", () => {
    expect(docConfirmState("v1/coi.pdf", "2026-08-30T12:00:00Z")).toBe("confirmed");
  });

  it("a confirmation without a document is not a confirmation", () => {
    // 0152's trigger nulls the confirmation whenever the url changes, so this
    // should be unreachable — but a state machine that trusts that is one
    // migration away from lying.
    expect(docConfirmState(null, "2026-08-30T12:00:00Z")).toBe("none");
  });
});
