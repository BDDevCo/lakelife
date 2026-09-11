import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE CREW'S SCREENS, IN A TRUCK, AT 7AM, WITH GLOVES ON.
 *
 * Two classes of defect, both found by walking the crew's day rather than
 * reading the code:
 *
 * THE THUMB. `.ll-btn` lands at 44px from its padding and `.sm` cut that to
 * ~35. The crew's route card is SEVEN `.sm` buttons in a wrapping row, and
 * "Add photos" sits beside "Mark complete" with an 8px gap — so a miss opens
 * the camera instead of closing the job. 44 is this codebase's own number: it
 * is set by hand in 82 other places.
 *
 * THE MONEY. Both crew surfaces claimed "payout released" on completion. The
 * job panel says thirty lines earlier that a make-it-right visit "carries no
 * charge and no separate pay", so one of its two sentences was always false;
 * the route card cannot tell the two apart at all, because vendor_jobs does
 * not carry `correction_of`. Neither can know whether the server released
 * anything — that is the photo gate's decision, and this codebase has already
 * had to correct a comment claiming a payout proves the gate passed.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const css = read("../app/globals.css");
const stopCard = strip(read("./VendorStopCard.tsx"));
const jobPanel = strip(read("./VendorJobPanel.tsx"));
const walkAround = strip(read("./WalkAround.tsx"));
const docs = strip(read("./VendorDocs.tsx"));

describe("the scanners are reading the crew's screens", () => {
  it("found them", () => {
    expect(css).toMatch(/\.ll-btn\.sm/);
    expect(stopCard.length).toBeGreaterThan(1000);
    expect(jobPanel.length).toBeGreaterThan(1000);
    expect(walkAround).toMatch(/minHeight/);
  });
});

describe("every control clears a gloved thumb", () => {
  it("a small button is still 44px tall", () => {
    // Measured in the running app after this landed: ll-btn, ll-btn sm,
    // ll-btn ghost sm and ll-btn gold sm all report 44. The last two are the
    // pair that sit side by side on the route card.
    const sm = css.match(/\.ll-btn\.sm\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sm, ".ll-btn.sm was not found").toContain("padding");
    expect(sm, "small buttons dropped back under a thumb").toMatch(/min-height:\s*44px/);
  });

  it("the photo chips clear one too", () => {
    // These ARE the photo gate. A missed tap is a shot not taken, and rule 2
    // means the job cannot complete and the payout cannot release without it.
    // The comment beside this number already named "375px, gloved thumb".
    expect(walkAround).toMatch(/minHeight:\s*44/);
    expect(walkAround, "the walk-around chips went back to 32").not.toMatch(/minHeight:\s*32/);
  });

  it("the document upload is labelled and sized", () => {
    // globals.css gives every control a box and explicitly excludes
    // [type=file], so this was the one input on the card with no styling at
    // all — a bare OS chip under a heading saying jobs cannot be sent without
    // it.
    expect(docs).toMatch(/type="file"/);
    expect(docs, "the file input is unlabelled again").toMatch(/The document itself/);
    expect(docs).toMatch(/minHeight:\s*44/);
  });
});

describe("neither crew screen claims a payout it cannot see", () => {
  it("the route card does not", () => {
    expect(stopCard, "the route card claims a payout for a job it cannot price")
      .not.toMatch(/payout released/);
  });

  it("the job panel does not", () => {
    expect(jobPanel).not.toMatch(/payout released/);
  });

  it("the job panel still says a make-it-right visit is unpaid", () => {
    // The sentence that made the old toast a contradiction must survive — it
    // is the true half.
    expect(jobPanel).toMatch(/no charge and no separate pay/);
  });

  it("and it distinguishes the two on completion", () => {
    // It has `isCorrection`; using it is the whole point.
    expect(jobPanel).toMatch(/isCorrection\s*\n?\s*\?/);
  });

  it("sends them to the screen that does know", () => {
    for (const [name, src] of [["route card", stopCard], ["job panel", jobPanel]] as const) {
      expect(src, `${name} says nothing about where pay is`).toMatch(/earnings screen/);
    }
  });
});

/**
 * PARK WORK AND LAKE-HOME WORK, AT THE FIRST DOOR.
 *
 * MyServicesEditor's own header describes this bug in the PAST tense —
 * "Onboarding drew them as adjacent chips in one flat list" — and it was only
 * ever fixed on the screen a LIVE crew edits. The first door, which is the one
 * a crew recruited to mow The Haven actually walks through, went on drawing
 * twenty services as one alphabetical grid with "Lawn mowing & trim" and "Park
 * grounds mowing & trim" three chips apart.
 *
 * `isEligible` and `canClaim` both match on exact membership, so tapping the
 * wrong one makes that crew invisible to every park mow — no error, on either
 * side, until somebody wonders why the job never filled.
 */
describe("onboarding tells park work apart from lake-home work", () => {
  const onboarding = strip(read("./VendorOnboarding.tsx"));

  it("found the screen", () => {
    expect(onboarding.length).toBeGreaterThan(1000);
    expect(onboarding).toMatch(/ToggleChips/);
  });

  it("groups the chips instead of listing them flat", () => {
    // THE RENDER, NOT THE VARIABLE. A first version of this checked only that
    // the file MENTIONED lakeHomeWork — which stays true when the group is
    // switched off, so disabling it left the test green. Matching the prop
    // that actually feeds the chips is what makes the mutation bite.
    expect(onboarding, "the chips are one flat list again")
      .toMatch(/options=\{lakeHomeWork\}/);
    expect(onboarding).toMatch(/options=\{parkWork\}/);
    // And the two lists must be derived from the flag, not hand-written.
    expect(onboarding).toMatch(/filter\(\(s\) => !s\.parkOnly\)/);
    expect(onboarding).toMatch(/filter\(\(s\) => s\.parkOnly\)/);
  });

  it("says out loud which group is a park's", () => {
    // The heading IS the fix — a crew who does parks knows they do parks.
    expect(onboarding).toMatch(/Parks/);
    expect(onboarding).toMatch(/priced per lot/);
  });

  it("every loader feeding it carries the flag", () => {
    // FOUR of them, found by the compiler rather than by grep: the vendor
    // home, earnings, import and open all build this screen's props from
    // their own read. One left on select("name") would render every service
    // as lake-home work.
    for (const rel of [
      "../app/vendor/page.tsx",
      "../app/vendor/earnings/page.tsx",
      "../app/vendor/import/page.tsx",
      "../app/vendor/open/page.tsx",
    ]) {
      const src = strip(read(rel));
      expect(src, `${rel} still reads services without park_only`).toMatch(/select\("name, park_only"\)/);
    }
  });
});
