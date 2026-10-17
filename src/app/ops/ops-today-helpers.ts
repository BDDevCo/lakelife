/**
 * THE CONSOLE OPENED ON FOUR ZEROS AND AN EMPTY BOARD.
 *
 * /ops begins with four tiles — requests waiting, jobs this week, week
 * revenue, week margin — which in production read 0, 0, $0 and $0. Under them
 * sit nine tabs, defaulting to Jobs, which is also empty. So the first screen
 * of the operations console says nothing true except that nothing has
 * happened, and says it four times.
 *
 * Meanwhile the fact that actually matters — NO CREW CAN TAKE ANY JOB, every
 * vendor in production being a test account — was two taps away on the Crews
 * tab, below the roster. The screen that opens is not the screen that knows.
 *
 * This is the same shape as the park morning screen, and the same fix: work
 * out what needs a person, say it as a sentence with the number in it, and put
 * the door to it on the row. The ranking and the words are decided here, with
 * no database and no React, so they can be tested.
 */

/** The nine tabs, as OpsShell names them. */
export type OpsTab =
  | "jobs" | "calendar" | "dispatch" | "margin"
  | "lakes" | "routing" | "crews" | "messages" | "parks";

export type OpsUrgency =
  /** Somebody is waiting on a human, or money is stopped. */
  | "now"
  /** Real, and it will cost something if it is still true next week. */
  | "soon"
  /** Worth knowing. Not worth interrupting anything for. */
  | "watch";

export interface OpsTask {
  key: string;
  /**
   * The sentence. A FACT WITH ITS NUMBER IN IT, never a label: "3 disputes
   * need a human call" rather than "Disputes". A label makes him open the tab
   * to find out whether it was worth opening.
   */
  said: string;
  /** The tab that holds it, or null when it is already on this page. */
  tab: OpsTab | null;
  /** What the control says. Named per task — there is no generic "Sort it". */
  verb: string;
  urgency: OpsUrgency;
}

export interface OpsFacts {
  /** Disputes past the auto-refund line. Crew pay is frozen on each. */
  escalations: number;
  /** Payout batches the bank handed back, with the crew still unpaid. */
  payoutsReturned: number;
  /** Crews sitting below zero, which every month-end run skips in silence. */
  crewsInTheRed: number;
  /** Payouts released and waiting to be sent. */
  payoutsQueued: number;
  /** Jobs that found no crew. */
  jobsNeedingCrew: number;
  /** Households who have tried more than once and still are not in. */
  stuckHouseholds: number;
  /** Park enquiries with nobody's reply on them yet. */
  parkEnquiries: number;
  /** Fees a park has proposed and nobody has answered. */
  proposedFees: number;
  /** Crews who count at all: active, and not a test account. */
  liveCrews: number;
  /** Active services with no crew anywhere, on any lake. */
  orphanServices: number;
  /** (service × lake) pairs nobody can cover, and how many were examined. */
  coverageHoles: number;
  coveragePairs: number;
  /** Crews who ticked work they never priced. Chase for a number. */
  unpricedCrews: number;
  /** Threads waiting on ops. */
  unreadThreads: number;
  /** Open requests with no job yet. */
  requestsWaiting: number;
  /**
   * Parks that asked to be set up to receive rent and are not live yet.
   *
   * THE READER THAT MAKES THE OWNER'S ASK REAL. 0196's registry shipped with
   * no writer and no queue; a draft nobody looks at is a request that
   * silently never happens.
   */
  parksAwaitingPayments: number;
  /**
   * Parks that cannot be invoiced at all — no fee start month, so the raise
   * door refuses every month. LakeLife earns nothing from them, silently.
   */
  parksNotBillable: number;
  /** Months owed on billable parks that nobody has raised. */
  monthsUnbilled: number;
  /** What those months are worth, in cents, at today's lot counts. */
  unbilledCents: number;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** Cents as a person reads them. No trailing ".00" on a round figure. */
const dollars = (cents: number) => {
  const d = Math.round(cents) / 100;
  return d % 1 === 0 ? `$${d.toLocaleString("en-US")}`
    : `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/**
 * What needs a person, hardest first.
 *
 * MONEY AND PEOPLE BEFORE STRUCTURE. A dispute with a customer waiting and a
 * crew's pay frozen outranks a coverage hole for a service nobody has booked,
 * even though the coverage hole is the bigger problem in March. The list is
 * read top-down by somebody with a morning, not by a planner.
 */
export function opsTasks(f: OpsFacts): OpsTask[] {
  const out: OpsTask[] = [];

  if (f.escalations > 0) {
    out.push({
      key: "escalations",
      said: `${f.escalations} ${plural(f.escalations, "dispute")} ${plural(f.escalations, "needs", "need")} a human call — crew pay is frozen on ${f.escalations === 1 ? "it" : "each"} until you decide.`,
      tab: null, verb: "It's further down this page", urgency: "now",
    });
  }

  if (f.payoutsReturned > 0) {
    out.push({
      key: "payouts-returned",
      said: `The bank handed back ${f.payoutsReturned} payout ${plural(f.payoutsReturned, "batch", "batches")} and ${f.payoutsReturned === 1 ? "that crew is" : "those crews are"} still unpaid.`,
      tab: "dispatch", verb: "Open the payout queue", urgency: "now",
    });
  }

  if (f.crewsInTheRed > 0) {
    out.push({
      key: "crews-in-the-red",
      said: `${f.crewsInTheRed} ${plural(f.crewsInTheRed, "crew")} ${plural(f.crewsInTheRed, "is", "are")} below zero after a clawback — every month-end run skips ${f.crewsInTheRed === 1 ? "them" : "them"} without saying so.`,
      tab: "dispatch", verb: "Open the payout queue", urgency: "now",
    });
  }

  if (f.jobsNeedingCrew > 0) {
    out.push({
      key: "jobs-needing-crew",
      said: `${f.jobsNeedingCrew} ${plural(f.jobsNeedingCrew, "job")} ${plural(f.jobsNeedingCrew, "has", "have")} no crew.`,
      tab: "dispatch", verb: "Open dispatch", urgency: "now",
    });
  }

  if (f.stuckHouseholds > 0) {
    out.push({
      key: "stuck-households",
      said: `${f.stuckHouseholds} ${plural(f.stuckHouseholds, "household")} ${plural(f.stuckHouseholds, "has", "have")} tried more than once to get into their rent screen and still ${plural(f.stuckHouseholds, "is", "are")} not in.`,
      tab: null, verb: "It's further down this page", urgency: "now",
    });
  }

  if (f.parkEnquiries > 0) {
    out.push({
      key: "park-enquiries",
      said: `${f.parkEnquiries} park ${plural(f.parkEnquiries, "enquiry", "enquiries")} ${plural(f.parkEnquiries, "is", "are")} waiting on a reply.`,
      tab: "parks", verb: "Open parks", urgency: "now",
    });
  }

  if (f.proposedFees > 0) {
    out.push({
      key: "proposed-fees",
      said: `${f.proposedFees} proposed ${plural(f.proposedFees, "fee")} ${plural(f.proposedFees, "is", "are")} waiting on your yes or no.`,
      tab: null, verb: "It's further down this page", urgency: "now",
    });
  }

  // THE ONE THAT WAS BURIED. In production every vendor is a test account, so
  // this is the true state of the platform and it was on the Crews tab, under
  // the roster. A console that opens without saying it is a console that lets
  // somebody sell work nobody can do.
  if (f.liveCrews === 0) {
    out.push({
      key: "no-crews",
      said:
        "No crew can take any job — there is not one active, non-test crew on " +
        "the platform. Anything booked today has nobody to send.",
      tab: "crews", verb: "Open crews", urgency: "now",
    });
  } else if (f.orphanServices > 0) {
    out.push({
      key: "orphan-services",
      said: `${f.orphanServices} ${plural(f.orphanServices, "service")} ${plural(f.orphanServices, "is", "are")} switched on with no crew anywhere who can do ${f.orphanServices === 1 ? "it" : "them"}.`,
      tab: "crews", verb: "Open crews", urgency: "soon",
    });
  } else if (f.coverageHoles > 0) {
    out.push({
      key: "coverage-holes",
      said: `${f.coverageHoles} of ${f.coveragePairs} service-and-lake ${plural(f.coveragePairs, "pair")} ${plural(f.coverageHoles, "has", "have")} nobody who can cover ${f.coverageHoles === 1 ? "it" : "them"}.`,
      tab: "crews", verb: "Open crews", urgency: "soon",
    });
  }

  if (f.unpricedCrews > 0) {
    out.push({
      key: "unpriced-crews",
      said: `${f.unpricedCrews} ${plural(f.unpricedCrews, "crew")} ${plural(f.unpricedCrews, "has", "have")} ticked work ${plural(f.unpricedCrews, "they", "they")} never priced. Chase them for a number — don't go and hire somebody.`,
      tab: "crews", verb: "Open crews", urgency: "soon",
    });
  }

  if (f.unreadThreads > 0) {
    out.push({
      key: "threads",
      said: `${f.unreadThreads} ${plural(f.unreadThreads, "message thread")} ${plural(f.unreadThreads, "is", "are")} waiting on you.`,
      tab: "messages", verb: "Open messages", urgency: "soon",
    });
  }

  if (f.requestsWaiting > 0) {
    out.push({
      key: "requests",
      said: `${f.requestsWaiting} ${plural(f.requestsWaiting, "request")} ${plural(f.requestsWaiting, "has", "have")} come in with no job on ${f.requestsWaiting === 1 ? "it" : "them"} yet.`,
      tab: "jobs", verb: "Open the jobs board", urgency: "soon",
    });
  }

  if (f.parksAwaitingPayments > 0) {
    out.push({
      key: "parks-awaiting-payments",
      said: `${f.parksAwaitingPayments} ${plural(f.parksAwaitingPayments, "park")} ${plural(f.parksAwaitingPayments, "is", "are")} waiting to be set up to collect rent — until then ${f.parksAwaitingPayments === 1 ? "its residents cannot" : "their residents cannot"} pay in the app.`,
      tab: "parks", verb: "Open parks", urgency: "now",
    });
  }

  // OUR OWN REVENUE, and it sits above the watch items because it is the
  // only line on this card that is money we are not collecting rather than
  // money somebody else is waiting on.
  if (f.parksNotBillable > 0) {
    out.push({
      key: "parks-not-billable",
      said: `${f.parksNotBillable} ${plural(f.parksNotBillable, "park")} ${plural(f.parksNotBillable, "cannot", "cannot")} be invoiced at all — ${f.parksNotBillable === 1 ? "it has" : "they have"} no month their fee starts from, so nothing can ever be raised.`,
      tab: "margin", verb: "Set when the fee starts", urgency: "now",
    });
  }

  if (f.monthsUnbilled > 0) {
    const worth = f.unbilledCents > 0
      ? ` — about ${dollars(f.unbilledCents)} we have not asked for`
      : "";
    out.push({
      key: "months-unbilled",
      said: `${f.monthsUnbilled} ${plural(f.monthsUnbilled, "month")} of platform fee ${plural(f.monthsUnbilled, "has", "have")} gone unraised${worth}.`,
      tab: "margin", verb: "Raise them", urgency: "soon",
    });
  }

  if (f.payoutsQueued > 0) {
    out.push({
      key: "payouts-queued",
      said: `${f.payoutsQueued} ${plural(f.payoutsQueued, "payout")} ${plural(f.payoutsQueued, "is", "are")} released and waiting to be sent.`,
      tab: "dispatch", verb: "Open the payout queue", urgency: "watch",
    });
  }

  return out;
}

/**
 * When the list is empty.
 *
 * SAY WHAT WAS CHECKED. "Nothing needs you" reads the same whether the morning
 * really is clear or every loader on the page came back broken — the mistake
 * the claim card made for months. So the quiet state names the questions it
 * asked, and the number of them, which is also the only way anybody notices
 * the day this stops asking.
 */
export function opsQuietSentence(f: OpsFacts): string {
  const asked = Object.keys(f).length;
  const crews = f.liveCrews === 1 ? "1 crew is live" : `${f.liveCrews} crews are live`;
  return (
    `Nothing needs you right now. ${crews}, no job is without one, ` +
    `nobody is waiting on a reply, and no payout is stuck. ` +
    `${asked} things were checked to say that.`
  );
}

/**
 * Which tab to open on.
 *
 * The console defaulted to Jobs, which in production is empty — so the first
 * thing it ever showed was a board with nothing on it. It now opens on the tab
 * the top task lives on, and when nothing needs anybody it opens on the first
 * tab that has anything in it at all. Jobs stays the fallback so the console
 * has a home when the whole platform is quiet.
 */
export function opsOpeningTab(f: OpsFacts, tasks: readonly OpsTask[]): OpsTab {
  const firstWithTab = tasks.find((t) => t.tab !== null)?.tab;
  if (firstWithTab) return firstWithTab;
  if (f.requestsWaiting > 0 || f.jobsNeedingCrew > 0) return "jobs";
  if (f.liveCrews === 0 || f.orphanServices > 0 || f.coverageHoles > 0) return "crews";
  if (f.parkEnquiries > 0) return "parks";
  return "jobs";
}

/**
 * What a tile with a zero on it should say underneath.
 *
 * FOUR ZEROS IS NOT FOUR FACTS. A zero is only readable next to the reason it
 * is a zero: no job this week is the expected state of a platform whose first
 * real crew has not been signed, and it is an emergency on a platform with
 * forty jobs booked. The tile cannot tell those apart; the console can.
 */
export function tileFootnote(opts: {
  value: number;
  liveCrews: number;
  /** True for the two money tiles, whose zero follows from the jobs tile. */
  followsFromJobs?: boolean;
  jobsThisWeek?: number;
}): string | null {
  if (opts.value !== 0) return null;
  if (opts.liveCrews === 0) return "no live crew yet";
  if (opts.followsFromJobs && (opts.jobsThisWeek ?? 0) === 0) return "no jobs this week yet";
  return "none";
}

/**
 * Threads where the last word was the owner's.
 *
 * Derived rather than stored: there is no read-receipt column on a thread, and
 * inventing one would be a column with no writer. "They spoke last" is the
 * fact the board already shows and the only one that is true without a new
 * migration.
 *
 * AN AI AUTO-REPLY COUNTS AS ANSWERED, and that is a choice rather than an
 * oversight: a message DID go back to the owner, so the thread is not one
 * where somebody is sitting in silence. If the auto-reply turns out to be the
 * wrong answer the owner writes again, and the thread lands back on this list
 * with their message last. Counting AI replies as unanswered would put every
 * auto-replied thread on the console permanently.
 */
export function threadsAwaitingReply(
  threads: readonly { messages: readonly { from: string }[] }[],
): number {
  return threads.filter((t) => {
    const last = t.messages[t.messages.length - 1];
    return last != null && last.from === "owner";
  }).length;
}
