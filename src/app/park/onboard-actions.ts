"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { toDaterange } from "@/lib/parks";
import { buildTenant } from "./park-helpers";
import { planOnboarding, type OnboardRow } from "./onboard-helpers";
import type { ParkResult } from "./actions";

/**
 * THE FIRST AFTERNOON AFTER CLOSING.
 *
 * The importer wrote the lots and the rate cards off the seller's sheet and no
 * tenancies at all, because that sheet names nobody. This is the screen that
 * puts the nineteen households onto them.
 *
 * IT WRITES ROW BY ROW, NOT AS ONE BATCH. Eighteen good rows must not be lost
 * to one bad one — and at nineteen households a failed all-or-nothing save is a
 * whole afternoon retyped.
 *
 * IT NEVER OVERWRITES. A lot that already has somebody on it is not offered,
 * so running this twice cannot double-file a household or quietly replace one.
 */

const DENIED = "You don't manage that park.";

export interface OnboardSeed {
  lotId: string;
  lotNumber: string;
  /** The monthly rate the importer took off the seller's roll. */
  suggestedRent: string;
}

/**
 * The empty live lots, with whatever rent is already on file.
 *
 * Pre-filling the rent is most of the speed here: he confirms numbers and types
 * names, rather than typing both. It is still HIS knowledge either way —
 * `amount_source` stays 'owner_knowledge' whether he accepts the roll's figure
 * or retypes it, because a seller's sheet does not become true by being copied.
 */
export async function getOnboardSeeds(
  parkId: string,
): Promise<{ ok: boolean; error?: string; seeds?: OnboardSeed[]; today?: string }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const today = todayLakeDate();

  const { data: lots } = await admin
    .from("park_lots")
    .select("id, lot_number")
    .eq("park_id", parkId)
    .eq("lifecycle", "live");
  const lotIds = (lots ?? []).map((l) => l.id as string);
  if (lotIds.length === 0) return { ok: true, seeds: [], today };

  // Anything already held is not on offer — this screen only fills gaps.
  const { data: taken } = await admin
    .from("lot_reservations")
    .select("park_lot_id")
    .in("park_lot_id", lotIds)
    .in("status", ["approved", "active"]);
  const takenIds = new Set((taken ?? []).map((r) => r.park_lot_id as string));

  const { data: rates } = await admin
    .from("lot_rates")
    .select("park_lot_id, amount")
    .in("park_lot_id", lotIds)
    .eq("term", "monthly");
  const rateByLot = new Map((rates ?? []).map((r) => [r.park_lot_id as string, Number(r.amount)]));

  const seeds = (lots ?? [])
    .filter((l) => !takenIds.has(l.id as string))
    .map((l) => ({
      lotId: l.id as string,
      lotNumber: l.lot_number as string,
      suggestedRent: rateByLot.has(l.id as string)
        ? String(rateByLot.get(l.id as string))
        : "",
    }))
    .sort((a, b) => a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true }));

  return { ok: true, seeds, today };
}

/**
 * File them.
 *
 * `grandfathered` decides two things at once, and they belong together:
 * `origin` (which the 0065 trigger reads to exempt inherited tenancies from the
 * agreement cap) and the tenancy LENGTH (the cap when it applies, the rolling
 * horizon when it does not). Passing the cap to `buildTenant` is what keeps
 * those two consistent — the same function the one-at-a-time path uses, so the
 * validation cannot drift between the two screens.
 */
export async function commitOnboarding(
  parkId: string,
  rows: OnboardRow[],
  grandfathered: boolean,
): Promise<ParkResult & { filed?: number; failed?: { lotNumber: string; why: string }[] }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const today = todayLakeDate();
  const plan = planOnboarding(rows, today);
  if (plan.toFile.length === 0) {
    return { ok: false, error: "Nothing filled in to file." };
  }

  const admin = createServiceClient();
  const { data: park } = await admin
    .from("parks").select("max_agreement_months").eq("id", parkId).maybeSingle();
  // Inherited tenancies never agreed to a cap, so they are written on the
  // rolling horizon and the trigger exempts them by origin.
  const cap = grandfathered ? null : ((park?.max_agreement_months as number) ?? null);

  // Re-check what is already held, so a second submit cannot double-file.
  const { data: taken } = await admin
    .from("lot_reservations")
    .select("park_lot_id")
    .in("park_lot_id", plan.toFile.map((r) => r.lotId))
    .in("status", ["approved", "active"]);
  const takenIds = new Set((taken ?? []).map((r) => r.park_lot_id as string));

  let filed = 0;
  const failed: { lotNumber: string; why: string }[] = [];

  for (const r of plan.toFile) {
    if (takenIds.has(r.lotId)) {
      failed.push({ lotNumber: r.lotNumber, why: "Somebody is already on that lot." });
      continue;
    }

    const built = buildTenant(
      {
        displayName: r.displayName,
        movedInOn: r.movedInOn,
        term: "monthly",
        rent: r.rent == null ? "" : String(r.rent),
        mobile: "",
        email: "",
        source: "owner_knowledge",
      },
      today,
      cap,
    );
    if (!built.ok || !built.renter || !built.tenancy) {
      failed.push({ lotNumber: r.lotNumber, why: built.error ?? "Couldn't file that one." });
      continue;
    }

    const { data: renter, error: renterErr } = await admin
      .from("park_renters")
      .insert({ ...built.renter, park_id: parkId })
      .select("id")
      .single();
    if (renterErr || !renter) {
      failed.push({ lotNumber: r.lotNumber, why: "Couldn't save that household." });
      continue;
    }

    const { error: stayErr } = await admin.from("lot_reservations").insert({
      park_lot_id: r.lotId,
      renter_id: renter.id,
      during: toDaterange({ start: built.tenancy.start, end: built.tenancy.end }),
      status: "active",
      term: "monthly",
      quoted_amount: built.tenancy.quoted_amount,
      // WHERE THE NUMBER CAME FROM. Michael's sheet is the owner's knowledge,
      // never the tenant's — it improves only when the household confirms it.
      amount_source: "owner_knowledge",
      tenancy_began_on: r.movedInOn,
      origin: grandfathered ? "grandfathered" : "application",
    });
    if (stayErr) {
      // The renter file survives on purpose — he can put them on a lot by hand
      // rather than retyping the person.
      failed.push({
        lotNumber: r.lotNumber,
        why: "Saved the household but couldn't put them on the lot — check the dates.",
      });
      continue;
    }
    filed += 1;
  }

  revalidatePath("/park");
  revalidatePath("/park/today");
  revalidatePath("/park/rent");

  if (filed === 0) {
    return { ok: false, error: "None of those could be filed.", failed };
  }
  return {
    ok: true,
    filed,
    failed,
    signal:
      `${filed} ${filed === 1 ? "household" : "households"} filed` +
      (failed.length ? `, ${failed.length} couldn't be` : "") +
      (plan.skipped ? `. ${plan.skipped} still to do.` : "."),
  };
}
