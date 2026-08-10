"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { toDaterange, type Lot, effectiveSeason } from "@/lib/parks";
import { todayLakeDate } from "@/lib/booking";
import {
  buildLotRow, buildParkProfileRow, buildRateRows, canApprove,
  decideProblemText, toStay,
  buildLotRange, planBulkRates, buildTenant, buildTenantEdit,
  type LotFormInput, type LotRangeInput, type ParkProfileInput, type RawReservation,
  type TenantInput, type TenantEditInput,
} from "./park-helpers";

/**
 * The park owner's write path. Every action asserts membership of the park it
 * is about BEFORE it touches anything, and re-derives the park from the row
 * being edited rather than trusting a parkId from the browser.
 *
 * Phase 1 moves NO money. There is no charge, no invoice, no payout here, and
 * a rent amount never enters the job pipeline — see the header of migration
 * 0052 for what breaks if it ever does.
 */

export interface ParkResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

const DENIED = "You don't manage that park.";

/** Resolve the park that owns a lot, then assert membership. */
async function assertLotIsMine(lotId: string): Promise<string | null> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("park_lots").select("park_id").eq("id", lotId).maybeSingle();
  const parkId = (data?.park_id as string) ?? null;
  if (!parkId) return null;
  return (await assertMyPark(parkId)) ? parkId : null;
}

/** Resolve the park that owns a reservation, then assert membership. */
async function assertReservationIsMine(
  reservationId: string,
): Promise<{ parkId: string; lotId: string } | null> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("lot_reservations")
    .select("park_lot_id, park_lots(park_id)")
    .eq("id", reservationId)
    .maybeSingle();
  if (!data) return null;
  const lotId = data.park_lot_id as string;
  const parkId = (data.park_lots as unknown as { park_id: string } | null)?.park_id ?? null;
  if (!parkId) return null;
  return (await assertMyPark(parkId)) ? { parkId, lotId } : null;
}

// ------------------------------------------------------------- profile ----

export async function saveParkProfile(
  parkId: string,
  input: ParkProfileInput,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const built = buildParkProfileRow(input);
  if (!built.ok || !built.row) return { ok: false, error: built.error };

  const admin = createServiceClient();
  const { error } = await admin.from("parks").update(built.row).eq("id", parkId);
  if (error) return { ok: false, error: "Couldn't save that — try again." };

  revalidatePath("/park");
  revalidatePath("/park/setup");
  return { ok: true, signal: "Park profile saved." };
}

/**
 * The launch switch. An active park shows on the public page and can take
 * applications; a dark one is visible only to the people setting it up.
 * OWNER only — a manager runs the park day to day, but putting it in front of
 * the public is the owner's call.
 */
export async function setParkLive(parkId: string, active: boolean): Promise<ParkResult> {
  const membership = await assertMyPark(parkId);
  if (!membership) return { ok: false, error: DENIED };
  if (membership.role !== "owner") {
    return { ok: false, error: "Only the park owner can publish the park." };
  }

  const admin = createServiceClient();

  if (active) {
    // Refuse to publish an empty park. A public page with no lots is a dead
    // link that costs the owner a first impression they only get once.
    const { count } = await admin
      .from("park_lots")
      .select("id", { count: "exact", head: true })
      .eq("park_id", parkId)
      .eq("active", true);
    if (!count) {
      return { ok: false, error: "Add at least one lot before you publish the park." };
    }
    const { data: park } = await admin
      .from("parks").select("slug, name").eq("id", parkId).maybeSingle();
    if (!park?.slug) {
      const slug = await mintSlug(park?.name as string ?? "park", parkId);
      if (!slug) return { ok: false, error: "Couldn't create the park's web address — try a different name." };
    }
  }

  const { error } = await admin.from("parks").update({ active }).eq("id", parkId);
  if (error) return { ok: false, error: "Couldn't change that — try again." };

  revalidatePath("/park");
  revalidatePath("/parks");
  return {
    ok: true,
    signal: active ? "Your park is live. 🌊" : "Park unpublished — only you can see it now.",
  };
}

/** A URL-safe, unique slug for the public park page. Collisions get a suffix
 *  rather than an error the owner can do nothing about. */
async function mintSlug(name: string, parkId: string): Promise<string | null> {
  const admin = createServiceClient();
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)
    || "park";
  for (let i = 0; i < 25; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const { error } = await admin.from("parks").update({ slug }).eq("id", parkId);
    if (!error) return slug;
  }
  return null;
}

// ---------------------------------------------------------------- lots ----

export async function saveLot(
  parkId: string,
  lotId: string | null,
  input: LotFormInput,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (lotId && (await assertLotIsMine(lotId)) !== parkId) {
    return { ok: false, error: DENIED };
  }

  const built = buildLotRow(input);
  if (!built.ok || !built.row) return { ok: false, error: built.error };

  const admin = createServiceClient();
  const { error } = lotId
    ? await admin.from("park_lots").update(built.row).eq("id", lotId)
    : await admin.from("park_lots").insert({ ...built.row, park_id: parkId });

  if (error) {
    // 23505 = the (park_id, lot_number) unique index. Say what happened.
    if (error.code === "23505") {
      return { ok: false, error: `Lot ${built.row.lot_number} already exists in this park.` };
    }
    return { ok: false, error: "Couldn't save that lot — try again." };
  }

  revalidatePath("/park");
  revalidatePath("/park/lots");
  return { ok: true, signal: lotId ? "Lot updated." : `Lot ${built.row.lot_number} added.` };
}

/**
 * Make a whole park's worth of lots at once.
 *
 * This is the FIRST thing an owner does, and before it existed it was the
 * reason they never got to the second: park_lots is empty on closing morning,
 * the importer joins on lot_number, and adding lots one form at a time is five
 * interactions and a page refresh, seventy-nine times.
 *
 * Existing lot numbers are skipped rather than rejected, so re-running the same
 * range after hand-adding one lot quietly does the rest instead of failing on
 * the first collision and leaving the park half-built.
 */
export async function generateLots(
  parkId: string,
  input: LotRangeInput,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();

  // Read what is already there so collisions become a "skipped" line in the
  // confirmation rather than a unique-violation the owner cannot interpret.
  const { data: existing } = await admin
    .from("park_lots").select("lot_number").eq("park_id", parkId);
  const have = (existing ?? []).map((r) => r.lot_number as string);

  const built = buildLotRange(input, have);
  if (!built.ok || !built.rows) return { ok: false, error: built.error };

  const { error } = await admin
    .from("park_lots")
    .insert(built.rows.map((r) => ({ ...r, park_id: parkId })));
  if (error) {
    // A collision here means someone added a lot between our read and our
    // write. Say something true rather than leaking a constraint name.
    if (error.code === "23505") {
      return { ok: false, error: "Someone just added a lot with one of those numbers. Try again." };
    }
    return { ok: false, error: "Couldn't create those lots — try again." };
  }

  revalidatePath("/park");
  revalidatePath("/park/lots");

  const made = built.rows.length;
  const skipped = built.skipped?.length ?? 0;
  return {
    ok: true,
    signal:
      `${made} lot${made === 1 ? "" : "s"} added` +
      (skipped > 0 ? ` — ${skipped} already existed and were left alone.` : ". Edit any of them individually below."),
  };
}

/**
 * The park's rate card for one lot. Terms the owner left blank are DELETED,
 * which is how a park stops selling nightly — quoteStay then returns null for
 * that term instead of quietly falling back to another one.
 */
export async function saveLotRates(
  lotId: string,
  rates: Record<string, string>,
): Promise<ParkResult> {
  if (!(await assertLotIsMine(lotId))) return { ok: false, error: DENIED };

  const built = buildRateRows(rates);
  if (!built.ok || !built.rows) return { ok: false, error: built.error };

  const admin = createServiceClient();
  const keep = built.rows.map((r) => r.term);

  // Drop the terms that are no longer for sale...
  let del = admin.from("lot_rates").delete().eq("park_lot_id", lotId);
  if (keep.length > 0) del = del.not("term", "in", `(${keep.join(",")})`);
  await del;

  // ...then write the ones that are.
  if (built.rows.length > 0) {
    const { error } = await admin
      .from("lot_rates")
      .upsert(
        built.rows.map((r) => ({ park_lot_id: lotId, term: r.term, amount: r.amount })),
        { onConflict: "park_lot_id,term" },
      );
    if (error) return { ok: false, error: "Couldn't save those rates — try again." };
  }

  revalidatePath("/park/lots");
  return { ok: true, signal: "Rates saved." };
}

/**
 * Price a whole park in one action.
 *
 * Same problem as generateLots, one step later: without this, setting rates
 * means opening a panel per lot, seventy-nine times.
 *
 * FILLS BY DEFAULT, never overwrites. A bulk write that clobbers rates the
 * owner tuned lot by lot is unrecoverable — there is no undo on a rate card,
 * and the damage is silent until a renter is quoted the wrong number.
 * Replacing is a separate, deliberate tick.
 */
export async function setRatesForLots(
  parkId: string,
  rates: Record<string, string>,
  opts: { siteType?: string; tier?: string; replaceExisting?: boolean } = {},
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();

  const { data: lotRows } = await admin
    .from("park_lots").select("id, site_type, tier").eq("park_id", parkId);
  const lots = lotRows ?? [];
  if (lots.length === 0) return { ok: false, error: "Add some lots first." };

  const { data: rateRows } = await admin
    .from("lot_rates").select("park_lot_id, amount")
    .in("park_lot_id", lots.map((l) => l.id as string));

  // Only a PRICED rate counts as "already set" — a stored 0 is our own
  // representation of "not for sale", and treating it as priced would make
  // those lots permanently unreachable by the bulk tool.
  const priced = new Map<string, number>();
  for (const r of rateRows ?? []) {
    if (Number(r.amount) > 0) {
      priced.set(r.park_lot_id as string, (priced.get(r.park_lot_id as string) ?? 0) + 1);
    }
  }

  const plan = planBulkRates(
    lots.map((l) => ({
      lotId: l.id as string,
      siteType: l.site_type as string,
      tier: (l.tier as string | null) ?? "standard",
      existingRateCount: priced.get(l.id as string) ?? 0,
    })),
    rates,
    opts,
  );
  if (!plan.ok || !plan.lotIds || !plan.rows) return { ok: false, error: plan.error };

  // Replacing means the OLD card goes first — otherwise a lot that used to
  // sell nightly and now sells monthly would quietly sell both.
  if (opts.replaceExisting) {
    await admin.from("lot_rates").delete().in("park_lot_id", plan.lotIds);
  }

  const payload = plan.lotIds.flatMap((lotId) =>
    plan.rows!.map((r) => ({ park_lot_id: lotId, term: r.term, amount: r.amount })),
  );
  const { error } = await admin
    .from("lot_rates").upsert(payload, { onConflict: "park_lot_id,term" });
  if (error) return { ok: false, error: "Couldn't save those rates — try again." };

  revalidatePath("/park");
  revalidatePath("/park/lots");

  const n = plan.lotIds.length;
  const skipped = plan.skippedPriced ?? 0;
  return {
    ok: true,
    signal:
      `Rates set on ${n} lot${n === 1 ? "" : "s"}` +
      (skipped > 0 ? ` — ${skipped} already had their own and were left alone.` : "."),
  };
}

/**
 * Put the tenant who is ALREADY LIVING THERE onto a lot.
 *
 * This is the single most-used screen in year one and the one that decides
 * whether the product gets used at all: until the rent roll is right, the
 * owner keeps the notebook, and then none of the rest of this matters.
 *
 * The renter file is created UNCLAIMED (park_renters.user_id stays null). She
 * needs no account, no password and no app — and if she ever makes one, it
 * claims this file rather than starting a second one.
 */
export async function addTenant(
  parkId: string,
  lotId: string,
  input: TenantInput,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if ((await assertLotIsMine(lotId)) !== parkId) return { ok: false, error: DENIED };

  const built = buildTenant(input, todayLakeDate());
  if (!built.ok || !built.renter || !built.tenancy) {
    return { ok: false, error: built.error };
  }

  const admin = createServiceClient();

  const { data: renter, error: renterErr } = await admin
    .from("park_renters")
    .insert({ ...built.renter, park_id: parkId })
    .select("id")
    .single();
  if (renterErr || !renter) return { ok: false, error: "Couldn't save that tenant — try again." };

  const { error: resErr } = await admin.from("lot_reservations").insert({
    park_lot_id: lotId,
    renter_id: renter.id,
    during: toDaterange({ start: built.tenancy.start, end: built.tenancy.end }),
    term: built.tenancy.term,
    quoted_amount: built.tenancy.quoted_amount,
    // They are living there right now. `active` holds the dates, which is what
    // makes the lot read as occupied rather than vacant.
    status: "active",
  });

  if (resErr) {
    // Don't strand a renter file with no tenancy — she would show nowhere and
    // be re-created next time he tried.
    await admin.from("park_renters").delete().eq("id", renter.id);
    // 23P01 = the no-double-booking constraint. Somebody is already on this
    // lot for those dates, which is a real answer, not a crash.
    if (resErr.code === "23P01") {
      return {
        ok: false,
        error: "Someone is already recorded on that lot for those dates. Move them out first, or check the dates.",
      };
    }
    return { ok: false, error: "Couldn't put them on that lot — try again." };
  }

  revalidatePath("/park");
  return {
    ok: true,
    signal: `${built.renter.display_name} is on the roll.` +
      (built.renter.mobile_e164 ? " They'll get receipts and reminders by text." : ""),
  };
}

// -------------------------------------------------------- applications ----

/**
 * Approve or decline an application. The DATABASE is the real guard against
 * double-booking (the exclusion constraint in 0052); canApprove exists so the
 * owner reads "Lot 12 is already taken those nights" instead of a constraint
 * violation, and so two managers deciding at once get a clean answer rather
 * than a 500.
 *
 * NOT a screening decision. The platform records what a human decided and
 * never produces, scores, or suggests one — see the FCRA note in the design
 * doc.
 */
export async function decideApplication(
  reservationId: string,
  decision: "approve" | "decline",
): Promise<ParkResult> {
  const scope = await assertReservationIsMine(reservationId);
  if (!scope) return { ok: false, error: DENIED };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: DENIED };

  const admin = createServiceClient();

  const { data: appRow } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, renter_unit_id, during, term, quoted_amount, status, decided_at, created_at")
    .eq("id", reservationId)
    .maybeSingle();
  if (!appRow) return { ok: false, error: "That application is gone." };

  const application = toStay(appRow as unknown as RawReservation);

  if (decision === "decline") {
    const { error } = await admin
      .from("lot_reservations")
      .update({ status: "declined", decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("id", reservationId)
      .eq("status", "applied"); // no-op if someone already decided it
    if (error) return { ok: false, error: "Couldn't record that — try again." };
    revalidatePath("/park");
    return { ok: true, signal: "Application declined." };
  }

  // Approving: re-read the lot and its other stays so the check is against the
  // CURRENT state, not what the page rendered a few minutes ago.
  const { data: lotRow } = await admin
    .from("park_lots")
    .select("id, lot_number, site_type, max_length_ft, amperage, has_water, has_sewer, slip_included, active, park_id, season_open_month, season_open_day, season_close_month, season_close_day")
    .eq("id", scope.lotId)
    .maybeSingle();
  if (!lotRow) return { ok: false, error: "That lot is gone." };

  const { data: others } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, renter_unit_id, during, term, quoted_amount, status, decided_at, created_at")
    .eq("park_lot_id", scope.lotId);

  // The lot's own window, else the park's. Without this a boat slip approves
  // happily for a week in January.
  const { data: parkRow } = await admin
    .from("parks")
    .select("season_open_month, season_open_day, season_close_month, season_close_day")
    .eq("id", lotRow.park_id as string)
    .maybeSingle();

  const season = effectiveSeason(
    {
      openMonth:  (lotRow.season_open_month  as number | null) ?? null,
      openDay:    (lotRow.season_open_day    as number | null) ?? null,
      closeMonth: (lotRow.season_close_month as number | null) ?? null,
      closeDay:   (lotRow.season_close_day   as number | null) ?? null,
    },
    {
      openMonth:  (parkRow?.season_open_month  as number | null) ?? null,
      openDay:    (parkRow?.season_open_day    as number | null) ?? null,
      closeMonth: (parkRow?.season_close_month as number | null) ?? null,
      closeDay:   (parkRow?.season_close_day   as number | null) ?? null,
    },
  );

  const check = canApprove(
    application,
    (others ?? []).map((r) => toStay(r as unknown as RawReservation)),
    {
      id: lotRow.id as string,
      lotNumber: lotRow.lot_number as string,
      siteType: lotRow.site_type as Lot["siteType"],
      maxLengthFt: (lotRow.max_length_ft as number | null) ?? null,
      amperage: (lotRow.amperage as number | null) ?? null,
      hasWater: !!lotRow.has_water,
      hasSewer: !!lotRow.has_sewer,
      slipIncluded: !!lotRow.slip_included,
      active: !!lotRow.active,
    },
    season,
  );
  if (!check.ok) return { ok: false, error: decideProblemText(check.problem!) };

  const { error } = await admin
    .from("lot_reservations")
    .update({ status: "approved", decided_by: user.id, decided_at: new Date().toISOString() })
    .eq("id", reservationId)
    .eq("status", "applied");

  if (error) {
    // 23P01 = the exclusion constraint. Someone approved a conflicting stay
    // between our check and our write — the database won, which is correct.
    if (error.code === "23P01") {
      return { ok: false, error: "Someone just took those nights on that lot. Nothing was changed." };
    }
    return { ok: false, error: "Couldn't approve that — try again." };
  }

  revalidatePath("/park");
  return { ok: true, signal: "Approved. The lot is held for those dates." };
}

/** End a tenancy early, or close one out. Frees the dates for the next renter
 *  — the exclusion constraint only holds `approved` and `active` rows. */
export async function endTenancy(reservationId: string, reason: "ended" | "cancelled"): Promise<ParkResult> {
  if (!(await assertReservationIsMine(reservationId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const { error } = await admin
    .from("lot_reservations")
    .update({ status: reason })
    .eq("id", reservationId)
    .in("status", ["approved", "active"]);
  if (error) return { ok: false, error: "Couldn't update that — try again." };

  revalidatePath("/park");
  return { ok: true, signal: reason === "ended" ? "Tenancy closed out." : "Reservation cancelled." };
}

/**
 * Correct a tenant already on the roll — the typo, the rent, the due day, and
 * the one that matters: whether he has actually confirmed this with the person
 * standing in front of him.
 *
 * Writes to two tables and they are NOT symmetric. The name lives on the
 * renter file; the money lives on the tenancy. A failure on the second must
 * not silently leave the first applied and report success.
 */
export async function editTenancy(
  reservationId: string,
  input: TenantEditInput,
): Promise<ParkResult> {
  const scope = await assertReservationIsMine(reservationId);
  if (!scope) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const { data: res } = await admin
    .from("lot_reservations")
    .select("id, renter_id, quoted_amount, due_day, status")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) return { ok: false, error: "That tenancy is gone." };

  const built = buildTenantEdit(
    input,
    {
      rent: res.quoted_amount == null ? null : Number(res.quoted_amount),
      dueDay: (res.due_day as number | null) ?? null,
    },
    todayLakeDate(),
  );
  if (!built.ok || !built.renter || !built.tenancy) {
    return { ok: false, error: built.error };
  }

  // The money first. If this fails we have changed nothing, which is the state
  // that is easiest to explain and easiest to retry.
  const tenancyPatch: Record<string, unknown> = {
    quoted_amount: built.tenancy.quoted_amount,
    due_day: built.tenancy.due_day,
  };
  if (built.tenancy.amount_source) {
    tenancyPatch.amount_source = built.tenancy.amount_source;
    tenancyPatch.amount_source_at = new Date().toISOString();
  }

  const { error: tErr } = await admin
    .from("lot_reservations")
    .update(tenancyPatch)
    .eq("id", reservationId);
  if (tErr) return { ok: false, error: "Couldn't save that — try again." };

  const renterPatch: Record<string, unknown> = { display_name: built.renter.display_name };
  if (built.renter.confirmed_at) renterPatch.confirmed_at = new Date().toISOString();
  if (input.confirmedWithTenant) renterPatch.source = "tenant_confirmed";

  const { error: rErr } = await admin
    .from("park_renters")
    .update(renterPatch)
    .eq("id", res.renter_id as string);
  if (rErr) {
    // Say so rather than reporting a clean save. The money DID move.
    return {
      ok: false,
      error: "The rent saved, but the name didn't. Try the name again.",
    };
  }

  revalidatePath("/park");
  return {
    ok: true,
    signal: input.confirmedWithTenant
      ? `Confirmed with ${built.renter.display_name}. That's off the seller's roll now.`
      : "Saved.",
  };
}
