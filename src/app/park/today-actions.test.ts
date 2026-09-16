import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE TODAY LOADER, BY SHAPE.
 *
 * What these pin cannot be observed behaviourally without a live database:
 * that the readiness list has NO takeover-date gate (the checklist it
 * replaces showed only when a cutover was set and in the future, so most
 * parks never saw it), that it is derived from the rows this loader already
 * reads rather than a second read of them, and that the one "crews on site"
 * read is keyed on today.
 */
const src = readFileSync(fileURLToPath(new URL("./today-actions.ts", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the scanner is reading real code", () => {
  it("still finds the loader's reads", () => {
    expect((src.match(/mustRead\(/g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(src).toContain('from("park_payments")');
  });
});

describe("the readiness list on Today", () => {
  it("is assigned from the builder with no cutover in the condition", () => {
    const stmt = src.match(/const readiness = [\s\S]*?;\n/);
    expect(stmt, "no `readiness =` assignment").not.toBeNull();
    expect(stmt![0]).toContain("showReadinessOnToday(");
    expect(stmt![0]).toContain("readinessHeadline(");
    expect(stmt![0]).not.toContain("cutoverOn");
    // The go-live placement is its own boolean, computed once, from the
    // date — the list's visibility never reads it directly.
    expect(src).toMatch(/const beforeGoLive = cutoverOn != null && cutoverOn > today;/);
    expect(stmt![0]).toContain("beforeGoLive ||");
  });

  it("is built from the loader's own rows plus the light reads — not a second loader", () => {
    expect(src).toMatch(/readinessFactsFrom\(\{/);
    expect(src).toMatch(/const rows = readinessFor\(ready\.facts\)/);
    expect(src).toMatch(/readinessExtras\(\s*parkId,/);
    expect(src).not.toContain("getReadinessFacts(");
    // The rows handed over are the ones read for the money card and the
    // occupancy line, by name.
    const pre = src.match(/readinessFactsFrom\(\{[\s\S]*?\}\);/)![0];
    for (const line of ["reservations: everyRow ?? []", "lots: lots ?? []", "renters: renters ?? []", "rates: rates ?? []", "chargesRaised: (charges ?? []).length", "viewerIsOwner: membership.role === \"owner\""]) {
      expect(pre).toContain(line);
    }
    // And those reads carry the columns the rows are earned by.
    expect(src).toMatch(/\.select\("name, rent_due_day, office_recording_lag_days, max_agreement_months, cutover_date, active, lake_id, lat, lng, notices_held_at, accepts_online_rent"\)/);
    expect(src).toMatch(/\.select\("id, lot_number, lifecycle, active"\)/);
    expect(src).toMatch(/\.select\("id, display_name, email, phone_on_file_with_park, invite_sent_at, claim_code_issued_at"\)/);
  });

  it("the pre-cutover checklist and its private counts are gone; occupancy is the shared rule", () => {
    expect(src).not.toMatch(/\bpreCutover\(/);
    expect(src).not.toMatch(/\blotsWithRates\b/);
    expect(src).not.toMatch(/\bmonthlyRoll\b/);
    expect(src).toMatch(/const occupancy = lotOccupancy\(/);
  });

  it("the first-run card honours a dismissal through the task states it already reads", () => {
    expect(src).toMatch(/st\.task_key === firstRunTaskKey\(parkId\) && st\.dismissed_at != null/);
    expect(src).toMatch(/firstRunDismissed \? null : firstRunCard\(ready\.facts, ready\.contact, rows\)/);
  });
});

describe("crews on site today", () => {
  it("reads today's visits, through mustRead, and counts distinct crews with the placeholder left out", () => {
    expect(src).toMatch(/\.from\("park_site_visits"\)\.select\("crew"\)\.eq\("park_id", parkId\)\.eq\("visit_date", today\)/);
    expect(src).toMatch(/const visitsToday = mustRead\("who's on site today", visitsRes\)/);
    expect(src).toMatch(/crewsOnSite: crewsOnSite\(/);
    expect(src).toContain("UNASSIGNED_CREW");
  });
});

describe("the arrears card is handed the oldest open month", () => {
  it("from the same rows the money card reads", () => {
    expect(src).toMatch(/arrearsOldestMonth: arrears\.length\s*\?\s*arrears\.reduce\(/);
  });
});
