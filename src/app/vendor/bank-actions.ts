"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sealSecret } from "@/lib/gate";
import { abaValid, accountPlausible, earlyFee } from "@/lib/payouts";
import { getPlatformSettings } from "@/lib/settings";
import { sendSms } from "@/lib/sms";

export interface BankResult {
  ok: boolean;
  error?: string;
  last4?: string;
}

/**
 * Save where the money goes. Routing/account are validated (real ABA
 * checksum — a typo never reaches the vault), encrypted at rest with the
 * gate-code AES envelope, and NEVER echoed back — the caller gets last4
 * and nothing else. Works for crew users and HOA users alike.
 */
export async function setPayoutAccount(input: {
  bankName: string;
  routing: string;
  account: string;
}): Promise<BankResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const routing = (input.routing ?? "").replace(/\D/g, "");
  const account = (input.account ?? "").replace(/\D/g, "");
  if (!abaValid(routing)) return { ok: false, error: "That routing number doesn't check out — double-check the 9 digits on your checks." };
  if (!accountPlausible(account)) return { ok: false, error: "Account numbers are 4–17 digits." };

  const admin = createServiceClient();
  const last4 = account.slice(-4);
  const { data: prev } = await admin
    .from("payout_accounts").select("account_last4").eq("user_id", user.id).maybeSingle();
  const { error } = await admin.from("payout_accounts").upsert({
    user_id: user.id,
    bank_name: (input.bankName ?? "").slice(0, 80) || null,
    routing_encrypted: sealSecret(routing),
    account_encrypted: sealSecret(account),
    account_last4: last4,
    updated_at: new Date().toISOString(),
  });
  if (error) return { ok: false, error: error.message };
  // A changed payout destination is never silent — a hijacked session must
  // not be able to reroute money without the owner hearing about it.
  if (prev && prev.account_last4 !== last4) {
    try {
      const { data: u } = await admin.from("users").select("phone").eq("id", user.id).maybeSingle();
      if (u?.phone) void sendSms(u.phone as string, `LakeLife security: your payout account was just changed to ····${last4}. If this wasn't you, call us immediately.`);
    } catch { /* best effort */ }
  }
  return { ok: true, last4 };
}

export interface EarlyPayoutResult {
  ok: boolean;
  error?: string;
  gross?: number;
  fee?: number;
  net?: number;
}

/**
 * "Get it now": batch every released, un-batched payout for THIS crew at
 * the early_payout_fee_pct dial. Race-safe: the batch row is created
 * first, then payout rows are CLAIMED by a guarded update (batch_id null
 * → this batch) — a double-tap's second claim gets zero rows and the
 * empty batch is deleted. The queued batch is what the automated banking
 * layer executes; nothing here waits on a human.
 */
export async function requestEarlyPayout(): Promise<EarlyPayoutResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const admin = createServiceClient();
  const { data: vendor } = await admin
    .from("vendors").select("id, company").eq("user_id", user.id).maybeSingle();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet." };

  const { data: acct } = await admin
    .from("payout_accounts").select("account_last4").eq("user_id", user.id).maybeSingle();
  if (!acct) return { ok: false, error: "Add your bank details first — that's where the money lands." };

  // Create the envelope INVISIBLE to the exporter ('building'), claim rows
  // into it, then write totals + flip to 'queued' in ONE checked update —
  // the export can never see a batch whose numbers aren't final (review:
  // the $0-export window is how a crew gets paid nothing for real money).
  const { data: batch, error: bErr } = await admin
    .from("payout_batches")
    .insert({ user_id: user.id, vendor_id: vendor.id, kind: "early", status: "building" })
    .select("id")
    .single();
  if (bErr || !batch) return { ok: false, error: bErr?.message ?? "Couldn't start the payout." };

  const unclaimAndDrop = async () => {
    await admin.from("payouts").update({ batch_id: null }).eq("batch_id", batch.id);
    await admin.from("payout_batches").delete().eq("id", batch.id);
  };

  const { data: claimed } = await admin
    .from("payouts")
    .update({ batch_id: batch.id })
    .eq("vendor_id", vendor.id)
    .eq("status", "released")
    .is("batch_id", null)
    .select("amount");
  const gross = Math.round((claimed ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100;
  if (!claimed || claimed.length === 0 || gross <= 0) {
    await unclaimAndDrop();
    return { ok: false, error: "Nothing released to pull right now — payouts land here the moment a job's photos clear." };
  }

  const settings = await getPlatformSettings();
  const { fee, net } = earlyFee(gross, settings.earlyPayoutFeePct);
  const { data: finalized, error: finErr } = await admin
    .from("payout_batches")
    .update({ gross, fee, net, status: "queued" })
    .eq("id", batch.id)
    .eq("status", "building")
    .select("id");
  if (finErr || !finalized || finalized.length === 0) {
    await unclaimAndDrop(); // money goes back to the pool, nothing stranded
    return { ok: false, error: "Couldn't queue the payout — nothing was taken, try again." };
  }

  // The receipt text — the number they'll see land.
  try {
    const { data: u } = await admin.from("users").select("phone").eq("id", user.id).maybeSingle();
    if (u?.phone) {
      void sendSms(u.phone as string, `LakeLife: early payout queued — $${net.toFixed(2)} to your account ····${acct.account_last4} ($${gross.toFixed(2)} − $${fee.toFixed(2)} early fee). Month-end payouts are always free. 🌊`);
    }
  } catch { /* best effort */ }

  return { ok: true, gross, fee, net };
}
