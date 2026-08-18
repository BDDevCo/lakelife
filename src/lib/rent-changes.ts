import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";

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
