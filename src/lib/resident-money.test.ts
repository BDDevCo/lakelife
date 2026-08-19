import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE TWO WAYS A RESIDENT'S OWN MONEY USED TO LEAVE HER SCREEN.
 *
 * Both were found by walking a full year as Doris — 78, lot 14, eleven years
 * on the pad, pays by cheque — and both are about the same mistake: the screen
 * showed the CURRENT state of the LOT and treated everything else as over.
 *
 *  1. ARREARS VANISHED. The bill read was `.limit(1)`. The morning February
 *     was raised, an unpaid January left the screen — no balance, no Pay
 *     button, no "I already paid this" — and if February was then settled the
 *     card read "Paid in full — thank you." to a household a month behind.
 *
 *  2. MOVE-OUT ERASED EVERYTHING. The tenancy read excluded `ended`, so the
 *     loader returned null and the page said "No lot on your account. We
 *     looked for a tenancy attached to this sign-in and didn't find one." —
 *     every clause false. Her deposit and her final prorated month went with
 *     it, and 0101 raises that final month AFTER the move-out on purpose, so
 *     it was a bill she could never see.
 *
 * Verified on screen 19 Aug 2026 against a three-month fixture: June unpaid,
 * July part-paid ($412.53 - $200 = $212.53), August current; then the same
 * tenancy ended with a $500 deposit outstanding.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const data = () => src("../app/parks/my-data.ts");
const home = () => src("../components/RenterHome.tsx");

describe("arrears", () => {
  it("the bill read is no longer limit(1)", () => {
    const s = data();
    const at = s.indexOf('.from("park_charges")');
    expect(at).toBeGreaterThan(-1);
    // Just this query — the window must not run into the next one, which has
    // its own limit and would make this assertion pass or fail by accident.
    const block = s.slice(at, s.indexOf(")", s.indexOf(".limit(", at)) + 1);
    expect(block, "one bill on screen is how January disappeared").toMatch(/\.limit\(24\)/);
    expect(block).not.toMatch(/\.limit\(1\)/);
  });

  it("every earlier month with a balance is returned, oldest first", () => {
    const s = data();
    expect(s).toMatch(/arrears: Bill\[\]/);
    expect(s).toMatch(/arrears: older\.map\(toBill\)/);
    // .reverse() is what makes it oldest-first; the query is newest-first.
    expect(s).toMatch(/\.reverse\(\)/);
    // Only months with something still owed.
    expect(s).toMatch(/paid_total \?\? 0\) > 0\.005/);
  });

  it("claims are read for EVERY bill, not just the newest", () => {
    // Otherwise an arrears month she has already claimed would still offer to
    // take payment, and would not show the "nothing is being chased" line.
    const s = data();
    expect(s).toMatch(/\.in\("charge_id", billIds\)/);
    expect(s).not.toMatch(/\.eq\("charge_id", charge\.id as string\)/);
  });

  it("each arrears row can be paid AND claimed", () => {
    const h = home();
    const at = h.indexOf("view.arrears.length > 0");
    expect(at).toBeGreaterThan(-1);
    const block = h.slice(at);
    expect(block).toMatch(/<PayRentButton/);
    expect(block).toMatch(/<IPaidForm/);
    // A claimed month must not also offer to collect.
    expect(block).toMatch(/a\.disputed \?/);
  });
});

describe("move-out", () => {
  it("an ended tenancy still loads the screen", () => {
    const s = data();
    expect(s).toMatch(/"approved", "active", "ended"/);
    // A live tenancy still wins when she has one.
    expect(s).toMatch(/liveStay/);
    expect(s).toMatch(/tenancyEnded/);
  });

  it("the money half survives and the LOT half does not", () => {
    const h = home();
    // The deposit, the bills and the receipts stay — that is the whole point.
    expect(h).toMatch(/Your tenancy has ended/);
    // Reporting a broken step on a pad somebody else now lives on must not.
    expect(h).toMatch(/\{!view\.tenancyEnded && \(/);
    expect(h).toMatch(/\{!view\.tenancyEnded && <EnableLotBooking/);
  });

  it("the header stops claiming she lives there", () => {
    const h = home();
    expect(h).toMatch(/lived here/);
  });
});
