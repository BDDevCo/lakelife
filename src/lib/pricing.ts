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
  /**
   * A PARK'S LIVE LOT COUNT — the only countable that is not equipment.
   *
   * A 21-lot park is a different day's work from a 60-lot one, so grounds work
   * is priced off the count the same way a pier is priced off its sections.
   * OPTIONAL on the profile: a lake house has no `lots` key at all, which
   * `profileValue` reads as 0, which makes `serviceApplies` false, which keeps
   * every park service off a lake house's menu without a single extra branch.
   */
  | "lots"
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
  /**
   * per_section: floor the count at this value (prototype floors lifts at 1).
   * The floor only ever raises a count an OWNER already has — it can never
   * conjure equipment from zero; serviceApplies() runs first (audit bug 5).
   */
  min_count?: number;
  /** band: price per band key. */
  small?: number;
  medium?: number;
  large?: number;
  /** per_sqft_band: ordered tiers; first whose max > sqft wins (max null = top tier). */
  tiers?: Array<{ max: number | null; price: number }>;
  /**
   * Additive per-engine pricing (winterize/de-winterize): for each boat
   * that has an engine, add the first tier whose max > engine_hp (max null
   * = top tier), times the boat's engine count. Rides ON TOP of the model
   * price — the per-foot rate still matters (owner, 2026-07-22); engines
   * refine it, they don't replace it.
   */
  per_engine_hp_tiers?: Array<{ max: number | null; price: number }>;
  /** generic additive terms applied on top of the model price. */
  add?: AddTerm[];
  /**
   * TRANSPORT (0149). Collection work only — the boat is not at the property,
   * so the visit carries a tow whose length is a property of the BOOKING, not
   * of the home. Every other input to pricing comes off the profile; this one
   * cannot.
   *
   * `included_miles` is covered by the model price; past it,
   * `per_mile_beyond` is charged on the excess only. Both default to 0, which
   * is the INERT state: no radius, no rate, and the service prices exactly as
   * a flat service always has. That is the shape the market bills in — the
   * research file's Pointe Marine: free within ~20 miles, then $3.60/mile.
   */
  included_miles?: number;
  per_mile_beyond?: number;
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
  /** Present only on a park's grounds property. See CountableField. */
  lots?: number;
  sqft: number;
  beds: number;
  baths: number;
  pier_sections: number;
  boat_lifts: number;
  toy_lifts: number;
  jet_skis: number;
  pwc_lifts: number;
  lawn_band: "small" | "medium" | "large";
  boats: Array<{
    type?: string;
    length_ft: number;
    /** 'outboard' | 'sterndrive' | 'inboard' | 'jet' | 'none' — null/absent = unknown (legacy). */
    engine_type?: string | null;
    engine_hp?: number | null;
    engines?: number | null;
  }>;
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
 * The equipment fields a rule's own data says the work is measured in.
 *
 * Two sources, both already in `band_pricing` — no new column, rule 8 intact:
 *  1. `count_field` — the per_section counter (pier sections, lifts, skis).
 *  2. a FLAT rule's `add` terms. This is the water-toy case, and the audit
 *     (two-season audit 2026-07, bug 5) is right to count it as phantom: the
 *     $120 base is the *visit fee* for handling the things the `add` terms
 *     name (toy lifts, loose toys). With none of them there is nothing to
 *     pull, wrap or store — the crew drives out to a bare shoreline. A flat
 *     rule that names no equipment (spring opening, fall winterization,
 *     battery care) has an empty list here and always applies, which is why
 *     the gate cannot touch the seasonal and land services.
 */
export function countedFields(rule: ServiceRule): CountableField[] {
  const cfg: PricingParams = rule.band_pricing ?? {};
  if (cfg.count_field) return [cfg.count_field];
  if (rule.pricing_model === "flat" && Array.isArray(cfg.add) && cfg.add.length) {
    return cfg.add.map((t) => t.field);
  }
  return [];
}

/**
 * Does this service have anything to DO at this property?
 *
 * Audit bug 5: the "$0 means you don't own this" guard in createBooking only
 * ever protected pure multipliers, so a `base` (pier $220, water toys $120)
 * or a `min_count` floor (boat lift $495) quoted a real, bookable price to
 * someone who owns none of it — ~455 phantom tiles per 1,000 customers, each
 * one a crew driving to a property with nothing to do. Applicability is now
 * an explicit property of (rule, profile) instead of something the arithmetic
 * was hoped to reach, so it is stateable and testable on its own.
 *
 * A rule that counts nothing always applies — lawn, housekeeping, opening and
 * winterization are unaffected.
 */
export function serviceApplies(rule: ServiceRule, p: PricingProfile): boolean {
  const fields = countedFields(rule);
  if (fields.length === 0) return true;
  return fields.some((f) => profileValue(p, f) > 0);
}

/**
 * Compute the customer price for one service against one property profile.
 * Always returns a finite number ≥ 0, and exactly 0 when the service does
 * not apply to the property at all.
 */
export function priceService(rule: ServiceRule, p: PricingProfile): number {
  const cfg: PricingParams = rule.band_pricing ?? {};

  // Nothing to do here → no price, no tile, no booking (audit bug 5).
  if (!serviceApplies(rule, p)) return 0;

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

  // Per-engine adds: sail/no-engine boats skip; unknown HP prices at the
  // cheapest tier (an honest floor, never a guess up).
  if (Array.isArray(cfg.per_engine_hp_tiers) && cfg.per_engine_hp_tiers.length) {
    for (const b of p.boats ?? []) {
      if ((b.engine_type ?? "") === "none") continue;
      const hp = Number(b.engine_hp) || 0;
      const tier = cfg.per_engine_hp_tiers.find((t) => t.max == null || hp < t.max);
      if (tier) price += Math.max(1, Number(b.engines) || 1) * Number(tier.price);
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

/**
 * TRANSPORT SURCHARGE for a collection visit (0149).
 *
 * DELIBERATELY NOT PART OF `priceService`. That function has 25 call sites —
 * menus, tiles, the crew's own rate card, margin health, autopilot — and not
 * one of them knows where a boat wintered. Threading a distance through it
 * would make 24 of them price at zero miles, which is precisely how 0115 put
 * three money bugs live from one change. So this is additive and opt-in: a
 * caller that knows the distance adds it, and everything else is untouched
 * and returns exactly what it returned before.
 *
 * `miles` is the ONE-WAY tow, matching how the market bills (research:
 * "transport is billed per one-way move"). Returns whole dollars ≥ 0.
 *
 * Returns 0 — meaning "the model price already covers it" — when:
 *   · no rate is configured (the inert default, and today's live state)
 *   · the distance is unknown (null); the CALLER decides what to do about
 *     that, because silently charging nothing is an undercharge and this
 *     function must not make that call on its own
 *   · the tow is inside the included radius
 */
export function transportFee(rule: ServiceRule, miles: number | null): number {
  const cfg: PricingParams = rule.band_pricing ?? {};
  const rate = Number(cfg.per_mile_beyond) || 0;
  if (rate <= 0) return 0; // inert: no mileage pricing on this service
  if (miles == null || !Number.isFinite(miles) || miles < 0) return 0;
  const included = Math.max(0, Number(cfg.included_miles) || 0);
  const excess = miles - included;
  if (excess <= 0) return 0;
  return Math.max(0, Math.round(excess * rate));
}

/** Does this service bill by distance at all? Drives whether a booking must
 *  know where the boat is before it can quote one all-in price. */
export function billsByDistance(rule: ServiceRule): boolean {
  return (Number(rule.band_pricing?.per_mile_beyond) || 0) > 0;
}

/** Format a price the way the customer sees it — one all-in dollar figure. */
export function formatPrice(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}
