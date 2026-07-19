"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { DOC_TYPES, MAX_DOC_BYTES, safeExt, validExpiry } from "./onboarding-helpers";

export interface OnboardingResult {
  ok: boolean;
  error?: string;
}

/**
 * Confirm the signed-in user owns a vendors row, and return its id + status.
 * Identity is asserted with the SESSION client (auth.getUser); the row is read
 * with the SERVICE client so RLS can't hide a still-onboarding record. NEVER
 * trust a vendorId sent from the browser.
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

/**
 * Upload a Certificate of Insurance or W-9 to the private vendor-docs bucket
 * and record its path on the vendor row. The crew's device sends the file in a
 * FormData; for a COI it must also send a future `expiry` (YYYY-MM-DD). The
 * client can ONLY ever move coi_url/coi_expiry/w9_url — never status, capacity
 * or payout (those are the service role's / ops' to set).
 */
export async function uploadVendorDoc(kind: "coi" | "w9", form: FormData): Promise<OnboardingResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };
  }
  if (kind !== "coi" && kind !== "w9") return { ok: false, error: "Unknown document." };

  // COI needs a valid future expiry BEFORE we store anything.
  let expiry: string | null = null;
  if (kind === "coi") {
    expiry = validExpiry(form.get("expiry"), todayLakeDate());
    if (!expiry) return { ok: false, error: "Enter the COI's expiry date — it must be in the future." };
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No file received." };
  if (!(DOC_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Use a PDF, JPG, PNG, WEBP or HEIC file." };
  }
  if (file.size > MAX_DOC_BYTES) return { ok: false, error: "File is too large (max 10MB)." };

  const admin = createServiceClient();
  const ext = safeExt(file.name);
  const path = `${vendor.id}/${kind}-${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await admin.storage.from("vendor-docs").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (upErr) return { ok: false, error: upErr.message };

  const patch =
    kind === "coi" ? { coi_url: path, coi_expiry: expiry } : { w9_url: path };
  const { error: rowErr } = await admin.from("vendors").update(patch).eq("id", vendor.id);
  if (rowErr) return { ok: false, error: rowErr.message };
  return { ok: true };
}

/** A short-lived signed URL to view a stored vendor doc (own row only). */
export async function getVendorDocUrl(kind: "coi" | "w9"): Promise<string | null> {
  const vendor = await assertMyVendor();
  if (!vendor) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("vendors")
    .select("coi_url, w9_url")
    .eq("id", vendor.id)
    .maybeSingle();
  const path = (kind === "coi" ? data?.coi_url : data?.w9_url) as string | null;
  if (!path) return null;
  const { data: signed } = await admin.storage.from("vendor-docs").createSignedUrl(path, 3600);
  return signed?.signedUrl ?? null;
}

/**
 * Store which services this crew does. Every name is whitelisted against the
 * ACTIVE services table (service role select) so a tampered client can't invent
 * work types. Writes vendors.service_types only — nothing else.
 */
export async function setServiceTypes(types: string[]): Promise<OnboardingResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };
  }

  const admin = createServiceClient();
  const { data: svcs } = await admin.from("services").select("name").eq("active", true);
  const allowed = new Set((svcs ?? []).map((s) => s.name as string));

  const wanted = Array.isArray(types) ? types : [];
  const clean = [...new Set(wanted.filter((t) => typeof t === "string" && allowed.has(t)))];

  const { error } = await admin
    .from("vendors")
    .update({ service_types: clean })
    .eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
