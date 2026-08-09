/**
 * EXTEND A STAY — PURE, no I/O, fully unit-testable.
 *
 * Two problems, one mechanism.
 *
 * 1. THE REVENUE ONE. A transient guest whose site is booked through Friday
 *    gets a text on Wednesday: "Reply to keep site 12 through the 23rd —
 *    $315." Converting a short stay into a long one is the highest-value
 *    behaviour change in a transient park, and the moment to ask is before
 *    they have started packing, not after.
 *
 * 2. THE CORRECTNESS ONE. Month-to-month tenancies are stored as a ROLLING
 *    FINITE RANGE (phase 2 design §1h — unbounded ranges make the rent roll
 *    report a lot vacant while someone lives on it). Nothing rolled them
 *    forward, so a year after move-in Donna's tenancy would quietly lapse and
 *    her lot would read empty. Same mechanism: extend before the end.
 *
 * The renter has NO ACCOUNT and may never have one, so the only thing that can
 * reach her is a text with a signed link. That is why this is one tap and not
 * a login.
 *
 * WHAT THIS MODULE NEVER DOES: invent a price. The extension is quoted from
 * the park owner's own rate card, exactly like the original stay.
 */

import { nightsIn, type DateRange, type Term } from "@/lib/parks";

/** Nights one period of each term covers. Matches quoteStay's table — if these
 *  two ever disagree, a renter is quoted one thing and given another. */
const TERM_NIGHTS: Record<Term, number> = {
  nightly: 1, weekly: 7, monthly: 30, seasonal: 180, annual: 365,
};

/**
 * How far ahead we ask. Short stays get asked late (a nightly guest does not
 * plan a week out); long tenancies get asked early, because a month-to-month
 * renter needs time and the park owner needs warning to re-let.
 */
export const LEAD_DAYS: Record<Term, number> = {
  nightly: 1, weekly: 2, monthly: 14, seasonal: 30, annual: 45,
};

/** A month-to-month tenancy rolls silently and forever; a transient guest is
 *  asked. Beyond this many automatic rolls we stop and tell the owner, so a
 *  tenancy nobody has looked at in five years surfaces rather than compounding. */
export const MAX_SILENT_ROLLS = 24;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The range this stay becomes if extended by ONE more period.
 *
 * Starts where the current one ends, so the two are contiguous and the
 * exclusion constraint sees a clean hand-off rather than an overlap with
 * itself.
 */
export function extendedRange(current: DateRange, term: Term): DateRange {
  const nights = TERM_NIGHTS[term] ?? 30;
  return { start: current.start, end: addDays(current.end, nights) };
}

/** What one more period costs, from the PARK'S card. Null when the park does
 *  not sell that term any more — we quote nothing rather than guess. */
export function extensionPrice(
  rates: { term: Term; amount: number }[],
  term: Term,
): number | null {
  const card = rates.find((r) => r.term === term && r.amount > 0);
  return card ? card.amount : null;
}

export type RemindDecision = "send" | "already_sent" | "too_early" | "too_late" | "not_extendable";

/**
 * Should tonight's run text this renter?
 *
 * `alreadySent` is the caller's ledger check — the reminder is exactly-once,
 * because a guest texted three nights running about the same checkout stops
 * reading our texts, and the one that matters is the freeze warning.
 */
export function remindDecision(input: {
  range: DateRange | null;
  term: Term;
  status: string;
  todayISO: string;
  alreadySent: boolean;
  extendedCount?: number;
}): RemindDecision {
  const { range, term, status, todayISO, alreadySent } = input;

  // Only a live stay can be extended. An application holds no dates; a
  // cancelled one is over.
  if (!range) return "not_extendable";
  if (status !== "approved" && status !== "active") return "not_extendable";
  if ((input.extendedCount ?? 0) >= MAX_SILENT_ROLLS) return "not_extendable";

  if (alreadySent) return "already_sent";

  const daysLeft = nightsIn({ start: todayISO, end: range.end });
  if (daysLeft < 0) return "too_late";

  const lead = LEAD_DAYS[term] ?? 7;
  // Ask on the day we reach the lead window, or any day inside it — a missed
  // nightly must not lose the reminder forever, which is the same catch-up
  // lesson the waitlist warning learned the hard way.
  if (daysLeft > lead) return "too_early";
  return "send";
}

export type ExtendRefusal =
  | "not_found"
  | "not_extendable"
  | "lot_taken"
  | "no_rate"
  | "already_ended";

/**
 * May this stay be extended right now? The DATABASE is the real guard — the
 * exclusion constraint re-validates the widened range on UPDATE for free, so
 * if the park has booked someone into that window the write simply fails.
 * This exists so the renter reads a sentence instead of an error, and so we
 * do not take a tap we cannot honour.
 */
export function canExtend(input: {
  range: DateRange | null;
  term: Term;
  status: string;
  todayISO: string;
  /** Other DECIDED stays on the same lot. */
  otherHeld: DateRange[];
  rates: { term: Term; amount: number }[];
}): { ok: boolean; refusal?: ExtendRefusal; range?: DateRange; price?: number } {
  const { range, term, status, todayISO, otherHeld, rates } = input;

  if (!range) return { ok: false, refusal: "not_found" };
  if (status !== "approved" && status !== "active") return { ok: false, refusal: "not_extendable" };
  if (range.end < todayISO) return { ok: false, refusal: "already_ended" };

  const price = extensionPrice(rates, term);
  if (price == null) return { ok: false, refusal: "no_rate" };

  const next = extendedRange(range, term);

  // Half-open, matching the exclusion constraint exactly. The stay we are
  // widening is NOT in otherHeld — the caller excludes it — so any overlap
  // here is a genuine conflict with somebody else.
  const clash = otherHeld.some((h) => h.start < next.end && next.start < h.end);
  if (clash) return { ok: false, refusal: "lot_taken" };

  return { ok: true, range: next, price };
}

/** What the renter reads. Never blames them, never mentions another renter. */
export function refusalText(r: ExtendRefusal): string {
  switch (r) {
    case "not_found":       return "We couldn't find that stay. Give the park a call and they'll sort it out.";
    case "not_extendable":  return "This stay can't be extended from here — the park can still do it for you.";
    case "already_ended":   return "That stay has already finished. The park can set up a new one.";
    case "no_rate":         return "The park isn't taking extensions at that rate right now — give them a call.";
    // Deliberately does not say who took it or until when. That is somebody
    // else's business, and the renter only needs to know what to do next.
    case "lot_taken":       return "That site is spoken for after your dates. The park can look for another one.";
  }
}
