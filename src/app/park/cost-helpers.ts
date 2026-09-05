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
  // 0144. The fee could claim snow from 0067 onward and no bill could carry
  // it, so the coverage panel called it unverified forever.
  | "snow"
  | "unit_electric" | "other" | "tax" | "insurance";

/**
 * WHICH COST CATEGORY IS THIS PIECE OF WORK?
 *
 * 0144 added `snow` so a bill could finally carry it, and its commit says the
 * point was making snow "mean the same thing in all four places" — warning that
 * "a category nothing can file is a column with no writer." It widened both
 * dropdowns, the label map and the fee vocabulary, and missed a fifth list: the
 * ONE-TAP writer on the costs screen passed a hardcoded `"grounds"` for
 * whatever the job had been.
 *
 * That button is the path the screen pushes hardest — "nothing to retype" — and
 * `BillableParkJob` carries the service NAME but no category, so a mow, a leaf
 * haul and a whole-park plough all filed as groundskeeping.
 *
 * IT IS MONEY, NOT TIDINESS. The Haven's only active fee covers
 * [water, sewer, trash, common_electric, grounds, other] — `grounds` yes,
 * `snow` NO. `recordCost` asks `feeCovering(parkId, category)`; a hit files the
 * bill `fee_covered`, absorbs the whole amount into the park, and writes no lot
 * shares. So every plough all winter was carried by the park, where the same
 * bill typed manually as "Snow clearing" finds no covering fee and splits
 * across the households. And `checkCoverage`'s "categories no fee claims"
 * warning — the one that answers "is my $142.53 set right?" — can never fire
 * for snow while snow is filed as grounds.
 *
 * NAMES, NOT IDS, because that is what the billable-job row carries. Matching
 * is on the exact catalogue name; anything unrecognised falls to `other`
 * rather than `grounds`, so a service added later cannot silently claim to have
 * been groundskeeping. The screen prints the category on the button, so a
 * fallback is visible before it is committed.
 */
const COST_CATEGORY_BY_SERVICE: Record<string, CostCategory> = {
  "Snow clearing — roads & common drives": "snow",
  "Park grounds mowing & trim": "grounds",
  "Common-area spring cleanup": "grounds",
  "Common-area fall cleanup & leaf haul": "grounds",
  // A park can buy these too (park_bookable). There is no pier category, and
  // The Haven's existing pier cost row already sits in `other` saying so.
  "Pier install / removal": "other",
  "Boat lift set / pull": "other",
  "PWC lift set / pull": "other",
};

export function costCategoryForService(serviceName: string | null | undefined): CostCategory {
  return COST_CATEGORY_BY_SERVICE[(serviceName ?? "").trim()] ?? "other";
}

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
  snow: "Snow clearing",
  // Power for a home the PARK owns and rents out. A lot renter's own
  // electricity is metered and billed by the utility DIRECTLY to them — the
  // park never sees it, and nothing here should imply otherwise.
  unit_electric: "Electric on a home you own",
  // Both are shared park costs — they sit in the pool every rentable lot
  // carries a share of, exactly like sewer. They lived in `other` until 0123,
  // where a single reminder slot meant the tax bill and the insurance premium
  // could not both be watched for.
  tax: "Property tax",
  insurance: "Insurance",
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
    /**
     * VACANCY CARRY ONLY, or null when the row has no snapshot. A bill the
     * park carries on purpose, or one a fee already covers, contributes 0 —
     * `park_absorbed` on those rows is the whole bill and means something else
     * entirely.
     */
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
    // An unmeasured row adds to the COUNT, never to the total — adding 0 would
    // make an unknown look like a zero. `listCosts` is the single place that
    // decides what counts as vacancy carry: it sends 0 for a bill the park
    // carries on purpose or one a fee covers, and null ONLY for a row with no
    // snapshot at all. Re-deciding it here would give the two rules somewhere
    // to drift apart.
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
  carry: CostCarry;
}): string {
  // Thousands separators, like every other figure on the screen. `toFixed`
  // alone rendered "$1433.17" one line under a column reading "$1,433.17".
  const money = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (r.carry === "unrecorded") {
    return "Recorded before we started keeping track of who carried what — the split is right, but we can't say what you covered.";
  }
  if (r.carry === "covered_by_fee") {
    return `${money(r.amountPaid)} — your recurring fee already covers this, so it wasn't split again.`;
  }
  if (r.carry === "park_only") {
    // THE ONE THE BOAT NEEDED. Not a failure to split — a decision not to.
    return `${money(r.amountPaid)} — you're carrying this one. Nobody was billed a share.`;
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

  // EVERY LOT IS LET AND THERE IS STILL A REMAINDER. `allocateCost` floors each
  // share to the cent on purpose, so a bill that does not divide evenly leaves
  // the park a few cents even at full occupancy — and the sentence below would
  // have blamed that on "the 0 with nobody in them". $1,433.17 across 21 lots
  // is 13 cents of rounding, not a vacancy.
  if (empties === 0) {
    return `${money(r.allocatedTotal)} across all ${denom} ${lot(denom)} — you carried ${money(absorbed)}, which is what wouldn't divide evenly.`;
  }

  return `${money(r.allocatedTotal)} across ${payers} of ${denom} ${lot(denom)} — you carried ${money(absorbed)} for the ${empties} with nobody in ${empties === 1 ? "it" : "them"}.`;
}


// ------------------------------------------- bills that arrive every month --

/**
 * THE CATEGORIES A REMINDER MAY BE SET FOR — narrower than CostCategory, and
 * the narrowing is the point. 0117 holds the same list at the database.
 *
 * `unit_electric` is out because `recordCost` refuses it (see `canSplit`): the
 * reminder would send him to a screen where it is not in the dropdown and the
 * action would decline it. `other` is out because the one-active-row-per-
 * category index cannot tell two 'other' bills apart — the property tax and
 * the insurance binder would share one reminder and each would falsely satisfy
 * it. A wrong reassurance is worse than no reminder at all.
 */
/**
 * HOW A BILL CAME TO REST. A stored fact since 0118, not an inference.
 *
 * `park_only` is the one The Haven's boat forced into existence: the guest
 * boat is bookable by SHORT-STAY guests only, so winterizing it is a cost of
 * the nightly business and not of living on lot 14. Before this it would have
 * gone in as `other` and divided across all twenty-one rentable lots.
 */
export type CostCarry = "split" | "park_only" | "covered_by_fee" | "unrecorded";

/** What the DB stores in park_costs.allocation_method, mapped to the above. */
export function carryFromRow(row: {
  allocation_method?: string | null;
  denominator_lots?: number | null;
  park_absorbed?: number | string | null;
}): CostCarry {
  const method = row.allocation_method ?? "per_lot";
  if (method === "park_only") return "park_only";
  if (method === "fee_covered") return "covered_by_fee";
  if (row.denominator_lots != null) return "split";
  // Pre-0112: no snapshot at all. `park_absorbed` is NOT NULL DEFAULT 0, so a
  // row like this reads 0.00 and must NOT be reported as "carried nothing".
  return "unrecorded";
}

export const SCHEDULABLE_CATEGORIES: CostCategory[] = [
  "water", "sewer", "trash", "common_electric", "grounds", "snow", "tax", "insurance",
];

export type Cadence = "monthly" | "quarterly" | "annual";

export interface CostScheduleInput {
  category: string;
  cadence: string;
  /** Day of the month, 1-28. */
  dueDay: string;
  /** WHICH month, for quarterly and annual. Empty for monthly. */
  dueMonth: string;
  /** Blank is allowed and means "I don't know what it usually comes to". */
  typicalAmount: string;
  label: string;
}

/**
 * WHICH PERIOD A BILL IS CURRENTLY DUE FOR, and what to call it.
 *
 * The whole reason this exists: a task keyed on the calendar month nags twelve
 * times a year about a bill that arrives once. A property tax reminder must be
 * one task with one name — "Property tax for 2026" — and it must go quiet the
 * moment the bill is entered and stay quiet until next November.
 *
 * `from`/`to` are the window a matching cost must fall in, half-open like every
 * other window here. `key` goes in the task id, so the same bill in the same
 * period is the same task no matter how many mornings he opens the screen.
 */
export function billPeriod(
  cadence: Cadence,
  dueMonth: number | null,
  dueDay: number,
  todayISO: string,
): { key: string; label: string; dueOn: string; from: string; to: string } {
  const [y, m] = todayISO.split("-").map(Number);
  // Capped at 28 so February always has the day — the same clamp the column's
  // CHECK makes structural.
  const day = String(Math.min(Math.max(dueDay, 1), 28)).padStart(2, "0");
  const iso = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;

  if (cadence === "monthly") {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    return {
      key, label: prettyMonthName(y, m), dueOn: `${key}-${day}`,
      from: iso(y, m), to: m === 12 ? iso(y + 1, 1) : iso(y, m + 1),
    };
  }

  if (cadence === "quarterly") {
    // The cycle is anchored to due_month: an anchor of 2 means Feb, May, Aug,
    // Nov. Find the anchor month of the quarter TODAY sits in.
    const anchor = ((dueMonth ?? 1) - 1) % 3;          // 0, 1 or 2 within a quarter
    const since = (m - 1 - anchor + 12) % 3;           // months into the current cycle
    const startMonth = m - since;
    const sy = startMonth < 1 ? y - 1 : y;
    const sm = startMonth < 1 ? startMonth + 12 : startMonth;
    const em = sm + 3;
    const ey = em > 12 ? sy + 1 : sy;
    const emm = em > 12 ? em - 12 : em;
    return {
      key: `${sy}-Q${sm}`,
      label: `the ${prettyMonthName(sy, sm)} quarter`,
      dueOn: `${sy}-${String(sm).padStart(2, "0")}-${day}`,
      from: iso(sy, sm), to: iso(ey, emm),
    };
  }

  // ANNUAL. The year it is due in is THIS year if the due month has not passed
  // by more than its window, and the window is the whole year — a tax bill
  // entered in December still answers November's reminder.
  return {
    key: String(y),
    label: String(y),
    dueOn: `${y}-${String(dueMonth ?? 1).padStart(2, "0")}-${day}`,
    from: iso(y, 1), to: iso(y + 1, 1),
  };
}

function prettyMonthName(y: number, m: number): string {
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

export interface CostScheduleResult {
  ok: boolean;
  error?: string;
  row?: {
    category: string;
    due_day: number;
    due_month: number | null;
    typical_amount: number | null;
    label: string | null;
    cadence: string;
    active: boolean;
  };
}

/**
 * Every rule the database holds, re-checked here so a mistake comes back as a
 * sentence instead of a Postgres constraint name.
 */
export function buildCostScheduleRow(input: CostScheduleInput): CostScheduleResult {
  const category = (input.category ?? "").trim();
  if (!SCHEDULABLE_CATEGORIES.includes(category as CostCategory)) {
    return { ok: false, error: "Pick which bill this is." };
  }

  const cadence = (input.cadence ?? "monthly").trim() as Cadence;
  if (!["monthly", "quarterly", "annual"].includes(cadence)) {
    return { ok: false, error: "How often does it come — monthly, quarterly or once a year?" };
  }

  // WHICH MONTH is required for anything that is not monthly, and forbidden for
  // anything that is. "Some time this year" is not a reminder, it is a shrug —
  // and a month stored against a monthly bill is a fact with two readings.
  let dueMonth: number | null = null;
  const rawMonth = (input.dueMonth ?? "").trim();
  if (cadence === "monthly") {
    if (rawMonth) return { ok: false, error: "A monthly bill comes every month — no need to pick one." };
  } else {
    if (!/^\d{1,2}$/.test(rawMonth)) {
      return {
        ok: false,
        error: cadence === "annual"
          ? "Which month does it land in?"
          : "Which month does the first one land in? The rest follow every three months.",
      };
    }
    dueMonth = Number(rawMonth);
    if (dueMonth < 1 || dueMonth > 12) return { ok: false, error: "That isn't a month." };
  }

  const rawDay = (input.dueDay ?? "").trim();
  if (!/^\d{1,2}$/.test(rawDay)) {
    return { ok: false, error: "Give a day of the month — just the number." };
  }
  const dueDay = Number(rawDay);
  if (dueDay < 1 || dueDay > 28) {
    return {
      ok: false,
      // The 28 is not arbitrary and saying why stops it reading as a bug.
      error: "Pick a day between 1 and 28 — we stop at the 28th so every month has one, February included.",
    };
  }

  let typical: number | null = null;
  const rawAmount = (input.typicalAmount ?? "").trim();
  if (rawAmount) {
    const n = Number(rawAmount.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n)) return { ok: false, error: "That amount isn't a number." };
    if (n <= 0) {
      return { ok: false, error: "Leave it blank if you don't know what it usually comes to — 0 isn't an amount." };
    }
    if (n > 1_000_000) return { ok: false, error: "That amount looks like a typo." };
    typical = Math.round(n * 100) / 100;
  }

  const label = (input.label ?? "").trim();
  if (label.length > 60) {
    return { ok: false, error: "That name is a bit long — keep it under 60 characters." };
  }

  return {
    ok: true,
    row: {
      category,
      due_day: dueDay,
      due_month: dueMonth,
      typical_amount: typical,
      label: label || null,
      cadence,
      active: true,
    },
  };
}
