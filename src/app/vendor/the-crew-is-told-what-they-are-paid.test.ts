import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRateForm,
  crewPricedRateLines,
  crewPricedNote,
  feePctLabel,
  quoteAndPayoutSentence,
  type RateService,
} from "./rates-helpers";
import { payoutFeeLine, platformFeeSummary, type EarningRow } from "./earnings-helpers";
import { crewPayout, type PlatformFee } from "@/lib/platform-fee";

/**
 * THE SILENT DEDUCTION IS THE BUG THIS FILE EXISTS TO PREVENT.
 *
 * Today a crew types $100 on their rate card and is paid $100. On a
 * `crew_priced` service (0174) they type $100 and are paid $88 — same column,
 * same screen, opposite meaning. A contractor who learns about a 12% deduction
 * from their first payout has been cheated by a screen, whatever the contract
 * says, so the sentences are pinned WORD FOR WORD here.
 *
 * The mirror half matters just as much: on an ordinary service there is no fee,
 * and a screen that mentions one is lying in the other direction. Every test
 * below has both halves.
 */

const FEE: PlatformFee = { customerPct: 0.12, crewPct: 0.12 };

/** The owner's own worked example: a crew prices a 2-acre yard at $50. */
const FLAT_SERVICE = (crewPriced: boolean): RateService => ({
  pricing_model: "flat",
  band_pricing: null,
  crew_priced: crewPriced,
});

describe("the two sentences a crew must read before they type a number", () => {
  it("names the quote, the payout and the percentage, in that order", () => {
    expect(quoteAndPayoutSentence(50, FEE)).toBe(
      "You quote $50.00. You're paid $44.00 — LakeLife's fee is 12%.",
    );
  });

  it("carries the unit through so a per-foot card is not read as a whole job", () => {
    expect(quoteAndPayoutSentence(12, FEE, "foot")).toBe(
      "You quote $12.00 per foot. You're paid $10.56 per foot — LakeLife's fee is 12%.",
    );
  });

  it("says nothing at all about a number nobody has typed", () => {
    // $0 is this platform's word for unpriced. "You quote $0.00, you're paid
    // $0.00" is a true sentence that reads as a broken screen.
    expect(quoteAndPayoutSentence(null, FEE)).toBeNull();
    expect(quoteAndPayoutSentence(0, FEE)).toBeNull();
    expect(quoteAndPayoutSentence(-5, FEE)).toBeNull();
  });

  it("carries cents, because the published percentage is checkable", () => {
    // $416 at 12/12 is $366.08 — not $366. A crew with a calculator who is told
    // "12%" and paid a rounded number learns the stated fee is not the fee.
    expect(quoteAndPayoutSentence(416, FEE)).toContain("$366.08");
  });

  it("prints a fractional dial honestly", () => {
    expect(feePctLabel(0.125)).toBe("12.5%");
    expect(feePctLabel(0.12)).toBe("12%");
    expect(feePctLabel(0)).toBe("0%");
  });

  it("states the rule before any number is saved", () => {
    expect(crewPricedNote(FEE)).toBe(
      "You set the price for this one — what you type is your QUOTE, not your take-home. " +
        "LakeLife's fee is 12% of it. For example, quote $100.00 and you're paid $88.00.",
    );
  });

  it("never uses the word margin — that is an ops word", () => {
    const everything = [
      quoteAndPayoutSentence(50, FEE),
      quoteAndPayoutSentence(12, FEE, "foot"),
      crewPricedNote(FEE),
    ].join(" ");
    expect(everything.toLowerCase()).not.toContain("margin");
  });
});

describe("the rate form only changes meaning when the SERVICE says so", () => {
  it("relabels away from take-home and attaches both numbers", () => {
    const form = buildRateForm(FLAT_SERVICE(true), { base: 50, unit_rate: null, band_pricing: null }, FEE);
    expect(form.crewPriced).toBe(true);
    // "Your flat take-home" is now false — they are paid $44, not $50.
    expect(form.fields[0].label).toBe("Your flat quote");
    expect(form.fields[0].value).toBe(50);
    expect(form.fields[0].payout).toBe(44);
    expect(form.fields[0].feeSentence).toBe(
      "You quote $50.00. You're paid $44.00 — LakeLife's fee is 12%.",
    );
  });

  it("is byte-for-byte today's form when the service is not crew-priced", () => {
    const form = buildRateForm(FLAT_SERVICE(false), { base: 50, unit_rate: null, band_pricing: null }, FEE);
    expect(form.crewPriced).toBe(false);
    expect(form.feeNote).toBeNull();
    expect(form.fields[0].label).toBe("Your flat take-home");
    expect(form.fields[0].payout).toBeUndefined();
    expect(form.fields[0].feeSentence).toBeUndefined();
  });

  it("needs BOTH halves — a fee alone, or a flag alone, switches nothing on", () => {
    // The flag without a fee: the caller has no dials to quote.
    const noFee = buildRateForm(FLAT_SERVICE(true), { base: 50, unit_rate: null, band_pricing: null }, null);
    expect(noFee.crewPriced).toBe(false);
    expect(noFee.feeNote).toBeNull();
    // The fee without the flag: an ordinary service, unchanged.
    const noFlag = buildRateForm(FLAT_SERVICE(false), { base: 50, unit_rate: null, band_pricing: null }, FEE);
    expect(noFlag.feeNote).toBeNull();
  });

  it("quotes a per-foot card per foot", () => {
    const form = buildRateForm(
      { pricing_model: "per_foot", band_pricing: null, crew_priced: true },
      { base: 0, unit_rate: 12, band_pricing: null },
      FEE,
    );
    const unit = form.fields.find((f) => f.kind === "unit")!;
    expect(unit.label).toBe("Your quote per foot");
    expect(unit.feeSentence).toContain("per foot");
    // The optional base charge is a whole-job number, not a per-foot one.
    const base = form.fields.find((f) => f.kind === "base")!;
    expect(base.feeSentence).toBeNull(); // nothing saved there
  });

  it("carries the note even when the crew has saved nothing yet", () => {
    const form = buildRateForm(FLAT_SERVICE(true), null, FEE);
    expect(form.feeNote).toContain("your QUOTE, not your take-home");
    expect(form.fields[0].feeSentence).toBeNull();
  });
});

describe("what the rates PAGE prints", () => {
  const priced = (crewPriced: boolean, base: number) => ({
    name: crewPriced ? "Lawn mowing & trim" : "Housekeeping",
    form: buildRateForm(FLAT_SERVICE(crewPriced), { base, unit_rate: null, band_pricing: null }, FEE),
  });

  it("lists the crew-priced service with its note and its sentence", () => {
    const lines = crewPricedRateLines([priced(true, 50), priced(false, 200)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("Lawn mowing & trim");
    expect(lines[0].sentences).toEqual([
      "You quote $50.00. You're paid $44.00 — LakeLife's fee is 12%.",
    ]);
  });

  it("renders NOTHING for a crew with no crew-priced work — which is every crew today", () => {
    // The page guards on `feeLines.length > 0`, so [] means the block does not
    // appear at all and an ordinary crew's screen is unchanged.
    expect(crewPricedRateLines([priced(false, 200)])).toEqual([]);
  });
});

describe("what a crew is told about money they have already earned", () => {
  const row = (over: Partial<EarningRow>): EarningRow => ({
    id: "p1", jobDate: "2027-01-14", service: "Lawn mowing & trim",
    address: null, amount: 44, status: "released", ...over,
  });

  it("names the fee off the job's OWN frozen numbers", () => {
    expect(payoutFeeLine(row({ crewQuote: 50, feeCrewPct: 0.12 }))).toBe(
      "Your quote was $50.00 — LakeLife's fee 12%.",
    );
  });

  it("says nothing on an ordinary job, where they were paid what they typed", () => {
    expect(payoutFeeLine(row({}))).toBeNull();
    expect(payoutFeeLine(row({ amount: 100 }))).toBeNull();
  });

  it("refuses to guess a percentage from a quote with none frozen on it", () => {
    // A percentage is a claim about what was taken. We either know it or we
    // do not — today's dial is not evidence about a job billed months ago.
    expect(payoutFeeLine(row({ crewQuote: 50, feeCrewPct: null }))).toBeNull();
  });

  it("names the fee once above a statement, and only when there is one", () => {
    expect(platformFeeSummary([row({})])).toBeNull();
    expect(platformFeeSummary([row({ crewQuote: 50, feeCrewPct: 0.12 })])).toContain(
      "your quote less LakeLife's 12% fee",
    );
  });

  it("will not pick one percentage for jobs charged at two", () => {
    const mixed = platformFeeSummary([
      row({ id: "a", crewQuote: 50, feeCrewPct: 0.12 }),
      row({ id: "b", crewQuote: 50, feeCrewPct: 0.1 }),
    ]);
    expect(mixed).toContain("shown on each one");
    expect(mixed).not.toContain("12%");
  });
});

/**
 * The claim board and the claim action need a live Postgres, a property, a
 * rate card and a job to exercise, so these are source scans — and each one
 * first proves it is looking at real code, per the house rule that a scanner
 * which finds nothing passes everything.
 */
const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the claim board pays the payout, not the quote", () => {
  it("the scan is looking at real code", () => {
    expect(code("app/vendor/open-data.ts").length).toBeGreaterThan(4000);
    expect(code("app/vendor/open-actions.ts").length).toBeGreaterThan(4000);
  });

  it("the board asks the service whether it is crew-priced", () => {
    const src = code("app/vendor/open-data.ts");
    expect(src).toMatch(/services\(name, pricing_model, est_minutes, takes_custody, crew_priced\)/);
    expect(src).toMatch(/svc\?\.crew_priced/);
  });

  it("takeHome is run through crewPayout before it is shown", () => {
    const src = code("app/vendor/open-data.ts");
    expect(src).toMatch(/takeHome = quote != null \? crewPayout\(quote, fee\) : null/);
  });

  it("the board and the action BOTH hand the fee to canClaim", () => {
    // A rule in one doorway of three is not a rule: the board is a courtesy,
    // the action is the boundary, and the floor must be skipped on both.
    expect(code("app/vendor/open-data.ts")).toMatch(/platformFee: fee,/);
    expect(code("app/vendor/open-actions.ts")).toMatch(/platformFee: fee,/);
  });

  it("the claim writes the PAYOUT to vendor_cost, never the quote", () => {
    const src = code("app/vendor/open-actions.ts");
    // payouts.amount = jobs.vendor_cost. Writing the quote here overpays by
    // the crew-side fee on every crew-priced job, forever.
    expect(src).toMatch(/const rate = fee \? crewPayout\(quote, fee\) : quote;/);
    expect(src).toMatch(/vendor_cost: rate/);
  });

  it("the claim freezes all three of the job's own money facts together", () => {
    const src = code("app/vendor/open-actions.ts");
    expect(src).toMatch(/crew_quote: quote/);
    expect(src).toMatch(/fee_customer_pct: fee\.customerPct/);
    expect(src).toMatch(/fee_crew_pct: fee\.crewPct/);
  });

  it("releasing a claim puts the price back too", () => {
    const src = code("app/vendor/open-actions.ts");
    // Both release paths. A released job carrying a price and a quote from a
    // crew who does not have it would make the next crew's write illegal.
    const releases = src.match(/status: "requested", \.\.\.unfreeze/g) ?? [];
    expect(releases).toHaveLength(2);
    expect(src).toMatch(/crew_quote: null, fee_customer_pct: null, fee_crew_pct: null/);
  });

  it("an unpriced job can actually BE claimed — the race key knows null from 0", () => {
    const src = code("app/vendor/open-actions.ts");
    // A crew-priced job is BORN with customer_price NULL (book/actions.ts
    // writes null, never 0, so no invoice or ledger reader mistakes "nobody
    // has quoted this" for "free"). The guarded UPDATE used to key on
    // `.eq("customer_price", priceAtRead)` with priceAtRead coerced to 0 —
    // and `= 0` never matches a NULL row in SQL, so every claim on the one
    // doorway that PRICES these jobs would have failed with "That job was
    // already taken", forever.
    expect(src, "the claim must notice an unpriced job")
      .toMatch(/const unpriced = job\.customer_price == null;/);
    expect(src, "and key its race on IS NULL rather than = 0")
      .toMatch(/claimQuery\.is\("customer_price", null\)/);
    expect(src, "a priced job still keys on the figure it was computed against")
      .toMatch(/claimQuery\.eq\("customer_price", priceAtRead\)/);
  });

  it("releasing a crew-priced claim puts the price back to NULL, not 0", () => {
    const src = code("app/vendor/open-actions.ts");
    // THREE DOORWAYS, ONE CONVENTION. book/actions.ts writes null at birth and
    // autoAssignJob's release writes null; a 0 here would put a PRICE of zero
    // on a job nobody has quoted — free to the invoice writer, "$0.00" on the
    // ops board — and the next claim's IS NULL race key would miss it.
    expect(src).toMatch(/customer_price: null, crew_quote: null, fee_customer_pct: null, fee_crew_pct: null/);
    expect(src, "a released job must never carry a price of zero")
      .not.toMatch(/customer_price: 0, crew_quote: null/);
    // The other two doorways, so this convention cannot drift apart again.
    expect(code("app/book/actions.ts")).toMatch(/customer_price: price,/);
    expect(code("app/book/dispatch.ts"))
      .toMatch(/crew_quote: null, fee_customer_pct: null, fee_crew_pct: null, customer_price: null/);
  });

  it("no crew-readable surface gains a customer price or a margin", () => {
    // RULE 1's surviving half. A crew may see their own quote and their own
    // payout; customer_price stays server-side only on this path.
    const src = code("app/vendor/open-data.ts");
    const openJob = src.match(/export interface OpenJob \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(openJob.length, "OpenJob not found — this scan is measuring nothing").toBeGreaterThan(300);
    expect(openJob).not.toMatch(/customerPrice|customer_price|margin/);
  });

  it("the arithmetic the board shows is the arithmetic platform-fee.ts does", () => {
    // Not a recomputation of the formula — the real function, on the owner's
    // own worked example, tied to the number the migration's header states.
    expect(crewPayout(50, FEE)).toBe(44);
  });
});
