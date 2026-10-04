import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE ONE PUBLIC SURFACE IN THIS PRODUCT THAT PRINTS A DOLLAR FIGURE.
 *
 * `fromPrice` builds "From $400/month" out of the LOT RATES alone, and this
 * page never read park_fees. The Haven holds an active "Grounds fee" of
 * $142.53 monthly on long_term, so the day `parks.active` flips a stranger
 * would read $400 against a bill of $542.53 — a figure understating the real
 * cost by a third, on the page a prospective resident acts on.
 *
 * It is latent only because the park is inactive and getPublicPark returns
 * null before any of this. The whole point of that column is that it flips.
 *
 * WHAT TO PUBLISH INSTEAD IS HIS CALL — all-in, or the rate with an explicit
 * exclusion line. This pins the action that is correct under EITHER answer:
 * while a monthly long-term fee is in force, no figure is published at all.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Comments are stripped before every scan. The strings this file looks for are
 * quoted in the prose that explains them, so a raw scan would match its own
 * explanation — the false alarm the one-household rehearsal hit on
 * charge-edits.ts, and the reason that file now strips too.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flat = (s: string) => strip(s).replace(/\s+/g, " ");

describe("a published rate must not understate the bill", () => {
  const src = flat(read("./public-data.ts"));

  it("the public loader reads the park's fees", () => {
    // Before this change it did not read park_fees at all, by any name.
    expect(src, "the public page is not asking what else a resident owes")
      .toContain('from("park_fees")');
  });

  it("and asks only about the fees that actually bill a long-term resident", () => {
    // 0182's rule: monthly x long_term is the only shape that bills. A pet or
    // annual fee is not part of a monthly "from" figure and must not suppress
    // it, or the page goes silent for a fee nobody is charged.
    expect(src).toContain('.eq("cadence", "monthly")');
    expect(src).toContain('.eq("applies_to", "long_term")');
    expect(src).toContain('.eq("active", true)');
  });

  it("suppresses the figure on BOTH surfaces, not just the headline pill", () => {
    // The park-level `from` feeds the pill AND the meta description; the
    // lot-level `from` feeds each listed site. Fixing one and not the other
    // leaves the number on the page in a different place — this codebase's
    // most repeated shape.
    const guarded = src.match(/priceWouldUnderstate \? null : fromPrice\(/g) ?? [];
    expect(guarded, "a `from` was left computing a price the fees contradict")
      .toHaveLength(2);
  });

  it("fails CLOSED — a fee read that errored suppresses the price too", () => {
    // "We could not check what else they owe" is not a licence to publish the
    // smaller number. A failed read is not an empty one.
    expect(src).toMatch(/feeRows\.error !== null \|\|/);
  });

  it("the scan bites — it would catch the code reverting", () => {
    // Absence-only assertions pass against a scanner that has been quietly
    // broken. These are the literals as of 4 October 2026; if the shapes below
    // stop being findable, the assertions above are measuring nothing.
    expect(src).toContain("fromPrice(");
    expect(src).toContain("priceWouldUnderstate");
    // AND THE STRIPPER REALLY STRIPS — proved on a fixture, NOT on this file.
    //
    // The first version of this assertion stripped this test's own source and
    // went red. The reason is worth keeping: a comment-stripper cannot be
    // trusted against its OWN text, because its regex literals contain the
    // very open- and close-comment sequences it hunts for, so the pattern
    // matches itself and eats part of the file. A fixture has no such problem.
    const fixture = "/* a stranger would read $400 */ const keep = 1; // and $542.53\nconst also = 2;";
    expect(flat(fixture)).not.toContain("$400");
    expect(flat(fixture)).not.toContain("$542.53");
    expect(flat(fixture)).toContain("const keep = 1;");
    expect(flat(fixture)).toContain("const also = 2;");
  });
});
