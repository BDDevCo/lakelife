import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { planChannels, smsHoldSays, inviteSmsBody, GSM7, isGsm7, type RenterChannels } from "./invite-channels";

const base: RenterChannels = {
  email: "donna@example.com",
  mobileE164: null,
  mobileVerifiedAt: null,
  smsConsentAt: null,
  phoneOnFile: null,
};

describe("which doors are open", () => {
  it("emails when there is an address", () => {
    expect(planChannels(base).email).toBe("donna@example.com");
    expect(planChannels({ ...base, email: "   " }).email).toBeNull();
  });

  it("NEVER texts the number that came off the old records", () => {
    // The whole reason `phone_on_file_with_park` is a separate column. A number
    // somebody else wrote down is not that person agreeing to be messaged, and
    // texting carries per-message damages that email does not.
    const p = planChannels({ ...base, phoneOnFile: "(260) 555-0142" });
    expect(p.sms).toBeNull();
    expect(p.smsHold).toBe("park_file_only");
  });

  it("won't text a number the resident gave but hasn't confirmed", () => {
    const p = planChannels({ ...base, mobileE164: "+12605550142" });
    expect(p.sms).toBeNull();
    expect(p.smsHold).toBe("unverified");
  });

  it("won't text a confirmed number without operational consent", () => {
    const p = planChannels({
      ...base, mobileE164: "+12605550142", mobileVerifiedAt: "2026-08-01T00:00:00Z",
    });
    expect(p.sms).toBeNull();
    expect(p.smsHold).toBe("no_consent");
  });

  it("texts only when they gave it, confirmed it, and agreed", () => {
    const p = planChannels({
      ...base,
      mobileE164: "+12605550142",
      mobileVerifiedAt: "2026-08-01T00:00:00Z",
      smsConsentAt: "2026-08-01T00:00:00Z",
    });
    expect(p.sms).toBe("+12605550142");
    expect(p.smsHold).toBeNull();
  });

  it("tells 'no number' apart from 'a number we may not use'", () => {
    // Different things for the office to do: collect one, versus ask them to
    // confirm the one we already have.
    expect(planChannels(base).smsHold).toBe("no_number");
    expect(planChannels({ ...base, phoneOnFile: "2605550142" }).smsHold).toBe("park_file_only");
  });

  it("says every hold in words, with no reason codes on screen", () => {
    for (const h of ["no_number", "park_file_only", "unverified", "no_consent"] as const) {
      const said = smsHoldSays(h);
      expect(said.length).toBeGreaterThan(10);
      expect(said).not.toMatch(/_/);
    }
  });

  it("emails and texts TOGETHER, never one instead of the other", () => {
    const p = planChannels({
      ...base,
      mobileE164: "+12605550142",
      mobileVerifiedAt: "x", smsConsentAt: "x",
    });
    expect(p.email).toBeTruthy();
    expect(p.sms).toBeTruthy();
  });
});

describe("the text itself", () => {
  const body = inviteSmsBody({
    parkName: "Cedar Bend", lotNumber: "14",
    url: "https://lakelife.ai/parks/welcome?t=" + "a".repeat(64),
  });

  it("leads with the park's name, which is the only familiar word on a lock screen", () => {
    expect(body.startsWith("Cedar Bend:")).toBe(true);
  });

  it("says STOP, because this is the first message after an opt-in", () => {
    // The A2P campaign filing describes a flow where replying STOP works — and
    // it does, via Twilio's Advanced Opt-Out. But a campaign whose SAMPLES do
    // not say so is reviewed against a claim its own evidence contradicts, and
    // that is a documented rejection reason. CTIA guidance puts the instruction
    // on the message following opt-in, which is this one.
    expect(body).toMatch(/Reply STOP to stop\./);
  });

  it("stays in GSM-7, which is the difference between 2 segments and 4", () => {
    // ONE character outside GSM-7 forces the WHOLE message into UCS-2, and a
    // UCS-2 segment holds 70 characters instead of 160. This body is 218
    // characters: in GSM-7 that is two segments, in UCS-2 it is four — double
    // the bill and double the A2P segment count, on every household, forever.
    // It used to contain an em-dash.
    const outside = [...body].filter((c) => !GSM7.has(c));
    expect(outside, `these characters force UCS-2: ${JSON.stringify(outside)}`).toEqual([]);
    expect(isGsm7(body)).toBe(true);
  });

  it("the GSM-7 check actually bites — an em-dash is not in the alphabet", () => {
    // Absence-only assertions pass against a broken checker. Prove the set
    // rejects the exact character that caused this, and accepts a plain hyphen.
    expect(isGsm7("your rent - here")).toBe(true);
    expect(isGsm7("your rent \u2014 here")).toBe(false);
    expect(isGsm7("nice wave \uD83C\uDF0A")).toBe(false);
  });

  it("carries a link and NO code", () => {
    // Same rule as the email. The slip promises we will never text asking for
    // a code; that dies the moment a code travels by message.
    expect(body).toContain("https://lakelife.ai/parks/welcome?t=");
    expect(body).not.toMatch(/[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}/);
  });

  it("says nothing changes, offers a way out, and warns what we never ask", () => {
    expect(body).toMatch(/Nothing about how you pay changes/);
    // THE WAY OUT USED TO BE "Ignore this if you'd rather not", AND THAT IS A
    // COURTESY, NOT AN OPT-OUT. A person who ignores a message has not opted
    // out of anything and will get the next one. "Reply STOP to stop" is the
    // instruction carriers, CTIA and the A2P campaign filing all expect, and
    // it is the one that actually does something — Twilio's Advanced Opt-Out
    // intercepts STOP before the message reaches us.
    // Pinned in the STOP test above; asserted here too so this test keeps
    // meaning what its NAME says it means.
    expect(body).toMatch(/Reply STOP to stop\./);
    expect(body).not.toMatch(/Ignore this/);
    expect(body).toMatch(/never text asking for a code or card details/);
  });
});

describe("the send path sends both", () => {
  const source = () => {
    const raw = readFileSync(
      new URL("../app/parks/invite-actions.ts", import.meta.url), "utf8");
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("finds what it is scanning", () => {
    expect(source()).toMatch(/export async function inviteHousehold/);
  });

  it("awaits the text and never lets a failed text kill the invite", () => {
    // The email is the channel we rely on; the text is redundancy. A dropped
    // text must not report the whole invite as failed, or the office reprints
    // slips for people who were successfully emailed.
    const s = source();
    expect(s).toMatch(/const t = await sendSms\(/);
    expect(s).not.toMatch(/void\s+sendSms/);
    // QUEUED, NOT OK. `sendSms` returns `queued` now — Twilio accepting a
    // message is not the carrier delivering it, and 81 sent / 0 delivered is
    // what the old name hid.
    expect(s).toMatch(/textQueued = t\.queued/);
    expect(s).not.toMatch(/\bt\.ok\b/);
  });

  it("decides the channels from planChannels, not from an inline check", () => {
    // One place holds the rule. An inline `if (mobile)` somewhere in the action
    // is how the park-file number ends up texted by accident.
    const s = source();
    expect(s).toMatch(/planChannels\(/);
    // The transport is handed `channels.sms` and nothing else — no other
    // variable reaches sendSms.
    const calls = s.match(/sendSms\(\s*([A-Za-z0-9_.]+)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain("channels.sms");
  });

  it("passes the park-file number to planChannels but NEVER to sendSms", () => {
    const s = source();
    // It is read (so the hold can say which case it is)...
    expect(s).toMatch(/phoneOnFile: \(file\.phone_on_file_with_park/);
    // ...and the only thing handed to the transport is the planned target.
    expect(s).toMatch(/sendSms\(\s*channels\.sms/);
  });
});
