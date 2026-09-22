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
 * WHAT THIS MODULE NEVER DOES: invent a price. An extension is quoted from
 * the park owner's own rate card, exactly like the original stay; a renewal
 * at a capped park is quoted at the rent the household already pays, as it
 * stands on the successor's first morning — the caller resolves that from the
 * served history, and the card is only the fallback for a household with no
 * rent on file.
 */

import { nightsIn, type DateRange, type Term } from "@/lib/parks";
import { agreementEnd, chooseAgreementLength, perTermWords } from "@/app/park/agreement-helpers";
import { money } from "@/app/park/ledger-helpers";
import { longDate } from "@/lib/lake-time";

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
export function extendedRange(
  current: DateRange,
  term: Term,
  /**
   * A park that caps agreement length does not EXTEND — it writes the next
   * agreement, and THIS is its length: the household's choice from the
   * lengths the park offers, never the cap. The successor starts the day this
   * one ends, which is what makes the two consecutive and carries the deposit
   * forward. See app/park/agreement-helpers.ts. Null means an extension.
   */
  renewMonths?: number | null,
  /**
   * The checkout morning the lot's season sets, when it has one — from
   * agreementSeasonEnd, the same value the owner's door hands planRenewal.
   * A renewal ends at whichever comes first, the chosen length or this.
   */
  seasonEnd?: string | null,
): DateRange {
  if (renewMonths != null) {
    // THE ONE END ARITHMETIC (agreement-helpers agreementEnd): month
    // arithmetic that clamps Jan 31, and the season clamp, so the resident's
    // door and the owner's cannot disagree about either. This door used to
    // add the months and nothing else: on a slip lot closing 15 October the
    // owner's Renew wrote [Sep 1, Oct 16) and the household's own tap for
    // three months wrote [Sep 1, Dec 1) — two rows for one act.
    return { start: current.end, end: agreementEnd(current.end, renewMonths, { seasonEnd: seasonEnd ?? null })! };
  }
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
  | "already_ended"
  | "already_renewed"
  | "inherited"
  | "length_missing"
  | "length_not_offered"
  | "season_closed";

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
  /** Other DECIDED stays on the same lot — SOMEBODY ELSE'S. The caller
   *  partitions the household's own next agreement into `ownSuccessor`. */
  otherHeld: DateRange[];
  /**
   * THE HOUSEHOLD'S OWN LATER ROW on this lot, when one is already written
   * — by their earlier tap, or by the office for them. At a CAPPED park it
   * is their next agreement, judged before the clash test AND before
   * `already_ended`, so a household who renewed reads "you're already set"
   * — never "that lot is spoken for" (what it read as in `otherHeld`), and
   * never "that stay has already finished" when they re-open the link after
   * the old row's end with the next one in force. At a park with NO cap
   * nothing is renewed — the stay is widened — so a guest's own later
   * booking is simply one more held range for the clash test, exactly as
   * anybody else's would be.
   */
  ownSuccessor?: DateRange | null;
  rates: { term: Term; amount: number }[];
  /** The park's agreement cap, when it has one — the switch between an
   *  extension (no cap) and a renewal (a cap). Never the length. */
  capMonths?: number | null;
  /** The park's house style — with the cap, what decides which lengths it
   *  offers (offeredAgreementLengths). Read only at a capped park. */
  defaultMonths?: number | null;
  /**
   * THE RENEWAL'S LENGTH, in months — the household's choice, judged HERE
   * against the lengths the park offers by the one judgement every writing
   * door reads (chooseAgreementLength). Read only at a capped park. A capped
   * park with no length is refused as `length_missing`, never written at the
   * cap; a length the park does not write is `length_not_offered`.
   */
  renewMonths?: number | null;
  /**
   * The checkout morning the lot's season sets (agreementSeasonEnd), or null
   * for a year-round lot. A renewal is cut to it, and one that would START
   * on or after it is refused — there is nothing to renew into.
   */
  seasonEnd?: string | null;
  /**
   * What this tenant pays on the successor's first morning — the caller
   * resolves it from the served rent history, so an increase already noticed
   * for a date before the renewal starts is in it. On a renewal THIS is the
   * price shown and written; the card is only for a household with no rent on
   * file.
   */
  currentAmount?: number | null;
  /** How the current agreement came to be. A household still on the seller's
   *  arrangement ('grandfathered') signs its new lease with the park, never
   *  from this link. */
  origin?: string | null;
}): {
  ok: boolean;
  refusal?: ExtendRefusal;
  range?: DateRange;
  price?: number;
  isRenewal?: boolean;
  /**
   * TRUE when the season close, not the chosen length, set the range's end
   * — the same judgement the owner's plan carries (cutShortBySeason), so
   * the page after the tap never calls six weeks "3 months".
   */
  cutShortBySeason?: boolean;
} {
  const {
    range, term, status, todayISO, otherHeld, rates, capMonths, defaultMonths, renewMonths, seasonEnd,
    currentAmount, origin, ownSuccessor,
  } = input;

  if (!range) return { ok: false, refusal: "not_found" };
  if (status !== "approved" && status !== "active") return { ok: false, refusal: "not_extendable" };
  // Before 'already_ended', as on the owner's side. A holdover's new lease is
  // a particular act, recorded from the roll's signing control, and this
  // household has a sentence that says exactly that — where 'already_ended'
  // could only send them to the phone. This link must not be a second door to
  // the signing control either.
  if (origin === "grandfathered") return { ok: false, refusal: "inherited" };
  // THEIR NEXT AGREEMENT IS ALREADY WRITTEN — a renewal-path fact, so only at
  // a capped park. Nothing to choose, the clash test below must never see it
  // as somebody else's booking, and it outranks 'already_ended': the old
  // row's end is behind them precisely because the next one has begun, and
  // "that stay has already finished" — with nothing after it but a phone
  // call — is a lie to a household whose new one is in force.
  if (capMonths != null && ownSuccessor) return { ok: false, refusal: "already_renewed" };
  if (range.end < todayISO) return { ok: false, refusal: "already_ended" };

  // The park's asking rate, when it publishes one for this term.
  let price = extensionPrice(rates, term);

  // A RENEWAL IS AT THE RENT THEY ALREADY PAY. At a park that caps agreement
  // length, renewing is the normal way to stay. The card is the ASKING rate —
  // what a new tenant would be quoted — and writing it onto a sitting tenant's
  // next agreement would be a rent change nobody served notice on; the owner
  // raises a sitting tenant's rent from the re-rate screen, with notice, and
  // that increase arrives here inside `currentAmount`. The card is the
  // fallback for a household with no rent on file, so an empty card never
  // strands somebody who has paid the same rent for a year — and a missing
  // rent never refuses somebody the park has a price for.
  if (capMonths != null && currentAmount != null && currentAmount > 0) {
    price = currentAmount;
  }
  if (price == null) return { ok: false, refusal: "no_rate" };

  // A RENEWAL HAS THE LENGTH THE HOUSEHOLD PICKED. The cap used to be passed
  // here as the length, so every tap wrote the maximum. Without a length there
  // is nothing to write, and saying so beats writing the cap; a length the
  // park does not write is refused by the one judgement of a chosen length,
  // so this verdict IS the list of buttons the page may show.
  if (capMonths != null) {
    if (renewMonths == null) return { ok: false, refusal: "length_missing" };
    if (!chooseAgreementLength(renewMonths, defaultMonths ?? null, capMonths).ok) {
      return { ok: false, refusal: "length_not_offered" };
    }
    // A renewal that would begin after the season has closed is not a
    // renewal — as on the owner's side (planRenewal), there is nothing to
    // renew into until the season opens again.
    if (seasonEnd != null && range.end >= seasonEnd) return { ok: false, refusal: "season_closed" };
  }
  const next = extendedRange(range, term, capMonths != null ? renewMonths : null, capMonths != null ? seasonEnd : null);

  // Half-open, matching the exclusion constraint exactly. The stay we are
  // widening is NOT in otherHeld — the caller excludes it — so any overlap
  // here is a genuine conflict. At a park with no cap the guest's own later
  // booking is held too: an extension that ran into it would be refused by
  // the database just the same, and they read a sentence instead.
  const held = capMonths == null && ownSuccessor ? [...otherHeld, ownSuccessor] : otherHeld;
  const clash = held.some((h) => h.start < next.end && next.start < h.end);
  if (clash) return { ok: false, refusal: "lot_taken" };

  return {
    ok: true,
    range: next,
    price,
    isRenewal: capMonths != null,
    // Cut short when the length alone would have ended it later.
    cutShortBySeason: capMonths != null && renewMonths != null
      && next.end !== extendedRange(range, term, renewMonths, null).end,
  };
}

/**
 * What the renter reads. Never blames them, never mentions another renter.
 *
 * `nextAgreement` is the household's own successor, for `already_renewed`
 * — the sentence names its dates in words, the way the page after the tap
 * did, so a re-opened link says the same thing the tap said.
 *
 * `rentalMode` picks the noun (lotWord) where a sentence names the lot: a
 * long-term household whose page title says "lot 14" was told "that SITE is
 * spoken for" one refusal later.
 */
export function refusalText(
  r: ExtendRefusal,
  nextAgreement?: DateRange | null,
  rentalMode?: string | null,
): string {
  switch (r) {
    case "not_found":       return "We couldn't find that stay. Give the park a call and they'll sort it out.";
    case "not_extendable":  return "This stay can't be extended from here — the park can still do it for you.";
    // NAMES NO DOOR AT THE PARK, because there is not always one. A stay that
    // ran out a few weeks ago the owner can still renew from its own end. Once
    // more time has passed than the longest agreement the park writes, every
    // length he could pick would be over before it started and his screen
    // refuses him too — and "the park can set up a new one" was then a promise
    // made to the household about a control the park does not have. Calling
    // them is true on either side of that line, and it is the only thing this
    // page can honestly ask them to do.
    case "already_ended":   return "That stay has already finished. Give the park a call and they'll sort out what happens next.";
    // Their own next agreement is written — by their tap, or by the office
    // for them. Not an error, and never "spoken for": the site is theirs.
    case "already_renewed":
      return nextAgreement
        ? `You're already set — your next agreement runs ${longDate(nextAgreement.start)} to ${longDate(nextAgreement.end)}. The park will send the agreement to sign.`
        : "You're already set — your next agreement is written. The park will send the agreement to sign.";
    case "no_rate":         return "The park isn't taking extensions at that rate right now — give them a call.";
    // Deliberately does not say who took it or until when. That is somebody
    // else's business, and the renter only needs to know what to do next.
    case "lot_taken":       return `That ${lotWord(rentalMode)} is spoken for after your dates. The park can look for another one.`;
    // A household inherited from the previous owner signs its new lease with
    // the park; that act ends the old arrangement and is recorded from the
    // rent roll, not from a tap on a text.
    case "inherited":       return "Your new agreement is signed with the park — give them a call and they'll have it ready.";
    // The tap named NO length at a park where the length is the household's
    // choice — a form that lost its field, a link opened by hand. The page
    // this sends them back to shows one button per length.
    case "length_missing":
      return "Pick how long to renew for — open the link again and tap one of the lengths it offers.";
    // The tap named a length the park does not write — a replayed link, or a
    // cap that changed since the text went out. The page lists the ones it does.
    case "length_not_offered":
      return "The park doesn't write agreements of that length. Open the link again and pick one of the lengths it offers.";
    // The lot's season closes before the next agreement would start — the
    // slips are out of the water. As on the owner's side, nothing to renew
    // into; the park books them in again when it opens.
    case "season_closed":
      return "Your spot is closed for the season after your dates, so there's nothing to renew into yet — the park can book you in again when it opens.";
  }
}

// ---------------------------------------------------------------------------
// THE WORDS A HOUSEHOLD READS ABOUT THEIR LOT AND THEIR RENT — one home for
// the text that mints the token, the page it opens and the page after the
// tap, so none of the three can say a number or a noun the others do not.
// ---------------------------------------------------------------------------

/**
 * "lot" for a household that lives there; "site" for a pad booked by the
 * night. The text and the page said "site 2" to a long-term household whose
 * lease, invite and own home page all say "Lot 2".
 */
export function lotWord(rentalMode: string | null | undefined): "lot" | "site" {
  return rentalMode === "short_term" ? "site" : "lot";
}

/** A fee the successor's household will be billed each month, by label. */
export interface MonthlyFee {
  label: string;
  amount: number;
}

/**
 * WHAT THE NEXT AGREEMENT COSTS A MONTH, in the household's words —
 * "$400.00 rent plus the $142.53 Grounds fee — $542.53 a month". The rent
 * alone is what they are quoted; the fee is what the ledger will bill from
 * the successor's first morning (the owner's signing toast already says
 * "$542.53 ($400.00 rent + $142.53 fees)"), and a text that names only the
 * rent understates the bill by a third. With no fee it is plain "$400.00 a
 * month" — a park with no fee never reads "with the fees". The fee's label
 * is the park's own, never a typed-in name. Only a monthly rent combines
 * with a monthly fee; any other term quotes the rent alone.
 */
export function renewalRentWords(input: {
  price: number | null;
  term: string;
  fees?: readonly MonthlyFee[] | null;
}): string {
  if (input.price == null) return "";
  const per = perTermWords(input.term);
  const rent = `${money(input.price)}${per ? ` ${per}` : ""}`;
  const fees = (input.fees ?? []).filter((f) => f.amount > 0);
  if (input.term !== "monthly" || fees.length === 0) return rent;
  const feeTotal = Math.round(fees.reduce((sum, f) => sum + f.amount, 0) * 100) / 100;
  const all = Math.round((input.price + feeTotal) * 100) / 100;
  const named = fees.length === 1
    ? `the ${money(fees[0].amount)} ${fees[0].label}`
    : `${money(feeTotal)} in fees (${fees.map((f) => f.label).join(", ")})`;
  return `${money(input.price)} rent plus ${named} — ${money(all)} a month`;
}
