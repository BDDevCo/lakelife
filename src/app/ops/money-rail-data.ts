import "server-only";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { inFlight, STUCK_AFTER_WEEKDAYS } from "@/app/park/clearing-helpers";

/**
 * NOTHING NOTICED WHEN THE BANK RAIL BROKE.
 *
 * Two watches, both of which stay silent today and both of which have to exist
 * before the processor is connected rather than after.
 *
 * ============ 1. MONEY ASKED FOR THAT NEVER LANDED ============
 *
 * A bank debit is recorded provisional (0191) and something has to end it. The
 * park owner's own in-flight panel is that something — but it is a panel on a
 * screen, and a screen only works when somebody opens it. At The Haven that is
 * one person with a park to run.
 *
 * A debit nobody clears is not a small thing: the household has paid, their
 * bill reads open, and the arrears figure deliberately leaves it out — so the
 * money is in no total anywhere and nobody is being chased for it either. It
 * is invisible in both directions, which is the worst place for money to be.
 * Past seven working days the likeliest cause is that the processor never sent
 * it, which from this side looks exactly like patience.
 *
 * ============ 2. PROCESSOR EVENTS NOBODY READ ============
 *
 * 0157's webhook records every delivery with `processed_at` null and decides
 * no policy, on purpose: "the handler that drains that table is written after
 * the processor call, against real event names." That handler does not exist.
 *
 * So the day a processor is connected, events begin arriving and piling up in
 * a table nothing reads — including the one that matters most, an ACH debit
 * returned on Thursday that succeeded on Monday. This counts them. It reads
 * zero today and will read zero until the first delivery, and the first
 * delivery is exactly the moment somebody needs to be told.
 */

export interface StuckInFlight {
  /** Bank debits that have been on their way longer than they should be. */
  count: number;
  cents: number;
  /** The longest wait, in working days, so the sentence can name it. */
  worstWeekdays: number;
}

/**
 * Bank debits nobody has cleared or returned, across every park.
 *
 * NULL ON A FAILED READ. Zero reads as "all the money landed", which is the
 * reassuring way to be wrong about money in limbo.
 */
export async function getStuckInFlight(today = todayLakeDate()): Promise<StuckInFlight | null> {
  if (!(await assertOps())) return null;
  const admin = createServiceClient();

  const { data, error } = await admin
    .from("park_payments")
    .select("amount, received_on")
    // The same three exclusions every reader of this table uses: a reversed
    // row never happened, a bank-returned row came back, a settled row landed.
    .is("settled_at", null)
    .is("reversed_at", null)
    .is("returned_at", null);
  if (error) {
    console.error("[ops] money still clearing:", error.message);
    return null;
  }

  let count = 0;
  let cents = 0;
  let worstWeekdays = 0;
  for (const p of data ?? []) {
    const verdict = inFlight({ receivedOn: String(p.received_on ?? ""), today });
    // `unknown` IS COUNTED, not skipped. A row whose date we cannot read is a
    // payment we cannot age, and quietly dropping it is how a stuck debit
    // becomes invisible — the opposite of this function's job.
    if (verdict.kind !== "stuck" && verdict.kind !== "unknown") continue;
    count += 1;
    cents += Math.round(Number(p.amount ?? 0) * 100);
    worstWeekdays = Math.max(worstWeekdays, verdict.weekdays ?? STUCK_AFTER_WEEKDAYS);
  }
  return { count, cents, worstWeekdays };
}

/**
 * Processor deliveries nobody has acted on.
 *
 * NULL ON A FAILED READ, for the same reason: zero reads as "we are up to
 * date with the processor".
 */
export async function getUnreadProcessorEvents(): Promise<number | null> {
  if (!(await assertOps())) return null;
  const admin = createServiceClient();
  const { count, error } = await admin
    .from("processor_events")
    .select("id", { count: "exact", head: true })
    .is("processed_at", null);
  if (error) {
    console.error("[ops] unread processor events:", error.message);
    return null;
  }
  // A head count answers `{ count: null, error: null }` if the server declines
  // to count. That is not zero, and `count ?? 0` would make it zero — the
  // shape that once let a charge through a disputed-bill guard.
  return count ?? null;
}
