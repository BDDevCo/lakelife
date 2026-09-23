import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * APPROVING A CREW'S CORRECTION MUST NOT REPRICE SOLD WORK FROM TONIGHT'S DIAL.
 *
 * Rule 6: a flag changes nothing and bills nothing until the homeowner
 * approves, and approval updates the profile and reprices ATOMICALLY. Under
 * 0174 that reprice has a second half nobody had to think about before: on a
 * crew-priced job the customer's price is DERIVED from the crew's quote
 * through two percentages, and those percentages are frozen onto the job at
 * booking precisely so that tuning a dial can never reprice work already sold.
 *
 * This door is the one that could undo that. It already loads
 * `getPlatformSettings()` for the rush premium and the margin floor — the
 * dials are three lines away and in scope — so reaching for
 * `settings.platformFeeCustomerPct` here would look completely natural and
 * would silently reprice every open job at the property the next time anybody
 * nudged a dial. The pin is therefore two-sided: the job's OWN columns must be
 * read, and the live dials must not appear in this file at all.
 *
 * Scanned rather than executed: `approveFlag` is a server action needing a
 * session, a pending flag, a property and an open job list — the same reason
 * `reprice.test.ts` beside it scans. What can break here is the SHAPE: which
 * columns the reprice reads, and which it writes.
 */
const src = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");
/** Comments stripped, so a sentence ABOUT the dial can never satisfy a scan FOR it. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * The crew-priced branch, bounded. Anchored on the first READ of the job's own
 * frozen percentage — the behaviour itself — rather than on a comment (which
 * is stripped here) or a local variable name (which a refactor renames without
 * changing anything that bills).
 */
const branch = (() => {
  const start = code.indexOf("j.fee_customer_pct");
  const end = code.indexOf("const menu = priceService", start);
  return start < 0 || end < 0 ? "" : code.slice(start, end);
})();

describe("the scanner is reading the reprice loop", () => {
  it("found approveFlag and its crew-priced branch", () => {
    expect(code, "approveFlag is gone or renamed").toMatch(/approveFlag/);
    expect(branch.length, "the crew-priced reprice branch was not found").toBeGreaterThan(200);
    // And the branch really is inside the per-job loop, above the menu path.
    expect(code.indexOf("for (const j of openJobs")).toBeLessThan(code.indexOf("crewSetsThePrice("));
  });
});

describe("a crew-priced reprice uses the job's own frozen percentages", () => {
  it("reads them off the job row", () => {
    expect(code, "fee_customer_pct is never selected — the reprice cannot know this job's terms")
      .toMatch(/select\("id, service_id, vendor_id, vendor_cost, customer_price, is_rush, gap_claim, crew_quote, fee_customer_pct, fee_crew_pct"\)/);
    expect(branch).toMatch(/j\.fee_customer_pct/);
    expect(branch).toMatch(/j\.fee_crew_pct/);
  });

  it("NEVER reaches for the live dial, anywhere in this file", () => {
    // The two-sided half of the pin. `getPlatformSettings()` is already
    // awaited in this function for the rush premium and the floor, so both
    // dials are in scope and one keystroke away. A job recomputes from its
    // own three or from nothing.
    expect(code, "the live platform-fee dial is read in the approval door — that reprices sold work")
      .not.toMatch(/platformFeeCustomerPct|platformFeeCrewPct/);
  });

  it("writes the crew's new quote and both derived ends, so the row still reconciles", () => {
    // guard_job_money_shape (0050) raises unless margin = customer_price −
    // vendor_cost to the cent. All three come from the shared helpers rather
    // than a second copy of the arithmetic, which is what makes that hold.
    expect(branch).toMatch(/customer_price:\s*feeCustomerPrice\(/);
    expect(branch).toMatch(/vendor_cost:\s*feeCrewPayout\(/);
    expect(branch).toMatch(/margin:\s*feePlatformTake\(/);
    expect(branch).toMatch(/crew_quote:\s*quote/);
    // Re-derived from the CREW's card at the corrected size — never from the
    // global row, which on a crew-priced service is a shape and not a price.
    expect(branch).toMatch(/rateByVendorService\.get/);
  });

  it("does not consult the margin floor, and that omission is deliberate", () => {
    // Not the same omission the menu branch below was fixed for. LakeLife's
    // share here is (c + k) / (1 + c) — the SAME fraction on every job — so a
    // floor test is not a filter, it is a platform-wide on/off switch that
    // would hold every crew-priced approval the day somebody nudged a dial.
    expect(branch).not.toMatch(/marginFloor/);
    // The menu branch still has it. Losing that is the bug this file's
    // sibling, the-floor-at-the-approval-door.test.ts, exists for — asserted
    // here too so a "simplification" cannot delete both in one pass.
    expect(code.slice(code.indexOf("const menu = priceService"))).toMatch(/marginPct\(price, cost\) < rushSettings\.marginFloor/);
  });

  it("holds, rather than guesses, the three jobs whose number cannot be re-derived", () => {
    // No card on file, a gap claim, or a same-day rush priced off a menu that
    // no longer exists. On this path the customer's price IS the crew's quote,
    // so moving one end without the other is the "owner pays for twelve, crew
    // paid for eight" bug with the sides swapped.
    expect(branch).toMatch(/if \(!vrCrew \|\| isGap \|\| isRushJob\)/);
    expect(branch).toMatch(/heldAgreements \+= 1/);
    // And a card that prices to nothing at the new size never makes the visit free.
    expect(branch).toMatch(/if \(!\(quote > 0\)\) continue;/);
  });

  it("asks the one precedence rule, and no longer fences parks out by hand", () => {
    // ============ CORRECTED 23 SEPTEMBER 2026 (0176) ============
    //
    // This test used to read `expect(branch).toMatch(/!parkRates/)` under the
    // comment "a park's grounds never reaches this branch". That pinned the
    // rule the owner RETRACTED — "park work is never crew-priced" — and it was
    // my sentence, not his:
    //
    //   "well josh would be a contractor uploaded onto lake life that the park
    //    then would be able to see his services offeren on LakeLife, just like
    //    any crew for any home owner or renter in the park needing services."
    //
    // The park is a CUSTOMER. `parkRates` is a Map — usually an EMPTY one — for
    // every park, so `!parkRates` was "never, for any park", in a fourth
    // spelling that `park-precedence.test.ts`'s scan could not see.
    //
    // What governs now is PRECEDENCE, and the only correct test of it is the
    // shared helper: The Haven's mow has its own row, so `crewSetsThePrice` is
    // FALSE and the mow still reprices down the menu branch through
    // `withParkRate` — while a park with no row on a crew-priced service (snow,
    // the cleanups, the dock) reaches this branch and gets re-quoted, which is
    // what the owner's screen already promises it will.
    expect(branch, "the reprice door re-derives 'is this a park' beside crew_priced again")
      .not.toMatch(/!parkRates/);
    expect(branch, "the crew-priced reprice must ask the shared precedence rule")
      .toMatch(/crewSetsThePrice\(/);
    // And it must ask with the JOB's service id: a rule with no id matches no
    // park rate row, which would hand The Haven's $125 mow to a crew's card.
    expect(branch).toMatch(/id: j\.service_id/);
  });
});
