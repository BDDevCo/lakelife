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

  it("never sends both a service and a from-number", () => {
    // The Twilio API rejects a request carrying both, so this is a ternary and
    // not two spread-in fields.
    expect(code).toMatch(/serviceSid\s*\n?\s*\?\s*\{ messagingServiceSid: serviceSid, to, body \}\s*\n?\s*:\s*\{ from: from as string, to, body \}/);
  });

  it("still sends from the number while the service is unset", () => {
    // Until registration clears, today's behaviour must be untouched.
    expect(code).toMatch(/\{ from: from as string, to, body \}/);
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
