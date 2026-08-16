import { randomInt } from "node:crypto";

/**
 * THE CODE THAT GETS READ OUT LOUD IN SOMEBODY'S KITCHEN.
 *
 * Migration 0055 specified this and never built it: "How an unclaimed file
 * becomes a claimed one. Short, single-use, handed over deliberately by the
 * park owner — never guessable, never emailed to an address we have not
 * verified."
 *
 * Every decision below comes from how it is actually delivered. This is not a
 * URL token that gets clicked; it is spoken across a table, or written on the
 * back of a rent receipt, and then typed by somebody who may be 78 and using a
 * phone they got for Christmas. So:
 *
 * NO LOOK-ALIKE CHARACTERS. The alphabet excludes I, L, O, U and the digits 0
 * and 1. `O` versus `0` and `l` versus `1` are the classic pair that turns a
 * one-minute job into a phone call to the office — which is the exact call
 * this whole module exists to prevent. U is dropped as well, following
 * Crockford's base32, because it is the letter that turns a random string into
 * a word nobody wants to read aloud to a stranger.
 *
 * AND THEREFORE NO LOOK-ALIKE "CORRECTION" ON INPUT. The first draft of this
 * mapped O to 0 and I to 1 on the way in, to be forgiving. That is incoherent:
 * 0 and 1 are not in the alphabet either, so the mapping sent valid-looking
 * input to characters that can never be right. Excluding the ambiguous pair
 * from the MINT is what makes guessing unnecessary — seeing an O, a 0, an I or
 * a 1 means the code was misread, and there is no honest way to know of what.
 * So we say "that code isn't right" rather than silently claiming a household
 * on a guess. Input is normalised for case and separators only, which is the
 * part a person genuinely varies.
 *
 * EIGHT CHARACTERS, GROUPED 4-4. `K7QM-3XR9` reads as two chunks, which is how
 * people say numbers. 32^8 is about 1.1 trillion, so guessing is not a
 * strategy even before rate limiting — and the code is single-use and tied to
 * one file, so a guessed code is worth one household, not a park.
 */

/** Crockford-style: no I, L, O, U, and no 0 or 1 to collide with them. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP = 4;
const LENGTH = 8;

/** What a minted code looks like: 8 alphabet characters with one dash. */
export const CLAIM_CODE_RE = /^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/;

/**
 * Mint a code. Cryptographically random — `Math.random` would make this
 * guessable from a seed, and this string is the only thing standing between a
 * stranger and somebody's tenancy.
 */
export function mintClaimCode(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, GROUP)}-${out.slice(GROUP)}`;
}

/**
 * Turn whatever somebody typed into the code we would have minted, or null.
 *
 * Handles: lower case, missing dash, extra spaces, a pasted code with a stray
 * character, and the look-alikes above. Returns null when it cannot be read as
 * a code at all — the caller shows "that code isn't right", never a stack of
 * validation rules.
 */
export function normalizeClaimCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  // Case and separators only. A person varies those every time; they do not
  // vary which letter they saw. Long dashes are included because a phone
  // keyboard autocorrects a typed hyphen into one.
  const cleaned = raw.toUpperCase().replace(/[\s\-–—_.]/g, "");

  if (cleaned.length !== LENGTH) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;

  return `${cleaned.slice(0, GROUP)}-${cleaned.slice(GROUP)}`;
}

/** True when `raw` reads as a claim code we could have minted. */
export const looksLikeClaimCode = (raw: string | null | undefined) =>
  normalizeClaimCode(raw) !== null;
