import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  leaveWarning, leavingLosesWork, sameAfterBuilding, sameForm,
  unsavedButtonLabel, unsavedSentence,
} from "./unsaved-helpers";
import { buildParkDialsRow, buildParkProfileRow } from "@/app/park/park-helpers";

/**
 * FOUR SAVE BUTTONS, AND THE WRONG ONE SAID "SAVED."
 *
 * /park/setup stacks four cards, each with its own Save and its own server
 * action. Two tracked whether they held an edit; two did not. So: type into
 * the park profile at the bottom, scroll up, press the Save you can see
 * ("Save how this park runs"), read "Saved." — and the profile edit is still
 * sitting in the box, where it stayed until he tapped a nav tab and it went.
 *
 * The toast was true about the card it came from. That is what made it
 * expensive: nothing on the screen was wrong, and the work was gone anyway.
 */

const src = (f: string) =>
  readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CARDS = [
  { file: "./ParkStreams.tsx", key: "park-streams", label: "What this park earns from" },
  { file: "./ParkDials.tsx", key: "park-dials", label: "How this park runs" },
  { file: "./ParkOnlineRent.tsx", key: "park-online-rent", label: "How rent comes in" },
  { file: "./ParkSetup.tsx", key: "park-profile", label: "How your park runs" },
];

describe("every card on the setup page knows whether it holds an edit", () => {
  it.each(CARDS)("$label registers itself, by name", (card) => {
    const s = src(card.file);
    expect(s.length, "the scan is measuring nothing").toBeGreaterThan(500);
    expect(s, `${card.file} does not register with the unsaved bar`)
      .toMatch(/useUnsavedCard\(/);
    expect(s).toContain(`key: "${card.key}"`);
    // The label is the card's own heading. A bar that says "section 2" tells
    // him nothing about which of his edits is at risk.
    expect(s).toContain(`label: "${card.label}"`);
  });

  it.each(CARDS)("$label has no live Save when there is nothing to save", (card) => {
    const s = src(card.file);
    // Either the button is gated on dirty, or it is not rendered unless dirty
    // (ParkStreams hides it entirely). Both are the same guarantee: the
    // button he can press is never one that lies about his work.
    const gated = /disabled=\{[^}]*!dirty/.test(s);
    const hidden = /\{dirty && \(/.test(s);
    expect(gated || hidden, `${card.file}'s Save is live with nothing to save`).toBe(true);
  });

  it("no card falls back to the bare word that caused this", () => {
    // "Saved." on a page with four Save buttons cannot say which card it came
    // from, and that ambiguity is the whole defect. Every fallback now names
    // its own card. (The server's own signal is preferred where it has one.)
    for (const card of CARDS) {
      const s = src(card.file);
      expect(s, `${card.file} still falls back to a toast that names nothing`)
        .not.toMatch(/\?\?\s*"Saved\."/);
    }
  });

  it("the page mounts the bar, or none of the above does anything", () => {
    const page = src("../app/park/setup/page.tsx");
    expect(page).toMatch(/<UnsavedWatch>/);
    expect(page).toMatch(/<\/UnsavedWatch>/);
    expect(page).toMatch(/import \{ UnsavedWatch \}/);
  });
});

describe("the sentence names the work, never counts it", () => {
  it("names one card", () => {
    expect(unsavedSentence(["How this park runs"]))
      .toBe("You've changed “How this park runs” and haven't saved it yet.");
  });

  it("names all of them when more than one is open", () => {
    const s = unsavedSentence(["How this park runs", "How your park runs"]);
    expect(s).toContain("How this park runs");
    expect(s).toContain("How your park runs");
    // Small-N naming: at four cards you say the four words rather than a
    // number he cannot act on.
    expect(s).not.toMatch(/\b2 (unsaved|changes)/);
  });

  it("says nothing when nothing is unsaved", () => {
    expect(unsavedSentence([])).toBeNull();
    expect(unsavedSentence(["  "])).toBeNull();
  });

  it("is one tap whether it is one card or four", () => {
    expect(unsavedButtonLabel(1)).toBe("Save it");
    expect(unsavedButtonLabel(4)).toBe("Save all of it");
  });

  it("the leave warning says what is lost, not what the software is feeling", () => {
    const w = leaveWarning(["How your park runs"]);
    expect(w).toContain("How your park runs");
    expect(w).toMatch(/lost/);
  });
});

describe("a form that matches what it loaded with is not an edit", () => {
  const initial = {
    name: "The Haven", address: "9085 E 500 S", parkType: "mobile",
    ageRestricted: false, approvalRequired: true,
    seasonOpen: "", seasonClose: "",
    includedUtilities: ["water", "sewer"], houseRules: "",
  };

  it("an untouched form is clean", () => {
    expect(sameForm(initial, { ...initial })).toBe(true);
  });

  it("a typed character is an edit", () => {
    expect(sameForm(initial, { ...initial, name: "The Haven " })).toBe(false);
  });

  it("a flipped switch is an edit", () => {
    expect(sameForm(initial, { ...initial, approvalRequired: false })).toBe(false);
  });

  it("A CHIP TOGGLED OFF AND BACK ON IS NOT AN EDIT", () => {
    // The trap this exists for: the utilities are toggled, so turning Water
    // off and on again leaves the same facts in a different order. Compared as
    // a sequence the card would read dirty forever, with nothing on screen to
    // explain it — and the bar would nag about work already saved, which is
    // how a warning stops being read.
    expect(sameForm(initial, { ...initial, includedUtilities: ["sewer", "water"] })).toBe(true);
  });

  it("but adding or dropping one is", () => {
    expect(sameForm(initial, { ...initial, includedUtilities: ["water"] })).toBe(false);
    expect(sameForm(initial, { ...initial, includedUtilities: ["water", "sewer", "trash"] })).toBe(false);
  });
});

/**
 * THE TRAP ParkOnlineRent HAD ALREADY WRITTEN DOWN.
 *
 * These forms are strings on screen and numbers and trimmed text in the
 * database. `getParkDials` reads a numeric column back through `String(v)`;
 * the builder writes it through `wholeNumber`, which trims. So "03" saves as
 * 3 and reads back as "3" — while the component still holds "03", because
 * `router.refresh()` re-renders without remounting.
 *
 * Compared as typed, the card is dirty FOREVER after a save that worked: the
 * button never returns to "Saved" and the bar nags about work saved a minute
 * ago. Which is how a warning becomes noise and stops being read — the one
 * thing this whole module must not do.
 */
describe("a save that worked leaves the card clean", () => {
  const dials = {
    maxAgreementMonths: "3", depositAmount: "400", rentDueDay: "1",
    officeRecordingLagDays: "5", rentNoticeDays: "45", cutoverOn: "2027-01-01",
  };
  const clean = (a: typeof dials, b: typeof dials) =>
    sameAfterBuilding(a, b, buildParkDialsRow);

  it("A LEADING ZERO IS NOT AN EDIT", () => {
    // Types "03" over "3". Saves as 3. Reads back "3". Still clean.
    expect(clean({ ...dials, maxAgreementMonths: "03" }, dials)).toBe(true);
  });

  it("and neither is a space around a number", () => {
    expect(clean({ ...dials, rentNoticeDays: " 45 " }, dials)).toBe(true);
  });

  it("A DOLLAR SIGN AND A COMMA ARE NOT AN EDIT", () => {
    expect(clean({ ...dials, depositAmount: "$400" }, dials)).toBe(true);
    expect(clean({ ...dials, depositAmount: "400.00" }, dials)).toBe(true);
  });

  it("but a different number is", () => {
    expect(clean({ ...dials, maxAgreementMonths: "6" }, dials)).toBe(false);
    expect(clean({ ...dials, depositAmount: "500" }, dials)).toBe(false);
    expect(clean({ ...dials, cutoverOn: "2027-02-01" }, dials)).toBe(false);
  });

  it("clearing a dial is an edit — a park with no cap is a real answer", () => {
    expect(clean({ ...dials, maxAgreementMonths: "" }, dials)).toBe(false);
  });

  it("AN INVALID FORM IS DIRTY, because the input is unsaved and unsavable", () => {
    // Mid-typing. The bar should be warning about this, not calling it clean.
    expect(clean({ ...dials, maxAgreementMonths: "abc" }, dials)).toBe(false);
    expect(clean({ ...dials, rentDueDay: "99" }, dials)).toBe(false);
  });

  it("the park profile is judged the same way", () => {
    const profile = {
      name: "The Haven", address: "9085 E 500 S", parkType: "mh",
      ageRestricted: false, approvalRequired: true,
      seasonOpen: "", seasonClose: "",
      includedUtilities: ["water", "sewer"], houseRules: "",
    };
    const same = (a: typeof profile) => sameAfterBuilding(a, profile, buildParkProfileRow);
    // `name` is saved trimmed, so a trailing space is not an edit.
    expect(same({ ...profile, name: "The Haven " })).toBe(true);
    // `address` and `house_rules` become null when blank.
    expect(same({ ...profile, houseRules: "   " })).toBe(true);
    // A chip toggled off and back on is still not an edit.
    expect(same({ ...profile, includedUtilities: ["sewer", "water"] })).toBe(true);
    // A real change still is.
    expect(same({ ...profile, name: "The Haven Park" })).toBe(false);
    expect(same({ ...profile, approvalRequired: false })).toBe(false);
  });

  it("both cards run the REAL builder, not a copy of its rules", () => {
    // A rebuilt expression passes when you delete the real one.
    for (const [file, builder] of [
      ["./ParkDials.tsx", "buildParkDialsRow"],
      ["./ParkSetup.tsx", "buildParkProfileRow"],
    ] as const) {
      const s = src(file);
      expect(s, `${file} does not compare what would be written`)
        .toMatch(new RegExp(`sameAfterBuilding\\([^)]*${builder}\\)`));
      expect(s).toMatch(new RegExp(`import \\{[^}]*${builder}`));
    }
  });
});

/**
 * WHICH CLICKS LOSE WORK.
 *
 * The browser's own unload prompt covers closing the tab, reloading and
 * leaving the site. It does NOT see a client-side route change — which is
 * every tab in ParkNav and the agreements link at the foot of this very
 * screen. That is the tap that dropped the edit in silence, so that is the one
 * held back; everything that keeps this page alive is left alone.
 */
describe("leaving the screen", () => {
  const here = "/park/setup";
  const at = (over: Partial<Parameters<typeof leavingLosesWork>[0]> = {}) =>
    leavingLosesWork({ dirty: true, href: "/park/today", currentPath: here, ...over });

  it("a nav tab with an edit open is held back", () => {
    expect(at()).toBe(true);
  });

  it("nothing is held back when nothing is unsaved", () => {
    expect(at({ dirty: false })).toBe(false);
  });

  it("cmd-click and middle-click are not held back — this page survives them", () => {
    expect(at({ modified: true })).toBe(false);
  });

  it("a new tab is not held back", () => {
    expect(at({ target: "_blank" })).toBe(false);
  });

  it("a download is not a navigation", () => {
    expect(at({ download: true })).toBe(false);
  });

  it("an in-page anchor goes nowhere", () => {
    expect(at({ href: "#rules" })).toBe(false);
  });

  it("the page he is already on goes nowhere", () => {
    expect(at({ href: "/park/setup" })).toBe(false);
    expect(at({ href: "/park/setup/" })).toBe(false);
    expect(at({ href: "/park/setup#rules" })).toBe(false);
    expect(at({ href: "/park/setup?tab=2" })).toBe(false);
  });

  it("mailto and tel open an app, not a page", () => {
    expect(at({ href: "mailto:hello@lakelife.ai" })).toBe(false);
    expect(at({ href: "tel:+12605551234" })).toBe(false);
  });

  it("an off-site link is a full load, which the browser already asks about", () => {
    expect(at({ href: "https://www.lakelife.ai/sms" })).toBe(false);
    expect(at({ href: "//cdn.example.test/x" })).toBe(false);
  });

  it("an anchor with no href is not a link", () => {
    expect(at({ href: null })).toBe(false);
    expect(at({ href: "  " })).toBe(false);
  });

  it("and /park itself — the rent roll — is held back like any other tab", () => {
    // Worth its own case: `/park` is a prefix of this route, and a sloppy
    // same-page check that compared prefixes would wave through the one tab
    // most likely to be tapped next.
    expect(at({ href: "/park" })).toBe(true);
  });
});

/**
 * THE GUARD ITSELF.
 *
 * Two properties, both of which a refactor could quietly undo: the listener
 * has to run before the router does anything, and a card that goes clean has
 * to leave the bar.
 */
describe("the guard is wired the only way that works", () => {
  const guard = src("./UnsavedGuard.tsx");

  it("catches the click before the router sees it", () => {
    expect(guard.length).toBeGreaterThan(1000);
    // Capture phase. In the bubble phase Next's Link has already called
    // router.push and the component holding the edit is being unmounted.
    expect(guard, "a bubble-phase listener is too late to stop a route change")
      .toMatch(/addEventListener\("click",\s*onClick,\s*true\)/);
  });

  it("asks the browser about a full unload too", () => {
    expect(guard).toMatch(/addEventListener\("beforeunload"/);
  });

  it("a card that goes clean leaves the bar", () => {
    // Otherwise the bar outlives the edit and nags about saved work.
    expect(guard).toMatch(/if \(!dirty\) \{ ctx\.forget\(key\); return; \}/);
  });

  it("the bar renders nothing when nothing is unsaved", () => {
    expect(guard).toMatch(/if \(cards\.length === 0\) return null;/);
  });

  it("a screen that has not opted in still works", () => {
    // The hook is used by four cards; three of those cards are also rendered
    // on other screens. No context must mean no tracking, never a crash.
    expect(guard).toMatch(/if \(!ctx\) return;/);
  });
});
