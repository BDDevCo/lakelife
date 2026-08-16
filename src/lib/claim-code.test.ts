import { describe, it, expect } from "vitest";
import { mintClaimCode, normalizeClaimCode, looksLikeClaimCode, CLAIM_CODE_RE } from "@/lib/claim-code";

/**
 * This code is spoken across a kitchen table and typed by somebody who may be
 * 78. The tests are about that, not about regex trivia.
 */
describe("minting", () => {
  const codes = Array.from({ length: 400 }, () => mintClaimCode());

  it("always mints the shape it promises", () => {
    for (const c of codes) expect(c, c).toMatch(CLAIM_CODE_RE);
  });

  it("NEVER mints a character that can be misread as another", () => {
    // The whole point of the alphabet. If any of these ever appears, somebody
    // reading a code down the phone will get it wrong and blame themselves.
    for (const c of codes) {
      expect(c, `${c} contains a look-alike`).not.toMatch(/[OIL01U]/);
    }
  });

  it("does not repeat itself", () => {
    // Not a randomness proof — a smoke alarm. 400 draws from 32^8 colliding
    // means the generator is broken, not unlucky.
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("mints from crypto, not Math.random", async () => {
    // A guessable code is worth somebody's tenancy. Source-checked because the
    // failure is invisible at runtime — see token-format for the same lesson.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./claim-code.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/Math\.random/);
    expect(src).toMatch(/randomInt/);
  });
});

describe("what a person actually types", () => {
  const CODE = "K7QM-3XR9";

  const accepted: Array<[string, string]> = [
    ["exactly as printed", "K7QM-3XR9"],
    ["all lower case", "k7qm-3xr9"],
    ["no dash", "K7QM3XR9"],
    ["a space instead of the dash", "K7QM 3XR9"],
    ["leading and trailing space", "  K7QM-3XR9  "],
    ["an en-dash their phone autocorrected", "K7QM–3XR9"],
    ["an em-dash", "K7QM—3XR9"],
    ["an underscore", "K7QM_3XR9"],
    ["mixed case and a stray full stop", "k7Qm.3xR9"],
    ["spaces between every character", "K 7 Q M 3 X R 9"],
  ];
  it.each(accepted)("accepts %s", (_label, typed) => {
    expect(normalizeClaimCode(typed)).toBe(CODE);
  });

  const refused: Array<[string, unknown]> = [
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 12345678],
    ["too short", "K7QM-3XR"],
    ["too long", "K7QM-3XR99"],
    ["a letter the alphabet excludes (O)", "K7QO-3XR9"],
    ["a digit the alphabet excludes (0)", "K7Q0-3XR9"],
    ["the letter I", "K7QI-3XR9"],
    ["the letter L", "K7QL-3XR9"],
    ["the digit 1", "K7Q1-3XR9"],
    ["the letter U", "K7QU-3XR9"],
    ["punctuation that is not a separator", "K7QM/3XR9"],
    ["a whole sentence", "my code is K7QM-3XR9"],
  ];
  it.each(refused)("refuses %s", (_label, typed) => {
    expect(normalizeClaimCode(typed as string)).toBeNull();
    expect(looksLikeClaimCode(typed as string)).toBe(false);
  });

  it("REFUSES A MISREAD RATHER THAN GUESSING AT IT", () => {
    // The tempting kindness is to map O to 0 and I to 1 on input. It is
    // incoherent here — neither 0 nor 1 is in the alphabet, so the mapping
    // sends valid-looking input somewhere that can never be right — and it is
    // dangerous in principle: the thing on the other side of this code is a
    // household's tenancy, so a guess is not a small kindness.
    expect(normalizeClaimCode("K7Q0-3XR9")).toBeNull();
    expect(normalizeClaimCode("K7QO-3XR9")).toBeNull();
  });

  it("round-trips everything it mints", () => {
    for (let i = 0; i < 200; i++) {
      const c = mintClaimCode();
      expect(normalizeClaimCode(c)).toBe(c);
      expect(normalizeClaimCode(c.toLowerCase().replace("-", " "))).toBe(c);
    }
  });
});
