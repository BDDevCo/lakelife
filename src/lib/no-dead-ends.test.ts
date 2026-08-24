import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A SENTENCE THAT TELLS SOMEBODY TO DO SOMETHING MUST LEAVE THEM A WAY TO DO IT.
 *
 * This is the codebase's oldest repeated defect — copy that instructs an action
 * the screen does not offer. A first-run walk of all four roles found three
 * more of it in one pass, and two shared a single root cause.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the scanner", () => {
  it("reads the files it thinks it reads", () => {
    expect(code("../app/profile/page.tsx")).toContain("PaymentMethods");
    expect(code("../components/ClaimMyLot.tsx")).toContain("ClaimMyLot");
  });
});

describe("a card can be added by somebody who owns no lake house", () => {
  const profile = code("../app/profile/page.tsx");

  it("the no-property branch still offers the card form", () => {
    // A card is an ACCOUNT fact, not a property fact. This branch hid the only
    // add-a-card form in the product behind "do you own a lake house?", which
    // stranded a park owner told "There's no card on file" with the switch
    // disabled, and a resident sent here by "Add a way to pay".
    const start = profile.indexOf("if (!profile?.hasProfile)");
    const end = profile.indexOf("let nickname");
    // ANCHORS MUST EXIST. The first version of this sliced to "const nickname",
    // which is not in the file — indexOf returned -1, the slice ran to the end,
    // and it matched the OTHER PaymentMethods in the full-profile render. It
    // passed with the fix reverted, which is worth more than the assertion.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const branch = profile.slice(start, end);
    expect(branch).toContain("<PaymentMethods");
    // and the slice really is just the branch
    expect((branch.match(/<PaymentMethods/g) ?? []).length).toBe(1);
  });

  it("and the full-profile branch still has it too", () => {
    expect((profile.match(/<PaymentMethods/g) ?? []).length).toBe(2);
  });

  it("the two screens that send people there still do", () => {
    expect(code("../components/PayRentButton.tsx")).toContain('href="/profile"');
    expect(code("../app/park/service-helpers.ts")).toMatch(/Add one on your account page/);
  });
});

describe("every park blocker names a destination and offers it", () => {
  const helpers = code("../app/park/service-helpers.ts");
  const view = code("../components/ParkServices.tsx");

  it("the card blocker names where to go", () => {
    const line = helpers.slice(helpers.indexOf("if (!r.hasCard)"));
    expect(line).toMatch(/account page/);
  });

  it("and the list renders a link for it", () => {
    // It was plain <li> text with no links at all — `grep href=` returned
    // nothing — while the two blockers above it named a real ParkNav tab.
    expect(view).toContain('href="/profile"');
    expect(view).toContain('href="/park/setup"');
  });
});

describe("the claim screen's refusals can be acted on", () => {
  const claim = code("../components/ClaimMyLot.tsx");

  it("keeps the outcome, so a refusal can offer a control", () => {
    expect(claim).toMatch(/outcome\?: string/);
  });

  it("wrong account gets a way to switch, not just an instruction", () => {
    // The sentence says "sign in with that account" and there was no way to:
    // the only sign-out is the top bar's, which lands on "/" and throws the
    // claim link and the pre-filled code away. /parks/claim is linked from
    // nowhere, so her only route back was re-scanning the paper slip.
    expect(claim).toContain('said.outcome === "claim_already_set_up"');
    expect(claim).toContain("SwitchAccount");
    expect(claim).toContain("selfUrl");
  });

  it("already-here points at the lot it is talking about", () => {
    expect(claim).toContain('said.outcome === "claim_already_here"');
    expect(claim).toContain('href="/parks/my"');
  });

  it("the page actually passes selfUrl in", () => {
    // The prop existed on the page and was never handed over.
    expect(code("../app/parks/claim/page.tsx")).toContain("selfUrl={selfUrl}");
  });

  it("this is the fix the sibling screen already had", () => {
    // FollowInvite solved the identical case; ClaimMyLot never imported it.
    expect(code("../components/FollowInvite.tsx")).toContain("SwitchAccount");
  });
});

// ---------------------------------------------------------------------------

describe("the resident with no lot is not sent to the phone", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  /**
   * The empty state said "ring them and they can join the two up" — while
   * /parks/claim existed and is built for exactly this person: the office
   * hands out a paper slip with a code and she joins her own file to her own
   * account. Telling her to phone while the self-serve door sits one link away
   * is the dead-end shape inverted: the screen HAD the better action and never
   * offered it.
   */
  const page = read("../app/parks/my/page.tsx");

  it("offers the claim door", () => {
    expect(page).toContain('href="/parks/claim"');
  });

  it("and that route exists", () => {
    const files = readdirSync(fileURLToPath(new URL("../app/parks/claim", import.meta.url)));
    expect(files).toContain("page.tsx");
  });

  it("still tells somebody with no slip what to do", () => {
    // Ringing the office is the right answer for her — it just is not the
    // only answer, and it was being given to everybody.
    expect(page).toMatch(/No slip — ring them/);
  });

  it("does not send everybody to the phone as the first move", () => {
    expect(page).not.toMatch(/ring them and they can join the two up/);
  });
});
