import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  encryptGate,
  decryptGate,
  sealSecret,
  openSecret,
  bankKeyConfigured,
  BankKeyMissingError,
} from "./gate";

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
 * The shape of every blob written before the version byte existed: no header
 * at all, just [12-byte iv][16-byte tag][ciphertext]. Written out by hand
 * because the code that produced it is gone — this is the historical artifact
 * the ONE gate code in production is stored in (verified 30 Sep 2026:
 * properties holds a single 32-byte blob whose first three bytes are c3 1c 53,
 * not "LL"), and it is not a copy of today's writer.
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

/**
 * TWO KINDS OF SECRET, TWO KEYS.
 *
 * A lake-house door code and a crew's bank account number were sealed with the
 * same 32 bytes, so rotating the door-code key — a leak, a departing
 * contractor, ordinary hygiene — was also a rotation of every routing number.
 * That rotation is not loud: planExport catches the throw, counts the batch as
 * "no bank on file or undecryptable", and the ACH file simply goes out without
 * it.
 *
 * Production holds ZERO bank rows and ONE legacy gate code (verified 30 Sep
 * 2026), which is why the split happens now and why it costs nothing: there is
 * nothing to re-encrypt. These tests exist to keep it that way.
 */
describe("a door code and a bank number no longer share a key", () => {
  const GATE = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const BANK = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

  beforeEach(() => {
    process.env.GATE_ENCRYPTION_KEY = GATE;
    process.env.BANK_ENCRYPTION_KEY = BANK;
  });
  afterEach(() => {
    delete process.env.BANK_ENCRYPTION_KEY;
  });

  const head = (blob: string) => [...Buffer.from(blob.slice(2), "hex").subarray(0, 3)];

  it("stamps a bank secret v2 and a gate code v1", () => {
    expect(head(sealSecret("021000021"))).toEqual([0x4c, 0x4c, 0x02]);
    expect(head(encryptGate("2214"))).toEqual([0x4c, 0x4c, 0x01]);
  });

  /**
   * BOTH WAYS. "It failed to open" proves nothing alone — it would also pass
   * if sealSecret were broken and produced garbage. So the SAME blob is opened
   * with the right key, refused with the wrong one, and opened again.
   */
  it("will not open a bank number with the door-code key", () => {
    const sealed = sealSecret("021000021");
    expect(openSecret(sealed)).toBe("021000021");

    process.env.BANK_ENCRYPTION_KEY = GATE; // the door-code key, in the bank slot
    expect(() => openSecret(sealed), "the door-code key opened a bank account number").toThrow();

    process.env.BANK_ENCRYPTION_KEY = BANK;
    expect(openSecret(sealed)).toBe("021000021");
  });

  it("fails CLOSED with no bank key — it never falls back to the door-code key", () => {
    const sealed = sealSecret("021000021");
    delete process.env.BANK_ENCRYPTION_KEY;

    expect(bankKeyConfigured()).toBe(false);
    expect(() => sealSecret("021000021")).toThrow(BankKeyMissingError);
    // And it says WHY, by name — not "auth tag mismatch", which would send
    // whoever reads the log hunting for corruption in a bank column.
    expect(() => openSecret(sealed)).toThrow(BankKeyMissingError);

    process.env.BANK_ENCRYPTION_KEY = BANK;
    expect(bankKeyConfigured()).toBe(true);
    expect(openSecret(sealed)).toBe("021000021");
  });

  it("leaves every gate code readable with no bank key at all", () => {
    const code = encryptGate("2214");
    delete process.env.BANK_ENCRYPTION_KEY;
    expect(decryptGate(code), "splitting the bank key broke door codes").toBe("2214");
  });

  it("still opens everything the ONE key sealed — nothing stored is re-encrypted", () => {
    // The two shapes that exist from before the split: the legacy gate code
    // production actually holds, and anything sealed v1 under the shared key.
    // Both are gate-key blobs; neither may need the bank key to open.
    const legacy = legacySeal("9021");
    const v1 = encryptGate("021000021");
    delete process.env.BANK_ENCRYPTION_KEY;
    expect(openSecret(legacy), "a blob sealed before the split stopped opening").toBe("9021");
    expect(openSecret(v1)).toBe("021000021");
  });
});
