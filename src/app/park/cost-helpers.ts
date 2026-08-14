/**
 * SPLITTING A BILL ACROSS THE LOTS THAT WERE OCCUPIED.
 *
 * The owner's ask: recover water, sewer, trash, park lighting and grounds —
 * the costs sitting in the seller's expense history year after year. The
 * mechanism is deliberately dull: enter what the bill cost, divide it across
 * occupied lots, show the arithmetic.
 *
 * TWO RULES, AND EVERYTHING ELSE FOLLOWS FROM THEM.
 *
 *   1. NEVER RECOVER MORE THAN WAS PAID. Not a penny. This is enforced in the
 *      database too (0064), because it is the rule that turns ordinary cost
 *      recovery into a regulatory problem when it breaks.
 *
 *   2. ROUND DOWN, AND THE PARK ABSORBS THE REMAINDER. $100 across three lots
 *      is $33.33 each; the park eats a penny. Rounding to nearest would bill
 *      $100.02 — over-recovery, for a cent, on every odd bill forever.
 *
 * A VACANT LOT PAYS NOTHING and the park carries its share. Nobody lives there
 * to have used anything, and the incentive points the right way: the cost of
 * an empty lot is the owner's problem, which is what makes filling it worth
 * doing.
 */

export type CostCategory =
  | "water" | "sewer" | "trash" | "common_electric" | "grounds"
  | "unit_electric" | "other";

/**
 * MAY THIS COST BE SPLIT ACROSS THE LOTS AT ALL?
 *
 * `unit_electric` is power for a home the PARK owns and rents out. Its own
 * column comment has said since 0069 that a lot renter's electricity is
 * metered and billed by the utility DIRECTLY to them, and that nothing should
 * imply otherwise — and then the costs screen offered it in the same dropdown
 * as the water bill and split it across every long-term resident.
 *
 * At five park-owned homes that is roughly $7,200–$10,800 a year moving off
 * the park's short-term-rental P&L and onto nineteen households, which is
 * several times larger than the vacancy question and points the wrong way.
 *
 * Brendon, settling it: "electrical is seperately metered and will be billed
 * directly to renter (park take the STR bills directly but not allocated to
 * rest of the renters)."
 *
 * So it stays recordable — he needs it in his own books and against that
 * unit's income — and it is never divided by anybody else.
 */
export function canSplit(category: CostCategory): boolean {
  return category !== "unit_electric";
}

/** Why a resident is not being asked for a share of this one. */
export function whyNotSplit(category: CostCategory): string {
  return category === "unit_electric"
    ? "Power for a home you own is metered to that home. It belongs against that home's income, not split across the lots."
    : "";
}

export const COST_CATEGORY_LABEL: Record<CostCategory, string> = {
  water: "Water",
  sewer: "Sewer",
  trash: "Trash",
  common_electric: "Park lighting & common areas",
  grounds: "Grounds & mowing",
  // Power for a home the PARK owns and rents out. A lot renter's own
  // electricity is metered and billed by the utility DIRECTLY to them — the
  // park never sees it, and nothing here should imply otherwise.
  unit_electric: "Electric on a home you own",
  other: "Other",
};

/** A lot as it stood when the bill was split. */
export interface CostLot {
  lotId: string;
  lotNumber: string;
  /** Null when nobody was on it. Those lots are still in the DENOMINATOR. */
  reservationId: string | null;
  /**
   * Could this lot be rented at all? A live pad with a water tap counts even
   * when it is empty or switched off for repairs. A lot that is planned,
   * being renovated or retired does not — there is no pedestal to serve.
   *
   * Defaults TRUE so an older caller that has not been taught the difference
   * behaves as it always did, rather than silently emptying the denominator
   * and handing one household the entire bill.
   */
  rentable?: boolean;
  /**
   * A home the PARK owns and rents short-term. In the denominator — its guests
   * use the well and the roads — but never a payer: a three-night guest is not
   * sent a month of park water. Its share is what the park carries.
   */
  parkOwned?: boolean;
  /** For a metered split: this lot's reading for the period. */
  reading?: number | null;
}

export interface CostShare {
  lotId: string;
  lotNumber: string;
  reservationId: string;
  amount: number;
  basis: string;
}

export interface CostAllocation {
  shares: CostShare[];
  /** What residents will be asked for, in total. */
  allocated: number;
  /**
   * What the park carries: the vacant lots' share, plus the rounding
   * remainder. Shown on screen, because it is the real cost of a vacancy and
   * the owner should see it rather than discover it.
   */
  parkAbsorbs: number;
  occupiedCount: number;
  /** Every lot the bill was divided BY. */
  denominatorLots: number;
  /** How many of those had somebody to bill. */
  payerLots: number;
  vacantCount: number;
  /** Set when the split could not be done at all. */
  problem?: "no_rentable_lots" | "no_readings" | "over_recovery";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Always DOWN to the cent. The direction is the whole safety property. */
const floor2 = (n: number) => Math.floor(n * 100) / 100;

export interface AllocateInput {
  amountPaid: number;
  method: "per_lot" | "metered";
  lots: readonly CostLot[];
}

export function allocateCost(input: AllocateInput): CostAllocation {
  const { amountPaid, method, lots } = input;

  // THE DENOMINATOR IS EVERY LOT THAT COULD BE RENTED — occupied or not,
  // park-owned or not. Dividing by OCCUPIED lots, which is what this did,
  // means a household's share rises when their neighbours leave: the same
  // $1,140 water bill is $60.00 each at 19 occupied and $76.00 at 15, and
  // $1,140 to the last tenant standing. Vacancy is the landlord's risk.
  //
  // The predicate is a FLAG ON EACH LOT rather than a filter on the query, so
  // `payers` is a subset of `rentable` by construction. Filtering in two
  // places is how you end up allocating more than you were billed.
  const rentable = lots.filter((l) => l.rentable !== false);
  const payers = rentable.filter((l) => l.reservationId != null && !l.parkOwned);
  const vacantCount = rentable.length - payers.length;

  const nothing = (problem: CostAllocation["problem"]): CostAllocation => ({
    shares: [],
    allocated: 0,
    parkAbsorbs: round2(amountPaid),
    occupiedCount: payers.length,
    denominatorLots: rentable.length,
    payerLots: payers.length,
    vacantCount,
    problem,
  });

  // No rentable lots at all is a problem — there is nothing to divide BY.
  // Rentable lots with nobody on them is NOT a problem: the bill is recorded
  // and the park carries all of it, which is the whole point.
  if (rentable.length === 0) return nothing("no_rentable_lots");
  if (amountPaid <= 0) return nothing(undefined);

  let shares: CostShare[];

  if (method === "metered") {
    const total = payers.reduce((s, l) => s + (l.reading ?? 0), 0);
    // No readings means no basis for a metered split. Refuse rather than
    // silently falling back to an equal one — the owner chose "metered"
    // because he believed there were meters, and quietly changing the method
    // would produce a bill nobody could explain.
    if (total <= 0) return nothing("no_readings");

    shares = payers.map((l) => {
      const reading = l.reading ?? 0;
      return {
        lotId: l.lotId,
        lotNumber: l.lotNumber,
        reservationId: l.reservationId!,
        amount: floor2((reading / total) * amountPaid),
        basis: `${reading} of ${round2(total)} units metered`,
      };
    });
  } else {
    // Divided by RENTABLE, paid by PAYERS. The gap is the park's.
    const each = floor2(amountPaid / rentable.length);
    shares = payers.map((l) => ({
      lotId: l.lotId,
      lotNumber: l.lotNumber,
      reservationId: l.reservationId!,
      amount: each,
      basis: `1 of ${rentable.length} rentable ${rentable.length === 1 ? "lot" : "lots"}`,
    }));
  }

  const allocated = round2(shares.reduce((s, x) => s + x.amount, 0));

  // REFUSE, DO NOT CLAMP. This used to Math.min the total down to the amount
  // paid, which turns a real bug — more payers than the denominator — into a
  // silently wrong split that still looks tidy. It cannot happen while payers
  // is derived from rentable, and if it ever does the honest answer is to
  // stop rather than to send the bill.
  if (allocated > amountPaid) return nothing("over_recovery");

  return {
    shares,
    allocated,
    parkAbsorbs: round2(amountPaid - allocated),
    occupiedCount: payers.length,
    denominatorLots: rentable.length,
    payerLots: payers.length,
    vacantCount,
  };
}

/**
 * What the owner reads before he commits the split.
 *
 * Leads with the per-lot number, because that is the one a resident will
 * question, and states what the park is carrying — a vacancy has a cost and
 * it should be visible rather than absorbed silently.
 */
export function allocationSummary(a: CostAllocation, category: CostCategory): string {
  if (a.problem === "no_rentable_lots") {
    return "There are no rentable lots for that period, so there is nothing to divide it by.";
  }
  if (a.problem === "over_recovery") {
    return "That split would recover more than you paid — nothing has been recorded. Tell us, this is a bug.";
  }
  if (a.problem === "no_readings") {
    return "No meter readings for that period — enter them, or split it evenly instead.";
  }
  // NOBODY TO BILL IS NOT AN ERROR. The bill is real and the park carries all
  // of it — which is the sentence he most needs to see on an empty park.
  if (a.shares.length === 0) {
    return `${COST_CATEGORY_LABEL[category]}: nobody is on a lot, so you carry all $${a.parkAbsorbs.toFixed(2)} — ${a.denominatorLots} rentable ${a.denominatorLots === 1 ? "lot" : "lots"}.`;
  }

  const each = a.shares[0].amount;
  const same = a.shares.every((s) => s.amount === each);
  const per = same
    ? `$${each.toFixed(2)} each`
    : `$${Math.min(...a.shares.map((s) => s.amount)).toFixed(2)}–$${Math.max(...a.shares.map((s) => s.amount)).toFixed(2)}`;

  const absorbed = a.parkAbsorbs > 0
    ? ` You carry $${a.parkAbsorbs.toFixed(2)}${a.vacantCount ? ` — ${a.vacantCount} empty ${a.vacantCount === 1 ? "lot" : "lots"}` : ""}.`
    : "";

  // NAMES THE DENOMINATOR. "across 19 lots" was ambiguous the moment the
  // divisor stopped being the number of payers — he has to be able to walk the
  // park and count pedestals against this sentence.
  return `${COST_CATEGORY_LABEL[category]}: ${per} across ${a.payerLots} of ${a.denominatorLots} rentable ${a.denominatorLots === 1 ? "lot" : "lots"}.${absorbed}`;
}

/**
 * A year's worth of bills, by category — the view that answers "am I actually
 * recovering what the proforma said I would?".
 */
export interface RecoveryLine {
  category: CostCategory;
  paid: number;
  /**
   * WHAT THE PARK CARRIED, because a lot was empty or park-owned (0112).
   *
   * A decomposition of `paid`, not of `billed`: for every measured row
   * `allocated + absorbed === amountPaid`. Deliberately NOT folded into `net`,
   * which answers a different question — net is billed minus paid.
   */
  absorbed: number;
  /**
   * HOW MANY ROWS IN THIS CATEGORY HAVE NO SNAPSHOT, so `absorbed` above is
   * understated by an unknown amount. Counted rather than guessed: a bill
   * recorded before 0112 reads park_absorbed = 0.00 because that is the column
   * default, and treating that as "carried nothing" is exactly the confident
   * wrong number this module exists to avoid.
   */
  absorbedUnknown: number;
  /**
   * ALLOCATED, not recovered.
   *
   * This was named `recovered` and computed from `park_costs.allocated_total`
   * — the amount the owner INTENDED to split. Nothing billed from it (the
   * shares it produced had no reader at all until 0104), so the screen said
   * "passed on $1,140" about money no household had been asked for. A number
   * named after the outcome while measuring the intent is the worst kind of
   * wrong: it reads as reassurance.
   */
  allocated: number;
  /** What has actually landed on a household's bill (0104). */
  billed: number;
  /** Negative is the park's cost after what was actually billed. */
  net: number;
}

export function recoveryByCategory(
  costs: readonly {
    category: CostCategory;
    amountPaid: number;
    allocatedTotal: number;
    /** Sum of this cost's shares that have actually reached a bill (0104). */
    billedTotal?: number;
    /** null = this row carries no snapshot; see RecoveryLine.absorbedUnknown. */
    absorbed?: number | null;
  }[],
): {
  lines: RecoveryLine[];
  paid: number;
  allocated: number;
  billed: number;
  net: number;
  absorbed: number;
  absorbedUnknown: number;
} {
  const by = new Map<CostCategory, RecoveryLine>();
  for (const c of costs) {
    const cur = by.get(c.category)
      ?? { category: c.category, paid: 0, allocated: 0, billed: 0, net: 0,
           absorbed: 0, absorbedUnknown: 0 };
    cur.paid = round2(cur.paid + c.amountPaid);
    cur.allocated = round2(cur.allocated + c.allocatedTotal);
    cur.billed = round2(cur.billed + (c.billedTotal ?? 0));
    // An unmeasured row adds to the COUNT, never to the total — adding 0 would
    // make an unknown look like a zero.
    if (c.absorbed == null) cur.absorbedUnknown += 1;
    else cur.absorbed = round2(cur.absorbed + c.absorbed);
    // NET IS AGAINST WHAT WAS BILLED, not what was intended. Netting off an
    // allocation nobody was asked for tells the owner he broke even on a bill
    // he is still carrying in full.
    cur.net = round2(cur.billed - cur.paid);
    by.set(c.category, cur);
  }
  const lines = [...by.values()].sort((a, b) => b.paid - a.paid);
  const paid = round2(lines.reduce((s, l) => s + l.paid, 0));
  const allocated = round2(lines.reduce((s, l) => s + l.allocated, 0));
  const billed = round2(lines.reduce((s, l) => s + l.billed, 0));
  const absorbed = round2(lines.reduce((s, l) => s + l.absorbed, 0));
  const absorbedUnknown = lines.reduce((s, l) => s + l.absorbedUnknown, 0);
  return { lines, paid, allocated, billed, net: round2(billed - paid), absorbed, absorbedUnknown };
}

/**
 * ONE BILL, IN A SENTENCE — including what the park carried.
 *
 * The row used to read "$343.71 across 19 lots", which is true and hides the
 * thing 0112 was built to make visible: the denominator is 21, and the $36.29
 * difference is the owner's, because two pads are empty. He saw that number
 * once, in the preview before saving, and never again.
 *
 * Branch order matters. "We did not record it" must win over any arithmetic,
 * and it must carry NO dollar figure at all — `park_absorbed` is NOT NULL
 * DEFAULT 0, so a pre-0112 row would otherwise announce "$0.00 carried" with
 * complete confidence about something nobody measured.
 */
export function carriedLine(r: {
  allocatedTotal: number;
  amountPaid: number;
  absorbed: number | null;
  denominatorLots: number | null;
  payerLots: number | null;
  carry: "split" | "covered_by_fee" | "unrecorded";
}): string {
  const money = (n: number) => `$${n.toFixed(2)}`;

  if (r.carry === "unrecorded") {
    return "Recorded before we started keeping track of who carried what — the split is right, but we can't say what you covered.";
  }
  if (r.carry === "covered_by_fee") {
    return `${money(r.amountPaid)} — your recurring fee already covers this, so it wasn't split again.`;
  }

  const denom = r.denominatorLots ?? 0;
  const payers = r.payerLots ?? 0;
  const absorbed = r.absorbed ?? 0;
  const lot = (n: number) => (n === 1 ? "lot" : "lots");

  if (payers === 0) {
    return `${money(r.amountPaid)} — nobody to bill, so you carried all of it.`;
  }
  if (absorbed === 0) {
    return `${money(r.allocatedTotal)} across all ${denom} ${lot(denom)} — you carried nothing.`;
  }
  const empties = denom - payers;
  return `${money(r.allocatedTotal)} across ${payers} of ${denom} ${lot(denom)} — you carried ${money(absorbed)} for the ${empties} with nobody in ${empties === 1 ? "it" : "them"}.`;
}
