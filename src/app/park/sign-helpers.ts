/**
 * THEY SIGNED THE NEW LEASE — the transition nothing could record.
 *
 * Both ways to put an inherited household on the roll write `origin:
 * 'grandfathered'`: the importer always, and "Who lives here" whenever the
 * signed tick is clear — which is the true state on any day before go-live,
 * and the readiness list asks for the roll before go-live. Then, on 1 January,
 * everybody signs. Today said "18 households haven't signed the new lease"
 * and pointed at the rent roll, where no control could record a signature:
 * the Edit panel patched rent and due day, no `.update()` anywhere touched
 * origin, and the renewal list would not even offer these rows until
 * November. So the $142.53 fee — which the rule says "starts when they sign"
 * — billed $0 for all eighteen, every month, with the Fees screen still
 * reading "it starts for each of them when they sign a new agreement".
 *
 * The transition cannot be a flip of origin in place: the 0065 trigger fires
 * on UPDATE too, and refuses any non-grandfathered row longer than the park's
 * cap — which every holdover is, by design. So it is what the ledger already
 * knows how to read: END THE HOLDOVER on the signing day and INSERT A
 * SUCCESSOR from it, the same renter file, the same chain one link on.
 *
 * The rules, in one pure function so the door and its test see the same
 * arithmetic:
 *
 *   - Only a `grandfathered` holdover that still holds the lot may sign.
 *   - The holdover is TRIMMED to [start, signedOn) — no `ended`, no
 *     `moved_out_on`, because nobody moved out. If the signing day is on or
 *     before the holdover's first day it never had a day at all, and an empty
 *     range is refused by the database, so it is `cancelled` instead.
 *   - The successor is `successorRow(prior, ...)`: same renter, same chain,
 *     next seq, no deposit, origin 'office' — the park's own paper — from
 *     the day the row runs from (`from`, below) for THE LENGTH THE HOUSEHOLD CHOSE (the owner's decision:
 *     one, three or six months, from the lengths the park offers; the form
 *     starts on the park's house style). A length the park does not offer
 *     is refused in words that name the ones it does; the toast says the
 *     length back. Paid MONTHLY, whatever the holdover was
 *     filed as: the rent on this form is a monthly figure and the sentence
 *     he reads quotes a month, so a successor copying a yearly term would
 *     be a row the charge run refuses while the toast says it bills.
 *   - The rent's provenance is the owner's knowledge as of now, whether or
 *     not the number changed. It is on a lease he holds; the seller's roll
 *     is never the source of a figure on the park's own paper.
 *   - signedOn is THE DAY THE NEW LEASE RUNS FROM — the day on the paper,
 *     not the day it is recorded. Bounded by THE SAME RULE the filing
 *     screen applies (agreementStartFor): never before the cutover — one
 *     before go-live would bill a month that was never ours — and never
 *     more than SIGNED_START_HORIZON_DAYS ahead. A lease in his hand on
 *     20 December effective 1 January is a fact on 20 December; this door
 *     used to refuse it ("that hasn't come yet") while "Who lives here"
 *     filed the same paper the same afternoon, so Today kept nagging about
 *     a household that had signed, and the forced wait put the signing
 *     AFTER January's bills — the ordering behind a double January bill.
 *     A day still to come writes the successor `approved` (it holds the lot
 *     without claiming anyone is on it yet); one already running writes it
 *     `active`. The form defaults the box to the holdover's own first day
 *     when that is on or after the cutover (an imported row's 1 January)
 *     and otherwise leaves it blank — never today, which is the day the
 *     office got round to it, and dating the agreement from it bills the
 *     first month short and runs every later link 4th-to-4th.
 *   - THE DAY THE ROW RUNS FROM is not always the day on the paper. Three
 *     shapes, judged against the arrangement's END (decision 3, 16 Sep:
 *     "it's billed at the new rent, if there is any"):
 *       · a day INSIDE the arrangement's window — the holdover is trimmed
 *         (or cancelled) to it and the successor runs from it: the trim;
 *       · a day ON the arrangement's last morning — the consecutive case,
 *         not a gap: the holdover already ends there, nothing is trimmed,
 *         and the successor runs from that morning (`keep`);
 *       · an arrangement that has RUN OUT (its end is on or before today)
 *         — whatever later day the paper says, the successor is written
 *         from the arrangement's own end, the rule planRenewal applies, so
 *         the days since it ran out are on the lease's rent: not free, and
 *         not a fresh start from the next 1st. `keep` again. The day on
 *         the paper is stored nowhere (lot_reservations has no column for
 *         it); `during` is the billing period, and the sentence he reads
 *         says which day the row runs from;
 *       · a day AFTER an arrangement that has not yet ended is refused —
 *         there is nothing to carry on from across the gap.
 *     `from` is on the plan, and sign-actions keys every bill on it — never
 *     on the typed day.
 *   - AND THE SUCCESSOR MUST STILL BE RUNNING, judged from `from`. A
 *     1 January lease under a one-month term recorded on 15 February would
 *     cancel the holdover and write a successor [1 Jan, 1 Feb) — already
 *     over — so from that moment nothing held the lot: the roll read it
 *     vacant, Today dropped the household, and every later run billed them
 *     nothing, rent AND the fee this door exists to bill. Refused, in the
 *     filing screen's words, with nothing trimmed or cancelled; the form
 *     leaves the box blank for the same day and says why. For an
 *     arrangement that ran out the day is not his to change — the row runs
 *     from the end — so the refusal names the lengths that DO reach past
 *     today (ranOutRefusal), or says none does; never "check the day".
 *   - Email AND mobile are a condition of the new lease, in the same words
 *     the filing screen uses.
 *   - The rent is the lease's own number. Defaulted on screen from the lot's
 *     rate card, else from what they paid before; never assumed here.
 */

import { successorRow, type PriorLink, type SuccessorRow } from "@/lib/successor-row";
import type { DateRange } from "@/lib/parks";
import { toE164 } from "@/lib/phone";
import {
  dayInWords, capitalise, agreementStartFor,
  agreementEndFrom, alreadyOverClause, agreementAlreadyOver, SIGNED_LEASE_LABEL,
} from "./park-helpers";
import {
  chooseAgreementLength, offeredAgreementLengths, lengthAdjective, lengthInWords, lengthsInWords, successorStatus,
} from "./agreement-helpers";
import { contactProblem } from "./onboard-helpers";
import { prettyMonth } from "./ledger-helpers";

/**
 * THE ONE HOME IS park-helpers. The label and the already-over clause are
 * read by the roll, Today, the Fees screen and the filing screen's helpers;
 * the last of those is what this module imports contactProblem from, so the
 * words could not live here without a cycle. Re-exported so every reader of
 * this door keeps its import.
 */
export { agreementEndFrom, alreadyOverClause, agreementAlreadyOver, SIGNED_LEASE_LABEL };

export interface SigningInput {
  /**
   * The day the new agreement runs from — the day on the paper, not the day
   * it is recorded. A lease signed 20 December effective 1 January is
   * entered as 1 January.
   */
  signedOn: string;
  /** What the lease says, as typed. */
  rent: string;
  email: string;
  mobile: string;
  /**
   * HOW LONG THE LEASE RUNS, in months — the household's choice from the
   * lengths the park offers, seeded on the form with the park's house style.
   * Null only at a park with neither dial, where the successor runs the
   * rolling horizon. Judged by `chooseAgreementLength`, never defaulted here.
   */
  agreementMonths: number | null;
}

/** The holdover as it stands, plus what the successor copies from it. */
export interface Holdover extends PriorLink {
  range: DateRange | null;
  status: string;
  origin: string | null;
}

export interface SigningContext {
  todayISO: string;
  cutoverDate: string | null;
  defaultAgreementMonths: number | null;
  maxAgreementMonths: number | null;
  /** ISO timestamp, for amount_source_at when the rent changed. */
  nowISO: string;
  /**
   * The monthly fees a signed agreement on this lot is charged, already
   * filtered by the biller's own rule (feesForTenancy). What the first month
   * bills is rent plus these, and the sentence he reads has to be that number.
   */
  feePerMonth: number;
}

export type SigningPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /**
       * THE SUCCESSOR'S FIRST DAY — the typed day inside the arrangement's
       * window, else the arrangement's own end. sign-actions keys its bill
       * work on this, never on the typed day.
       */
      from: string;
      /** What happens to the holdover row. */
      holdover:
        | { id: string; trimTo: { start: string; end: string } }  // `during` becomes [start, from)
        | { id: string; cancel: true }                             // never had a day
        | { id: string; keep: true };                              // already ends where the successor starts
      successor: SuccessorRow;
      /** The renter-file patch — both are a condition of the lease. */
      renter: { email: string; phone_on_file_with_park: string };
      /** The first month the new agreement bills, in words, with its rent. */
      signal: string;
    };

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function planSigning(
  input: SigningInput,
  prior: Holdover,
  ctx: SigningContext,
): SigningPlan {
  if (prior.origin !== "grandfathered") {
    return { ok: false, error: "They're already on an agreement with you — there's nothing to sign onto." };
  }
  if (prior.status !== "approved" && prior.status !== "active") {
    return { ok: false, error: "That tenancy is already closed." };
  }
  if (!prior.range) {
    return {
      ok: false,
      error: "That tenancy has no dates on it, so the new agreement can't be dated from it. That's ours to fix — get in touch and we'll sort it.",
    };
  }

  const signedOn = input.signedOn.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) {
    return { ok: false, error: "Pick the day the new lease runs from." };
  }
  // ONE WINDOW FOR BOTH DOORS. The filing screen's rule, in its words: not
  // before the ledger starts, not more than two months out. Either side of
  // today is a day a lease can run from.
  const at = agreementStartFor(signedOn, ctx.todayISO, ctx.cutoverDate);
  if (!at.ok) return { ok: false, error: at.error };

  // WHERE THE ROW RUNS FROM, and what becomes of the holdover — the three
  // shapes the header describes. `from`, not the typed day, is what every
  // later judgement and every bill keys on.
  const lapsed = prior.range.end <= ctx.todayISO;
  let from: string;
  let holdover: Extract<SigningPlan, { ok: true }>["holdover"];
  if (signedOn < prior.range.end) {
    // THE TRIM: the lease runs from a day the arrangement still covered. If
    // the signing day is on or before the holdover's first day it never had
    // a day at all, and an empty range is refused by the database.
    from = signedOn;
    holdover = signedOn <= prior.range.start
      ? { id: prior.id, cancel: true as const }
      : { id: prior.id, trimTo: { start: prior.range.start, end: signedOn } };
  } else if (signedOn === prior.range.end || lapsed) {
    // CONSECUTIVE, OR AN ARRANGEMENT THAT RAN OUT (decision 3, 16 Sep: "it's
    // billed at the new rent, if there is any"). The successor is written
    // from the arrangement's own END — the same rule planRenewal applies —
    // so the days since it ran out are on the lease's rent, not free and not
    // a fresh start from the next 1st. Nothing is trimmed: the row already
    // ends there. The day on the paper is not stored anywhere
    // (lot_reservations has no column for it) — `during` is the billing
    // period, and the sentence says which day it runs from.
    from = prior.range.end;
    holdover = { id: prior.id, keep: true as const };
  } else {
    return {
      ok: false,
      error: `Their current arrangement ends on ${dayInWords(prior.range.end)} — that's after it, so there's nothing to carry on from.`,
    };
  }
  // THE DATE IS JUDGED WHOLE BEFORE THE CONTACTS. The successor has to be
  // running when it lands, or the lot holds nothing from this moment — the
  // sibling door (buildTenant) refuses the same shape with the same clause.
  // Said here, with the other date refusals, and not after the email check:
  // a form whose date is over and whose email is blank used to get 'No email
  // yet.' first and learn the date could not be recorded only on the next tap.
  // THE LENGTH THEY CHOSE, from the lengths this park offers — never the cap,
  // never the house style unless that is what was picked. A choice the park
  // does not offer is refused before the date is judged against it.
  const pick = chooseAgreementLength(input.agreementMonths, ctx.defaultAgreementMonths, ctx.maxAgreementMonths);
  if (!pick.ok) return { ok: false, error: pick.error };
  const months = pick.months;
  const end = agreementEndFrom(from, months);
  if (end <= ctx.todayISO) {
    // An arrangement that ran out runs the row from its own end whatever
    // the paper says, so "check the day" would name a box that cannot help;
    // the refusal names the lengths that reach past today instead.
    if ("keep" in holdover) {
      const offered = offeredAgreementLengths(ctx.defaultAgreementMonths, ctx.maxAgreementMonths);
      return { ok: false, error: ranOutRefusal(from, months, offered, ctx.todayISO) };
    }
    return {
      ok: false,
      error: `${capitalise(alreadyOverClause(from, months))} — check the day the lease runs from.`,
    };
  }

  const rawRent = input.rent.trim();
  if (!rawRent) return { ok: false, error: "What rent did they sign for?" };
  const n = Number(rawRent.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "That rent isn't a dollar amount." };
  if (n > 100_000) return { ok: false, error: "That rent looks like a typo." };
  const rent = Math.round(n * 100) / 100;

  const contact = contactProblem(input.email, input.mobile);
  if (contact) return { ok: false, error: contact };
  const email = input.email.trim().toLowerCase();
  const phone = toE164(input.mobile);
  if (!phone) return { ok: false, error: "That phone number doesn't look right." };

  const successor = successorRow(prior, {
    start: from,
    end,
    // A lease that has not started yet holds the lot as `approved`; one
    // already running is `active` — the one rule every door writes
    // (successorStatus), and the run bills whichever covers the month.
    status: successorStatus(from, ctx.todayISO),
    quotedAmount: rent,
    origin: "office",
    continuesChain: true,
    nextSeq: (prior.agreement_seq ?? 1) + 1,
    nowISO: ctx.nowISO,
  });
  // THE RENT ON A SIGNED LEASE IS NEVER THE SELLER'S ROLL. successorRow copies
  // amount_source when the number is unchanged — right for a renewal, wrong
  // here: a holdover at $275 signing for $275 would carry 'prior_roll' onto
  // the park's own paper. The figure is on a lease the owner holds, as of now.
  successor.amount_source = "owner_knowledge";
  successor.amount_source_at = ctx.nowISO;
  // PAID MONTHLY. The rent typed here is a monthly figure and the sentence
  // below quotes a month; a successor copying a yearly holdover's term would
  // be refused by the charge run ('filed as paid yearly') while the toast
  // said January bills $542.53.
  successor.term = "monthly";

  // THE SENTENCE NAMES THE DAY THE ROW RUNS FROM. When that is the day on
  // the paper it is the sentence it always was; when the arrangement's end
  // set it, it says so — a lease dated the 15th recorded from the 1st would
  // otherwise read as running from the 15th, and January's bill would
  // surprise him. firstMonthBills with the holdover's first day before
  // `from` already says both halves for a mid-month end.
  const bills = firstMonthBills(from, rent, ctx.feePerMonth, prior.range.start);
  const signal = from === signedOn
    ? `On the ${newLeaseWords(months)} from ${dayInWords(from)} — ${bills}.`
    : `Their arrangement ${lapsed ? "ran out" : "ends"} on ${dayInWords(from)}, so the ${newLeaseWords(months)} is recorded from that day — ${bills}.`;

  return { ok: true, from, holdover, successor, renter: { email, phone_on_file_with_park: phone }, signal };
}

/**
 * WHY A LEASE ON AN ARRANGEMENT THAT RAN OUT IS REFUSED at the length
 * picked — the row runs from the arrangement's end whatever the paper says,
 * so the day is not his to change and "check the day the lease runs from"
 * would name a box that cannot help. Names the lengths the park offers that
 * DO reach past today from that end ("pick 3 or 6 months"), or says none
 * does — the renew door's own shape for the same fact. Read by the planner
 * and, before the tap, by the form.
 */
export function ranOutRefusal(
  endISO: string,
  months: number | null,
  offered: readonly number[],
  todayISO: string,
): string {
  return `Their arrangement ran out on ${dayInWords(endISO)}, and ${ranOutOverClause(endISO, months, offered, todayISO)}`;
}

/**
 * "from that day 1 month would be over already — pick 3 months." — the
 * clause both ranOutRefusal and the form's lead line end with. No leading
 * capital; each caller opens its own sentence.
 */
function ranOutOverClause(
  endISO: string,
  months: number | null,
  offered: readonly number[],
  todayISO: string,
): string {
  if (months == null) return "an agreement from that day would already be over by now — there's nothing to record from here.";
  const reach = offered.filter((m) => !agreementAlreadyOver(endISO, m, todayISO));
  return reach.length > 0
    ? `from that day ${lengthInWords(months)} would be over already — pick ${lengthsInWords(reach)}.`
    : "even the longest agreement this park writes, run from that day, would be over already — there's nothing to record from here.";
}

const money = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "new one-month lease", "new 3-month lease", or "new lease" at a park with
 * neither dial — the words both the form (before the write) and the toast
 * (after it) open with, so the length he is told he is filing is the length
 * he is told he filed.
 */
export function newLeaseWords(months: number | null): string {
  return months == null ? "new lease" : `new ${lengthAdjective(months)} lease`;
}

/**
 * WHAT THE RENT BOX STARTS FROM — a MONTHLY figure or nothing. The lot's rate
 * card first (the number the lease was written from); else what they paid
 * before, but only when that was filed monthly. The successor is written
 * monthly whatever the holdover was, and the sentence under the box quotes a
 * month, so a yearly holdover's $3,300 seeded here read 'January 2027 bills
 * $3,442.53'. The Edit panel empties the box on a term change for the same
 * reason. Never divides by twelve: the lease's own number is the one.
 */
export function signingRentSeed(
  rateCard: number | null,
  holdoverTerm: string | null,
  holdoverAmount: number | null,
): number | null {
  if (rateCard != null) return rateCard;
  return holdoverTerm === "monthly" ? holdoverAmount : null;
}

/**
 * WHAT THE FIRST MONTH BILLS, in words, with the real figure.
 *
 * The one sentence both the form (before the write) and the toast (after it)
 * read, so what he is told he is about to file is what he is told he filed.
 * A lease from the 1st bills the month whole. One from mid-month bills from
 * that day and the whole figure from the next — and when the arrangement
 * they had was already running (a holdover filed from an earlier day, kept
 * `active` and trimmed to end on the signing day) the same month bills BOTH
 * halves: the old arrangement to the day before, then the lease from ITS
 * day, named — 'then the new lease from that day' sat right after the old
 * arrangement's last day and read as the lease running from the 14th. Said
 * so, or the sentence reads as if the month starts billing on the 15th. No
 * trailing full stop — the caller ends the sentence. The form calls it only
 * once the rent box holds a number: a figure built from an empty box is not
 * one to quote.
 */
export function firstMonthBills(
  signedOn: string,
  rent: number,
  feePerMonth: number,
  /** The holdover's first day; it keeps days in the month when before signedOn. */
  holdoverFrom: string | null = null,
): string {
  const month = signedOn.slice(0, 7);
  const whole = signedOn.endsWith("-01");
  const monthly = Math.round((rent + feePerMonth) * 100) / 100;
  const parts = feePerMonth > 0 ? ` (${money(rent)} rent + ${money(feePerMonth)} fees)` : "";
  if (whole) return `${prettyMonth(month)} bills ${money(monthly)}${parts}`;
  if (holdoverFrom != null && holdoverFrom < signedOn) {
    return (
      `${prettyMonth(month)} bills the arrangement they had to ${dayInWords(addDays(signedOn, -1))}, ` +
      `then the new lease from ${dayInWords(signedOn)} — ${money(monthly)} a month after that${parts}`
    );
  }
  return `${prettyMonth(month)} bills from that day, then ${money(monthly)} a month${parts}`;
}

/**
 * THE DAY BOX, FOR THE LENGTH PICKED — the one rule the form's seed and its
 * length select both apply, so "already over" is judged at the household's
 * CHOICE and not at the house style once at mount.
 *
 * The Haven on 15 February 2027: an imported 1 January holdover. At one month
 * an agreement from 1 January is over; at three it is not, and planSigning
 * accepts 1 January at three months. Judged at `seed.termMonths` the box
 * stayed blank after he picked '3 months', under a sentence saying the one
 * day the server would take could not be recorded.
 *
 *   - the seeded day is over at `months` → a box still holding the seeded
 *     day empties; a day HE typed is left alone;
 *   - the seeded day is open at `months` → a blank box fills with it; a day
 *     he typed is left alone.
 *
 * Called with `signedOn = seededDay` for the initial state, and with the
 * box's current value on every length change. Never returns today: `todayISO`
 * is only the judge of 'over' (agreementAlreadyOver — the same function
 * planSigning refuses on).
 */
export function signingDayForLength(
  seededDay: string,
  signedOn: string,
  months: number | null,
  todayISO: string,
): string {
  if (!seededDay) return signedOn;
  if (agreementAlreadyOver(seededDay, months, todayISO)) {
    return signedOn === seededDay ? "" : signedOn;
  }
  return signedOn === "" ? seededDay : signedOn;
}

/**
 * WHY THE DAY BOX IS BLANK, at the length picked — and what to do about it,
 * only when the screen can honour it. "pick a longer length" is said when
 * some longer offered length keeps the seeded day open (1 January at three
 * months on 15 February); when none does, the sentence says why and stops —
 * sending him to "type the day the lease runs from" would name the one day
 * this form refuses. Which link to write for a lease recorded a month late
 * is the owner's call, not this copy's. No leading capital, no full stop:
 * the form opens with "The day is left blank:" and ends the sentence.
 */
export function blankDayWords(
  seededDay: string,
  months: number | null,
  offered: readonly number[],
  todayISO: string,
): string {
  const longerKeepsItOpen = offered.some(
    (m) => months != null && m > months && !agreementAlreadyOver(seededDay, m, todayISO),
  );
  const at = months == null ? "" : `at ${months === 1 ? "one month" : lengthInWords(months)} `;
  const began = `their arrangement began ${dayInWords(seededDay)}, and ${at}that agreement would already be over`;
  return longerKeepsItOpen
    ? `${began} — pick a longer length or type the day the lease runs from`
    : `${began}, so it can't be recorded from that day here`;
}

/**
 * THE DAY THE FORM STARTS FROM — NEVER TODAY.
 *
 * The holdover's own first day, when the ledger already covers it: an
 * imported row runs from the cutover, and the lease everybody signs at a
 * takeover runs from that same day, so on the 4th the box already says the
 * 1st. A holdover filed by hand before go-live starts before the ledger does
 * and its first day is not a day a lease can run from; the box is left blank
 * and he types the day on the paper.
 *
 * A HOLDOVER THAT RAN OUT seeds its own END: that is the day the successor
 * is written from whatever the paper says (planSigning's `keep` branch), so
 * the box shows the day the row will carry. A day inside the old window is
 * still his to type — that is the trim — and a later one writes the same
 * row from the end. `todayISO` reaches this only as the judge of "ran out";
 * it is never the seed.
 *
 * Today is the day the office got round to it. Seeded as the agreement's
 * start it billed January three days of the seller's rent plus 28/31 of the
 * lease, and ran every later link 4th-to-4th.
 */
export function defaultSigningDay(
  holdoverStart: string | null,
  cutoverDate: string | null,
  holdoverEnd: string | null,
  todayISO: string,
): string {
  if (holdoverEnd != null && holdoverEnd <= todayISO) return holdoverEnd;
  if (!holdoverStart) return "";
  if (cutoverDate && holdoverStart < cutoverDate) return "";
  return holdoverStart;
}

/**
 * THE DAY BOX'S VALUE, for the form's first render and every length change
 * — signingDayForLength's rule, EXCEPT for a holdover that ran out. There
 * the seed is the arrangement's end, the one day the row will run from
 * whatever is typed, and the box must not empty when the picked length is
 * over from it (the server refuses that pick in words that name a longer
 * one — ranOutRefusal — and an empty box under "Pick the day the new lease
 * runs from" names a control that cannot help). A blank box fills with the
 * seed; a day he typed is left alone.
 */
export function signingSeedFor(
  seededDay: string,
  signedOn: string,
  months: number | null,
  todayISO: string,
  ranOut: boolean,
): string {
  if (ranOut) return signedOn === "" ? seededDay : signedOn;
  return signingDayForLength(seededDay, signedOn, months, todayISO);
}

/**
 * THE FORM'S LEAD LINE FOR A HOLDOVER THAT RAN OUT — what the row will
 * carry, before the tap: "Their arrangement ran out on January 1, 2028 —
 * the new lease is recorded from that day when the paper's day is later,
 * and January 2028 bills from it at the lease's rent." When the length
 * picked is over from that day, the same words the server would refuse
 * with follow (ranOutRefusal's tail), so he learns it before the tap. No
 * trailing space: the form adds the rent and contact sentences after it.
 */
export function ranOutLeadWords(
  endISO: string,
  months: number | null,
  offered: readonly number[],
  todayISO: string,
): string {
  const lead =
    `Their arrangement ran out on ${dayInWords(endISO)} — the new lease is recorded from that day when the ` +
    `paper's day is later, and ${prettyMonth(endISO.slice(0, 7))} bills from it at the lease's rent.`;
  if (!agreementAlreadyOver(endISO, months, todayISO)) return lead;
  return `${lead} ${capitalise(ranOutOverClause(endISO, months, offered, todayISO))}`;
}
