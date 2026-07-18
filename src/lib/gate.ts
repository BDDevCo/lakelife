import crypto from "node:crypto";

/**
 * Gate/door-code encryption (CLAUDE.md rule 3 — encrypted at rest).
 *
 * App-level AES-256-GCM, which the launch plan explicitly permits. The key
 * lives only in GATE_ENCRYPTION_KEY (env, never in the repo). The encrypted
 * value is stored in properties.gate_code_encrypted (a bytea column), so we
 * hand back a Postgres hex literal ("\\x…") ready to store, and read it back
 * the same way. Day-of-job visibility gating for vendors arrives in Phase 4.
 *
 * SERVER ONLY — never import into a client component.
 */

function key(): Buffer {
  const hex = process.env.GATE_ENCRYPTION_KEY ?? "";
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("GATE_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  }
  return buf;
}

/** Encrypt a gate code into a Postgres bytea hex literal ("\\x…"). */
export function encryptGate(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: [12-byte iv][16-byte tag][ciphertext]
  const payload = Buffer.concat([iv, tag, enc]);
  return "\\x" + payload.toString("hex");
}

/** Decrypt a value read back from the bytea column ("\\x…") to the gate code. */
export function decryptGate(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const hex = stored.startsWith("\\x") ? stored.slice(2) : stored;
  const buf = Buffer.from(hex, "hex");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
