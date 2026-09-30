import crypto from "node:crypto";

/**
 * Secrets encrypted at rest: gate/door codes (CLAUDE.md rule 3) and the crew
 * bank numbers behind payouts.
 *
 * App-level AES-256-GCM, which the launch plan explicitly permits. TWO keys,
 * never one: GATE_ENCRYPTION_KEY seals door codes, BANK_ENCRYPTION_KEY seals
 * routing/account numbers, and both live only in the environment, never in the
 * repo. The encrypted value is stored in a bytea column
 * (properties.gate_code_encrypted, payout_accounts.routing_encrypted /
 * account_encrypted), so we hand back a Postgres hex literal ("\\x…") ready to
 * store, and read it back the same way. Day-of-job visibility gating for
 * vendors arrives in Phase 4.
 *
 * SERVER ONLY — never import into a client component.
 */

function gateKey(): Buffer {
  const hex = process.env.GATE_ENCRYPTION_KEY ?? "";
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("GATE_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  }
  return buf;
}

/** Thrown BY NAME, so a caller can refuse in words instead of 500-ing. */
export class BankKeyMissingError extends Error {
  constructor() {
    super("BANK_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
    this.name = "BankKeyMissingError";
  }
}

function bankKey(): Buffer {
  const hex = process.env.BANK_ENCRYPTION_KEY ?? "";
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new BankKeyMissingError();
  return buf;
}

/**
 * True once bank secrets can be sealed at all. Callers ask BEFORE taking
 * somebody's routing number, so the refusal is a sentence rather than a stack
 * trace, and so nothing half-writes.
 */
export function bankKeyConfigured(): boolean {
  try {
    bankKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * ============ TWO KEYS, AND THE ENVELOPE SAYS WHICH ============
 *
 * A door code on a lake house and a crew's bank account number are not the
 * same kind of secret, and one key used to seal both. Rotating
 * GATE_ENCRYPTION_KEY to contain a leaked door code would have dragged every
 * routing number through the same rotation — and a rotation that strands a
 * bank blob is not loud: planExport catches the throw, counts the batch as
 * "no bank on file or undecryptable", and the ACH file goes out without it.
 *
 * So bank secrets get their own key and their own version byte. NOTHING
 * STORED IS TOUCHED and nothing is re-encrypted — the opener below reads all
 * three shapes, which is the whole point of having put a version in the
 * envelope in the first place:
 *
 *   legacy  [12-byte iv][16-byte tag][ciphertext]     GATE_ENCRYPTION_KEY
 *   v1      ["L"]["L"][0x01][iv][tag][ciphertext]     GATE_ENCRYPTION_KEY
 *   v2      ["L"]["L"][0x02][iv][tag][ciphertext]     BANK_ENCRYPTION_KEY
 *
 * Production holds ONE legacy gate code and (verified 30 Sep 2026) ZERO bank
 * rows, which is exactly why the split happens now: every blob that has to
 * keep opening is a gate-key blob, and every one of them still does.
 *
 * A version means "which key and which scheme". A later rotation mints v3 and
 * leaves v1/v2 able to open what they sealed.
 *
 * WHEN BANK_ENCRYPTION_KEY IS UNSET, BANK SECRETS FAIL CLOSED. sealSecret
 * throws rather than quietly falling back to the door-code key: a fallback
 * would rebuild the very defect this removes, and would write a bank number
 * under the gate key while the version byte claimed otherwise — the worst of
 * both, because it would look split. Gate codes are unaffected either way;
 * they never touch the bank key.
 */
const MAGIC_L = 0x4c; // "L"
const V1_GATE = 0x01;
const V2_BANK = 0x02;
const HEADER = 3; // "L","L",version

function seal(plain: string, version: number, k: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: ["L"]["L"][version][12-byte iv][16-byte tag][ciphertext]
  const payload = Buffer.concat([Buffer.from([MAGIC_L, MAGIC_L, version]), iv, tag, enc]);
  return "\\x" + payload.toString("hex");
}

/** Encrypt a gate code into a Postgres bytea hex literal ("\\x…"). */
export function encryptGate(plain: string): string {
  return seal(plain, V1_GATE, gateKey());
}

/**
 * Seal a bank routing/account number. Throws BankKeyMissingError when
 * BANK_ENCRYPTION_KEY is unset — deliberately, so a bank number is never
 * written under the door-code key. Callers check bankKeyConfigured() first.
 */
export function sealSecret(plain: string): string {
  return seal(plain, V2_BANK, bankKey());
}

/** Open one [iv][tag][ciphertext] body. Throws on a bad tag, as it always has. */
function openBody(buf: Buffer, k: Buffer): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

/**
 * Open any stored value — legacy, v1 or v2 — by READING the version byte
 * rather than guessing. One reader, deliberately: a reader that tried keys
 * until one worked is precisely what the version byte exists to replace, and
 * which function you called is not evidence of which key sealed the bytes.
 */
export function openEnvelope(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const hex = stored.startsWith("\\x") ? stored.slice(2) : stored;
  const buf = Buffer.from(hex, "hex");

  // A legacy blob starts with 12 random IV bytes, so in principle one could
  // begin "LL\\x01" (or "LL\\x02") by accident. That is why the versioned read
  // FALLS THROUGH rather than throwing: GCM's tag makes a wrong guess fail
  // loudly, and the legacy read below is then tried on the same bytes. A
  // genuinely corrupt value still throws, from the second attempt.
  //
  // The ONE thing that does not fall through is a missing bank key. Retrying a
  // v2 blob on the gate key would fail anyway, and it would fail as "auth tag
  // mismatch" — a sentence that sends whoever reads the log hunting for
  // corruption in a bank column instead of for an unset environment variable.
  if (buf.length > HEADER && buf[0] === MAGIC_L && buf[1] === MAGIC_L) {
    const version = buf[2];
    if (version === V1_GATE || version === V2_BANK) {
      try {
        return openBody(buf.subarray(HEADER), version === V2_BANK ? bankKey() : gateKey());
      } catch (e) {
        if (e instanceof BankKeyMissingError) throw e;
        /* not a versioned envelope after all — read it as the old shape */
      }
    }
  }
  return openBody(buf, gateKey());
}

/** Decrypt a value read back from the bytea column ("\\x…") to the gate code. */
export const decryptGate = openEnvelope;

/**
 * The bank-side name. The WRITERS differ — sealSecret uses
 * BANK_ENCRYPTION_KEY, encryptGate uses GATE_ENCRYPTION_KEY — and the reader
 * is deliberately the same function, because the version byte in the blob is
 * what names the key, not the name of the function that opened it.
 *
 * The blobs never leave the server; clients only ever see last4.
 */
export const openSecret = openEnvelope;