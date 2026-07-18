import { describe, it, expect, beforeAll } from "vitest";
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
