"use server";

import { createClient } from "@/lib/supabase/server";
import { getMyVendorId } from "@/app/vendor/data";

export interface SlotResult {
  ok: boolean;
  error?: string;
}

/**
 * Add or remove a day from the signed-in vendor's `work_days`. Vendor-only —
 * the RLS policy on `vendors` already scopes the row to this vendor, and the
 * user-session client carries their auth, so no service role is needed.
 */
export async function toggleWorkDay(day: string): Promise<SlotResult> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return { ok: false, error: "This is the vendor area." };

  const supabase = await createClient();
  const { data: vendor } = await supabase
    .from("vendors")
    .select("work_days")
    .eq("id", vendorId)
    .maybeSingle();

  const current: string[] = (vendor?.work_days as string[] | null) ?? [];
  const next = current.includes(day)
    ? current.filter((d) => d !== day)
    : [...current, day];

  const { error } = await supabase.from("vendors").update({ work_days: next }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Block or reopen one slot on one day. Absence of a row means "open", so we
 * upsert (blocked → status 'blocked', reopen → status 'open'). A slot that
 * holds a real LakeLife job is status 'booked' and locked: we re-read the
 * current status first and refuse to touch it, so a stale grid can't move a
 * scheduled crew. Vendor-only via the user-session client + RLS.
 */
export async function setSlot(date: string, slot: string, blocked: boolean): Promise<SlotResult> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return { ok: false, error: "This is the vendor area." };

  const supabase = await createClient();

  // Re-read status — never let the vendor change a booked slot.
  const { data: existing } = await supabase
    .from("vendor_availability")
    .select("status")
    .eq("vendor_id", vendorId)
    .eq("date", date)
    .eq("slot", slot)
    .maybeSingle();
  if (existing?.status === "booked") {
    return { ok: false, error: "That slot has a LakeLife job — message dispatch to move it." };
  }

  const { error } = await supabase.from("vendor_availability").upsert(
    { vendor_id: vendorId, date, slot, status: blocked ? "blocked" : "open" },
    { onConflict: "vendor_id,date,slot" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
