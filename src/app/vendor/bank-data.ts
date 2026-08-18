import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getPlatformSettings } from "@/lib/settings";
import { earlyFee } from "@/lib/payouts";
import { mustRead } from "@/lib/must-read";

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
  const vendor = mustRead(
    "your crew account",
    await admin.from("vendors").select("id").eq("user_id", user.id).maybeSingle(),
  );
  if (!vendor) return null;

  // EVERY READ BELOW IS A NUMBER ABOUT SOMEBODY'S MONEY. A dropped connection
  // used to render "no bank account on file", "$0.00 ready to pull" and an
  // empty payout history — three sentences a crew acts on, none of them true.
  const [acctRes, readyRes, batchesRes, settings] = await Promise.all([
    admin.from("payout_accounts").select("bank_name, account_last4").eq("user_id", user.id).maybeSingle(),
    admin.from("payouts").select("amount, kind").eq("vendor_id", vendor.id).eq("status", "released").is("batch_id", null),
    admin.from("payout_batches").select("id, kind, net, status, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(12),
    getPlatformSettings(),
  ]);
  const acct = mustRead("your bank details", acctRes);
  const ready = mustRead("what's ready to pull", readyRes);
  const batches = mustRead("your payout history", batchesRes);
  const readyNow = Math.round((ready ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100;
  // THE PREVIEW MUST QUOTE WHAT THE ACTION WILL ACTUALLY CHARGE. `requestEarlyPayout`
  // computes the 2% on earned money only — a tip is never discounted, because
  // the homeowner is told every cent of it reaches the crew — and this screen
  // did not. The crew was shown a fee too high and a net too low, then paid
  // more than the number they tapped. Two plausible figures, neither flagged.
  // Unreachable until now only because no tip had ever been recorded.
  const tipsReady = Math.round(
    (ready ?? []).filter((p) => p.kind === "tip").reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100,
  ) / 100;
  const { fee } = earlyFee(Math.round((readyNow - tipsReady) * 100) / 100, settings.earlyPayoutFeePct);
  const net = Math.round((readyNow - fee) * 100) / 100;
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
