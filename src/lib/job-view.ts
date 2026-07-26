/**
 * Pure presentation + query helpers for the job-detail surfaces (2026-07-26).
 * No I/O, fully unit-testable — same discipline as the pricing and refund math.
 * Three roles render the same job three ways; the *words* they see and the
 * *safety* of a search box are logic, so they live here rather than being
 * retyped inside three JSX trees.
 */

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------

/**
 * Make a user-typed search string safe to drop into a PostgREST filter.
 *
 * Two distinct hazards, both real:
 *  1. LIKE wildcards — `%` and `_` are wildcards, so a customer named "50%"
 *     or an address with an underscore silently matches far too much.
 *  2. PostgREST's filter GRAMMAR — `.or("a.ilike.*x*,b.ilike.*x*")` is parsed
 *     as a comma-separated list with parenthesised groups, so a comma,
 *     parenthesis, or backslash in the needle corrupts the whole filter (and
 *     can make it match rows the user never asked for). Quotes are stripped
 *     for the same reason.
 *
 * We drop grammar-breaking characters entirely rather than trying to escape
 * them — nobody searches for "(" on purpose, and a silently-wrong filter is
 * worse than a slightly-narrower one.
 */
export function sanitizeSearchTerm(raw: string): string {
  return (raw ?? "")
    .trim()
    .slice(0, 80)
    .replace(/[%_\\]/g, " ")        // LIKE wildcards + escape char
    .replace(/[(),."'*:]/g, " ")     // PostgREST filter grammar
    .replace(/\s+/g, " ")
    .trim();
}

/** A term short enough to match half the database is not worth running. */
export function isSearchable(term: string): boolean {
  return sanitizeSearchTerm(term).length >= 2;
}

// ---------------------------------------------------------------------------
// STATUS WORDS
// ---------------------------------------------------------------------------

/** Plain English for a job status, from the CUSTOMER's point of view. */
export function customerStatusLabel(status: string): string {
  switch (status) {
    case "requested": return "Finding your crew";
    case "scheduled": return "Scheduled";
    case "in_progress": return "Crew is there now";
    case "complete": return "Done";
    case "paid": return "Done · paid";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

/** Plain English for a job status, from the CREW's point of view. */
export function crewStatusLabel(status: string): string {
  switch (status) {
    case "requested": return "Unassigned";
    case "scheduled": return "On your schedule";
    case "in_progress": return "In progress";
    case "complete": return "Done — pay released on the next batch";
    case "paid": return "Paid";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

// ---------------------------------------------------------------------------
// MAKE-IT-RIGHT, IN THE CUSTOMER'S WORDS
// ---------------------------------------------------------------------------

export interface DisputeViewInput {
  status: string;
  /** Date of the booked correction visit, if one exists (YYYY-MM-DD). */
  correctionDate?: string | null;
}

export interface DisputeView {
  /** Short pill text. */
  pill: string;
  /** One honest sentence about where this stands. */
  line: string;
  /** True while the crew's pay is frozen — drives the crew-side warning. */
  payOnHold: boolean;
  /** True when we're waiting on the CUSTOMER to answer. */
  needsCustomer: boolean;
}

function prettyDay(iso?: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

/**
 * Map a dispute's internal state to something a homeowner should read. The
 * internal names ('crew_review', 'resolved_closed') must never reach a
 * customer's screen, and the copy must never promise money that policy
 * hasn't decided to send.
 */
export function disputeViewForCustomer(d: DisputeViewInput): DisputeView {
  switch (d.status) {
    case "crew_review":
      return {
        pill: "Reported",
        line: "Your crew has been told and it's on them to make this right. You'll hear from them shortly.",
        payOnHold: true, needsCustomer: false,
      };
    case "fixing": {
      const when = prettyDay(d.correctionDate);
      return {
        pill: "Crew is coming back",
        line: when
          ? `Your crew is returning ${when} to put this right — no charge, and you'll get photos when it's done.`
          : "Your crew is coming back to put this right — no charge, and you'll get photos when it's done.",
        payOnHold: true, needsCustomer: false,
      };
    }
    case "verifying":
      return {
        pill: "Your call",
        line: "Your crew stands by the work and sent their photos. Have a look — does that settle it?",
        payOnHold: true, needsCustomer: true,
      };
    case "talk":
      return {
        pill: "In conversation",
        line: "Your crew replied below. Sort it out together here, or tell us it's still not right.",
        payOnHold: true, needsCustomer: true,
      };
    case "escalated":
      return {
        pill: "With our team",
        line: "This one's with us now. We're reviewing it and will come back to you — nothing more for you to do.",
        payOnHold: true, needsCustomer: false,
      };
    case "resolved_fixed":
      return { pill: "Resolved", line: "The return visit sorted it. Thanks for giving us the chance to fix it.", payOnHold: false, needsCustomer: false };
    case "resolved_verified":
      return { pill: "Resolved", line: "You confirmed this one was settled. Thanks.", payOnHold: false, needsCustomer: false };
    case "resolved_refunded":
      return { pill: "Refunded", line: "We sent your money back on this one. Sorry we missed the mark.", payOnHold: false, needsCustomer: false };
    case "resolved_closed":
      return { pill: "Closed", line: "This one's closed out. If anything's still wrong, message us below.", payOnHold: false, needsCustomer: false };
    default:
      return { pill: "Open", line: "We're on this one.", payOnHold: true, needsCustomer: false };
  }
}

/** The same state, in the CREW's words — pay status is what they care about. */
export function disputeViewForCrew(d: DisputeViewInput): DisputeView {
  const base = disputeViewForCustomer(d);
  switch (d.status) {
    case "crew_review":
      return { ...base, pill: "Needs your call", line: "The customer flagged this job. Your pay for it is on hold until it's settled — pick how you want to handle it." };
    case "fixing": {
      const when = prettyDay(d.correctionDate);
      return { ...base, pill: "Return visit booked", line: when ? `You're going back ${when}, free of charge. Photos are still required — your pay releases once it's done and accepted.` : "You're going back free of charge. Photos are still required — your pay releases once it's done and accepted." };
    }
    case "verifying":
      return { ...base, pill: "With the customer", line: "You stood by the work and we sent them your photos. Waiting on their answer; your pay stays on hold until then." };
    case "talk":
      return { ...base, pill: "In conversation", line: "You're talking it through with the customer. Your pay stays on hold until this settles." };
    case "escalated":
      return { ...base, pill: "With LakeLife", line: "This one came to us to decide. Your pay stays on hold until we close it out." };
    case "resolved_refunded":
      return { ...base, pill: "Closed — refunded", line: "The customer was refunded on this one. Your pay was adjusted per the service terms; see Earnings." };
    case "resolved_fixed":
    case "resolved_verified":
    case "resolved_closed":
      return { ...base, pill: "Settled", line: "Settled — your pay for this job has been released." };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// PHOTO GATE
// ---------------------------------------------------------------------------

/** How the photo requirement reads on a crew's screen. */
export function photoGateLabel(count: number, min: number): string {
  if (min <= 0) return `${count} photo${count === 1 ? "" : "s"} on file`;
  if (count >= min) return `${count} / ${min} photos — you're clear to finish`;
  const need = min - count;
  return `${count} / ${min} photos — ${need} more before you can mark this done`;
}
