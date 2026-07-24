"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";

/**
 * Apply a Margin Health price-up suggestion (docs/margin-gap-design.md
 * follow-on) — one tap turns a margin_stranded row's suggested raise into
 * a live menu change. Ops-only; the server never trusts the client's
 * numbers — it re-reads the service, re-derives the CURRENT value of the
 * exact field being replaced, and re-checks the 40% cap itself.
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

export async function applyMenuSuggestion(input: ApplyMenuSuggestionInput): Promise<ApplyMenuSuggestionResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const newValue = Math.round(Number(input.newValue) * 100) / 100;
  if (!Number.isFinite(newValue) || newValue <= 0) {
    return { ok: false, error: "New price must be a positive number." };
  }
  const serviceId = input.serviceId;
  if (!serviceId) return { ok: false, error: "Missing service." };

  const admin = createServiceClient();
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
