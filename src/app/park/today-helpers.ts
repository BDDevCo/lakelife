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
import { ledgerHeadline } from "./ledger-helpers";
import { prettyMonth } from "./ledger-helpers";

// Notification thresholds, not pricing — so they live here rather than in the
// database. The first time he says one of these numbers is wrong, it becomes a
// park column.
export const RENEWAL_LEAD_DAYS = 45;
export const NOTICE_WARN_DAYS = 7;
export const BILL_WARN_DAYS = 3;

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
}

export function moneyBlock(input: {
  monthToDateCents: number;
  todayCents: number;
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
    disputedOlder = [], today,
  } = input;

  const headline = monthToDateCents === 0
    ? "Nothing has come in yet this month."
    : `${money(monthToDateCents / 100)} in so far this month.`;

  // Omitted, not zeroed. Twenty-five days a month this line would read $0.00
  // and mean nothing at all.
  const todayLine = todayCents === 0 ? null : `${money(todayCents / 100)} came in today.`;

  let arrearsLine: string | null = null;
  if (arrears.length > 0) {
    const total = arrears.reduce((s, r) => s + r.balance, 0);
    const lots = new Set(arrears.map((r) => r.lotNumber)).size;
    const oldest = arrears.reduce((m, r) => (r.dueOn < m ? r.dueOn : m), arrears[0].dueOn);
    arrearsLine =
      `${money(total)} still owing from earlier months — ` +
      `${lots} ${lots === 1 ? "household" : "households"}, oldest due ${oldest} ` +
      `(${daysBetween(oldest, today)} days).`;
  }

  let disputedLine: string | null = null;
  if (disputedOlder.length > 0) {
    const total = disputedOlder.reduce((s2, r) => s2 + r.balance, 0);
    const n = new Set(disputedOlder.map((r) => r.lotNumber)).size;
    disputedLine =
      `${money(total)} from earlier months is disputed — ` +
      `${n} ${n === 1 ? "household says they" : "households say they"} already paid. ` +
      `That is a conversation, not arrears.`;
  }

  return {
    headline,
    todayLine,
    ledgerLine: ledgerHeadline(monthSummary, lagDays),
    arrearsLine,
    disputedLine,
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

  if (s.occupied === 0 && s.reserved > 0) {
    return {
      main: `${s.reserved} of ${s.liveLots} lots spoken for.`,
      sub: "Their tenancies start later — nothing is collectable yet.",
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
    renterName: string | null;
    endsOn: string;
    chainId: string | null;
    seq: number;
    hasSuccessor: boolean;
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
   * Bills that arrive every month and have not been entered for this one.
   *
   * The Haven's sewer is 82% of everything the park spends on its residents'
   * behalf, and it arrives monthly. Miss it and nineteen households are never
   * billed their share — invisibly, because a cost nobody entered leaves no
   * trace. `typical` is a HINT so a wrong invoice is noticeable; it is never
   * billed and never written to park_costs.
   */
  billsDue: {
    scheduleId: string;
    category: string;
    label: string;
    /** The period this is due FOR — a month, a quarter, or a year. */
    periodKey: string;
    periodLabel: string;
    dueOn: string;
    typical: number | null;
  }[];
}

function rank(u: TaskUrgency): number {
  return u === "overdue" ? 0 : u === "soon" ? 1 : 2;
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
      detail: `${money(f.arrearsAmount)} still outstanding from before ${f.currentMonth}.`,
      urgency: "overdue",
      dueOn: null,
      href: "/park/rent",
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

  // THE RECURRING WORKLOAD AT THIS PARK. A three-month cap means renewals come
  // round four times a year per household, and a lapsed tenancy stops being
  // billed SILENTLY — buildStatement returns zero days and the charge run drops
  // the row without an error.
  const ending = f.agreements
    .filter((a) => !a.hasSuccessor)
    .filter((a) => {
      const d = daysBetween(f.today, a.endsOn);
      return d <= RENEWAL_LEAD_DAYS;
    });
  if (ending.length > 3) {
    const soonest = ending.reduce((m, a) => (a.endsOn < m ? a.endsOn : m), ending[0].endsOn);
    out.push({
      key: `agreements_ending:${f.parkId}:${soonest}`,
      title: `${ending.length} agreements are running out`,
      detail: `The first ends ${soonest}. When one lapses the rent stops being billed — quietly.`,
      urgency: daysBetween(f.today, soonest) < 0 ? "overdue" : "soon",
      dueOn: soonest,
      href: "/park/today",
      canDismiss: true,
    });
  } else {
    for (const a of ending) {
      const d = daysBetween(f.today, a.endsOn);
      out.push({
        key: `agreement_ending:${a.chainId ?? a.reservationId}:${a.seq}`,
        title: d < 0
          ? `Lot ${a.lotNumber}'s agreement ran out`
          : `Lot ${a.lotNumber}'s agreement ends in ${d} ${d === 1 ? "day" : "days"}`,
        detail: a.renterName
          ? `${a.renterName} — write the next one, or their rent stops being billed.`
          : "Write the next one, or the rent stops being billed.",
        urgency: d < 0 ? "overdue" : "soon",
        dueOn: a.endsOn,
        href: "/park/today",
        canDismiss: true,
      });
    }
  }

  // BILLING THE MONTH. Only worth raising when there is somebody to bill.
  if (!f.monthBilled && f.liveOccupiedLots > 0) {
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
      detail:
        `${n === 1 ? "Lot" : "Lots"} ${f.holdoverLots.join(", ")} — still on the ` +
        `arrangement they already had, so your agreement cap doesn't apply to them yet.`,
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
        title: `Lot ${rc.lotNumber}'s new rent can't start ${rc.effectiveOn}`,
        detail:
          `You needed to give ${rc.noticeDaysRequired} days' notice by ${serveBy}. ` +
          `Move the date or serve it now and start later.`,
        urgency: "overdue",
        dueOn: serveBy,
        href: "/park/lots",
        canDismiss: false,
      });
    } else if (until <= NOTICE_WARN_DAYS) {
      out.push({
        key: `notice_cliff:${rc.id}`,
        title: `Lot ${rc.lotNumber} needs its rent notice by ${serveBy}`,
        detail: `${rc.noticeDaysRequired} days' notice before it starts ${rc.effectiveOn}.`,
        urgency: "soon",
        dueOn: serveBy,
        href: "/park/lots",
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
  // that nineteen households are waiting to be charged their share of. It is
  // 'soon' before the due day and 'overdue' after, because a sewer bill
  // entered three weeks late still bills correctly — it is only the FORGOTTEN
  // one that costs money.
  for (const b of f.billsDue) {
    const late = daysBetween(f.today, b.dueOn) < 0;
    out.push({
      // KEYED ON THE BILL'S OWN PERIOD, not the calendar month. A tax bill is
      // one task called "Property tax for 2026" — keying it on the month made
      // it twelve tasks a year for something that arrives once.
      key: `bill_due:${b.scheduleId}:${b.periodKey}`,
      title: late
        ? `${b.label} for ${b.periodLabel} still isn't entered`
        : `${b.label} for ${b.periodLabel} is due about now`,
      detail: b.typical != null
        ? `Usually about ${money(b.typical)}. Enter the real figure and it splits across the lots — until it is in, nobody is billed for it.`
        : "Enter it and it splits across the lots — until it is in, nobody is billed for it.",
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
    .filter((n) => n.days < 0 || n.days <= RENEWAL_LEAD_DAYS);

  const gone = leaving.filter((n) => n.days < 0);
  for (const n of gone) {
    out.push({
      key: `move_out_due:${n.reservationId}`,
      title: `Lot ${n.lotNumber} was due to leave on ${n.leavingOn}`,
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
      detail: `The first goes ${soonest}. ${upcoming.map((n) => n.lotNumber).join(", ")} — ` +
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
          ? `${n.renterName} is out on ${n.leavingOn}. Start showing it now, not the morning after.`
          : `Out on ${n.leavingOn}. Start showing it now, not the morning after.`,
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

// --------------------------------------------------------- before go-live ---

export interface ReadinessItem { label: string; value: string; done: boolean }

/** "the 1" reads like a truncated number; "the 1st" reads like a date. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * Before the park is his, there is no money and no occupancy — only whether the
 * file is ready. Counted against LOTS AND RATE CARDS, which exist, never
 * against tenancies, which do not.
 */
export function preCutover(input: {
  today: string;
  cutoverOn: string;
  parkName: string;
  lots: number;
  lotsWithRates: number;
  monthlyRoll: number;
  households: number;
  rentDueDay: number;
  maxAgreementMonths: number | null;
}): { headline: string; sub: string; items: ReadinessItem[] } {
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
      : `You go live on ${input.cutoverOn}. Nothing is collectable until then.`,
    items: [
      { label: "Lots on file", value: String(input.lots), done: input.lots > 0 },
      {
        label: "Rate cards",
        value: input.lots
          ? `${input.lotsWithRates} of ${input.lots}${input.monthlyRoll ? ` — ${money(input.monthlyRoll)} a month` : ""}`
          : "—",
        done: input.lots > 0 && input.lotsWithRates === input.lots,
      },
      { label: "Households on the roll", value: String(input.households), done: input.households > 0 },
      { label: "Rent due day", value: `the ${ordinal(input.rentDueDay)}`, done: true },
      {
        label: "Agreement cap",
        value: input.maxAgreementMonths ? `${input.maxAgreementMonths} months` : "not set",
        done: input.maxAgreementMonths != null,
      },
    ],
  };
}
