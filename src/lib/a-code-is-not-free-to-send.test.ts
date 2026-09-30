import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  VERIFY_LIMITS,
  verifyLimitVerdict,
  verifyGateRefusal,
  type VerifyTally,
} from "./verify-rate";
import { optInSays } from "./sms-consent";

/** A tally at every ceiling and over none of them. */
const atLimit = (): VerifyTally => ({
  numberHour: VERIFY_LIMITS.numberHour,
  numberDay: VERIFY_LIMITS.numberDay,
  userDay: VERIFY_LIMITS.userDay,
  ipHour: VERIFY_LIMITS.ipHour,
});

describe("how many codes one party may ask for", () => {
  it("lets a tally that sits exactly on every ceiling through", () => {
    // The tally already counts the attempt being decided, so "3 an hour" must
    // mean the third is sent and the fourth is not. Off by one here is a
    // resident who corrects a typo twice and is locked out.
    expect(verifyLimitVerdict(atLimit())).toBeNull();
  });

  // EACH CEILING, COLLAPSED BOTH WAYS. A test that only asserts "an enormous
  // tally is refused" passes with three of the four clauses deleted. These
  // move ONE key past its limit, require a refusal naming that key, and then
  // put the same key back on its limit and require the refusal to go away —
  // so deleting any single clause fails exactly one pair.
  const cases: Array<[keyof VerifyTally, string]> = [
    ["numberHour", "number_hour"],
    ["numberDay", "number_day"],
    ["userDay", "user_day"],
    ["ipHour", "ip_hour"],
  ];

  for (const [key, code] of cases) {
    it(`refuses on ${code}, and only on ${code}`, () => {
      const over = atLimit();
      over[key] = over[key] + 1;
      expect(verifyLimitVerdict(over)).toBe(code);

      const back = atLimit();
      back[key] = back[key];
      expect(verifyLimitVerdict(back)).toBeNull();
    });

    it(`${code} is the ONLY thing that can refuse that tally`, () => {
      // Everything else at zero: proves the verdict came from this clause and
      // not from a neighbour that happens to be at its ceiling too.
      const lone: VerifyTally = { numberHour: 0, numberDay: 0, userDay: 0, ipHour: 0 };
      lone[key] = VERIFY_LIMITS[key] + 1;
      expect(verifyLimitVerdict(lone)).toBe(code);
      lone[key] = VERIFY_LIMITS[key];
      expect(verifyLimitVerdict(lone)).toBeNull();
    });
  }

  it("an empty tally is never refused", () => {
    expect(verifyLimitVerdict({ numberHour: 0, numberDay: 0, userDay: 0, ipHour: 0 })).toBeNull();
  });
});

describe("what she is told", () => {
  it("names a wait, which is an action the screen supports", () => {
    const said = verifyGateRefusal({ allowed: false, code: "number_hour", failed: false });
    expect(said).toMatch(/try again/i);
    expect(said).toMatch(/hour/i);
  });

  it("never names which ceiling was hit", () => {
    for (const code of ["number_hour", "number_day", "user_day", "ip_hour"] as const) {
      const said = verifyGateRefusal({ allowed: false, code, failed: false });
      expect(said).not.toMatch(/_/);
      expect(said).not.toMatch(/\d/);
    }
  });

  it("says nothing was sent when the limiter itself could not look", () => {
    // A failed read is not an empty one, and the person must not be left
    // thinking a code is on its way.
    const said = verifyGateRefusal({ allowed: false, code: null, failed: true });
    expect(said).toMatch(/no code was sent/i);
    expect(said).not.toMatch(/a lot of codes/i);
  });

  it("the opt-in door says the same two things", () => {
    expect(optInSays("too_many")).toMatch(/hour/i);
    expect(optInSays("check_failed")).toMatch(/no code was sent/i);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. A correct, tested limiter nobody calls is the third shape — a
// symbol with no caller. These read the real files, strip comments so a
// mention in prose cannot satisfy them, and assert ORDER against the actual
// Twilio call rather than merely presence.
// ---------------------------------------------------------------------------

const source = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("both Verify doors count before they send", () => {
  it("the sign-up route refuses reserved space before it reaches Twilio", () => {
    // This is the door the fix to consent-actions.ts named and did not close.
    const s = source("../app/api/verify/start/route.ts");
    expect(s).toMatch(/phoneRefusal\(e164\)/);
    expect(s.indexOf("phoneRefusal")).toBeLessThan(s.indexOf("verifications.create"));
  });

  it("the sign-up route asks the limiter before it reaches Twilio", () => {
    const s = source("../app/api/verify/start/route.ts");
    expect(s).toMatch(/mayStartVerification\(/);
    expect(s.indexOf("mayStartVerification")).toBeLessThan(s.indexOf("verifications.create"));
  });

  it("the sign-up route refuses when the gate says no", () => {
    // Calling the gate and ignoring it is code, comment and test all agreeing
    // about a rule none of them enforces.
    const s = source("../app/api/verify/start/route.ts");
    expect(s).toMatch(/if \(!gate\.allowed\)/);
    expect(s.indexOf("gate.allowed")).toBeLessThan(s.indexOf("verifications.create"));
  });

  it("the park opt-in action asks the limiter before it reaches Twilio", () => {
    const s = source("../app/parks/consent-actions.ts");
    expect(s).toMatch(/mayStartVerification\(/);
    expect(s.indexOf("mayStartVerification")).toBeLessThan(s.indexOf("verifications.create"));
    expect(s).toMatch(/if \(!gate\.allowed\)/);
  });
});

describe("the counter table does not grow for ever", () => {
  it("the nightly cron calls the sweeper", () => {
    const s = source("../app/api/cron/nightly/route.ts");
    expect(s).toMatch(/sweepVerifyAttempts\(\)/);
  });
});
