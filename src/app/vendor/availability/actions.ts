"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getMyVendorId } from "@/app/vendor/data";

export interface SlotResult {
  ok: boolean;
  error?: string;
}

/**
 * Confirm the signed-in user owns a vendors row, and return its id + status.
 * Identity is asserted with the SESSION client (auth.getUser); the row is read
 * with the SERVICE client so RLS can't hide a still-onboarding record. Mirrors
 * assertMyVendor in onboarding-actions.ts / rates-actions.ts — NEVER trust a
 * vendorId sent from the browser.
 */
async function assertMyVendor(): Promise<{ id: string; status: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("vendors")
    .select("id, status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return null;
  return { id: data.id as string, status: data.status as string };
}

const STORAGE_TYPES = ["outdoor", "indoor"] as const;

/** Clamp to a whole-number storage capacity in feet, 0..100000 (0 = no storage). */
function validCapacityFeet(n: unknown): number | null {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0 || v > 100_000) return null;
  return v;
}

export interface StorageSettingsInput {
  capacityFeet: number;
  types: string[];
}

/**
 * Crew self-sets their winter storage capacity (feet) and storage types
 * (outdoor lot / indoor building). Mirrors setServiceLakes/setDailyCapacity in
 * onboarding-actions.ts exactly: identity asserted via assertMyVendor, the
 * write goes through the service role, and both inputs are whitelisted/clamped
 * server-side — never trust the browser. Writes vendors.storage_capacity_feet
 * and vendors.storage_types ONLY (own row).
 */
export async function setStorageSettings(input: StorageSettingsInput): Promise<SlotResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };
  }

  const capacityFeet = validCapacityFeet(input?.capacityFeet);
  if (capacityFeet == null) return { ok: false, error: "Enter a whole number of feet, 0 or more." };

  const wanted = Array.isArray(input?.types) ? input.types : [];
  const types = [
    ...new Set(wanted.filter((t): t is string => typeof t === "string" && (STORAGE_TYPES as readonly string[]).includes(t))),
  ];

  const admin = createServiceClient();
  const { error } = await admin
    .from("vendors")
    .update({ storage_capacity_feet: capacityFeet, storage_types: types })
    .eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Add or remove a day from the signed-in vendor's `work_days`.
 *
 * THIS WAS BROKEN, AND HAD BEEN SINCE IT SHIPPED. The comment here used to
 * read "the RLS policy on `vendors` already scopes the row to this vendor …
 * so no service role is needed", which is half of the requirement. Postgres
 * needs BOTH a table GRANT and an RLS policy to let a write through, and
 * `authenticated` holds INSERT, DELETE and SELECT on `vendors` — never UPDATE.
 * So `vendor_updates_self` permitted a write the grant refused, and every tap
 * of a work-day chip came back "permission denied for table vendors".
 *
 * Found by a post-condition in 0100 asserting that tables written by the
 * session client still hold their grants: `vendors` failed the assertion, and
 * the assertion was right.
 *
 * Fixed the way the other ~50 tables do it — service role, scoped in code by
 * `getMyVendorId()`, which is a session read and cannot be spoofed from a
 * browser. `vendors` therefore needs no client write grant at all, and 0100
 * takes the leftover INSERT/DELETE away with the rest.
 */
export async function toggleWorkDay(day: string): Promise<SlotResult> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return { ok: false, error: "This is the vendor area." };

  const admin = createServiceClient();
  const { data: vendor } = await admin
    .from("vendors")
    .select("work_days")
    .eq("id", vendorId)
    .maybeSingle();

  const current: string[] = (vendor?.work_days as string[] | null) ?? [];
  const next = current.includes(day)
    ? current.filter((d) => d !== day)
    : [...current, day];

  // `.eq("id", vendorId)` is the scope, and vendorId came from the SESSION —
  // never from an argument — so the service role can only ever reach this
  // vendor's own row.
  const { error } = await admin.from("vendors").update({ work_days: next }).eq("id", vendorId);
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
