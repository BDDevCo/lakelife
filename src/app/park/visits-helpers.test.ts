import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitVisits, crewsOnSite, crewsOnSiteLine, UNASSIGNED_CREW } from "./visits-helpers";

const TODAY = "2026-09-16";
const v = (date: string, crew = "Lakeshore Lawn") => ({ date, crew });

describe("splitVisits — the board's three buckets", () => {
  it("today, tomorrow → upcoming, 29 days ago → recent, 31 days ago → nowhere", () => {
    const b = splitVisits([v("2026-08-16"), v("2026-08-18"), v("2026-09-16"), v("2026-09-17")], TODAY);
    expect(b.today.map((x) => x.date)).toEqual(["2026-09-16"]);
    expect(b.upcoming.map((x) => x.date)).toEqual(["2026-09-17"]);
    // 2026-08-18 is 29 days back; 2026-08-16 is 31 and falls off.
    expect(b.recent.map((x) => x.date)).toEqual(["2026-08-18"]);
  });

  it("the 30-day edge itself is IN, and recent is newest first", () => {
    const b = splitVisits([v("2026-08-17"), v("2026-09-01"), v("2026-09-15")], TODAY);
    expect(b.recent.map((x) => x.date)).toEqual(["2026-09-15", "2026-09-01", "2026-08-17"]);
  });

  it("crosses a month boundary backwards, and a year", () => {
    const b = splitVisits([v("2025-12-20"), v("2025-12-01")], "2026-01-10");
    expect(b.recent.map((x) => x.date)).toEqual(["2025-12-20"]);
  });

  it("keeps upcoming in the order given (the loader asks for ascending dates)", () => {
    const b = splitVisits([v("2026-09-20"), v("2026-09-25")], TODAY);
    expect(b.upcoming.map((x) => x.date)).toEqual(["2026-09-20", "2026-09-25"]);
  });
});

describe("crewsOnSite — trucks, not jobs", () => {
  it("the same crew twice is one; the placeholder is nobody", () => {
    expect(crewsOnSite([v(TODAY), v(TODAY)])).toBe(1);
    expect(crewsOnSite([v(TODAY), v(TODAY, "Pier Pros")])).toBe(2);
    expect(crewsOnSite([v(TODAY, UNASSIGNED_CREW)])).toBe(0);
    expect(crewsOnSite([v(TODAY, UNASSIGNED_CREW), v(TODAY)])).toBe(1);
    expect(crewsOnSite([])).toBe(0);
  });
  it("the placeholder is the view's own words", () => {
    expect(UNASSIGNED_CREW).toBe("Crew to be assigned");
  });
});

describe("crewsOnSiteLine — never a zero line", () => {
  it("0 → null, 1 → singular, n → plural", () => {
    expect(crewsOnSiteLine(0)).toBeNull();
    expect(crewsOnSiteLine(-1)).toBeNull();
    expect(crewsOnSiteLine(1)).toBe("1 crew on site today — see who");
    expect(crewsOnSiteLine(3)).toBe("3 crews on site today — see who");
  });
});

describe("the board reads the helper — one split, one placeholder", () => {
  const src = readFileSync(fileURLToPath(new URL("./visits-data.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("imports both and keeps no private copy", () => {
    expect(src).toMatch(/import \{ splitVisits, UNASSIGNED_CREW \} from "\.\/visits-helpers"/);
    expect(src).toMatch(/\.\.\.splitVisits\(all, today\)/);
    expect(src).toMatch(/\?\? UNASSIGNED_CREW/);
    expect(src).not.toMatch(/\b_d\b/);
    expect(src).not.toContain('"Crew to be assigned"');
    expect(src).not.toMatch(/setUTCDate/);
    // Still the loader it was: the scan is reading code.
    expect(src).toContain('from("park_site_visits")');
  });
});
