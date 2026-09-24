/**
 * CAN A CREW'S OWN RATE CARD ACTUALLY PRICE THIS SERVICE?
 *
 * 0174 added `services.crew_priced` and switched nothing on. Flipping it moves
 * one service off LakeLife's menu and onto the crews' cards: the buyer sees
 * each crew's own number on the offers screen, pays `quote x (1 + customer
 * fee)`, and the crew is paid `quote x (1 - crew fee)`. Work already booked is
 * untouched — 0174 freezes the quote and both percentages onto the job.
 *
 * TWO OF THE LIVE SERVICES CANNOT DO THAT ARITHMETIC, and flipping one of them
 * would not make it crew-priced, it would make it wrongly priced. This file is
 * the test, and it is DERIVED FROM THE SERVICE'S OWN ROW — never a list of
 * names — so the next service with the same shape is refused without anybody
 * remembering to add it. (There is already such a service waiting: the
 * inactive `Snow removal — drive & walks` is a second `band` row.)
 *
 * ========================= HOW THE VERDICT IS DERIVED =====================
 *
 * A crew-priced job's price is `priceService(rule, profile)` where `rule` is
 * built in `buildCandidates` (src/app/book/dispatch.ts) out of the CREW's
 * stored row:
 *
 *     base:         vendor_rates.base
 *     unit_rate:    vendor_rates.unit_rate
 *     band_pricing: vendor_rates.band_pricing
 *
 * and that stored row is whatever `computeRateRow` (src/app/vendor/
 * rates-helpers.ts) emitted when the crew saved their card. So the question
 * "can a crew's card price this?" is exactly: does `computeRateRow` carry
 * through every term `priceService` needs?
 *
 *   1. TERMS THE CARD DROPS. `priceService` adds `band_pricing.add[]` (rate x
 *      a counted field) and `band_pricing.per_engine_hp_tiers[]` on TOP of the
 *      model price. `computeRateRow` emits `count_field`/`min_count`
 *      (per_section), `band_field` + small/medium/large (band) and `tiers`
 *      (per_sqft_band) — and NOTHING ELSE, on any branch. Neither additive
 *      term survives on any model. `Water toy prep & storage` is `flat` with
 *      `{add:[{rate:60,field:toy_lifts},{rate:15,field:toys_count}]}`, so a
 *      crew's card would quote its flat number for a shoreline with two lifts
 *      and six toys exactly as for one with none.
 *
 *      Judged on the term being DECLARED, not on its rate today: a $0 term is
 *      a term somebody edits next season, and the card would still drop it.
 *
 *      NOT INCLUDED, AND THIS WAS CHECKED RATHER THAN ASSUMED: the transport
 *      keys (`included_miles`, `per_mile_beyond`) are also absent from every
 *      `computeRateRow` branch, but they are not dropped — `createBooking`
 *      only adds a tow `if (!crewPriced && billsByDistance(priceRule))`,
 *      because on a crew-priced service the crew is the one driving and the
 *      tow is inside their own quote. A deliberate skip is not a lost term.
 *
 *   2. A PRICE CHOSEN BY A SIZE WORD. The `band` model prices off `bandValue`,
 *      which reads a categorical field — `lawn_band` or `drive_band`, the only
 *      two `BandField` values — off the property. Nothing in the product
 *      measures a yard: `CountableField` lists sections, lifts, skis, toys,
 *      beds, baths, panes and lots, and no area at all; "¼–½ acre" exists in
 *      this codebase only as WORDS inside a band label. So a crew cannot say
 *      "$25 an acre" — the owner's own example of what a crew's rate looks
 *      like. All they can do is fill in LakeLife's three buckets, which leaves
 *      LakeLife holding the ladder the price is chosen from.
 *
 *      `Lawn mowing & trim` is the one active band service. This refusal is
 *      the one that ends when a lawn carries a measured size, not when
 *      somebody edits a list.
 *
 *   3. A MODEL THE CARD HAS NO BRANCH FOR. `computeRateRow`'s `default` arm
 *      returns "This service can't be priced yet". Every model in
 *      `PricingModel` has a branch today, so this can only fire for a model
 *      added later — which is the point of having it.
 *
 * PURE ON PURPOSE. No imports beyond types, so the server action, the ops
 * screen and the tests all ask the same function the same question, and the
 * migration's CHECK can mirror it line for line.
 */

import type { PricingModel, PricingParams } from "@/lib/pricing";

/** Why a service cannot be crew-priced. One per verdict — the first that bites. */
export type CrewPricingBlocker =
  /** The price is picked by a size word with no measurement behind it. */
  | "size_word_not_a_measure"
  /** The service's rule declares terms a crew's rate card cannot carry. */
  | "card_drops_terms"
  /** `computeRateRow` has no branch for this pricing model at all. */
  | "no_card_for_this_model";

export interface CrewPricingVerdict {
  /** True = a crew's card can reproduce this service's price. */
  ok: boolean;
  blocker?: CrewPricingBlocker;
  /**
   * The refusal, in the words the ops screen prints. Always names the service
   * and the reason; never "unsupported".
   */
  reason?: string;
  /** The `band_pricing` keys the card would drop, when that is the blocker. */
  droppedTerms?: string[];
}

/** The service row this file judges. Exactly the columns it reads. */
export interface SwitchableService {
  name: string;
  pricing_model: PricingModel | string;
  band_pricing?: PricingParams | null;
}

/**
 * THE MODELS `computeRateRow` CAN BUILD A CARD FOR — one entry per non-default
 * branch of that switch, in its order. If a branch is deleted there, deleting
 * it here is the whole change.
 */
export const MODELS_A_CARD_CAN_PRICE: readonly PricingModel[] = [
  "flat",
  "per_section",
  "per_foot",
  "seasonal_plus_perdiem",
  "band",
  "per_sqft_band",
] as const;

/**
 * THE MODEL THAT PRICES OFF A SIZE WORD. One entry, derived from `bandValue`
 * being the only price selector in `priceService` that reads a categorical
 * field rather than a number. A second such model would be added here and to
 * that function together.
 */
export const MODELS_PRICED_BY_A_SIZE_WORD: readonly PricingModel[] = ["band"] as const;

/**
 * ADDITIVE TERMS `priceService` READS AND `computeRateRow` NEVER EMITS.
 *
 * Both are arrays on `services.band_pricing`. Both ride on top of the model
 * price for EVERY model, so this is not a per-model table — a crew's card
 * loses them whatever the service is.
 */
const TERMS_THE_CARD_DROPS = [
  { key: "add", words: "its per-item add-ons" },
  { key: "per_engine_hp_tiers", words: "its per-engine pricing" },
] as const;

/** A declared term is a non-empty array, whatever the rates inside it are. */
function declares(bp: PricingParams | null | undefined, key: string): boolean {
  const v = (bp ?? {}) as unknown as Record<string, unknown>;
  const arr = v[key];
  return Array.isArray(arr) && arr.length > 0;
}

/**
 * Can a crew's own rate card price this service? Judged on the row's SHAPE —
 * `pricing_model` and `band_pricing` — and never on its name or id.
 */
export function crewCardCanPrice(service: SwitchableService): CrewPricingVerdict {
  const model = service.pricing_model as PricingModel;
  const name = service.name;

  if (!MODELS_A_CARD_CAN_PRICE.includes(model)) {
    return {
      ok: false,
      blocker: "no_card_for_this_model",
      reason:
        `${name} is priced as "${String(service.pricing_model)}", and the crew rate-card builder has no ` +
        `form for that model — a crew could not type a number for it at all. It has to be able to build ` +
        `the card before the crews can set the price.`,
    };
  }

  if (MODELS_PRICED_BY_A_SIZE_WORD.includes(model)) {
    return {
      ok: false,
      blocker: "size_word_not_a_measure",
      reason:
        `${name} is priced by a size word — small, medium or large — and nothing in the product measures ` +
        `the yard. A crew can only fill in our three buckets, so we would still be holding the ladder, ` +
        `and "$25 an acre" has no acreage to multiply. This one opens when a lawn carries a measured size.`,
    };
  }

  const dropped = TERMS_THE_CARD_DROPS.filter((t) => declares(service.band_pricing, t.key));
  if (dropped.length > 0) {
    return {
      ok: false,
      blocker: "card_drops_terms",
      droppedTerms: dropped.map((t) => t.key),
      reason:
        `${name} charges ${dropped.map((t) => t.words).join(" and ")} on top of its base, and a crew's rate ` +
        `card has nowhere to put ${dropped.length > 1 ? "them" : "it"}. Flip this and every crew would quote ` +
        `one flat number whether the property has none of it or a dozen — the same price for a bare shoreline ` +
        `as for a full one.`,
    };
  }

  return { ok: true };
}

/**
 * THE THING A RATE IS CHARGED PER, in words a person reads.
 *
 * `count_field` and an `add[]` term's `field` are both column-ish names —
 * `toy_lifts`, `toys_count`, `pwc_lifts` — and dropping one raw into a price
 * line produced "$60 per toy lifts + $15 per toys count". The plural is what
 * makes it wrong: the sentence says "per ONE of these".
 *
 * Deliberately not a lookup table of the eight `CountableField` values. A
 * table is a list somebody has to remember to extend, and the failure mode
 * when they don't is the raw column name back on the screen. This is shape
 * work on the string itself, so a field added next season reads correctly
 * without anybody touching this file.
 */
function unitNoun(field: string): string {
  const words = String(field)
    .replace(/_/g, " ")
    .replace(/\s*count$/, "") // `toys_count` counts TOYS
    .trim()
    .replace(/s$/, ""); // per ONE of them
  // The one initialism among them; "pwc lift" is not a word anybody reads.
  return words.replace(/\bpwc\b/gi, "PWC");
}

/**
 * WHAT THE MENU CHARGES TODAY, so the thing being switched off is named rather
 * than left as "the menu price". Built from the row's own numbers; it never
 * invents one, and a row with nothing on it says exactly that.
 */
export function menuPriceLine(service: {
  name: string;
  pricing_model: PricingModel | string;
  base?: number | string | null;
  unit_rate?: number | string | null;
  band_pricing?: PricingParams | null;
  park_only?: boolean | null;
}): string | null {
  const base = Number(service.base ?? 0);
  const unit = Number(service.unit_rate ?? 0);
  const bp = service.band_pricing ?? null;
  const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

  // NULL, NOT A SENTENCE. A row with no number is not "charging nothing" and
  // must not be dropped into the middle of another sentence — the caller has
  // to say something different about it, and a string here let it read
  // "Today it charges No menu price — ... — after the flip...".
  const nothing = null;

  switch (service.pricing_model) {
    case "flat": {
      const adds = (bp?.add ?? []).map((t) => `${money(Number(t.rate))} per ${unitNoun(String(t.field))}`);
      if (base <= 0 && adds.length === 0) return nothing;
      return [base > 0 ? `${money(base)} flat` : "no base", ...adds].join(" + ");
    }
    case "per_section": {
      const noun = unitNoun(String(bp?.count_field ?? "pier_sections"));
      if (base <= 0 && unit <= 0) return nothing;
      const head = base > 0 ? `${money(base)} + ` : "";
      // THE FLOOR IS PART OF THE PRICE. `priceService` does
      // `count = max(min_count, count)`, so `Boat lift set / pull` at $495 per
      // boat lift with `min_count: 1` charges $495 for a property with no
      // lifts at all. Naming the rate and hiding the floor understates what
      // the menu actually takes — on the one screen whose job is to name the
      // number being switched off.
      const floor = Number(bp?.min_count ?? 0);
      const tail = floor > 0 ? `, minimum ${floor}` : "";
      return `${head}${money(unit)} per ${noun}${tail}`;
    }
    case "per_foot":
    case "seasonal_plus_perdiem": {
      if (base <= 0 && unit <= 0) return nothing;
      const head = base > 0 ? `${money(base)} + ` : "";
      return `${head}${money(unit)} per boat foot`;
    }
    case "band": {
      const parts = (["small", "medium", "large"] as const)
        .map((k) => (bp && bp[k] != null ? `${k} ${money(Number(bp[k]))}` : null))
        .filter((s): s is string => s !== null);
      return parts.length ? parts.join(" · ") : nothing;
    }
    case "per_sqft_band": {
      const tiers = bp?.tiers ?? [];
      if (!tiers.length) return nothing;
      return tiers
        .map((t) => `${t.max == null ? "above that" : `to ${Number(t.max).toLocaleString("en-US")} sq ft`} ${money(Number(t.price))}`)
        .join(" · ");
    }
    default:
      return nothing;
  }
}

/**
 * WHAT FLIPPING THIS WOULD DO, in the words the screen prints above the
 * switch. Every number here comes from a read the caller made; nothing is
 * derived from the sentence itself.
 *
 * `cardedCrews` and `futureJobs` are `number | null`, and null means THE READ
 * FAILED. A failed count must never read as a confident zero — "no crew has
 * priced it" and "we could not look" point at opposite decisions.
 */
export function flipConsequenceLines(input: {
  serviceName: string;
  /** What the menu charges, or NULL when it charges nothing at all. */
  menuLine: string | null;
  /** True for a service only a park can buy — there is no lake-house menu. */
  parkOnly?: boolean;
  cardedCrews: number | null;
  futureJobs: number | null;
  customerPct: number;
  crewPct: number;
}): string[] {
  const pct = (p: number) => `${Math.round(p * 10_000) / 100}%`;
  const lines: string[] = [];

  if (input.menuLine) {
    lines.push(
      `The menu price stops applying. Today it charges ${input.menuLine} — after the flip there is no ` +
        `LakeLife number for this at all.`,
    );
  } else if (input.parkOnly) {
    // 0115 zeroed the global row on every park_only service: there is no menu
    // price here to switch off, and saying one stops applying would be a lie
    // about the thing he is deciding.
    lines.push(
      `There is no menu price to switch off — every park pays its own number for this one, and a park that ` +
        `has set one keeps paying it.`,
    );
  } else {
    lines.push(
      `There is no menu price on file for this today, so nothing is being switched off — it goes straight ` +
        `from unpriced to priced by whichever crew quotes it.`,
    );
  }
  lines.push(
    `The buyer sees each crew's own price and picks one. They pay that crew's quote plus ${pct(input.customerPct)}; ` +
      `the crew is paid their quote less ${pct(input.crewPct)}.`,
  );

  if (input.cardedCrews === null) {
    lines.push(
      `We couldn't read how many crews have priced this, so there is no way to tell whether anyone could ` +
        `take it. Leave it where it is until that reads.`,
    );
  } else if (input.cardedCrews === 0) {
    lines.push(
      `NO CREW HAS PRICED THIS YET, so the moment you flip it this service has no price and no options — ` +
        `a buyer gets "we're still lining up a crew" instead of a booking. That is a fine thing to do the ` +
        `day before crews onboard; it is not a fine thing to do by accident.`,
    );
  } else {
    // A CARD IS NECESSARY, NOT SUFFICIENT, and the difference is the whole
    // value of the number. Dispatch still asks for unexpired insurance named
    // to the business (0152), this lake in `service_lakes`, the right weekday
    // in `work_days`, room left in the day — and on a package, a rate row for
    // EVERY leg. "N crews would be pickable" is a readiness sentence he would
    // act on, and it is not one this count can make.
    lines.push(
      `${input.cardedCrews} ${input.cardedCrews === 1 ? "crew has" : "crews have"} a rate card for this. ` +
        `A card is what makes a crew pickable at all — each still has to clear insurance, cover this lake, ` +
        `work that day and have room in it. Any crew without a card drops out entirely: there is no price ` +
        `to choose them by.`,
    );
  }

  if (input.futureJobs === null) {
    lines.push(
      `We couldn't read what's already booked for this service, so we can't tell you whether anything is ` +
        `in the diary. Nothing already sold ever reprices — but this line should have named a number.`,
    );
  } else if (input.futureJobs > 0) {
    // TWO SHAPES OF SOLD PRICE, AND THIS SENTENCE USED TO NAME ONLY ONE.
    //
    // "A job keeps the quote and both percentages it was sold under" is true
    // of a job sold at a crew's quote, and says nothing at all about a job
    // sold at the MENU price and still waiting for a crew — which is the
    // shape every booking has today, and the one this switch turns into a
    // crew-priced job overnight. `autoAssignJob` now treats a positive
    // `customer_price` as an agreed price whichever model sold it, and
    // refuses the assignment rather than rewrite it. Both halves are said
    // here because both halves are what "none of them move" rests on.
    lines.push(
      `${input.futureJobs} ${input.futureJobs === 1 ? "job is" : "jobs are"} already booked for this and ` +
        `NONE of them reprice. One sold at a crew's quote keeps that quote and both percentages, frozen ` +
        `onto the job; one sold at the menu price keeps the figure its customer was shown, and a crew ` +
        `whose own number differs is refused rather than allowed to rewrite it. This changes the next ` +
        `booking only.`,
    );
  } else {
    lines.push(`Nothing is booked for this service, so there is no sold work to keep at its old price.`);
  }

  return lines;
}

/**
 * WHICH PARKS ARE PROTECTED ON THIS SERVICE, AND WHICH ARE NOT.
 *
 * 0176 dropped `services_park_is_never_crew_priced` because a park is a
 * customer like any other. What stands in its place is PRECEDENCE, in code:
 * `pricingPathFor` (src/lib/park-rates.ts) answers `park_rate` — never
 * `crew_card` — the moment that park holds its own row for the service,
 * whatever this flag says. So the mow is safe because it HAS a number, not
 * because a fence is standing in front of it.
 *
 * THE HAVEN'S MOW IS THE ONE THAT MUST NOT MOVE: 21 households sign leases on
 * 1 January against a fee the mow sits inside. This sentence is how he can see
 * that on the screen instead of taking it on faith.
 *
 * @param parksWithOwnRate parks holding a `park_service_rates` row for THIS
 *   service. A park with no row is a park a crew's card would price.
 * @param parksThatCouldBuy every park that can buy this service at all.
 *   `null` when either read failed — which must not print as "no park buys
 *   this", because that is the sentence that would make an unprotected mow
 *   look safe.
 */
export function parkPrecedenceLine(input: {
  serviceName: string;
  parksWithOwnRate: string[] | null;
  parksThatCouldBuy: string[] | null;
}): string | null {
  const { parksWithOwnRate: own, parksThatCouldBuy: all } = input;
  if (own === null || all === null) {
    return (
      `We couldn't read which parks hold their own price for this, so we can't tell you which of them a ` +
      `flip would move onto a crew's card. Leave it until that reads.`
    );
  }
  if (all.length === 0) return null; // no park buys this — nothing to say

  const ownSet = new Set(own);
  const exposed = all.filter((p) => !ownSet.has(p));

  const protectedHalf = own.length
    ? `${own.join(", ")} ${own.length === 1 ? "holds its own price" : "hold their own prices"} for this, and a ` +
      `park's own number beats a crew's card — ${own.length === 1 ? "that park keeps" : "those parks keep"} ` +
      `paying exactly what ${own.length === 1 ? "it pays" : "they pay"} today.`
    : null;

  const exposedHalf = exposed.length
    ? `${exposed.join(", ")} ${exposed.length === 1 ? "has no price of its own" : "have no prices of their own"} ` +
      `for this, so after a flip ${exposed.length === 1 ? "it buys" : "they buy"} it from whichever crew quotes ` +
      `it — the same as a lake house.`
    : null;

  return [protectedHalf, exposedHalf].filter(Boolean).join(" ");
}
