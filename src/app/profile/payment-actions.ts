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
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
}

/** List the signed-in customer's saved payment methods (safe details only). */
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
      .select("id, brand, last4, exp_month, exp_year, is_default")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
  );
  return (data ?? []) as SavedCard[];
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
  const t = token?.token ?? "";
  const tail = t.replace(/^tok_[a-z0-9]+_\d{4}_/, "");
  if (t.length === 0 || t.length > 64 || /\d{13,19}/.test(tail) || /\d{13,19}/.test(t)) {
    return { ok: false, error: "Invalid payment token." };
  }
  if (token.last4 && !/^\d{4}$/.test(token.last4)) {
    return { ok: false, error: "Invalid payment token." };
  }

  // THIS COUNT DECIDES WHICH CARD AUTOPAY CHARGES. A failed count is null, and
  // `(count ?? 0) === 0` would read that as "first card" — quietly making this
  // card the default over the one they chose. No count, no save.
  const countRes = await supabase
    .from("payment_methods")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (countRes.error) {
    return { ok: false, error: readFailedMessage("your saved cards", countRes.error) };
  }
  const count = countRes.count;

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
    brand: token.brand,
    last4: token.last4,
    exp_month: token.exp_month,
    exp_year: token.exp_year,
    token: token.token,
    funding,
    is_default: (count ?? 0) === 0, // first card becomes default
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
