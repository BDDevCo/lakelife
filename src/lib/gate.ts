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

/**
 * ============ THE ENVELOPE CARRIES ITS OWN VERSION ============
 *
 * Every blob written before this change was bare: [iv][tag][ciphertext] and
 * nothing else. One key seals gate codes and bank routing/account numbers
 * alike, so the day that key has to be rotated — a leak, a departing
 * contractor, ordinary hygiene — there is nothing IN a stored value to say
 * which key sealed it. The only recovery is "try both and see which one
 * opens", run against a column of people's bank account numbers.
 *
 * New envelopes therefore open with "LL" and a version byte. Nothing stored is
 * touched and nothing is re-encrypted: the opener below reads both shapes, and
 * that is the whole point — a rotation becomes possible later without a
 * migration over every row that already exists.
 *
 * A version means "which key and which scheme". v1 is GATE_ENCRYPTION_KEY with
 * AES-256-GCM. A rotation adds v2 pointing at the new key and leaves v1 able
 * to open what v1 sealed.
 */
const MAGIC_L = 0x4c; // "L"
const V1 = 0x01;
const HEADER = 3; // "L","L",version

/** Encrypt a gate code into a Postgres bytea hex literal ("\\x…"). */
export function encryptGate(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: ["L"]["L"][version][12-byte iv][16-byte tag][ciphertext]
  const payload = Buffer.concat([Buffer.from([MAGIC_L, MAGIC_L, V1]), iv, tag, enc]);
  return "\\x" + payload.toString("hex");
}

/** Open one [iv][tag][ciphertext] body. Throws on a bad tag, as it always has. */
function openBody(buf: Buffer): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

/** Decrypt a value read back from the bytea column ("\\x…") to the gate code. */
export function decryptGate(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const hex = stored.startsWith("\\x") ? stored.slice(2) : stored;
  const buf = Buffer.from(hex, "hex");

  // A legacy blob starts with 12 random IV bytes, so in principle one of them
  // could begin "LL\x01" by accident. That is why the versioned read FALLS
  // THROUGH rather than throwing: GCM's tag makes a wrong guess fail loudly,
  // and the legacy read below is then tried on the same bytes. A genuinely
  // corrupt value still throws, from the second attempt.
  if (buf.length > HEADER && buf[0] === MAGIC_L && buf[1] === MAGIC_L && buf[2] === V1) {
    try {
      return openBody(buf.subarray(HEADER));
    } catch {
      /* not a v1 envelope after all — read it as the old shape */
    }
  }
  return openBody(buf);
}

/**
 * Generic aliases for other secrets encrypted at rest with the SAME
 * key + envelope (bank routing/account numbers for payout_accounts).
 * The blobs never leave the server; clients only ever see last4.
 *
 * ONE KEY STILL SEALS BOTH. A door code on a lake house and a crew's bank
 * account number are not the same kind of secret and should not share a key —
 * rotating one to contain a leak forces the other through the same rotation.
 * The version byte above is what makes splitting them possible later; doing it
 * is a separate change, and it is not this one.
 */
export const sealSecret = encryptGate;
export const openSecret = decryptGate;
