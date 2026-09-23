import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE BOOKING DOOR PRICES BEFORE IT DISPATCHES, AND UNDER 0174 THAT IS
 * BACKWARDS.
 *
 * `createBookingBatch` computes `standardPrice`, refuses a $0, writes the row
 * with that number and only then asks a crew. On a crew-priced service there
 * IS no price at that point and there cannot be one — the crew's own card is
 * the quote, and no crew has been picked. So the order inverts: book the row
 * with NO price, dispatch, and take the number from the decision.
 *
 * What that opens up, and what this file pins:
 *
 *  1. A $0 PRICE ON A REAL VISIT. `jobs.customer_price` is nullable, and the
 *     difference between null and 0 is the difference between "we'll confirm
 *     this" and "this is free". A 0 would reach the invoice writer, the
 *     ledger, and the ops board as a price.
 *  2. AN EMAIL THAT PRINTS IT. The confirmation says "Your price: $X" and the
 *     batch version prints a bold TOTAL. Both are built from the same list
 *     that now carries nulls, and `sum + null` is silently `sum` — a partial
 *     figure presented as the total, in bold, in an email the customer keeps.
 *  3. SAME-DAY. The rush premium is a percentage OF THE MENU PRICE, and a
 *     rush job never auto-dispatches — it is born on the claim board, where
 *     the crew's take-home is computed against the customer's number. On a
 *     crew-priced job that number would not exist yet.
 *  4. THE PARK. 0174's CHECK stops a `park_only` service being crew-priced,
 *     but nothing stops a park's grounds booking an ordinary one — and a
 *     stranger's card must never quote work a park negotiated its own rate
 *     for. Park rates never combine.
 *
 * Scanned rather than executed, for the same reason the two sibling scans
 * beside it are: `createBookingBatch` is a server action needing a session, a
 * profile, a live service, a season, a calendar and an assignment engine. The
 * behaviour BEHIND this door — the five money columns and the swap guard — is
 * driven for real in the-crew-sets-the-price.test.ts.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Comments stripped, so prose ABOUT a rule can never satisfy a scan FOR it. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const src = strip(read("./actions.ts"));

/** The confirmation email body, bounded — never the SMS above it. */
const emailBody = (() => {
  const i = src.indexOf("to: me.email,");
  return i < 0 ? "" : src.slice(i, i + 4000);
})();

describe("the scanner is reading the booking door", () => {
  it("found createBookingBatch, its insert and its confirmation email", () => {
    expect(src, "createBookingBatch is gone or renamed").toMatch(/createBookingBatch/);
    expect(src, "the job insert was not found").toMatch(/\.from\("jobs"\)\s*\.insert\(\{/);
    expect(emailBody.length, "the confirmation email body was not found").toBeGreaterThan(500);
  });
});

describe("a crew-priced service is booked unpriced, then priced by the crew", () => {
  it("asks the database whether the crew sets this price", () => {
    expect(src, "crew_priced is never selected — this door cannot tell the two models apart")
      .toMatch(/select\("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands, is_water_work, daily_capacity, frequency_options, kind, active, needs_pickup_spot, needs_release, crew_priced"\)/);
  });

  it("A PARK'S GROUNDS IS NEVER CREW-PRICED — the fence is in the flag itself", () => {
    // Not a second `if` somewhere downstream that a later edit can forget.
    // One expression decides the whole path, so a park falls through to
    // withParkRate and the honest "set what you pay for it" refusal.
    expect(src).toMatch(/const crewPriced = service\.crew_priced === true && !profile\.groundsForParkId;/);
  });

  it("writes NULL, not 0, when nobody has quoted the visit yet", () => {
    expect(src).toMatch(/let price: number \| null = crewPriced \? null :/);
    expect(src).toMatch(/customer_price: price,/);
  });

  it("the $0 refusal still fires on the menu path, and is not applied to a price that does not exist yet", () => {
    // The refusal's sentence ("your profile shows none of the equipment it
    // covers") is a confident statement about somebody's setup. On the
    // crew-priced path nothing has been priced at this point, so firing it
    // here would accuse a customer whose profile is fine.
    expect(src).toMatch(/if \(!crewPriced && standardPrice <= 0\)/);
    expect(src).toMatch(/prices to \$0 for your place — your profile shows none of the equipment it covers/);
  });

  it("the crew-priced twin of that refusal fires after dispatch, on the cause it can actually see", () => {
    // pricedToZero is true only when eligible crews HAVE cards and every one
    // of them prices this property at nothing — a wait that can never end.
    // Not to be confused with "no crew has set a rate yet", which is honest
    // waitlist demand and keeps the row.
    expect(src).toMatch(/if \(outcome\.pricedToZero\)/);
    const i = src.indexOf("outcome.pricedToZero");
    const after = src.slice(i, i + 600);
    expect(after, "the phantom row is left behind").toMatch(/\.delete\(\)\.eq\("id", inserted\.id\)/);
  });

  it("takes the price from the decision rather than computing a second one", () => {
    // A second computation is a second chance to disagree with the row that
    // was just written, and the row is what gets billed.
    expect(src).toMatch(/if \(crewPriced && outcome\.assigned && outcome\.customerPrice != null\)/);
    expect(src).toMatch(/price = outcome\.customerPrice;/);
  });

  it("the all_full_or_blocked delete path is untouched", () => {
    // Separated from no_routable_crew last week; that fix is load-bearing.
    expect(src).toMatch(/outcome\.decision\.reasonNoFit === "all_full_or_blocked"/);
    expect(src).toMatch(/That day just filled up — pick another date\./);
  });
});

describe("same-day is refused for a service we cannot price in time", () => {
  it("rush days are moved into `refused`, with the real reason", () => {
    expect(src).toMatch(/const bookable = plan\.filter\(\(p\) => p\.ok && !\(crewPriced && p\.isRush\)\);/);
    expect(src).toMatch(/the crew who takes it sets the price, so we can't confirm a number before the day starts/);
  });

  it("names the service, so the sentence is about the thing they tapped", () => {
    const i = src.indexOf("isn't available same-day");
    expect(src.slice(Math.max(0, i - 120), i)).toMatch(/\$\{service\.name\}/);
  });
});

describe("the confirmation never prints a price nobody has quoted", () => {
  it("guards the solo price line and says what is actually true instead", () => {
    expect(emailBody).toMatch(/\$\{only\.price != null/);
    expect(emailBody).toMatch(/We'll confirm your price as soon as a crew picks this up/);
  });

  it("never interpolates a price without first testing it for null", () => {
    // The specific failure this catches is an un-guarded `only.price` or
    // `b.price` reaching toLocaleString — which on a null throws, and on a 0
    // would print "$0" to somebody who is going to be charged.
    for (const m of emailBody.matchAll(/(only|b)\.price\.toLocaleString\(\)/g)) {
      const before = emailBody.slice(Math.max(0, (m.index ?? 0) - 260), m.index);
      expect(before, `an unguarded ${m[0]} in the confirmation email`).toMatch(/price != null|price == null/);
    }
  });

  it("does not add up a list with holes in it, and does not call a partial figure a total", () => {
    // `sum + null` is `sum`. The old reduce would have presented the priced
    // visits' subtotal as "Total across 3 visits", in bold.
    expect(src).toMatch(/const pricedVisits = booked\.filter\(\(b\) => b\.price != null\)/);
    expect(src).toMatch(/const total = pricedVisits\.reduce\(/);
    expect(src, "the old reduce over every visit is still here").not.toMatch(/booked\.reduce\(\(sum, b\) => sum \+ b\.price, 0\)/);
    expect(emailBody).toMatch(/\$\{anyUnpriced/);
  });

  it("the batch list names the unpriced visits rather than showing them at $0", () => {
    expect(emailBody).toMatch(/b\.price == null \? "priced by the crew who takes it"/);
  });

  it("the same-day SMS offer is never sent without a number to offer", () => {
    // rushOfferLine's whole sentence IS the price. Unreachable today because
    // same-day is refused above; this is the branch that keeps it unreachable.
    expect(src).toMatch(/only\.isRush && only\.price != null/);
  });
});

describe("Autopilot cannot lock a price that does not exist", () => {
  const auto = strip(read("./autopilot-actions.ts"));

  it("refuses a crew-priced service, and says why", () => {
    expect(auto, "crew_priced is never selected on the enrollment path")
      .toMatch(/select\("id, name, pricing_model, base, unit_rate, band_pricing, active, crew_priced"\)/);
    expect(auto).toMatch(/if \(svc\.crew_priced === true && !grounds\)/);
    expect(auto).toMatch(/the crew who takes it sets its price, so there's no price to lock in/);
  });

  it("refuses BEFORE it prices, so no figure is ever frozen onto the enrollment", () => {
    expect(auto.indexOf("svc.crew_priced === true")).toBeLessThan(auto.indexOf("const locked = priceService("));
  });
});
