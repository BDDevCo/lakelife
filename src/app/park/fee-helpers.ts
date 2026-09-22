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

// The cost screen's words for the cost categories — imported, never retyped.
import {
  COST_CATEGORY_LABEL, COST_CATEGORIES, canSplit, costMonths, type CostCategory,
} from "./cost-helpers";
// Months in words and the one money formatter — never ISO, never toFixed here.
import { prettyMonth, money } from "./ledger-helpers";

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
 * WHAT A FEE MAY BE RECONCILED AGAINST — every shared cost the park carries.
 *
 * Brendon, 22 September 2026: "tax and insurance belong in the pool." They do,
 * and the pool is what this list describes: the grounds fee exists to recover
 * the cost of running the park, and the tax on seven parcels and the premium
 * on the policy over them are as shared as the sewer bill. The costs screen
 * has said so in its own label map since 0123 — "both are shared park costs,
 * they sit in the pool every rentable lot carries a share of, exactly like
 * sewer" — while this list went on refusing them.
 *
 * THE LIST IS NO LONGER TYPED OUT. It was, and it fell behind twice. `snow`
 * became a real cost category in 0144 and sat on in the "not a billable
 * category" list below. `tax` and `insurance` were recordable, schedulable,
 * splittable and in the costs dropdown, and a fee still could not claim them —
 * so the month he files the tax bill it was GUARANTEED to land in `uncovered`,
 * under a sentence asking whether that gap was deliberate, about a gap the
 * product had made and he had no way to close.
 *
 * So the list derives from the two things that actually decide it: every cost
 * category there is, minus the ones the park never spreads. `canSplit` is that
 * rule and it has exactly one member — `unit_electric`, power for a home the
 * PARK owns. Brendon settled that one too: "electrical is seperately metered
 * and will be billed directly to renter (park take the STR bills directly but
 * not allocated to rest of the renters)." It is one building's cost, set
 * against that building's own income; a fee is spread across every lot, so the
 * two can never meet. `recordCost` refuses to split it and the costs dropdown
 * does not offer it — one rule, read here rather than restated.
 *
 * `other` STAYS IN, deliberately: it is where The Haven's pier sits, it is
 * splittable, and the only list that leaves it out is the reminder list — for
 * a reason about reminders (two unrelated `other` bills would each satisfy the
 * other's) that says nothing about what a fee may cover.
 *
 * The next category to arrive lands here the day it is declared, without
 * anybody having to remember to come back.
 */
export const FEE_COVERS: CostCategory[] = COST_CATEGORIES.filter(canSplit);

/**
 * Extra coverage words a fee may claim that are not billable cost categories.
 *
 * `snow` used to live here and no longer does. 0144 gave it a column, a
 * dropdown and a reminder, which makes it an ordinary cost category and puts
 * it in `FEE_COVERS` above. Leaving it in both would have given the fee form
 * two Snow clearing checkboxes sharing one key, and gone on telling
 * `checkCoverage` that a snow-only fee earns nothing worth checking.
 */
export const FEE_EXTRA_COVERS = ["maintenance", "pest", "amenities"] as const;

/**
 * THE WORDS A COVERAGE LINE PRINTS — one source, not a second copy.
 *
 * This used to hand-list ten strings, seven of them a duplicate of the cost
 * screen's own words. Two things went wrong with that, and both showed up on
 * the one card built to answer "is my fee covering my costs?".
 *
 * The copy had DRIFTED: this map called snow "Snow removal" while the costs
 * screen called the very same category "Snow clearing", so one bill was named
 * two ways on two screens.
 *
 * And it was INCOMPLETE. `checkCoverage` lists every recorded cost category no
 * active fee claims, so a category with no entry here reached the card as its
 * own database enum: it printed the bare word `tax` beside "Water, Trash", a
 * column name sitting in an English sentence.
 *
 * Spreading the cost screen's map fixes both at once and, more to the point,
 * cannot drift again when the next category lands: whatever the costs screen
 * calls it, the fee screen calls it that too. The three extras below are the
 * coverage words a fee may claim that are not billable categories at all.
 *
 * ONE GUARDRAIL, AND IT IS NOT THE ONE IT USED TO BE. The checkbox row on the
 * fee form is built from `[...FEE_COVERS, ...FEE_EXTRA_COVERS]`, not from this
 * map's keys — leave it that way. It used to matter because tax and insurance
 * had labels and no right to a tickbox; now they have both, and the word this
 * map holds that must never become a tickbox is `unit_electric`. It is named
 * here so a coverage line can read "you pay for Electric on a home you own and
 * no fee covers it", which is TRUE and is the whole point of naming it; a fee
 * still cannot claim it, because a park-owned home's power is never spread.
 */
export const COVER_LABEL: Record<string, string> = {
  ...COST_CATEGORY_LABEL,
  maintenance: "Maintenance",
  pest: "Pest control",
  amenities: "Amenities",
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

/**
 * WHICH FEES THIS PARTICULAR TENANCY IS CHARGED.
 *
 * A FEE NEVER LANDS ON A TENANCY THE PARK INHERITED.
 *
 * `feesFor` reads one list for the park and the biller handed that same list to
 * every long-term tenancy, so the first grounds fee saved would have appeared
 * on the January bill of all nineteen households at The Haven — people who
 * signed nothing with this owner, were never told, and whose rent went up by a
 * third overnight. Nothing in the schema could express "not them": there is no
 * effective date on a fee, no notice mechanism of any kind, and
 * `lot_fee_assignments` — the per-lot table — has no writer anywhere.
 *
 * The distinction already exists on the TENANCY. `origin = 'grandfathered'`
 * means exactly "inherited, never agreed to anything with us", and this
 * codebase already treats it as a category apart in two other places: 0065's
 * trigger exempts it from the park's agreement cap, and 0059's constraint
 * forbids it carrying a decision, because no decision happened. A charge the
 * resident never agreed to is the same argument a third time.
 *
 * It is a REFUSAL, not a silence — `ParkFees` says on screen who this fee will
 * and will not reach, and the payer count agrees with it. A park that means to
 * charge an inherited household needs to serve notice first, and the machinery
 * for that does not exist yet; refusing until it does is the conservative half
 * of the mistake.
 *
 * A sitting tenant who later signs a new agreement gets a successor row with a
 * different origin, and the fee begins applying then — which is right, because
 * that is the moment they agreed to it.
 */
export function feesForTenancy<T>(
  fees: readonly T[],
  lot: { rental_mode?: unknown },
  stay: { origin?: unknown },
): T[] {
  // A nightly home is priced per stay, not billed a monthly fee.
  if ((lot.rental_mode as string) === "short_term") return [];
  if ((stay.origin as string) === "grandfathered") return [];
  return [...fees];
}

/** How many of these tenancies a fee may actually be charged to. */
export function feePayableCount(
  stays: readonly { park_lot_id?: unknown; origin?: unknown }[],
): number {
  return stays.filter((s) => (s.origin as string) !== "grandfathered").length;
}

/**
 * THE HOUSEHOLDS FILED TO PAY A FEE FROM A DAY STILL TO COME — signed leases
 * on the roll whose agreements start later (a takeover's eighteen leases
 * filed on 20 December for 1 January). `payers` counts only tenancies
 * covering TODAY, which before go-live is zero by construction, and the
 * screen turned that into "Nobody is on a lot yet, so this fee is collecting
 * nothing" on the afternoon nineteen households were filed and the roll
 * read "18 reserved". A wrong count, on the screen where he decides whether
 * $142.53 is set right.
 */
export interface UpcomingPayers {
  /** Lots counted once, grandfathered rows never. */
  count: number;
  /** YYYY-MM — the month the first of them is billed, from the rows' own earliest start. */
  fromMonth: string;
  /** What the active monthly fees bring in a month once they are all billed. */
  income: number;
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
  /**
   * How many months of cost each claimed category's monthly figure rests
   * on — the evidence behind `actualCost`, per bill. Only categories with a
   * row appear; the ones without are in `unverified`.
   */
  monthsByCategory: { category: CostCategory; months: number }[];
}

/**
 * Put the fee income and the real cost side by side.
 *
 * EACH BILL IS AVERAGED OVER ITS OWN MONTHS. Three months of water bills is
 * $1,140 of water, not $1,140 a month — but the denominator has to be the
 * months THAT bill was entered for, not the months any bill was. The Haven's
 * grounds, common electric and "other" are annual figures divided by twelve
 * and entered once, as a June row; only the sewer arrives monthly and only
 * the sewer has a reminder. With one denominator across every category, each
 * December sewer bill diluted the three baselines and the sentence he sets
 * the fee by drifted from "ahead by $37.67 a lot" to $60.63 by July, in the
 * reassuring direction, while nothing had changed.
 *
 * A category's month is the month its period BEGINS (`period_start`), which
 * is the same key the rest of the ledger reads a park_costs row by.
 *
 * AND A BILL IS FOR AS MANY MONTHS AS ITS OWN PERIOD RUNS. Every reader in
 * this product treats a park_costs row as one month, and until tax and
 * insurance could be claimed nothing tested that: the four rows on file are
 * each a single June, and the two annual baselines among them had already
 * been divided by twelve by the man typing them in.
 *
 * The Haven's property tax is $3,517.96 for the YEAR across seven parcels. Ask
 * this function the old question with that bill entered whole and a fee that
 * claims tax, and it answered: "Your fees bring in $2,850.60 a month against
 * $6,202.42 of real cost — SHORT by $167.59 a lot." Short by more than the fee
 * charges, on the screen where he decides what twenty households pay for a
 * year. The truth is $293.16 a month of tax and a fee that is ahead.
 *
 * So each row is divided by the months ITS period covers (`costMonths`), and a
 * category's denominator is the sum of those spans over the distinct months
 * its bills were filed against — which leaves every existing one-month row
 * reading exactly as it did, and stops an annual bill reading as a January.
 * Two rows filed against the same month are still one month of cost: a
 * corrected invoice entered twice is not two Decembers.
 *
 * The denominator is not a detail a reader should have to assume, so
 * `evidenceLine` names it per bill — "Property tax over 12 months" — and
 * `coverageSummary` says the figures are monthly in the sentence itself.
 */
export function checkCoverage(
  fees: readonly ParkFee[],
  payersByFee: ReadonlyMap<string, number>,
  costs: readonly {
    category: CostCategory;
    amountPaid: number;
    periodStart: string;
    /**
     * The day the period ENDS, half-open, straight off the row.
     *
     * REQUIRED, not defaulted. `park_costs.period_end` is NOT NULL and
     * `listFees` has been selecting it since before this helper could use it —
     * a column read and handed to nobody. Making it optional here would let
     * the next caller forget it and silently get the one-month reading back
     * for a bill covering a year, which is the defect this parameter exists
     * to close. The compiler asks every caller instead.
     */
    periodEnd: string;
  }[],
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
  // Category → the month each bill was filed against → the longest span any
  // bill filed against that month covers. Keyed by the filing month so two
  // rows for one December stay one December; holding the LONGEST span means a
  // year's tax filed in January counts its twelve months, and a second
  // January row cannot shrink them.
  const monthsBy = new Map<CostCategory, Map<string, number>>();
  for (const c of costs) {
    spentBy.set(c.category, round2((spentBy.get(c.category) ?? 0) + c.amountPaid));
    const filed = String(c.periodStart ?? "").slice(0, 7);
    const spans = monthsBy.get(c.category) ?? new Map<string, number>();
    spans.set(filed, Math.max(spans.get(filed) ?? 0, costMonths(c.periodStart, c.periodEnd)));
    monthsBy.set(c.category, spans);
  }
  const monthsOf = (cat: CostCategory) =>
    Math.max(1, [...(monthsBy.get(cat)?.values() ?? [])].reduce((s, n) => s + n, 0));

  // Per category: what it costs in a typical month. Then the sum of those.
  const actualCost = round2(
    [...spentBy.entries()]
      .filter(([cat]) => claimed.has(cat))
      .reduce((s, [cat, amt]) => s + round2(amt / monthsOf(cat)), 0),
  );

  return {
    feeIncome,
    actualCost,
    margin: round2(feeIncome - actualCost),
    unverified: [...claimed].filter((c) => !spentBy.has(c)),
    uncovered: [...spentBy.keys()].filter((c) => !claimed.has(c)),
    monthsByCategory: [...spentBy.keys()]
      .filter((c) => claimed.has(c))
      .map((category) => ({ category, months: monthsOf(category) })),
  };
}

/**
 * HOW THIN THE EVIDENCE IS, per bill — the caption under the headline.
 *
 * Null when there is nothing recorded (the headline already says so, and
 * "from one month of bills" under it would be inventing a month nobody
 * entered). Names each bill with the months it rests on, because "averaged
 * over 7 months" was true of the sewer and false of everything else on the
 * same screen. A single month is also a SEASON — a June of mowing is not a
 * January of ploughing — and a fee set on it is set for a year, so the
 * one-month caveat stays as long as any bill is resting on one.
 *
 * THIS IS ALSO WHERE AN ANNUAL BILL DECLARES ITSELF. A year's property tax
 * entered whole reads "Property tax over 12 months" here, which is the only
 * place on the card that says what the monthly figure above was divided by —
 * and the place to look when it is wrong, because a tax bill typed in against
 * a single month will say "over one month" and be believed.
 */
export function evidenceLine(check: CoverageCheck): string | null {
  const rows = check.monthsByCategory;
  if (rows.length === 0) return null;
  const thin = "thin evidence for a number you set for a year";
  if (rows.every((r) => r.months === 1)) {
    return `From one month of bills — ${thin}.`;
  }
  // Group by month count, most months first, so the line reads
  // "sewer over 7 months; common electric, grounds and other over one".
  const byMonths = new Map<number, string[]>();
  for (const r of rows) {
    const label = COVER_LABEL[r.category] ?? r.category;
    byMonths.set(r.months, [...(byMonths.get(r.months) ?? []), label]);
  }
  const parts = [...byMonths.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([months, labels]) => {
      const names = labels.sort((a, b) => a.localeCompare(b));
      const list = names.length <= 1
        ? names.join("")
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      return `${list} over ${months === 1 ? "one month" : `${months} months`}`;
    });
  const anyThin = rows.some((r) => r.months === 1);
  return (
    `Each bill is averaged over the months it was entered for: ${parts.join("; ")}.` +
    (anyThin ? ` A single month is ${thin}.` : "")
  );
}

/**
 * The sentence that decides whether he changes the fee.
 *
 * Says the PER-LOT gap, not just the total — "$21 a lot short" is a number he
 * can act on, where "$420 short" needs dividing before it means anything.
 */
export function coverageSummary(
  check: CoverageCheck,
  payers: number,
  /**
   * How many fees exist at all, active or not.
   *
   * WITHOUT IT THIS SENTENCE CONTRADICTED THE SCREEN AROUND IT. `feeIncome` is
   * zero both when there are no fees AND when there are fees nobody is on a lot
   * to pay — and the no-cost branch ran first, so a park with a saved fee and
   * no tenancies read "No fees and no bills yet." inside a card that only
   * renders BECAUSE a fee exists. That is The Haven's exact state until the
   * roll is named. Defaulted so existing callers keep their old behaviour.
   */
  feeCount = 0,
  /**
   * Households filed to pay from a day still to come. Named BEFORE "nobody",
   * because on the afternoon eighteen leases are filed for 1 January the
   * truer sentence is that eighteen will be billed it from January — not
   * that the fee collects nothing. Null for a park with no such rows.
   */
  upcoming: UpcomingPayers | null = null,
): string {
  // NOBODY ON A LOT IS THE MORE SPECIFIC TRUTH, so it goes first. A fee that
  // exists and collects nothing is a different situation from having no fee,
  // and only this branch can tell him which one he is looking at.
  if (feeCount > 0 && payers === 0) {
    // LEAD WITH THE FACT THE COUNT MEASURES. `payers` counts households
    // billed the fee, which excludes a grandfathered holdover — who IS on a
    // lot (the roll reads 'Occupied 1' at The Haven on 20 December) and is
    // billed nothing. 'Nobody is on a lot yet' beside 'Occupied 1' was the
    // contradiction; 'nobody is billed it yet' is what is known here.
    if (upcoming && upcoming.count > 0) {
      return (
        `Nobody is billed it yet — ${upcoming.count} ${upcoming.count === 1 ? "household" : "households"} will be ` +
        `from ${prettyMonth(upcoming.fromMonth)}, ${money(upcoming.income)} a month. Nothing is billed before then.`
      );
    }
    return "Nobody is on a lot yet, so this fee is collecting nothing.";
  }
  if (check.actualCost === 0) {
    return check.feeIncome > 0
      ? "No bills entered yet, so there's nothing to check this against."
      : feeCount > 0
        ? "No bills entered yet, so there's nothing to check this against."
        : "No fees and no bills yet.";
  }
  if (payers === 0) return "Nobody is paying this yet.";

  const perLot = round2(Math.abs(check.margin) / payers);
  // BOTH HALVES ARE MONTHLY FIGURES AND ONLY ONE OF THEM SAID SO. The income
  // side carried "a month" from the first draft; the cost side read "$6,202.42
  // of real cost", which a reader takes for a total of what was entered —
  // right while the fee could only claim bills that arrive monthly anyway. Now
  // a fee may claim the property tax, `checkCoverage` spreads that year over
  // twelve, and a number that is an AVERAGE has to say so in the sentence a
  // person reads, not only in the caption underneath it.
  if (check.margin >= 0) {
    return `Your fees bring in ${money(check.feeIncome)} a month against ${money(check.actualCost)} a month of real cost — ahead by ${money(perLot)} a lot.`;
  }
  return `Your fees bring in ${money(check.feeIncome)} a month against ${money(check.actualCost)} a month of real cost — SHORT by ${money(perLot)} a lot, ${money(Math.abs(check.margin))} a month.`;
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
    : `Lot ${lotNumber}: ${money(target)} a night covers its share of running the park. Build it into the nightly rate — we can't add it to a booking taken somewhere else.`;
}
