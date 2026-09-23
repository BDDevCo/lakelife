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
 *
 * SINCE 0174 THE MEANING OF THE NUMBER THEY TYPE CAN FLIP, and this file is
 * where the screen learns which meaning is in force.
 *
 * On an ordinary service a crew types $100 and is paid $100 — the label "Your
 * flat take-home" is literally true, and nothing below changes for them.
 * On a `crew_priced` service (services.crew_priced) their card IS the price:
 * LakeLife adds a published percentage for the customer and takes a published
 * percentage out of the quote, so they type $100 and are paid $88. Same
 * column, same screen, opposite meaning.
 *
 * So when — and ONLY when — a fee is in force, `buildRateForm` relabels the
 * input away from "take-home" (which would be a lie) and attaches, per field,
 * the two numbers in plain words. The arithmetic is never redone here:
 * `quoteBreakdown` in lib/platform-fee.ts is the single source, and a second
 * copy of a money formula is a bug with a schedule.
 *
 * This is still rule-1 clean. Everything below is the crew's OWN quote and the
 * crew's OWN payout. The customer's price is deliberately NOT computed, named
 * or returned anywhere in this file, even though a crew who knows the
 * published percentage could work it out — that arithmetic is theirs to do,
 * not ours to publish on their screen.
 */

import type { PricingModel, PricingParams } from "@/lib/pricing";
import { quoteBreakdown, type PlatformFee } from "@/lib/platform-fee";
import { formatCurrency } from "./earnings-helpers";

/** Largest per-line take-home we'll accept (guards fat-finger / overflow). */
export const RATE_CAP = 100_000;

/** The service structure a crew prices against (NO customer dollars used). */
export interface RateService {
  pricing_model: PricingModel;
  band_pricing: PricingParams | null;
  /**
   * services.crew_priced (0174). TRUE = the crew's card IS the price and what
   * they type is a QUOTE, not their take-home. Optional, defaulting to the
   * false path, so every existing caller keeps today's behaviour byte for byte.
   */
  crew_priced?: boolean | null;
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
  /**
   * What this number actually PAYS on a crew-priced service — value less the
   * crew-side fee. Null on every ordinary service (where value IS the payout,
   * so a second number would invent a distinction that does not exist) and
   * null when nothing is saved yet.
   */
  payout?: number | null;
  /**
   * The crew's two numbers in plain words, e.g. "You quote $50.00. You're paid
   * $44.00 — LakeLife's fee is 12%." Null unless this service is crew-priced
   * AND this field has a value — a fee sentence on a service that charges no
   * fee would be its own lie.
   */
  feeSentence?: string | null;
}

/** The full render spec for one service's rate row. */
export interface RateForm {
  model: PricingModel;
  unitNoun: string | null; // "pier section", "foot", ... (null for flat/band)
  fields: RateField[];
  /** services.crew_priced — whether the numbers below are quotes or take-home. */
  crewPriced: boolean;
  /**
   * The standing sentence for a crew-priced service, shown whether or not a
   * number is saved yet. Null on an ordinary service: those crews are paid
   * exactly what they type, and naming a fee they do not pay is the mirror of
   * the bug this whole field exists to prevent.
   */
  feeNote: string | null;
}

/**
 * "12%" from 0.12. Two decimals at most, so 0.125 reads "12.5%" rather than
 * "12.500000000000002%" — and never a bare rounded integer, because the whole
 * point of publishing the number is that a crew can check it with a calculator.
 */
export function feePctLabel(pct: number): string {
  if (!Number.isFinite(pct)) return "0%";
  return `${Math.round(pct * 10_000) / 100}%`;
}

/**
 * THE SENTENCE THAT KEEPS A CONTRACTOR FROM BEING SURPRISED BY A DEDUCTION.
 *
 * Both numbers, named, with the percentage spelled out — never a single figure
 * whose meaning depends on knowing which pricing model a service is on. The
 * word "margin" is deliberately absent: that is an ops word for the ops side,
 * and a crew reading it on their own screen learns nothing true.
 *
 * `unitNoun` carries the per-unit ending ("per foot", "per pier section") so a
 * per-foot card does not read as a whole-job number. Returns null for a
 * missing or non-positive quote: there is nothing honest to say about a number
 * nobody has typed, and $0 is this platform's word for unpriced.
 */
export function quoteAndPayoutSentence(
  quote: number | null | undefined,
  fee: PlatformFee,
  unitNoun?: string | null,
): string | null {
  const q = Number(quote);
  if (!Number.isFinite(q) || q <= 0) return null;
  const b = quoteBreakdown(q, fee);
  const per = unitNoun ? ` per ${unitNoun}` : "";
  return (
    `You quote ${formatCurrency(b.crewQuote)}${per}. ` +
    `You're paid ${formatCurrency(b.crewPayout)}${per} — LakeLife's fee is ${feePctLabel(fee.crewPct)}.`
  );
}

/**
 * The standing note for a crew-priced service, for when no number is saved yet
 * (and above the inputs when one is). It states the rule and shows it working
 * on a round hypothetical, clearly labelled as an example — we are not
 * inventing a price for the service, we are demonstrating a percentage.
 */
export function crewPricedNote(fee: PlatformFee): string {
  const example = quoteBreakdown(100, fee);
  return (
    `You set the price for this one — what you type is your QUOTE, not your take-home. ` +
    `LakeLife's fee is ${feePctLabel(fee.crewPct)} of it. ` +
    `For example, quote ${formatCurrency(example.crewQuote)} and you're paid ${formatCurrency(example.crewPayout)}.`
  );
}

/** Human noun for a per-unit rate, from the service's counted field. */
export function unitNounFor(model: PricingModel, countField?: string | null): string {
  if (model === "per_foot") return "foot";
  switch (countField) {
    // A PARK'S LOTS. All three per_section park services count these, and
    // without a case here the label fell to "unit" — which a mowing crew reads
    // as "per visit", because that is how mowing is quoted everywhere. Typing
    // the whole-job number then stores it as a PER-LOT rate: $100 becomes
    // $2,100 at The Haven's 21 lots, the margin floor drops them, and the
    // screen says "Saved." The reverse costs them just as much.
    case "lots":
      return "lot";
    case "panes":
      // "per unit" on a window job reads as "per window" or "per visit"
      // depending on the crew. Same failure the `lots` case above exists for.
      return "pane";
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
 * Decorate a built form with the crew-priced meaning, or leave it exactly as it
 * was. THE WHOLE POINT IS THE `else` BRANCH: with no fee in force this returns
 * the same object today's screen has always rendered, so an ordinary service
 * shows no fee sentence, no relabelling and no second number.
 *
 * When a fee IS in force it does three things and no more:
 *   1. renames the inputs away from "take-home", which is now false
 *   2. attaches each field's own payout and its two-number sentence
 *   3. carries the standing note, so a crew with nothing saved yet still reads
 *      the rule before they type their first number
 */
function withCrewPricing(form: RateForm, service: RateService, fee: PlatformFee | null): RateForm {
  if (!service.crew_priced || !fee) return { ...form, crewPriced: false, feeNote: null };
  const fields = form.fields.map((f) => {
    // A per-unit field is quoted per unit; everything else (a flat price, a
    // base charge, a size band, a sq-ft tier) is a whole-job number.
    const noun = f.kind === "unit" ? form.unitNoun : null;
    const label =
      f.kind === "unit" && noun
        ? `Your quote per ${noun}`
        : f.kind === "base" && form.model === "flat"
          ? "Your flat quote"
          : f.label;
    const q = f.value;
    const paid = q != null && Number.isFinite(q) && q > 0 ? quoteBreakdown(q, fee).crewPayout : null;
    return { ...f, label, payout: paid, feeSentence: quoteAndPayoutSentence(q, fee, noun) };
  });
  return { ...form, fields, crewPriced: true, feeNote: crewPricedNote(fee) };
}

/**
 * Build the render spec for a service's rate row from the SERVICE structure and
 * the crew's existing values. Pure — never reads or returns a customer price.
 *
 * `fee` is optional and defaults to absent, which is today's behaviour byte for
 * byte. It is only ever consulted when the SERVICE says crew_priced: a fee
 * without the flag changes nothing, and the flag without a fee changes nothing,
 * so neither half can switch this on by itself.
 */
export function buildRateForm(
  service: RateService,
  existing: ExistingRate | null,
  fee: PlatformFee | null = null,
): RateForm {
  return withCrewPricing(buildRateFormShape(service, existing), service, fee);
}

/** The structural half, unchanged — inputs, labels and saved values. */
function buildRateFormShape(service: RateService, existing: ExistingRate | null): RateForm {
  const base = existing?.base != null ? Number(existing.base) : null;
  const unit = existing?.unit_rate != null ? Number(existing.unit_rate) : null;
  const bp = existing?.band_pricing ?? null;

  switch (service.pricing_model) {
    case "flat":
      return {
        model: "flat",
        unitNoun: null,
        crewPriced: false,
        feeNote: null,
        fields: [{ key: "base", kind: "base", label: "Your flat take-home", value: base }],
      };

    case "per_section": {
      const noun = unitNounFor("per_section", service.band_pricing?.count_field);
      return {
        model: "per_section",
        unitNoun: noun,
        crewPriced: false,
        feeNote: null,
        fields: [
          { key: "base", kind: "base", label: "Base charge (optional)", value: base },
          { key: "unit_rate", kind: "unit", label: `Your rate per ${noun}`, value: unit },
        ],
      };
    }

    case "per_foot":
    case "seasonal_plus_perdiem": // storage tiers: priced per boat foot, same as per_foot (see lib/pricing.ts)
      return {
        model: service.pricing_model,
        unitNoun: "foot",
        crewPriced: false,
        feeNote: null,
        fields: [
          { key: "base", kind: "base", label: "Base charge (optional)", value: base },
          { key: "unit_rate", kind: "unit", label: "Your rate per foot", value: unit },
        ],
      };

    case "band":
      return {
        model: "band",
        unitNoun: null,
        crewPriced: false,
        feeNote: null,
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
      return { model: "per_sqft_band", unitNoun: null, crewPriced: false, feeNote: null, fields };
    }

    default:
      return { model: service.pricing_model, unitNoun: null, crewPriced: false, feeNote: null, fields: [] };
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
    case "seasonal_plus_perdiem": // storage tiers: same base+per-foot shape as per_foot
      return { ok: true, row: { base: b.value, unit_rate: u.value, band_pricing: null } };

    case "band": {
      const out: PricingParams = {};
      // CARRY THE BAND FIELD THROUGH. This branch rebuilt band_pricing from
      // BAND_KEYS alone, so a crew's own rate override on a band service
      // DROPPED `band_field` — and open-data.ts reads that stored object
      // straight back into priceService. The customer would have been priced
      // off the driveway and the crew's cost off the LAWN: a margin bug with
      // no error on any screen. The per_section branch already carries
      // count_field for exactly this reason.
      const carried = (service.band_pricing as PricingParams | null)?.band_field;
      if (carried) out.band_field = carried;
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
      return { ok: false, error: "This service can't be priced yet — email hello@lakelife.ai and we'll sort it." };
  }
}

/** One crew-priced service, reduced to the sentences a screen should print. */
export interface CrewPricedLines {
  name: string;
  /** The standing rule for this service (always present). */
  note: string;
  /** One "You quote X. You're paid Y" line per saved number (may be empty). */
  sentences: string[];
}

/**
 * THE RATES PAGE'S OWN COPY, as data so it can be pinned by a test.
 *
 * Reduces the crew's rate list to just the crew-priced services and the
 * sentences that must appear for them. Ordinary services are dropped entirely
 * rather than listed with an empty note — a crew paid exactly what they type
 * should read nothing new on this screen, and an "and this one has no fee"
 * line for every other service would bury the one that does.
 *
 * Returns [] when nothing is crew-priced, which is every crew today: the page
 * renders no block at all and reads as it always has.
 */
export function crewPricedRateLines(
  rates: Array<{ name: string; form: RateForm }>,
): CrewPricedLines[] {
  const out: CrewPricedLines[] = [];
  for (const r of rates) {
    if (!r.form.crewPriced || !r.form.feeNote) continue;
    out.push({
      name: r.name,
      note: r.form.feeNote,
      sentences: r.form.fields
        .map((f) => f.feeSentence)
        .filter((x): x is string => typeof x === "string" && x.length > 0),
    });
  }
  return out;
}
