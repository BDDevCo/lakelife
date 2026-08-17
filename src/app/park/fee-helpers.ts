/**
 * RECURRING FEES, AND WHETHER THEY ACTUALLY COVER WHAT THEY CLAIM TO.
 *
 * The owner's structure: one flat grounds fee per lot — an averaged prorated
 * share — covering water, sewer, trash, park lighting and maintenance. A
 * resident pays a number they can predict; the park stops re-splitting twenty
 * shares every time a bill lands.
 *
 * A RESIDENT'S OWN ELECTRICITY IS NOT IN HERE AND NEVER WAS. The electric
 * company meters each lot and bills that household directly; the park is not
 * in the loop. The only power the park pays for is on homes it OWNS, and that
 * is `unit_electric` — the cost of that building, set against its rent rather
 * than spread across everybody's fee.
 *
 * WHICH LEAVES ONE QUESTION WORTH ANSWERING, and it is the whole reason the
 * bills are still recorded: IS THE FEE SET RIGHT? A park charging $50 a lot
 * against $71 of real cost is losing $21 per lot per month — $5,000 a year on
 * twenty lots — and will not find out for a year unless something puts the two
 * numbers side by side. This does that.
 *
 * The comparison is only possible because a fee declares WHAT IT COVERS in the
 * same vocabulary the costs are recorded in. A fee labelled "utilities and
 * stuff" could never be reconciled against anything.
 */

import type { CostCategory } from "./cost-helpers";

export type FeeCadence = "monthly" | "per_stay" | "annual" | "one_time";
export type FeeAppliesTo = "all_lots" | "long_term" | "short_term" | "opt_in";

export interface ParkFee {
  id: string;
  label: string;
  amount: number;
  cadence: FeeCadence;
  appliesTo: FeeAppliesTo;
  covers: CostCategory[];
  active: boolean;
}

/**
 * What a fee may be reconciled against.
 *
 * `unit_electric` is deliberately ABSENT: power for a park-owned home is the
 * cost of that building and belongs against its rent, not spread across every
 * lot's grounds fee. And a lot renter's own electricity never appears at all —
 * the utility meters it and bills them directly.
 */
export const FEE_COVERS: CostCategory[] = [
  "water", "sewer", "trash", "common_electric", "grounds", "other",
];

/** Extra coverage words a fee may claim that are not billable cost categories. */
export const FEE_EXTRA_COVERS = ["maintenance", "snow", "pest", "amenities"] as const;

export const COVER_LABEL: Record<string, string> = {
  water: "Water",
  sewer: "Sewer",
  trash: "Trash",
  common_electric: "Park lighting & common areas",
  grounds: "Grounds & mowing",
  maintenance: "Maintenance",
  snow: "Snow removal",
  pest: "Pest control",
  amenities: "Amenities",
  other: "Other",
};

export const CADENCE_LABEL: Record<FeeCadence, string> = {
  monthly: "a month",
  per_stay: "per stay",
  annual: "a year",
  one_time: "one-off",
};

export const APPLIES_LABEL: Record<FeeAppliesTo, string> = {
  all_lots: "every lot",
  long_term: "lots people live on",
  short_term: "nightly homes",
  opt_in: "only who signs up",
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * How many lots a fee actually lands on.
 *
 * An opt-in fee is counted from its assignments, never from the lot count —
 * assuming everybody has a pet would overstate income by exactly the amount
 * that makes a proforma wrong.
 */
/**
 * How many lots actually pay this fee.
 *
 * COUNTS OCCUPIED LOTS ONLY. A fee is a line on a rent bill, and an empty lot
 * gets no rent bill — so counting live-but-empty lots inflated the "my fee
 * covers my costs" number by exactly the vacancy the park is carrying. Same
 * mistake the cost allocator made in the other direction, on the same screen.
 */
export function payersFor(
  fee: ParkFee,
  counts: { longTerm: number; shortTerm: number; optedIn: number },
): number {
  switch (fee.appliesTo) {
    // "ALL LOTS" MEANS EVERY LOT THAT IS ACTUALLY BILLED A FEE, and the charge
    // run bills a short-term lot NONE (ledger-actions: `fees: rental_mode ===
    // "short_term" ? [] : fees`). Counting them here credited the park income
    // from lots that are never invoiced, on the very screen built to answer
    // "is my fee covering my costs?".
    case "all_lots":   return counts.longTerm;
    case "long_term":  return counts.longTerm;

    // THE SAME RULE THE all_lots CASE ABOVE ALREADY STATES, applied to the two
    // it missed. Both credit income from a bill that is never raised:
    //
    //   short_term — the charge run hands a short-term lot NO fees at all
    //     (ledger-actions.ts:232 and :349, `fees: rental_mode ===
    //     "short_term" ? [] : fees`), so every payer counted here is a lot
    //     that cannot be invoiced for it.
    //   opt_in     — `lot_fee_assignments` has exactly one reader in the whole
    //     codebase and NO writer, and no screen can sign anybody up. The count
    //     is structurally zero, but returning 0 by rule rather than by
    //     accident is what stops it silently coming back if a writer appears
    //     before the biller does (ledger-actions.ts:72 also drops opt_in).
    case "short_term": return 0;
    case "opt_in":     return 0;
  }
}

/** What a fee brings in per month. Only the cadence the biller actually bills. */
export function monthlyIncome(fee: ParkFee, payers: number): number {
  if (!fee.active) return 0;
  const per =
    fee.cadence === "monthly" ? fee.amount
    // ANNUAL WAS CREDITED AT amount/12 AND BILLED AT NOTHING.
    // `buildStatement` (statement-helpers.ts:176) skips every cadence that is
    // not monthly, so a $120-a-year road fee on 19 lots read "$190.00/mo" on
    // the costs screen, folded $190 into the margin he uses to set the rent,
    // and raised $0 across twelve charge runs — $2,280 a year he believed he
    // was collecting. park_fees has no due_month column, so there is nowhere
    // to record when an annual fee even falls due; teaching the biller about
    // it is a real slice of work, not a patch, and until then the money screen
    // must not claim it.
    //
    // A per-stay or one-off fee has no honest monthly figure without knowing
    // turnover, and inventing one would quietly inflate the only number the
    // owner is using to judge whether his fee covers his costs.
    : 0;
  return round2(per * payers);
}

export interface CoverageCheck {
  /** What the fees covering this category bring in, per month. */
  feeIncome: number;
  /** What the park actually spent on it, per month. */
  actualCost: number;
  /** Positive = the fee covers it with room. Negative = the park is short. */
  margin: number;
  /** Categories the fee claims to cover but nothing has been spent on yet. */
  unverified: CostCategory[];
  /** Categories the park pays for that NO fee claims to cover. */
  uncovered: CostCategory[];
}

/**
 * Put the fee income and the real cost side by side.
 *
 * `monthsObserved` matters: three months of bills is $1,140 of water, not
 * $1,140 a month. Getting that wrong would tell him he is losing money at four
 * times the real rate, and a wrong alarm is worse than no alarm.
 */
export function checkCoverage(
  fees: readonly ParkFee[],
  payersByFee: ReadonlyMap<string, number>,
  costs: readonly { category: CostCategory; amountPaid: number }[],
  monthsObserved: number,
): CoverageCheck {
  const live = fees.filter((f) => f.active);

  const claimed = new Set<CostCategory>();
  for (const f of live) for (const c of f.covers) claimed.add(c);

  // Only fees that cover at least one REAL cost category count toward the
  // comparison — a fee purely for amenities has nothing here to be checked
  // against and must not be credited against the water bill.
  const feeIncome = round2(
    live
      .filter((f) => f.covers.some((c) => (FEE_COVERS as string[]).includes(c)))
      .reduce((s, f) => s + monthlyIncome(f, payersByFee.get(f.id) ?? 0), 0),
  );

  const spentBy = new Map<CostCategory, number>();
  for (const c of costs) {
    spentBy.set(c.category, round2((spentBy.get(c.category) ?? 0) + c.amountPaid));
  }

  const months = Math.max(1, monthsObserved);
  const actualCost = round2(
    [...spentBy.entries()]
      .filter(([cat]) => claimed.has(cat))
      .reduce((s, [, amt]) => s + amt, 0) / months,
  );

  return {
    feeIncome,
    actualCost,
    margin: round2(feeIncome - actualCost),
    unverified: [...claimed].filter((c) => !spentBy.has(c)),
    uncovered: [...spentBy.keys()].filter((c) => !claimed.has(c)),
  };
}

/**
 * The sentence that decides whether he changes the fee.
 *
 * Says the PER-LOT gap, not just the total — "$21 a lot short" is a number he
 * can act on, where "$420 short" needs dividing before it means anything.
 */
export function coverageSummary(check: CoverageCheck, payers: number): string {
  if (check.actualCost === 0) {
    return check.feeIncome > 0
      ? "No bills entered yet, so there's nothing to check this against."
      : "No fees and no bills yet.";
  }
  if (payers === 0) return "Nobody is paying this yet.";

  const perLot = round2(Math.abs(check.margin) / payers);
  if (check.margin >= 0) {
    return `Your fees bring in $${check.feeIncome.toFixed(2)} a month against $${check.actualCost.toFixed(2)} of real cost — ahead by $${perLot.toFixed(2)} a lot.`;
  }
  return `Your fees bring in $${check.feeIncome.toFixed(2)} a month against $${check.actualCost.toFixed(2)} of real cost — SHORT by $${perLot.toFixed(2)} a lot, $${Math.abs(check.margin).toFixed(2)} a month.`;
}


/**
 * WHAT A PARK-OWNED HOME COSTS THE PARK, PER NIGHT IT COULD BE BOOKED.
 *
 * Brendon: "lets think about STR and assessing a Park Fee during their stay.
 * only fair."
 *
 * It is fair, and a guest's load is CAPACITY, not consumption. Three nights
 * barely touch a well, but they occupy a whole unit's worth of road, lighting,
 * trash and grounds — which is why hotels charge a resort fee per night rather
 * than prorating a monthly figure. Dividing the long-term fee by 30 and
 * multiplying by three nights is the wrong instinct: it recovers almost
 * nothing while the unit sat empty the other 27.
 *
 * SO THIS IS A PRICE, NOT AN INVOICE LINE — and deliberately so. The stay is
 * booked on somebody else's platform; LakeLife is not in that transaction and
 * cannot add a line to it. What it CAN do is tell him what the unit costs him
 * per available night so he sets a nightly rate that covers it. It becomes a
 * real billed line the day LakeLife hosts the booking, and not before: a fee
 * nothing can charge is a number that lies.
 *
 * `nightsAvailable` is the honest denominator — nights the unit could be let,
 * not nights it was. Dividing by nights actually booked would make the rate
 * rise as occupancy falls, which is the same mistake the cost allocator made
 * with vacant lots.
 */
export function nightlyRecoveryTarget(input: {
  /** The park's monthly cost for this lot — its share of the split. */
  monthlyShare: number;
  /** Nights the unit could be let this month. */
  nightsAvailable: number;
}): number | null {
  const { monthlyShare, nightsAvailable } = input;
  if (!(monthlyShare > 0) || !(nightsAvailable > 0)) return null;
  // Rounded UP to the cent: under-recovering every night of the season is a
  // slow leak, and a guest cannot tell $1.81 from $1.82.
  return Math.ceil((monthlyShare / nightsAvailable) * 100) / 100;
}

/** "$1.82 a night covers what Lot 12 costs the park." */
export function nightlyRecoveryLine(lotNumber: string, target: number | null): string {
  return target == null
    ? `We can't work out a nightly figure for lot ${lotNumber} yet — it needs a park cost split first.`
    : `Lot ${lotNumber}: $${target.toFixed(2)} a night covers its share of running the park. Build it into the nightly rate — we can't add it to a booking taken somewhere else.`;
}
