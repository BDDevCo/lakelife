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
 *
 * THIS FILE IS REACHED BY THE BROWSER, ON PURPOSE. `PaymentMethods.tsx` is a
 * `"use client"` component and imports it, which is exactly right for hosted
 * fields and exactly wrong for anything holding a processor's secret key — so
 * `charge()` and `refund()` no longer live here. They are in
 * `payments-server.ts` behind `import "server-only"`, and only
 * `charge-gate.ts` may call them.
 */

import { abaValid, accountPlausible } from "./payouts";

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

// ------------------------------------------------- a bank account ---------

/**
 * WHAT A RESIDENT TYPES TO PAY RENT FROM THEIR BANK, and none of it is kept.
 *
 * The same rule as a card, for the same reason: rule 4 says card data never
 * touches our database, and a routing-and-account pair is the same kind of
 * secret. Only the token, the last four digits of the account and which of
 * two kinds it is leave this function.
 *
 * DELIBERATELY NOT THE `payout_accounts` PATTERN, which holds
 * `routing_encrypted` / `account_encrypted`. A RESIDENT's bank account is the
 * same kind of secret as a card, so CLAUDE.md rule 4 governs it, and 0197
 * asserts that no column on `payment_methods` is even NAMED like a bank
 * credential.
 *
 * THIS USED TO ADD "those columns were written when LakeLife expected to
 * generate ACH files itself; under Architecture A it never does". FALSE since
 * 20 Oct 2026: a crew is never a merchant (0200), so it is paid as LakeLife's
 * accounts payable and **LakeLife does originate those credits.**
 * `payout_accounts` is the live mechanism for paying a crew, not a legacy
 * pattern. The two tables hold different things because they serve different
 * parties — a payer we must never store, and a payee we must be able to pay.
 */
export interface BankInput {
  routing: string;
  account: string;
  accountKind: "checking" | "savings";
  bankName?: string;
}

export interface BankToken {
  token: string;
  last4: string;
  account_kind: "checking" | "savings";
  bank_name: string | null;
}

export interface TokenizeBankResult {
  ok: boolean;
  error?: string;
  token?: BankToken;
}

export interface TokenizeResult {
  ok: boolean;
  error?: string;
  token?: PaymentToken;
}

// ------------------------------------------------- a bank account ---------

/**
 * WHAT A RESIDENT TYPES TO PAY RENT FROM THEIR BANK, and none of it is kept.
 *
 * The same rule as a card, for the same reason: rule 4 says card data never
 * touches our database, and a routing-and-account pair is the same kind of
 * secret. Only the token, the last four digits of the account and which of
 * two kinds it is leave this function.
 *
 * DELIBERATELY NOT THE `payout_accounts` PATTERN, which holds
 * `routing_encrypted` / `account_encrypted`. A RESIDENT's bank account is the
 * same kind of secret as a card, so CLAUDE.md rule 4 governs it, and 0197
 * asserts that no column on `payment_methods` is even NAMED like a bank
 * credential.
 *
 * THIS USED TO ADD "those columns were written when LakeLife expected to
 * generate ACH files itself; under Architecture A it never does". FALSE since
 * 20 Oct 2026: a crew is never a merchant (0200), so it is paid as LakeLife's
 * accounts payable and **LakeLife does originate those credits.**
 * `payout_accounts` is the live mechanism for paying a crew, not a legacy
 * pattern. The two tables hold different things because they serve different
 * parties — a payer we must never store, and a payee we must be able to pay.
 */
/**
 * THE ROUTING AND ACCOUNT CHECKS COME FROM `payouts.ts`, WHICH ALREADY HAD
 * THEM — and the first draft of this file wrote a second copy.
 *
 * `abaValid` (the 3-7-1 checksum) and `accountPlausible` (4-17 digits) have
 * been in src/lib/payouts.ts since the crew payout rails were built, with
 * their own tests and a simulation over them. Two copies of a validation rule
 * is how two doorways come to disagree about whether a bank account is valid,
 * and this codebase has already paid for that once: ten copies of the HTML
 * escaper became one.
 *
 * WHY THE CHECKSUM EARNS ITS PLACE AT ALL: a transposed digit is the
 * commonest data-entry error there is, and it is the direct cause of an R04
 * return — the debit goes out, comes back days later, the bill reopens, the
 * park is charged a return fee and the household is told their payment
 * failed. Nine multiplications catch it at the keyboard instead.
 */

export interface BankInput {
  routing: string;
  account: string;
  accountKind: "checking" | "savings";
  bankName?: string;
}

export interface BankToken {
  token: string;
  last4: string;
  account_kind: "checking" | "savings";
  bank_name: string | null;
}

export interface TokenizeBankResult {
  ok: boolean;
  error?: string;
  token?: BankToken;
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
    //
    // The tail must never contain a long digit run, because charge() in
    // `payments-server.ts` REFUSES any token matching /\d{12,}/ as a
    // leaked-PAN defence (rule 4). The previous version claimed in a comment
    // that its tail was "base36 (letters + digits), so the token can never
    // contain a long digit run" — but crypto.randomUUID() is HEX, and hex is
    // ten digits out of sixteen symbols. About one token in a few hundred came
    // out with twelve or more digits in a row, and our own charge() then
    // rejected our own token. It surfaced as a ~1-in-900 test flake; the real
    // cost was a payment that failed for no reason a customer could
    // understand.
    //
    // Now bounded BY CONSTRUCTION: groups of five, joined by a letter, so the
    // longest possible digit run is five whatever the random source does.
    const raw =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const rand = `x${raw.slice(0, 5)}x${raw.slice(5, 10)}x${raw.slice(10, 15)}`;
    const token = `tok_mock_${last4}_${rand}`;

    return { ok: true, token: { token, brand, last4, exp_month, exp_year } };
  },

  /**
   * Mock of the processor's bank tokenize(). Validates the pair, then returns
   * a vault token and the four digits a resident uses to tell two accounts
   * apart. The routing and account numbers are discarded here.
   *
   * THE TOKEN'S DIGIT RUNS ARE BOUNDED BY CONSTRUCTION, the same way the card
   * one is and for the same reason it had to be fixed there: `charge()` in
   * payments-server.ts refuses any token matching /\d{12,}/ as a leaked-PAN
   * defence, and 0007's own CHECK refuses /[0-9]{13,19}/ on the column. A
   * token built from hex came out with twelve digits in a row about once in a
   * few hundred, and our own guard then rejected our own token. Groups of
   * five joined by a letter make the longest run five whatever the random
   * source does.
   */
  async tokenizeBank(bank: BankInput): Promise<TokenizeBankResult> {
    const routing = (bank.routing ?? "").replace(/\D/g, "");
    const account = (bank.account ?? "").replace(/\D/g, "");

    if (!/^\d{9}$/.test(routing)) {
      return { ok: false, error: "A routing number is nine digits — it's on the bottom left of a cheque." };
    }
    if (!abaValid(routing)) {
      // SAID AS A LIKELY TYPO, not as a verdict on their bank. The checksum
      // fails on a transposition far more often than on a real number.
      return { ok: false, error: "That routing number doesn't check out — it's usually two digits swapped. Have another look." };
    }
    // `accountPlausible` IS 4-17 DIGITS — NACHA's own ceiling, and the floor
    // is what guarantees `last4` has four digits to take. Reused rather than
    // re-spelled for the same reason the checksum is.
    if (!accountPlausible(account)) {
      return { ok: false, error: "An account number is between 4 and 17 digits." };
    }
    if (bank.accountKind !== "checking" && bank.accountKind !== "savings") {
      return { ok: false, error: "Is it a checking or a savings account?" };
    }

    const last4 = account.slice(-4);
    const raw =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const rand = `x${raw.slice(0, 5)}x${raw.slice(5, 10)}x${raw.slice(10, 15)}`;
    const token = `tok_mockbank_${last4}_${rand}`;

    const bankName = (bank.bankName ?? "").trim().slice(0, 60);
    return {
      ok: true,
      token: {
        token,
        last4,
        account_kind: bank.accountKind,
        bank_name: bankName || null,
      },
    };
  },
};
