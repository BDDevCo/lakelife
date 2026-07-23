import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getPlatformSettings } from "@/lib/settings";
import { earlyFee } from "@/lib/payouts";

export interface PayoutState {
  hasAccount: boolean;
  bankName: string | null;
  last4: string | null;
  /** Released, un-batched take-home ready to pull. */
  readyNow: number;
  feePct: number;
  feeNow: number;
  netNow: number;
  batches: Array<{ id: string; kind: string; net: number; status: string; created_at: string }>;
}

/** The crew's payout picture — last4 only, never the encrypted blobs. */
export async function getMyPayoutState(): Promise<PayoutState | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const { data: vendor } = await admin.from("vendors").select("id").eq("user_id", user.id).maybeSingle();
  if (!vendor) return null;

  const [{ data: acct }, { data: ready }, { data: batches }, settings] = await Promise.all([
    admin.from("payout_accounts").select("bank_name, account_last4").eq("user_id", user.id).maybeSingle(),
    admin.from("payouts").select("amount").eq("vendor_id", vendor.id).eq("status", "released").is("batch_id", null),
    admin.from("payout_batches").select("id, kind, net, status, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(12),
    getPlatformSettings(),
  ]);
  const readyNow = Math.round((ready ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100;
  const { fee, net } = earlyFee(readyNow, settings.earlyPayoutFeePct);
  return {
    hasAccount: !!acct,
    bankName: (acct?.bank_name as string) ?? null,
    last4: (acct?.account_last4 as string) ?? null,
    readyNow,
    feePct: settings.earlyPayoutFeePct,
    feeNow: fee,
    netNow: net,
    batches: (batches ?? []).map((b) => ({
      id: b.id as string, kind: b.kind as string, net: Number(b.net ?? 0),
      status: b.status as string, created_at: b.created_at as string,
    })),
  };
}
