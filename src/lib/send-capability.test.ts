import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sendCapability, liftedNoticesSignal } from "./send-capability";

/**
 * "Lifted. Notices can now reach your households."
 *
 * That was the answer to lifting the notice hold, and it was false in both
 * channels at once — an unset EMAIL_FROM sends from Resend's sandbox, which
 * only reaches our own inbox, and texts without a Messaging Service are
 * unregistered traffic that carriers drop. It is the last sentence the owner
 * reads before believing twenty households have been told about their rent.
 */

const KEYS = [
  "RESEND_API_KEY", "EMAIL_FROM",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID",
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const set = (env: Partial<Record<string, string>>) => {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
};

describe("what the deployment can actually reach", () => {
  it("today's real state: neither channel reaches a household", () => {
    // RESEND_API_KEY and the Twilio creds are set; EMAIL_FROM and the
    // Messaging Service SID are not. That is production as of Sep 2026, and
    // it is exactly 0 of 81 texts and every email landing in our own inbox.
    set({ RESEND_API_KEY: "re_x", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok" });
    const cap = sendCapability();
    expect(cap.email).toBe(false);
    expect(cap.sms).toBe(false);
    expect(cap.none).toBe(true);
    expect(cap.reasons.join(" ")).toMatch(/only ever arrives in our own inbox/);
    expect(cap.reasons.join(" ")).toMatch(/aren't registered with the carriers/);
  });

  it("EMAIL_FROM is the whole email switch", () => {
    set({ RESEND_API_KEY: "re_x", EMAIL_FROM: "LakeLife <hello@lakelife.ai>" });
    expect(sendCapability().email).toBe(true);
  });

  it("no Resend key is a different sentence from no sender", () => {
    // "Email isn't connected" and "email goes to our own inbox" are different
    // problems with different fixes; one message for both would send him to
    // the wrong screen.
    set({});
    expect(sendCapability().reasons.join(" ")).toMatch(/isn't connected at all/);
    set({ RESEND_API_KEY: "re_x" });
    expect(sendCapability().reasons.join(" ")).toMatch(/our own inbox/);
  });

  it("a bare Twilio number is NOT a channel — carriers route on the service", () => {
    // sms.ts: "sending from the bare number keeps the traffic unregistered no
    // matter how green the console looks."
    set({ TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok", TWILIO_PHONE_NUMBER: "+12605550000" });
    expect(sendCapability().sms).toBe(false);
    set({ TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok", TWILIO_MESSAGING_SERVICE_SID: "MG" });
    expect(sendCapability().sms).toBe(true);
  });
});

describe("the sentence he reads when he lifts the hold", () => {
  it("does not promise delivery when nothing can go out", () => {
    set({ RESEND_API_KEY: "re_x", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok" });
    const s = liftedNoticesSignal();
    expect(s).toMatch(/nothing can actually go out yet/);
    expect(s, "the old sentence must not survive in this state")
      .not.toMatch(/can now reach your households/);
  });

  it("names email as the channel when it is the only one", () => {
    set({ RESEND_API_KEY: "re_x", EMAIL_FROM: "x@lakelife.ai", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok" });
    const s = liftedNoticesSignal();
    expect(s).toMatch(/by email/);
    expect(s, "and still says texts do not work").toMatch(/aren't registered/);
  });

  it("only makes the unqualified promise when both channels work", () => {
    set({
      RESEND_API_KEY: "re_x", EMAIL_FROM: "x@lakelife.ai",
      TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok", TWILIO_MESSAGING_SERVICE_SID: "MG",
    });
    expect(liftedNoticesSignal()).toBe("Lifted. Notices can now reach your households.");
  });

  it("claims nothing stronger than 'configured' — presence is weaker evidence than absence", () => {
    // A Messaging Service SID does not prove a campaign was approved, and an
    // EMAIL_FROM does not prove the domain is verified. Checked on the SENTENCES
    // rather than the source: the file's own header uses both words to say what
    // it does NOT claim, and a scan over the prose flagged that (it failed here
    // first, on the documentation, not the behaviour).
    const states = [
      { RESEND_API_KEY: "re_x" },
      { RESEND_API_KEY: "re_x", EMAIL_FROM: "x@lakelife.ai" },
      { TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok", TWILIO_MESSAGING_SERVICE_SID: "MG" },
      {
        RESEND_API_KEY: "re_x", EMAIL_FROM: "x@lakelife.ai",
        TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok", TWILIO_MESSAGING_SERVICE_SID: "MG",
      },
    ];
    for (const st of states) {
      set(st);
      const words = [liftedNoticesSignal(), ...sendCapability().reasons].join(" ");
      expect(words, `overclaims for ${JSON.stringify(st)}`)
        .not.toMatch(/verified|approved|guaranteed|confirmed delivery/i);
    }
  });
});

describe("the action uses it", () => {
  it("setNoticeHold's lift branch calls the helper rather than a literal", () => {
    const src = readFileSync(join(process.cwd(), "src/app/park/actions.ts"), "utf8");
    const fn = src.match(/export async function setNoticeHold[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "setNoticeHold not found — this scan is measuring nothing").not.toBe("");
    expect(fn, "the lift signal must consult the channels").toMatch(/liftedNoticesSignal\(\)/);
    expect(fn, "the old unconditional promise must be gone")
      .not.toMatch(/"Lifted\. Notices can now reach your households\."/);
  });

  it("still says the honest thing when HOLDING — that half was already true", () => {
    const src = readFileSync(join(process.cwd(), "src/app/park/actions.ts"), "utf8");
    expect(src).toMatch(/Held\. Nothing will reach your households until you lift it\./);
  });
});
