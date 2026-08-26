"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, mustCount, readFailedMessage } from "@/lib/must-read";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { toDaterange } from "@/lib/parks";
import { buildTenant } from "./park-helpers";
import { planOnboarding, type OnboardRow } from "./onboard-helpers";
import type { ParkResult } from "./actions";

/**
 * THE FIRST AFTERNOON ON THE SYSTEM.
 *
 * However a park arrives — bought last week, or owned for thirty years — it
 * arrives with lots and rates and no tenancies, because a rent roll is a list
 * of lots and amounts and typically names nobody. This is the screen that puts
 * the households onto them.
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
  /** The monthly rate already recorded against the lot, if any. */
  suggestedRent: string;
}

/**
 * The empty live lots, with whatever rent is already on file.
 *
 * Pre-filling the rent is most of the speed here: he confirms numbers and types
 * names, rather than typing both. It is still HIS knowledge either way —
 * `amount_source` stays 'owner_knowledge' whether he accepts the roll's figure
 * or retypes it, because a sheet does not become true by being copied.
 */
export async function getOnboardSeeds(
  parkId: string,
): Promise<{
  ok: boolean;
  error?: string;
  seeds?: OnboardSeed[];
  today?: string;
  capMonths?: number | null;
  rentsFromImport?: boolean;
  /** Monthly fees a SIGNED household will also be charged, per lot. */
  feePerSignedLot?: number;
}> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const today = todayLakeDate();

  // An empty list here means "this park has no live lots" and the screen says
  // so. A failed read said the same thing to a park with seventy-nine of them.
  const lots = mustRead("your lots", await admin
    .from("park_lots")
    .select("id, lot_number")
    .eq("park_id", parkId)
    .eq("lifecycle", "live"));
  const lotIds = (lots ?? []).map((l) => l.id as string);
  if (lotIds.length === 0) return { ok: true, seeds: [], today };

  // Anything already held is not on offer — this screen only fills gaps.
  //
  // FAILS OPEN, AND THE GAP IT LEAVES IS THE WHOLE POINT OF THE SCREEN.
  // `taken ?? []` cannot tell a dropped read from a park where nobody lives, so
  // a failure offers every OCCUPIED lot as an empty row to fill in — which is
  // how one afternoon files a second household onto somebody's home.
  const taken = mustRead("who is already on your lots", await admin
    .from("lot_reservations")
    .select("park_lot_id")
    .in("park_lot_id", lotIds)
    .in("status", ["approved", "active"]));
  const takenIds = new Set((taken ?? []).map((r) => r.park_lot_id as string));

  // The pre-filled rent is a number he confirms rather than types. A failed
  // read blanks every one of them and reads as "no rent on file anywhere".
  const rates = mustRead("the rents already on your lots", await admin
    .from("lot_rates")
    .select("park_lot_id, amount")
    .in("park_lot_id", lotIds)
    .eq("term", "monthly"));
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

  // TWO FACTS THE SCREEN USED TO ASSUME.
  //
  // The cap: `max_agreement_months` is a per-park dial and is usually unset —
  // no park in the database has one today — yet three sentences asserted "your
  // three-month rule" to everybody.
  //
  // The import: the screen told every owner their rents "came off the sheet you
  // imported", including parks that never pasted a roll in. Both are now read
  // rather than assumed — and neither may be assumed by FAILING either, which
  // is what `?? null` and `(count ?? 0) > 0` quietly did: a dropped read put
  // the screen straight back on the two sentences this paragraph removed.
  const [parkRes, importRes, feeRes] = await Promise.all([
    admin.from("parks").select("max_agreement_months").eq("id", parkId).maybeSingle(),
    // Committed and not since undone. There is no `status` column here — the
    // batch's life is recorded as two timestamps.
    admin
      .from("park_import_batches")
      .select("id", { count: "exact", head: true })
      .eq("park_id", parkId)
      .not("committed_at", "is", null)
      .is("undone_at", null),
    // WHAT ELSE THE RUN WILL CHARGE THEM. The same filter the biller uses —
    // active, monthly, and an audience the charge run honours — so this screen
    // cannot quote a fee that will not bill, nor miss one that will.
    admin
      .from("park_fees")
      .select("amount, cadence, applies_to")
      .eq("park_id", parkId)
      .eq("active", true),
  ]);
  const parkRow = mustRead("your park's agreement cap", parkRes);
  const importCount = mustCount("whether you imported a rent roll", importRes);
  // A dropped read here would quote rent alone and understate the total he is
  // about to commit to, which is the whole reason the figure is on the screen.
  const feeRows = mustRead("the fees these households will also pay", feeRes);
  const feePerSignedLot = (feeRows ?? [])
    .filter((f) => (f.cadence as string) === "monthly")
    .filter((f) => ["all_lots", "long_term"].includes(f.applies_to as string))
    .reduce((sum, f) => sum + Number(f.amount), 0);

  return {
    ok: true,
    seeds,
    today,
    capMonths: (parkRow?.max_agreement_months as number | null) ?? null,
    rentsFromImport: importCount > 0,
    feePerSignedLot: Math.round(feePerSignedLot * 100) / 100,
  };
}

/**
 * File them.
 *
 * `signedNewLease` decides two things at once and they belong together:
 * `origin` (which the 0065 trigger reads to exempt a holdover from the
 * agreement cap) and the tenancy LENGTH (the cap when an agreement exists, the
 * rolling horizon when it does not). Passing the cap to `buildTenant` keeps them
 * consistent — the same function the one-at-a-time path uses, so validation
 * cannot drift between the two screens.
 */
export async function commitOnboarding(
  parkId: string,
  rows: OnboardRow[],
): Promise<ParkResult & { filed?: number; failed?: { lotNumber: string; why: string }[] }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const today = todayLakeDate();
  const plan = planOnboarding(rows, today);
  if (plan.toFile.length === 0) {
    return { ok: false, error: "Nothing filled in to file." };
  }

  const admin = createServiceClient();
  // Null means he HAS no cap, and the rolling horizon is written instead. A
  // failed read means we don't know his — and the silent rolling range against
  // a park that has one is refused by 0065, once per household, as nineteen
  // unexplained failures at the end of the afternoon. Same guard the
  // one-at-a-time path (`addTenant`) already makes.
  const parkRes = await admin
    .from("parks").select("max_agreement_months").eq("id", parkId).maybeSingle();
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park's agreement cap", parkRes.error) };
  }
  const parkCap = (parkRes.data?.max_agreement_months as number) ?? null;

  // Re-check what is already held, so a second submit cannot double-file.
  //
  // FAILS OPEN. `taken ?? []` on a dropped read holds nobody, so the check
  // below never fires and a second tap files the whole list again — a second
  // household written onto a lot somebody already lives on. The exclusion
  // constraint refuses only the rows whose DATES overlap; this is the guard
  // that refuses the rest.
  const takenRes = await admin
    .from("lot_reservations")
    .select("park_lot_id")
    .in("park_lot_id", plan.toFile.map((r) => r.lotId))
    .in("status", ["approved", "active"]);
  if (takenRes.error) {
    return { ok: false, error: readFailedMessage("who is already on your lots", takenRes.error) };
  }
  const takenIds = new Set((takenRes.data ?? []).map((r) => r.park_lot_id as string));

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
      // Signed means a real agreement exists on paper, so it is written under
      // the cap. Unsigned is a holdover on the rolling horizon, which the 0065
      // trigger exempts by origin — the two must move together or the write is
      // refused.
      r.signedNewLease ? parkCap : null,
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
      // WHERE THE NUMBER CAME FROM. The office's sheet is the owner's
      // knowledge, never the tenant's — it improves only when they confirm it.
      amount_source: "owner_knowledge",
      // The real arrival date, kept apart from the agreement window that
      // `buildTenant` now clamps forward. They are the same value only for a
      // household who moved in today.
      tenancy_began_on: built.tenancy.beganOn,
      origin: r.signedNewLease ? "application" : "grandfathered",
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
