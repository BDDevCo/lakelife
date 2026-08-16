import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { opsReasonText } from "@/lib/claim-reasons";

describe("what ops is told about a refusal", () => {
  it("says what happened, not what the resident was told to do", () => {
    // Two audiences, two sentences. She gets "sign out and use that address";
    // ops gets the fact, so whoever picks up the phone knows before dialling.
    expect(opsReasonText("invite_wrong_account"))
      .toBe("signed in with a different email from the invite");
    expect(opsReasonText("claim_locked")).toBe("locked out after five tries");
  });

  it("degrades to something legible for a code it has never seen", () => {
    // A new refusal reason must not render as blank. It will look ugly, which
    // is the correct amount of ugly for "somebody added a reason and forgot
    // this map".
    expect(opsReasonText("some_new_reason")).toContain("some_new_reason");
    expect(opsReasonText("some_new_reason")).toContain("refused");
  });

  it("covers every reason the two claim paths can actually return", () => {
    // Read from the migrations rather than a hand-kept list, so a reason added
    // in SQL and never mapped here fails HERE rather than on ops' screen.
    const root = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
    const sql = ["0129_the_four_doors_and_who_may_knock.sql",
                 "0132_one_invite_to_an_address_of_record.sql"]
      .map((f) => readFileSync(root + f, "utf8")).join("\n");

    // Every v_reason := 'x' in the claim functions.
    const reasons = [...sql.matchAll(/v_reason\s*:=\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(5);   // the scanner found something

    for (const r of new Set(reasons)) {
      expect(opsReasonText(r), `${r} has no ops wording`).not.toMatch(/^refused \(/);
    }
  });
});

describe("the surface keeps the park owner out", () => {
  const component = readFileSync(
    fileURLToPath(new URL("../../components/OpsStuckClaims.tsx", import.meta.url)), "utf8");
  const data = readFileSync(
    fileURLToPath(new URL("./claims-data.ts", import.meta.url)), "utf8");

  it("lives only under /ops", () => {
    // The one structural guarantee. A failed attempt must never become a
    // durable note about a resident on their landlord's screen (0128).
    expect(data).toMatch(/^import "server-only";/m);
    const roll = readFileSync(
      fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)), "utf8");
    expect(roll).not.toMatch(/StuckHousehold|getStuckHouseholds|claims-data/);
  });

  it("says what it checked when there is nothing to show", () => {
    // "Nothing here" reads identically whether everyone got in or the query
    // broke. Both quiet states name the window and the counts.
    expect(component).toMatch(/No slips printed and no invites sent/);
    expect(component).toMatch(/Nobody is stuck/);
    expect(component).toMatch(/last 30 days/);
  });

  it("counts rather than percentages", () => {
    // At nineteen households a percentage is thirteen people wearing false
    // precision.
    expect(component).not.toMatch(/%/);
    expect(component).not.toMatch(/Pct|percent/i);
  });

  it("does not swallow a failed read", () => {
    // An error that returns [] reads as "nobody is stuck", which is the most
    // reassuring possible way to be wrong.
    expect(data).toMatch(/console\.error\("\[ops\] claim log read failed"/);
    expect(data).toMatch(/console\.error\("\[ops\] claim tally read failed"/);
  });

  it("ignores households who got in or said no thanks", () => {
    // Otherwise one mistyped code in December keeps somebody on the call list
    // forever.
    expect(data).toMatch(/f\.user_id == null && f\.claim_declined_at == null/);
  });
});
