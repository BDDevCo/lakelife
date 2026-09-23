import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * THE OPS BOARD COUNTED THE THREE ACCOUNTS WE INVENTED AS BUSINESSES.
 *
 * Every vendor in production is a fixture. Four crew doorways already fenced
 * them out by joining their OWNER's `users.is_fixture` — auto-dispatch, the
 * dispatch read, the coverage card, the assign dropdown — and a fifth did not:
 * the vendors read inside `computeMarginHealthRows`. So "Ready crews" on the
 * margin board read 2 and 1, under a type comment calling them "truly ready to
 * take the work", one tab from the coverage card saying every vendor on the
 * platform is a test account and dispatch will not route to one.
 *
 * The money half is why this is not just a wrong number. The same rows decide
 * `ready` versus `floorFail`, and the cheapest floor-failing card becomes
 * `cheapestFailingComparable` — the single number the nightly pass computes a
 * menu raise from and applies to the LIVE services row unattended
 * (`price_autoapply_max_pct` is set in production, so that pass is on). A
 * scratch crew's rate card could have set a real customer's price. Nothing had
 * moved when this was found: with no waiting demand there were no suggestions.
 *
 * This is a source scan because the defect is a missing clause in a query, and
 * the read it lives in needs the whole database to exercise. Comments are
 * stripped first — this file quotes the fence in prose twice above.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => strip(readFileSync(new URL(p, import.meta.url), "utf8"));

const opsData = read("./data.ts");
const crewsData = read("./crews-data.ts");
const crewBoard = read("../../components/ops/CrewBoard.tsx");

/** Every `.from("vendors")` read in a file, as the text that follows it. */
function vendorReads(src: string): string[] {
  return src.split('.from("vendors")').slice(1).map((chunk) => chunk.slice(0, 600));
}

describe("every crew doorway on the ops console is fenced the same way", () => {
  it("found the files and the reads — this scan is not passing on an empty string", () => {
    expect(opsData.length).toBeGreaterThan(2000);
    expect(crewsData.length).toBeGreaterThan(2000);
    // Two vendor reads in ops/data.ts today. It was three until the dead
    // getEligibleVendors — born uncalled, never wired to anything — was
    // deleted; fencing it had been the only thing keeping it honest. If one is
    // added or removed this number is wrong, which is the point: the next one
    // gets read too.
    expect(vendorReads(opsData)).toHaveLength(2);
  });

  it("no read of the ACTIVE crews leaves the scratch accounts in", () => {
    for (const r of vendorReads(opsData)) {
      if (!/\.eq\("status",\s*"active"\)/.test(r)) continue;
      expect(r, "an active-crews read in ops/data.ts with no fixture fence").toMatch(
        /users!vendors_user_id_fkey!inner\(is_fixture\)/,
      );
      expect(r).toMatch(/\.eq\("users\.is_fixture",\s*false\)/);
    }
  });

  it("the margin board's own read is one of them", () => {
    // Named directly, so that deleting the loop above cannot make this pass by
    // finding nothing to check.
    const margin = vendorReads(opsData).filter((r) => r.includes("service_lakes"));
    expect(margin).toHaveLength(1);
    expect(margin[0]).toMatch(/\.eq\("users\.is_fixture",\s*false\)/);
  });
});

/**
 * THE ROSTER IS THE ONE PLACE THESE ROWS MUST STAY — ops has to be able to
 * suspend and edit them — so it is labelled rather than fenced. The column has
 * to be SELECTED, carried, and read by the card; this repo's most repeated bug
 * is the comparison added without the column, which compiles and reads
 * undefined forever.
 */
describe("the crew roster carries the label instead of the fence", () => {
  it("selects is_fixture on the embed it already has", () => {
    expect(crewsData).toMatch(/users!vendors_user_id_fkey\(name, email, phone, is_fixture\)/);
  });

  it("does not add a SECOND embed on the same relation", () => {
    // Two FKs from vendors to users: a bare or duplicated embed is PGRST201,
    // which showed an empty Crews tab reading "nobody invited yet".
    expect(crewsData.split("users!vendors_user_id_fkey(").length - 1).toBe(1);
  });

  it("carries it onto the view model as a label, not as a gate", () => {
    // `=== true`: an invited crew with no user row yet is unclaimed, not a
    // fixture. The fences elsewhere use `!== false` because refusing work on a
    // missing row is the safe direction; labelling a real crew is not.
    expect(crewsData).toMatch(/isFixture: u\?\.is_fixture === true/);
  });

  it("and the card actually reads it", () => {
    // A column with no reader is the same defect wearing the other hat.
    expect(crewBoard).toMatch(/crew\.isFixture/);
    expect(crewBoard).toContain("Test account — nothing will route to it");
  });
});
