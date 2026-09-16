import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * "EVERY LIVE LOT ALREADY HAS SOMEBODY ON IT" WAS SAID TO A PARK WITH NO LOTS.
 *
 * An empty seed list was three different facts — no lots, lots not yet live,
 * every live lot taken — and the screen printed the third for all of them.
 * Worse, a refused or failed loader reached the same sentence, because the
 * page passed `res.seeds ?? []` through without looking at `res.ok`.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/park/onboard-actions", () => ({ commitOnboarding: async () => ({ ok: true }) }));

const { ParkOnboard } = await import("./ParkOnboard");

const render = (liveLots: number, totalLots: number) => renderToStaticMarkup(
  <ParkOnboard parkId="p1" seeds={[]} today="2026-09-16" capMonths={null} rentsFromImport={false}
    liveLots={liveLots} totalLots={totalLots} />,
);

describe("Who lives here with nobody to file", () => {
  it("no lots at all: says so and opens both doors", () => {
    const html = render(0, 0);
    expect(html).toContain("No lots on file yet");
    expect(html).toContain('href="/park/lots"');
    expect(html).toContain('href="/park/import"');
    expect(html).not.toContain("Every live lot");
  });
  it("lots that are not live: names the count and the picker's own word", () => {
    const html = render(0, 5);
    expect(html).toContain("Your 5 lots aren&#x27;t live yet");
    // The picker's option is "Live", quoted as it reads there.
    expect(html).toContain("Set each one to ‘Live’ under");
    expect(html).toContain('href="/park/lots"');
    expect(html).not.toContain('href="/park/import"');
    expect(html).not.toContain("Every live lot");
    expect(render(0, 1)).toContain("Your lot isn&#x27;t live yet");
  });
  it("every live lot taken: the sentence that was always true of that case", () => {
    const html = render(5, 5);
    expect(html).toContain("Every live lot already has somebody on it. Nothing left to file.");
    expect(html).not.toContain('href="/park/lots"');
  });
});

describe("the page, by source", () => {
  const src = readFileSync(fileURLToPath(new URL("../app/park/onboard/page.tsx", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("renders a refused or failed loader as its sentence, before ParkOnboard, and passes both counts", () => {
    const guard = src.indexOf("if (!res.ok)");
    const screen = src.indexOf("<ParkOnboard");
    expect(guard).toBeGreaterThan(-1);
    expect(screen).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(screen);
    expect(src.slice(guard, screen)).toContain("{res.error}");
    expect(src).toMatch(/liveLots=\{res\.liveLots \?\? 0\}/);
    expect(src).toMatch(/totalLots=\{res\.totalLots \?\? 0\}/);
  });
  it("the loader counts every lot and the live ones separately", () => {
    const actions = readFileSync(fileURLToPath(new URL("../app/park/onboard-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(actions).toMatch(/return \{ ok: true, seeds: \[\], today, liveLots: 0, totalLots: \(allLots \?\? \[\]\)\.length \};/);
    expect(actions).toMatch(/liveLots: lotIds\.length,\s*totalLots: \(allLots \?\? \[\]\)\.length,/);
  });
});
