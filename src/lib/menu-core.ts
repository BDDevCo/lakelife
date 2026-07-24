import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * THE menu update executor (moved out of the "use server" action module,
 * review finding 2026-07-23: every export of a "use server" file is a
 * network-reachable endpoint, and this one is deliberately auth-free — the
 * caller authorizes. server-only + a lib home makes that posture structural,
 * same as refund-core). applyMenuSuggestion validates a human's tap,
 * autoApplyPriceSuggestions (lib/automation.ts) drives the exact same write
 * as the machine — one validated path, one 40% cap re-check against
 * whatever's on the menu RIGHT NOW, either way.
 *
 * NOTE this changes what CUSTOMERS PAY going forward — prices at booking
 * are read live from services, existing booked jobs keep their price.
 */

export interface ApplyMenuSuggestionInput {
  serviceId: string;
  field: "base" | "unit_rate" | "band:medium" | "tier:mid";
  newValue: number;
}

export interface ApplyMenuSuggestionResult {
  ok: boolean;
  error?: string;
  applied?: string;
}

type BandPricing = {
  small?: number;
  medium?: number;
  large?: number;
  tiers?: Array<{ max: number | null; price: number }>;
  [key: string]: unknown;
};

export async function executeMenuUpdate(
  admin: ReturnType<typeof createServiceClient>,
  input: ApplyMenuSuggestionInput,
): Promise<ApplyMenuSuggestionResult> {
  const newValue = Math.round(Number(input.newValue) * 100) / 100;
  if (!Number.isFinite(newValue) || newValue <= 0) {
    return { ok: false, error: "New price must be a positive number." };
  }
  const serviceId = input.serviceId;
  if (!serviceId) return { ok: false, error: "Missing service." };

  const { data: svc } = await admin
    .from("services")
    .select("id, name, base, unit_rate, band_pricing")
    .eq("id", serviceId)
    .maybeSingle();
  if (!svc) return { ok: false, error: "Service not found." };

  // 40% cap, checked against whatever the CURRENT value of the target field
  // is right now (never the client's snapshot) — a stale suggestion can't
  // sneak a bigger jump through than what's actually on the menu today.
  const withinCap = (current: number) => current > 0 && newValue <= current * 1.4;
  const CAP_ERROR = "That raise is larger than the 40% cap allows — refresh Margin Health and try again.";

  switch (input.field) {
    case "base": {
      const current = Number(svc.base ?? 0);
      if (!withinCap(current)) return { ok: false, error: CAP_ERROR };
      const { error } = await admin.from("services").update({ base: newValue }).eq("id", serviceId);
      if (error) return { ok: false, error: error.message };
      return { ok: true, applied: `Base raised $${current} → $${newValue}.` };
    }
    case "unit_rate": {
      const current = Number(svc.unit_rate ?? 0);
      if (!withinCap(current)) return { ok: false, error: CAP_ERROR };
      const { error } = await admin.from("services").update({ unit_rate: newValue }).eq("id", serviceId);
      if (error) return { ok: false, error: error.message };
      return { ok: true, applied: `Unit rate raised $${current} → $${newValue}.` };
    }
    case "band:medium": {
      const band = ((svc.band_pricing ?? {}) as BandPricing) ?? {};
      const current = Number(band.medium ?? 0);
      if (!withinCap(current)) return { ok: false, error: CAP_ERROR };
      const nextBand: BandPricing = { ...band, medium: newValue };
      const { error } = await admin.from("services").update({ band_pricing: nextBand }).eq("id", serviceId);
      if (error) return { ok: false, error: error.message };
      return { ok: true, applied: `Medium band raised $${current} → $${newValue}.` };
    }
    case "tier:mid": {
      const band = ((svc.band_pricing ?? {}) as BandPricing) ?? {};
      const tiers = Array.isArray(band.tiers) ? [...band.tiers] : [];
      if (tiers.length === 0) return { ok: false, error: "This service has no tiers on file." };
      const midIdx = Math.floor(tiers.length / 2);
      const current = Number(tiers[midIdx]?.price ?? 0);
      if (!withinCap(current)) return { ok: false, error: CAP_ERROR };
      // Read-modify-write: only the mid tier's price moves, everything else
      // in the jsonb (including its own `max` bound) is carried through.
      tiers[midIdx] = { ...tiers[midIdx], price: newValue };
      const nextBand: BandPricing = { ...band, tiers };
      const { error } = await admin.from("services").update({ band_pricing: nextBand }).eq("id", serviceId);
      if (error) return { ok: false, error: error.message };
      return { ok: true, applied: `Mid tier raised $${current} → $${newValue}.` };
    }
    default:
      return { ok: false, error: "Unknown field." };
  }
}
