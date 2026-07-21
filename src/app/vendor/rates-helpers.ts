/**
 * Pure helpers for CREW RATE-SETTING. No I/O, fully unit-testable.
 *
 * CLAUDE.md rule 1 is paramount here: a crew NEVER sees the customer/menu
 * price or margin. Everything in this file deals only with STRUCTURE (which
 * inputs a service needs, its band boundaries, its counted field) and the
 * crew's OWN private take-home numbers — never a customer price and never an
 * anchor derived from one.
 *
 * A crew's stored rate mirrors the `services` pricing shape (base / unit_rate /
 * band_pricing) so the Phase 8 dispatch engine's priceService() can compute the
 * crew's price for any property. We copy the service's *structural* params
 * (count_field, min_count, tier maxes) into the crew's band_pricing so pricing
 * counts the right field — but we NEVER copy the service's dollar amounts.
 */

import type { PricingModel, PricingParams } from "@/lib/pricing";

/** Largest per-line take-home we'll accept (guards fat-finger / overflow). */
export const RATE_CAP = 100_000;

/** The service structure a crew prices against (NO customer dollars used). */
export interface RateService {
  pricing_model: PricingModel;
  band_pricing: PricingParams | null;
}

/** A crew's existing saved rate row (may be absent). */
export interface ExistingRate {
  base: number | null;
  unit_rate: number | null;
  band_pricing: PricingParams | null;
}

/** What the client submits — plain numbers in the crew's own units. */
export interface RatePayload {
  base?: number | string | null;
  unitRate?: number | string | null;
  /** band/tier values keyed by the field key (small|medium|large or a tier key). */
  band?: Record<string, number | string | null>;
}

export type RateFieldKind = "base" | "unit" | "band" | "tier";

/** One input to render for a service's rate. */
export interface RateField {
  key: string; // form key the client echoes back
  kind: RateFieldKind;
  label: string;
  value: number | null; // the crew's current saved value, if any
}

/** The full render spec for one service's rate row. */
export interface RateForm {
  model: PricingModel;
  unitNoun: string | null; // "pier section", "foot", ... (null for flat/band)
  fields: RateField[];
}

/** Human noun for a per-unit rate, from the service's counted field. */
export function unitNounFor(model: PricingModel, countField?: string | null): string {
  if (model === "per_foot") return "foot";
  switch (countField) {
    case "pier_sections":
      return "pier section";
    case "boat_lifts":
      return "boat lift";
    case "jet_skis":
      return "jet ski";
    case "pwc_lifts":
      return "PWC lift";
    case "toy_lifts":
      return "toy lift";
    default:
      return "unit";
  }
}

/** Stable key for a sqft tier — its max, or "top" for the open-ended last tier. */
export function tierKey(max: number | null): string {
  return max == null ? "top" : String(max);
}

/** Readable band label from the tier boundaries (structure, not price). */
export function tierLabel(prevMax: number | null, max: number | null): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (max == null) return prevMax == null ? "Any size" : `${fmt(prevMax)}+ sq ft`;
  if (prevMax == null) return `Up to ${fmt(max)} sq ft`;
  return `${fmt(prevMax)}–${fmt(max)} sq ft`;
}

const BAND_KEYS = ["small", "medium", "large"] as const;
const BAND_LABEL: Record<(typeof BAND_KEYS)[number], string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate ONE crew rate number. Returns a rounded (to the cent) non-negative
 * value, or null if empty/missing. Throws-free: invalid (NaN, negative, over
 * cap) is reported separately by the caller via `valid`.
 */
export function coerceRate(v: unknown): { ok: boolean; value: number } {
  if (v == null || v === "") return { ok: true, value: 0 };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > RATE_CAP) return { ok: false, value: 0 };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** Ordered tier maxes for a per_sqft_band service (structure only). */
function tierMaxes(service: RateService): (number | null)[] {
  const tiers = service.band_pricing?.tiers ?? [];
  return tiers.map((t) => (t.max == null ? null : Number(t.max)));
}

/**
 * Build the render spec for a service's rate row from the SERVICE structure and
 * the crew's existing values. Pure — never reads or returns a customer price.
 */
export function buildRateForm(service: RateService, existing: ExistingRate | null): RateForm {
  const base = existing?.base != null ? Number(existing.base) : null;
  const unit = existing?.unit_rate != null ? Number(existing.unit_rate) : null;
  const bp = existing?.band_pricing ?? null;

  switch (service.pricing_model) {
    case "flat":
      return {
        model: "flat",
        unitNoun: null,
        fields: [{ key: "base", kind: "base", label: "Your flat take-home", value: base }],
      };

    case "per_section": {
      const noun = unitNounFor("per_section", service.band_pricing?.count_field);
      return {
        model: "per_section",
        unitNoun: noun,
        fields: [
          { key: "base", kind: "base", label: "Base charge (optional)", value: base },
          { key: "unit_rate", kind: "unit", label: `Your rate per ${noun}`, value: unit },
        ],
      };
    }

    case "per_foot":
      return {
        model: "per_foot",
        unitNoun: "foot",
        fields: [
          { key: "base", kind: "base", label: "Base charge (optional)", value: base },
          { key: "unit_rate", kind: "unit", label: "Your rate per foot", value: unit },
        ],
      };

    case "band":
      return {
        model: "band",
        unitNoun: null,
        fields: BAND_KEYS.map((k) => ({
          key: k,
          kind: "band" as const,
          label: BAND_LABEL[k],
          value: num(bp?.[k]),
        })),
      };

    case "per_sqft_band": {
      const maxes = tierMaxes(service);
      const existingTiers = bp?.tiers ?? [];
      let prev: number | null = null;
      const fields: RateField[] = maxes.map((max) => {
        const key = tierKey(max);
        const label = tierLabel(prev, max);
        prev = max;
        const found = existingTiers.find((t) => (t.max == null ? null : Number(t.max)) === max);
        return { key, kind: "tier" as const, label, value: found ? Number(found.price) : null };
      });
      return { model: "per_sqft_band", unitNoun: null, fields };
    }

    default:
      return { model: service.pricing_model, unitNoun: null, fields: [] };
  }
}

export interface RateRowResult {
  ok: boolean;
  error?: string;
  row?: { base: number; unit_rate: number; band_pricing: PricingParams | null };
}

/**
 * Turn a crew's submitted payload into the columns to store, re-deriving all
 * STRUCTURE from the authoritative service (never trusting client-sent shape).
 * Copies the service's count_field / min_count / tier maxes so dispatch prices
 * the right field — but only the crew's own dollars go into the numbers.
 */
export function computeRateRow(service: RateService, payload: RatePayload): RateRowResult {
  const band = payload.band ?? {};

  const b = coerceRate(payload.base);
  const u = coerceRate(payload.unitRate);
  if (!b.ok) return { ok: false, error: "Enter a valid base amount (0 or more)." };
  if (!u.ok) return { ok: false, error: "Enter a valid rate (0 or more)." };

  switch (service.pricing_model) {
    case "flat":
      return { ok: true, row: { base: b.value, unit_rate: 0, band_pricing: null } };

    case "per_section": {
      // Carry the service's counted field so dispatch counts the right thing.
      const bpOut: PricingParams = {};
      if (service.band_pricing?.count_field) bpOut.count_field = service.band_pricing.count_field;
      if (service.band_pricing?.min_count != null) bpOut.min_count = service.band_pricing.min_count;
      return {
        ok: true,
        row: { base: b.value, unit_rate: u.value, band_pricing: Object.keys(bpOut).length ? bpOut : null },
      };
    }

    case "per_foot":
      return { ok: true, row: { base: b.value, unit_rate: u.value, band_pricing: null } };

    case "band": {
      const out: PricingParams = {};
      for (const k of BAND_KEYS) {
        const r = coerceRate(band[k]);
        if (!r.ok) return { ok: false, error: `Enter a valid ${BAND_LABEL[k].toLowerCase()} amount.` };
        (out as Record<string, number>)[k] = r.value;
      }
      return { ok: true, row: { base: 0, unit_rate: 0, band_pricing: out } };
    }

    case "per_sqft_band": {
      const maxes = tierMaxes(service);
      const tiers: NonNullable<PricingParams["tiers"]> = [];
      for (const max of maxes) {
        const r = coerceRate(band[tierKey(max)]);
        if (!r.ok) return { ok: false, error: "Enter a valid amount for each size tier." };
        tiers.push({ max, price: r.value });
      }
      return { ok: true, row: { base: 0, unit_rate: 0, band_pricing: { tiers } } };
    }

    default:
      return { ok: false, error: "This service can't be priced yet — call dispatch." };
  }
}
