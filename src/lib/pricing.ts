/**
 * LakeLife pricing engine.
 *
 * Every price the customer sees is computed HERE from rules stored in the
 * `services` table (CLAUDE.md rule 8 — pricing lives in data, not code).
 * This file only knows how to *apply* a rule to a property profile; the
 * numbers themselves come from the database (see supabase/seed/seed_services.sql).
 *
 * The five pricing models, straight from the prototype:
 *   flat          — fixed price (spring opening, fall winterization)
 *   per_section    — base + unit_rate × a counted field (pier sections, lifts)
 *   per_foot       — base + unit_rate × total boat feet (bow to stern)
 *   band           — a price chosen by a named band (lawn: small/medium/large)
 *   per_sqft_band  — a price chosen by a square-footage tier (housekeeping)
 *   seasonal_plus_perdiem — winter storage: this computes the SEASONAL
 *                    MINIMUM (base + unit_rate × boat feet), charged when
 *                    the fall visit completes. The per-diem overage past
 *                    the season-end dials is billed at spring splash by
 *                    the settle machinery — never part of the booking quote.
 *
 * A rule may also carry generic additive terms in its params (e.g. water-toy
 * prep = base + per-lift + per-toy), so the whole thing stays data-driven.
 */

export type PricingModel =
  | "flat"
  | "per_section"
  | "per_foot"
  | "band"
  | "per_sqft_band"
  | "seasonal_plus_perdiem";

/** A profile field that can be counted or multiplied in a pricing rule. */
export type CountableField =
  | "pier_sections"
  | "boat_lifts"
  | "toy_lifts"
  | "jet_skis"
  | "pwc_lifts"
  | "toys_count"
  | "beds"
  | "baths";

/** One additive term: rate × the value of a profile field. */
export interface AddTerm {
  field: CountableField;
  rate: number;
}

/** Extra rule parameters stored in services.band_pricing (jsonb). */
export interface PricingParams {
  /** per_section: which profile field to count (default "pier_sections"). */
  count_field?: CountableField;
  /** per_section: floor the count at this value (prototype floors lifts at 1). */
  min_count?: number;
  /** band: price per band key. */
  small?: number;
  medium?: number;
  large?: number;
  /** per_sqft_band: ordered tiers; first whose max > sqft wins (max null = top tier). */
  tiers?: Array<{ max: number | null; price: number }>;
  /** generic additive terms applied on top of the model price. */
  add?: AddTerm[];
}

/** A pricing rule as stored in the `services` table. */
export interface ServiceRule {
  id?: string;
  name: string;
  pricing_model: PricingModel;
  base: number;
  unit_rate: number;
  band_pricing?: PricingParams | null;
}

/** The property inputs that drive pricing. */
export interface PricingProfile {
  sqft: number;
  beds: number;
  baths: number;
  pier_sections: number;
  boat_lifts: number;
  toy_lifts: number;
  jet_skis: number;
  pwc_lifts: number;
  lawn_band: "small" | "medium" | "large";
  boats: Array<{ type?: string; length_ft: number }>;
  toys: Array<{ name?: string }>;
}

/** Total boat length across the fleet, bow to stern. */
export function boatFeet(p: Pick<PricingProfile, "boats">): number {
  return (p.boats ?? []).reduce((sum, b) => sum + (Number(b.length_ft) || 0), 0);
}

function profileValue(p: PricingProfile, field: AddTerm["field"]): number {
  if (field === "toys_count") return (p.toys ?? []).length;
  const v = (p as unknown as Record<string, unknown>)[field];
  return Number(v) || 0;
}

/**
 * Compute the customer price for one service against one property profile.
 * Always returns a finite number ≥ 0.
 */
export function priceService(rule: ServiceRule, p: PricingProfile): number {
  const cfg: PricingParams = rule.band_pricing ?? {};
  let price = 0;

  switch (rule.pricing_model) {
    case "flat":
      price = rule.base;
      break;

    case "per_section": {
      const field = cfg.count_field ?? "pier_sections";
      let count = Number((p as unknown as Record<string, unknown>)[field]) || 0;
      if (cfg.min_count != null) count = Math.max(cfg.min_count, count);
      price = rule.base + rule.unit_rate * count;
      break;
    }

    case "per_foot":
    case "seasonal_plus_perdiem": // seasonal minimum scales by the fleet's feet
      price = rule.base + rule.unit_rate * boatFeet(p);
      break;

    case "band":
      price = Number(cfg[p.lawn_band] ?? rule.base) || 0;
      break;

    case "per_sqft_band": {
      const tiers = cfg.tiers ?? [];
      const tier = tiers.find((t) => t.max == null || p.sqft < t.max);
      price = tier ? Number(tier.price) : rule.base;
      break;
    }
  }

  // Generic additive terms (e.g. water toys: base + per-lift + per-toy).
  if (Array.isArray(cfg.add)) {
    for (const term of cfg.add) {
      price += Number(term.rate) * profileValue(p, term.field);
    }
  }

  return Math.max(0, Math.round(price));
}

/** Format a price the way the customer sees it — one all-in dollar figure. */
export function formatPrice(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}
