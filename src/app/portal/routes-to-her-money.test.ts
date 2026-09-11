import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A RESIDENT WHO MOVES OUT STILL OWNS HER MONEY.
 *
 * /portal is the only navigation a resident has — "My portal" in the top bar.
 * It looked for a tenancy in `approved|active` and, finding none the day the
 * office closed her out, fell through to /book: the lake-house booking page,
 * offered to somebody waiting on a deposit.
 *
 * Both things she is still owed live on /parks/my and are raised AFTER the
 * move-out: the deposit, and the final prorated month, which `runCharges`
 * deliberately bills late (0101). So the screen holding her money existed, was
 * correct, and was reachable only by typing the URL.
 *
 * THE APPLICANT MUST STILL BE SENT ON, which is what the original filter was
 * right about — somebody who applied and was never approved has no row in any
 * of the three states, so they keep going to the ordinary customer door. That
 * is why this widens to a THIRD state rather than dropping the filter.
 *
 * Scanned rather than executed: /portal is a server component whose whole
 * behaviour is `redirect()` calls against a live session, and the thing worth
 * pinning is which states it treats as "she is still owed something".
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const portal = strip(read("./page.tsx"));

describe("the scanner is reading the portal", () => {
  it("found the tenancy lookup it judges", () => {
    // Without this, every assertion below passes against an empty string.
    expect(portal.length, "portal/page.tsx did not load").toBeGreaterThan(1000);
    expect(portal, "the resident branch is gone").toMatch(/lot_reservations/);
    expect(portal).toMatch(/\/parks\/my/);
  });
});

describe("which tenancies still route to her own screen", () => {
  it("includes ENDED — the state that holds her deposit", () => {
    expect(
      portal,
      "a resident who moved out is sent to the lake-house booking page while the park still holds her deposit",
    ).toMatch(/\.in\("status",\s*\[\s*"approved",\s*"active",\s*"ended"\s*\]\)/);
  });

  it("still recognises a live tenancy", () => {
    // The other half of the mutation: widening must not drop the states that
    // were already right.
    const m = portal.match(/\.in\("status",\s*\[([^\]]*)\]\)/);
    expect(m, "the status filter was removed rather than widened").toBeTruthy();
    expect(m![1]).toContain('"approved"');
    expect(m![1]).toContain('"active"');
  });

  it("does not simply drop the filter and route everyone", () => {
    // A claimed file with NO reservation row at all is an applicant. Sending
    // them to /parks/my would show a screen that only says they have no lot —
    // which is what the original comment was right about.
    expect(portal, "the tenancy filter was removed entirely").toMatch(/\.in\("status"/);
  });

  it("no longer explains itself with the reasoning it abandoned", () => {
    // The comment used to justify the narrow filter: "A claimed file with no
    // live tenancy is an applicant, not a resident." Leaving that in place
    // above a widened filter is this project's copy-that-lies class, in a
    // comment — the next reader would narrow it back.
    expect(portal).not.toMatch(/no live tenancy is an applicant/);
  });
});
