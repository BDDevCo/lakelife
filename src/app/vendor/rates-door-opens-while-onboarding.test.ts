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

  it("and EVERY invitation names the money before it says Go live", () => {
    // THE RULE, NOT A LITERAL. This used to grep for the exact phrase "Set what
    // you charge" and require it before the first "Go live" — which worked for
    // as long as there was one invitation email. 0181 added a second: a crew
    // ops set up on the phone is sent a two-step note ("your lakes, your days
    // and your rates are waiting — check them and confirm") rather than the
    // six-step wizard, and that body carries no such phrase. The literal went
    // red while the rule it stood for was perfectly intact.
    //
    // So the rule is stated instead: in each body, the crew is told about their
    // money BEFORE they are told to flip themselves live. Telling somebody to
    // go live first is telling them to start taking work they have no price
    // for — and dispatch will then never offer them any of it, silently.
    //
    // SCOPED TO THE BODIES, NOT THE FILE. The first attempt at this sliced the
    // whole source and passed against a deliberately broken email, because the
    // word "rates" appears all over the code around it —
    // `crew_setup_proposed_rates`, `rateRows`. A copy rule has to be asked of
    // the copy.
    const invite = src("app/ops/crews-invite.ts");
    const at = invite.indexOf("const steps = preFilled");
    expect(at, "the invitation no longer branches — this is measuring nothing").toBeGreaterThan(-1);
    const region = invite.slice(at, invite.indexOf("return sendEmail({", at));
    const split = region.indexOf(": html`");
    expect(split, "the two invitation bodies can no longer be told apart").toBeGreaterThan(-1);

    const bodies: Array<[string, string]> = [
      ["the pre-filled invitation", region.slice(0, split)],
      ["the six-step invitation", region.slice(split)],
    ];
    for (const [name, body] of bodies) {
      expect(body, `${name} no longer tells anybody to go live`).toMatch(/Go live/);
      const live = body.indexOf("Go live");
      expect(
        body.slice(0, live),
        `${name} reaches "Go live" without having mentioned what they charge`,
      ).toMatch(/(rates\b|what you charge)/i);
    }
  });
});
