import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { quietClaimState } from "./claims-quiet";

/**
 * "NOBODY HAS STARTED ONBOARDING A PARK YET."
 *
 * On the ops console, with The Haven loaded: a real park, twenty-one lots, a
 * cutover date in the database. The card was reading one fact — no invites and
 * no slips in thirty days — and reporting a different one.
 *
 * They come apart for a year at a time. The Haven's households do not sign
 * until 1 January 2027, so no invite CAN have gone out, and the console called
 * that an empty platform.
 *
 * And a failed tally read fell back to `empty: true`, which rendered as that
 * same sentence — so the most reassuring words on the screen were also exactly
 * what a broken query looked like. claims-data.ts had this written down as a
 * known lie; these are the tests that close it.
 */

const HAVEN = { name: "The Haven", occupied: 19 };

describe("the quiet state reports what it found, not what it assumed", () => {
  it("A PARK IS LOADED: it says that, and never that nobody has started", () => {
    const v = quietClaimState({ checked: true, parks: [HAVEN] });
    expect(v.kind).toBe("nobody_invited");
    const said = "said" in v ? v.said : "";
    // The park by name, because at one park the name is the useful half.
    expect(said).toContain("The Haven");
    expect(said).toContain("19 households");
    // The exact sentence this test exists to kill.
    expect(said).not.toMatch(/nobody has started onboarding a park/i);
    expect(said).not.toMatch(/no park is set up/i);
  });

  it("and it says the silence is expected, so it does not read as an alarm", () => {
    // The Haven's cutover is 1 Jan 2027. Nobody invited is the CORRECT state
    // for a year, and a console that cries about it teaches him to ignore it.
    const v = quietClaimState({ checked: true, parks: [HAVEN] });
    expect("said" in v ? v.said : "").toMatch(/expected before a park's cutover/i);
  });

  it("NO PARK AT ALL is the one case the old sentence was true for", () => {
    const v = quietClaimState({ checked: true, parks: [] });
    expect(v.kind).toBe("no_parks");
    expect("said" in v ? v.said : "").toMatch(/no park is set up on the platform yet/i);
  });

  it("A PARK WITH AN EMPTY ROLL says there is nobody to invite", () => {
    // A different fact again, and a different next action: load the roll.
    const v = quietClaimState({ checked: true, parks: [{ name: "Pine Ridge", occupied: 0 }] });
    expect(v.kind).toBe("nobody_to_invite");
    const said = "said" in v ? v.said : "";
    expect(said).toContain("Pine Ridge");
    expect(said).toMatch(/nobody on the roll/i);
    expect(said).toMatch(/load the roll/i);
  });

  it("THE READ THAT DID NOT HAPPEN is its own state, never a zero", () => {
    // This is the half claims-data.ts called a known lie: a failed query fell
    // back to `empty: true` and rendered as the reassuring sentence.
    const v = quietClaimState({ checked: false, parks: [HAVEN] });
    expect(v.kind).toBe("unchecked");
    // And it carries no sentence at all, so no caller can accidentally print
    // a finding for a read that never ran.
    expect("said" in v).toBe(false);
  });

  it("unchecked wins even with no parks, which could also look like an answer", () => {
    expect(quietClaimState({ checked: false, parks: [] }).kind).toBe("unchecked");
  });
});

describe("naming at small N, counting past it", () => {
  const roll = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `Park ${i + 1}`, occupied: 5 }));

  it("names one", () => {
    expect("said" in quietClaimState({ checked: true, parks: roll(1) })
      ? (quietClaimState({ checked: true, parks: roll(1) }) as { said: string }).said : "")
      .toMatch(/^Park 1 is set up/);
  });

  it("names two and three", () => {
    const two = quietClaimState({ checked: true, parks: roll(2) }) as { said: string };
    expect(two.said).toMatch(/^Park 1 and Park 2 are set up/);
    const three = quietClaimState({ checked: true, parks: roll(3) }) as { said: string };
    expect(three.said).toMatch(/^Park 1, Park 2 and Park 3 are set up/);
  });

  it("counts four", () => {
    const four = quietClaimState({ checked: true, parks: roll(4) }) as { said: string };
    expect(four.said).toMatch(/^4 parks are set up/);
    expect(four.said).not.toContain("Park 1");
  });

  it("counts only the parks that have somebody to invite", () => {
    // A park with an empty roll is not a park anybody failed to invite, so
    // naming it here would send him to look at the wrong one.
    const v = quietClaimState({
      checked: true,
      parks: [HAVEN, { name: "Pine Ridge", occupied: 0 }],
    }) as { said: string };
    expect(v.said).toContain("The Haven");
    expect(v.said).not.toContain("Pine Ridge");
    expect(v.said).toContain("19 households");
  });

  it("says household, singular, for one", () => {
    const v = quietClaimState({
      checked: true, parks: [{ name: "Pine Ridge", occupied: 1 }],
    }) as { said: string };
    expect(v.said).toContain("1 household on the roll");
    expect(v.said).not.toContain("1 households");
  });
});

/**
 * The wiring. Each of these is a line a refactor could drop while every
 * sentence above still passed.
 */
describe("the console is wired to the new states", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (f: string) =>
    strip(readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8"));

  const card = read("../../components/OpsStuckClaims.tsx");
  const page = read("./page.tsx");
  const data = read("./claims-data.ts");

  it("the sentence is gone from the component", () => {
    expect(card.length).toBeGreaterThan(1000);
    expect(card, "the card still says nobody has started onboarding a park")
      .not.toMatch(/started onboarding a park/i);
  });

  it("the card is told about the parks, or it cannot know", () => {
    expect(card).toMatch(/parks: readonly QuietPark\[\]/);
    expect(card).toMatch(/quietClaimState\(/);
    expect(page, "/ops never passes the parks to the card").toMatch(/parks=\{parks\}/);
  });

  it("the card checks whether the read happened BEFORE reporting a finding", () => {
    const unchecked = card.indexOf("!tally.checked");
    const emptyBranch = card.indexOf("tally.empty && stuck.length === 0");
    expect(unchecked, "the card never tests whether the tally was read").toBeGreaterThan(-1);
    expect(emptyBranch).toBeGreaterThan(-1);
    expect(unchecked, "a finding is reported before asking whether we looked")
      .toBeLessThan(emptyBranch);
    expect(card).toMatch(/couldn&apos;t check/i);
  });

  it("BOTH fallbacks say the read did not happen", () => {
    // There are two: the loader's own, and /ops's when the promise rejects.
    // One of them left as `checked: true` would put the old lie back for the
    // failure mode it covers.
    expect(data).toMatch(/empty: true, checked: false/);
    expect(page).toMatch(/empty: true, checked: false/);
    // And the successful read says so.
    expect(data).toMatch(/checked: true/);
  });
});
