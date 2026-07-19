"use server";

import { createClient } from "@/lib/supabase/server";
import type { PaymentToken } from "@/lib/payments";

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
  const { data } = await supabase
    .from("payment_methods")
    .select("id, brand, last4, exp_month, exp_year, is_default")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
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
  // A vault token must look like a token (tok_...) and must not contain a
  // 13-19 digit run (a PAN). The known "tok_<vault>_<last4>_" head is
  // stripped first so its legitimate digits can't join a run and false-flag.
  const t = token?.token ?? "";
  const tail = t.replace(/^tok_[a-z0-9]+_\d{4}_/, "");
  if (!t.startsWith("tok_") || /\d{13,19}/.test(tail) || t.length > 64) {
    return { ok: false, error: "Invalid payment token." };
  }
  if (token.last4 && !/^\d{4}$/.test(token.last4)) {
    return { ok: false, error: "Invalid payment token." };
  }

  const { count } = await supabase
    .from("payment_methods")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  const { error } = await supabase.from("payment_methods").insert({
    user_id: user.id,
    brand: token.brand,
    last4: token.last4,
    exp_month: token.exp_month,
    exp_year: token.exp_year,
    token: token.token,
    is_default: (count ?? 0) === 0, // first card becomes default
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Remove a saved payment method (RLS scopes it to the owner). */
export async function removePaymentMethod(id: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };
  const { error } = await supabase.from("payment_methods").delete().eq("id", id).eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
