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
 *     signedOn for the park's term. Paid MONTHLY, whatever the holdover was
 *     filed as: the rent on this form is a monthly figure and the sentence
 *     he reads quotes a month, so a successor copying a yearly term would
 *     be a row the charge run refuses while the toast says it bills.
 *   - The rent's provenance is the owner's knowledge as of now, whether or
 *     not the number changed. It is on a lease he holds; the seller's roll
 *     is never the source of a figure on the park's own paper.
 *   - signedOn is THE DAY THE NEW LEASE RUNS FROM — the day on the paper,
 *     not the day it is recorded. Bounded [cutover_date, today]: a day still
 *     to come is not a fact yet, and one before go-live would bill a month
 *     that was never ours. The form defaults it to the holdover's own first
 *     day when that is on or after the cutover (an imported row's 1 January)
 *     and otherwise leaves it blank — never today, which is the day the
 *     office got round to it, and dating the agreement from it bills the
 *     first month short and runs every later link 4th-to-4th.
 *   - AND THE SUCCESSOR MUST STILL BE RUNNING. A 1 January lease under a
 *     one-month term recorded on 15 February would cancel the holdover and
 *     write a successor [1 Jan, 1 Feb) — already over — so from that moment
 *     nothing held the lot: the roll read it vacant, Today dropped the
 *     household, and every later run billed them nothing, rent AND the fee
 *     this door exists to bill. Refused, in the filing screen's words, with
 *     nothing trimmed or cancelled; the form leaves the box blank for the
 *     same day and says why. (Which link to write for a lease recorded a
 *     month late is the owner's call, not a default.)
 *   - Email AND mobile are a condition of the new lease, in the same words
 *     the filing screen uses.
 *   - The rent is the lease's own number. Defaulted on screen from the lot's
 *     rate card, else from what they paid before; never assumed here.
 */

import { successorRow, type PriorLink, type SuccessorRow } from "@/lib/successor-row";
import type { DateRange } from "@/lib/parks";
import { toE164 } from "@/lib/phone";
import {
  agreementMonthsFor, dayInWords, capitalise,
  agreementEndFrom, alreadyOverClause, agreementAlreadyOver, SIGNED_LEASE_LABEL,
} from "./park-helpers";
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
      /** What happens to the holdover row. */
      holdover:
        | { id: string; trimTo: { start: string; end: string } }  // `during` becomes [start, signedOn)
        | { id: string; cancel: true };                            // never had a day
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
  if (signedOn > ctx.todayISO) {
    return {
      ok: false,
      error: `The new lease runs from ${dayInWords(signedOn)} — that hasn't come yet. Record it from that day.`,
    };
  }
  if (ctx.cutoverDate && signedOn < ctx.cutoverDate) {
    return {
      ok: false,
      error: `The ledger starts on ${dayInWords(ctx.cutoverDate)} — the new agreement can't begin before that.`,
    };
  }
  if (signedOn >= prior.range.end) {
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
  const months = agreementMonthsFor(ctx.defaultAgreementMonths, ctx.maxAgreementMonths);
  const end = agreementEndFrom(signedOn, months);
  if (end <= ctx.todayISO) {
    return {
      ok: false,
      error: `${capitalise(alreadyOverClause(signedOn, months))} — check the day the lease runs from.`,
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
    start: signedOn,
    end,
    // Always active: a signing is only ever recorded on or after its day
    // (the bound above), so the agreement is already running when it lands.
    status: "active",
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

  const holdover = signedOn <= prior.range.start
    ? { id: prior.id, cancel: true as const }
    : { id: prior.id, trimTo: { start: prior.range.start, end: signedOn } };

  const signal = `On the new lease from ${dayInWords(signedOn)} — ${firstMonthBills(signedOn, rent, ctx.feePerMonth, prior.range.start)}.`;

  return { ok: true, holdover, successor, renter: { email, phone_on_file_with_park: phone }, signal };
}

const money = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
 * THE DAY THE FORM STARTS FROM — NEVER TODAY.
 *
 * The holdover's own first day, when the ledger already covers it: an
 * imported row runs from the cutover, and the lease everybody signs at a
 * takeover runs from that same day, so on the 4th the box already says the
 * 1st. A holdover filed by hand before go-live starts before the ledger does
 * and its first day is not a day a lease can run from; the box is left blank
 * and he types the day on the paper.
 *
 * Today is the day the office got round to it. Seeded as the agreement's
 * start it billed January three days of the seller's rent plus 28/31 of the
 * lease, and ran every later link 4th-to-4th.
 */
export function defaultSigningDay(
  holdoverStart: string | null,
  cutoverDate: string | null,
): string {
  if (!holdoverStart) return "";
  if (cutoverDate && holdoverStart < cutoverDate) return "";
  return holdoverStart;
}
