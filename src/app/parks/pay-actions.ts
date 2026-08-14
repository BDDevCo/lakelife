"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { LakeLifePayments } from "@/lib/payments";
import { rentDescriptor } from "@/lib/descriptor";
import { todayLakeDate } from "@/lib/booking";

/**
 * PAYING RENT FROM THE RESIDENT'S OWN SCREEN.
 *
 * RENT IS THE PARK'S MONEY. LakeLife moves it and records it; it never becomes
 * our revenue, never nets against a service debt, and a late bill here can
 * never hold back a mow. The row this writes is an ordinary `park_payments`
 * row — the same one the office writes for a cheque — so the existing paid
 * total, receipt number and claim-settling triggers all apply unchanged.
 * Online is a METHOD, not a second money path.
 *
 * ON THE RAIL. This charges the saved card through the same mock interface the
 * service side uses, so the processor is a later config decision. When real
 * keys arrive, rent belongs on ACH: The Haven is ~$5,200 a month, which is
 * about $1,860 a year in card fees versus roughly $230 on ACH. `method`
 * already accepts both.
 */

export interface PayResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

export async function payRent(chargeId: string): Promise<PayResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in again." };

  const admin = createServiceClient();

  // ---- is this bill actually theirs? -------------------------------------
  // The charge id comes from a browser, so nothing is trusted about it. The
  // path from the signed-in account to the bill runs through the CLAIMED
  // renter file, which is the same gate the portal itself uses.
  const { data: charge } = await admin
    .from("park_charges")
    .select("id, park_id, renter_id, amount, paid_total, status, period_month")
    .eq("id", chargeId)
    .maybeSingle();
  if (!charge) return { ok: false, error: "We can't find that bill." };

  const { data: file } = await admin
    .from("park_renters")
    .select("id")
    .eq("id", charge.renter_id as string)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!file) return { ok: false, error: "That isn't your bill." };

  if ((charge.status as string) === "void") {
    return { ok: false, error: "That bill was cancelled — nothing to pay." };
  }

  // ---- the park has to have agreed to take money this way ----------------
  const { data: park } = await admin
    .from("parks")
    .select("accepts_online_rent, name")
    .eq("id", charge.park_id as string)
    .maybeSingle();
  if (!park?.accepts_online_rent) {
    return { ok: false, error: "This park isn't taking online rent payments yet." };
  }

  // ---- A DISPUTED BILL IS NOT COLLECTED ----------------------------------
  // They have told the office the ledger is wrong and nothing is being chased
  // until somebody looks. Taking the money anyway — especially on a future
  // autopay run — is the single worst thing this action could do.
  const { count: openClaims } = await admin
    .from("park_payment_claims")
    .select("id", { count: "exact", head: true })
    .eq("charge_id", charge.id as string)
    .is("resolved_at", null);
  if ((openClaims ?? 0) > 0) {
    return {
      ok: false,
      error: "You've told the office this bill doesn't look right, so we're not taking payment until they've checked.",
    };
  }

  const owed = Math.round((Number(charge.amount ?? 0) - Number(charge.paid_total ?? 0)) * 100) / 100;
  if (owed <= 0) return { ok: false, error: "That bill is already settled." };

  const { data: pm } = await admin
    .from("payment_methods")
    .select("token, last4")
    .eq("user_id", user.id)
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!pm?.token) return { ok: false, error: "Add a payment method first." };

  // ---- take it -----------------------------------------------------------
  const charged = await LakeLifePayments.charge({
    token: pm.token as string,
    amountCents: Math.round(owed * 100),
    // The park's name on the statement, not LakeLife's — it is their rent, and
    // an unrecognised line on a bank statement is a chargeback.
    description: rentDescriptor(park.name as string),
  });
  if (!charged.ok || !charged.ref) {
    return { ok: false, error: "That payment didn't go through. Try again, or ring the office." };
  }

  // 0108 refuses a card or ACH row with no processor reference, so a payment
  // that cannot be traced cannot be recorded at all.
  const { error } = await admin.from("park_payments").insert({
    park_id: charge.park_id,
    renter_id: file.id,
    charge_id: charge.id,
    amount: owed,
    method: "card",
    received_on: todayLakeDate(),
    reference: charged.ref,
    kind: "rent",
  });
  if (error) {
    // The money left their account and the ledger did not record it. This is
    // the one failure ops must never discover from a resident.
    return {
      ok: false,
      error: `Your payment went through (${charged.ref}) but we couldn't file it. Ring the office with that reference — do not pay again.`,
    };
  }

  revalidatePath("/parks/my");
  return { ok: true, signal: `Paid — thank you. It's on your ledger straight away.` };
}
