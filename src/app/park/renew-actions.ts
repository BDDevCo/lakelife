"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange, effectiveSeason } from "@/lib/parks";
import {
  planRenewal, renewalRefusalText, chainNotice, monthsBetween,
  offeredAgreementLengths, agreementMonthsFor, lengthNotOfferedText, agreementSpanWords,
  renewalLeadDays, RENEWAL_LEAD_CAP_DAYS, agreementSeasonEnd, successorStatus,
  latestSeqByChain, hasLaterLink, perTermWords, backfillWords, lostMonths, lengthInWords, lengthsInWords,
  type PlannedRenewal, type AgreementTerms,
} from "./agreement-helpers";
import { rentForPeriod, addDays } from "./rerate-helpers";
import { money, currentPeriod } from "./ledger-helpers";
import { parkRanMonth, billLostMonths, lostMonthsWords } from "./gap-bills";
import { longDate } from "@/lib/lake-time";
import { servedRentHistory } from "@/lib/rent-changes";
import { successorRow, type PriorLink } from "@/lib/successor-row";
import type { ParkResult } from "./actions";
import { mustRead, ReadFailed, readFailedMessage } from "@/lib/must-read";

/**
 * WRITING THE NEXT AGREEMENT — from the owner's side.
 *
 * This is the recurring workload at a park that caps agreement length:
 * nineteen households, each renewing as often as the length they chose runs
 * out — a household on one-month agreements twelve times a year, one on six
 * months twice — and until now there was NO WAY TO DO ONE from the owner's screens.
 * `planRenewal` had no caller at all, and the only path that existed was the
 * renter's own `/x/{token}` link — which needs a token minted by an SMS
 * reminder, and SMS is switched off (see reminder-actions.ts: approved by the
 * carriers, but nothing delivered and no consent writer).
 *
 * So the Today screen said "write the next one, or their rent stops being
 * billed" and pointed at a screen that could not write it.
 *
 * WHY THE STAKES ARE HIGHER THAN A MISSING BUTTON: when a tenancy lapses,
 * `buildStatement` returns zero days, the charge run drops the row, and the
 * rent simply stops being billed. No error, no empty state, no warning. The
 * household stays on the lot and the money quietly stops.
 *
 * The renewal itself is INSERTED, never edited in place. Last term's dates and
 * its rent are what the ledger already billed against, and rewriting them would
 * silently restate history.
 *
 * THE LENGTH IS THE HOUSEHOLD'S CHOICE, NEVER THE CAP. The owner's decision:
 * one, three or six months, chosen at every renewal. The planner works every
 * length the park offers (`offeredAgreementLengths`) so the card can show the
 * dates of whichever is picked, the button writes the one picked, and a length
 * the park does not offer is refused in words that name the ones it does. This
 * door used to write the cap: every "Renew at the same rent" turned a one-month
 * lease into a three-month one, and would have made it six the day the cap
 * was raised — silently, on the owner's most-used button.
 *
 * THE ROW IS BUILT BY `successorRow`, shared with the resident's own extend
 * link, so the two doors cannot disagree about what travels: the household's
 * due day, their move-in date, whether the rent was confirmed with them. And
 * THE RENT IS THE ONE IN FORCE ON THE SUCCESSOR'S FIRST MORNING, resolved from
 * the same served history the bills use — because a rent increase is pinned to
 * one link of a chain, and copying `quoted_amount` off that link before the
 * increase had been applied wrote the successor at the old number. The
 * increase then evaporated after one month, with nothing on any screen saying
 * so.
 *
 * THE DOOR BILLS THE MONTHS IT MADE BILLABLE (decision 3, 16 Sep). A
 * successor written from a lapsed agreement's own end starts in the past;
 * the run keys 'already billed' per reservation and visits a month once, so
 * nothing would ever raise those months again. reraiseMonth — the same
 * re-raise the signing door uses — raises each lost month on the new row,
 * oldest first, settled from money on account, and the toast names each
 * (gap-bills.ts). The current month is left to the run unless the run has
 * already happened.
 */

const DENIED = "You don't manage that park.";

export interface RenewalPreview {
  reservationId: string;
  lotNumber: string;
  renterName: string | null;
  priorStart: string;
  priorEnd: string;
  /**
   * The rent the successor WILL BE WRITTEN AT — the number in force on its
   * first morning, once every served increase has been applied. This is what
   * the button writes, so it is what the card shows.
   */
  quotedAmount: number | null;
  /** What the prior row carries today. Differs from `quotedAmount` only when
   *  a served increase lands between now and the successor's start. */
  priorQuotedAmount: number | null;
  /** The effective date of that increase, when there is one. */
  rentChangeOn: string | null;
  /**
   * TRUE when the prior agreement's end is already behind today — it lapsed,
   * and nothing has been billed to the household since. The card says
   * "lapsed February 1, 2027" for these rather than "ends", which is the
   * future tense for a past event, and leads with them.
   */
  lapsed: boolean;
  /**
   * THE CARD'S HEADLINE PLAN: the park's house style — the length the choice
   * starts on — when that length can be written; otherwise the shortest
   * length that can. Most refusals (inherited, no cap, season closed) are
   * true of every length, and then this carries the refusal and the card
   * shows a sentence instead of buttons. `already_ended` is the exception:
   * it is judged on the PLAN's own end, so on 17 June one month from a
   * 1 February lapse is over before it is written while six months reaches
   * August — the card offers only the lengths that reach past today, and
   * carries the refusal only when none does.
   */
  plan: PlannedRenewal;
  refusalText: string | null;
  /** Said out loud past a year of consecutive short agreements — at the house style. */
  chainNote: string | null;
  /**
   * EVERY LENGTH THE PARK OFFERS, each planned in full, ascending — so the
   * card shows the real dates of whichever the household picks (season clamp
   * included) and the button writes exactly what the card said. Empty when
   * the plan refuses.
   */
  lengths: { months: number; plan: PlannedRenewal; chainNote: string | null }[];
  /** The length the choice starts on: the park's house style under its cap. */
  defaultMonths: number | null;
  /**
   * THE MONTHS THE TAP WILL BILL — every month from the plan's start that
   * the run has already passed (agreement-helpers lostMonths: months behind
   * today, and the current month once its run has happened, floored at the
   * ledger's start). The same for every length on the row: they share the
   * start. Empty when the plan refuses, or when the current month is still
   * the run's to bill.
   */
  lostMonths: string[];
  /**
   * THE MONEY FACT OF A BACKFILL — "Writing it bills this agreement for
   * February 2027 and March 2027 — nothing has billed it for those months
   * yet." (backfillWords). The tap bills them (decision 3): the card prints
   * it under the dates before the tap, and the toast says what landed after
   * it (lostMonthsWords). Null when nothing is missed and the plan starts
   * today or later. "If there is any": with no rent set, or a row filed as
   * paid some other way than monthly, the tap cannot bill them, and the
   * note says so instead — with the door that sets a rent, or the run's own
   * not-monthly sentence — rather than promising months.
   */
  backfillNote: string | null;
}

async function loadTerms(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  lotId: string,
  startISO: string,
): Promise<{ terms: AgreementTerms; cutoverDate: string | null }> {
  const [parkRes, lotRes] = await Promise.all([
    admin.from("parks")
      // THE HOUSE STYLE TOO. This selected only the cap, and the cap was then
      // used as the length — so the default the owner set (one month) was
      // read by no door at renewal time. AND THE CUTOVER: the months a
      // backfill bills are floored at the ledger's start (lostMonths), and a
      // cutover read as null would bill the seller's months.
      .select("max_agreement_months, default_agreement_months, deposit_amount, cutover_date, season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", parkId).maybeSingle(),
    admin.from("park_lots")
      .select("season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", lotId).maybeSingle(),
  ]);

  // A FAILED READ IS NOT AN ABSENT SETTING, and here that distinction writes
  // itself into an agreement. A null park makes `maxAgreementMonths` null,
  // which planRenewal reads as "this park doesn't write fixed-length
  // agreements" and refuses — telling the owner a fact about his own park that
  // we did not have. A null LOT is worse, because it does not refuse: the lot's
  // own earlier season close silently disappears, effectiveSeason falls back to
  // the park's, and the agreement is written running past the morning the slip
  // comes out of the water. The clamp exists precisely to stop that, and a
  // dropped read must not be able to lift it.
  const park = mustRead("your park's agreement terms", parkRes);
  const lot = mustRead("that lot's season", lotRes);

  // A lot may close before its park does — a slip comes out of the water while
  // the pads stay open. effectiveSeason takes the LOT's season only when all
  // four of its dates are set, which is the all-or-nothing rule 0063 enforces.
  const season = effectiveSeason(
    {
      openMonth: (lot?.season_open_month as number) ?? null,
      openDay: (lot?.season_open_day as number) ?? null,
      closeMonth: (lot?.season_close_month as number) ?? null,
      closeDay: (lot?.season_close_day as number) ?? null,
    },
    {
      openMonth: (park?.season_open_month as number) ?? null,
      openDay: (park?.season_open_day as number) ?? null,
      closeMonth: (park?.season_close_month as number) ?? null,
      closeDay: (park?.season_close_day as number) ?? null,
    },
  );

  // ONE HOME for the morning the season sets — the resident's texted link
  // reads the same function, so the two doors clamp one choice to one row.
  // This was typed inline here as the close DAY in the start's year: one
  // night short of what the booking gate sells, and wrong by a year for a
  // window that wraps the New Year.
  return {
    terms: {
      maxAgreementMonths: (park?.max_agreement_months as number) ?? null,
      defaultAgreementMonths: (park?.default_agreement_months as number) ?? null,
      depositAmount: park?.deposit_amount == null ? null : Number(park.deposit_amount),
      seasonEnd: agreementSeasonEnd(startISO, season),
    },
    cutoverDate: (park?.cutover_date as string | null) ?? null,
  };
}

type PreviewResult = { ok: boolean; error?: string; preview?: RenewalPreview };

/** The preview plus the prior row it was planned from — the row the successor
 *  is built FROM. Internal: the exported action hands back only the preview. */
type Planned = PreviewResult & { prior?: PriorLink };

/**
 * What the next agreement WOULD be. Nothing is written.
 *
 * THROWS `ReadFailed` rather than reporting a missing tenancy. Two callers want
 * two different things from that: the exported action below turns it into a
 * sentence for the button that is awaiting one, and `renewalsDue` lets it go up
 * to the page boundary, because a household quietly dropped out of the "write
 * the next one" list is the failure this whole file exists to prevent.
 *
 * `ranCurrent` — whether this month's run has already happened — is read
 * here once per call (parkRanMonth) unless the caller already knows it:
 * renewalsDue reads it ONCE and passes it to every row. A failed read
 * throws too: the sentence "bills when you bill the month" about a month
 * that already ran would leave that month to nobody.
 */
async function planNextAgreement(
  parkId: string,
  reservationId: string,
  startFrom?: string,
  ranCurrent?: boolean,
): Promise<Planned> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  // "That tenancy isn't here." and "You don't manage that park." are both
  // statements of fact, and a dropped read has no facts to state. The first
  // sends the owner hunting for a row sitting in front of him; the second tells
  // him something false about his own access.
  //
  // ONE READ of the prior row, and it carries everything the successor copies
  // — the household's due day, move-in date and rent confirmation travel with
  // them, so they are read here rather than dropped on the floor by a second,
  // narrower select at write time.
  const res = mustRead("that tenancy", await admin
    .from("lot_reservations")
    // ONE string literal — supabase-js types a concatenated select as an error.
    .select("id, park_lot_id, renter_id, renter_unit_id, during, quoted_amount, term, agreement_chain_id, agreement_seq, status, origin, due_day, tenancy_began_on, amount_source, amount_source_at")
    .eq("id", reservationId)
    .maybeSingle());
  if (!res) return { ok: false, error: "That tenancy isn't here." };

  const lot = mustRead("that lot", await admin
    .from("park_lots").select("id, lot_number, park_id")
    .eq("id", res.park_lot_id as string).maybeSingle());
  if (!lot || lot.park_id !== parkId) return { ok: false, error: DENIED };

  const range = parseDaterange(res.during as string);
  if (!range) return { ok: false, error: "That tenancy has no dates to renew from." };

  const today = todayLakeDate();
  const { terms, cutoverDate } = await loadTerms(admin, parkId, lot.id as string, startFrom ?? range.end);
  let ran = ranCurrent;
  if (ran === undefined) {
    const r = await parkRanMonth(admin, parkId, currentPeriod(today));
    if (typeof r !== "boolean") {
      console.error(`[read failed] ${r.what}:`, r.error);
      throw new ReadFailed(r.what, String((r.error as { message?: string })?.message ?? ""));
    }
    ran = r;
  }
  const chainId = (res.agreement_chain_id as string) ?? (res.id as string);
  const seq = (res.agreement_seq as number) ?? 1;
  const priorQuoted = res.quoted_amount == null ? null : Number(res.quoted_amount);

  // THE CHAIN'S REAL LENGTH, for the long-run sentence. Every earlier live link
  // by its own dates, plus this one — not the sequence number times the cap,
  // which at a park whose first lease is one month and whose renewals are three
  // said "six months" after four. A failed read here would make the chain look
  // short and keep the sentence quiet, so it stops instead.
  //
  // THE ENDED LINKS COME TOO, for one question: was a LATER link of this
  // chain closed out? A move-out inside a successor marks only that link
  // `ended` and leaves this one held, run out, with nothing held after it —
  // the lapsed shape, read from held rows alone. This is a public endpoint
  // (previewRenewal, renewAgreement), so hiding the card is not the guard:
  // the planner itself refuses, below.
  const links = mustRead("that household's earlier agreements", await admin
    .from("lot_reservations")
    .select("id, during, agreement_seq, status")
    .eq("agreement_chain_id", chainId)
    .in("status", ["approved", "active", "ended"]));
  const closedOutLater = (links ?? []).some(
    (l) => l.status === "ended" && ((l.agreement_seq as number) ?? 1) > seq,
  );
  const chainMonthsSoFar = (links ?? [])
    .filter((l) => l.status !== "ended")
    .filter((l) => l.id !== res.id && ((l.agreement_seq as number) ?? 1) < seq)
    .reduce((sum, l) => {
      const r = parseDaterange(l.during as string);
      return r ? sum + monthsBetween(r.start, r.end) : sum;
    }, monthsBetween(range.start, range.end));

  // EVERY LENGTH THE PARK OFFERS, PLANNED. The household picks one at the
  // card; the button writes the plan for that one. The house style is the
  // plan the card starts on and the one whose refusal speaks for all.
  const prior = {
    id: res.id as string,
    chainId,
    seq,
    start: range.start,
    end: range.end,
    quotedAmount: priorQuoted,
    term: (res.term as string) ?? "monthly",
    chainMonthsSoFar,
  };
  const offered = offeredAgreementLengths(terms.defaultAgreementMonths ?? null, terms.maxAgreementMonths);
  const defaultMonths = agreementMonthsFor(terms.defaultAgreementMonths ?? null, terms.maxAgreementMonths);
  let lengths = offered.map((months) => {
    const p = planRenewal(prior, terms, today, months, startFrom);
    return { months, plan: p, chainNote: p.totalMonthsAfter ? chainNotice(p.totalMonthsAfter) : null };
  });
  // No cap: nothing is offered and the planner says so with `no_cap`; a
  // length has to be passed to hear it, and any number is refused the same.
  //
  // THE HOUSE STYLE FIRST, THEN THE SHORTEST LENGTH THAT CAN BE WRITTEN. A
  // lapsed agreement is planned consecutively from its own end, and the plan
  // for a short length may be over before today (already_ended) while a
  // longer one reaches past it — so a refused house style does not speak for
  // every length. Every other refusal is true of all of them, and falls
  // through unchanged.
  const house = lengths.find((l) => l.months === defaultMonths)?.plan ?? lengths[0]?.plan;
  let plan = house?.ok
    ? house
    : lengths.find((l) => l.plan.ok)?.plan
      ?? house
      ?? planRenewal(prior, terms, today, defaultMonths ?? 1, startFrom);

  // A HOUSEHOLD STILL ON THE SELLER'S ARRANGEMENT is not renewed from here.
  // Their new lease is a different act — it ends the holdover and starts the
  // fee — and it is recorded from their row on the rent roll. Writing a
  // successor here would either copy 'grandfathered' onto a lease they had
  // just signed (the fee never bills) or assert 'office' on one they had not
  // (a fee they never agreed to). So the card says where the control is.
  // Whatever else the planner said — "already ended, start a new one" would
  // send him to a door that files a second renter for the same household.
  if (res.origin === "grandfathered") {
    plan = { ok: false, refusal: "inherited" };
  }
  // THE HOUSEHOLD MOVED OUT — closed out of a later link of this chain. The
  // final fact, whatever else the planner said: a successor written from
  // this row's end would land over the family who left, and the door would
  // then bill them for every month since (billLostMonths).
  if (closedOutLater) {
    plan = { ok: false, refusal: "moved_out" };
  }
  // A refusal is true of every length; the card offers nothing to pick.
  if (!plan.ok) lengths = [];

  // THE RENT IN FORCE ON THE SUCCESSOR'S FIRST MORNING — from the same served
  // history the bills read, so a $425 increase served for 1 April is what a
  // May–August agreement written on 17 March carries, not the $400 still
  // sitting on the February row. A failed read of that history would quietly
  // write the old number, so it stops.
  const hist = await servedRentHistory([res.id as string]);
  if (hist.error) {
    console.error("[read failed] the rent history for that tenancy:", hist.error);
    throw new ReadFailed("the rent history for that tenancy", String((hist.error as { message?: string })?.message ?? ""));
  }
  const changes = hist.byRes.get(res.id as string) ?? [];
  const successorStart = plan.ok && plan.start ? plan.start : (startFrom ?? range.end);
  const quotedAmount = rentForPeriod(changes, successorStart, priorQuoted);
  const inForce = [...changes]
    .filter((c) => c.effective_on <= successorStart)
    .sort((a, b) => a.effective_on.localeCompare(b.effective_on))
    .at(-1);

  const renter = res.renter_id
    ? mustRead("the name on that tenancy", await admin
        .from("park_renters").select("display_name")
        .eq("id", res.renter_id as string).maybeSingle())
    : null;

  const lotNumber = (lot.lot_number as string) ?? "?";
  // THE MONTHS THE TAP WILL BILL, and the sentence that says so — from the
  // plan's own start, today, the ledger's floor and whether this month ran.
  // The sentence is judged on the row too: the rent the successor is written
  // at and the term it copies, because the tap cannot bill a row with no
  // rent or one filed as paid some other way than monthly, and the card must
  // not promise months it cannot bill (backfillWords says which, and where
  // the door is).
  const lost = plan.ok && plan.start ? lostMonths(plan.start, today, cutoverDate, ran) : [];
  const priorTerm = (res.term as string) ?? "monthly";
  return {
    ok: true,
    preview: {
      reservationId: res.id as string,
      lotNumber,
      renterName: (renter?.display_name as string) ?? null,
      priorStart: range.start,
      priorEnd: range.end,
      lapsed: range.end < today,
      quotedAmount,
      priorQuotedAmount: priorQuoted,
      rentChangeOn: inForce && quotedAmount !== priorQuoted ? inForce.effective_on : null,
      plan,
      refusalText: plan.refusal ? renewalRefusalText(plan.refusal, lotNumber, offered) : null,
      chainNote: plan.totalMonthsAfter ? chainNotice(plan.totalMonthsAfter) : null,
      lengths,
      defaultMonths,
      lostMonths: lost,
      backfillNote: plan.ok && plan.start
        ? backfillWords(plan.start, today, lost, { quotedAmount, term: priorTerm, lotNumber })
        : null,
    },
    prior: {
      id: res.id as string,
      park_lot_id: res.park_lot_id as string,
      renter_id: res.renter_id as string,
      renter_unit_id: (res.renter_unit_id as string | null) ?? null,
      term: (res.term as string) ?? "monthly",
      quoted_amount: priorQuoted,
      agreement_chain_id: (res.agreement_chain_id as string | null) ?? null,
      agreement_seq: seq,
      due_day: (res.due_day as number | null) ?? null,
      tenancy_began_on: (res.tenancy_began_on as string | null) ?? null,
      amount_source: (res.amount_source as string | null) ?? null,
      amount_source_at: (res.amount_source_at as string | null) ?? null,
    },
  };
}

/**
 * The same thing, in the shape a button can read.
 *
 * A rejected promise inside a transition surfaces as a blank failure with no
 * sentence attached, so this catches and answers in its own result shape.
 */
export async function previewRenewal(
  parkId: string,
  reservationId: string,
  startFrom?: string,
): Promise<PreviewResult> {
  const { ok, error, preview } = await plannedOrSentence(parkId, reservationId, startFrom);
  return { ok, error, preview };
}

async function plannedOrSentence(
  parkId: string,
  reservationId: string,
  startFrom?: string,
): Promise<Planned> {
  try {
    return await planNextAgreement(parkId, reservationId, startFrom);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("that tenancy", e) };
  }
}

/**
 * Write it.
 *
 * `months` is THE HOUSEHOLD'S CHOICE of length, and it is required: the card
 * seeds the park's house style, so a call without one is a caller that lost
 * the choice, and defaulting here would be the cap-as-length bug in a new
 * coat. A length the park does not offer is refused in words that name the
 * ones it does.
 *
 * `newRent` is optional — a renewal at the same rent is the common case, and
 * demanding a number every time is how a renewal cycle becomes a chore. But
 * SENT AND BLANK is refused: that is the new-rent door with nothing typed,
 * and the placeholder must not write itself.
 */
export async function renewAgreement(
  parkId: string,
  reservationId: string,
  opts: { months: number; startFrom?: string; newRent?: string },
): Promise<ParkResult & { newEnd?: string }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  // The prior row is read ONCE, by the planner, and the successor is built
  // from that same read — so a failed read never reaches the insert as a row
  // attached to nobody: the planner's sentence comes back instead.
  const pre = await plannedOrSentence(parkId, reservationId, opts.startFrom);
  if (!pre.ok || !pre.preview || !pre.prior) return { ok: false, error: pre.error ?? "Couldn't work that out." };
  const { lotNumber } = pre.preview;
  if (!pre.preview.plan.ok) {
    return { ok: false, error: pre.preview.refusalText ?? "Can't renew that one." };
  }
  // THE PLAN FOR THE LENGTH THEY PICKED — the one the card showed. Not
  // offered means not planned, and the sentence names what is.
  const chosen = pre.preview.lengths.find((l) => l.months === opts.months);
  if (!chosen) {
    return { ok: false, error: lengthNotOfferedText(pre.preview.lengths.map((l) => l.months)) };
  }
  const plan = chosen.plan;
  if (!plan.ok || !plan.start || !plan.end) {
    const offered = pre.preview.lengths.map((l) => l.months);
    // A PER-LENGTH REFUSAL IS NOT A TOTAL ONE. `already_ended` is judged on
    // the plan's own end, so the length he tapped can be over while a longer
    // one reaches past today — the card loaded on 28 February shows the
    // 1-month chip, the tap lands after midnight on 1 March. This returned
    // the sentence written for "no length reaches" ("there's nothing to
    // write from here") while the refreshed card offered 3 or 6 months. Say
    // what the card says: which is over, and what to pick.
    const reach = pre.preview.lengths.filter((l) => l.plan.ok).map((l) => l.months);
    if (plan.refusal === "already_ended" && reach.length > 0) {
      return {
        ok: false,
        error: `From ${longDate(pre.preview.priorEnd)}, ${lengthInWords(chosen.months)} would be over already — pick ${lengthsInWords(reach)}.`,
      };
    }
    return { ok: false, error: plan.refusal ? renewalRefusalText(plan.refusal, lotNumber, offered) : "Can't renew that one." };
  }

  let quoted = pre.preview.quotedAmount;
  // THE ATTEMPT, BEFORE THE SANITIZER COLLAPSES IT. `newRent` undefined is
  // the same-rent door — one tap, nothing typed. `newRent` sent and blank is
  // the new-rent door with nothing in the box, and the placeholder must not
  // write itself: "Write it" over an empty field used to file the old rent
  // under a toast identical to a change.
  if (opts.newRent !== undefined && !opts.newRent.trim()) {
    return { ok: false, error: "Type the new rent, or use Renew at the same rent." };
  }
  const raw = (opts.newRent ?? "").trim();
  if (raw) {
    const n = Number(raw.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "That rent isn't a dollar amount." };
    if (n > 100_000) return { ok: false, error: "That rent looks like a typo." };
    quoted = Math.round(n * 100) / 100;
  }

  const admin = createServiceClient();

  // A SUCCESSOR ROW, never an edit. Last term's dates and rent are what the
  // ledger already billed against; rewriting them would restate history.
  //
  // Built by the one builder both doors share. `origin` is this door's fact —
  // an agreement the owner wrote is 'office' — never a copy of the prior's.
  // A gap OMITS the chain column so the database mints a new chain; sending
  // null to it is a constraint error, not a fresh start.
  const { data: inserted, error } = await admin.from("lot_reservations").insert(successorRow(pre.prior, {
    start: plan.start,
    end: plan.end,
    // ONE RULE with the resident's door: approved until it starts, active
    // from its first morning (a lapsed agreement backfilled from its own end
    // has already started).
    status: successorStatus(plan.start, todayLakeDate()),
    quotedAmount: quoted,
    origin: "office",
    continuesChain: plan.continuesChain ?? false,
    nextSeq: plan.nextSeq ?? 1,
    // The owner's own rule, and the database refuses a deposit on a
    // consecutive renewal regardless — so the two cannot drift apart.
    depositAmount: plan.depositDue ? plan.depositAmount : null,
    nowISO: new Date().toISOString(),
  })).select("id").single();
  if (error) {
    return {
      ok: false,
      error:
        "Couldn't write that one — check the dates don't overlap another " +
        "tenancy on the same lot.",
    };
  }

  revalidatePath("/park");
  revalidatePath("/park/today");
  revalidatePath("/park/rent");

  // THE MONTHS THE RUN HAS ALREADY PASSED are billed now, on the row just
  // written (decision 3). THE SAME MONTHS THE CARD NAMED — the planner's
  // own list (every length shares the start, and the planner read whether
  // this month ran) — each raised the way the run would raise it and
  // settled from money on account, oldest first. A month the run did raise
  // comes back 'already' and is silent; a month that could not be billed is
  // said, with its door.
  const billed = await billLostMonths(admin, parkId, (inserted?.id as string) ?? "", pre.preview.lostMonths);
  const tail = lostMonthsWords(billed);
  // A date a person reads is words — "May 1, 2027", never "2027-05-01" — and
  // the length they picked is said back, so a one-month renewal written by
  // mistake for six is caught by the toast and not by the ledger. THE WORDS
  // COME FROM THE PLAN, not the request: on a slip lot the season close sets
  // the end, and "renewed for 3 months, September 1 to October 15" described
  // six weeks as three months. agreementSpanWords says "cut short by the
  // season close" when it was, and the Today card reads the same helper.
  //
  // THE RENT IS NAMED EVERY TIME — the number written is the number the
  // ledger bills from the successor's first morning, and no screen after
  // this one shows it before it bills. "(was $400.00)" when it moved.
  // CONSECUTIVE only when the plan says the chain continues; a deposit is
  // mentioned only when one is due. A fresh start after a gap used to read
  // "Consecutive — no new deposit" at any park whose deposit dial is unset.
  const span = agreementSpanWords(plan);
  const priorRent = pre.preview.priorQuotedAmount;
  const per = perTermWords(pre.prior.term);
  const rent = quoted == null
    ? ""
    : ` at ${money(quoted)}${per ? ` ${per}` : ""}${priorRent != null && priorRent !== quoted ? ` (was ${money(priorRent)})` : ""}`;
  const chain = plan.continuesChain
    ? "Consecutive with the last one."
    : `Starts a new chain — there was a gap after ${longDate(pre.preview.priorEnd)}.` +
      (plan.depositDue && plan.depositAmount != null ? ` A deposit of ${money(plan.depositAmount)} is due.` : "");
  // THE MONEY FACT OF A BACKFILL, said back: what the tap billed, month by
  // month, in the words gap-bills gives every door (lostMonthsWords).
  return {
    ok: true,
    newEnd: plan.end,
    signal: `Lot ${lotNumber} renewed for ${span}${rent}. ${chain}${tail ? ` ${tail}` : ""}`,
  };
}

/**
 * Everything ending soon, so a whole cycle can be worked in one sitting.
 *
 * HOW FAR AHEAD IS EACH AGREEMENT'S OWN LAST HALF, capped at `leadCapDays`
 * (R2, `renewalLeadDays`): a one-month agreement is asked for renewal in its
 * last ~15 days, a three-month one 45 days out. A flat 45 days was longer
 * than a one-month agreement, so a renewal written on 1 February for
 * 1 February – 1 March was back in this list the same morning under the
 * toast that said it was renewed — as if the tap had not taken — and on
 * 1 January every one-month lease would have sat here from the day it was
 * signed.
 *
 * THROWS `ReadFailed`. Its one caller is `/park/today`, a server component
 * under the root error boundary, and that is deliberate: the caller renders
 * `rows ?? []`, and `ParkRenewals` renders NOTHING for an empty list. So a
 * dropped read used to remove the entire "Agreements to write" section from the
 * owner's morning screen without a mark — which is indistinguishable from a
 * quiet quarter, and ends with a tenancy lapsing and the rent stopping.
 */
export async function renewalsDue(
  parkId: string,
  leadCapDays: number = RENEWAL_LEAD_CAP_DAYS,
): Promise<{ ok: boolean; rows?: RenewalPreview[] }> {
  if (!(await assertMyPark(parkId))) return { ok: false };

  const admin = createServiceClient();
  const today = todayLakeDate();

  const lots = mustRead("your lots", await admin
    .from("park_lots").select("id").eq("park_id", parkId).eq("lifecycle", "live"));
  const ids = (lots ?? []).map((l) => l.id as string);
  if (!ids.length) return { ok: true, rows: [] };

  // The maxSeq map below decides which agreements ALREADY have a successor
  // written. Built from a failed read it would be empty, and every chain would
  // look unrenewed — so this read has to answer or stop.
  //
  // THE ENDED ROWS ARE READ TOO, so a later link that was closed out — the
  // household moved out inside its successor — still counts as a later
  // link. Without them the expired prior (held, run out, nothing held after
  // it) sat here under "Agreements to write" beside a tap that would have
  // billed a family who had left. Only held rows are candidates below.
  const everyRow = mustRead("who is on your lots", await admin
    .from("lot_reservations")
    .select("id, park_lot_id, during, status, agreement_chain_id, agreement_seq")
    .in("park_lot_id", ids)
    .in("status", ["approved", "active", "ended"]));
  const stays = (everyRow ?? []).filter((s) => s.status === "approved" || s.status === "active");

  // A chain with a later link already has its next agreement written — the
  // one predicate (agreement-helpers), which the nightly reminder reads too.
  const maxSeq = latestSeqByChain(everyRow ?? []);

  // WHETHER THIS MONTH'S RUN HAS HAPPENED — read once for the whole list, not
  // once per row. It decides whether the current month is among the months a
  // backfill bills; a failed read stops the list (a row told "bills when you
  // bill the month" about a month that ran would leave that month to nobody).
  const ran = await parkRanMonth(admin, parkId, currentPeriod(today));
  if (typeof ran !== "boolean") {
    console.error(`[read failed] ${ran.what}:`, ran.error);
    throw new ReadFailed(ran.what, String((ran.error as { message?: string })?.message ?? ""));
  }

  // Each agreement's own lead: the morning it enters its last half, or
  // `leadCapDays` before its end, whichever is later. Listed from that day.
  const due = stays.filter((s) => {
    const r = parseDaterange(s.during as string);
    if (!r) return false;
    const askFrom = addDays(r.end, -renewalLeadDays(r.start, r.end, leadCapDays));
    if (today < askFrom) return false;
    return !hasLaterLink(s, maxSeq);
  });

  const rows: RenewalPreview[] = [];
  for (const s of due) {
    // The THROWING core, not the button-shaped wrapper. `if (p.ok)` would drop
    // a household whose read failed straight out of the list, silently, which
    // is the one outcome this list exists to make impossible.
    const p = await planNextAgreement(parkId, s.id as string, undefined, ran);
    if (p.ok && p.preview) rows.push(p.preview);
  }
  rows.sort((a, b) => a.priorEnd.localeCompare(b.priorEnd));
  return { ok: true, rows };
}
