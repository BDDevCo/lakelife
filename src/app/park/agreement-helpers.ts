/**
 * AGREEMENTS THAT END, AND RENEWALS THAT CHAIN.
 *
 * The Haven's rule: no agreement runs longer than the park's cap. Somebody may
 * stay as long as they like, but each further period is a NEW agreement
 * executed on its own — and if the periods are CONSECUTIVE, no second deposit
 * is collected.
 *
 * THE LENGTH IS THE HOUSEHOLD'S CHOICE, NOT THE CAP. The owner's decision:
 * "options for them to have a 1 month, 3 month or 6 month renew." At every
 * signing and every renewal the household picks from the lengths the park
 * offers — the standard lengths (`AGREEMENT_LENGTHS`) that fit under its cap
 * — and the park's house style (`default_agreement_months`) is only what the
 * choice STARTS on. Until now the cap was passed through as the length, so
 * "Renew at the same rent" turned every one-month lease into a three-month
 * one, silently, and would have turned it into a six-month one the day the
 * cap was raised. The length is chosen exactly once, at the moment a row is
 * written, and nothing edits `during` afterwards — so every writing door
 * takes the choice as an input, and refuses one the park does not offer.
 *
 * Three things follow, and they are the whole of this file:
 *
 *   1. An agreement's end is computed from its start and the CHOSEN length,
 *      with real month arithmetic. Not 90 days. Dec 15 → Mar 15.
 *   2. A renewal is a SUCCESSOR, not a wider date range. Widening would erase
 *      the discrete signed period the structure exists to create.
 *   3. CONSECUTIVE is a precise thing — the next agreement starts the day the
 *      last one ends — and it is the only thing that carries a deposit
 *      forward. A gap means they left, and coming back is a new chain.
 */

import { longDate } from "@/lib/lake-time";
import { isSeasonal, type ParkSeason } from "@/lib/parks";
import { prettyMonth } from "./ledger-helpers";

/**
 * Add whole months, clamping to the end of the target month.
 *
 * Jan 31 + 1 month is Feb 28, not Mar 3. Naive date arithmetic rolls over and
 * would quietly hand somebody three extra days on a lot — and, at renewal
 * time, drift the whole chain later month by month.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

/**
 * How many months a half-open agreement REALLY ran, by the same calendar
 * arithmetic that wrote its end: whole months by stepping `addMonths` from the
 * start, and a remainder of fifteen days or more counts as one more. Never
 * negative.
 *
 * This replaces `seq × cap`, which assumed every link in a chain was written
 * at the cap. At The Haven the first signed lease is ONE month and the renewal
 * is three, so multiplying the sequence number by the cap said a household had
 * held the lot for six months after four — and, later in the chain, would have
 * spoken the long-run sentence a season before it was true.
 */
export function monthsBetween(startISO: string, endISO: string): number {
  if (endISO <= startISO) return 0;
  let n = 0;
  while (addMonths(startISO, n + 1) <= endISO) n += 1;
  const rest = daysBetween(addMonths(startISO, n), endISO);
  return rest >= 15 ? n + 1 : n;
}

/**
 * HOW FAR AHEAD AN AGREEMENT IS ASKED FOR RENEWAL — the R2 ruling.
 *
 * Today's "Agreements to write" list asked for every agreement ending within
 * a flat 45 days. With the length now the household's choice and the house
 * style one month, that flat lead is longer than the agreement: a one-month
 * renewal written on 1 February for 1 February – 1 March was back in the
 * list the same morning, reading "ends March 1, 2027" under the toast that
 * said it was renewed — which looks like the tap did not take. On 1 January
 * all 21 one-month leases would sit in the list from the day they were
 * signed.
 *
 * So the lead is a function of the agreement's OWN span: it is asked for
 * renewal in its last half, and never more than `cap` days ahead. A
 * one-month agreement lists in its last ~15 days; a three-month one 45 days
 * out, as before. Whole days; an odd day goes to the lead, so every
 * three-month span (89–92 days) reaches the cap and a 31-day month asks in
 * its last 16.
 */
export const RENEWAL_LEAD_CAP_DAYS = 45;

export function renewalLeadDays(
  startISO: string,
  endISO: string,
  cap: number = RENEWAL_LEAD_CAP_DAYS,
): number {
  const span = Math.max(0, daysBetween(startISO, endISO));
  return Math.min(cap, Math.ceil(span / 2));
}

// ------------------------------------------------ the lengths on offer -----

/**
 * THE LENGTHS A HOUSEHOLD MAY CHOOSE BETWEEN, in months. The owner named
 * one, three and six; twelve is on the list so a park with no cap, or a cap
 * of a year, can offer it. A park's cap filters the list — at a cap of three
 * the choice is one or three; at six it is one, three or six. Nothing here
 * assumes any park's cap: it is read from `parks.max_agreement_months` by
 * every door, and the 0065 trigger refuses a row longer than it regardless.
 */
export const AGREEMENT_LENGTHS: readonly number[] = [1, 3, 6, 12];

/**
 * HOW LONG ONE NEW AGREEMENT RUNS WHEN NOBODY CHOOSES — the park's house
 * style under its ceiling. This is the length every choice STARTS on.
 *
 * THE CAP AND THE DEFAULT ARE DIFFERENT NUMBERS, and 0067 added
 * `parks.default_agreement_months` specifically to stop them being conflated:
 * "Three months max, but typically month to month ... conflating them writes
 * every new tenant a three-month agreement when the house style is one month
 * rolling." The column shipped with neither a reader nor a writer, so the cap
 * was passed straight through as the length and every signed agreement was
 * written at the MAXIMUM — the exact bug that comment describes. It matters
 * most on a day everybody signs at once: twenty agreements written on one
 * afternoon all end on one morning, and when they do the rent stops with no
 * error anywhere.
 *
 * Clamped, because a default longer than the cap is a contradiction the
 * database also refuses (parks_default_within_max), and because the 0065
 * trigger rejects any agreement longer than the cap outright. Null only when
 * the park has set neither dial, which means the rolling horizon.
 */
export function agreementMonthsFor(
  defaultMonths: number | null,
  capMonths: number | null,
): number | null {
  if (defaultMonths == null) return capMonths;
  if (capMonths == null) return defaultMonths;
  return Math.min(defaultMonths, capMonths);
}

/**
 * THE LENGTHS THIS PARK OFFERS, ascending: the standard lengths that fit
 * under its cap (no cap: all of them), always including its own house style
 * so a park whose default is not on the standard list still offers it. EMPTY
 * for a park with neither dial — such a park writes no fixed-length
 * agreement at all (the rolling horizon, see `agreementMonthsFor`), and an
 * empty list is how every door knows there is nothing to choose.
 */
export function offeredAgreementLengths(
  defaultMonths: number | null,
  capMonths: number | null,
): number[] {
  if (defaultMonths == null && capMonths == null) return [];
  const cap = capMonths ?? Number.POSITIVE_INFINITY;
  const offered = new Set(AGREEMENT_LENGTHS.filter((m) => m <= cap));
  const house = agreementMonthsFor(defaultMonths, capMonths);
  if (house != null) offered.add(house);
  return [...offered].sort((a, b) => a - b);
}

/**
 * THE ONE JUDGEMENT OF A CHOSEN LENGTH, for every door that writes a row:
 * the owner's Renew button, the resident's texted link, the roll's signing
 * control, "Someone lives here" and "Who lives here". A length the park does
 * not offer is refused in words that name the ones it does; at a park with
 * neither dial the only right answer is no length (the horizon), so a length
 * sent there is refused too rather than quietly written. A missing choice is
 * refused, never defaulted here — the screens seed the park's house style,
 * so a blank reaching this point is a caller that lost the choice.
 */
export function chooseAgreementLength(
  chosen: number | null | undefined,
  defaultMonths: number | null,
  capMonths: number | null,
): { ok: true; months: number | null } | { ok: false; error: string } {
  const offered = offeredAgreementLengths(defaultMonths, capMonths);
  if (offered.length === 0) {
    return chosen == null
      ? { ok: true, months: null }
      : { ok: false, error: "This park doesn't write fixed-length agreements, so there's no length to pick." };
  }
  if (chosen == null) {
    return { ok: false, error: `Pick how long the agreement runs — ${lengthsInWords(offered)}.` };
  }
  if (!offered.includes(chosen)) return { ok: false, error: lengthNotOfferedText(offered) };
  return { ok: true, months: chosen };
}

/** "This park writes agreements of 1, 3 or 6 months — pick one of those." */
export function lengthNotOfferedText(offered: number[]): string {
  return offered.length
    ? `This park writes agreements of ${lengthsInWords(offered)} — pick one of those.`
    : "This park doesn't write fixed-length agreements, so there's no length to pick.";
}

/** "1 month", "3 months" — a length a person reads. */
export function lengthInWords(months: number): string {
  return `${months} ${months === 1 ? "month" : "months"}`;
}

/** "1, 3 or 6 months"; "1 or 3 months"; "1 month" — a list of lengths. */
export function lengthsInWords(months: readonly number[]): string {
  if (months.length === 0) return "";
  if (months.length === 1) return lengthInWords(months[0]);
  const head = months.slice(0, -1).join(", ");
  const last = months[months.length - 1];
  return `${head} or ${last} months`;
}

/** "one-month", "3-month" — the adjective in "under your one-month term". */
export function lengthAdjective(months: number): string {
  return `${months === 1 ? "one" : months}-month`;
}

/**
 * "a month", "a week", "a night" — the words after a rent figure, from the
 * tenancy's term. Every sentence that quotes a rent reads this so a weekly
 * pad is never told its rent is "a month"; an unknown term gets no words at
 * all rather than a wrong cadence.
 */
export function perTermWords(term: string | null | undefined): string {
  switch (term) {
    case "nightly": return "a night";
    case "weekly": return "a week";
    case "monthly": return "a month";
    case "seasonal": return "for the season";
    case "annual": return "a year";
    default: return "";
  }
}

export interface AgreementTerms {
  /**
   * The park's CEILING — the longest agreement it writes. NULL means the park
   * writes agreements of any length, and a renewal is refused as `no_cap`:
   * there is nothing to renew, the stay just continues.
   */
  maxAgreementMonths: number | null;
  /** The park's house style — what a choice starts on. NULL means "the cap". */
  defaultAgreementMonths?: number | null;
  /** What the park collects once per chain. NULL means none. */
  depositAmount: number | null;
  /**
   * The first morning AFTER this lot's season, when it has one — from
   * `agreementSeasonEnd`, never typed inline. An agreement ends at whichever
   * comes first — the chosen length or the season close.
   */
  seasonEnd?: string | null;
}

/**
 * THE CHECKOUT MORNING A LOT'S SEASON SETS for an agreement starting on
 * `startISO` — the `seasonEnd` every door hands `agreementEnd` and
 * `planRenewal`. ONE home: the owner's Renew button computed this inline and
 * the resident's texted link never computed it at all, so on a slip lot the
 * two doors wrote different rows for the same choice.
 *
 * THE CLOSE DAY IS THE LAST NIGHT, half-open like everything else: a lot that
 * closes 15 October sells the night of the 15th (parkOpenFor says so, and
 * seasonEndAfter's "a season closing Oct 31 returns Nov 1"), so its
 * agreements end on the morning of the 16th. The inline copy ended them on
 * the 15th — one night short of what the park's own booking gate would sell.
 *
 * THIS season's end, not the next one's: a start after the close gets back
 * the close it has already passed, so planRenewal's `start >= seasonEnd`
 * refuses it as season_closed. seasonEndAfter rolls forward to next year's
 * close instead — right for "when must a stay from here be out by", wrong
 * here, where it would plan three winter months on a slip that is out of the
 * water. A window that wraps the New Year (open November, close March)
 * closes in the year AFTER the open the start sits in.
 *
 * Null for a year-round lot — nothing to clamp to.
 */
export function agreementSeasonEnd(startISO: string, season: ParkSeason): string | null {
  if (!isSeasonal(season)) return null;
  const [y, m, d] = startISO.split("-").map(Number);
  const md = m * 100 + d;
  const open = season.openMonth! * 100 + season.openDay!;
  const close = season.closeMonth! * 100 + season.closeDay!;
  const year = open <= close || md < open ? y : y + 1;
  // Day + 1: the morning after the last night.
  return new Date(Date.UTC(year, season.closeMonth! - 1, season.closeDay! + 1))
    .toISOString().slice(0, 10);
}

/**
 * The end date of an agreement starting on `startISO` and running for
 * `termMonths` — THE CHOSEN LENGTH, never the cap. Null length means the park
 * writes no fixed term, and the only end is the season's, if any.
 *
 * Half-open, matching the database: the tenant is there through the night
 * before this date, and it is checkout morning.
 */
export function agreementEnd(
  startISO: string,
  termMonths: number | null,
  terms: Pick<AgreementTerms, "seasonEnd">,
): string | null {
  const ends = termMonths == null ? null : addMonths(startISO, termMonths);

  // WHICHEVER COMES FIRST. A three-month slip agreement taken out in September
  // would otherwise run to December, and the slips come out of the water in
  // October. Selling somebody a slip for a month it does not exist is the kind
  // of error that is discovered by the customer.
  const season = terms.seasonEnd ?? null;
  if (ends == null) return season;
  if (season == null) return ends;
  return season < ends ? season : ends;
}

export interface PriorAgreement {
  id: string;
  chainId: string;
  seq: number;
  /** Half-open. `end` is checkout morning. */
  start: string;
  end: string;
  quotedAmount: number | null;
  term: string;
  /**
   * Whole months this chain has run by the end of `prior`, summed from every
   * link's REAL dates (see `monthsBetween`). The caller that has the chain's
   * rows passes it. Left out, the prior's own span stands in — exact for a
   * chain of one, an undercount for a longer one, and never `seq × cap`.
   */
  chainMonthsSoFar?: number;
}

export type RenewalRefusal =
  | "no_cap"
  | "not_offered"
  | "already_ended"
  | "not_yet_renewable"
  | "season_closed"
  | "inherited";

/**
 * THE LABEL ON THE ROLL'S SIGNING CONTROL — the one home for the words Today,
 * the fee page, the filing screen and every refusal that sends him to it all
 * render. Homed here, the leaf of the park helpers, so a sentence in this
 * file can name the control without importing sign-helpers back up the graph
 * (sign-helpers imports `addMonths` from here). The screens that import the
 * label from sign-helpers get the same words — agreement-helpers.test.ts
 * pins the two equal. Render this; never retype it — retyped, the words
 * outlive the button.
 */
export const SIGNED_LEASE_LABEL = "They signed the new lease";

/**
 * A household still on the seller's arrangement has no successor to write
 * from here. Their new lease is recorded from their row on the rent roll —
 * that control is the one act that ends the holdover and starts the fee — and
 * this sentence names it rather than a button this screen does not have.
 */
export function inheritedRefusalText(lotNumber: string | null | undefined): string {
  const who = lotNumber ? `Lot ${lotNumber} is` : "This household is";
  return (
    `${who} still on the arrangement they had with the previous owner. When they ` +
    `sign your new lease, record it from their row on the rent roll — '${SIGNED_LEASE_LABEL}'.`
  );
}

export function renewalRefusalText(
  r: RenewalRefusal,
  lotNumber: string | null | undefined,
  /**
   * The lengths the park does offer — named when the chosen one is not.
   * REQUIRED: defaulted to [] this read "This park doesn't write fixed-length
   * agreements" for `not_offered`, which the planner returns only when the
   * cap IS set. Every caller has the list; none may leave it out.
   */
  offered: number[],
): string {
  switch (r) {
    case "no_cap":
      return "This park doesn't write fixed-length agreements, so there's nothing to renew — the stay just continues.";
    case "not_offered":
      return lengthNotOfferedText(offered);
    // THE RULE IS ON THE PLAN, not the prior: a short lapse is backfilled
    // consecutively (the household never left), and this fires only when
    // even the longest length the park writes, run from the old end, would
    // be over before today. It names no door — the card has none for this —
    // and "Start a new one instead" used to point at a control the owner's
    // screen does not have. And no duration claim: at a park that writes
    // one-month agreements, one day past that length is not "so long ago".
    case "already_ended":
      return "That agreement has run out, and even the longest agreement this park writes, run from its end, would be over already — there's nothing to write from here.";
    case "not_yet_renewable":
      return "It's too early to renew this one.";
    case "season_closed":
      return "That spot is closed for the season. You can book it again when the season opens.";
    case "inherited":
      return inheritedRefusalText(lotNumber);
  }
}

export interface PlannedRenewal {
  ok: boolean;
  refusal?: RenewalRefusal;
  /** The successor's half-open range. */
  start?: string;
  end?: string;
  /** The length it was planned at — the household's choice, in months. */
  termMonths?: number;
  /**
   * TRUE when the season close, not the chosen length, set `end` — a
   * September slip agreement chosen at three months that the slips coming
   * out on 15 October cuts to six weeks. The one place that judgement is
   * made; every sentence that quotes the length beside the dates reads it,
   * so none can call a six-week agreement "3 months".
   */
  cutShortBySeason?: boolean;
  /** Same chain when consecutive; a brand-new chain when there was a gap. */
  continuesChain?: boolean;
  nextSeq?: number;
  /**
   * TRUE only when a deposit must actually be collected — which is to say,
   * only when this is NOT a consecutive renewal. This is the owner's rule
   * expressed as one boolean, and the database refuses to record a deposit on
   * a renewal regardless, so the two cannot drift apart.
   */
  depositDue?: boolean;
  depositAmount?: number | null;
  /**
   * How long this person will have held the lot once this agreement runs out,
   * counting the whole chain by its real dates. The number that makes a
   * two-year residency visible instead of implied.
   */
  totalMonthsAfter?: number;
}

/**
 * Plan the next agreement in a chain.
 *
 * `termMonths` is THE HOUSEHOLD'S CHOICE — one of the lengths the park offers
 * (`offeredAgreementLengths`), and refused as `not_offered` otherwise. It is
 * the successor's length; the cap in `terms` is only the ceiling and the
 * `no_cap` sentinel, never the length.
 *
 * `startFrom` defaults to the prior agreement's end, which is what makes it
 * consecutive. Passing a later date is how somebody comes back after a gap —
 * and that starts a new chain and a new deposit, deliberately.
 */
export function planRenewal(
  prior: PriorAgreement,
  terms: AgreementTerms,
  todayISO: string,
  termMonths: number,
  startFrom?: string,
): PlannedRenewal {
  if (terms.maxAgreementMonths == null) return { ok: false, refusal: "no_cap" };
  const offered = offeredAgreementLengths(terms.defaultAgreementMonths ?? null, terms.maxAgreementMonths);
  if (!offered.includes(termMonths)) return { ok: false, refusal: "not_offered" };

  const start = startFrom ?? prior.end;
  const end = agreementEnd(start, termMonths, terms)!;

  // A renewal that would begin after the season has already closed is not a
  // renewal — there is nothing to renew into until the season opens again.
  if (terms.seasonEnd != null && start >= terms.seasonEnd) {
    return { ok: false, refusal: "season_closed" };
  }

  // CONSECUTIVE means the next one begins the morning the last one ends. Not
  // "close to"; not "within a few days". A gap is a period during which the
  // lot was theirs to lose, and the deposit went back.
  const continuesChain = start === prior.end;

  // A start before the prior's end would overlap the household with itself.
  if (!continuesChain && start < prior.end) {
    return { ok: false, refusal: "not_yet_renewable" };
  }

  // THE RULE IS ON THE PLAN, NOT ON THE PRIOR. A lapsed agreement is planned
  // consecutively from its own end on purpose — the household never left, and
  // the successor covers the days since (a one-month lease ended 1 February,
  // renewed on the 16th, is written 1 February – 1 March). What cannot be
  // written is a successor that is OVER before it exists: on 17 June, one
  // month from 1 February ends 1 March, and that row would bill nothing, hold
  // nothing, and re-list the lot tomorrow one month further along. So the
  // plan is refused when its own end does not reach past today, whatever
  // start it was given. The guard this replaces read
  // `!continuesChain && todayISO > prior.end && startFrom === undefined` —
  // and with startFrom undefined the start IS the prior's end, so
  // continuesChain was always true and the branch could never fire.
  if (end <= todayISO) {
    return { ok: false, refusal: "already_ended" };
  }

  // REAL LENGTHS, both sides. The successor's own span (season-clamped when
  // the slips come out early) plus what the chain has actually run — never the
  // cap multiplied by a sequence number.
  const months = monthsBetween(start, end);
  const priorMonths = continuesChain
    ? (prior.chainMonthsSoFar ?? monthsBetween(prior.start, prior.end))
    : 0;

  return {
    ok: true,
    start,
    end,
    termMonths,
    cutShortBySeason: end !== addMonths(start, termMonths),
    continuesChain,
    nextSeq: continuesChain ? prior.seq + 1 : 1,
    // The whole point: consecutive costs nothing extra.
    depositDue: !continuesChain && terms.depositAmount != null && terms.depositAmount > 0,
    depositAmount: continuesChain ? null : terms.depositAmount,
    totalMonthsAfter: priorMonths + months,
  };
}

/**
 * THE SPAN A PLAN WAS WRITTEN FOR, IN WORDS — what the toast says back and
 * what the Today card says under the chips, from ONE home so they cannot
 * disagree: "3 months, September 1, 2027 to December 1, 2027", or, when the
 * season set the end instead of the length, "3 months, cut short by the
 * season close — September 1, 2027 to October 16, 2027". Reads the PLAN,
 * never the request: the length he picked and the dates the row will carry
 * are both on it. Empty for a refused plan — the caller reads the refusal.
 */
export function agreementSpanWords(plan: PlannedRenewal): string {
  if (!plan.ok || plan.termMonths == null || !plan.start || !plan.end) return "";
  const length = lengthInWords(plan.termMonths);
  const dates = `${longDate(plan.start)} to ${longDate(plan.end)}`;
  return plan.cutShortBySeason
    ? `${length}, cut short by the season close — ${dates}`
    : `${length}, ${dates}`;
}

/**
 * THE MONTHS A BACKFILLED AGREEMENT REACHES BACK OVER, in words — "It
 * reaches back over February 2027 through June 2027, which nothing has
 * billed yet." A successor planned from a lapsed agreement's own end starts
 * in the past, and the one tap that writes it makes every month since
 * billable at the rent; the bills run keys on the row, and this row is new,
 * so none of them has been raised — including a month whose run already
 * happened on the 1st and found no tenancy on the lot. Named so the click
 * that made five months billable says so on screen. A statement, not an
 * instruction: whether to run those months is the owner's call. Null when
 * the plan starts today or later. Months in words (prettyMonth), never ISO.
 */
export function backfillWords(startISO: string, todayISO: string): string | null {
  if (!(startISO < todayISO)) return null;
  const first = startISO.slice(0, 7);
  const last = todayISO.slice(0, 7);
  const span = first === last ? prettyMonth(first) : `${prettyMonth(first)} through ${prettyMonth(last)}`;
  return `It reaches back over ${span}, which nothing has billed yet.`;
}

/**
 * What to say about a chain that has been going a while.
 *
 * Returns null for a short chain, because a first renewal needs no commentary.
 * Past a year of consecutive short agreements it says so plainly — not to
 * advise, but because the length of a chain is a fact the owner should be
 * looking at, and it is exactly what a court would look at too.
 */
export const LONG_CHAIN_MONTHS = 12;

export function chainNotice(totalMonths: number): string | null {
  if (totalMonths < LONG_CHAIN_MONTHS) return null;
  const years = Math.floor(totalMonths / 12);
  const rest = totalMonths % 12;
  const span = years >= 1
    ? `${years} year${years === 1 ? "" : "s"}${rest ? ` and ${rest} month${rest === 1 ? "" : "s"}` : ""}`
    : `${totalMonths} months`;
  return (
    `By the end of this one they'll have held the lot for ${span} on back-to-back ` +
    `agreements. Worth knowing — a long unbroken run can be treated differently ` +
    `from a short stay, whatever each agreement says. Ask your attorney how they ` +
    `want these handled.`
  );
}

// ------------------------------------------------ the successor's status ---

/**
 * THE STATUS A SUCCESSOR IS WRITTEN WITH — one rule for every door that
 * writes one. `approved` is an agreement that has not started; `active` is
 * one already running (park-helpers' tenancy convention). The owner's Renew
 * button hardcoded `approved` and the resident's texted tap hardcoded
 * `active`, so the same fact — a signed-for period that has not begun — was
 * filed under two statuses depending on which door wrote it. Every reader
 * takes the pair, so no screen was wrong; but a row that had already started
 * (a lapsed agreement backfilled from its own end) sat `approved`, and a tap
 * on the end day wrote a row starting today as if it had not.
 */
export function successorStatus(startISO: string, todayISO: string): "approved" | "active" {
  return startISO > todayISO ? "approved" : "active";
}

// ------------------------------------------------ a chain's later links ----

/** The columns a chain-link check reads off a `lot_reservations` row. */
export interface ChainLink {
  agreement_chain_id?: unknown;
  agreement_seq?: unknown;
}

/**
 * THE LATEST SEQUENCE NUMBER PER CHAIN, from every live row on the park's
 * lots — the map that decides which agreements ALREADY have a successor
 * written. The owner's "Agreements to write" list built this inline; the
 * nightly reminder built nothing, and so the night after a household
 * renewed it read the old row again and counted the household's own next
 * agreement as "lot taken". One predicate for every door that asks it:
 * renewalsDue (the card), remindExpiringStays (the nightly), and the Today
 * loader's `hasSuccessor` (today-actions.ts) — the third still builds the
 * map inline, and is to be repointed here.
 */
export function latestSeqByChain(rows: readonly ChainLink[]): Map<string, number> {
  const maxSeq = new Map<string, number>();
  for (const s of rows) {
    const cid = (s.agreement_chain_id as string | null) ?? null;
    if (!cid) continue;
    maxSeq.set(cid, Math.max(maxSeq.get(cid) ?? 0, (s.agreement_seq as number) ?? 1));
  }
  return maxSeq;
}

/** True when a later link of this row's chain is already written. */
export function hasLaterLink(row: ChainLink, maxSeq: Map<string, number>): boolean {
  const cid = (row.agreement_chain_id as string | null) ?? null;
  if (!cid) return false;
  return (maxSeq.get(cid) ?? 0) > ((row.agreement_seq as number) ?? 1);
}
