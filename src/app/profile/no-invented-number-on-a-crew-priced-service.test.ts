import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  priceCellLabel,
  CREW_QUOTED_CELL,
  CREW_QUOTED_HINT,
} from "@/components/ProfileWizard";

/**
 * WHAT A HOMEOWNER IS SHOWN BEFORE A CREW EXISTS.
 *
 * On a `crew_priced` service (0174) there is no menu price, because LakeLife
 * does not set one — that is the whole decision:
 *
 *   "I do not want lakelife setting the pricing for crews, that doesnt make us
 *    3rd part enough ... now if there is more than one crew that has been
 *    onboarded at a lower rate the homeowner should be given the options
 *    available, and what days and the crew rating ... then they make the
 *    decision."
 *
 * So an indicative LakeLife number is not a helpful placeholder, it is the menu
 * wearing a hat: every crew would price to it. And "$0" is worse — it reads as
 * free. The customer is shown no number and told something true instead.
 */

describe("a price slot with no LakeLife price in it", () => {
  it("shows the real number on an ordinary service", () => {
    expect(priceCellLabel(485, false)).toBe("$485");
    expect(priceCellLabel(485, false, "per trip")).toBe("$485 per trip");
  });

  it("never prints a dollar figure on a crew-priced one", () => {
    expect(priceCellLabel(485, true)).toBe(CREW_QUOTED_CELL);
    expect(priceCellLabel(485, true, "per trip")).toBe(CREW_QUOTED_CELL);
    expect(priceCellLabel(485, true)).not.toContain("$");
  });

  it("never prints $0 on a crew-priced one either", () => {
    // priceService returns 0 for these rows by design — a $0 slot would read
    // as free, which is the same lie with a different number.
    expect(priceCellLabel(0, true)).toBe(CREW_QUOTED_CELL);
    expect(priceCellLabel(0, true)).not.toContain("0");
  });

  it("says who sets the price and when the customer will see it", () => {
    // The sentence has to be true of the product, not just non-committal.
    expect(CREW_QUOTED_HINT).toContain("set their own price");
    expect(CREW_QUOTED_HINT).toContain("when you book");
    // It must not blame the customer for an empty crew bench.
    expect(CREW_QUOTED_HINT).not.toContain("No services chosen");
  });
});

const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const menuFn = () => {
  const src = code("app/profile/data.ts");
  const fn = src.match(/export async function getPricedServices[\s\S]*?\n}/)?.[0] ?? "";
  expect(fn.length, "getPricedServices not found — this scan is measuring nothing")
    .toBeGreaterThan(400);
  return fn;
};

describe("the booking menu asks, and does not invent", () => {
  it("selects crew_priced at all", () => {
    expect(menuFn()).toMatch(/crew_priced/);
  });

  it("returns 0 rather than a priced guess on a crew-priced row", () => {
    expect(menuFn()).toMatch(/price: crewPriced \? 0 : priceService\(/);
  });

  it("sends the true sentence along with the empty number", () => {
    // A caller that prints `price` without reading `crewPriced` shows $0. The
    // sentence travels on the same row so the fix is one field away.
    expect(menuFn()).toMatch(/priceNote: crewPriced \? CREW_QUOTES_THIS : null/);
  });

  it("a crew-priced service the property cannot use is still no tile", () => {
    // `price > 0` on /book has always done TWO jobs: drop the unpriced, and
    // drop the inapplicable — "Pier install / removal — $0" on a mobile home.
    // A crew-priced row prices to 0 for both reasons and cannot tell them
    // apart, so /book had to start keeping `crewPriced` rows regardless of
    // price. Without this gate that reopens the exact dead end the filter was
    // added to kill: a lake house with no boat handed a crew-quoted boat-lift
    // tile. serviceApplies counts the equipment, not the money.
    expect(menuFn(), "the crew-priced branch must be gated on serviceApplies")
      .toMatch(/serviceApplies\(s as unknown as ServiceRule, pp\)/);
    // And /book must be the caller that relies on it.
    const bookPage = readFileSync(join(process.cwd(), "src/app/book/page.tsx"), "utf8");
    expect(bookPage).toMatch(/priced\.filter\(\(s\) => s\.price > 0 \|\| s\.crewPriced\)/);
  });

  it("A PARK IS NEVER CREW-PRICED, in the code as well as in the database", () => {
    // The Haven's mow is the $125 Mike negotiated and 21 households sign
    // leases against $400 + $142.53 on 1 January. None of that is a crew's to
    // quote. 0174 refuses park_only AND crew_priced at the database; this is
    // the same rule in the doorway the park menu actually runs through.
    expect(menuFn()).toMatch(/!isGrounds && !s\.park_only/);
  });
});

describe("the wizard only changes when the service does", () => {
  it("reads the flag off the service rather than a list of names", () => {
    const src = code("components/ProfileWizard.tsx");
    expect(src.length, "ProfileWizard not found").toBeGreaterThan(5000);
    expect(src).toMatch(/const crewQuotes = \(name: string\) => !!rule\(name\)\?\.crew_priced;/);
  });

  it("guards every price slot in the wizard, not just some of them", () => {
    // A rule in one doorway of three is not a rule. Every formatPrice call on
    // a SERVICE price must sit behind a crewQuotes check; the only bare ones
    // left are inside priceCellLabel itself and the two band helpers, which
    // are each wrapped at their call site.
    const src = code("components/ProfileWizard.tsx");
    for (const name of [
      "Pier install / removal",
      "Boat lift set / pull",
      "Boat storage & winterize",
      "Window washing",
      "Lawn mowing & trim",
      "Snow removal — drive & walks",
    ]) {
      expect(src, `${name} still prints a price without checking crew_priced`)
        .toMatch(new RegExp(`crewQuotes\\("${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)|priceText\\("${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    }
  });

  /**
   * THIS TEST PINNED THE LIE, AND IT IS THE MOST EXPENSIVE SHAPE THERE IS.
   *
   * It read `anyCrewQuoted ? "" : ", priced exactly to your place"` and
   * asserted, correctly, that the clause is dropped when a chosen service is
   * crew-quoted. Code, comment and test all agreed — and all three were wrong
   * about what was being enforced. The hedge only ever answered WHO names the
   * price. It never answered whether the number is FIRM, and on the
   * menu-priced branch it is not: every figure in that recap descends from
   * lakelife.html (0047 seeded $220 + $48/section straight out of the
   * prototype, with no source note), and no crew has been onboarded to agree
   * to one. So "priced exactly to your place" was false on exactly the branch
   * this test protected.
   *
   * Updated to the new sentence rather than deleted or loosened: the BRANCH is
   * still real and still worth pinning — it is why a crew-quoted menu says
   * nothing about pricing and shows CREW_QUOTED_HINT instead. Only the words
   * inside it changed, to the arithmetic half every other screen now uses.
   */
  it("the recap's pricing clause is about the property, not about firmness", () => {
    const src = code("components/ProfileWizard.tsx");
    expect(src).toMatch(/anyCrewQuoted \? "" : ", priced from what's actually on your place"/);
    // Collapsed the other way too: the claim this replaced must not come back.
    expect(src, "the old firmness claim is back in the recap")
      .not.toContain("priced exactly to your place");
  });
});
