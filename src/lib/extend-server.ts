import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, ReadFailed, readFailedMessage } from "@/lib/must-read";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange, toDaterange, type DateRange, type Term } from "@/lib/parks";
import { canExtend, refusalText, type ExtendRefusal } from "@/lib/extend-stay";
import { isExtendToken } from "@/lib/token-format";
import { servedRentHistory } from "@/lib/rent-changes";
import { rentForPeriod } from "@/app/park/rerate-helpers";
import { successorRow } from "@/lib/successor-row";

/**
 * The server half of the one-tap extend. Pure decisions live in
 * lib/extend-stay.ts; this reads, writes, and never decides.
 */

export interface ExtendView {
  reservationId: string;
  lotNumber: string;
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
  refusal: ExtendRefusal | null;
  message: string | null;
  /** True when this park writes a NEW agreement instead of widening this one. */
  isRenewal: boolean;
  capMonths: number | null;
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
export async function loadExtendByToken(token: string): Promise<ExtendView | null> {
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
  });
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
export async function extendViewFor(res: ExtendSource): Promise<ExtendView | null> {
  const admin = createServiceClient();

  const [lotRes, renterRes] = await Promise.all([
    admin.from("park_lots").select("lot_number, park_id").eq("id", res.park_lot_id).maybeSingle(),
    admin.from("park_renters").select("display_name").eq("id", res.renter_id).maybeSingle(),
  ]);
  const lot = mustRead("the household's lot", lotRes);
  const renter = mustRead("the household's name", renterRes);
  // A stay whose lot is genuinely gone is not a stay the link can act on —
  // null here is the same "doesn't match a stay" the token lookup returns, and
  // it is only reached when the read RAN and found nothing.
  if (!lot) return null;

  const [parkRes, rateRes, othersRes, depositRes] = await Promise.all([
    admin.from("parks").select("name, max_agreement_months")
      .eq("id", lot.park_id as string).maybeSingle(),
    admin.from("lot_rates").select("term, amount").eq("park_lot_id", res.park_lot_id),
    admin
      .from("lot_reservations")
      .select("id, during, status")
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

  const range = parseDaterange(res.during);
  const term = res.term as Term;

  // Everything else DECIDED on this lot — excluding the stay being extended,
  // so an overlap here is a genuine clash with somebody else.
  const otherHeld: DateRange[] = (others ?? [])
    .filter((o) => o.id !== res.id)
    .map((o) => parseDaterange(o.during as string))
    .filter((r): r is DateRange => r != null);

  const capMonths = (park?.max_agreement_months as number | null) ?? null;

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

  const verdict = canExtend({
    range,
    term,
    status: res.status,
    todayISO: todayLakeDate(),
    otherHeld,
    rates: (rateRows ?? []).map((r) => ({ term: r.term as Term, amount: Number(r.amount) })),
    capMonths,
    currentAmount,
    origin: res.origin,
  });

  return {
    reservationId: res.id,
    lotNumber: (lot.lot_number as string) ?? "",
    parkName: (park?.name as string) ?? "the park",
    renterName: (renter?.display_name as string) ?? "there",
    term,
    currentEnd: range?.end ?? "",
    newEnd: verdict.ok ? verdict.range!.end : null,
    newStart: verdict.ok ? verdict.range!.start : null,
    price: verdict.ok ? verdict.price! : null,
    refusal: verdict.refusal ?? null,
    message: verdict.refusal ? refusalText(verdict.refusal) : null,
    // At a park that caps agreement length this is not an extension at all —
    // it is the NEXT AGREEMENT, and the screen has to say so, because signing
    // one is a different act from staying on.
    isRenewal: Boolean(verdict.isRenewal),
    capMonths,
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
): Promise<{ ok: boolean; newEnd?: string; depositHeld?: boolean; error?: string }> {
  // The loader THROWS on a failed read (a page can render an honest error; a
  // button awaiting { ok, error } cannot), so this is where that is turned
  // back into a sentence. `not_found` here would be the loader's lie repeated.
  let view: ExtendView | null;
  try {
    view = await loadExtendByToken(token);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your stay", e, { money: true }) };
  }
  if (!view) return { ok: false, error: refusalText("not_found") };
  if (view.refusal || !view.newEnd) {
    return { ok: false, error: view.message ?? refusalText("not_extendable") };
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

    const { error: insErr } = await admin.from("lot_reservations").insert(successorRow(
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
        status: "active",
        quotedAmount,
        origin: "office",
        // extendedRange starts the successor the morning this one ends.
        continuesChain: true,
        nextSeq: ((current!.agreement_seq as number) ?? 1) + 1,
        nowISO: new Date().toISOString(),
      },
    ));

    if (insErr) {
      if (insErr.code === "23P01") return { ok: false, error: refusalText("lot_taken") };
      return { ok: false, error: "Something went wrong — give the park a call and they'll sort it." };
    }

    // Clear the reminder on the OLD agreement so the new one gets asked in its
    // own right when its time comes.
    await admin
      .from("lot_reservations")
      .update({ extend_reminded_at: null, extended_at: new Date().toISOString() })
      .eq("id", view.reservationId);

    // `depositHeld` travels with the answer so the page after the tap can say
    // "nothing more to pay on your deposit" only to somebody who paid one.
    return { ok: true, newEnd: view.newEnd, depositHeld: view.depositHeld };
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
    if (error.code === "23P01") return { ok: false, error: refusalText("lot_taken") };
    return { ok: false, error: "Something went wrong — give the park a call and they'll sort it." };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "That stay just changed. Refresh, or give the park a call." };
  }

  return { ok: true, newEnd: view.newEnd, depositHeld: view.depositHeld };
}
