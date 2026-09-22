import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  hasTwilioAccount,
  hasTwilioVerifyEnv,
  hasTwilioMessagingEnv,
  missingTwilioVars,
} from "./env";

/**
 * THE PREDICATE THAT COULD NOT TELL TWO TRANSPORTS APART.
 *
 * One `hasTwilioEnv()` answered on the VERIFY service SID and was read
 * everywhere as "texting works". Verify codes arrived the whole time; every
 * notification was rejected at the carrier for two months. These tests pin the
 * two answers apart, and in particular pin the exact state the outage ran in:
 * an account, a phone number, and no Messaging Service.
 */

const VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VERIFY_SERVICE_SID",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_PHONE_NUMBER",
] as const;

const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

function clear() {
  for (const v of VARS) delete process.env[v];
}

beforeEach(clear);

afterAll(() => {
  clear();
  for (const [k, v] of Object.entries(SAVED)) if (v !== undefined) process.env[k] = v;
});

describe("the account itself", () => {
  it("needs both halves — pinned both ways", () => {
    expect(hasTwilioAccount()).toBe(false);
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    expect(hasTwilioAccount()).toBe(false);
    process.env.TWILIO_AUTH_TOKEN = "tok_test";
    expect(hasTwilioAccount()).toBe(true);
    delete process.env.TWILIO_ACCOUNT_SID;
    expect(hasTwilioAccount()).toBe(false);
  });
});

describe("the Verify channel — the codes", () => {
  it("is true only with the account AND the Verify service", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok_test";
    expect(hasTwilioVerifyEnv()).toBe(false);
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA_test";
    expect(hasTwilioVerifyEnv()).toBe(true);
  });

  it("is NOT turned on by the Messaging service", () => {
    // The mirror of the outage: notifications configured, codes not.
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok_test";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    expect(hasTwilioMessagingEnv()).toBe(true);
    expect(hasTwilioVerifyEnv()).toBe(false);
  });
});

describe("the Messaging channel — the notifications", () => {
  it("is true only with the account AND the Messaging service", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok_test";
    expect(hasTwilioMessagingEnv()).toBe(false);
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    expect(hasTwilioMessagingEnv()).toBe(true);
  });

  it("IS FALSE ON A BARE PHONE NUMBER — the state the whole outage ran in", () => {
    // 81 messages, 0 delivered, 66 rejected 30034. The console looked
    // configured because a number was set. Carriers route on the Messaging
    // Service; a number alone is unregistered traffic.
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok_test";
    process.env.TWILIO_PHONE_NUMBER = "+12605550142";
    expect(hasTwilioMessagingEnv()).toBe(false);
    // And the other way: the service alone, with no number, IS enough.
    delete process.env.TWILIO_PHONE_NUMBER;
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    expect(hasTwilioMessagingEnv()).toBe(true);
  });

  it("is NOT turned on by the Verify service — the two-month confusion, pinned", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok_test";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA_test";
    expect(hasTwilioVerifyEnv()).toBe(true);
    expect(hasTwilioMessagingEnv()).toBe(false);
  });
});

describe("what is missing, by name", () => {
  it("names the variables that are not set, and names them per channel", () => {
    expect(missingTwilioVars("verify")).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_VERIFY_SERVICE_SID",
    ]);
    expect(missingTwilioVars("messaging")).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_MESSAGING_SERVICE_SID",
    ]);
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok_test";
    expect(missingTwilioVars("verify")).toEqual(["TWILIO_VERIFY_SERVICE_SID"]);
    expect(missingTwilioVars("messaging")).toEqual(["TWILIO_MESSAGING_SERVICE_SID"]);
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    expect(missingTwilioVars("messaging")).toEqual([]);
  });

  it("returns NAMES, never values — nothing it returns is a credential", () => {
    // The list goes straight onto an ops screen. A value leaking into it
    // would put a live auth token in a screenshot.
    process.env.TWILIO_ACCOUNT_SID = "AC_secret_value";
    for (const name of [...missingTwilioVars("verify"), ...missingTwilioVars("messaging")]) {
      expect(name).toMatch(/^TWILIO_[A-Z_]+$/);
      expect(name).not.toContain("secret");
    }
  });
});

/* -- and the split actually reached the call sites ------------------------- */

const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Comments quote the old name on purpose; only real calls count. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SOURCES = walk(abs("../")).filter((p) => !p.endsWith("/lib/env.ts"));

describe("nobody asks the ambiguous question any more", () => {
  it("scans a real spread of source, with tests and env.ts excluded", () => {
    expect(SOURCES.length).toBeGreaterThan(80);
    expect(SOURCES.some((p) => p.endsWith("/app/ops/sms-health.ts"))).toBe(true);
    expect(SOURCES.some((p) => /\.test\.tsx?$/.test(p))).toBe(false);
  });

  it("would catch an offender — the scanner is not vacuously passing", () => {
    const rogue = "const ok = hasTwilioEnv();";
    expect(/\bhasTwilioEnv\s*\(/.test(stripComments(rogue))).toBe(true);
    // And the comment strip really strips, or every quoted mention would count.
    expect(/\bhasTwilioEnv\s*\(/.test(stripComments("// see hasTwilioEnv()"))).toBe(false);
    expect(/\bhasTwilioEnv\s*\(/.test(stripComments("/* hasTwilioEnv() */"))).toBe(false);
  });

  it("leaves NO callers — the alias itself is gone", () => {
    // src/app/page.tsx was the last one; it now asks hasTwilioVerifyEnv()
    // directly, and the alias was deleted in the same pass. An empty list is
    // the point: the ambiguous question cannot be asked any more.
    const callers = SOURCES.filter((p) => /\bhasTwilioEnv\s*\(/.test(stripComments(readFileSync(p, "utf8"))))
      .map((p) => p.replace(/.*\/src\//, "src/"));
    expect(callers).toEqual([]);
    // And the export is gone from lib/env.ts too — excluded from SOURCES above,
    // so it needs its own read or the deletion is unpinned.
    const envSrc = stripComments(readFileSync(abs("../lib/env.ts"), "utf8"));
    expect(envSrc).not.toMatch(/export function hasTwilioEnv\b/);
    expect(envSrc).toMatch(/export function hasTwilioVerifyEnv\b/);
  });

  it("page.tsx asks the VERIFY question by name", () => {
    // The banner it feeds says "enable text verification". If somebody swaps
    // it to the messaging predicate the banner starts lying, so pin the pair.
    const page = stripComments(readFileSync(abs("../app/page.tsx"), "utf8"));
    expect(page).toMatch(/hasTwilioVerifyEnv\(\)/);
    expect(page).not.toMatch(/hasTwilioMessagingEnv\s*\(/);
  });

  it("gave the delivery panel the account predicate, not the Verify one", () => {
    // The panel reads the MESSAGING log. Gating it on the Verify service SID
    // is the conflation that hid the outage.
    const s = stripComments(readFileSync(abs("../app/ops/sms-health.ts"), "utf8"));
    expect(s).toMatch(/hasTwilioAccount\(\)/);
    expect(s).not.toMatch(/hasTwilioVerifyEnv\s*\(/);
  });

  it("gave both verify routes and the resident opt-in the Verify predicate", () => {
    for (const rel of [
      "../app/api/verify/start/route.ts",
      "../app/api/verify/check/route.ts",
      "../app/parks/consent-actions.ts",
    ]) {
      const s = stripComments(readFileSync(abs(rel), "utf8"));
      expect(s, rel).toMatch(/hasTwilioVerifyEnv\s*\(/);
      expect(s, rel).not.toMatch(/hasTwilioMessagingEnv\s*\(/);
    }
  });
});
