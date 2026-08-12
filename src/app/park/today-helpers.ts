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
}

export function moneyBlock(input: {
  monthToDateCents: number;
  todayCents: number;
  monthSummary: LedgerSummary;
  lagDays: number;
  /** Open charges from months BEFORE this one. */
  arrears: readonly LedgerRow[];
  today: string;
}): MoneyBlock {
  const { monthToDateCents, todayCents, monthSummary, lagDays, arrears, today } = input;

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

  return {
    headline,
    todayLine,
    ledgerLine: ledgerHeadline(monthSummary, lagDays),
    arrearsLine,
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
  /** Costs entered but never split across lots — they bill nobody. */
  unallocatedCosts: { id: string; label: string; amount: number }[];
  /**
   * Households still on whatever the seller agreed, with no new lease signed.
   * Named by lot, because chasing a signature is a door-knock not a query.
   */
  holdoverLots: string[];
  /** Rent changes whose notice period is about to make the date impossible. */
  pendingRentChanges: {
    id: string; lotNumber: string; effectiveOn: string;
    noticeDaysRequired: number; noticeServedOn: string | null;
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
        `${n === 1 ? "Lot" : "Lots"} ${f.holdoverLots.join(", ")} — still on what they had ` +
        `with the seller, so your agreement cap doesn't apply to them yet.`,
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

// -------------------------------------------------------- before closing ---

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
      : `${input.parkName} — ${days} ${days === 1 ? "day" : "days"} to closing.`,
    sub: days === 0
      ? "Money and occupancy start now."
      : `You take over on ${input.cutoverOn}. Nothing is collectable until then.`,
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
