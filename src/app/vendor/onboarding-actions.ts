"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import {
  DOC_TYPES, MAX_DOC_BYTES, safeExt, validExpiry, validLatLng, activationGaps,
} from "./onboarding-helpers";

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

/** Clamp to a whole-number daily capacity in the allowed 1–20 range. */
function validCapacity(n: unknown): number | null {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1 || v > 20) return null;
  return v;
}

/**
 * Crew self-sets how many jobs a day they can take (1–20). Writes
 * vendors.daily_capacity only, own row, via the service role after an identity
 * check — the same trust model as setServiceTypes. This replaces the ops-only
 * setCrewCapacity for the onboarding path.
 */
export async function setDailyCapacity(n: number): Promise<OnboardingResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };

  const cap = validCapacity(n);
  if (cap == null) return { ok: false, error: "Enter a whole number of jobs per day, 1 to 20." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ daily_capacity: cap }).eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Crew self-selects the lakes they service. Every id is whitelisted against the
 * lakes table (service-role select) so a tampered client can't invent a lake or
 * claim one that doesn't exist. Writes vendors.service_lakes only.
 */
export async function setServiceLakes(lakeIds: string[]): Promise<OnboardingResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };

  const admin = createServiceClient();
  const { data: lakes } = await admin.from("lakes").select("id, name");
  const allowed = new Set((lakes ?? []).map((l) => l.id as string));

  const wanted = Array.isArray(lakeIds) ? lakeIds : [];
  let clean = [...new Set(wanted.filter((id) => typeof id === "string" && allowed.has(id)))];
  if (clean.length === 0) return { ok: false, error: "Choose at least one lake you service." };

  // Phase E: a lake the crew is paused on can't be re-added until its
  // cooldown runs out (missing table pre-migration ⇒ no pauses — safe).
  try {
    const { isCoolingDown } = await import("@/lib/lake-standing");
    const { getPlatformSettings } = await import("@/lib/settings");
    const [{ data: pauses }, settings] = await Promise.all([
      admin.from("vendor_lake_demotions").select("lake_id, demoted_at").eq("vendor_id", vendor.id),
      getPlatformSettings(),
    ]);
    const cooling = new Set(
      (pauses ?? [])
        .filter((p) => isCoolingDown(p.demoted_at as string, settings.lakeDemotionCooldownDays, Date.now()))
        .map((p) => p.lake_id as string),
    );
    const blocked = clean.filter((id) => cooling.has(id));
    if (blocked.length > 0) {
      const nameById = new Map((lakes ?? []).map((l) => [l.id as string, l.name as string]));
      const names = blocked.map((id) => nameById.get(id) ?? "that lake").join(", ");
      clean = clean.filter((id) => !cooling.has(id));
      if (clean.length === 0) {
        return { ok: false, error: `${names} is paused for your crew right now — it reopens automatically. Pick your other lakes for now.` };
      }
    }
  } catch {
    /* pre-migration: no pause table yet — proceed */
  }

  const { error } = await admin.from("vendors").update({ service_lakes: clean }).eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Crew self-sets a home base (from address autocomplete → lat/lng). Optional:
 * it sharpens distance ranking but must NEVER block activation. Coordinates are
 * sanity-bounded (rejects 0,0 and out-of-region typos) before storing.
 */
export async function setBaseLocation(lat: number, lng: number): Promise<OnboardingResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };

  const base = validLatLng(lat, lng);
  if (!base) return { ok: false, error: "That location didn't look right — pick your town from the list." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ base_lat: base.lat, base_lng: base.lng }).eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * ZERO-OPS SELF-ACTIVATION (Phase A). The crew flips THEMSELVES from 'invited'
 * to 'active' the moment their documents + declarations clear the mechanical
 * gate — no ops approval. Every requirement is re-checked SERVER-SIDE against a
 * fresh service-role read (never trust the browser). A suspended crew can never
 * self-reactivate here (that stays an ops-only override), and verified_at is
 * stamped for the annual COI re-validation cycle.
 *
 * Note: this proves the docs are present, typed, and unexpired — not that the
 * COI is authentic. Authenticity is carried by the onboarding agreement + the
 * yearly re-attest + a future third-party verification callback.
 */
export async function finishOnboarding(): Promise<OnboardingResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };
  if (vendor.status === "active") return { ok: true }; // already live — idempotent

  const admin = createServiceClient();
  const { data: v } = await admin
    .from("vendors")
    .select("coi_url, coi_expiry, w9_url, service_types, service_lakes, daily_capacity")
    .eq("id", vendor.id)
    .maybeSingle();
  if (!v) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };

  const gaps = activationGaps(
    {
      coi_url: (v.coi_url as string | null) ?? null,
      coi_expiry: (v.coi_expiry as string | null) ?? null,
      w9_url: (v.w9_url as string | null) ?? null,
      service_types: (v.service_types as string[] | null) ?? [],
      service_lakes: (v.service_lakes as string[] | null) ?? [],
      daily_capacity: (v.daily_capacity as number | null) ?? null,
    },
    todayLakeDate(),
  );
  if (gaps.length > 0) return { ok: false, error: gaps[0] };

  const { error } = await admin
    .from("vendors")
    .update({ status: "active", verified_at: new Date().toISOString() })
    .eq("id", vendor.id)
    .eq("status", "invited"); // guard: only invited→active, never resurrect a suspension
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
