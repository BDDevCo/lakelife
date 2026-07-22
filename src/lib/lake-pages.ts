/**
 * Lake landing pages (§8 SEO) — PURE helpers. Public pages show CUSTOMER
 * menu pricing only (the menu is public by nature; crew rates and margin
 * never appear — rule 1 applies to the public internet most of all).
 * "From" pricing is honest: the lowest real number a service can bill at,
 * with its unit named when the price scales.
 */

import type { ServiceRule } from "@/lib/pricing";

export interface FromPrice {
  amount: number;
  unit: string | null; // "per section", "per foot" — null = flat/from
  from: boolean; // true when the real bill scales up from this number
}

export function fromPrice(rule: Pick<ServiceRule, "pricing_model" | "base" | "unit_rate" | "band_pricing">): FromPrice | null {
  const base = Number(rule.base ?? 0);
  const unit = Number(rule.unit_rate ?? 0);
  switch (rule.pricing_model) {
    case "flat":
      return base > 0 ? { amount: base, unit: null, from: false } : null;
    case "per_section": {
      // The unit is whatever the service actually counts (pier sections,
      // boat lifts, PWC lifts) — band_pricing.count_field names it.
      const cf = (rule.band_pricing as { count_field?: string } | null)?.count_field ?? "pier_sections";
      const label =
        cf === "boat_lifts" ? "per lift" :
        cf === "pwc_lifts" ? "per PWC lift" :
        cf === "jet_skis" ? "per jet ski" : "per pier section";
      return unit > 0 ? { amount: unit, unit: label, from: true } : null;
    }
    case "per_foot":
      return unit > 0 ? { amount: unit, unit: "per boat foot", from: true } : null;
    case "band": {
      const b = rule.band_pricing as { small?: number; medium?: number; large?: number } | null;
      const vals = [b?.small, b?.medium, b?.large].map(Number).filter((n) => n > 0);
      return vals.length ? { amount: Math.min(...vals), unit: null, from: true } : null;
    }
    case "per_sqft_band": {
      const b = rule.band_pricing as { tiers?: Array<{ max: number | null; price: number }> } | null;
      const vals = (b?.tiers ?? []).map((t) => Number(t.price)).filter((n) => n > 0);
      return vals.length ? { amount: Math.min(...vals), unit: null, from: true } : null;
    }
    default:
      return null;
  }
}

/** "Big Long Lake" → "big-long-lake" (must match the SQL backfill exactly). */
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
