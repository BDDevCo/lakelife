import { describe, it, expect } from "vitest";
import {
  validExpiry, safeExt, activationGaps, readyToActivate, validLatLng, addDays, coiRevalidationDue,
  type ActivationInput,
} from "./onboarding-helpers";

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

const fullCrew: ActivationInput = {
  coi_url: "v/coi-1.pdf",
  coi_expiry: "2026-12-31",
  w9_url: "v/w9-1.pdf",
  service_types: ["Pier install"],
  service_lakes: ["lake-a"],
  daily_capacity: 4,
};

describe("activationGaps / readyToActivate (zero-ops self-activation gate)", () => {
  it("a crew with docs + services + lakes + capacity is ready", () => {
    expect(activationGaps(fullCrew, today)).toEqual([]);
    expect(readyToActivate(fullCrew, today)).toBe(true);
  });

  it("base location is NOT required (must never block activation)", () => {
    // fullCrew has no base_lat/lng in ActivationInput at all — still ready.
    expect(readyToActivate(fullCrew, today)).toBe(true);
  });

  it("flags a missing COI", () => {
    expect(activationGaps({ ...fullCrew, coi_url: null }, today)).toContain(
      "Upload your insurance certificate (COI)",
    );
  });

  it("treats an expired or undated COI as a gap (no COI, no jobs)", () => {
    expect(readyToActivate({ ...fullCrew, coi_expiry: "2020-01-01" }, today)).toBe(false);
    expect(readyToActivate({ ...fullCrew, coi_expiry: today }, today)).toBe(false); // today = not future
    expect(readyToActivate({ ...fullCrew, coi_expiry: null }, today)).toBe(false);
  });

  it("requires W-9, at least one service, at least one lake, and capacity >= 1", () => {
    expect(readyToActivate({ ...fullCrew, w9_url: null }, today)).toBe(false);
    expect(readyToActivate({ ...fullCrew, service_types: [] }, today)).toBe(false);
    expect(readyToActivate({ ...fullCrew, service_lakes: [] }, today)).toBe(false);
    expect(readyToActivate({ ...fullCrew, daily_capacity: 0 }, today)).toBe(false);
    expect(readyToActivate({ ...fullCrew, daily_capacity: null }, today)).toBe(false);
  });
});

describe("validLatLng (base sanity bound)", () => {
  it("accepts a plausible NE Indiana base", () => {
    expect(validLatLng(41.6, -85.3)).toEqual({ lat: 41.6, lng: -85.3 });
  });
  it("rejects 0,0 and out-of-region / non-finite typos", () => {
    expect(validLatLng(0, 0)).toBeNull();
    expect(validLatLng(41.6, 85.3)).toBeNull();   // wrong hemisphere
    expect(validLatLng(NaN, -85)).toBeNull();
    expect(validLatLng("x", "y")).toBeNull();
    expect(validLatLng(80, -85)).toBeNull();       // above US band
  });
});

describe("addDays / coiRevalidationDue (annual re-attest)", () => {
  it("addDays does not day-drift across month/year boundaries", () => {
    expect(addDays("2026-07-19", 30)).toBe("2026-08-18");
    expect(addDays("2026-12-20", 30)).toBe("2027-01-19");
    expect(addDays("2026-07-19", -365)).toBe("2025-07-19");
  });

  it("is due exactly 30 days before the COI expires (one send, no daily nag)", () => {
    expect(coiRevalidationDue({ coi_expiry: addDays(today, 30), verified_at: null }, today)).toBe(true); // 2026-08-18
    expect(coiRevalidationDue({ coi_expiry: addDays(today, 29), verified_at: null }, today)).toBe(false);
    expect(coiRevalidationDue({ coi_expiry: addDays(today, 31), verified_at: null }, today)).toBe(false);
  });

  it("is due on the yearly anniversary of the last verification", () => {
    expect(coiRevalidationDue({ coi_expiry: "2027-06-01", verified_at: "2025-07-19T12:00:00Z" }, today)).toBe(true);
    expect(coiRevalidationDue({ coi_expiry: "2027-06-01", verified_at: "2025-07-18T12:00:00Z" }, today)).toBe(false);
  });

  it("is not due for a fresh crew with a far-off COI", () => {
    expect(coiRevalidationDue({ coi_expiry: "2027-06-01", verified_at: "2026-07-01T12:00:00Z" }, today)).toBe(false);
  });

  it("is not due when both signals are absent", () => {
    expect(coiRevalidationDue({ coi_expiry: null, verified_at: null }, today)).toBe(false);
  });
});
