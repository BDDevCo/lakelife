import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import type { RentChangePoint } from "@/app/park/rerate-helpers";

/**
 * APPLYING RENT INCREASES THAT HAVE COME DUE — the engine, with no auth of its
 * own, in a file a browser cannot reach.
 *
 * This lived in `rerate-actions.ts`, which carries "use server". Every export
 * of such a file is a server action callable from any browser that knows its
 * id, and unlike every sibling in that file it had NO `assertMyPark` — so it
 * was an unauthenticated write to rent. Worse, `parkId` is optional: called
 * with no argument it walks EVERY park in the system.
 *
 * The blast radius was bounded by the query rather than by any check: it only
 * touches changes that are already past their effective date, already have a
 * notice served, and are not applied or cancelled. So a stranger could not
 * invent an increase — only make one that was already legitimately due land
 * earlier in the day than the owner intended. That is a small harm and it is
 * still not a decision a stranger gets to make.
 *
 * CALLERS AUTHORIZE. `runCharges` has already asserted park membership before
 * it calls this; the nightly is cron-authenticated and deliberately passes no
 * park so it sweeps them all. The thin wrapper left behind in rerate-actions
 * is the only version a browser can reach, and it checks.
 */
export async function applyDueRentChangesFor(parkId?: string): Promise<{
  applied: number; skipped: number; errors: string[];
}> {
  const admin = createServiceClient();
  const today = todayLakeDate();

  let q = admin
    .from("lot_rent_changes")
    .select("id, reservation_id, to_amount, effective_on, notice_given_on")
    .lte("effective_on", today)
    .is("applied_at", null)
    .is("cancelled_at", null)
    .not("notice_given_on", "is", null);
  if (parkId) q = q.eq("park_id", parkId);

  const dueRes = await q;
  const errors: string[] = [];
  let applied = 0;
  let skipped = 0;

  // NOBODY IS WATCHING THIS ONE. A failed read arrives as `data: null`, which
  // this loop reads as "no increases are due" — so the nightly returned
  // { applied: 0, skipped: 0, errors: [] }, a clean bill of health for a run
  // that never looked. Rent then quietly stays at the old figure until somebody
  // notices. Report it as the failure it is and apply nothing: the other
  // nightly steps still run, and tomorrow's run picks these up because they are
  // still unapplied.
  if (dueRes.error) {
    console.error("[read failed] rent increases that have come due:", dueRes.error);
    return { applied: 0, skipped: 0, errors: ["couldn't read the due rent changes"] };
  }
  const due = dueRes.data;

  for (const c of due ?? []) {
    const { error: resErr } = await admin
      .from("lot_reservations")
      .update({
        quoted_amount: c.to_amount,
        // HE set this number, and he set it before anyone confirmed it. A
        // re-rate is never 'tenant_confirmed' — that has to be earned at the
        // window, one household at a time.
        amount_source: "owner_knowledge",
        amount_source_at: new Date().toISOString(),
      })
      .eq("id", c.reservation_id as string);

    if (resErr) { skipped += 1; errors.push(`reservation ${c.reservation_id}`); continue; }

    const { error: chErr } = await admin
      .from("lot_rent_changes")
      .update({ applied_at: new Date().toISOString() })
      .eq("id", c.id as string);
    if (chErr) { skipped += 1; errors.push(`change ${c.id}`); continue; }

    applied += 1;
  }

  return { applied, skipped, errors };
}

/**
 * THE RENT HISTORY A BILL IS ALLOWED TO RELY ON.
 *
 * Two callers reconstruct what a household's rent WAS during a month —
 * `previewChargeRun` for the confirm screen and `runCharges` for the bills
 * themselves — and they were reading two different sets of rows:
 *
 *   preview: effective_on <= TODAY, notice served, not applied, not cancelled
 *   run:     every non-cancelled change, resolved at the END OF THE MONTH
 *
 * Both halves of that mismatch bill somebody wrongly.
 *
 * 1. THE WINDOW. Billing January on the 2nd, with an increase to $400 due the
 *    15th: the preview finds nothing due by today and quotes $272, the run
 *    resolves at 31 January and bills $400. He approves nineteen bills at the
 *    old rate and nineteen households are charged the new one — the one thing
 *    a confirm screen must never do, and the preview's own comment says so.
 *
 * 2. THE NOTICE. `scheduleReRate` writes every change with `notice_given_on`
 *    NULL on purpose — he has not served anybody yet — and the database
 *    refuses to APPLY one until he records that he has. But the run never
 *    asked: it rebuilt the rate from the change rows directly, so an increase
 *    nobody had been told about was billed anyway. That is the entire point of
 *    the notice gate, walked straight past by the path that takes the money.
 *
 * So there is now ONE query, with the notice filter, and both callers resolve
 * it at the same instant — the end of the month being billed. A change that
 * has not been served is not history yet, and does not move a bill.
 *
 * `applied_at` is deliberately NOT filtered: an applied change is exactly the
 * history a past month needs to be billed correctly.
 */
export async function servedRentHistory(
  resIds: readonly string[],
): Promise<{ byRes: Map<string, RentChangePoint[]>; error: unknown | null }> {
  const byRes = new Map<string, RentChangePoint[]>();
  if (resIds.length === 0) return { byRes, error: null };

  const admin = createServiceClient();
  const res = await admin
    .from("lot_rent_changes")
    .select("reservation_id, effective_on, from_amount, to_amount")
    .in("reservation_id", [...resIds])
    .is("cancelled_at", null)
    .not("notice_given_on", "is", null);

  // Empty reads as "nobody's rent ever changed", which bills every month at
  // today's rate. The callers turn this into a refusal rather than a guess.
  if (res.error) return { byRes, error: res.error };

  for (const c of res.data ?? []) {
    const k = c.reservation_id as string;
    const list = byRes.get(k) ?? [];
    list.push({
      effective_on: c.effective_on as string,
      from_amount: c.from_amount == null ? null : Number(c.from_amount),
      to_amount: c.to_amount == null ? null : Number(c.to_amount),
    });
    byRes.set(k, list);
  }
  return { byRes, error: null };
}
