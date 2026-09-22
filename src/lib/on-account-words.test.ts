import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMES_OFF, STILL_COMES_OFF, OFFICE_HAS_IT, STILL_OFFICE_HAS_IT } from "./on-account-words";

/**
 * TWO RESIDENT-FACING DOORS, ONE VOCABULARY. The confirm page at
 * /paid/[token] and the printed receipt both tell a household what happens
 * to money still on account. The receipt said "comes off your next bill" to
 * everybody, including a household with no next bill, because the words —
 * and the three-way choice — lived inside the route and nothing else could
 * reach them.
 */
describe("the resident's words for money on account", () => {
  it("say nothing about HOW money comes back — LakeLife handles no cash, and the office does", () => {
    for (const s of [COMES_OFF, STILL_COMES_OFF, OFFICE_HAS_IT, STILL_OFFICE_HAS_IT]) {
      expect(s).not.toMatch(/refund|cash|cheque|check|bank|card/i);
      // Nor an office control a resident's screen does not have.
      expect(s).not.toMatch(/Money not against a bill|Rent screen/);
    }
  });

  it("are the same four sentences the /paid page shows, whether it imports them yet or not", () => {
    const route = readFileSync(fileURLToPath(new URL("../app/paid/[token]/route.ts", import.meta.url)), "utf8");
    // Non-vacuous: the file was read and is the confirm page.
    expect(route).toContain("ConfirmView");
    const imports = /from "@\/lib\/on-account-words"/.test(route);
    if (!imports) {
      for (const s of [COMES_OFF, STILL_COMES_OFF, OFFICE_HAS_IT, STILL_OFFICE_HAS_IT]) {
        expect(route, "the /paid page and the receipt must not drift").toContain(s);
      }
    }
  });

  it("the receipt reads them from here rather than keeping a fifth copy", () => {
    const receipt = readFileSync(fileURLToPath(new URL("../app/park/receipt-helpers.ts", import.meta.url)), "utf8");
    expect(receipt).toMatch(/import \{[^}]*OFFICE_HAS_IT[^}]*\} from "@\/lib\/on-account-words"/);
  });
});
