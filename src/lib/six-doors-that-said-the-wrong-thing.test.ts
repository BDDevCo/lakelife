import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * SIX FROM THE VERIFIED TAIL, each confirmed by two or three skeptics — and
 * three of them the same shape: THE RIGHT THING ALREADY EXISTED AND THIS
 * DOORWAY DID NOT USE IT.
 *
 *  - A lost session told a resident to "have a word with the office". The
 *    sentence for a lost session (`not_signed_in`) had existed in
 *    sms-consent.ts the whole time; myFile() returned the same shape for
 *    "no session" and "no file", so nothing ever selected it.
 *  - "Sign in first" on the park page was a bare sentence: no link, no button.
 *    SignInHere — sign in over the screen you are on and come back — was
 *    already written for the claim screen.
 *  - A re-run of guided setup wiped a saved pane count to zero. The wizard was
 *    innocent; its CALLER built `initial` from every profile field except the
 *    two 0159 added, though the loader returned both.
 *
 * And three plain lies:
 *  - The crew's stop card fell back to the string "Address on file" in
 *    precisely the case where there is none.
 *  - /for-parks sold "repairs" to insured crews. No repair service exists and
 *    nothing turns a resident's report into one.
 *  - The claim screen's field was labelled "Park" and wanted a URL slug; the
 *    slip in her hand says "The Haven".
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

describe("a lost session is not a lost lot", () => {
  const src = strip(read("../app/parks/consent-actions.ts"));

  it("tells the two apart at the source", () => {
    expect(src, "myFile still returns one shape for no-session and no-file")
      .toMatch(/if \(!user\) return \{ file: null, signedOut: true \}/);
  });

  it("every caller says 'sign in again' for the session case", () => {
    const n = (src.match(/optInSays\(signedOut \? "not_signed_in" : "no_file"\)/g) ?? []).length;
    expect(n, "a caller still sends a signed-out resident to the office").toBe(3);
  });

  it("uses the sentence that already existed", () => {
    expect(read("./sms-consent.ts")).toMatch(/not_signed_in:\s*"Sign in again/);
  });
});

describe("the park page's sign-in comes back", () => {
  const src = strip(read("../components/ParkApply.tsx"));
  it("is a button that returns her to this page, not a sentence", () => {
    expect(src).not.toMatch(/Sign in first and we/);
    expect(src).toMatch(/<SignInHere/);
    expect(src).toMatch(/window\.location\.pathname/);
  });
});

describe("guided setup hands over everything it loaded", () => {
  const src = strip(read("../app/profile/setup/page.tsx"));
  it("passes panes and drive_band like it passes lat and lng", () => {
    for (const f of ["lat", "lng", "panes", "drive_band"]) {
      expect(src, `${f} is not handed to the wizard`).toMatch(new RegExp(`${f}:\\s*profile\\.${f}\\s*\\?\\?\\s*undefined`));
    }
  });
});

describe("three sentences that were not true", () => {
  it("the stop card says there is no address, when there is none", () => {
    const src = strip(read("../components/VendorStopCard.tsx"));
    expect(src).not.toMatch(/\?\?\s*"Address on file"/);
    expect(src).toMatch(/No address on file/);
  });

  it("/for-parks sells what a park can actually buy", () => {
    const src = strip(read("../app/for-parks/page.tsx"));
    // Seven park-bookable services exist; none is a repair.
    expect(src).not.toMatch(/\brepairs?\b/i);
    expect(src).not.toMatch(/work orders/i);
    expect(src).not.toMatch(/\bfixing\b/i);
  });

  it("the claim screen asks for the park by the name on the slip", () => {
    const ui = strip(read("../components/ClaimMyLot.tsx"));
    expect(ui).toMatch(/Park name/);
    expect(ui).not.toMatch(/placeholder="the-haven"/);
    const server = strip(read("../app/parks/claim-actions.ts"));
    expect(server, "a typed name is not resolved to a slug").toMatch(/resolveParkSlug\(/);
    expect(server).toMatch(/\.ilike\("name", typed\)/);
  });
});
