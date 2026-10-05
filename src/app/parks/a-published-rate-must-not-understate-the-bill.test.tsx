import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ParkApply is a client component and calls useRouter, which throws outside a
// mounted app router. The router is not what this file is about — the rendered
// price is — so it is stubbed, and nothing else about the component is.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

const { ParkApply } = await import("@/components/ParkApply");
type ApplyLotView = import("@/components/ParkApply").ApplyLotView;

/**
 * THE FIRST VERSION OF THIS TEST PASSED WHILE THE PAGE WAS STILL WRONG.
 *
 * 76647ef suppressed `from` in public-data.ts so the public park page would
 * stop printing "From $400/month" against a $542.53 bill. The suppression was
 * real and it landed on a field NOTHING RENDERED: /parks/[slug] built each
 * site card from `l.rates`, so twenty-one cards and the term picker went on
 * printing $400 while only the headline pill went quiet.
 *
 * The test shipped with it asserted that the string
 * `priceWouldUnderstate ? null : fromPrice(` appeared twice in the source. It
 * did. So the assertion passed, the commit message said "suppresses the figure
 * on BOTH surfaces", and all three agreed about a fact none of them had
 * checked — this codebase's most expensive shape, and the reason the rule is
 * to test the ASSEMBLY rather than a copy of it.
 *
 * So this file renders the component and reads the output. A source scan
 * cannot tell you what a stranger sees.
 */

const lot = (over: Partial<ApplyLotView> = {}): ApplyLotView => ({
  id: "lot-15",
  lotNumber: "15",
  siteType: "mobile_home",
  maxLengthFt: null,
  amperage: null,
  openNow: true,
  rates: [{ term: "monthly", amount: 400 }],
  ratesPublishable: true,
  ...over,
});

const html = (over: Partial<ApplyLotView> = {}) =>
  renderToStaticMarkup(
    <ParkApply parkName="The Haven" approvalRequired={false} lots={[lot(over)]} signedIn={false} />,
  );

describe("a published rate must not understate the bill", () => {
  it("prints NO dollar figure for a site while a fee the rate excludes is in force", () => {
    // The Haven: $400 on the rate card, $142.53 monthly grounds fee, so the
    // real bill is $542.53. Publishing $400 understates it by a third on the
    // page a prospective resident acts on.
    const out = html({ ratesPublishable: false });
    expect(out, "a site card still prints the rate").not.toContain("400");
    expect(out, "the page should say to ask instead").toContain("Ask the park about rates.");
  });

  it("still lets them enquire — withholding a price must not close the door", () => {
    // Emptying `rates` would have suppressed the figure too, and also removed
    // this button (its gate is priced.length > 0). No price is survivable; no
    // way to enquire is not.
    const out = html({ ratesPublishable: false });
    expect(out, "the enquiry button went with the price").toContain("Ask about this site");
  });

  it("and the term picker is gated on the same flag — a SOURCE check, and labelled as one", () => {
    // HONEST ABOUT ITS REACH. The picker lives inside `openLot === lot.id`, so
    // a collapsed card never renders it and renderToStaticMarkup cannot open
    // one. The tests above prove the FLAG works where it can be seen; this one
    // only proves the picker consults the same flag rather than a second,
    // unguarded copy of the amount — which is how the original defect happened.
    const src = readFileSync(
      fileURLToPath(new URL("../../components/ParkApply.tsx", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src, "the picker prints an amount without consulting the flag")
      .toContain("lot.ratesPublishable ? `${r.term}");
  });

  it("COLLAPSED THE OTHER WAY — a park with no such fee still publishes its rate", () => {
    // Absence-only assertions pass against a component that renders nothing at
    // all. This is the case that proves the three above are measuring the flag
    // and not a blank page.
    const out = html({ ratesPublishable: true });
    expect(out).toContain("400");
    expect(out).not.toContain("Ask the park about rates.");
  });
});
