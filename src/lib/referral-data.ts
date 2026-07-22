import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";

/**
 * Referral ticker aggregates (owner request, 2026-07-23). Per-row earnings are
 * OPS-ONLY at RLS (review H2: a row's amount ÷ the public pct reconstructs a
 * customer's bill — rule 1 by arithmetic). Beneficiaries get TOTALS through
 * here instead: enough to run the scoreboard, never enough to do the math on
 * any single job.
 */

export interface ReferralTicker {
  earnedTotal: number; // lifetime, all non-void accruals
  maturing: number; // inside the clawback window
  available: number; // homeowners: spendable credit balance · crews: matured awaiting payout batch
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function getMyReferralTicker(): Promise<ReferralTicker | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createServiceClient();
  const [{ data: earnings }, { data: credits }, { data: vendorRow }] = await Promise.all([
    admin.from("referral_earnings").select("amount, status").eq("beneficiary", user.id).neq("status", "void"),
    admin.from("user_credits").select("amount").eq("user_id", user.id),
    admin.from("vendors").select("id").eq("user_id", user.id).maybeSingle(),
  ]);

  let earnedTotal = 0, maturing = 0, matured = 0;
  for (const e of earnings ?? []) {
    const a = Number(e.amount ?? 0);
    earnedTotal += a;
    if (e.status === "accrued") maturing += a;
    if (e.status === "matured") matured += a;
  }
  const creditBalance = (credits ?? []).reduce((s, c) => s + Number(c.amount ?? 0), 0);

  return {
    earnedTotal: r2(earnedTotal),
    maturing: r2(maturing),
    available: r2(vendorRow ? matured : Math.max(0, creditBalance)),
  };
}
