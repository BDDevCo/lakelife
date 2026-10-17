"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import type { PaymentToken } from "@/lib/payments";
import { normaliseFunding } from "@/app/parks/card-fee";

/**
 * WHY THE WRITES GO THROUGH THE SERVICE CLIENT NOW.
 *
 * 0156 revokes INSERT, UPDATE and DELETE on `payment_methods` from `anon` and
 * `authenticated`. Until then the live grants let a signed-in browser POST
 * straight to PostgREST under policy `pm_owner` — with no CHECK and no trigger
 * on the table, the rule-4 shape guard below was the ONLY thing standing
 * between a raw card number and our database, and it sat on a doorway nobody
 * had to use. The table now refuses that route outright.
 *
 * Which means these two writes can no longer go through the resident's own
 * session; they would fail with a permission error and the card form would
 * simply stop working. They go through the service client instead, and the
 * ownership rule that RLS used to keep is written into the statements: the
 * insert stamps `user_id` from the session, the delete is scoped by it.
 *
 * The READS stay on the session client. The SELECT grant and `pm_owner` are
 * untouched, so a failure of this file cannot widen what anybody can see.
 */

export interface SavedCard {
  id: string;
  /** card | bank (0197). A bank row has no brand and no expiry. */
  kind: "card" | "bank";
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  /** Bank rows only: the institution, and which of two kinds. */
  bank_name: string | null;
  account_kind: "checking" | "savings" | null;
  is_default: boolean;
}

/**
 * List the signed-in customer's saved payment methods (safe details only).
 *
 * `kind` IS SELECTED, and without it the screen cannot tell a bank account
 * from a card: a bank row has no brand and no expiry, so it would render as a
 * card with every field missing. The whole point of 0197 is that these are
 * two different things that get charged on two different rails.
 */
export async function listPaymentMethods(): Promise<SavedCard[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  // Returns a LIST, not { ok, error } — so this one throws rather than lying
  // with an empty wallet ("no card on file" to someone who is on autopay).
  const data = mustRead(
    "your saved cards",
    await supabase
      .from("payment_methods")
      .select("id, kind, brand, last4, exp_month, exp_year, bank_name, account_kind, is_default")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
  );
  return (data ?? []) as SavedCard[];
}

/**
 * RULE 4's SHAPE GUARD, FOR BOTH RAILS — never store anything that could be a
 * real card number or a real bank account number.
 *
 * ONE COPY, because there are two doorways now. A card and a bank account are
 * tokenized by different calls and saved by different actions, and a rule in
 * one doorway of two is the shape this codebase has paid for repeatedly. 0007
 * and 0197 put the same rule on the column, so it holds against a writer that
 * never reaches this line.
 *
 * WHAT IT DOES NOT REQUIRE, and why that matters: not a `tok_` prefix. That is
 * the MOCK's format, invented in payments.ts. A real processor issues its own
 * (`pm_…`, or its own scheme) — so a prefix test means the day the real SDK is
 * swapped in, the very first method anybody tried to add comes back "Invalid
 * payment token" and nothing can ever be saved. The prefix was never the rule;
 * the SHAPE is. A vault token is short, non-empty, and carries no 13-19 digit
 * run, which is what an account number looks like.
 *
 * The known `tok_<vault>_<last4>_` head is stripped first so the mock's own
 * legitimate digits cannot join a run and false-flag.
 */
function tokenShapeRefusal(token: string | undefined, last4: string | null | undefined): string | null {
  const t = token ?? "";
  const tail = t.replace(/^tok_[a-z0-9]+_\d{4}_/, "");
  if (t.length === 0 || t.length > 64 || /\d{13,19}/.test(tail) || /\d{13,19}/.test(t)) {
    return "Invalid payment token.";
  }
  if (last4 && !/^\d{4}$/.test(last4)) return "Invalid payment token.";
  return null;
}

/**
 * WHICH METHOD AUTOPAY USES, decided once for both rails.
 *
 * A failed count is null, and `(count ?? 0) === 0` would read that as "the
 * first one" — quietly making this method the default over the one they chose.
 * No count, no save.
 */
async function isTheirFirstMethod(
  supabase: Awaited<ReturnType<typeof createClient>>, userId: string,
): Promise<{ ok: true; first: boolean } | { ok: false; error: string }> {
  const countRes = await supabase
    .from("payment_methods")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (countRes.error) {
    return { ok: false, error: readFailedMessage("your saved payment methods", countRes.error) };
  }
  return { ok: true, first: (countRes.count ?? 0) === 0 };
}

/**
 * Store a tokenized card. Receives ONLY the vault token + display details —
 * never the card number (that stayed in the browser / processor). First card
 * added becomes the default (autopay) method.
 */
export async function savePaymentMethod(token: PaymentToken): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // RULE 4 guard: never store anything that could be a real card number.
  //
  // WHAT IT USED TO ALSO REQUIRE, AND WHY THAT WAS WRONG. The old test began
  // `!t.startsWith("tok_")`. That is the MOCK's format, invented in
  // payments.ts. Stripe issues `pm_…`, Helcim issues its own — so the day the
  // real SDK is swapped in, the very first card anybody tried to add would
  // have come back "Invalid payment token" and no card could ever be saved.
  // The prefix was never the rule; the SHAPE is. A vault token is short,
  // non-empty, and carries no 13-19 digit run — which is what a card number
  // is. 0156 puts the same rule on the column, so it holds against writers
  // that never reach this line.
  //
  // The known "tok_<vault>_<last4>_" head is still stripped first, so the
  // mock's own legitimate digits cannot join a run and false-flag.
  const bad = tokenShapeRefusal(token?.token, token?.last4);
  if (bad) return { ok: false, error: bad };

  const first = await isTheirFirstMethod(supabase, user.id);
  if (!first.ok) return { ok: false, error: first.error };

  // THE COLUMN THAT DECIDES WHETHER A SURCHARGE IS LEGAL GETS ITS WRITER HERE.
  //
  // `funding` (0156) is what lets the rent path tell a credit card from a
  // debit one, and surcharging debit is forbidden at any rate in every state.
  // The mock's `PaymentToken` carries no funding type and a real SDK does, so
  // this reads it off the token if it is there and records 'unknown' if it is
  // not. 'unknown' surcharges nothing — see card-fee.ts — which is the honest
  // answer for every card on file today.
  const funding = normaliseFunding((token as { funding?: unknown }).funding);

  const { error } = await createServiceClient().from("payment_methods").insert({
    user_id: user.id,
    kind: "card",
    brand: token.brand,
    last4: token.last4,
    exp_month: token.exp_month,
    exp_year: token.exp_year,
    token: token.token,
    funding,
    is_default: first.first, // first method becomes default
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Store a tokenized BANK ACCOUNT. Receives ONLY the vault token, the last four
 * digits and which of two kinds — never the routing or account number, which
 * stayed in the browser and were discarded by `tokenizeBank`.
 *
 * WHY THIS IS WORTH HAVING AT ALL: pay-actions has carried the figure since
 * online rent was built — about $1,860 a year in card fees at The Haven
 * against roughly $230 on ACH. That saving is the park owner's, and under
 * Architecture A it reaches them directly because rent settles to their own
 * merchant account.
 *
 * NOTHING HERE PASSES `funding`. The column is NOT NULL and defaults to
 * 'unknown', and 0197's trigger pins it to 'unknown' on a bank row — the one
 * value `mayBeSurcharged` refuses. Passing a value here would be this doorway
 * taking responsibility for a rule that belongs to all of them.
 */
export async function saveBankAccount(token: {
  token: string;
  last4: string;
  account_kind: "checking" | "savings";
  bank_name: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const bad = tokenShapeRefusal(token?.token, token?.last4);
  if (bad) return { ok: false, error: bad };
  // A BANK ROW MUST SAY WHICH ACCOUNT IT IS. With no brand and no expiry,
  // four digits is the only thing that tells two of them apart on the screen
  // where a resident picks one — so unlike a card's, this one is required.
  if (!/^\d{4}$/.test(token?.last4 ?? "")) {
    return { ok: false, error: "Invalid payment token." };
  }
  if (token.account_kind !== "checking" && token.account_kind !== "savings") {
    return { ok: false, error: "Is it a checking or a savings account?" };
  }

  const first = await isTheirFirstMethod(supabase, user.id);
  if (!first.ok) return { ok: false, error: first.error };

  const { error } = await createServiceClient().from("payment_methods").insert({
    user_id: user.id,
    kind: "bank",
    last4: token.last4,
    token: token.token,
    bank_name: (token.bank_name ?? "")?.trim() || null,
    account_kind: token.account_kind,
    is_default: first.first,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Remove a saved payment method.
 *
 * `.eq("user_id", user.id)` used to be belt-and-braces over RLS. Since 0156
 * revoked DELETE from `authenticated` this runs as the service role, so that
 * clause IS the ownership rule — it is not decoration and must not be dropped.
 */
export async function removePaymentMethod(id: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };
  const { error } = await createServiceClient()
    .from("payment_methods").delete().eq("id", id).eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
