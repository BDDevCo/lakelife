import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, ReadFailed, readFailedMessage } from "@/lib/must-read";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange, toDaterange, effectiveSeason, type DateRange, type Term } from "@/lib/parks";
import { canExtend, refusalText, type ExtendRefusal, type MonthlyFee } from "@/lib/extend-stay";
import { offeredAgreementLengths, agreementMonthsFor, agreementSeasonEnd, successorStatus } from "@/app/park/agreement-helpers";
import { feesForTenancy } from "@/app/park/fee-helpers";
import { isExtendToken } from "@/lib/token-format";
import { servedRentHistory } from "@/lib/rent-changes";
import { rentForPeriod } from "@/app/park/rerate-helpers";
import { successorRow } from "@/lib/successor-row";
// A SUCCESSOR WRITTEN INTO THE PAST BILLS THE MONTHS IT MADE BILLABLE — the
// same rule and re-raise the owner's Renew and signing doors use (decision 3).
import { lostMonths } from "@/app/park/agreement-helpers";
import { parkRanMonth, billLostMonths } from "@/app/park/gap-bills";

/**
 * The server half of the one-tap extend. Pure decisions live in
 * lib/extend-stay.ts; this reads, writes, and never decides.
 */

export interface ExtendView {
  reservationId: string;
  /** The park the lot belongs to — what the tap bills a past month against. */
  parkId: string;
  /**
   * THE PARK'S GO-LIVE DAY (parks.cutover_date). A successor written from an
   * agreement that ended today, after this month's run, has a remainder the
   * run will never come back for; which months of it are ours to bill floors
   * here (lostMonths). Null when the park has not set one.
   */
  cutoverDate: string | null;
  lotNumber: string;
  /** long_term | short_term — what the lot is called to the household
   *  ("lot" or "site", lotWord) and whether a monthly fee reaches it. */
  rentalMode: string | null;
  parkName: string;
  renterName: string;
  term: Term;
  currentEnd: string;
  /** Null when it cannot be extended — `refusal` says why. */
  newEnd: string | null;
  /** The successor's START. Only set on a renewal — an extension keeps its own. */
  newStart: string | null;
  /**
   * THE NUMBER THE PAGE PRINTS AND THE NUMBER THE TAP WRITES. On a renewal it
   * is the rent in force on the successor's first morning — resolved from the
   * served history, so a $425 increase noticed for 1 April is what a May
   * agreement says and is written at — and `extendByToken` writes THIS field,
   * so the two cannot come apart.
   */
  price: number | null;
  /**
   * THE FEES THE SUCCESSOR'S HOUSEHOLD WILL BE BILLED EACH MONTH beside the
   * rent — the park's active monthly fees that reach this lot's mode and a
   * successor written as 'office' (feesForTenancy, the biller's own rule).
   * The text, the page and the page after the tap quote rent AND fee, so
   * "$400 a month" never describes an agreement that bills $542.53. Empty
   * at a park with no fee; on a short-term lot; on an extension.
   */
  monthlyFees: MonthlyFee[];
  refusal: ExtendRefusal | null;
  /** The refusal in the household's words — for `already_renewed` it names
   *  their next agreement's dates; for `lot_taken` the lot's own noun. */
  message: string | null;
  /** True when this park writes a NEW agreement instead of widening this one. */
  isRenewal: boolean;
  /** The park's ceiling — the renewal/extension switch, never the length. */
  capMonths: number | null;
  /**
   * THE LENGTHS THE HOUSEHOLD MAY PICK, ascending: the ones the park offers
   * (`offeredAgreementLengths`) that the tap would honour — each one asked
   * of `canExtend`, the tap's own verdict, so the page never shows a button
   * the tap refuses. Empty on an extension, and on a refusal.
   */
  offeredMonths: number[];
  /**
   * EACH OFFERED LENGTH WITH THE END IT WOULD REALLY HAVE — the same
   * verdicts `offeredMonths` was filtered by, kept so a button can say
   * "3 months, cut short by the season close" on a slip lot instead of
   * promising three months the season will not give. Same order as
   * `offeredMonths`; empty when it is.
   */
  lengths: { months: number; end: string; cutShortBySeason: boolean }[];
  /**
   * TRUE when the lot's season, not the chosen length, set `newEnd` — the
   * same judgement the owner's plan carries, so the page after the tap can
   * say "cut short by the season close" rather than call six weeks
   * "3 months". False on an extension.
   */
  cutShortBySeason: boolean;
  /**
   * THE LENGTH THIS VIEW IS RESOLVED AT — `newStart`/`newEnd` are its dates.
   * The requested one when the tap named one; otherwise the park's house
   * style, or the first offered length when the house style's dates are
   * taken. Null on an extension.
   */
  renewMonths: number | null;
  /**
   * WHETHER THE PARK IS HOLDING A DEPOSIT OF THEIRS — the fact that gates
   * "your deposit carries over" on the page and in the text. Read from the
   * money ledger by the same predicate the resident's own front page uses
   * (parks/my-data.ts): a `deposit` payment neither reversed nor handed back.
   * Not the park's deposit dial, which says what a NEW tenant would be asked
   * for and nothing about this household; at a park whose households signed
   * before the dial was set, every one of them would read a sentence about a
   * deposit they never paid.
   */
  depositHeld: boolean;
}

/** The row both doors start from — the page's token lookup and the nightly
 *  reminder's sweep read these columns and hand them to `extendViewFor`. */
export interface ExtendSource {
  id: string;
  park_lot_id: string;
  renter_id: string;
  during: string;
  term: string;
  status: string;
  origin: string | null;
  quoted_amount: number | string | null;
}

/**
 * Look up a stay by its texted token and work out whether one more period is
 * possible. Read-only — safe to run on a GET, which matters because SMS
 * link-preview prefetchers issue GETs.
 */
export async function loadExtendByToken(
  token: string,
  /** The length the tap named, on a POST; a GET names none and reads the house style. */
  renewMonths: number | null = null,
): Promise<ExtendView | null> {
  // Was `token.length < 16`, which let any 16-character string reach `.eq()`.
  // NOT `isBearerToken`: this token is minted as 'x' + 32 hex, so a hex-only
  // rule would refuse every extend link already sitting in somebody's texts.
  if (!isExtendToken(token)) return null;
  const admin = createServiceClient();

  // `return null` becomes "This link doesn't match a stay" on the renter's
  // phone. That sentence is only true if the lookup actually ran.
  const stay = mustRead("your stay", await admin
    .from("lot_reservations")
    // ONE string literal — supabase-js types a concatenated select as an error.
    .select("id, park_lot_id, renter_id, during, term, status, origin, quoted_amount")
    .eq("extend_token", token)
    .maybeSingle());
  if (!stay) return null;

  return extendViewFor({
    id: stay.id as string,
    park_lot_id: stay.park_lot_id as string,
    renter_id: stay.renter_id as string,
    during: stay.during as string,
    term: stay.term as string,
    status: stay.status as string,
    origin: (stay.origin as string | null) ?? null,
    quoted_amount: stay.quoted_amount as number | string | null,
  }, renewMonths);
}

/**
 * THE ONE RESOLUTION of what a stay's extend link offers — dates, price, or
 * the refusal — shared by the page that renders it and the nightly text that
 * mints its token.
 *
 * They used to resolve it separately. The reminder quoted the park's rate
 * card and an end date thirty nights out; the page, at a park that caps
 * agreement length, showed the household's rent in force and a new
 * three-month agreement. So at any capped park where the card differs from
 * the rent — or a served increase is pending — the text named one number and
 * the page it linked to named another; and with an empty card the text was
 * never sent, so the page's "an empty card never strands somebody" was
 * unreachable through the only path that mints its token. One function, two
 * callers, and the text cannot say anything the page will not.
 *
 * Every read here either produces the truth or throws `ReadFailed`: the page
 * renders an honest error, the reminder skips the household and says so.
 *
 * WHO READS THE NAME OF A FAILED READ. The `what` on every read below reaches
 * exactly two readers — the server log, and the nightly's skipped list, which
 * the office reads about somebody else's household — and never the resident:
 * the page's boundary renders its own sentence and the tap's returns one of
 * its own. So the reads are named in the third person. "Couldn't read your
 * rent history" on the owner's morning list was addressed to the tenant.
 */
export async function extendViewFor(
  res: ExtendSource,
  /**
   * THE LENGTH THE HOUSEHOLD PICKED, when they have — the POST re-resolves
   * the view at the length the tap named, and refuses one the park does not
   * offer, because a texted link can be replayed and the page's view is not
   * what the insert reads. Null resolves at the park's house style, which is
   * what the reminder text and the page before the tap read.
   */
  renewMonths: number | null = null,
): Promise<ExtendView | null> {
  const admin = createServiceClient();

  const [lotRes, renterRes] = await Promise.all([
    // THE LOT'S SEASON TOO — a slip closes before its park does, and the
    // successor is cut to it exactly as the owner's door cuts it (loadTerms).
    admin.from("park_lots")
      .select("lot_number, park_id, rental_mode, season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", res.park_lot_id).maybeSingle(),
    admin.from("park_renters").select("display_name").eq("id", res.renter_id).maybeSingle(),
  ]);
  const lot = mustRead("the household's lot", lotRes);
  const renter = mustRead("the household's name", renterRes);
  // A stay whose lot is genuinely gone is not a stay the link can act on —
  // null here is the same "doesn't match a stay" the token lookup returns, and
  // it is only reached when the read RAN and found nothing.
  if (!lot) return null;

  const [parkRes, rateRes, othersRes, depositRes, feeRes] = await Promise.all([
    // THE HOUSE STYLE TOO. Only the cap was read, and the cap was the length.
    // And the park's season, which the lot inherits when it has none of its own.
    admin.from("parks")
      .select("name, max_agreement_months, default_agreement_months, season_open_month, season_open_day, season_close_month, season_close_day, cutover_date")
      .eq("id", lot.park_id as string).maybeSingle(),
    admin.from("lot_rates").select("term, amount").eq("park_lot_id", res.park_lot_id),
    // WHOSE, as well as when: the household's own next agreement sits on
    // this lot too, and it is not a clash.
    admin
      .from("lot_reservations")
      .select("id, renter_id, during, status")
      .eq("park_lot_id", res.park_lot_id)
      .in("status", ["approved", "active"]),
    // Money of theirs the park is holding — the resident's own front page's
    // predicate, to the column. `returned_on` is the park handing it back at
    // move-out; `returned_at` is the bank pulling the debit back after it
    // settled (0155); `reversed_at` means it never happened. One row is enough
    // to know, and its own read rather than a slice of recent receipts,
    // because a deposit taken years ago is still held.
    admin
      .from("park_payments")
      .select("id")
      .eq("renter_id", res.renter_id)
      .eq("kind", "deposit")
      .is("reversed_at", null)
      .is("returned_on", null)
      .is("returned_at", null)
      .limit(1),
    // WHAT THE SUCCESSOR BILLS BESIDE THE RENT — the same read and rule the
    // owner's signing toast uses (sign-actions): active park fees, filtered
    // below to the monthly ones the biller charges.
    admin
      .from("park_fees")
      .select("label, amount, cadence, applies_to")
      .eq("park_id", lot.park_id as string)
      .eq("active", true),
  ]);
  // FAILS OPEN IF LEFT ALONE, twice over. A failed `parks` read leaves
  // capMonths null, which switches the agreement cap OFF and turns a renewal
  // into a silent open-ended extension; a failed `others` read leaves otherHeld
  // empty, so canExtend sees no clash and offers a period the lot is already
  // sold for. Both end in money and a double-booked pad.
  const park = mustRead("the park", parkRes);
  const rateRows = mustRead("the rate for the household's lot", rateRes);
  const others = mustRead("what else is booked on the household's lot", othersRes);
  // And a failed deposit read must not quietly print nothing about a $500
  // the household is owed — or "carries over" at one they never paid.
  const deposits = mustRead("the household's deposit", depositRes);
  // A failed fee read must not print "$400 a month" as the all-in — the
  // household would act on a number a third short of the bill.
  const feeRows = mustRead("the park's fees", feeRes);

  const range = parseDaterange(res.during);
  const term = res.term as Term;

  // Everything else DECIDED on this lot — excluding the stay being extended
  // — PARTITIONED. A later row for the SAME household, starting on or after
  // this one's end, is `ownSuccessor`, the earliest of them: at a capped
  // park their next agreement (written by their earlier tap, or by the
  // office for them), and at a park with no cap simply their own later
  // booking, which canExtend holds for the clash test like anybody else's.
  // Everything else is somebody else's, and only that is a clash. Keyed on
  // the renter, not the chain: a gap renewal from the office starts a new
  // chain for the same household.
  const decided = (others ?? [])
    .filter((o) => o.id !== res.id)
    .map((o) => ({ renterId: (o.renter_id as string | null) ?? null, range: parseDaterange(o.during as string) }))
    .filter((o): o is { renterId: string | null; range: DateRange } => o.range != null);
  const isOwn = (o: { renterId: string | null; range: DateRange }) =>
    o.renterId === res.renter_id && range != null && o.range.start >= range.end;
  const ownSuccessor: DateRange | null = decided
    .filter(isOwn)
    .map((o) => o.range)
    .sort((a, b) => a.start.localeCompare(b.start))[0] ?? null;
  const otherHeld: DateRange[] = decided.filter((o) => !isOwn(o)).map((o) => o.range);

  // THE FEES THIS HOUSEHOLD WILL BE BILLED with the successor's rent — the
  // biller's filter (monthly, an audience the run honours) and its rule
  // (feesForTenancy: never a short-term lot, never an inherited tenancy —
  // and the successor is written 'office', which is what the tap writes).
  const monthlyFees: MonthlyFee[] = feesForTenancy(
    (feeRows ?? [])
      .filter((f) => (f.cadence as string) === "monthly")
      .filter((f) => ["all_lots", "long_term"].includes(f.applies_to as string)),
    { rental_mode: lot.rental_mode },
    { origin: "office" },
  ).map((f) => ({ label: (f.label as string) ?? "fee", amount: Number(f.amount) }));

  const capMonths = (park?.max_agreement_months as number | null) ?? null;
  const defaultMonths = (park?.default_agreement_months as number | null) ?? null;

  // THE SEASON THE SUCCESSOR IS CUT TO — the lot's own when it has one, else
  // the park's (effectiveSeason), and the morning it sets from the ONE home
  // the owner's door reads (agreementSeasonEnd). Null for a year-round lot.
  const season = effectiveSeason(
    {
      openMonth: (lot.season_open_month as number | null) ?? null,
      openDay: (lot.season_open_day as number | null) ?? null,
      closeMonth: (lot.season_close_month as number | null) ?? null,
      closeDay: (lot.season_close_day as number | null) ?? null,
    },
    {
      openMonth: (park?.season_open_month as number | null) ?? null,
      openDay: (park?.season_open_day as number | null) ?? null,
      closeMonth: (park?.season_close_month as number | null) ?? null,
      closeDay: (park?.season_close_day as number | null) ?? null,
    },
  );
  const seasonEnd = range ? agreementSeasonEnd(range.end, season) : null;

  // THE RENT IN FORCE ON THE SUCCESSOR'S FIRST MORNING — which is the day this
  // agreement ends — from the same served history the bills read. This is the
  // number the page prints and the number the tap writes; `quoted_amount` off
  // this row is the number BEFORE a scheduled increase has been applied to it,
  // and printing that while writing the other told a resident "$400" and
  // filed $425. A failed history read would print the old number as if it
  // were the truth, so it stops — the page renders an honest error instead.
  const quoted = res.quoted_amount == null ? null : Number(res.quoted_amount);
  const hist = await servedRentHistory([res.id]);
  if (hist.error) {
    console.error("[read failed] the household's rent history:", hist.error);
    throw new ReadFailed("the household's rent history", String((hist.error as { message?: string })?.message ?? ""));
  }
  const currentAmount = range
    ? rentForPeriod(hist.byRes.get(res.id) ?? [], range.end, quoted)
    : quoted;

  // THE ASK, BUILT ONCE. Every verdict below — each length the page may
  // offer, and the one the view is resolved at — is canExtend on this same
  // input with only the length changed, so the page can never show a button
  // the tap refuses. The list used to be filtered by a re-typed copy of
  // canExtend's clash test; the moment either copy changed, or canExtend
  // gained a refusal that depends on the length, the two disagreed again.
  const ask = {
    range,
    term,
    status: res.status,
    todayISO: todayLakeDate(),
    otherHeld,
    ownSuccessor,
    rates: (rateRows ?? []).map((r) => ({ term: r.term as Term, amount: Number(r.amount) })),
    capMonths,
    defaultMonths,
    seasonEnd,
    currentAmount,
    origin: res.origin,
  };

  // THE LENGTHS ON OFFER, at a capped park: the ones the park writes that the
  // tap would honour. The view is resolved at the requested length; a request
  // the park does not offer is refused by canExtend in its own words, and a
  // GET (no request) reads the house style, or the first honoured length when
  // the house style's dates are taken.
  const houseStyle = agreementMonthsFor(defaultMonths, capMonths);
  const lengths = capMonths == null
    ? []
    : offeredAgreementLengths(defaultMonths, capMonths).flatMap((m) => {
        const v = canExtend({ ...ask, renewMonths: m });
        return v.ok ? [{ months: m, end: v.range!.end, cutShortBySeason: Boolean(v.cutShortBySeason) }] : [];
      });
  const offeredMonths = lengths.map((l) => l.months);
  const resolvedMonths = capMonths == null
    ? null
    : renewMonths != null
      ? renewMonths
      : (houseStyle != null && offeredMonths.includes(houseStyle) ? houseStyle : offeredMonths[0] ?? houseStyle);

  const verdict = canExtend({ ...ask, renewMonths: resolvedMonths });

  return {
    reservationId: res.id,
    parkId: lot.park_id as string,
    cutoverDate: (park?.cutover_date as string | null) ?? null,
    lotNumber: (lot.lot_number as string) ?? "",
    rentalMode: (lot.rental_mode as string | null) ?? null,
    parkName: (park?.name as string) ?? "the park",
    renterName: (renter?.display_name as string) ?? "there",
    term,
    currentEnd: range?.end ?? "",
    newEnd: verdict.ok ? verdict.range!.end : null,
    newStart: verdict.ok ? verdict.range!.start : null,
    price: verdict.ok ? verdict.price! : null,
    monthlyFees: verdict.ok && verdict.isRenewal ? monthlyFees : [],
    refusal: verdict.refusal ?? null,
    message: verdict.refusal ? refusalText(verdict.refusal, ownSuccessor, lot.rental_mode as string | null) : null,
    // At a park that caps agreement length this is not an extension at all —
    // it is the NEXT AGREEMENT, and the screen has to say so, because signing
    // one is a different act from staying on.
    isRenewal: Boolean(verdict.isRenewal),
    capMonths,
    offeredMonths: verdict.ok && verdict.isRenewal ? offeredMonths : [],
    lengths: verdict.ok && verdict.isRenewal ? lengths : [],
    renewMonths: verdict.ok && verdict.isRenewal ? resolvedMonths : null,
    cutShortBySeason: Boolean(verdict.ok && verdict.cutShortBySeason),
    depositHeld: (deposits ?? []).length > 0,
  };
}

/**
 * Actually extend. POST only.
 *
 * The DATABASE is the real guard: widening the range is an UPDATE that the
 * no-double-booking exclusion constraint re-validates for free, so an
 * extension into somebody else's booked window fails rather than double-selling
 * the lot. We re-check first so the renter reads a sentence instead of an
 * error, and we still catch 23P01 because the window between the check and the
 * write is exactly where a race lives.
 */
export async function extendByToken(
  token: string,
  /**
   * THE LENGTH THE TAP NAMED, in months — the household's choice at a capped
   * park, posted by the button they pressed. Re-validated here against the
   * lengths the park offers, on the row as it stands now: a texted link is
   * replayable and the page's view is not what the insert reads. Ignored on
   * an extension (a park with no cap widens by one period of the term).
   */
  renewMonths: number | null = null,
): Promise<{
  ok: boolean;
  newStart?: string;
  newEnd?: string;
  /** Set on a renewal: the length written, and the monthly rent it was written at. */
  renewMonths?: number | null;
  price?: number | null;
  /** The fees billed beside that rent — the page after the tap quotes both. */
  monthlyFees?: MonthlyFee[];
  /** What the lot is called to them — "lot" or "site" (lotWord). */
  rentalMode?: string | null;
  term?: Term;
  /** On a renewal: the season, not the length, set `newEnd` — say so. */
  cutShortBySeason?: boolean;
  depositHeld?: boolean;
  error?: string;
  /** The loader's refusal, when that is why nothing was written — so the
   *  page after a replayed tap can tell "already set" from an error. */
  refusal?: ExtendRefusal;
}> {
  // The loader THROWS on a failed read (a page can render an honest error; a
  // button awaiting { ok, error } cannot), so this is where that is turned
  // back into a sentence. `not_found` here would be the loader's lie repeated.
  let view: ExtendView | null;
  try {
    view = await loadExtendByToken(token, renewMonths);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your stay", e, { money: true }) };
  }
  if (!view) return { ok: false, error: refusalText("not_found") };
  if (view.refusal || !view.newEnd) {
    return { ok: false, error: view.message ?? refusalText("not_extendable"), refusal: view.refusal ?? undefined };
  }
  // A RENEWAL IS WRITTEN AT THE LENGTH THEY PICKED, AND ONLY THAT. The loader
  // resolved the view at the posted length and refused one the park does not
  // offer; a tap with no length at all at a capped park is not a choice, and
  // writing the house style for them would be this screen choosing — and it
  // is told a length is MISSING, not that "that length" is not written.
  if (view.isRenewal && renewMonths == null) {
    return { ok: false, error: refusalText("length_missing") };
  }
  if (view.isRenewal && view.renewMonths !== renewMonths) {
    return { ok: false, error: refusalText("length_not_offered") };
  }

  const admin = createServiceClient();
  // Everything the successor copies is read here — the household's due day,
  // move-in date and rent confirmation travel with them, and a narrower select
  // is how they used to be dropped on the floor.
  const currentRes = await admin
    .from("lot_reservations")
    // ONE string literal — supabase-js types a concatenated select as an error.
    .select("id, during, origin, extended_count, park_lot_id, renter_id, renter_unit_id, term, quoted_amount, agreement_chain_id, agreement_seq, due_day, tenancy_began_on, amount_source, amount_source_at")
    .eq("id", view.reservationId)
    .maybeSingle();
  if (currentRes.error) {
    return { ok: false, error: readFailedMessage("your stay", currentRes.error, { money: true }) };
  }
  const current = currentRes.data;
  const range = parseDaterange(current?.during as string);
  if (!range) return { ok: false, error: refusalText("not_found") };

  // A HOUSEHOLD STILL ON THE SELLER'S ARRANGEMENT signs its new lease with the
  // park, and that is recorded from the rent roll — the one act that ends the
  // holdover and starts the fee. Writing a successor here would file it as
  // 'office' and bill a fee they never agreed to. The loader already refused
  // this; it is checked again on the row being written, because a texted link
  // can be replayed and the view it was handed is not what the insert reads.
  if (current?.origin === "grandfathered") {
    return { ok: false, error: refusalText("inherited") };
  }

  // ---- A CAPPED PARK WRITES A NEW AGREEMENT, it does not widen this one.
  //
  // Widening would destroy the thing the structure exists to produce: a
  // discrete, dated period with its own signature. So the successor is its own
  // row, sharing the chain, one higher in the sequence — and carrying NO
  // deposit, because a consecutive stay does not pay one twice. The database
  // refuses a deposit on any row with seq > 1, so that cannot drift.
  //
  // The row is built by the same builder the owner's "Agreements to write"
  // uses, and its rent is `view.price` — THE NUMBER THE PAGE PRINTED, which
  // the loader resolved as the rent in force on the successor's first morning
  // from the served history the bills read. Not `quoted_amount` copied off
  // this row before a scheduled increase has been applied to it, and not a
  // second resolution that could disagree with the sentence they tapped.
  if (view.isRenewal && view.newStart && view.newEnd) {
    const priorQuoted = current!.quoted_amount == null ? null : Number(current!.quoted_amount);
    const quotedAmount = view.price;

    const { data: succ, error: insErr } = await admin.from("lot_reservations").insert(successorRow(
      {
        id: view.reservationId,
        park_lot_id: current!.park_lot_id as string,
        renter_id: current!.renter_id as string,
        renter_unit_id: (current!.renter_unit_id as string | null) ?? null,
        term: current!.term as string,
        quoted_amount: priorQuoted,
        agreement_chain_id: (current!.agreement_chain_id as string | null) ?? null,
        agreement_seq: (current!.agreement_seq as number | null) ?? 1,
        due_day: (current!.due_day as number | null) ?? null,
        tenancy_began_on: (current!.tenancy_began_on as string | null) ?? null,
        amount_source: (current!.amount_source as string | null) ?? null,
        amount_source_at: (current!.amount_source_at as string | null) ?? null,
      },
      {
        start: view.newStart,
        end: view.newEnd,
        // ONE RULE with the owner's door: approved until it starts, active
        // from its first morning. This door wrote `active` for a row that
        // had not begun while the owner's wrote `approved` for the same fact.
        status: successorStatus(view.newStart, todayLakeDate()),
        quotedAmount,
        origin: "office",
        // extendedRange starts the successor the morning this one ends.
        continuesChain: true,
        nextSeq: ((current!.agreement_seq as number) ?? 1) + 1,
        nowISO: new Date().toISOString(),
      },
    )).select("id").single();

    if (insErr) {
      if (insErr.code === "23P01") return { ok: false, error: refusalText("lot_taken", null, view.rentalMode) };
      return { ok: false, error: "Something went wrong — give the park a call and they'll sort it." };
    }

    // The OLD agreement keeps its stamp: it WAS asked, and that is how this
    // row came to be. The successor is born with a stamp of its own (null),
    // so it is asked in its own right when its time comes. Clearing the old
    // stamp put the old row back into the nightly sweep the very next
    // night, where its own successor read as "lot taken".
    await admin
      .from("lot_reservations")
      .update({ extended_at: new Date().toISOString() })
      .eq("id", view.reservationId);

    // THE REMAINDER OF THIS MONTH, when the tap lands on the agreement's last
    // day (extend-stay refuses only a stay already ended) after the month's
    // run has happened: the successor starts today, the run visited this
    // month before it existed and keys "already billed" per reservation, so
    // nothing else would ever raise it. Bill it now through the one re-raise
    // every such door uses. Three doors write successors; this was the one
    // that did not bill what it made billable. The outcome's words go
    // nowhere — nothing here sends to a resident — so a failed read is
    // logged, and the month is left for the owner's rent screen.
    const today = todayLakeDate();
    const ran = await parkRanMonth(admin, view.parkId, today.slice(0, 7));
    if (typeof ran !== "boolean") {
      console.error(`[read failed] ${ran.what}:`, ran.error);
    } else if (succ?.id) {
      await billLostMonths(admin, view.parkId, succ.id as string, lostMonths(view.newStart, today, view.cutoverDate, ran));
    }

    // `depositHeld` travels with the answer so the page after the tap can say
    // "nothing more to pay on your deposit" only to somebody who paid one —
    // and the length and dates written travel so it can say what was chosen.
    return {
      ok: true,
      newStart: view.newStart,
      newEnd: view.newEnd,
      renewMonths: view.renewMonths,
      price: view.price,
      monthlyFees: view.monthlyFees,
      rentalMode: view.rentalMode,
      term: view.term,
      cutShortBySeason: view.cutShortBySeason,
      depositHeld: view.depositHeld,
    };
  }

  const { data: updated, error } = await admin
    .from("lot_reservations")
    .update({
      during: toDaterange({ start: range.start, end: view.newEnd }),
      extended_count: ((current?.extended_count as number) ?? 0) + 1,
      extended_at: new Date().toISOString(),
      // Clear the reminder so the NEXT period gets asked in its own right.
      // Leaving it set would extend a stay once and then never ask again.
      extend_reminded_at: null,
    })
    .eq("id", view.reservationId)
    // Guarded on the range we read: if the park moved it underneath us, this
    // matches nothing rather than overwriting their change.
    .eq("during", toDaterange(range))
    .select("id");

  if (error) {
    if (error.code === "23P01") return { ok: false, error: refusalText("lot_taken", null, view.rentalMode) };
    return { ok: false, error: "Something went wrong — give the park a call and they'll sort it." };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "That stay just changed. Refresh, or give the park a call." };
  }

  return { ok: true, newEnd: view.newEnd, renewMonths: null, rentalMode: view.rentalMode, depositHeld: view.depositHeld };
}
