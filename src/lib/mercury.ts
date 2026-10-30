import "server-only";
import { worldActionRefusal } from "@/lib/deployment";

/**
 * MERCURY — originating the ACH credits that pay crews.
 *
 * "lets get the mercury ach payouts to crews working" — 29 Oct 2026.
 *
 * Today a crew is paid by a CSV somebody downloads from /ops and hands a bank,
 * which decrypts every crew's routing and account number into one file. This
 * is the rail that replaces it.
 *
 * ===========================================================================
 * WHY `request-send-money` AND NOT `createTransaction`
 * ===========================================================================
 *
 * Mercury has two ways to move money and only one of them is open to us:
 *
 *   createTransaction ....... sends immediately. REQUIRES AN IP ALLOWLIST.
 *   request-send-money ...... queues for approval. No allowlist; Mercury's own
 *                             docs say it "may be useful in situations where a
 *                             static IP is not available".
 *
 * **Vercel serverless has no static egress IP.** So the direct path is closed
 * without a paid static-IP add-on or a proxy in front of us, and we use a
 * custom token with the `RequestSendMoney` scope.
 *
 * THE APPROVAL STEP IS A FEATURE HERE, NOT A LIMITATION. It is this product's
 * own standing rule — nothing goes out until he says — enforced by the bank
 * instead of by us. A payout run assembles itself, queues, and waits for one
 * tap in Mercury. Nothing in this file can move money on its own, by design.
 *
 * Which is also why `payout_batches` gained a `submitted` status in 0202
 * rather than reusing `paid`: a queued request is money ASKED FOR, not money
 * gone. Calling it paid would be this repo's own "a payment is not money until
 * it clears" on the way out instead of on the way in.
 *
 * ===========================================================================
 * WHAT IS UNVERIFIED, AND WHY THE MOCK IS THE DEFAULT
 * ===========================================================================
 *
 * This is built against Mercury's DOCUMENTED shape, read on 29 Oct 2026. It
 * has never run against a live Mercury account, because there is not one yet.
 * Two things in particular are unconfirmed and are his to check in the
 * dashboard before the first real run:
 *
 *   - THE PER-ACCOUNT ACH LIMIT. Mercury assigns one and only an admin can
 *     request an increase. A third-party guide claims $500k/day; that is not
 *     an official source. The Haven's crew run is small, but the limit is a
 *     cliff rather than a slope.
 *   - WHETHER MASS PAYMENTS CARRY A FEE. The developer page says 100 free ACH
 *     transfers a month; the pricing page appears to list "making mass
 *     payments on our API" among charged items. Those conflict, and the
 *     pricing page is old.
 *
 * So, exactly as `payments-server.ts` does for cards: unless the secrets are
 * set, every call here is a MOCK that moves nothing and says so. A mock that
 * silently looked like a success is how this codebase once had six charge
 * paths all "succeed" against nothing.
 */

const BASE = "https://api.mercury.com/api/v1";

export interface MercuryResult<T> {
  ok: boolean;
  /** Set when `ok` — never a partial success. */
  data?: T;
  /** A sentence for a person. Never a raw API body. */
  error?: string;
  /** True when nothing left this process. */
  mocked?: boolean;
}

/**
 * Are the secrets there?
 *
 * Both, deliberately: a token with no account id cannot address a payment, and
 * an account id with no token cannot authenticate. Half-configured is the
 * state that produces a confusing failure at the worst moment.
 */
export function mercuryConfigured(): boolean {
  return Boolean(process.env.MERCURY_API_TOKEN && process.env.MERCURY_ACCOUNT_ID);
}

/** The sentence a screen shows when it is not set up. Never the reason why. */
export const NOT_CONFIGURED =
  "Mercury isn't connected yet, so nothing was sent. Payouts stay queued until it is.";

async function call<T>(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<MercuryResult<T>> {
  // A BRANCH DEPLOY MUST NOT MOVE MONEY. Preview shares this database and
  // holds live credentials, so a payout run from somebody's feature branch
  // would queue real payments against the real account.
  const refusal = worldActionRefusal("payout");
  if (refusal) return { ok: false, error: refusal };

  if (!mercuryConfigured()) {
    // THE MOCK NEVER LOOKS LIKE A SUCCESS WITH AN ID. It returns `mocked`, and
    // every caller must decide what to do with that rather than storing a
    // fake id that a later approval or return would try to match against.
    return { ok: false, mocked: true, error: NOT_CONFIGURED };
  }

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.MERCURY_API_TOKEN}`,
        "content-type": "application/json",
        // Mercury's docs do not document an idempotency header, so this is
        // belt and braces rather than a guarantee: the real protection
        // against a double send is 0202's unique index on
        // `mercury_request_id` plus the one-rail trigger.
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[mercury] ${path} -> ${res.status}: ${text.slice(0, 400)}`);
      return {
        ok: false,
        error:
          res.status === 401 || res.status === 403
            ? "Mercury refused our credentials, so nothing was sent."
            : `Mercury couldn't take that just now (${res.status}). Nothing was sent.`,
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    // A NETWORK ERROR IS NOT A REFUSAL. We do not know whether Mercury
    // received it, so the caller must not record the batch as sent — and must
    // not retry blindly either. Said plainly so the sentence on screen is
    // honest about the uncertainty.
    console.error(`[mercury] ${path} threw:`, e);
    return {
      ok: false,
      error:
        "We couldn't reach Mercury. We don't know whether it got through, so nothing " +
        "has been marked sent — check Mercury before trying again.",
    };
  }
}

export interface RecipientInput {
  name: string;
  routing: string;
  account: string;
  /** Mercury distinguishes these and an ACH credit needs to know. */
  accountKind: "checking" | "savings";
  email?: string | null;
}

/**
 * Create the crew as a payee at Mercury.
 *
 * Once per crew, not once per payment: 0202 keeps `mercury_recipient_id` on
 * `payout_accounts` so their routing and account number are handed over a
 * single time. Every later run addresses the recipient id, which means the
 * one place in this product where bank numbers become plaintext stays the one
 * place it already was.
 */
export async function createRecipient(
  input: RecipientInput,
  idempotencyKey: string,
): Promise<MercuryResult<{ id: string }>> {
  const res = await call<{ id?: string; recipientId?: string }>(
    "/recipients",
    {
      name: input.name,
      emails: input.email ? [input.email] : [],
      paymentMethod: "electronic",
      electronicRoutingInfo: {
        accountNumber: input.account,
        routingNumber: input.routing,
        electronicAccountType: input.accountKind,
      },
    },
    idempotencyKey,
  );
  if (!res.ok) return { ok: false, error: res.error, mocked: res.mocked };
  const id = res.data?.id ?? res.data?.recipientId;
  if (!id) {
    // AN ID WE DID NOT GET IS NOT AN ID WE CAN STORE. Mercury may well have
    // created the recipient; what we cannot do is pretend we know its name.
    console.error("[mercury] a recipient came back with no id:", res.data);
    return { ok: false, error: "Mercury created the payee but didn't tell us its id. Check Mercury before retrying." };
  }
  return { ok: true, data: { id } };
}

export interface PayoutInput {
  recipientId: string;
  amountCents: number;
  /** Shows on the crew's statement and in Mercury's approval queue. */
  note: string;
}

/**
 * Queue a payment for approval.
 *
 * Returns Mercury's id for the REQUEST, which 0202 stores and makes immutable:
 * it is the only thing an approval or a return arriving later can be matched
 * against, and a rewritten id orphans money already asked for.
 */
export async function requestPayout(
  input: PayoutInput,
  idempotencyKey: string,
): Promise<MercuryResult<{ requestId: string }>> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    // Refused here rather than at Mercury, because a zero or negative amount
    // is our arithmetic being wrong and the error should say so.
    return { ok: false, error: "That payout amount doesn't look right, so nothing was sent." };
  }
  const res = await call<{ id?: string; requestId?: string }>(
    `/account/${process.env.MERCURY_ACCOUNT_ID}/request-send-money`,
    {
      recipientId: input.recipientId,
      // Mercury takes dollars. The ledger keeps cents, and the conversion
      // happens HERE, once, at the boundary.
      amount: input.amountCents / 100,
      paymentMethod: "ach",
      note: input.note,
      idempotencyKey,
    },
    idempotencyKey,
  );
  if (!res.ok) return { ok: false, error: res.error, mocked: res.mocked };
  const id = res.data?.id ?? res.data?.requestId;
  if (!id) {
    console.error("[mercury] a payment request came back with no id:", res.data);
    return {
      ok: false,
      error:
        "Mercury took the request but didn't give us an id for it. It may be waiting for " +
        "approval — check Mercury before sending again.",
    };
  }
  return { ok: true, data: { requestId: id } };
}

/**
 * The key for one batch's payment, so a retry cannot pay twice.
 *
 * The batch id, which is already unique and already the thing being paid.
 * Composed here rather than at the call site for the reason `chargeKey` exists
 * on the money-in side: a key invented per caller is a key that differs
 * between callers.
 */
export function payoutKey(batchId: string): string {
  return `payout:${batchId}`;
}

export function recipientKey(userId: string): string {
  return `recipient:${userId}`;
}
