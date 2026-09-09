import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CrewCoverage } from "./CrewCoverage";
import type { CrewCoverage as Coverage } from "@/app/ops/crews-data";

/**
 * THE QUESTION THE DISPATCH BOARD CANNOT ASK.
 *
 * That board lists jobs that failed to find a crew — right once a job exists,
 * useless before then. It cannot fire until somebody has already booked work
 * nobody can take, and for protective work in January that is exactly too
 * late.
 *
 * The live numbers this was built against, verified against production on
 * 9 Sep 2026: 3 vendors, ALL of them test accounts, so 0 real crews; 16 active
 * services across 3 lakes; **0 of 48 pairs covered**. Nothing anywhere said so.
 */
const base: Coverage = { holes: [], pairs: 48, liveCrews: 0, orphanServices: [] };
const draw = (c: Partial<Coverage>) =>
  renderToStaticMarkup(<CrewCoverage coverage={{ ...base, ...c }} />);

/** Every pair dark — the state production is actually in. */
const allDark: Partial<Coverage> = {
  pairs: 2,
  liveCrews: 0,
  holes: [
    { service: "Park grounds mowing & trim", lakeId: "l1", lakeName: "Big Long", crews: 0, protective: false },
    { service: "Snow clearing — roads & common drives", lakeId: "l1", lakeName: "Big Long", crews: 0, protective: true },
  ],
  orphanServices: ["Park grounds mowing & trim", "Snow clearing — roads & common drives"],
};

describe("when nobody can do anything", () => {
  it("says so in one sentence instead of listing every empty cell", () => {
    // "0 of 48" invites a reader to hunt for which ones. The answer is all of
    // them and the cause is a single fact.
    const html = draw(allDark);
    expect(html).toContain("No crew can take any job, anywhere.");
    expect(html).toContain("0 of 2 covered");
  });

  it("names the actual cause — every vendor is a test account", () => {
    // This is the finding. Dispatch excludes fixtures, so three vendors read
    // as zero, and no screen had ever said it out loud.
    expect(draw(allDark)).toMatch(/every vendor on the platform is a test account/);
  });

  it("says something different when there ARE live crews but none is set up", () => {
    // Same emptiness, completely different remedy: check their services,
    // their lakes, their certificate — not "go and hire somebody".
    const html = draw({ ...allDark, liveCrews: 2 });
    expect(html).not.toMatch(/test account/);
    expect(html).toMatch(/2 live crews/);
    expect(html).toMatch(/service list, their lakes/);
  });
});

describe("when some work is covered and some is not", () => {
  const partial: Partial<Coverage> = {
    pairs: 4,
    liveCrews: 3,
    holes: [
      { service: "Snow removal — drive & walks", lakeId: "l2", lakeName: "Pretty", crews: 0, protective: true },
    ],
    orphanServices: [],
  };

  it("names the gap, the lake, and that nobody has it", () => {
    const html = draw(partial);
    // `&` arrives HTML-escaped; assert on what the browser is actually sent.
    expect(html).toContain("Snow removal — drive &amp; walks");
    expect(html).toContain("Pretty");
    expect(html).toContain("3 of 4 covered");
  });

  it("says out loud that protective work will not cancel itself", () => {
    // 0053 stops the nightly auto-cancelling protective work, so an uncovered
    // one does not quietly disappear — it waits, and somebody is stranded.
    expect(draw(partial)).toMatch(/never cancel on its own/);
  });

  it("does not cry protective over routine work", () => {
    const routine = { ...partial, holes: [{ ...partial.holes![0], protective: false }] };
    expect(draw(routine)).not.toMatch(/never cancel on its own/);
  });
});

describe("when everything is covered", () => {
  it("says so plainly and raises no alarm", () => {
    const html = draw({ pairs: 12, liveCrews: 4, holes: [], orphanServices: [] });
    expect(html).toContain("Every active service has somebody on every lake");
    expect(html).not.toMatch(/No crew can take any job/);
    expect(html).not.toMatch(/never cancel on its own/);
  });

  it("does not claim coverage when there is nothing to cover", () => {
    // Zero services on zero lakes is not a clean bill of health, and the
    // green "all covered" sentence would be the most misleading thing here.
    const html = draw({ pairs: 0, liveCrews: 0, holes: [], orphanServices: [] });
    expect(html).toContain("nothing to cover");
    expect(html).not.toContain("Every active service has somebody");
  });
});
