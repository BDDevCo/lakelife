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

/**
 * THE SAME COUNT, TOLD TO THE PERSON WHO IS BEING ASKED TO JUDGE IT.
 *
 * The crew sees "3 / 4 photos — 1 more before you can mark this done". The
 * customer saw "4 photos from your crew" and nothing else — the minimum was
 * loaded into their view model and never printed. So when four photos arrive
 * for a fall winterization they have no way to know the gate was four, and
 * cannot tell a job that cleared the bar from a thin one. That is exactly the
 * judgement the 👍/👎 underneath is asking them to make, and the 👎 is what
 * holds the crew's pay.
 *
 * BEFORE THE JOB IS DONE, A SHORT COUNT IS NOT A SHORTFALL. Crews upload as
 * they work, so two-of-four mid-morning is normal and must not read as a crew
 * cutting corners. Only a finished job can be judged against its minimum.
 *
 * @param done whether the crew has marked the job complete.
 */
export function customerPhotoLabel(count: number, min: number, done: boolean): string {
  const photos = `${count} photo${count === 1 ? "" : "s"}`;
  if (min <= 0) return `${photos} from your crew, taken on site.`;
  if (!done) return `${photos} so far — ${min} are required before your crew can finish.`;
  if (count > min) return `${photos} from your crew — ${min} were required.`;
  return `${photos} from your crew — all ${min} required.`;
}

/**
 * WHAT AN EMPTY GALLERY MEANS, WHICH DEPENDS ENTIRELY ON WHEN YOU ASK.
 *
 * One sentence covered every status but cancelled: "No photos yet — they land
 * here the moment your crew finishes." On a COMPLETED visit that tells the
 * customer to keep waiting for something that is never coming. And if the
 * service carries a minimum, rows must exist for the job to have reached
 * complete at all — so an empty gallery there is ours to fix, not their cue to
 * wait. (`signedJobPhotos` returns nothing when the files behind the rows have
 * gone missing; it logs that, loudly, for the same reason.)
 */
export function emptyPhotoNote(status: string, minPhotos: number): string {
  if (status === "cancelled") return "No photos — this one was cancelled.";
  const done = status === "complete" || status === "paid";
  if (!done) return "No photos yet — they land here the moment your crew finishes.";
  if (minPhotos > 0) {
    return (
      `We can't show the photos for this visit right now — ${minPhotos} were required ` +
      `before your crew could mark it done. Tell us and we'll get them up.`
    );
  }
  return "This service doesn't call for photos, so your crew didn't take any.";
}

/**
 * IS THIS JOB STILL THIS CREW'S TO WORK?
 *
 * The gate code is the sharpest consumer, and the reason this lives here rather
 * than inline: the guard was written once, in job-detail-data.ts, with the
 * comment "Only a live assignment opens the door" — and the OTHER lane that
 * renders the same value, getVendorDay, never got it. A homeowner cancelling a
 * pier removal on Thursday left the crew holding the plaintext door code all
 * day Friday, on the route card, under the caption "Shown only today, for this
 * job" — about a job that no longer existed. Cancelling does not clear
 * `vendor_id` (it is read afterwards to pay the crew their slot share), so the
 * row keeps coming back for that crew.
 *
 * One exported predicate, used by both, so the next reader cannot inherit the
 * hole.
 */
export const LIVE_ASSIGNMENT_STATUSES = ["scheduled", "in_progress", "complete", "paid"] as const;

export function assignmentIsLive(status: string | null | undefined): boolean {
  return LIVE_ASSIGNMENT_STATUSES.includes(status as (typeof LIVE_ASSIGNMENT_STATUSES)[number]);
}
