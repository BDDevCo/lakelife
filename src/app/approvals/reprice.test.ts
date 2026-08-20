import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { rushPrice, fillInRate } from "@/lib/rush";

/**
 * APPROVING "THERE IS MORE WORK HERE" USED TO LOWER THE BILL.
 *
 * approveFlag reprices every open job on the property. It wrote the bare menu
 * price over each one, and two kinds of job carry a price that is deliberately
 * NOT the menu:
 *
 *   A SAME-DAY RUSH job — menu + same_day_surcharge_pct, confirmed to the
 *   customer at that number. A percentage, so it re-derives at the new size.
 *
 *   A SCARCITY-BUMPED job — the customer tapped Accept on a specific uplift so
 *   the cheapest crew could clear the margin floor. acceptScarcityOffer writes
 *   it straight into customer_price and records the uplift nowhere.
 *
 * And on the crew's side, a GAP CLAIM is below the card rate by definition —
 * canClaim refused the card rate, and the gap engine offered a lower take-home
 * the crew accepted. Re-deriving from the card pays them more than they agreed
 * and drops margin under the floor dispatch enforces.
 */

// The real seeded service: per_section, base 220, unit_rate 48 (0047).
const PIER: ServiceRule = {
  name: "Pier install / removal",
  pricing_model: "per_section",
  base: 220,
  unit_rate: 48,
  band_pricing: null,
};
const profile = (sections: number) => ({ pier_sections: sections }) as never;

describe("the arithmetic the fix has to preserve", () => {
  it("menu at 8 and 9 sections", () => {
    expect(priceService(PIER, profile(8))).toBe(604);
    expect(priceService(PIER, profile(9))).toBe(652);
  });

  it("a same-day rush job is menu + 25%, rounded up", () => {
    expect(rushPrice(604, 0.25)).toBe(755);
    expect(rushPrice(652, 0.25)).toBe(815);
  });

  it("so the old behaviour dropped the bill on MORE work", () => {
    // 755 agreed -> 652 written. $103 below what the customer confirmed, and
    // $163 below the correct figure for the bigger job.
    const agreed = rushPrice(priceService(PIER, profile(8)), 0.25);
    const oldWrote = priceService(PIER, profile(9));
    const correct = rushPrice(priceService(PIER, profile(9)), 0.25);
    expect(agreed).toBe(755);
    expect(oldWrote).toBe(652);
    expect(correct).toBe(815);
    expect(oldWrote).toBeLessThan(agreed);
  });

  it("a fill-in take-home is the card rate less the discount", () => {
    // Card 52/section. At 9 sections that is 468; less 15% = 397.80.
    const card = priceService({ ...PIER, base: 0, unit_rate: 52 }, profile(9));
    expect(card).toBe(468);
    expect(fillInRate(card, 0.15)).toBeCloseTo(397.8, 2);
  });
});

describe("approveFlag re-derives what it can and holds what it cannot", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8",
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads the columns that say a job's money is not the menu", () => {
    // Without is_rush and gap_claim the loop cannot tell an agreed number from
    // a stale one — which is why it overwrote both.
    expect(code).toMatch(/\.select\("id, service_id, vendor_id, vendor_cost, customer_price, is_rush, gap_claim"\)/);
  });

  it("re-applies the rush premium instead of writing the menu price", () => {
    expect(code).toMatch(/const price = isRush \? rushPrice\(menu, rushSettings\.sameDaySurchargePct\) : menu;/);
  });

  it("holds a job priced above menu for a reason it cannot re-derive", () => {
    expect(code).toMatch(/if \(!isRush && agreed > menu\) \{/);
    expect(code).toMatch(/heldAgreements \+= 1;/);
  });

  it("holds the WHOLE job, not just its price", () => {
    // A half-updated job — new minutes, old price — is worse than an untouched
    // one, so the guard continues rather than falling through.
    const at = code.indexOf("if (!isRush && agreed > menu)");
    expect(code.slice(at, at + 120)).toMatch(/continue;/);
  });

  it("never re-derives a gap claim from the rate card", () => {
    expect(code).toMatch(/if \(vr && !isGapClaim\)/);
  });

  it("mirrors the claim's fill-in discount for a rush job", () => {
    expect(code).toMatch(/isRush \? fillInRate\(card, rushSettings\.sameDayFillDiscountPct\) : card/);
  });

  it("and tells the owner when a visit was left alone", () => {
    const ui = readFileSync(
      fileURLToPath(new URL("../../components/ApprovalCard.tsx", import.meta.url)), "utf8",
    );
    expect(ui).toMatch(/res\.heldAgreements/);
    expect(ui).toMatch(/left (it|them) exactly as (it|they) (was|were)/);
  });
});
