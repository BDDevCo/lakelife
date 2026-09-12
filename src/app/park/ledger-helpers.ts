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

/**
 * THE WAYS MONEY ARRIVES BY HAND — one list, read by every door that keys it.
 *
 * `card` and `ach` are deliberately NOT here. Those two are processor rails:
 * 0108 refuses a row on either with no processor reference, 0142 refuses ever
 * to reverse one, and the statement screen offers only "Refund to card" on
 * them — all three on the assumption that a machine recorded it. A bank push
 * the office keys is `transfer`, which stays reversible. Only `payRent`
 * writes the other two, with the processor's own reference.
 *
 * It lives here, not in ledger-actions.ts, because a "use server" file can
 * export only async functions — and money-actions.ts had grown its OWN list
 * with the two rails still on it. Two lists, one rule, is how the rent screen
 * refused `ach` while the on-account door took it.
 */
export type HandKeyedMethod = "cash" | "check" | "transfer" | "other";
export const HAND_KEYED: readonly HandKeyedMethod[] = ["cash", "check", "transfer", "other"];
export const PROCESSOR_ONLY =
  "A card or bank-rail payment needs its reference from the processor, and only the " +
  "processor writes one — it can't be keyed by hand. If they pushed the money to " +
  "your bank, record it as a bank transfer.";
/** The one sentence for a method that is not a way money arrives at all. */
export const NOT_A_METHOD = "That isn't a way money arrives.";
/**
 * Why a hand-keyed door refuses a method, BEFORE any insert — or null when the
 * method is one of the four. Every door that takes a method from a browser
 * calls this first — rent (ledger-actions), on-account and deposit
 * (money-actions), and the amenities window (amenity-actions) — so the two
 * rails get the same sentence everywhere. ledger-helpers.test.ts does not
 * take that on trust: it walks src for every park_payments insert with a
 * bare `method,` and requires this call between each insert and the one
 * before it, so the next door in the same file cannot forget. (The
 * amenities door DID, since it was written on 14 Aug 2026, with `card` on
 * its own list and no reference to insert — the DB refused every one.)
 */
export function handKeyedRefusal(method: string): string | null {
  if (method === "card" || method === "ach") return PROCESSOR_ONLY;
  if (!(HAND_KEYED as readonly string[]).includes(method)) return NOT_A_METHOD;
  return null;
}

/**
 * WHY A PAYMENT AMOUNT IS REFUSED, before any door reads or writes — or null.
 *
 * Three refusals, each true of what was typed. "That amount isn't a number"
 * was said of -5 and of 0.004, and neither is not a number. A figure that
 * rounds to no cents (0.004) passes `amount <= 0`, then numeric(10,2) rounds
 * it to 0.00 and park_payments_amount_check (0070) refuses it — so the office
 * read the raw constraint text, or on the rent door "Recorded" about nothing.
 *
 * One rule here because four doors take an amount from a browser: rent
 * (ledger-actions recordPayment), on-account, deposit and deposit return
 * (money-actions), the amenities window (amenity-actions) — and the claim
 * door, where a resident says what they paid. The rent door fixed this alone
 * in one round and the other three kept "isn't a number" for 0 and -5; the
 * walk in ledger-helpers.test.ts now requires every park_payments door to
 * read this and keep no sentence of its own.
 */
export function paymentAmountRefusal(amount: number): string | null {
  if (!Number.isFinite(amount)) return "That payment amount isn't a number.";
  if (amount <= 0) return "That payment amount needs to be more than zero.";
  if (Math.round(amount * 100) === 0) return "That payment amount is less than a cent.";
  return null;
}

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
 * A TENANCY FILED AS PAID SOME OTHER WAY THAN MONTHLY.
 *
 * The run bills months. A row whose `term` is annual, seasonal, weekly or
 * nightly carries a `quoted_amount` that is a rate for THAT term — $3,600 a
 * year, $80 a night — and both charge paths used to bill it as a month's rent
 * without ever reading the column. Naming the lot and the term is the whole
 * fix on the biller's side; the importer that files such a row is another
 * door.
 */
const TERM_WORD: Record<string, string> = {
  annual: "yearly", seasonal: "by the season", weekly: "weekly", nightly: "nightly",
};

/**
 * A TERM PRICED PER STAY, not by any calendar month. The run's sentence
 * (below) and the rent screen's "Open the rent roll" link both branch on
 * it; this is the ONE spelling, so a term added to one list and not the
 * other cannot print "it's priced per stay" followed by a link to change
 * its monthly rent.
 */
export function perStayTerm(term: string): boolean {
  return term === "nightly" || term === "weekly";
}

export function notMonthlySentence(
  rows: readonly { lotNumber: string; term: string }[],
): string {
  if (rows.length === 0) return "";
  const byTerm = new Map<string, string[]>();
  for (const r of rows) {
    const list = byTerm.get(r.term) ?? [];
    if (!list.includes(r.lotNumber)) list.push(r.lotNumber);
    byTerm.set(r.term, list);
  }
  const sentences: string[] = [];
  for (const [term, lots] of byTerm) {
    const word = TERM_WORD[term] ?? `by the ${term}`;
    const who = lots.length === 1
      ? `Lot ${lots[0]} is`
      : `Lots ${lots.slice(0, -1).join(", ")} and ${lots[lots.length - 1]} are`;
    // A yearly or seasonal figure has a monthly answer he can type. A nightly
    // home does not — it is priced per stay, and telling him to set a monthly
    // rent on it would be the wrong instruction.
    //
    // THE DOOR IS NAMED, AND IT IS THE ONE THAT EXISTS. "Set a monthly rent"
    // sent him to type $400 into Edit, which changed the amount and left the
    // term at `annual` — so the run printed this same sentence next month.
    // Changing how a tenancy is paid is Edit on the roll (the term control the
    // edit panel carries), and the monthly figure is his to type — never the
    // yearly one divided by twelve.
    const advice = perStayTerm(term)
      ? "; it's priced per stay, not by the month."
      : " — change how it's paid to monthly from Edit on the roll and type the monthly rent.";
    sentences.push(`${who} filed as paid ${word} — the run bills months only${advice}`);
  }
  return sentences.join(" ");
}

/**
 * "lot 1, lot 2 and lot 7" — or "lot 1, lot 2, lot 6 and 15 more". The run's
 * own shape, named lots not counts, and never twenty numbers in one sentence.
 * The rent screen used to carry a verbatim copy of this; one home now.
 */
export function lotList(ns: readonly string[]): string {
  const named = ns.map((n) => `lot ${n}`);
  if (named.length <= 1) return named.join("");
  if (named.length <= 3) return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return `${named.slice(0, 3).join(", ")} and ${ns.length - 3} more`;
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
    notMonthly?: readonly { lotNumber: string; term: string }[];
  },
): string {
  const lots = lotList;

  // LOUDEST FIRST. An expired window is money stopping; the rest are ordinary.
  if (cause.expired.length > 0) {
    const n = cause.expired.length;
    return (
      `Nothing to bill for ${monthLabel} — ${n} ${n === 1 ? "agreement has" : "agreements have"} ` +
      `run out (${lots(cause.expired)}). Nobody moved out; the paperwork ended. ` +
      `Renew ${n === 1 ? "it" : "them"} and run this again.`
    );
  }
  if (cause.notMonthly && cause.notMonthly.length > 0) {
    return `Nothing to bill for ${monthLabel} — ${notMonthlySentence(cause.notMonthly)}`;
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
 *
 * ONE CLASSIFICATION, TWO DOORS. The run used to sort its skips into four
 * buckets (already billed / window ended / not started / no rent) and the
 * preview into two (already billed / "no total") — so on the morning every
 * one-month agreement lapsed, the preview read "18 skipped — no rent set" on a
 * park where every rent is $400, and disabled the only button that would have
 * reached the run's honest sentence. Both doors now call `classifyForRun`, and
 * the plan carries every bucket by lot name.
 */
export type SkipWhy =
  | "already"      // a live charge for this month exists
  | "expired"      // the agreement window ended before the month began
  | "notYet"       // the agreement window starts after the month ends
  | "movedOut"     // an ended tenancy whose window does not reach the month — somebody left
  | "notMonthly"   // filed as paid yearly / nightly / …; the run bills months only
  | "noRent";      // the statement has no honest total, or a zero one

export interface RunCandidate {
  reservationId: string;
  lotNumber: string;
  /**
   * The statement total. Null when it could not be totalled (no rent set) —
   * never billed as zero. Zero when the stay covers none of the month, or the
   * rent is nought; neither is worth a charge.
   */
  amount: number | null;
  /** The agreement window, half-open. Null when it could not be read. */
  range?: { start: string; end: string } | null;
  /**
   * How the tenancy is paid. NOT NULL in the database (0052), so an absent
   * value here only ever means a caller that did not carry it, and reads as
   * monthly — the only term this run can bill.
   */
  term?: string | null;
  /** `ended` means somebody moved out; its lapsed window is not paperwork running out. */
  status?: string | null;
}

/**
 * Why one tenancy is billed, or why it is not. Pure, and the ONLY place the
 * question is answered — both the preview and the run read this.
 */
export function classifyForRun(
  c: RunCandidate,
  month: string,
  alreadyBilled: ReadonlySet<string>,
): "bill" | SkipWhy {
  if (alreadyBilled.has(c.reservationId)) return "already";
  const monthStart = `${month}-01`;
  const nextMonthStart = `${shiftMonth(month, 1)}-01`;
  if (c.range) {
    // Half-open, like the database: a window ending on the 1st was not here
    // this month at all.
    const outside = c.range.end <= monthStart || c.range.start >= nextMonthStart;
    if (outside && c.status === "ended") return "movedOut";
    if (c.range.end <= monthStart) return "expired";
    if (c.range.start >= nextMonthStart) return "notYet";
  }
  if (c.term != null && c.term !== "monthly") return "notMonthly";
  // A statement with no total is a rent nobody set. Billing it as zero would
  // hide the problem behind a paid charge.
  if (c.amount == null || c.amount === 0) return "noRent";
  return "bill";
}

export interface RunPlan {
  toBill: { reservationId: string; lotNumber: string; amount: number }[];
  skippedAlreadyBilled: number;
  /**
   * Lot names, deduplicated, in read order. A prior term whose SUCCESSOR is
   * billed this month — or already was — appears in none of these: that lot's
   * paperwork did not run out, it was renewed.
   */
  expired: string[];
  notYet: string[];
  noRent: string[];
  notMonthly: { lotNumber: string; term: string }[];
  total: number;
}

export function planRun(
  candidates: readonly RunCandidate[],
  alreadyBilled: ReadonlySet<string>,
  /** The period, YYYY-MM. Needed to tell an ended window from one not started. */
  month: string,
): RunPlan {
  const toBill: RunPlan["toBill"] = [];
  let skippedAlreadyBilled = 0;
  const why = candidates.map((c) => classifyForRun(c, month, alreadyBilled));

  // FIRST PASS: what is billed, and which lots are therefore covered.
  const covered = new Set<string>();
  candidates.forEach((c, i) => {
    if (why[i] === "already") { skippedAlreadyBilled += 1; covered.add(c.lotNumber); }
    else if (why[i] === "bill") {
      toBill.push({ reservationId: c.reservationId, lotNumber: c.lotNumber, amount: c.amount as number });
      covered.add(c.lotNumber);
    }
  });

  // SECOND PASS: the skips worth naming. A renewal leaves the prior row
  // active (renew-actions inserts a successor), so without the `covered`
  // check every January agreement would be "run out" on every run from
  // February onward, forever, on a park where nothing had run out.
  const expired: string[] = [];
  const notYet: string[] = [];
  const noRent: string[] = [];
  const notMonthly: RunPlan["notMonthly"] = [];
  const once = (list: string[], name: string) => { if (!list.includes(name)) list.push(name); };
  candidates.forEach((c, i) => {
    switch (why[i]) {
      case "expired": if (!covered.has(c.lotNumber)) once(expired, c.lotNumber); break;
      case "notYet": if (!covered.has(c.lotNumber)) once(notYet, c.lotNumber); break;
      case "noRent": once(noRent, c.lotNumber); break;
      case "notMonthly":
        if (!notMonthly.some((n) => n.lotNumber === c.lotNumber)) {
          notMonthly.push({ lotNumber: c.lotNumber, term: c.term as string });
        }
        break;
      default: break; // bill, already, movedOut
    }
  });

  return {
    toBill,
    skippedAlreadyBilled,
    expired, notYet, noRent, notMonthly,
    total: round2(toBill.reduce((s, r) => s + r.amount, 0)),
  };
}

export function runSummary(plan: RunPlan, month: string): string {
  // THE RUN'S OWN SENTENCE, from the same buckets. The preview used to say
  // "Nothing to bill." here and leave the reason to a button it had just
  // disabled.
  if (plan.toBill.length === 0) {
    return nothingToBillReason(prettyMonth(month), {
      already: plan.skippedAlreadyBilled,
      expired: plan.expired, notYet: plan.notYet, noRent: plan.noRent,
      notMonthly: plan.notMonthly,
    });
  }
  const parts = [
    `Bill ${plan.toBill.length} ${plan.toBill.length === 1 ? "household" : "households"} for ${prettyMonth(month)} — $${plan.total.toFixed(2)}`,
  ];
  if (plan.skippedAlreadyBilled > 0) parts.push(`${plan.skippedAlreadyBilled} already billed`);
  // Named in the partial line too. Ten renewed and eight not is the likelier
  // morning, and "8 skipped — no rent set" sent him to set eight rents.
  if (plan.expired.length > 0) {
    const n = plan.expired.length;
    parts.push(`${n} ${n === 1 ? "agreement has" : "agreements have"} run out`);
  }
  if (plan.notMonthly.length > 0) parts.push(`${plan.notMonthly.length} not paid monthly`);
  if (plan.noRent.length > 0) parts.push(`${plan.noRent.length} skipped — no rent set`);
  if (plan.notYet.length > 0) {
    const n = plan.notYet.length;
    parts.push(`${n} ${n === 1 ? "starts" : "start"} after this month`);
  }
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
