import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import { encryptGate, decryptGate } from "./gate";

// A fixed 32-byte key (64 hex chars) just for the test run.
beforeAll(() => {
  process.env.GATE_ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
});

describe("gate code encryption (CLAUDE.md rule 3)", () => {
  it("round-trips a code back to the original", () => {
    const cipher = encryptGate("2214");
    expect(decryptGate(cipher)).toBe("2214");
  });

  it("stores as a Postgres bytea literal and never leaks the plaintext", () => {
    const cipher = encryptGate("2214");
    expect(cipher.startsWith("\\x")).toBe(true);
    expect(cipher).not.toContain("2214");
  });

  it("uses a fresh IV each time, so ciphertext differs on repeat", () => {
    expect(encryptGate("2214")).not.toBe(encryptGate("2214"));
  });

  it("returns null for an empty stored value", () => {
    expect(decryptGate(null)).toBeNull();
    expect(decryptGate("")).toBeNull();
  });

  it("refuses tampered ciphertext (auth tag mismatch)", () => {
    const cipher = encryptGate("2214");
    const tampered = cipher.slice(0, -2) + (cipher.slice(-2) === "00" ? "11" : "00");
    expect(() => decryptGate(tampered)).toThrow();
  });
});

/**
 * ONE KEY, AND UNTIL NOW NOTHING IN THE BLOB SAYING WHICH ONE.
 *
 * GATE_ENCRYPTION_KEY seals gate codes AND bank routing/account numbers, and
 * the stored envelope carried no version at all. Rotating that key would have
 * stranded every stored secret with nothing to say whether a given blob was
 * sealed with the old key or the new one — the only recovery being "try both
 * and see which one opens", against a column of bank account numbers.
 *
 * So new envelopes carry a version. NOTHING STORED IS TOUCHED, and the opener
 * reads both shapes; that is what makes a rotation possible later without
 * rewriting a single row.
 */
describe("the envelope says which key sealed it", () => {
  /**
   * The shape of every blob written before this change: no header at all,
   * just [12-byte iv][16-byte tag][ciphertext]. Written out by hand because
   * the code that produced it is gone — this is the historical artifact three
   * production secrets are stored in, not a copy of today's writer.
   */
  function legacySeal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(process.env.GATE_ENCRYPTION_KEY as string, "hex"),
      iv,
    );
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return "\\x" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("hex");
  }

  it("stamps a version on everything it seals from now on", () => {
    const buf = Buffer.from(encryptGate("2214").slice(2), "hex");
    // "LL", then the version byte. A rotation mints v2 and the opener picks
    // by this byte instead of guessing.
    expect([...buf.subarray(0, 3)]).toEqual([0x4c, 0x4c, 0x01]);
  });

  it("still opens a blob sealed before the version existed", () => {
    // THE WHOLE POINT. A gate code and two bank numbers are stored in the old
    // shape today and not one of them may become unreadable.
    expect(decryptGate(legacySeal("9021"))).toBe("9021");
    expect(decryptGate(legacySeal("021000021"))).toBe("021000021");
  });

  it("round-trips the new shape, and the two shapes agree", () => {
    const v1 = encryptGate("021000021");
    expect(decryptGate(v1)).toBe("021000021");
    expect(v1).not.toBe(encryptGate("021000021"));
    expect(decryptGate(legacySeal("021000021"))).toBe(decryptGate(v1));
  });

  it("still refuses a tampered versioned blob", () => {
    const cipher = encryptGate("021000021");
    const tampered = cipher.slice(0, -2) + (cipher.slice(-2) === "00" ? "11" : "00");
    expect(() => decryptGate(tampered)).toThrow();
  });
});
