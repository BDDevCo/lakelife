import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * EVERY PARK TAB OPENS WITH A PAGE TITLE, AND IT IS THE SAME SIZE AS EVERY
 * OTHER PAGE TITLE IN THE PRODUCT.
 *
 * The cohesion audit found the park owner's own tab bar going 24 → 24 → 24 →
 * 18 → 24 → 18, with two tabs opening on no title at all — while /vendor,
 * /ops, /billing and /requests all draw 26, which is the prototype's page
 * title (lakelife.html:506, :699). This pins the scale so a new tab cannot
 * drift, and pins that the two titleless tabs (Today, Rent roll) keep the
 * titles he asked for.
 */
const dir = fileURLToPath(new URL("./", import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const park = readdirSync(dir).filter((f) => /^Park[A-Z]\w*\.tsx$/.test(f));

describe("the scanner is reading the park tabs", () => {
  it("found them", () => {
    expect(park.length, "no Park*.tsx components found").toBeGreaterThanOrEqual(8);
  });
});

describe("a park page title is 26, like every other page title", () => {
  it("has no h1 at any other size", () => {
    const off: string[] = [];
    for (const f of park) {
      const src = strip(readFileSync(join(dir, f), "utf8"));
      for (const m of src.matchAll(/<h1[^>]*fontSize:\s*(\d+)/g)) {
        if (m[1] !== "26") off.push(`${f}: h1 at ${m[1]}`);
      }
    }
    expect(off, "a park page title drifted off the scale").toEqual([]);
  });

  it("Today and Rent roll have the titles he asked for", () => {
    expect(strip(readFileSync(join(dir, "ParkToday.tsx"), "utf8"))).toMatch(/<h1[^>]*>Today<\/h1>/);
    expect(strip(readFileSync(join(dir, "ParkRentRoll.tsx"), "utf8"))).toMatch(/<h1[^>]*>Rent roll<\/h1>/);
  });

  it("still finds page titles to judge", () => {
    // Without this the size check passes on a tree with no h1 at all.
    const n = park.reduce((s, f) => s + (strip(readFileSync(join(dir, f), "utf8")).match(/<h1/g) ?? []).length, 0);
    expect(n).toBeGreaterThanOrEqual(10);
  });
});
