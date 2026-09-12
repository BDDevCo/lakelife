"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage } from "@/lib/must-read";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { toDaterange, parseDaterange } from "@/lib/parks";
import { feesForTenancy } from "./fee-helpers";
import { planSigning, type SigningInput } from "./sign-helpers";
import type { SuccessorRow } from "@/lib/successor-row";
import type { ParkResult } from "./actions";

/**
 * RECORD THAT A HOLDOVER HOUSEHOLD SIGNED THE NEW LEASE.
 *
 * The one write path for the transition `sign-helpers.ts` describes. It is
 * three writes on two tables and they are NOT one transaction, so the order
 * and the error sentences are the whole design:
 *
 *   1. The renter file — email and phone, the condition of the lease. First,
 *      because a failure here changes nothing else and is the easiest to say.
 *   2. The holdover — trimmed to end on the signing day (or cancelled, if it
 *      never had a day). This has to come BEFORE the successor: the exclusion
 *      constraint refuses two held rows on one lot with overlapping dates, and
 *      the holdover runs a year out.
 *   3. The successor — the signed agreement. If THIS fails, the holdover is
 *      put back as it was, and the sentence says the household is still on the
 *      arrangement they had. Nothing bills differently until all three land.
 *
 * Never touches `origin` in place — the 0065 cap trigger fires on UPDATE and
 * would refuse it — and never creates a second renter file: the successor
 * carries the same `renter_id`, the same chain, one link on.
 */
export async function recordSigning(
  parkId: string,
  reservationId: string,
  input: SigningInput,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: "You don't manage that park." };

  const admin = createServiceClient();

  // THE ROW THE SUCCESSOR IS COPIED FROM — its lot, its renter, its chain, and
  // the facts that travel (due day, arrival date, provenance). A failed read
  // reaching the insert would file an agreement attached to nobody, so it
  // stops and says so.
  // ONE string literal on purpose: supabase-js types a concatenated select as
  // GenericStringError and every column below stops compiling.
  const priorRes = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, renter_unit_id, during, status, origin, term, quoted_amount, agreement_chain_id, agreement_seq, due_day, tenancy_began_on, amount_source, amount_source_at, park_lots(park_id, rental_mode)")
    .eq("id", reservationId)
    .maybeSingle();
  if (priorRes.error) {
    return { ok: false, error: readFailedMessage("that tenancy", priorRes.error, { money: true }) };
  }
  const prior = priorRes.data;
  if (!prior) return { ok: false, error: "That tenancy isn't there any more." };
  const lot = prior.park_lots as unknown as { park_id: string; rental_mode: string | null } | null;
  // Re-derived from the row, never trusted from the browser.
  if (!lot || lot.park_id !== parkId) return { ok: false, error: "You don't manage that park." };

  const [parkRes, feeRes] = await Promise.all([
    admin
      .from("parks")
      .select("cutover_date, default_agreement_months, max_agreement_months")
      .eq("id", parkId)
      .maybeSingle(),
    // WHAT THE FIRST MONTH BILLS. The same filter the biller uses — active,
    // monthly, an audience the run honours — so the sentence he reads cannot
    // quote a fee that will not bill, nor miss one that will.
    admin
      .from("park_fees")
      .select("amount, cadence, applies_to")
      .eq("park_id", parkId)
      .eq("active", true),
  ]);
  // The cutover bounds the date and the term sets the length. A failed read
  // would write the successor on the horizon against a park with a cap — the
  // database error 0065 exists to raise — or date it into the seller's months.
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park's settings", parkRes.error, { money: true }) };
  }
  if (feeRes.error) {
    return { ok: false, error: readFailedMessage("your park's fees", feeRes.error, { money: true }) };
  }
  const monthlyFees = (feeRes.data ?? [])
    .filter((f) => (f.cadence as string) === "monthly")
    .filter((f) => ["all_lots", "long_term"].includes(f.applies_to as string));
  const feePerMonth = feesForTenancy(monthlyFees, { rental_mode: lot.rental_mode }, { origin: "office" })
    .reduce((sum, f) => sum + Number(f.amount), 0);

  const plan = planSigning(
    input,
    {
      id: prior.id as string,
      park_lot_id: prior.park_lot_id as string,
      renter_id: prior.renter_id as string,
      renter_unit_id: (prior.renter_unit_id as string | null) ?? null,
      term: prior.term as string,
      quoted_amount: prior.quoted_amount == null ? null : Number(prior.quoted_amount),
      agreement_chain_id: (prior.agreement_chain_id as string | null) ?? null,
      agreement_seq: (prior.agreement_seq as number | null) ?? null,
      due_day: (prior.due_day as number | null) ?? null,
      tenancy_began_on: (prior.tenancy_began_on as string | null) ?? null,
      amount_source: (prior.amount_source as string | null) ?? null,
      amount_source_at: (prior.amount_source_at as string | null) ?? null,
      range: parseDaterange(prior.during as string),
      status: prior.status as string,
      origin: (prior.origin as string | null) ?? null,
    },
    {
      todayISO: todayLakeDate(),
      cutoverDate: (parkRes.data?.cutover_date as string | null) ?? null,
      defaultAgreementMonths: (parkRes.data?.default_agreement_months as number | null) ?? null,
      maxAgreementMonths: (parkRes.data?.max_agreement_months as number | null) ?? null,
      nowISO: new Date().toISOString(),
      feePerMonth: Math.round(feePerMonth * 100) / 100,
    },
  );
  if (!plan.ok) return { ok: false, error: plan.error };

  // ---- 1. the renter file ----------------------------------------------
  const { error: renterErr } = await admin
    .from("park_renters")
    .update(plan.renter)
    .eq("id", prior.renter_id as string);
  if (renterErr) {
    return {
      ok: false,
      error: "Couldn't save their email and phone, so nothing was recorded — they're still on the arrangement they had.",
    };
  }

  // ---- 2. the holdover ----------------------------------------------------
  const originalDuring = prior.during as string;
  const originalStatus = prior.status as string;
  const holdoverPatch = "cancel" in plan.holdover
    ? { status: "cancelled" }
    : { during: toDaterange(plan.holdover.trimTo) };
  const { data: held, error: holdErr } = await admin
    .from("lot_reservations")
    .update(holdoverPatch)
    .eq("id", prior.id as string)
    .in("status", ["approved", "active"])   // one recorder wins a double-tap
    .select("id");
  if (holdErr) {
    return {
      ok: false,
      error:
        "Their email and phone are saved, but the new agreement couldn't be written — " +
        "they're still on the arrangement they had, and nothing bills differently.",
    };
  }
  if (!held?.length) return { ok: false, error: "Somebody just changed that one — refresh to see what happened." };

  // ---- 3. the successor ---------------------------------------------------
  // Typed as the successor row on purpose: `origin` is a required key of it,
  // so this door cannot file by the column default (every-stay-names-its-
  // origin.test.ts checks both halves of that).
  const successor: SuccessorRow = plan.successor;
  const { error: insErr } = await admin.from("lot_reservations").insert(successor);
  if (insErr) {
    // PUT THE HOLDOVER BACK. Without this the household has been trimmed off
    // the lot on the signing day with nothing following — the lot reads
    // vacant, the charge run skips them, and the screen has reported a
    // failure that looks like nothing happened.
    const restore = "cancel" in plan.holdover
      ? { status: originalStatus }
      : { during: originalDuring };
    const { error: restoreErr } = await admin
      .from("lot_reservations")
      .update(restore)
      .eq("id", prior.id as string);
    if (restoreErr) {
      return {
        ok: false,
        error:
          "The new agreement couldn't be written, and their old arrangement couldn't be put back either — " +
          "so right now nothing holds their lot. That's ours to fix — get in touch and we'll sort it.",
      };
    }
    return {
      ok: false,
      error:
        "The new agreement couldn't be written, so their old arrangement was put back as it was. " +
        (insErr.code === "23P01"
          ? "Something else already holds that lot from that day — check the roll."
          : "Their email and phone are saved; nothing bills differently."),
    };
  }

  revalidatePath("/park");
  revalidatePath("/park/today");
  revalidatePath("/park/rent");
  // The fees screen — "this won't be charged to the N households you
  // inherited" — is rendered at /park/costs. There is no /park/fees route;
  // revalidating one left that count cached with the old number.
  revalidatePath("/park/costs");
  return { ok: true, signal: plan.signal };
}
