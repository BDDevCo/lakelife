import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STEP 4 OF THE INVITATION HAD NO DOOR UNTIL THE CREW WAS LIVE.
 *
 * The email ops sends a crew makes "set what you charge" step 4 (the bank is
 * 5 and "Tap Go live" is 6), and VendorNav renders the Rates tab directly
 * above that checklist. The tab answered step 4 by returning the wizard —
 * the same six steps, none of them about money, and the wizard offers no rates
 * control at all. MyServicesEditor points an onboarding crew at the same tab.
 *
 * The permission was never missing. rates-data.ts has said since it was written
 * that "a still-onboarding crew can set rates", getMyRates asks only
 * getMyVendorId, and setMyRate refuses a SUSPENDED crew and nothing else. The
 * right thing existed one import away and the door didn't use it — which is why
 * the fix is a deletion, not a new capability.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = (rel: string) => strip(readFileSync(join(process.cwd(), "src", rel), "utf8"));

describe("the rates tab answers an onboarding crew", () => {
  const page = src("app/vendor/rates/page.tsx");

  const EARLY_RETURN = /if \(vendor && vendor\.status !== "active"\)/;

  it("no longer bounces them into the wizard", () => {
    expect(page, "the Rates tab still hides itself from the crew the email sends there")
      .not.toMatch(EARLY_RETURN);
    expect(page, "the wizard is still what this tab renders").not.toMatch(/VendorOnboarding/);
  });

  it("renders the rates screen, and still reads the rates", () => {
    // Non-vacuity: if either of these goes the test above is measuring a file
    // that no longer does anything.
    expect(page).toMatch(/<VendorRates[\s/>]/);
    expect(page).toContain("getMyRates()");
  });

  it("and says plainly that a rate is not the same as being live", () => {
    // VendorRates says "no rate, no routing", which for an onboarding crew is
    // necessary and not sufficient — dispatch refuses them for not_active
    // whatever they charge. The screen has to carry the other half.
    expect(page).toContain("notLiveYet");
    expect(page).toMatch(/Go live/);
  });

  it("the five other wizard doors are untouched — the scan CAN see that gate", () => {
    // This is what proves the assertions above are not passing on a pattern
    // that silently stopped matching. Today is the crew's route; the wizard
    // belongs there, and there is where "Go live" lives.
    for (const p of [
      "app/vendor/page.tsx",
      "app/vendor/open/page.tsx",
      "app/vendor/schedule/page.tsx",
      "app/vendor/earnings/page.tsx",
      "app/vendor/import/page.tsx",
    ]) {
      expect(src(p), `${p} stopped gating on status — the scan is not measuring a gate`)
        .toMatch(EARLY_RETURN);
    }
  });
});

describe("the data layer already promised this", () => {
  it("getMyRates asks only whether they own a vendors row", () => {
    const data = src("app/vendor/rates-data.ts");
    const fn = data.slice(data.indexOf("export async function getMyRates"));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toContain("getMyVendorId()");
    expect(fn, "a status gate in the data layer would close the door again")
      .not.toMatch(/status/);
  });

  it("and the invitation can keep naming rates before Go live", () => {
    const invite = src("app/ops/crews-invite.ts");
    const rates = invite.indexOf("Set what you charge");
    const live = invite.indexOf("Go live");
    expect(rates).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(-1);
    expect(rates, "the email's order is only honest while the rates door is open")
      .toBeLessThan(live);
  });
});
