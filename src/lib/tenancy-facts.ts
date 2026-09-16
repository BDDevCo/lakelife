import { mustRead } from "@/lib/must-read";
import { parseDaterange } from "@/lib/parks";
import { todayLakeDate } from "@/lib/booking";
import { coversDay, lapsedRowOf } from "@/app/park/park-helpers";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * WHETHER ANYTHING MORE WILL EVER BILL FOR A HOUSEHOLD — the one read.
 *
 * "It comes off the next bill" is a promise, and since 0169 the DEFAULT
 * state of every move-out overpayment is that no next bill will ever come:
 * January paid in full, the bill cancelled, the part month settled from it,
 * $70.00 left. Every door that prints that promise has to ask the same two
 * questions first — has the tenancy ended (nobody on the lot, by the roll's
 * own rule), and is the month they moved out in billed (a non-void bill for
 * that month on the link they left from)?
 *
 * The rule lived as three private copies that already disagreed with each
 * other — the held-money panel's (money-actions), the resident receipt's
 * (confirm-server) and the resident home's (my-data). This is the one the
 * office's screens key "nothing more bills for them; this is theirs to
 * have back" on, lifted here so a "use server" module (whose every export
 * is an endpoint) is not the place a plain helper has to be imported from.
 *
 * mustRead on both reads: a failed read defaulting to "still here" would
 * print a promise of a next bill over money the park owes back, which is
 * the exact sentence this exists to end.
 */
export interface TenancyFacts {
  /**
   * Nobody is on the lot by the roll's rule (lapsedRowOf — no held link
   * covers today or is still to start, and the latest-ending row is a
   * close-out), and a link carries the day they left.
   */
  tenancyEnded: boolean;
  /** The day they left, off the link they moved out from — null while they are here. */
  movedOutOn: string | null;
  /**
   * A non-void bill exists on that link for the month they left in. Only
   * with `tenancyEnded` is "nothing more bills" true: a move-out recorded
   * before the month's run still gets a prorated final bill, which the run
   * settles from money on account (R1), so until that bill exists "theirs
   * to have back" is not yet the truth.
   */
  finalMonthBilled: boolean;
}

/** Both facts at once — the one test every "comes off the next bill" sentence keys on. */
export function nothingMoreBills(f: TenancyFacts | undefined): boolean {
  return f != null && f.tenancyEnded && f.finalMonthBilled;
}

export async function tenancyFactsFor(
  admin: ReturnType<typeof createServiceClient>,
  renterIds: readonly string[],
  todayISO: string = todayLakeDate(),
): Promise<Map<string, TenancyFacts>> {
  const out = new Map<string, TenancyFacts>();
  if (renterIds.length === 0) return out;
  const stays = mustRead(
    "whether those households are still here",
    await admin.from("lot_reservations")
      .select("id, renter_id, status, moved_out_on, during, term")
      .in("renter_id", [...renterIds])
      .in("status", ["approved", "active", "ended"]),
  ) ?? [];
  // The link each departed household moved out FROM — the one carrying the
  // last day. Its final month is the month of that day.
  const lastLink = new Map<string, { id: string; movedOutOn: string }>();
  const byRenter = new Map<string, typeof stays>();
  for (const s of stays) {
    const rid = s.renter_id as string;
    (byRenter.get(rid) ?? byRenter.set(rid, []).get(rid)!).push(s);
    if (s.status !== "ended") continue;
    const day = (s.moved_out_on as string | null) ?? null;
    if (!day) continue;
    const prev = lastLink.get(rid);
    if (!prev || day > prev.movedOutOn) lastLink.set(rid, { id: s.id as string, movedOutOn: day });
  }
  // STILL HERE is the roll's one rule (lapsedRowOf), not "a held row
  // exists". A household closed out THROUGH their renewal leaves the link
  // before it approved/active, run out, with nothing held after it — a
  // move-out marks only the link that covered the day `ended` and leaves
  // the expired links before it as they were — and "any held row means
  // they're here" read that family as living on January's link ten days
  // after they left: their $70.00 was promised to "the next bill", which
  // will never come. So: a held link covering today, or still to start,
  // means they are here; otherwise the latest-ending row across held and
  // ended decides — the run-out link is a lapsed holdover only when nobody
  // was closed out after it.
  const stillHere = new Set<string>();
  for (const [rid, rows] of byRenter) {
    const shaped = rows.map((r) => ({ status: String(r.status ?? ""), range: parseDaterange(r.during as string), term: String(r.term ?? "") }));
    const held = shaped.filter((r) => (r.status === "approved" || r.status === "active") && r.range);
    const holds = held.some((r) => coversDay(r.range, todayISO) || r.range!.start > todayISO);
    if (holds || lapsedRowOf(shaped, todayISO) != null) stillHere.add(rid);
  }
  const linkIds = [...lastLink.values()].map((l) => l.id);
  const billed = new Set<string>();
  if (linkIds.length) {
    const charges = mustRead(
      "whether their final month is billed",
      await admin.from("park_charges")
        .select("reservation_id, period_month, status")
        .in("reservation_id", linkIds)
        .neq("status", "void"),
    ) ?? [];
    for (const c of charges) billed.add(`${c.reservation_id}:${c.period_month}`);
  }
  for (const rid of renterIds) {
    const link = lastLink.get(rid);
    const ended = !stillHere.has(rid) && link != null;
    out.set(rid, {
      tenancyEnded: ended,
      movedOutOn: ended ? link!.movedOutOn : null,
      finalMonthBilled: ended && billed.has(`${link!.id}:${link!.movedOutOn.slice(0, 7)}`),
    });
  }
  return out;
}
