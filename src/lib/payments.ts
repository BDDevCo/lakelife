/**
 * LakeLife payment tokenization — the ONE integration point (CLAUDE.md rule 4).
 *
 * Card data never touches our database. In production this is replaced by the
 * processor's hosted-fields SDK: the card number lives only inside the
 * processor's secure iframe, and we receive back a vault token plus safe
 * display details (brand, last 4, expiry). Until processor keys exist we run
 * this MOCK, which has the exact same shape — `LakeLifePayments.tokenize()` —
 * so swapping in the real SDK later is a drop-in.
 *
 * IMPORTANT: even here, the raw card number is used only to derive brand/last4
 * client-side and is never returned or sent to our server. Only the token +
 * display details leave this function.
 */

export interface CardInput {
  number: string;
  exp: string; // "MM/YY"
  cvc: string;
  name?: string;
}

export interface PaymentToken {
  token: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

export function detectBrand(digits: string): string {
  if (/^4/.test(digits)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "Amex";
  if (/^6(011|5)/.test(digits)) return "Discover";
  return "Card";
}

/** Luhn check — the same basic validity check a real processor applies. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export interface TokenizeResult {
  ok: boolean;
  error?: string;
  token?: PaymentToken;
}

export const LakeLifePayments = {
  /**
   * Mock of the processor's tokenize(). Validates the card, then returns a
   * vault token + safe display details. The card number is discarded here.
   */
  async tokenize(card: CardInput): Promise<TokenizeResult> {
    const digits = card.number.replace(/\D/g, "");
    if (!luhnValid(digits)) {
      return { ok: false, error: "That card number doesn't look valid." };
    }
    const m = card.exp.match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
    if (!m) return { ok: false, error: "Expiry should look like MM/YY." };
    const exp_month = Number(m[1]);
    const exp_year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    if (exp_month < 1 || exp_month > 12) {
      return { ok: false, error: "That expiry month isn't valid." };
    }
    if (!/^\d{3,4}$/.test(card.cvc.trim())) {
      return { ok: false, error: "Check the security code." };
    }

    const brand = detectBrand(digits);
    const last4 = digits.slice(-4);
    // A stand-in vault token. The real one comes from the processor.
    // The random tail is base36 (letters + digits), so the token can never
    // contain a long digit run that trips the server's PAN guard.
    const rand =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? "x" + crypto.randomUUID().replace(/-/g, "").slice(0, 15)
        : "x" + Math.random().toString(36).slice(2, 17);
    const token = `tok_mock_${last4}_${rand}`;

    return { ok: true, token: { token, brand, last4, exp_month, exp_year } };
  },
};
