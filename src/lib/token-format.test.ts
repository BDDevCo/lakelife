import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isBearerToken, BEARER_TOKEN } from "@/lib/token-format";

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
    expect(code("lib/amenity-guest-server.ts")).toMatch(/BEARER_TOKEN/);
    expect(code("lib/disputes.ts")).toMatch(/isBearerToken/);
    // Neither may re-declare its own copy — that is how the two drift.
    expect(code("lib/amenity-guest-server.ts")).not.toMatch(/=\s*\/\^\[0-9a-f\]/);
    expect(code("lib/disputes.ts")).not.toMatch(/=\s*\/\^\[0-9a-f\]/);
  });

  it("dispute tokens are minted from crypto, never Math.random", () => {
    // The old fallback built a BEARER CREDENTIAL out of a seeded PRNG. It was
    // unreachable, which is exactly why it survived review.
    const src = code("lib/disputes.ts");
    expect(src, "a bearer credential must not come from a seeded PRNG").not.toMatch(/Math\.random/);
    expect(src).toMatch(/randomUUID/);
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
