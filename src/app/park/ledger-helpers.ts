/**
 * WHO OWES, WHO PAID, AND WHO IS ACTUALLY LATE.
 *
 * The last word matters. A charge past its due date is not automatically a
 * late payment — it is a payment nobody has RECORDED yet, and at a park where
 * rent arrives as checks in an envelope those are very different things.
 *
 * THE FIRST THING THIS SOFTWARE EVER TELLS A NEW PARK OWNER MUST NOT BE A
 * FALSE ALARM ABOUT ELEVEN HOUSEHOLDS WHO PAID ON TUESDAY. That is why
 * `parks.office_recording_lag_days` exists — it is how far behind the office
 * typically is, and nothing is called late until the paperwork has had time to
 * catch up. An owner who learns the overdue list is usually wrong stops
 * reading it, and then it is wrong when it matters.
 */

export type ChargeStatus = "open" | "paid" | "void";

export interface Charge {
  id: string;
  lotNumber: string;
  renterName: string | null;
  periodMonth: string;
  dueOn: string;
  amount: number;
  paidTotal: number;
  status: ChargeStatus;
}

export type LedgerState =
  | "paid"
  | "part_paid"
  | "due"        // not yet due, or inside the office's catch-up window
  | "late"       // genuinely past due and past the grace
  | "disputed"   // they say they paid and we have not found it
  | "void"
  | "credit";    // they paid more than the bill

export const LEDGER_LABEL: Record<LedgerState, string> = {
  paid: "Paid",
  part_paid: "Part paid",
  due: "Due",
  late: "Late",
  disputed: "They say they paid",
  void: "Cancelled",
  credit: "In credit",
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The month a charge run bills, as YYYY-MM. */
export function currentPeriod(todayISO: string): string {
  return todayISO.slice(0, 7);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A PERIOD AS A PERSON SAYS IT: "August 2026", never "2026-08".
 *
 * `YYYY-MM` is the right thing to STORE — it sorts, it compares, it keys a
 * unique index. It is the wrong thing to show a park owner on a screen, in an
 * email, or on a receipt a resident carries away. Nobody reads a bill for
 * "2026-08".
 *
 * Every human-facing month goes through here so the two can never drift.
 * Anything that isn't a well-formed period comes back unchanged rather than
 * becoming "Invalid Date" on somebody's statement.
 */
export function prettyMonth(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const name = MONTH_NAMES[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : period;
}

/**
 * The month before / after a period.
 *
 * `/park/rent` was hard-scoped to the current month with no way to reach any
 * other, so a June bill still open in August was structurally invisible — the
 * owner physically holding a July check had to hand-edit the URL. The page
 * already accepted `?month=`; nothing ever linked to it.
 */
export function shiftMonth(period: string, by: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + by;
  const y = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
}

export function balanceOf(c: Charge): number {
  return round2(c.amount - c.paidTotal);
}

/** Days from `a` to `b`, negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * What state a charge is really in.
 *
 * `lagDays` is the park's own estimate of how far behind its paperwork runs.
 * Zero is a legitimate answer for an office that banks the same day.
 */
export function ledgerState(
  c: Charge,
  todayISO: string,
  lagDays: number,
  /**
   * The household says they paid this and nobody has found it yet.
   *
   * DISPUTED OUTRANKS LATE, and that ordering is the whole point. A payment is
   * a two-party event and this ledger records one party; "they paid in cash and
   * nobody clicked yes" and "they paid nothing" are otherwise the same row. An
   * unanswered claim means the two parties disagree, and disagreement is not
   * delinquency — it is a question somebody has to answer.
   *
   * A claim is NOT proof. It does not mark the bill paid, it does not reduce
   * the balance, and it does not go away on its own. It stops the software
   * asserting a default while the question is open.
   */
  hasOpenClaim = false,
): LedgerState {
  if (c.status === "void") return "void";

  // AN OPEN DISAGREEMENT OUTRANKS THE BALANCE, including a settled one.
  //
  // The obvious reading is that a paid bill has nothing to argue about, and it
  // is wrong. When a renter says "that's not what I paid" about a payment the
  // park has already recorded, the balance is zero and the disagreement is
  // total — they are disputing the record itself. Checking the balance first
  // meant that case read as "Paid" and the owner never saw it.
  if (hasOpenClaim) return "disputed";

  const balance = balanceOf(c);
  if (balance < 0) return "credit";
  if (balance === 0) return "paid";

  const overdueBy = daysBetween(c.dueOn, todayISO);
  // Not late until it is past due AND past the office's own catch-up window.
  if (overdueBy > lagDays) return "late";

  return c.paidTotal > 0 ? "part_paid" : "due";
}

/**
 * WHY A CHARGE RUN RAISED NOTHING.
 *
 * The run said "it may already be done" whenever it produced no rows, and it
 * skips a tenancy for four different reasons. Three of them are not that.
 *
 * The one that matters is an ENDED AGREEMENT WINDOW. Nobody moved out, the
 * household is still on the lot, and the rent stops — the failure this ledger
 * calls "the one with no error anywhere". Every agreement filed on the same
 * afternoon under a 3-month cap ends on the same day, so this is a whole-park
 * event, not a one-lot one, and the old sentence would have explained it away
 * on exactly that morning.
 *
 * Named lots, not counts: at 21 lots a number sends him hunting and a list
 * does not.
 */
export function nothingToBillReason(
  monthLabel: string,
  cause: {
    already: number;
    expired: readonly string[];
    notYet: readonly string[];
    noRent: readonly string[];
  },
): string {
  const lots = (ns: readonly string[]) =>
    ns.length <= 3
      ? ns.map((n) => `lot ${n}`).join(", ")
      : `${ns.slice(0, 3).map((n) => `lot ${n}`).join(", ")} and ${ns.length - 3} more`;

  // LOUDEST FIRST. An expired window is money stopping; the rest are ordinary.
  if (cause.expired.length > 0) {
    const n = cause.expired.length;
    return (
      `Nothing to bill for ${monthLabel} — ${n} ${n === 1 ? "agreement has" : "agreements have"} ` +
      `run out (${lots(cause.expired)}). Nobody moved out; the paperwork ended. ` +
      `Renew ${n === 1 ? "it" : "them"} and run this again.`
    );
  }
  if (cause.noRent.length > 0) {
    return (
      `Nothing to bill for ${monthLabel} — no rent is set on ${lots(cause.noRent)}, ` +
      `so there is nothing to charge.`
    );
  }
  if (cause.notYet.length > 0) {
    return (
      `Nothing to bill for ${monthLabel} — ${lots(cause.notYet)} ` +
      `${cause.notYet.length === 1 ? "starts" : "start"} after this month.`
    );
  }
  if (cause.already > 0) {
    const n = cause.already;
    return `Nothing to bill for ${monthLabel} — ${n} ${n === 1 ? "bill is" : "bills are"} already raised.`;
  }
  return `Nothing to bill for ${monthLabel} — nobody is on a lot.`;
}

export interface LedgerRow extends Charge {
  balance: number;
  state: LedgerState;
  /** Days past due. Negative means not due yet. */
  overdueDays: number;
}

export function toRows(
  charges: readonly Charge[],
  todayISO: string,
  lagDays: number,
  /** Charge ids with an unanswered "I paid this" against them. */
  claimedChargeIds: ReadonlySet<string> = new Set(),
): LedgerRow[] {
  return charges.map((c) => ({
    ...c,
    balance: balanceOf(c),
    state: ledgerState(c, todayISO, lagDays, claimedChargeIds.has(c.id)),
    overdueDays: daysBetween(c.dueOn, todayISO),
  }));
}

export interface LedgerSummary {
  billed: number;
  collected: number;
  outstanding: number;
  /** Only what is genuinely late — not everything unpaid. */
  lateAmount: number;
  lateCount: number;
  /** Unpaid but still inside the window. Worth seeing, not worth chasing. */
  dueCount: number;
  paidCount: number;
  creditCount: number;
  /** Past due, but the household says they paid. Needs answering, not chasing. */
  disputedCount: number;
  disputedAmount: number;
}

export function summarise(rows: readonly LedgerRow[]): LedgerSummary {
  const s: LedgerSummary = {
    billed: 0, collected: 0, outstanding: 0,
    lateAmount: 0, lateCount: 0, dueCount: 0, paidCount: 0, creditCount: 0,
    disputedCount: 0, disputedAmount: 0,
  };
  for (const r of rows) {
    // A cancelled charge is not money anybody expected. Counting it as billed
    // would overstate the roll and make every collection rate wrong.
    if (r.state === "void") continue;

    s.billed = round2(s.billed + r.amount);
    s.collected = round2(s.collected + r.paidTotal);
    if (r.balance > 0) s.outstanding = round2(s.outstanding + r.balance);

    if (r.state === "late") { s.lateCount += 1; s.lateAmount = round2(s.lateAmount + r.balance); }
    // Deliberately NOT folded into lateAmount. The moment a disputed bill is
    // counted as arrears, every total downstream — a demand letter, a default
    // notice, an eviction exhibit — asserts a debt that is still a question.
    else if (r.state === "disputed") {
      s.disputedCount += 1;
      // Only the OUTSTANDING part. A dispute about a settled bill adds nothing
      // to a money total, and pretending otherwise would overstate arrears.
      if (r.balance > 0) s.disputedAmount = round2(s.disputedAmount + r.balance);
    }
    else if (r.state === "due" || r.state === "part_paid") s.dueCount += 1;
    else if (r.state === "paid") s.paidCount += 1;
    else if (r.state === "credit") s.creditCount += 1;
  }
  return s;
}

/**
 * The line at the top of the ledger.
 *
 * Leads with LATE, because that is the only part that needs him today, and
 * says nothing at all when nothing is late — an empty state that reads
 * "0 late" trains an owner to skim past the number on the day it isn't zero.
 */
export function ledgerHeadline(s: LedgerSummary, lagDays: number): string {
  if (s.billed === 0) return "Nothing billed yet this month.";

  // A disagreement leads, because it is the only line here that says the
  // software might be wrong about somebody.
  if (s.disputedCount > 0) {
    const n = s.disputedCount;
    const rest = s.lateCount > 0
      ? ` ${s.lateCount} other ${s.lateCount === 1 ? "household is" : "households are"} late — $${s.lateAmount.toFixed(2)}.`
      : "";
    // Nothing outstanding means they are disputing a payment we already
    // recorded, not claiming an unrecorded one. Reporting "$0.00" there reads
    // as a rounding error rather than a disagreement.
    if (s.disputedAmount === 0) {
      return `${n} ${n === 1 ? "household says a payment we've recorded isn't right" : "households say a payment we've recorded isn't right"}.${rest}`;
    }
    return `${n} ${n === 1 ? "household says they've" : "households say they've"} paid and we haven't found it — $${s.disputedAmount.toFixed(2)}.${rest}`;
  }
  if (s.lateCount > 0) {
    return `${s.lateCount} ${s.lateCount === 1 ? "household is" : "households are"} late — $${s.lateAmount.toFixed(2)}.`;
  }
  if (s.outstanding > 0) {
    const grace = lagDays > 0 ? ` Nothing is late yet; you allow ${lagDays} days for the office to catch up.` : "";
    return `$${s.collected.toFixed(2)} of $${s.billed.toFixed(2)} in.${grace}`;
  }
  return `Everything's in — $${s.collected.toFixed(2)}.`;
}

/**
 * What a run WOULD do, before it does it.
 *
 * A charge run is the one action here that touches every household at once, so
 * it is previewed rather than fired. `alreadyBilled` is the set of tenancies
 * that already have a charge for the month — re-running must add nothing,
 * which the unique constraint enforces anyway, but he should see zero rather
 * than trust it.
 */
export interface RunPlan {
  toBill: { reservationId: string; lotNumber: string; amount: number }[];
  skippedAlreadyBilled: number;
  skippedNoTotal: number;
  total: number;
}

export function planRun(
  candidates: readonly {
    reservationId: string;
    lotNumber: string;
    /** Null when the statement could not be totalled — never billed as zero. */
    amount: number | null;
  }[],
  alreadyBilled: ReadonlySet<string>,
): RunPlan {
  const toBill: RunPlan["toBill"] = [];
  let skippedAlreadyBilled = 0;
  let skippedNoTotal = 0;

  for (const c of candidates) {
    if (alreadyBilled.has(c.reservationId)) { skippedAlreadyBilled += 1; continue; }
    // A statement with no total is a rent nobody set. Billing it as zero would
    // hide the problem behind a paid charge.
    if (c.amount == null) { skippedNoTotal += 1; continue; }
    toBill.push({ reservationId: c.reservationId, lotNumber: c.lotNumber, amount: c.amount });
  }

  return {
    toBill,
    skippedAlreadyBilled,
    skippedNoTotal,
    total: round2(toBill.reduce((s, r) => s + r.amount, 0)),
  };
}

export function runSummary(plan: RunPlan, month: string): string {
  if (plan.toBill.length === 0) {
    if (plan.skippedAlreadyBilled > 0) return `${prettyMonth(month)} is already billed — nothing to do.`;
    return "Nothing to bill.";
  }
  const parts = [
    `Bill ${plan.toBill.length} ${plan.toBill.length === 1 ? "household" : "households"} for ${prettyMonth(month)} — $${plan.total.toFixed(2)}`,
  ];
  if (plan.skippedAlreadyBilled > 0) parts.push(`${plan.skippedAlreadyBilled} already billed`);
  if (plan.skippedNoTotal > 0) parts.push(`${plan.skippedNoTotal} skipped — no rent set`);
  return parts.join(" · ");
}

/**
 * WHICH DAY THIS HOUSEHOLD'S RENT IS DUE.
 *
 * `lot_reservations.due_day` is written by the tenant-edit form, shown on the
 * rent roll, and was read by NOTHING that raises a bill — both charge paths
 * used `parks.rent_due_day` for everybody. So an owner who set lot 7 to the
 * 10th because that household is paid mid-month saw "due the 10th" on the
 * roll, and every bill went out due on the 1st. Worse than cosmetic: lateness
 * is measured from the charge's own `due_on`, so that household was chased
 * nine days early, every month, for a concession he thought he had granted.
 *
 * NULL MEANS FOLLOW THE PARK, and that is why the importer no longer copies
 * the park's day onto all nineteen rows. A copy is not a default: it goes
 * stale the moment he changes the dial, and every household would have kept
 * the old day while the screen showed the new one.
 */
export function dueDayFor(
  tenancyDueDay: unknown,
  parkDueDay: number,
): number {
  const own = Number(tenancyDueDay);
  return Number.isFinite(own) && own >= 1 && own <= 31 ? own : parkDueDay;
}
