import "server-only";

/**
 * THE HALF OF THE PROCESSOR THAT MUST NEVER REACH A BROWSER.
 *
 * `payments.ts` is the hosted-fields half: `tokenize()` runs in the customer's
 * browser on purpose (CLAUDE.md rule 4 — the card number never leaves the
 * field, and only a vault token comes back). `charge()` and `refund()` are the
 * opposite kind of thing entirely: they are the calls a real processor
 * authenticates with a SECRET key, and the day those keys are wired in they
 * would have been read by a module that `src/components/PaymentMethods.tsx`
 * — a `"use client"` file — imports. Next would have bundled them, and every
 * card on the platform would be chargeable by anyone who opened devtools.
 *
 * There was no key to leak yet, which is the only reason this was survivable.
 * It stops being survivable on the same morning the gate stops declining, so
 * the two halves are separated now, while the split costs nothing: this file
 * carries `import "server-only"`, which makes the build FAIL rather than
 * quietly shipping it. `src/lib/charge-gate.test.ts` scans for a client file
 * that imports it, so the seventh doorway cannot open by accident.
 *
 * The mock's behaviour is unchanged — same shapes, same guards, same replay —
 * so the real adapter is still a drop-in and the contract tests still hold it
 * down.
 */

export interface ChargeInput {
  token: string;
  amountCents: number;
  description?: string;
  /**
   * SENT TO THE PROCESSOR, not just used by us.
   *
   * Every processor worth using (Stripe, Helcim) dedupes on this: the same key
   * replays the FIRST result instead of taking a second payment. It is the
   * answer to "what stops a duplicate charge", and it belongs on the request
   * rather than only on our own row — our unique index can refuse a second
   * ledger row, but by then the card has already been debited twice.
   */
  idempotencyKey?: string;
}

export interface RefundInput {
  chargeRef: string;
  amountCents: number;
  /** Same contract as a charge's: one key, one refund, however many submits. */
  idempotencyKey?: string;
}

export interface ChargeResult {
  ok: boolean;
  error?: string;
  ref?: string;
  amountCents?: number;
}

/**
 * What the mock has already charged, by idempotency key.
 *
 * A real processor keeps this for 24 hours on its own side; in a serverless
 * runtime this map does not survive a cold start, and that is fine — it exists
 * to model the CONTRACT so the adapter is a drop-in and so a test can prove a
 * repeated key takes one payment. The durable guard is the unique index on
 * park_payments.idempotency_key.
 */
const chargeReplays = new Map<string, ChargeResult>();
/** The same, for money going the other way. */
const refundReplays = new Map<string, ChargeResult>();

export const LakeLifePaymentsServer = {
  /**
   * Mock of the processor's charge(). In production the processor charges the
   * vault token and hands back the real `ref`; we never see a card number here.
   * Amounts are integer cents to avoid float drift. This mock also refuses
   * anything that looks like a raw PAN, defending CLAUDE.md rule 4 in depth.
   */
  async charge(input: ChargeInput): Promise<ChargeResult> {
    // REPLAY, DO NOT RE-CHARGE. A real processor holds this server-side for
    // 24h; this mock holds it in memory, which is enough to model the contract
    // and to let a test prove that two calls with one key take one payment.
    if (input.idempotencyKey) {
      const seen = chargeReplays.get(input.idempotencyKey);
      if (seen) return seen;
    }
    if (!input.token.startsWith("tok_")) {
      return { ok: false, error: "Invalid payment token." };
    }
    // A real processor charges a vault token, never a card number — refuse a
    // long digit run that could be (or hide) a leaked PAN.
    if (/\d{12,}/.test(input.token)) {
      return {
        ok: false,
        error: "Refusing to charge what looks like a raw card number.",
      };
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      return {
        ok: false,
        error: "Charge amount must be a positive whole number of cents.",
      };
    }

    // A stand-in charge reference. The real one comes from the processor.
    const rand =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? "x" + crypto.randomUUID().replace(/-/g, "").slice(0, 15)
        : "x" + Math.random().toString(36).slice(2, 17);
    const result: ChargeResult = { ok: true, ref: `ch_mock_${rand}`, amountCents: input.amountCents };
    if (input.idempotencyKey) chargeReplays.set(input.idempotencyKey, result);
    return result;
  },

  /**
   * Mock of the processor's refund(). Real processors refund against the
   * original charge reference, never the card; same shape here so the real
   * adapter is a drop-in (docs/refunds-design.md). A charge ref containing
   * "rf_fail" refuses deterministically — the test hook for the failure
   * path, mirroring how declining cards are staged for charge().
   */
  async refund(input: RefundInput): Promise<ChargeResult> {
    // A double-submitted refund used to reach the processor twice while the
    // office was told the money went back once. Same replay contract as a
    // charge, because a refund is a charge in the other direction.
    if (input.idempotencyKey) {
      const seen = refundReplays.get(input.idempotencyKey);
      if (seen) return seen;
    }
    if (!input.chargeRef || !input.chargeRef.startsWith("ch_")) {
      return { ok: false, error: "Invalid charge reference." };
    }
    if (input.chargeRef.includes("rf_fail")) {
      return { ok: false, error: "Processor refused the refund." };
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      return { ok: false, error: "Refund amount must be a positive whole number of cents." };
    }
    const rand =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? "x" + crypto.randomUUID().replace(/-/g, "").slice(0, 15)
        : "x" + Math.random().toString(36).slice(2, 17);
    const result: ChargeResult = { ok: true, ref: `rf_mock_${rand}`, amountCents: input.amountCents };
    if (input.idempotencyKey) refundReplays.set(input.idempotencyKey, result);
    return result;
  },
};
