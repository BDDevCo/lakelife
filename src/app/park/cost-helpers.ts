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
  /** Null when nobody was on it — those pay nothing. */
  reservationId: string | null;
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
  vacantCount: number;
  /** Set when the split could not be done at all. */
  problem?: "no_occupied_lots" | "no_readings";
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

  const occupied = lots.filter((l) => l.reservationId != null);
  const vacantCount = lots.length - occupied.length;

  const nothing = (problem: CostAllocation["problem"]): CostAllocation => ({
    shares: [],
    allocated: 0,
    parkAbsorbs: round2(amountPaid),
    occupiedCount: occupied.length,
    vacantCount,
    problem,
  });

  if (amountPaid <= 0 || occupied.length === 0) {
    return nothing(occupied.length === 0 ? "no_occupied_lots" : undefined);
  }

  let shares: CostShare[];

  if (method === "metered") {
    const total = occupied.reduce((s, l) => s + (l.reading ?? 0), 0);
    // No readings means no basis for a metered split. Refuse rather than
    // silently falling back to an equal one — the owner chose "metered"
    // because he believed there were meters, and quietly changing the method
    // would produce a bill nobody could explain.
    if (total <= 0) return nothing("no_readings");

    shares = occupied.map((l) => {
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
    const each = floor2(amountPaid / occupied.length);
    shares = occupied.map((l) => ({
      lotId: l.lotId,
      lotNumber: l.lotNumber,
      reservationId: l.reservationId!,
      amount: each,
      basis: `1 of ${occupied.length} occupied ${occupied.length === 1 ? "lot" : "lots"}`,
    }));
  }

  const allocated = round2(shares.reduce((s, x) => s + x.amount, 0));

  // Belt and braces. Rounding down cannot overshoot, but the invariant is
  // important enough that it gets asserted rather than assumed — and if it
  // ever did, dropping the excess is safer than sending the bill.
  const safeAllocated = Math.min(allocated, amountPaid);

  return {
    shares,
    allocated: round2(safeAllocated),
    parkAbsorbs: round2(amountPaid - safeAllocated),
    occupiedCount: occupied.length,
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
  if (a.problem === "no_occupied_lots") {
    return "Nobody is on a lot for that period, so there's nothing to split.";
  }
  if (a.problem === "no_readings") {
    return "No meter readings for that period — enter them, or split it evenly instead.";
  }
  if (a.shares.length === 0) return "Nothing to split.";

  const each = a.shares[0].amount;
  const same = a.shares.every((s) => s.amount === each);
  const per = same
    ? `$${each.toFixed(2)} each`
    : `$${Math.min(...a.shares.map((s) => s.amount)).toFixed(2)}–$${Math.max(...a.shares.map((s) => s.amount)).toFixed(2)}`;

  const absorbed = a.parkAbsorbs > 0
    ? ` You carry $${a.parkAbsorbs.toFixed(2)}${a.vacantCount ? ` — ${a.vacantCount} empty ${a.vacantCount === 1 ? "lot" : "lots"}` : ""}.`
    : "";

  return `${COST_CATEGORY_LABEL[category]}: ${per} across ${a.occupiedCount} ${a.occupiedCount === 1 ? "lot" : "lots"}.${absorbed}`;
}

/**
 * A year's worth of bills, by category — the view that answers "am I actually
 * recovering what the proforma said I would?".
 */
export interface RecoveryLine {
  category: CostCategory;
  paid: number;
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
  }[],
): {
  lines: RecoveryLine[];
  paid: number;
  allocated: number;
  billed: number;
  net: number;
} {
  const by = new Map<CostCategory, RecoveryLine>();
  for (const c of costs) {
    const cur = by.get(c.category)
      ?? { category: c.category, paid: 0, allocated: 0, billed: 0, net: 0 };
    cur.paid = round2(cur.paid + c.amountPaid);
    cur.allocated = round2(cur.allocated + c.allocatedTotal);
    cur.billed = round2(cur.billed + (c.billedTotal ?? 0));
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
  return { lines, paid, allocated, billed, net: round2(billed - paid) };
}
