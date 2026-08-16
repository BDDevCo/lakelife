import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { smsConsentText, SMS_OPT_IN_BLURB, optInSays } from "./sms-consent";
import { planChannels } from "./invite-channels";

describe("the sentence they agree to", () => {
  it("names the park, so it isn't consent to be texted by anybody", () => {
    const said = smsConsentText("Cedar Bend");
    expect(said).toContain("Cedar Bend");
    expect(said).not.toContain("{park}");
  });

  it("carries the three things a consent line has to carry", () => {
    const said = smsConsentText("Cedar Bend");
    expect(said).toMatch(/rates may apply/i);   // cost
    expect(said).toMatch(/STOP/);               // how to stop
    expect(said).toMatch(/any time/i);          // that stopping is always allowed
  });

  it("says what the texts are FOR, not just that texts will happen", () => {
    // "We'll text you" is vague enough that agreeing to it isn't agreeing to
    // anything. Rent, receipts, their own lot — and nothing else.
    expect(SMS_OPT_IN_BLURB).toMatch(/rent is due/);
    expect(SMS_OPT_IN_BLURB).toMatch(/receipt/);
    expect(SMS_OPT_IN_BLURB).toMatch(/won't use it for anything else/);
  });

  it("promises nothing about paying changes", () => {
    expect(SMS_OPT_IN_BLURB).toMatch(/Nothing about how you pay changes/);
  });
});

describe("the screen and the record use ONE string", () => {
  // The failure this prevents: a consent record that describes something the
  // resident was never shown, because the component and the action each held
  // their own wording.
  const read = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("finds both files it is scanning", () => {
    expect(read("../components/TextOptIn.tsx")).toMatch(/export function TextOptIn/);
    expect(read("../app/parks/consent-actions.ts")).toMatch(/export async function confirmTextOptIn/);
  });

  it("renders the constant rather than a copy of it", () => {
    const ui = read("../components/TextOptIn.tsx");
    expect(ui).toMatch(/smsConsentText\(parkName\)/);
    // No hand-typed consent prose in the component.
    expect(ui).not.toMatch(/rates may apply/i);
  });

  it("writes the same constant into the record", () => {
    const action = read("../app/parks/consent-actions.ts");
    expect(action).toMatch(/sms_consent_text: smsConsentText\(/);
    expect(action).not.toMatch(/rates may apply/i);
  });

  it("writes verification and consent together, never one without the other", () => {
    // A verified number with no consent is a number we still may not text; the
    // reverse is consent for a number nobody proved. Both, or neither.
    const action = read("../app/parks/consent-actions.ts");
    const update = action.slice(action.indexOf(".update({"), action.indexOf("sms_consent_text"));
    expect(update).toMatch(/mobile_verified_at/);
    expect(update).toMatch(/sms_consent_operational_at/);
  });

  it("takes no renter id — identity comes from the session", () => {
    // Nothing on the wire may point at somebody else's household. Same rule
    // that fixed claimCrewInvite.
    const action = read("../app/parks/consent-actions.ts");
    expect(action).toMatch(/export async function startTextOptIn\(phone: string\)/);
    expect(action).toMatch(/export async function confirmTextOptIn\(phone: string, code: string\)/);
    expect(action).toMatch(/\.eq\("user_id", user\.id\)/);
  });

  it("scopes every write to the file it just looked up", () => {
    const action = read("../app/parks/consent-actions.ts");
    const updates = action.match(/\.update\(\{[\s\S]*?\}\)\s*\.eq\("id", file\.id\)/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(2);   // consent on, and off
  });
});

describe("turning it off", () => {
  it("clears consent but keeps the number she gave", () => {
    // Withdrawal must be as easy as giving it. Clearing the verification too
    // would mean redoing the code dance for a change of mind.
    const action = readFileSync(
      new URL("../app/parks/consent-actions.ts", import.meta.url), "utf8");
    const stop = action.slice(action.indexOf("export async function stopTexts"));
    expect(stop).toMatch(/sms_consent_operational_at: null/);
    expect(stop).toMatch(/sms_consent_text: null/);
    expect(stop).not.toMatch(/mobile_e164: null/);
    expect(stop).not.toMatch(/mobile_verified_at: null/);
  });

  it("closes the send gate the moment consent goes", () => {
    // The whole point: the channel plan reads consent, so stopping is
    // immediate rather than a preference somebody has to honour.
    const after = planChannels({
      email: "d@example.com",
      mobileE164: "+12605550142",
      mobileVerifiedAt: "2026-08-01T00:00:00Z",
      smsConsentAt: null,            // she just turned it off
      phoneOnFile: null,
    });
    expect(after.sms).toBeNull();
    expect(after.smsHold).toBe("no_consent");
  });
});

describe("what she is told when it fails", () => {
  it("names a landline as a landline", () => {
    // The commonest real failure for the exact person this path exists for,
    // and one she should not be left guessing about.
    expect(optInSays("landline")).toMatch(/landline/);
    expect(optInSays("landline")).toMatch(/mobile/);
  });

  it("never shows a reason code, and always says what to do", () => {
    for (const c of ["not_signed_in", "no_file", "bad_phone", "not_configured",
                     "send_failed", "code_wrong", "code_expired", "landline",
                     "something_unmapped"]) {
      const said = optInSays(c);
      expect(said).not.toMatch(/_/);
      expect(said.length).toBeGreaterThan(15);
    }
  });

  it("blames the software, not her, when texts aren't switched on", () => {
    expect(optInSays("not_configured")).toMatch(/Nothing's wrong at your end/);
  });
});

describe("nothing in reserved space ever gets a code", () => {
  // sendSms has always refused these first thing. The Twilio VERIFY path did
  // not — so a 555 number went straight at the carrier. 555-01xx is fiction,
  // but the rest of that exchange is live and 555-1212 is directory
  // assistance. A verification code is still a text to a stranger.
  const action = () =>
    readFileSync(new URL("../app/parks/consent-actions.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("refuses before it reaches Twilio", () => {
    const s = action();
    expect(s).toMatch(/phoneRefusal\(e164\)/);
    expect(s.indexOf("phoneRefusal")).toBeLessThan(s.indexOf("verifications.create"));
  });
});
