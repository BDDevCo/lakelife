/**
 * TODAY — what a park owner needs at 7am with a phone in one hand.
 *
 * THE HARD FACT ABOUT A 21-LOT PARK IS THAT IT HAS NO VOLUME. Nineteen rents
 * arrive in the first five days of the month and nothing arrives for the other
 * twenty-five. Tenancy changes happen maybe three times a YEAR. Every dashboard
 * convention worth copying was designed for volume, and none of them survive
 * here.
 *
 * So three rules shape everything below:
 *
 *   MONTH-TO-DATE IS THE HEADLINE, not today. He asked for a daily tally and
 *   the honest version of it is a running month total with today as a sub-line
 *   that disappears when nothing came in. A "today" figure at this park is zero
 *   twenty-five days out of thirty, and a number that is usually zero teaches
 *   him to stop looking.
 *
 *   COUNTS, NOT PERCENTAGES. At 21 lots one move-out swings occupancy by 4.8
 *   points. "90%" is a disguised count with a step size bigger than anything he
 *   could act on, and it invites comparison against industry figures computed on
 *   thousands of pads.
 *
 *   MOST DAYS NOTHING IS WRONG. That is the normal state, and a screen that
 *   looks broken or empty when nothing is wrong gets abandoned inside a month.
 *   The quiet state says what was CHECKED, so silence reads as "I looked" rather
 *   than "I'm not working".
 */

import type { LedgerRow, LedgerSummary } from "./ledger-helpers";
// THE ONE money() — this file kept a private copy with the same body while
// importing three other things from the same module. One formatter, so the
// morning card and the rent screen cannot print one figure two ways.
import { ledgerHeadline, prettyMonth, money } from "./ledger-helpers";
import { SIGNED_LEASE_LABEL } from "./sign-helpers";
import { dayInWords, lapsedRowOf } from "./park-helpers";
// THE RENEWAL LEAD HAS ONE HOME. The card below and the "Agreements to write"
// list it links to (renew-actions renewalsDue) both read renewalLeadDays, so
// the card can never name a household the list keeps quiet about.
import { renewalLeadDays, addMonths } from "./agreement-helpers";
import { billPeriod, type BillPeriod, type Cadence } from "./cost-helpers";
import { periodIsBillable, preCutoverCostRefusal, firstBillablePeriod } from "@/lib/billing-start";
import { parseDaterange } from "@/lib/parks";

// Notification thresholds, not pricing — so they live here rather than in the
// database. The first time he says one of these numbers is wrong, it becomes a
// park column.
/**
 * How far ahead a household that has GIVEN NOTICE is a lot to start showing.
 * Its own number: this used to share the renewal card's flat 45 days, and the
 * renewal lead is no longer a constant at all (R2 — an agreement is asked for
 * renewal in its own last half; see agreement-helpers renewalLeadDays).
 */
export const MOVE_OUT_LEAD_DAYS = 45;
export const NOTICE_WARN_DAYS = 7;
export const BILL_WARN_DAYS = 3;
/**
 * How much warning a recurring bill gets before "due about now" is true.
 *
 * 28, so that MONTHLY behaviour is untouched — the longest gap between the
 * start of a monthly period and its due day is 27 (due on the 28th, seen on
 * the 1st). Quarterly and annual schedules used to claim "due about now" from
 * the first day of their period, which for the property tax was 313 days out.
 */
export const BILL_DUE_LEAD_DAYS = 28;

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

// ------------------------------------------------------------- the money ---

export interface MoneyBlock {
  /** The running total for the month, in prose. Never a bare "$0.00". */
  headline: string;
  /** Today's cash. Null when nothing came in — omitted rather than zeroed. */
  todayLine: string | null;
  /** The month's billing position, reusing the ledger's own words. */
  ledgerLine: string;
  /** Older months still open. The single-month ledger structurally can't see these. */
  arrearsLine: string | null;
  /**
   * Old bills somebody is DISPUTING. Deliberately its own line: these used to
   * be inside the arrears figure, which made "go and chase this" include money
   * a household says they already handed over. Taking them out of arrears
   * without saying so would be the opposite mistake — they would vanish.
   */
  disputedLine: string | null;
  /**
   * Cash that came in this month with NO BILL BEHIND IT — a deposit, money on
   * account, or something the park rented out.
   *
   * Its own line for the same reason the disputed one is: the headline is
   * every dollar that hit the bank, and the ledger line under it counts bills
   * only. Without a sentence naming the difference the two disagree and he
   * cannot tell which is wrong.
   */
  offBookLine: string | null;
}

/**
 * WHICH SIDE OF THE MONEY LINE A PAYMENT IS ON — ONE RULE, BOTH BUCKETS.
 *
 * Today splits the money that arrived in two: RECEIPTS, which are payments
 * against a bill and take every label they carry off that bill (lot, month,
 * bill total, bill status), and OFF-BOOK, which is everything with no live
 * bill behind it — a deposit, amenity income, rent handed over before its
 * bill exists, and money released by a cancelled one.
 *
 * The two used to be `charge_id != null` and `charge_id == null`, written a
 * few lines apart, and that disagreed with the ledger: 0169's whole model is
 * that a payment released by a CANCELLED bill KEEPS its charge_id — the row
 * never moves, the release is derived — so `park_on_account_payments` lists
 * it as money on account, the held panel counts it and the household's own
 * screen shows it, while Today counted it as a receipt against a bill that no
 * longer exists and left it out of the money-on-account line. One definition,
 * two answers, on the screen he opens with coffee.
 *
 * It is ONE function and not two filters because the two must be exact
 * complements: a payment counted on both sides is counted twice in the
 * month-to-date figure, which is the number he ties to a bank statement.
 *
 * A charge id whose row this screen could not find is a receipt, as it always
 * was — "there is a bill and we cannot see it" is not the same fact as "there
 * is no bill", and only the second is money on account.
 */
export type MoneySide = "receipt" | "offBook";

export function sideOfPayment(chargeId: string | null, chargeStatus: string | null | undefined): MoneySide {
  if (chargeId == null) return "offBook";
  // The view's own last clause: `p.charge_id is null or c.status = 'void'`.
  return chargeStatus === "void" ? "offBook" : "receipt";
}

/** What each kind of billless money actually is, in his words. */
const OFF_BOOK_WHAT: Record<string, string> = {
  // Count-agnostic on purpose: the caller passes which KINDS are present, not
  // how many rows, so none of these may commit to a singular.
  deposit: "deposit money you're holding",
  amenity: "income from something the park rents out",
  // WHAT IS STILL ON ACCOUNT, as the held panel and the household's own
  // screen count it — the view's `remaining`, never the amount that arrived.
  // Counted at arrival, this line said "$1,685.06 of that is money on
  // account" on a morning the held panel said $1,142.53 and the card's own
  // gap was $1,142.53: the sentence whose whole job is to explain the gap
  // was $542.53 wrong about it, because the part already spent on a bill was
  // counted here AND in the rent line. One definition, three screens.
  rent: "money on account — what's still held of what came in this month",
};

/** Name the kinds present, in a fixed order so the sentence never reshuffles. */
export function describeOffBook(kinds: readonly string[]): string {
  const seen = ["deposit", "amenity", "rent"].filter((k) => kinds.includes(k));
  const words = seen.map((k) => OFF_BOOK_WHAT[k]);
  if (words.length === 0) return "not rent against a bill";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * HOW MANY HOUSEHOLDS A SET OF BILLS BELONGS TO — one lot is one household,
 * the convention the money card has always used. The arrears TASK counted
 * rows (one per bill) while the money card two lines above it counted lots,
 * so a household with January and February open read "2 households owe"
 * beside "1 household" on the screen he reads with coffee. One helper, both
 * readers.
 */
export function householdsIn(rows: readonly { lotNumber: string }[]): number {
  return new Set(rows.map((r) => r.lotNumber)).size;
}

/**
 * THE LOTS STILL ON THE SELLER'S ARRANGEMENT — and not the ones that have
 * already signed.
 *
 * A signing (sign-actions) never rewrites the holdover: it TRIMS the
 * grandfathered row to end on the signing day and writes the new lease as
 * the next link in the same chain, approved, from that day. So on 20
 * December a household who signed on the 10th for 1 January is still LIVING
 * on the grandfathered row — current, origin `grandfathered` — with their
 * signed lease held one link later. Filtering on origin and today alone
 * listed them under "haven't signed the new lease" for the rest of the
 * month, with the card pointing at a button that would refuse them.
 *
 * `latestSeqInChain` is the loader's own map (the one the renewal card's
 * `hasSuccessor` reads): the highest agreement_seq in each chain, across
 * the held rows AND the ended ones — a signed lease the household was
 * later closed out of is still a later link, and the trimmed holdover
 * before it must not come back as "hasn't signed" the day they leave. A
 * holdover whose chain carries a later link has signed; it is left off.
 * Sorted numerically by lot, as the card prints it.
 *
 * A HOLDOVER THAT RAN OUT IS STILL A HOLDOVER. The date filter is `start <=
 * today` and nothing about the end: a grandfathered row whose range has
 * lapsed with no later link in its chain has STILL not signed the new lease,
 * and on 1 January — the morning every one of them is meant to have signed —
 * the `today < end` half read the whole roll as "everybody signed" the moment
 * their old ranges expired. The lapsed-tenancy build relies on this count.
 */
export function holdoverLotsOf(
  stays: readonly {
    park_lot_id: string;
    during: string;
    origin: string | null;
    agreement_chain_id: string | null;
    agreement_seq: number | null;
  }[],
  today: string,
  latestSeqInChain: ReadonlyMap<string, number>,
  lotNumber: (lotId: string) => string,
): string[] {
  return stays
    .filter((s) => s.origin === "grandfathered")
    .filter((s) => {
      const r = parseDaterange(s.during);
      return r != null && r.start <= today;
    })
    .filter((s) => {
      const cid = s.agreement_chain_id;
      const seq = s.agreement_seq ?? 1;
      return !(cid != null && (latestSeqInChain.get(cid) ?? 0) > seq);
    })
    .map((s) => lotNumber(s.park_lot_id))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function moneyBlock(input: {
  /** EVERY dollar received this month, bill or no bill. */
  monthToDateCents: number;
  todayCents: number;
  /**
   * MONEY THAT WENT BACK OUT ACROSS THE COUNTER — handed back (0168) or a
   * deposit returned, by the day it went. On the morning the office recorded
   * "$70.00 handed back on January 27, 2027" this screen still read "$50.00
   * came in today" and nothing anywhere said the drawer was $20.00 down.
   */
  handedBackMonthCents?: number;
  handedBackTodayCents?: number;
  /** The part of monthToDateCents with no charge behind it. */
  offBookCents?: number;
  /** Which kinds that part is made of, for the sentence. */
  offBookKinds?: readonly string[];
  monthSummary: LedgerSummary;
  lagDays: number;
  /** Open charges from months BEFORE this one, EXCLUDING disputed ones. */
  arrears: readonly LedgerRow[];
  /** Older open charges with an unanswered "I paid this" against them. */
  disputedOlder?: readonly LedgerRow[];
  today: string;
}): MoneyBlock {
  const {
    monthToDateCents, todayCents, monthSummary, lagDays, arrears,
    disputedOlder = [], today, offBookCents = 0, offBookKinds = [],
    handedBackMonthCents = 0, handedBackTodayCents = 0,
  } = input;

  // WHAT CAME IN, AND WHAT WENT BACK OUT. The headline is every dollar
  // received — the figure he ties to a bank statement — so a hand-back is
  // its own clause rather than a subtraction nobody can see.
  const headline = (monthToDateCents === 0
    ? "Nothing has come in yet this month."
    : `${money(monthToDateCents / 100)} in so far this month.`)
    + (handedBackMonthCents > 0 ? ` ${money(handedBackMonthCents / 100)} has been handed back.` : "");

  // Omitted, not zeroed. Twenty-five days a month this line would read $0.00
  // and mean nothing at all — but a day money went BACK out is never a quiet
  // one, even with nothing taken in.
  const net = todayCents - handedBackTodayCents;
  const todayLine = todayCents === 0 && handedBackTodayCents === 0
    ? null
    : handedBackTodayCents === 0
      ? `${money(todayCents / 100)} came in today.`
      : todayCents === 0
        ? `${money(handedBackTodayCents / 100)} went back out today, and nothing came in.`
        : `${money(todayCents / 100)} came in today and ${money(handedBackTodayCents / 100)} went back out — `
          + (net > 0 ? `${money(net / 100)} net in.` : net < 0 ? `${money(-net / 100)} net out.` : "nothing in net.");

  let arrearsLine: string | null = null;
  if (arrears.length > 0) {
    const total = arrears.reduce((s, r) => s + r.balance, 0);
    const lots = householdsIn(arrears);
    const oldest = arrears.reduce((m, r) => (r.dueOn < m ? r.dueOn : m), arrears[0].dueOn);
    arrearsLine =
      `${money(total)} still owing from earlier months — ` +
      `${lots} ${lots === 1 ? "household" : "households"}, oldest due ${dayInWords(oldest)} ` +
      `(${daysBetween(oldest, today)} days).`;
  }

  let disputedLine: string | null = null;
  if (disputedOlder.length > 0) {
    const total = disputedOlder.reduce((s2, r) => s2 + r.balance, 0);
    const n = householdsIn(disputedOlder);
    disputedLine =
      `${money(total)} from earlier months is disputed — ` +
      `${n} ${n === 1 ? "household says they" : "households say they"} already paid. ` +
      `That is a conversation, not arrears.`;
  }

  // THE SENTENCE BETWEEN THE TWO NUMBERS. "The rent line below counts bills
  // only" was true and still left the two figures unreconciled: that line is
  // scoped to ONE month, so money that went against an earlier month's bill
  // is in neither it nor this clause. Saying which month it counts is the
  // half that was missing.
  const offBookLine = offBookCents > 0
    ? `${money(offBookCents / 100)} of that is ${describeOffBook(offBookKinds)}. ` +
      `The rent line below counts this month's bills only.`
    : null;

  return {
    headline,
    todayLine,
    ledgerLine: ledgerHeadline(monthSummary, lagDays),
    arrearsLine,
    disputedLine,
    offBookLine,
  };
}

// --------------------------------------------------------- the lots ------

export interface OccupancySnapshot {
  /** Lots that are live — planned and retired ones are not inventory yet. */
  liveLots: number;
  occupied: number;
  reserved: number;
  vacant: number;
  vacantLotNumbers: string[];
}

/**
 * Occupancy in counts, and vacant lots BY NAME while there are few enough to
 * name. "3 empty" sends him to another screen; "lots 7, 12 and 19 are empty" is
 * the actual answer.
 */
export function occupancyLine(s: OccupancySnapshot): { main: string; sub: string | null } {
  if (s.liveLots === 0) {
    return { main: "No lots set up yet.", sub: null };
  }
  const filled = s.occupied + s.reserved;

  // NOT "nothing is collectable yet": the Take a payment button on every park
  // screen records a deposit or a cheque on account with no bill open
  // (recordOnAccount), and this line sits beneath it.
  if (s.occupied === 0 && s.reserved > 0) {
    return {
      main: `${s.reserved} of ${s.liveLots} lots spoken for.`,
      sub: "Their tenancies start later — anything handed in now goes on account.",
    };
  }

  const main = `${filled} of ${s.liveLots} lots taken.`;
  if (s.vacant === 0) return { main, sub: "Nothing empty." };
  // Above five, naming them is a list rather than an answer.
  const sub = s.vacant <= 5
    ? `Empty: ${s.vacantLotNumbers.map((l) => `lot ${l}`).join(", ")}.`
    : `${s.vacant} empty.`;
  return { main, sub };
}

// ----------------------------------------------------------- the to-dos ---

export type TaskUrgency = "overdue" | "soon" | "whenever";

export interface Task {
  /**
   * Stable across days so a snooze sticks, and DIFFERENT per period so
   * dismissing December's does not hide January's.
   */
  key: string;
  title: string;
  detail: string;
  urgency: TaskUrgency;
  /** The date it stops being optional. Null for standing work. */
  dueOn: string | null;
  href: string;
  /** Some things must not be dismissible. Money owed is one of them. */
  canDismiss: boolean;
}

export interface TaskFacts {
  today: string;
  parkId: string;
  currentMonth: string;
  rentDueDay: number;
  /** Agreements ending, with whether a successor already exists. */
  agreements: {
    reservationId: string;
    lotNumber: string;
    /** Who the agreement is with — the key `onAccountHeld` is counted per. */
    renterId?: string | null;
    renterName: string | null;
    /**
     * The agreement's own start — the lead is a function of its span
     * (renewalLeadDays), so the card needs both ends of it. A one-month
     * agreement is asked in its last ~15 days, a three-month one 45 out.
     */
    startsOn: string;
    endsOn: string;
    chainId: string | null;
    seq: number;
    hasSuccessor: boolean;
    /**
     * WHAT THE PARK IS STILL HOLDING FOR THIS HOUSEHOLD — the view's
     * `remaining` (0167), the same figure the held panel and their own screen
     * print, and zero for a household holding nothing.
     *
     * A LAPSED AGREEMENT STRANDS THE MONEY. Money on account comes off the
     * next bill raised, and no bill is ever raised for a household whose
     * paperwork ran out — so two households sat holding $542.53 each with
     * nothing on any screen tying the held money to the reason it was stuck.
     * The hand-back card covers households who LEFT; these had not left.
     */
    onAccountHeld?: number;
  }[];
  /** True when this month's charges have already been raised. */
  monthBilled: boolean;
  liveOccupiedLots: number;
  lateCount: number;
  lateAmount: number;
  disputedCount: number;
  /**
   * EARLIER MONTHS STILL OPEN — and the reason this exists at all.
   *
   * `lateCount`/`lateAmount` are computed from THIS MONTH's charges only, and
   * the task they generate is keyed on the current month. At midnight on the
   * 1st the unpaid July bill left the window, the task vanished, and no
   * successor was ever generated for it — the one surface designed to be
   * non-dismissible about money owed stopped mentioning it. At nineteen
   * households a single skipped month is roughly $2,700 that quietly left the
   * to-do list.
   *
   * Separate from `lateCount` rather than merged into it: this month's late
   * rent and last month's unpaid rent are different things to do about, and the
   * money block already keeps them apart on screen.
   */
  arrearsCount: number;
  arrearsAmount: number;
  /**
   * The oldest month still open, so the card can land on THAT month's rent
   * screen. `/park/rent` alone opens the current month, where the oldest open
   * bill is structurally invisible (getLedger is scoped to one period) — the
   * "Sort it" button on an arrears card was a door onto a screen that could
   * not show the debt. Null only when there is nothing in arrears.
   */
  arrearsOldestMonth: string | null;
  /** Costs entered but never split across lots — they bill nobody. */
  unallocatedCosts: { id: string; label: string; amount: number }[];
  /**
   * Households still on the arrangement they already had, with no new lease
   * signed. Named by lot, because chasing a signature is a door-knock not a
   * query.
   */
  holdoverLots: string[];
  /** Rent changes whose notice period is about to make the date impossible. */
  pendingRentChanges: {
    id: string; lotNumber: string; effectiveOn: string;
    noticeDaysRequired: number; noticeServedOn: string | null;
  }[];
  /**
   * Households who have said they are leaving, and haven't yet.
   *
   * `giveNotice` has written `expected_move_out` since 0101 and NOTHING has
   * ever read it — the action had no caller either, so the whole feature was
   * two columns and a validated write into the dark. Its own docstring says
   * what it was for: "two weeks of warning is the difference between showing a
   * lot and discovering a vacancy." This is that warning.
   */
  noticed: {
    reservationId: string;
    lotNumber: string;
    renterName: string | null;
    leavingOn: string;
  }[];
  /**
   * Recurring bills, at most one entry per schedule: its OLDEST period that
   * nobody has entered (`oldestUnansweredBill`, which the loader calls).
   *
   * The Haven's sewer is 82% of everything the park spends on its residents'
   * behalf, and it arrives monthly. Miss it and nineteen households are never
   * billed their share — invisibly, because a cost nobody entered leaves no
   * trace. `typical` is a HINT so a wrong invoice is noticeable; it is never
   * billed and never written to park_costs.
   *
   * THIS USED TO BE TODAY'S PERIOD ALONE, so a bill he never entered stopped
   * being mentioned the moment its period rolled — twenty-eight days for the
   * sewer, and then gone with the debt. When January's is entered the next
   * unanswered period takes its place, the way arrears names the oldest open
   * month.
   */
  billsDue: {
    scheduleId: string;
    category: string;
    label: string;
    /** The period this is due FOR — a month, a quarter, or a year. */
    periodKey: string;
    periodLabel: string;
    /**
     * The first day of that period (`billPeriod`'s `from`), ISO. This is the
     * month the go-live gate compares — the same month the cost door compares
     * (`period_start`) — so the reminder and the door cannot disagree about
     * whether a bill is ours.
     */
    periodFrom: string;
    dueOn: string;
    typical: number | null;
    /**
     * 0170: the schedule says the bill is FOR the period before its due
     * date. periodFrom/periodKey/periodLabel are then the COVERED period;
     * dueOn is still the real due date.
     */
    coversPriorPeriod: boolean;
  }[];
  /**
   * MONEY THE PARK HOLDS FOR A HOUSEHOLD THAT HAS LEFT — on account with
   * their final month already billed (so no bill will ever take it), or a
   * deposit still held. Fed from the same read as the held-money panel
   * (getHeldMoney), so the two cannot disagree about whose money it is.
   * The task it raises is not dismissible: the quiet state must not print
   * over a liability.
   */
  heldForDeparted: {
    renterId: string;
    renterName: string;
    /** YYYY-MM-DD — the last day they lived here. */
    movedOutOn: string;
    /**
     * Whether the month they left in is billed for them (getHeldMoney's own
     * fact, carried per household). On-account money is listed only when it
     * is; a deposit is listed as soon as they have gone, and the card's
     * sentence branches on this — "nothing more bills for them" is a promise
     * the run is about to break when it is false.
     */
    finalMonthBilled: boolean;
    onAccount: number;
    depositsHeld: number;
  }[];
  /**
   * The park's go-live date, or null when there is no restriction.
   *
   * REQUIRED, NOT OPTIONAL, on purpose: a caller that forgets it would get a
   * reminder list with no go-live gate and nothing would say so. Bills for a
   * period that began before go-live are not ours (`periodIsBillable`) — the
   * seller's tax is a credit at the closing table, never a park_costs row —
   * so the reminder for them is never raised. Handed in as the date rather
   * than pre-filtered, so the rule sits next to the card it governs and the
   * tests can pin it.
   */
  cutoverOn: string | null;
}

/**
 * THE OLDEST PERIOD OF A RECURRING BILL THAT NOBODY HAS ENTERED.
 *
 * WHAT WENT WRONG. The morning loader asked `billPeriod` about TODAY and
 * nothing else, so the reminder's key rolled with the calendar and took the
 * debt off the list with it. January's sewer bill was a red, undismissable
 * "still isn't entered" card for exactly twenty-eight days, and on 1 March it
 * was simply gone — the same defect the arrears card was rewritten to fix,
 * and the comment below this one ("it stays until the bill is entered")
 * promised the opposite. Two tests pinned the promise, on fixtures the loader
 * could never produce: the furthest a real `dueOn` could be in the past was
 * fifty-one days. Nothing else in the product ever says a scheduled bill is
 * missing — the nightly reconciler names unbilled RENT months only — so a
 * bill he missed in one month was never mentioned again by anything, and an
 * unentered cost is in nobody's books and nobody's fee comparison.
 *
 * ONE CARD PER SCHEDULE, NAMING THE OLDEST. Emitting every unanswered period
 * would pile undismissable cards on the screen, which is the precise failure
 * the 28-day lead clip and the unallocated-cost filters were written to
 * prevent. So this mirrors arrears: the oldest open one, and the next
 * appears when that one is entered.
 *
 * THE KEY STILL NAMES THE PERIOD. Keyed on the schedule alone the card would
 * persist, but a "not this week" taken over January's bill would also
 * silence February's — a different bill. The period in the key means a snooze
 * dies with the period it was taken about, and a tax bill is still one task a
 * year.
 *
 * THE FLOOR IS THE CALLER'S, and it is three facts at once: a period before
 * go-live is not ours to ask about, a period before the schedule was created
 * was never expected, and a period older than the costs the caller read
 * cannot be judged answered or not. The caller takes the latest of the three.
 * The period today sits in is always considered, floor or no floor, because
 * that is the one the go-live gate downstream has its own sentence for.
 *
 * `billPeriod` reads only the year and month of the date it is handed, so the
 * walk probes the 1st of each earlier month and the day never matters; it
 * steps a MONTH at a time rather than a cadence at a time so this file holds
 * no second copy of how long a quarter is — billPeriod names the period and a
 * repeated key says we are still inside it.
 */
export function oldestUnansweredBill(input: {
  cadence: Cadence;
  dueMonth: number | null;
  dueDay: number;
  coversPriorPeriod: boolean;
  today: string;
  floor: string;
  answered: (p: BillPeriod) => boolean;
}): BillPeriod | null {
  const { cadence, dueMonth, dueDay, coversPriorPeriod, today, floor, answered } = input;
  const at = (iso: string) => billPeriod(cadence, dueMonth, dueDay, iso, coversPriorPeriod);

  const current = at(today);
  let oldest: BillPeriod | null = answered(current) ? null : current;

  const seen = new Set<string>([current.key]);
  let probe = `${today.slice(0, 7)}-01`;
  while (probe >= floor) {
    probe = addMonths(probe, -1);
    const p = at(probe);
    // Compared on the period's own first day — the same thing the go-live
    // gate compares downstream, so the walk and the gate cannot disagree.
    if (p.from < floor) break;
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    if (!answered(p)) oldest = p;
  }
  return oldest;
}

function rank(u: TaskUrgency): number {
  return u === "overdue" ? 0 : u === "soon" ? 1 : 2;
}

/**
 * THE MONEY A LAPSED AGREEMENT STRANDS — how many households, and how much.
 *
 * Money on account comes off the NEXT bill raised (0167), and a household
 * whose paperwork has run out is raised no bill at all: the run skips them by
 * name. So two households sat holding $542.53 each, on a morning the held
 * panel listed both and no card anywhere tied the money to the reason it was
 * stuck. The hand-back card is for households who LEFT; these had not left,
 * and nobody was going to hand this back.
 *
 * Per HOUSEHOLD, not per agreement: `onAccountHeld` is the renter's total
 * across the park, so a household with two lapsed links in one chain would
 * otherwise have its money counted twice. Lots with no renter on the row are
 * skipped rather than pooled under one blank key.
 */
function strandedOnAccount(
  lapsed: readonly { renterId?: string | null; onAccountHeld?: number }[],
): { households: number; cents: number } {
  const per = new Map<string, number>();
  for (const a of lapsed) {
    const held = Math.round((a.onAccountHeld ?? 0) * 100);
    if (!a.renterId || held <= 0) continue;
    per.set(a.renterId, held);
  }
  let cents = 0;
  for (const c of per.values()) cents += c;
  return { households: per.size, cents };
}

/** The same fact as a sentence, and silence when there is no money stuck. */
function strandedClause(s: { households: number; cents: number }): string {
  if (s.households === 0 || s.cents <= 0) return "";
  return s.households === 1
    ? ` ${money(s.cents / 100)} of theirs is on account with no bill to come off.`
    : ` ${s.households} of them are holding ${money(s.cents / 100)} between them, with no bill for it to come off.`;
}

export function generateTasks(f: TaskFacts): Task[] {
  const out: Task[] = [];

  // MONEY OWED. Always aggregate — nineteen separate "chase lot 4" cards is a
  // list nobody reads — and never dismissible, because the software must not
  // offer to stop mentioning money.
  // EARLIER MONTHS, ON THEIR OWN CARD AND WITH A KEY THAT DOES NOT EXPIRE.
  //
  // `late_rent` is keyed on the current month so it can be raised afresh each
  // month. Arrears must not be: the whole defect was a task whose key rolled
  // over and took the debt off the list with it. This one is keyed on the park
  // alone, so it persists until the money does not.
  if (f.arrearsCount > 0) {
    out.push({
      key: `arrears:${f.parkId}`,
      title: `${f.arrearsCount} ${f.arrearsCount === 1 ? "household owes" : "households owe"} from earlier months`,
      detail: f.arrearsOldestMonth
        ? `${money(f.arrearsAmount)} still outstanding from before ${prettyMonth(f.currentMonth)} — the oldest is ${prettyMonth(f.arrearsOldestMonth)}.`
        : `${money(f.arrearsAmount)} still outstanding from before ${prettyMonth(f.currentMonth)}.`,
      urgency: "overdue",
      dueOn: null,
      // The rent screen takes `?month=` (rent/page.tsx); without it the door
      // opens on the current month and the oldest open bill is not on it.
      href: f.arrearsOldestMonth ? `/park/rent?month=${f.arrearsOldestMonth}` : "/park/rent",
      canDismiss: false,
    });
  }

  if (f.lateCount > 0) {
    out.push({
      key: `late_rent:${f.parkId}:${f.currentMonth}`,
      title: `${f.lateCount} ${f.lateCount === 1 ? "household is" : "households are"} late`,
      detail: `${money(f.lateAmount)} outstanding past your catch-up window.`,
      urgency: "overdue",
      dueOn: null,
      href: "/park/rent",
      canDismiss: false,
    });
  }

  // A DISAGREEMENT OUTRANKS ARREARS, because it is the one that says the
  // software might be wrong about somebody.
  if (f.disputedCount > 0) {
    out.push({
      key: `disputed:${f.parkId}:${f.currentMonth}`,
      title: `${f.disputedCount} ${f.disputedCount === 1 ? "household disagrees" : "households disagree"} with the ledger`,
      detail: "Nothing is being chased on those until you've looked.",
      urgency: "overdue",
      dueOn: null,
      href: "/park/rent",
      canDismiss: false,
    });
  }

  // MONEY TO HAND BACK. A household has left and the park is still holding
  // money of theirs — on account, where no bill will ever take it now, or a
  // deposit. Never dismissible: the software must not offer to stop
  // mentioning money it owes somebody. One card per household, named — at
  // twenty-one lots that is the answer, not a list.
  //
  // "NOTHING MORE BILLS FOR THEM" IS SAID ONLY WHEN IT IS TRUE. The loader
  // lists on-account money only once the month they left in is billed, but a
  // deposit as soon as they have gone — and a move-out closed out on the 2nd,
  // before the office presses Bill February, still gets its two-day
  // part-month from that run. The card used to promise "nothing more bills"
  // over that deposit; the office handed it back, and the arrears task then
  // chased a household that had gone. Now the card names the bill still to
  // come, and which button raises it.
  for (const h of f.heldForDeparted) {
    const acct = Math.round(h.onAccount * 100) / 100;
    const dep = Math.round(h.depositsHeld * 100) / 100;
    if (acct <= 0 && dep <= 0) continue;
    const what = [
      acct > 0 ? `${money(acct)} on account` : "",
      dep > 0 ? `${money(dep)} deposit` : "",
    ].filter(Boolean).join(" and ");
    const left = `they moved out ${dayInWords(h.movedOutOn)}`;
    const bills = h.finalMonthBilled
      ? `${left} and nothing more bills for them.`
      : `${left}; their final month isn't billed yet — it's raised when you bill ` +
        `${prettyMonth(h.movedOutOn.slice(0, 7))}${acct > 0 ? ", which takes anything on account first" : ""}.`;
    out.push({
      key: `hand_back:${h.renterId}`,
      title: `Money to hand back — ${h.renterName}`,
      detail:
        `${what}: ${bills} ` +
        (acct > 0
          ? `Hand it back from "Money not against a bill" on the Rent screen, or put it against a bill of theirs if one is still open.`
          : `Give it back from "Money not against a bill" on the Rent screen — or keep some, with a reason.`),
      urgency: "soon",
      dueOn: null,
      href: "/park/rent",
      canDismiss: false,
    });
  }

  // THE RECURRING WORKLOAD AT THIS PARK. A household on one-month agreements
  // renews twelve times a year, and a lapsed tenancy stops being billed
  // SILENTLY — buildStatement returns zero days and the charge run drops the
  // row without an error.
  //
  // ASKED WITH THE SAME LEAD AS THE LIST THIS CARD LINKS TO (R2): in the
  // agreement's own last half, never more than 45 days ahead. With a flat 45
  // days here and the list's lead already the agreement's own, the morning
  // he renewed Lot 14 for a month this card read "ends in 40 days — write
  // the next one" and the tap landed on a page whose "Agreements to write"
  // rendered nothing for it; on 1 January eighteen one-month leases signed
  // that morning were "running out" from the day they were signed.
  const ending = f.agreements
    .filter((a) => !a.hasSuccessor)
    .filter((a) => {
      const d = daysBetween(f.today, a.endsOn);
      return d <= renewalLeadDays(a.startsOn, a.endsOn);
    });
  if (ending.length > 3) {
    const soonest = ending.reduce((m, a) => (a.endsOn < m ? a.endsOn : m), ending[0].endsOn);
    // LAPSED IS NOT RUNNING OUT. The per-lot branch below already says "ran
    // out"; this aggregate said "running out" and "the first ends" about
    // fifteen agreements four months past their end, with nothing billed to
    // them since. The same test, split into the two counts.
    //
    // AND THE DAY ITSELF IS PAST. `endsOn` is a half-open range's EXCLUSIVE
    // end, so on the morning an agreement expires `daysBetween` is 0, not
    // negative: on 1 February this card read "[soon] 14 agreements are
    // running out — the first ends February 1, 2027", dismissible, on the
    // same morning the run skipped all fourteen and billed them nothing. It
    // only turned overdue on the 2nd. Zero is past, not soon.
    const lapsed = ending.filter((a) => daysBetween(f.today, a.endsOn) <= 0);
    const running = ending.length - lapsed.length;
    // AND THE MONEY THEY ARE STILL HOLDING FOR THEM. Once per household, in
    // case one household has two lapsed links in the same chain — see
    // strandedClause.
    const stranded = strandedOnAccount(lapsed);
    out.push({
      // THE KEY CARRIES THE FACT. "Running out" and "have lapsed" were the
      // same key, so a dismissal taken on 20 January — when the card was a
      // harmless nudge about eighteen leases with a fortnight left — silently
      // deleted the 16 March card saying the rent had stopped for all of
      // them. Nothing else on Today says a lapsed tenancy stopped being
      // billed, and a dismissal never expires. When the fact changes the key
      // changes with it, and the lapsed card cannot be dismissed at all:
      // stopped rent is money owed, and ParkToday's own rule is that money
      // owed may not be told to go away. `soonest` stays in the key so a
      // dismissal of the lapsed card cannot be resurrected against a later
      // one; snoozing is still offered on both.
      key: `agreements_ending:${f.parkId}:${soonest}${lapsed.length > 0 ? ":lapsed" : ""}`,
      title: lapsed.length > 0
        ? `${lapsed.length} ${lapsed.length === 1 ? "agreement has" : "agreements have"} lapsed` +
          (running > 0 ? ` and ${running} ${running === 1 ? "is" : "are"} running out` : "")
        : `${ending.length} agreements are running out`,
      detail: lapsed.length > 0
        ? `${lapsed.length} ${lapsed.length === 1 ? "has" : "have"} lapsed — the first on ${dayInWords(soonest)}; nothing billed since.` +
          (running > 0 ? ` ${running} ${running === 1 ? "is" : "are"} running out.` : "") +
          strandedClause(stranded)
        : `The first ends ${dayInWords(soonest)}. When one lapses the rent stops being billed — quietly.`,
      urgency: lapsed.length > 0 ? "overdue" : "soon",
      dueOn: soonest,
      href: "/park/today",
      canDismiss: lapsed.length === 0,
    });
  } else {
    for (const a of ending) {
      const d = daysBetween(f.today, a.endsOn);
      // THE LAST DAY IS EXCLUSIVE, so d === 0 is the morning the rent stops
      // — not a day of grace. This branch printed "Lot 6's agreement ends in
      // 0 days" and offered to dismiss it on the very morning the run
      // skipped that lot.
      const ranOut = d <= 0;
      out.push({
        // The same two facts under one key, a lot at a time: "ends in 12
        // days" and "ran out" were both `agreement_ending:chain-9:1`.
        key: `agreement_ending:${a.chainId ?? a.reservationId}:${a.seq}${ranOut ? ":ranout" : ""}`,
        title: ranOut
          ? `Lot ${a.lotNumber}'s agreement ran out`
          : `Lot ${a.lotNumber}'s agreement ends in ${d} ${d === 1 ? "day" : "days"}`,
        detail: (a.renterName
          ? `${a.renterName} — write the next one, or their rent stops being billed.`
          : "Write the next one, or the rent stops being billed.")
          // The same money, said a lot at a time — and only once it has
          // actually run out. While an agreement is still running the money
          // is not stranded: the next run takes it off the next bill.
          + strandedClause(ranOut ? strandedOnAccount([a]) : { households: 0, cents: 0 }),
        urgency: ranOut ? "overdue" : "soon",
        dueOn: a.endsOn,
        href: "/park/today",
        canDismiss: !ranOut,
      });
    }
  }

  // BILLING THE MONTH. Only worth raising when there is somebody to bill —
  // and only for a month that is ours: the run refuses a month that began
  // before go-live (preCutoverRefusal), so a card sending him to it would be
  // an instruction to press a button that says no.
  if (!f.monthBilled && f.liveOccupiedLots > 0 && periodIsBillable(f.currentMonth, f.cutoverOn)) {
    const dueOn = `${f.currentMonth}-${String(f.rentDueDay).padStart(2, "0")}`;
    const until = daysBetween(f.today, dueOn);
    if (until <= BILL_WARN_DAYS) {
      out.push({
        key: `month_not_billed:${f.parkId}:${f.currentMonth}`,
        title: `${prettyMonth(f.currentMonth)} isn't billed yet`,
        detail: until < 0
          ? `Rent was due on the ${ordinal(f.rentDueDay)}. Nobody has been billed.`
          : `Rent is due on the ${ordinal(f.rentDueDay)}.`,
        urgency: until < 0 ? "overdue" : "soon",
        dueOn,
        href: "/park/rent",
        canDismiss: false,
      });
    }
  }

  // STILL ON THE SELLER'S ARRANGEMENT. Not a problem — they live here and they
  // get billed either way — but it is the takeover's open list, and without a
  // line for it a household can sit unsigned indefinitely with nothing saying so.
  if (f.holdoverLots.length > 0) {
    const n = f.holdoverLots.length;
    out.push({
      key: `unsigned_lease:${f.parkId}`,
      title: `${n} ${n === 1 ? "household hasn't" : "households haven't"} signed the new lease`,
      // AND WHERE TO RECORD IT. This card sent him to the rent roll and the
      // roll had no control for a signature, so a household that signed on
      // 1 January stayed "unsigned" — and fee-exempt — with nothing saying
      // how to change that. The control is named here by its own label.
      detail:
        `${n === 1 ? "Lot" : "Lots"} ${f.holdoverLots.join(", ")} — still on the ` +
        `arrangement they already had, so your agreement cap doesn't apply to them yet. ` +
        `When one signs your new lease, record it from their row on the rent roll ` +
        `('${SIGNED_LEASE_LABEL}').`,
      urgency: "whenever",
      dueOn: null,
      href: "/park",
      canDismiss: true,
    });
  }

  // A COST NOBODY IS PAYING FOR. Entered, sitting there, billing nobody.
  for (const c of f.unallocatedCosts) {
    out.push({
      key: `cost_unallocated:${c.id}`,
      title: `${c.label} isn't split across any lots`,
      detail: `${money(c.amount)} entered. Until it's split it does not bill anyone.`,
      urgency: "whenever",
      dueOn: null,
      href: "/park/costs",
      canDismiss: true,
    });
  }

  // THE NOTICE CLIFF. A rent increase has a legally-required warning period,
  // and once the serve-by date passes the effective date is simply impossible.
  for (const rc of f.pendingRentChanges) {
    if (rc.noticeServedOn) continue;
    const serveBy = addDays(rc.effectiveOn, -rc.noticeDaysRequired);
    const until = daysBetween(f.today, serveBy);
    if (until < 0) {
      out.push({
        key: `notice_missed:${rc.id}`,
        title: `Lot ${rc.lotNumber}'s new rent can't start ${dayInWords(rc.effectiveOn)}`,
        // NAMES THE CONTROLS AT THE DOOR IT OPENS. This sent him to Lots &
        // rates, where no rent change can be recorded or called off — the
        // writer (rerate-actions recordNotice / cancelReRate) is mounted by
        // ParkReRate on the Rent roll, and these are its buttons' own words.
        detail:
          `You needed to give ${rc.noticeDaysRequired} days' notice by ${dayInWords(serveBy)}. ` +
          `On the rent roll, 'Call it off', then 'Change the rent on everyone' with a later start — ` +
          `or, if you did give notice, 'Record it' there.`,
        urgency: "overdue",
        dueOn: serveBy,
        href: "/park",
        canDismiss: false,
      });
    } else if (until <= NOTICE_WARN_DAYS) {
      out.push({
        key: `notice_cliff:${rc.id}`,
        title: `Lot ${rc.lotNumber} needs its rent notice by ${dayInWords(serveBy)}`,
        detail:
          `${rc.noticeDaysRequired} days' notice before it starts ${dayInWords(rc.effectiveOn)}. ` +
          `When you've given it, 'Record it' on the rent roll.`,
        urgency: "soon",
        dueOn: serveBy,
        href: "/park",
        canDismiss: false,
      });
    }
  }

  // A BILL THAT ARRIVES ON A RHYTHM AND HAS NOT ARRIVED HERE.
  //
  // Monthly, quarterly or once a year (0123) — the sewer bill, the trash
  // invoice, the property tax. Each is due for its OWN period, so an annual
  // bill is one task a year rather than twelve.
  //
  // Never dismissible: the software must not offer to stop mentioning a bill
  // that nineteen households are waiting to be charged their share of — or,
  // when a fee covers it, the one bill the fee comparison is waiting on. It
  // is 'soon' before the due day and 'overdue' after, because a sewer bill
  // entered three weeks late still records correctly — it is only the
  // FORGOTTEN one that costs money.
  for (const b of f.billsDue) {
    // NOT OURS. A bill for a period that began before the park went live
    // belongs to whoever was running the park then. The card used to
    // instruct him to enter it, and the cost door would have taken it, so
    // the seller's money would have landed on the residents' first bill.
    //
    // ONE KEY FOR ONE RULE. Keyed on the month `billPeriod` gives the bill —
    // the first day of the period it is due IN — because that is the month
    // the cost door compares (`period_start`, preCutoverCostRefusal). Keyed
    // on the due month instead, the two doors disagreed for a mid-year
    // go-live: this card raised a bill the door then refused.
    //
    // THE SCHEDULE CAN NOW SAY WHAT A BILL COVERS (0170). When it does,
    // `periodFrom` is the covered period — the sewer bill dated 5 January
    // for December's service is keyed on December, the Indiana tax bill due
    // 10 November 2027 on 2026 — and the card reads "Sewer for December
    // 2026 (bill due January 5)". When it does not, the card still names
    // only the due date, because that is all the schedule knows. Whether a
    // schedule shifts its period back one cadence is the owner's decision,
    // made per schedule on the costs screen; the gate is the LOADER's rule.

    const daysToDue = daysBetween(f.today, b.dueOn);
    const late = daysToDue < 0;

    // "DUE ABOUT NOW" HAS TO BE ABOUT NOW.
    //
    // Nothing used to bound this: a schedule with no cost recorded in its
    // period produced a card on the FIRST DAY of that period. For a monthly
    // bill that is a few weeks and reads correctly. For the annual property
    // tax it meant 1 January 2027 greeting him with "Property tax for 2027 is
    // due about now" — 313 days early, undismissable, and sitting on his
    // morning screen for ten months teaching him the list contains chores
    // that never go away. A quarterly schedule claimed it for three months.
    //
    // 28 days is chosen so MONTHLY IS UNCHANGED: the longest a monthly bill
    // can sit between the start of its period and its due day is 27 (due on
    // the 28th, seen on the 1st). So this clips the long cadences and leaves
    // the behaviour the monthly tests pin exactly where it was.
    //
    // A LATE bill is never clipped. Once the due day is past, the reminder is
    // the whole point and it stays until the bill is entered — which is only
    // TRUE because the loader now hands over the oldest unanswered period
    // rather than today's. When it handed over today's, this sentence and the
    // two tests pinning it were describing a state the loader could not
    // produce: a real `dueOn` was never more than fifty-one days past.
    //
    // Applied BEFORE the gate, so the not-ours line below is clipped the same
    // way: the seller's tax is not announced in January for November.
    if (!late && daysToDue > BILL_DUE_LEAD_DAYS) continue;

    if (!periodIsBillable(b.periodFrom.slice(0, 7), f.cutoverOn)) {
      // ONE LINE, NOT SILENCE — but only when the schedule KNOWS the bill is
      // for the period before (flag on) and the envelope lands on HIS desk
      // (due on or after go-live). On 5 January he is holding LaGrange's
      // December bill; a silent screen reads as "the reminder is broken" or
      // "enter it", and the cost door then refuses with a paragraph. So the
      // card names the envelope in his hand and where it goes, asks for
      // nothing (dismissible, no due date, "when you can"), and disappears on
      // its own when the key rolls — 1 February for the sewer, 1 January
      // 2028 for the 2026 tax.
      //
      // An UNFLAGGED schedule keeps today's silence: the card would be
      // guessing what the bill covers. A bill due BEFORE go-live stays
      // silent too — it was never his envelope.
      //
      // "STARTS before you went live", not "is from before": for a go-live on
      // the 15th the December sewer is half his, and the rule is about where
      // the period begins (billing-start). The detail is the cost door's OWN
      // sentence, so the reminder and the door literally share one — and it
      // ends with what the button under it does, because every card renders
      // "Sort it" and this one asks for nothing.
      if (b.coversPriorPeriod && f.cutoverOn && b.dueOn >= f.cutoverOn) {
        const refusal = preCutoverCostRefusal(b.periodFrom.slice(0, 7), f.cutoverOn, prettyMonth, null);
        out.push({
          key: `bill_not_ours:${b.scheduleId}:${b.periodKey}`,
          title: `${b.label} ${b.periodLabel} starts before you went live`,
          detail:
            `${refusal} 'Sort it' opens the costs screen, which says the same — unless ` +
            `one of your fees covers this bill, when it can still go in there as ` +
            `evidence for the fee comparison.`,
          urgency: "whenever",
          dueOn: null,
          href: "/park/costs",
          canDismiss: true,
        });
      }
      continue;
    }

    out.push({
      // KEYED ON THE BILL'S OWN PERIOD, not the calendar month. A tax bill is
      // one task a year — keying it on the month made it twelve tasks a
      // year for something that arrives once.
      key: `bill_due:${b.scheduleId}:${b.periodKey}`,
      // NAMED BY ITS DUE DATE, and by the period it covers only when the
      // schedule says what that is (0170). "Property tax for 2027" about the
      // bill due 10 November 2027 was the seller's 2026 tax under the
      // buyer's year; "sewer for January 2027" about the bill dated 5
      // January was December's service — both guesses. `periodLabel` is
      // billPeriod's: unflagged, "due November 10, 2027" for a yearly bill
      // and "(bill due January 5)" for a monthly or quarterly one; flagged,
      // "for December 2026 (bill due January 5)" and "for 2026, due November
      // 10, 2027", because then the covered period is a fact, not a guess.
      // "Sewer (bill due January 5) is coming up" — the label already carries
      // "due", so the not-yet-late form does not say it twice ("due January
      // 5 is due about now" was the stutter on the screen he opens with
      // coffee). The late form reads fine and is unchanged.
      title: late
        ? `${b.label} ${b.periodLabel} still isn't entered`
        : `${b.label} ${b.periodLabel} is coming up`,
      // WHAT THE DOOR WILL DO WITH IT IS NOT KNOWN HERE. The loader reads
      // no fees, and the costs screen does two different things with a bill:
      // one a live fee covers is recorded under that fee and divided to
      // nobody (at The Haven, this very sewer bill); one no fee covers is
      // split across the lots. This used to promise the split — "it splits
      // across the lots — until it is in, nobody is billed for it" — on the
      // 5th of every month, for a bill the screen it links to then refuses
      // to split. So it names both and promises neither. What IS true of
      // every bill: until it is entered it is in nobody's books and nobody's
      // fee comparison, which is the one thing the costs screen is for.
      detail:
        (b.typical != null ? `Usually about ${money(b.typical)}. ` : "") +
        "Enter the real figure on the costs screen — it goes under a fee that " +
        "covers it, or splits across the lots. Until it is in, it is in nobody's " +
        "books and nobody's fee comparison.",
      urgency: late ? "overdue" : "soon",
      dueOn: b.dueOn,
      href: "/park/costs",
      canDismiss: false,
    });
  }

  // GIVEN NOTICE, NOT YET GONE.
  //
  // Two jobs, and the second is the one with money in it. Ahead of the date
  // this is a lot to start showing. PAST the date it is a tenancy still open
  // on a lot somebody has already driven away from — and an open tenancy keeps
  // billing rent every month, to a household that left. Nothing else in the
  // product notices that, because every other check asks whether the roll is
  // billed, not whether the roll is true.
  const leaving = f.noticed
    .map((n) => ({ ...n, days: daysBetween(f.today, n.leavingOn) }))
    .filter((n) => n.days < 0 || n.days <= MOVE_OUT_LEAD_DAYS);

  const gone = leaving.filter((n) => n.days < 0);
  for (const n of gone) {
    out.push({
      key: `move_out_due:${n.reservationId}`,
      title: `Lot ${n.lotNumber} was due to leave on ${dayInWords(n.leavingOn)}`,
      detail: n.renterName
        ? `${n.renterName} gave notice for that day. If they've gone, close it out — ` +
          `an open tenancy keeps billing rent.`
        : "If they've gone, close it out — an open tenancy keeps billing rent.",
      urgency: "overdue",
      dueOn: n.leavingOn,
      href: "/park",
      // Not dismissible: this one silently bills somebody who no longer lives
      // there, and the software must not offer to stop mentioning that.
      canDismiss: false,
    });
  }

  const upcoming = leaving.filter((n) => n.days >= 0);
  if (upcoming.length > 3) {
    const soonest = upcoming.reduce((m, n) => (n.leavingOn < m ? n.leavingOn : m), upcoming[0].leavingOn);
    out.push({
      key: `leaving_soon:${f.parkId}:${soonest}`,
      title: `${upcoming.length} households are leaving`,
      detail: `The first goes ${dayInWords(soonest)}. ${upcoming.map((n) => n.lotNumber).join(", ")} — ` +
        `time to start showing them.`,
      urgency: "soon",
      dueOn: soonest,
      href: "/park",
      canDismiss: true,
    });
  } else {
    for (const n of upcoming) {
      out.push({
        key: `leaving:${n.reservationId}`,
        title: n.days === 0
          ? `Lot ${n.lotNumber} leaves today`
          : `Lot ${n.lotNumber} leaves in ${n.days} ${n.days === 1 ? "day" : "days"}`,
        detail: n.renterName
          ? `${n.renterName} is out on ${dayInWords(n.leavingOn)}. Start showing it now, not the morning after.`
          : `Out on ${dayInWords(n.leavingOn)}. Start showing it now, not the morning after.`,
        urgency: "soon",
        dueOn: n.leavingOn,
        href: "/park",
        canDismiss: true,
      });
    }
  }

  return out.sort(
    (a, b) =>
      rank(a.urgency) - rank(b.urgency) ||
      (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") ||
      a.title.localeCompare(b.title),
  );
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export interface TaskState {
  taskKey: string;
  snoozedUntil: string | null;
  dismissedAt: string | null;
}

/** What he actually sees, after his own decisions about it. */
export function visibleTasks(
  tasks: readonly Task[],
  states: readonly TaskState[],
  today: string,
): Task[] {
  const byKey = new Map(states.map((s) => [s.taskKey, s]));
  return tasks.filter((t) => {
    const st = byKey.get(t.key);
    if (!st) return true;
    if (st.dismissedAt) return false;
    // A snooze EXPIRES. Something he put off is not something he decided
    // against, and the difference matters a month later.
    if (st.snoozedUntil && st.snoozedUntil > today) return false;
    return true;
  });
}

/**
 * What the screen says when nothing is wrong — which is most days.
 *
 * Lists what was LOOKED AT. "Nothing needs you" on its own is indistinguishable
 * from a broken screen, and an owner who suspects it is broken stops trusting
 * it on the day it isn't.
 */
export function quietState(checked: readonly string[]): { headline: string; checkedLine: string } {
  return {
    headline: "Nothing needs you this morning.",
    checkedLine: checked.length
      ? `Checked: ${checked.join(" · ")}.`
      : "Nothing set up to check yet.",
  };
}

// ------------------------------------------------------------- occupancy ---

/**
 * WHICH LIVE LOTS HAVE SOMEBODY ON THEM TODAY — the one copy of the rule.
 *
 * This block lived inline in the Today loader. The readiness list needs the
 * same answer ("N of M live lots have a household on them"), and a second
 * copy would be the third occupancy rule in the module — the roll's
 * summarise() being the first — so the loader now calls this and the
 * readiness builder calls this.
 *
 * `rows` are the park's lot_reservations on live lots in status approved,
 * active OR ended: the ended rows reach only the lapsed test (a household
 * closed out of its successor has left; without the ended row the successor
 * looks like a lapsed holdover).
 */
export function lotOccupancy(
  rows: readonly { park_lot_id: string; during: string; status: string; term: string }[],
  liveLots: readonly { id: string; lot_number: string }[],
  today: string,
): { occupiedLotIds: Set<string>; reservedLotIds: Set<string>; snapshot: OccupancySnapshot } {
  const stays = rows.filter((s) => s.status === "approved" || s.status === "active");

  const occupiedLotIds = new Set<string>();
  const reservedLotIds = new Set<string>();
  for (const s of stays) {
    const r = parseDaterange(s.during);
    if (!r) continue;
    // Half-open: `end` is checkout morning, so today === end is NOT in date.
    if (r.start <= today && today < r.end) occupiedLotIds.add(s.park_lot_id);
    else if (r.start > today) reservedLotIds.add(s.park_lot_id);
  }
  // A LOT IS COUNTED ONCE. Renewing somebody writes a future tenancy on a lot
  // that already has a current one, so without this the same lot lands in both
  // sets and every renewal inflates occupancy by a lot that did not change
  // hands. Found by driving it: 3 lots, 1 tenant, "2 of 3 taken".
  for (const id of occupiedLotIds) reservedLotIds.delete(id);
  // LIVED ON, PAPERWORK RUN OUT: the roll's own rule (park-helpers
  // lapsedRowOf), read from every row on the lot — a held monthly row behind
  // today with nothing current, nothing coming and nobody closed out after
  // it. Nobody moved out, so the lot is not empty: the roll says "Ran out"
  // for the same row; Today read it as "Empty: lot 9". A stay by the night
  // or the week is not lapsed once its checkout passes, and a household
  // closed out of its successor has left — both the helper's, not this
  // file's, so the three screens cannot drift.
  const rowsOfLot = new Map<string, { status: string; range: ReturnType<typeof parseDaterange>; term: string }[]>();
  for (const s of rows) {
    const list = rowsOfLot.get(s.park_lot_id) ?? [];
    list.push({ status: s.status, range: parseDaterange(s.during), term: s.term });
    rowsOfLot.set(s.park_lot_id, list);
  }
  const lapsedLotIds = new Set<string>();
  for (const [lotId, lotRows] of rowsOfLot) {
    if (lapsedRowOf(lotRows, today)) lapsedLotIds.add(lotId);
  }
  // What is left is a lot somebody lives on with no paperwork in date:
  // counted as taken, never empty.
  for (const id of lapsedLotIds) occupiedLotIds.add(id);

  const vacantLots = liveLots.filter(
    (l) => !occupiedLotIds.has(l.id) && !reservedLotIds.has(l.id),
  );

  const snapshot: OccupancySnapshot = {
    liveLots: liveLots.length,
    occupied: occupiedLotIds.size,
    reserved: reservedLotIds.size,
    vacant: vacantLots.length,
    vacantLotNumbers: vacantLots
      .map((l) => l.lot_number)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };

  return { occupiedLotIds, reservedLotIds, snapshot };
}

// --------------------------------------------------------- before go-live ---

/** "the 1" reads like a truncated number; "the 1st" reads like a date. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * Before the park is his, there is no occupancy — only the countdown. The
 * checklist that used to hang under it (lots, rate cards, households, rent
 * due day, cap) is the readiness list's now (readiness.ts), which reads every
 * one of those columns and seven more, and links each to the control that
 * writes it. This keeps only the two sentences.
 *
 * NOT "nothing is collectable until then". No BILL can be raised before
 * go-live (ledger-actions preCutoverRefusal), but the gold Take a payment
 * button is on every park screen, this card sits directly under it, and its
 * on-account path (recordOnAccount) has no cutover gate: a cheque at signing
 * in December is recorded, receipted and allocated to the first bill. So the
 * sentence names the first month that IS billed — lib/billing-start's rule,
 * a mid-month go-live bills from the month after — and where earlier money
 * goes.
 */
export function preCutover(input: {
  today: string;
  cutoverOn: string;
  parkName: string;
}): { headline: string; sub: string } {
  const days = daysBetween(input.today, input.cutoverOn);
  return {
    headline: days === 0
      ? `${input.parkName} — today is the day.`
      // PARK-AGNOSTIC. Most parks joining already own themselves — there is no
      // closing and no seller in their story, only the day they start running
      // the park on this system. "Go-live" is true of a purchase AND of a park
      // that has been in the family for thirty years.
      : `${input.parkName} — ${days} ${days === 1 ? "day" : "days"} to go-live.`,
    sub: days === 0
      ? "Money and occupancy start now."
      : `You go live on ${dayInWords(input.cutoverOn)}. ${firstBillLine(input.cutoverOn)}`,
  };
}

/** The first month we bill, and where money handed in before it goes. */
function firstBillLine(cutoverOn: string): string {
  const first = firstBillablePeriod(cutoverOn);
  return first
    ? `The first month you bill is ${prettyMonth(first)}; money handed in before that goes on account.`
    : "Money handed in before then goes on account.";
}
