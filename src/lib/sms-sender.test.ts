import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE SENDER HAS TO BECOME A SERVICE, NOT A NUMBER.
 *
 * A registered A2P campaign is attached to a Messaging Service, and the
 * carriers route on that. Sending from the bare number leaves the traffic
 * unregistered however green the console looks — which is exactly the state
 * that has delivered 0 of 81 messages since 19 July.
 *
 * So the switchover is deliberately an environment variable rather than a code
 * change: on the day the brand is approved, setting
 * TWILIO_MESSAGING_SERVICE_SID moves every send with no deploy. These pin the
 * two halves of that — that the service wins when set, and that nothing
 * changes until it is.
 */
const src = readFileSync(fileURLToPath(new URL("./sms.ts", import.meta.url)), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the Twilio sender is switchable by environment alone", () => {
  it("reads a Messaging Service SID from the environment", () => {
    expect(code).toMatch(/process\.env\.TWILIO_MESSAGING_SERVICE_SID/);
  });

  it("sends through the service when it is set", () => {
    expect(code).toMatch(/messagingServiceSid: serviceSid/);
  });

  /**
   * THE WHOLE ARGUMENT OBJECT HANDED TO messages.create, as it is written —
   * not a rebuilt copy of it. The shape moved once already (a ternary between
   * two whole objects became ONE conditional spread beside `to`, `body` and
   * the status callback), and a test that pinned the old literal went red on a
   * change that was behaviourally identical. What actually matters is narrower
   * and does not care about the shape: whichever branch runs, EXACTLY ONE
   * sender field reaches Twilio.
   */
  const createArgs = (() => {
    const at = code.indexOf("client.messages.create({");
    expect(at, "the create call moved — this scanner is reading nothing").toBeGreaterThan(-1);
    const open = code.indexOf("{", at + "client.messages.create(".length);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) return code.slice(open, i + 1);
      }
    }
    throw new Error("unbalanced braces in the create call");
  })();

  it("reads the real create call, not a rebuilt one", () => {
    // Non-vacuity: the slice really is the argument object and really holds
    // the recipient and the body, so a match below means something.
    expect(createArgs).toMatch(/\bto,/);
    expect(createArgs).toMatch(/\bbody,/);
    expect(createArgs.length).toBeGreaterThan(40);
  });

  it("never sends both a service and a from-number", () => {
    // The Twilio API rejects a request carrying both. Whatever the syntax, the
    // two fields must be the two arms of ONE condition on serviceSid — so each
    // name appears exactly once in the argument object, and `from` only ever
    // on the far side of a `:` from `messagingServiceSid`.
    const services = createArgs.match(/messagingServiceSid/g) ?? [];
    const froms = createArgs.match(/\bfrom:/g) ?? [];
    expect(services).toHaveLength(1);
    expect(froms).toHaveLength(1);
    expect(createArgs).toMatch(
      /serviceSid\s*\?[\s\S]{0,60}messagingServiceSid: serviceSid[\s\S]{0,20}:[\s\S]{0,20}from: from as string/,
    );
  });

  it("still sends from the number while the service is unset", () => {
    // Until a Messaging Service SID is actually in the environment, today's
    // behaviour must be untouched: the else-arm is the bare number.
    expect(createArgs).toMatch(/from: from as string/);
  });

  it("would catch a request carrying both — the scanner is not vacuous", () => {
    // Collapse the branch BOTH ways and require both collapses to be caught,
    // or an absence-only assertion would pass on a file that sends neither.
    const both = "{ messagingServiceSid: serviceSid, from: from as string, to, body }";
    expect((both.match(/messagingServiceSid/g) ?? []).length === 1 && /serviceSid\s*\?/.test(both)).toBe(false);
    const neither = "{ to, body }";
    expect(/from: from as string/.test(neither)).toBe(false);
  });

  it("is configured if EITHER a number or a service is present", () => {
    expect(code).toMatch(/\(!from && !serviceSid\)/);
  });

  it("and the number alone is still enough, as it is today", () => {
    // Guard against someone later making the service mandatory and silencing
    // every send before registration finishes.
    expect(code).not.toMatch(/!serviceSid\)\s*return \{ queued: false, error: "SMS not configured" \}/);
  });
});
