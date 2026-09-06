import "server-only";
import {
  LakeLifePaymentsServer,
  type ChargeInput,
  type ChargeResult,
  type RefundInput,
} from "@/lib/payments-server";

/**
 * A MOCK MUST NEVER CREDIT A BILL.
 *
 * `LakeLifePaymentsServer` is a faithful mock of a processor contract
 * (CLAUDE.md rule 4) and its `charge()` returns `{ ok: true, ref: "ch_mock_…" }` for any
 * valid token. That is correct for a mock and correct for the tests that hold
 * the contract down. It is catastrophic as the thing standing between a
 * resident and a bill marked PAID.
 *
 * Six paths in this app charge a card:
 *
 *   requests/actions.ts     ×2   a customer paying for service work
 *   parks/pay-actions.ts    ×1   a resident paying rent
 *   ops/recovery-actions.ts ×1   the 25% fee after a missed visit
 *   automation.ts           ×2   the nightly settle, and a cancellation fee
 *
 * Every one of them would have succeeded against the mock, written a payment
 * row, and marked the bill settled — with no money anywhere. The Haven is
 * already configured with `accepts_online_rent = true` and a 3% card fee, and
 * on 1 January it will have twenty households on the roll. The exposure opens
 * the day the roll is named.
 *
 * ============ WHY A DECLINE, AND NOT AN EXCEPTION ============
 *
 * Because every caller already handles a decline, honestly and in words. The
 * nightly writes `status: 'failed'`, leaves the invoice `due` and emails the
 * customer. `payRent` refuses and tells the resident to ring the office.
 * Nothing has to be rewritten to be safe — the safe path is the one already
 * built for a card that bounces.
 *
 * So this returns a decline. No money moves, no row claims it did, and the
 * screens already know what to say.
 *
 * ============ THE DOORWAY ============
 *
 * App code must call `takePayment` / `giveRefund` and never
 * `LakeLifePaymentsServer.charge` / `.refund` directly, or the guard is only on
 * the doors somebody remembered — which is the defect this codebase keeps
 * paying for. `src/lib/charge-gate.test.ts` scans for that and fails if a
 * direct call comes back.
 *
 * This module is the ONLY importer of `payments-server.ts`, which is where
 * `charge()` and `refund()` now live behind `import "server-only"` — the half
 * a real processor authenticates with a secret key, and therefore the half
 * that must never be reachable from a `"use client"` file.
 *
 * ============ SWITCHING IT ON ============
 *
 * Set `LAKELIFE_PAYMENTS_LIVE=true` in the server environment, and only once
 * real processor keys are wired into `payments-server.ts`. It is deliberately
 * NOT `NEXT_PUBLIC_` — a browser has no business knowing or setting this — and
 * deliberately opt-in: an unset variable means no processor, which is the
 * truth today and the safe default forever.
 */

/** Is a real processor connected? Explicit opt-in; anything else is "no". */
export function paymentsAreLive(): boolean {
  return process.env.LAKELIFE_PAYMENTS_LIVE === "true";
}

/**
 * The sentence for a caller that wants to explain itself to a person. Distinct
 * from a real decline, because "your payment didn't go through" is a lie when
 * the truth is that we never asked anybody.
 */
export const NO_PROCESSOR_REASON = "no_processor" as const;

const declined: ChargeResult = {
  ok: false,
  error: "No payment processor is connected yet, so nothing was charged.",
};

/**
 * THE KEY THE PROCESSOR DEDUPES ON, BUILT ONE WAY.
 *
 * A charge that reaches the bank and a row that records it are two separate
 * things, and everything between them — a timeout, a cold start, a double-
 * tapped button, a nightly run overlapping itself — is a moment where the card
 * can be debited twice. `payments_one_capture_per_invoice` refuses the second
 * ROW; only the processor can refuse the second DEBIT, and it does that on
 * this key.
 *
 * `unitId` is the thing that may be charged exactly once: the invoice for
 * service work and fees, the JOB for a tip (a tip has no invoice at all —
 * 0097 hangs it off `payments.tip_job_id`).
 *
 * `priorDeclines` is the part that is easy to get wrong. A processor replays a
 * DECLINE for the same key for about 24 hours, and the nightly runs exactly 24
 * hours apart — so a key that never moves answers every retry with yesterday's
 * refusal, and the five-night retry cap gets burned on attempts that never
 * reached a bank. Counting the `failed` rows already on file moves the key
 * only when a real attempt was really refused: a crash REPLAYS, a decline
 * RETRIES.
 *
 * Both cancellation-fee doors — the customer cancelling, and the nightly
 * retrying — must produce the SAME string for the same invoice, or the retry
 * is a second debit rather than a replay. That is why this is a function and
 * not a template literal written out at four call sites.
 */
export function chargeKey(
  purpose: "service" | "cancel_fee" | "visit_fee" | "tip",
  unitId: string,
  priorDeclines: number,
): string {
  return `${purpose}:${unitId}:${Math.max(0, Math.trunc(priorDeclines))}`;
}

/** Charge a card — refusing, like a decline, until a processor exists. */
export async function takePayment(input: ChargeInput): Promise<ChargeResult> {
  if (!paymentsAreLive()) return declined;
  return LakeLifePaymentsServer.charge(input);
}

/**
 * Refund against a charge reference — same gate, same reason.
 *
 * A refund the processor never made is the same lie as a payment it never
 * took, and `park_refunds` (0142) is an append-only ledger: a row saying money
 * went back is not something a later correction can unsay.
 *
 * `idempotencyKey` is not optional in spirit — it had simply never existed on
 * this side. Both refund paths call the processor BEFORE writing their row,
 * deliberately (money that reached a card and was not filed is recoverable; a
 * filed refund nobody sent is a household ringing about money that never
 * arrived). That order makes the key the only thing standing between a double-
 * submitted form and two refunds, one of which nothing in the ledger records.
 */
export async function giveRefund(input: RefundInput): Promise<ChargeResult> {
  if (!paymentsAreLive()) {
    return { ok: false, error: "No payment processor is connected yet, so nothing was refunded." };
  }
  return LakeLifePaymentsServer.refund(input);
}
