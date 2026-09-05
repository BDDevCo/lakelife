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

describe("a certificate in a different legal name can actually be straightened out", () => {
  /**
   * THE ONE REMEDY THIS PRODUCT NAMES THREE TIMES AND HAS NEVER OFFERED.
   *
   * 0152 made the insurance rule real: a certificate must be unexpired AND
   * named to the business that sent it. A mismatch is deliberately not a
   * refusal — the document is filed, both names are recorded, and it becomes
   * something a person looks at. That design is right, and it rests entirely
   * on somebody being able to fix the name afterwards:
   *
   *   named-insured.ts — "a genuine DBA is a thirty-second conversation and
   *                       an edit to `vendors.company`"
   *   the crew's message — "send us a message and we'll get it straightened out"
   *   the ops board — "check which is wrong before approving"
   *
   * `vendors.company` was written in exactly two places, both INSERTs, both
   * invite paths. It appears in no UPDATE anywhere in src. So all three
   * sentences pointed at an edit nobody could make, and the mismatch blocked
   * activation, auto-dispatch and the claim board at once.
   *
   * It is likeliest on the path Brendon is about to use most: he types the
   * name he knows a crew by — "Bob's Mowing" — and Bob's policy is issued to
   * "Robert Klein Landscaping LLC". A homeowner inviting their own guy is
   * likelier still.
   *
   * OPS-ONLY, AND THAT IS THE POINT. Letting the crew edit their own business
   * name would make the gate self-certifying: type whatever the certificate
   * says and every certificate matches. named-insured.ts refuses fuzzy
   * matching for exactly that reason, and a self-serve name field would hand
   * back the failure it was avoiding.
   */
  const actions = code("../app/ops/crews-actions.ts");
  const board = code("../components/ops/CrewBoard.tsx");

  it("the mismatch message still promises somebody will sort it out", () => {
    // If this sentence ever goes, the tests below are guarding a promise
    // nobody makes any more.
    expect(code("./named-insured.ts")).toMatch(/straightened out/);
  });

  it("ops has a writer for the business name", () => {
    expect(
      actions,
      "vendors.company is still write-once at invite. The DBA conversation " +
        "the mismatch message promises has no edit behind it.",
    ).toMatch(/update\(\{\s*company/);
  });

  it("and it is ops-only, never the crew's own field", () => {
    expect(actions).toMatch(/export async function setCrewCompany/);
    expect(
      actions.slice(actions.indexOf("setCrewCompany")),
      "an ops action that doesn't assert ops",
    ).toMatch(/assertOps\(\)/);
    // The crew's own self-serve actions must never gain one.
    expect(
      code("../app/vendor/onboarding-actions.ts"),
      "a crew can rename their own business, which makes the insurance gate " +
        "self-certifying — any certificate matches once you can retype the account",
    ).not.toMatch(/update\(\{\s*company/);
  });

  it("the board offers the control on the card that reports the mismatch", () => {
    expect(board).toMatch(/setCrewCompany\(/);
    expect(
      board,
      "the board names the mismatch but the fix is somewhere else",
    ).toMatch(/namedInsuredMismatch/);
  });
});
