import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isBearerToken, BEARER_TOKEN, isExtendToken, EXTEND_TOKEN, DEFAULT_MIN, STICKER_MIN,
} from "@/lib/token-format";

/**
 * A TOKEN IS A CREDENTIAL, SO THE THINGS IT MUST REFUSE ARE THE POINT.
 *
 * loadDisputeByToken passed its raw path segment straight into `.eq()` — the
 * only token loader in the app that did not check first. These are the inputs
 * a URL can actually deliver.
 */
describe("bearer token shape", () => {
  it("accepts what the app actually mints", () => {
    // Dispute tokens are randomUUID() with the dashes removed: 32 hex.
    for (let i = 0; i < 50; i++) {
      expect(isBearerToken(randomUUID().replace(/-/g, ""))).toBe(true);
    }
  });

  it("survives a trip through a mail client that changed the case", () => {
    const t = randomUUID().replace(/-/g, "");
    expect(isBearerToken(t.toUpperCase())).toBe(true);
  });

  const refuse: Array<[string, unknown]> = [
    ["the empty segment — matched any row whose token column was ''", ""],
    ["whitespace", "   "],
    ["null", null],
    ["undefined", undefined],
    ["too short to be unguessable", "abc123"],
    ["31 hex — one short", "a".repeat(31)],
    ["97 hex — one long", "a".repeat(97)],
    ["non-hex letters", "z".repeat(32)],
    ["a PostgREST wildcard", "*"],
    ["a PostgREST or-filter, in case it ever reached a filter string", "id.eq.1,id.eq.2"],
    ["SQL-ish punctuation", "' or '1'='1"],
    ["a path traversal", "../../etc/passwd"],
    ["a URL", "https://example.com/"],
    ["a token with a trailing newline", `${"a".repeat(32)}\n`],
    ["a token with an inner space", `${"a".repeat(16)} ${"a".repeat(16)}`],
    ["a number", 12345],
    ["an object", {}],
  ];

  it.each(refuse)("refuses %s", (_label, value) => {
    expect(isBearerToken(value as string)).toBe(false);
  });

  it("is anchored at both ends, so a valid token with junk bolted on fails", () => {
    const t = randomUUID().replace(/-/g, "");
    expect(isBearerToken(`${t}/../admin`)).toBe(false);
    expect(isBearerToken(`prefix${t}`)).toBe(false);
  });
});

/**
 * The regex is only worth having if the loaders use it. This is a source check
 * because the failure mode is a call site that FORGOT — and you cannot write a
 * behavioural test for a check nobody wrote.
 */
describe("every bearer-token loader validates before it queries", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

  /**
   * Comments stripped, because a source-scanning test that reads prose fails on
   * the sentence explaining the fix. That is not hypothetical — the first
   * version of the Math.random check below went red against a comment saying
   * "never from Math.random". A guard that cannot tell code from commentary
   * will eventually block the documentation of its own rule.
   */
  const code = (p: string) =>
    read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("disputes.ts checks the token in loadDisputeByToken", () => {
    const src = read("lib/disputes.ts");
    const fn = src.match(/export async function loadDisputeByToken[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn, "loadDisputeByToken must reject a malformed token before .eq()").toMatch(/isBearerToken|BEARER_TOKEN/);
    // And the guard must come BEFORE the query, not after it.
    expect(fn.indexOf("isBearerToken")).toBeLessThan(fn.indexOf(".from("));
  });

  it("the guest link and the dispute link share ONE definition", () => {
    // amenity-guest-server went from `BEARER_TOKEN.test()` to `isBearerToken`
    // when the regex floor dropped to 20 for the sticker: matching the bare
    // regex would have silently taken its minimum from 32 down with it.
    expect(code("lib/amenity-guest-server.ts")).toMatch(/isBearerToken/);
    expect(code("lib/disputes.ts")).toMatch(/isBearerToken/);
    // Neither may re-declare its own copy — that is how the two drift.
    expect(code("lib/amenity-guest-server.ts")).not.toMatch(/=\s*\/\^\[0-9a-f\]/);
    expect(code("lib/disputes.ts")).not.toMatch(/=\s*\/\^\[0-9a-f\]/);
  });

  /**
   * THE THREE THAT CHECKED A LENGTH AND CALLED IT VALIDATION.
   *
   * confirm-server, extend-server and park-request-server each had a bare
   * `token.length < N` in front of `.eq()`. A length is not a shape: every
   * input the suite above enumerates — the or-filter, the traversal, the
   * trailing newline — is long enough to sail past a length floor.
   */
  const migrated: Array<[string, string, RegExp]> = [
    ["confirm-server.ts", "loadPaymentByToken", /isBearerToken/],
    ["extend-server.ts", "loadExtendByToken", /isExtendToken/],
    ["park-request-server.ts", "loadSticker", /isBearerToken/],
  ];

  it.each(migrated)("%s validates the token shape in %s", (file, fn, guard) => {
    const src = read(`lib/${file}`);
    const body = src.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? "";
    expect(body, `${fn} must reject a malformed token`).toMatch(guard);
    expect(body.search(guard), "the guard must run BEFORE the query")
      .toBeLessThan(body.indexOf(".from("));
  });

  it("no loader is left validating a credential by its length alone", () => {
    for (const [file] of migrated) {
      expect(code(`lib/${file}`), `${file} still has a bare length check`)
        .not.toMatch(/token\.length\s*<\s*\d+/);
    }
  });

  it("dispute tokens are minted from crypto, never Math.random", () => {
    // The old fallback built a BEARER CREDENTIAL out of a seeded PRNG. It was
    // unreachable, which is exactly why it survived review.
    const src = code("lib/disputes.ts");
    expect(src, "a bearer credential must not come from a seeded PRNG").not.toMatch(/Math\.random/);
    expect(src).toMatch(/randomUUID/);
  });
});

/**
 * FOUR SHAPES, BECAUSE THE APP MINTS FOUR — and the old single rule silently
 * refused two of them. These assert against the REAL mint expressions, copied
 * from their source files, so a change to either side shows up here.
 */
describe("every credential the app actually mints is accepted by its own rule", () => {
  const hex32 = () => randomUUID().replace(/-/g, "");

  it("dispute token: randomUUID with the dashes out (disputes.ts)", () => {
    expect(isBearerToken(hex32())).toBe(true);
  });

  it("payment confirm token: 32 hex + 8 hex (park/ledger-actions.ts)", () => {
    expect(isBearerToken(hex32() + randomUUID().slice(0, 8))).toBe(true);
  });

  it("QR sticker: randomUUID cut to 20 (park/request-actions.ts)", () => {
    const sticker = hex32().slice(0, 20);
    // The point of the whole exercise: 20 hex is a real credential that the
    // 32-floor rule refused, and it is accepted only when asked for by name.
    expect(isBearerToken(sticker)).toBe(false);
    expect(isBearerToken(sticker, STICKER_MIN)).toBe(true);
  });

  it("extend token: 'x' + 32 hex (automation.ts) — never hex-only", () => {
    const extend = `x${hex32()}`;
    expect(isExtendToken(extend)).toBe(true);
    // This is why extend-server does NOT use isBearerToken. If it did, every
    // extend link already sitting in somebody's texts would 404.
    expect(isBearerToken(extend)).toBe(false);
  });

  it("the extend rule refuses a bare hex token and a different prefix", () => {
    expect(isExtendToken(hex32())).toBe(false);
    expect(isExtendToken(`y${hex32()}`)).toBe(false);
    expect(isExtendToken(`x${hex32()}extra`)).toBe(false);
    expect(isExtendToken(null)).toBe(false);
  });
});

describe("widening the floor for the sticker did not weaken anybody else", () => {
  it("the default minimum is still 32, not the regex floor of 20", () => {
    expect(DEFAULT_MIN).toBe(32);
    expect(STICKER_MIN).toBe(20);
    // The regex admits 20 so the sticker can opt in...
    expect(BEARER_TOKEN.test("a".repeat(20))).toBe(true);
    // ...but a caller that names no length still gets 32.
    expect(isBearerToken("a".repeat(20))).toBe(false);
    expect(isBearerToken("a".repeat(31))).toBe(false);
    expect(isBearerToken("a".repeat(32))).toBe(true);
  });

  it("a caller cannot ask for a floor the shape does not allow", () => {
    // Below the regex floor the length argument cannot rescue it.
    expect(isBearerToken("a".repeat(19), 8)).toBe(false);
    expect(isBearerToken("abc", 1)).toBe(false);
  });

  it("the extend regex is anchored, case-insensitive and not stateful", () => {
    expect(EXTEND_TOKEN.flags).toContain("i");
    expect(EXTEND_TOKEN.flags).not.toContain("g");
    expect(EXTEND_TOKEN.source.startsWith("^")).toBe(true);
    expect(EXTEND_TOKEN.source.endsWith("$")).toBe(true);
    const t = `x${"a".repeat(32)}`;
    expect(EXTEND_TOKEN.test(t)).toBe(true);
    expect(EXTEND_TOKEN.test(t)).toBe(true);
  });
});

describe("the regex itself", () => {
  it("is case-insensitive and anchored", () => {
    expect(BEARER_TOKEN.flags).toContain("i");
    expect(BEARER_TOKEN.source.startsWith("^")).toBe(true);
    expect(BEARER_TOKEN.source.endsWith("$")).toBe(true);
  });

  it("has no global flag, which would make .test() stateful across calls", () => {
    // A /g regex advances lastIndex between calls and returns false every
    // other time — the classic way a validator passes its own test suite and
    // then rejects every second real request.
    expect(BEARER_TOKEN.flags).not.toContain("g");
    const t = "a".repeat(32);
    expect(BEARER_TOKEN.test(t)).toBe(true);
    expect(BEARER_TOKEN.test(t)).toBe(true);
  });
});
