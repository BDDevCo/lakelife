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

/**
 * THE PUBLIC FIXTURE FENCE ON A HOMEOWNER'S OWN WORK.
 *
 * A job, and the thumbs-up on it, is a fixture because the PROPERTY'S OWNER
 * is — the same derivation the crew count already uses one line above it
 * (dispatch.ts: `users.is_fixture` is read from the owner, never copied onto
 * the child row). Kept here as one pair of strings so the jobs count and the
 * confirmations count cannot drift apart, and so the FK is named rather than
 * guessed: `properties` reaches `users` only through `owner_id`, and an
 * unnamed embed breaks the day a second FK lands.
 *
 * The filter path is the EMBED'S OWN ALIAS chain — `properties.users...` —
 * which is why these two constants travel together.
 */
export const OWNER_FIXTURE_EMBED = "users!properties_owner_id_fkey!inner(is_fixture)";
export const OWNER_FIXTURE_FILTER = "properties.users.is_fixture";

/** Cents-safe: prod rates are whole dollars, but a rate with cents must not
 *  arrive on a public page as 267.99999999999994. */
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * The lowest number this service can actually bill, for the "from $X" line on
 * the public lake page.
 *
 * READ `priceService` BESIDE THIS. Every branch below mirrors one branch of
 * the engine, for the smallest property that could book the service at all
 * (`serviceApplies` decides what "at all" means), because this string is a
 * price claim on the open internet and the engine is what the customer is
 * actually charged.
 *
 * The audit found the two ways it lied, both by dropping `rule.base`:
 *   per_section — "from $48 per pier section" for work that starts at $268
 *                 (base 220 + 48 × 1 section).
 *   flat + add  — "$120" as an EXACT price for water toys, which cannot be
 *                 booked without at least one toy or lift on the profile, so
 *                 the cheapest real bill is $135 and it scales from there.
 *
 * THE UNIT NOUN IS ONLY TRUE OF A NUMBER THAT IS ONE UNIT. "from $268 per
 * pier section" would be a worse lie than the one it replaced — the second
 * section adds $48, not $268 — so the noun is kept only where the floor IS
 * the per-unit rate (no base, no min_count), and dropped for a floor that
 * bundles a base in. The card's own footer already tells the reader the exact
 * all-in price depends on their pier, boat and property.
 */
export function fromPrice(rule: Pick<ServiceRule, "pricing_model" | "base" | "unit_rate" | "band_pricing">): FromPrice | null {
  const base = Number(rule.base ?? 0) || 0;
  const unit = Number(rule.unit_rate ?? 0) || 0;
  const cfg = (rule.band_pricing ?? {}) as {
    count_field?: string;
    min_count?: number | null;
    add?: Array<{ field?: string; rate?: number }>;
    small?: number; medium?: number; large?: number;
    tiers?: Array<{ max: number | null; price: number }>;
  } | null;
  switch (rule.pricing_model) {
    case "flat": {
      // A flat rule's `add` terms are equipment (water toys: per lift, per
      // toy). countedFields makes them the gate — the service does not apply
      // to a property owning none of them — so the cheapest real bill is the
      // base plus the CHEAPEST SINGLE add term, and it is a floor, not a
      // price. A flat rule that names no equipment (opening, winterization)
      // has no add terms and stays exact, as it always was.
      const rates = (cfg?.add ?? []).map((t) => Number(t?.rate) || 0);
      const amount = money(base + (rates.length ? Math.min(...rates) : 0));
      return amount > 0 ? { amount, unit: null, from: rates.length > 0 } : null;
    }
    case "per_section": {
      // The unit is whatever the service actually counts (pier sections,
      // boat lifts, PWC lifts) — band_pricing.count_field names it.
      const cf = cfg?.count_field ?? "pier_sections";
      // THE SECOND NOUN TABLE, and the only customer-facing one — this renders
      // on /lakes/[slug], on the open internet. The fallback is "per pier
      // section", so a service counting anything unlisted advertises itself in
      // the wrong unit, publicly, with no error anywhere. Its twin is
      // unitNounFor in vendor/rates-helpers.ts; widen them together.
      const label =
        cf === "boat_lifts" ? "per lift" :
        cf === "pwc_lifts" ? "per PWC lift" :
        cf === "jet_skis" ? "per jet ski" :
        cf === "panes" ? "per pane" :
        cf === "lots" ? "per lot" : "per pier section";
      // `serviceApplies` refuses a counted service at zero, and priceService
      // floors the count at min_count — so ONE unit (or min_count of them) is
      // the smallest job that exists.
      const minCount = Math.max(1, Number(cfg?.min_count ?? 0) || 0);
      const amount = money(base + unit * minCount);
      const isOneUnit = base === 0 && minCount === 1 && unit > 0;
      return amount > 0 ? { amount, unit: isOneUnit ? label : null, from: unit > 0 } : null;
    }
    case "per_foot":
    case "seasonal_plus_perdiem": {
      // base + unit × boat feet. A foot is the smallest measure the rule can
      // bill, so base + one foot is a true floor — and with no base (every
      // seeded boat service today) the floor IS the per-foot rate, which is
      // the honest, useful string.
      const label = rule.pricing_model === "per_foot" ? "per boat foot" : "per boat foot / season";
      const amount = money(base + unit);
      return amount > 0 ? { amount, unit: base === 0 && unit > 0 ? label : null, from: unit > 0 } : null;
    }
    case "band": {
      // priceService reads cfg[small|medium|large] and falls back to `base`
      // for a band the rule does not carry — so a missing band is a real,
      // billable price too, and the floor has to consider it.
      const keys = ["small", "medium", "large"] as const;
      const present = keys.map((k) => Number(cfg?.[k]) || 0).filter((n) => n > 0);
      const anyMissing = keys.some((k) => !(Number(cfg?.[k]) > 0));
      const vals = anyMissing && base > 0 ? [...present, base] : present;
      return vals.length ? { amount: money(Math.min(...vals)), unit: null, from: true } : null;
    }
    case "per_sqft_band": {
      const tiers = cfg?.tiers ?? [];
      const vals = tiers.map((t) => Number(t.price) || 0).filter((n) => n > 0);
      // No catch-all tier (max: null) means a big house falls through to
      // `base` — same shape as a missing band key.
      if (!tiers.some((t) => t.max == null) && base > 0) vals.push(base);
      return vals.length ? { amount: money(Math.min(...vals)), unit: null, from: true } : null;
    }
    default:
      return null;
  }
}

/** "Big Long Lake" → "big-long-lake" (must match the SQL backfill exactly). */
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
