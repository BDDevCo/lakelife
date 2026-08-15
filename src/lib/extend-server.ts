import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange, toDaterange, type DateRange, type Term } from "@/lib/parks";
import { canExtend, refusalText, type ExtendRefusal } from "@/lib/extend-stay";
import { isExtendToken } from "@/lib/token-format";

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
  price: number | null;
  refusal: ExtendRefusal | null;
  message: string | null;
  /** True when this park writes a NEW agreement instead of widening this one. */
  isRenewal: boolean;
  capMonths: number | null;
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

  const { data: res } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, term, status, extended_count, agreement_chain_id, agreement_seq, quoted_amount")
    .eq("extend_token", token)
    .maybeSingle();
  if (!res) return null;

  const [{ data: lot }, { data: renter }] = await Promise.all([
    admin.from("park_lots").select("lot_number, park_id").eq("id", res.park_lot_id as string).maybeSingle(),
    admin.from("park_renters").select("display_name").eq("id", res.renter_id as string).maybeSingle(),
  ]);
  if (!lot) return null;

  const [{ data: park }, { data: rateRows }, { data: others }] = await Promise.all([
    admin.from("parks").select("name, max_agreement_months, deposit_amount")
      .eq("id", lot.park_id as string).maybeSingle(),
    admin.from("lot_rates").select("term, amount").eq("park_lot_id", res.park_lot_id as string),
    admin
      .from("lot_reservations")
      .select("id, during, status")
      .eq("park_lot_id", res.park_lot_id as string)
      .in("status", ["approved", "active"]),
  ]);

  const range = parseDaterange(res.during as string);
  const term = res.term as Term;

  // Everything else DECIDED on this lot — excluding the stay being extended,
  // so an overlap here is a genuine clash with somebody else.
  const otherHeld: DateRange[] = (others ?? [])
    .filter((o) => o.id !== res.id)
    .map((o) => parseDaterange(o.during as string))
    .filter((r): r is DateRange => r != null);

  const capMonths = (park?.max_agreement_months as number | null) ?? null;

  const verdict = canExtend({
    range,
    term,
    status: res.status as string,
    todayISO: todayLakeDate(),
    otherHeld,
    rates: (rateRows ?? []).map((r) => ({ term: r.term as Term, amount: Number(r.amount) })),
    capMonths,
    currentAmount: res.quoted_amount == null ? null : Number(res.quoted_amount),
  });

  return {
    reservationId: res.id as string,
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
): Promise<{ ok: boolean; newEnd?: string; error?: string }> {
  const view = await loadExtendByToken(token);
  if (!view) return { ok: false, error: refusalText("not_found") };
  if (view.refusal || !view.newEnd) {
    return { ok: false, error: view.message ?? refusalText("not_extendable") };
  }

  const admin = createServiceClient();
  const { data: current } = await admin
    .from("lot_reservations")
    .select("during, extended_count, park_lot_id, renter_id, term, quoted_amount, agreement_chain_id, agreement_seq")
    .eq("id", view.reservationId)
    .maybeSingle();
  const range = parseDaterange(current?.during as string);
  if (!range) return { ok: false, error: refusalText("not_found") };

  // ---- A CAPPED PARK WRITES A NEW AGREEMENT, it does not widen this one.
  //
  // Widening would destroy the thing the structure exists to produce: a
  // discrete, dated period with its own signature. So the successor is its own
  // row, sharing the chain, one higher in the sequence — and carrying NO
  // deposit, because a consecutive stay does not pay one twice. The database
  // refuses a deposit on any row with seq > 1, so that cannot drift.
  if (view.isRenewal && view.newStart && view.newEnd) {
    const { error: insErr } = await admin.from("lot_reservations").insert({
      park_lot_id: current!.park_lot_id,
      renter_id: current!.renter_id,
      during: toDaterange({ start: view.newStart, end: view.newEnd }),
      term: current!.term,
      quoted_amount: current!.quoted_amount,
      status: "active",
      origin: "office",
      agreement_chain_id: current!.agreement_chain_id,
      agreement_seq: ((current!.agreement_seq as number) ?? 1) + 1,
    });

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

    return { ok: true, newEnd: view.newEnd };
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

  return { ok: true, newEnd: view.newEnd };
}
