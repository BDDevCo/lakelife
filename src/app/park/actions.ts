"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { toDaterange, parseDaterange, type Lot, effectiveSeason } from "@/lib/parks";
import { todayLakeDate } from "@/lib/booking";
// Pure date maths, already used by the re-rate path — no need for a second copy.
import { addDays as addDaysISO } from "./rerate-helpers";
import {
  buildLotRow, buildParkProfileRow, buildRateRows, canApprove,
  decideProblemText, toStay,
  buildLotRange, planBulkRates, buildTenant, buildTenantEdit, buildParkDialsRow,
  type LotFormInput, type LotRangeInput, type ParkProfileInput, type RawReservation,
  type TenantInput, type TenantEditInput, type ParkDialsInput, lotLabelRange, SITE_DEFAULTS,
  buildOnlineRentRow, onlineRentCautions, CARD_FEE_CEILING, type OnlineRentInput,
} from "./park-helpers";
import { canEnableParkServices } from "./service-helpers";

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

/** The dials as they stand, plus what a new cap would collide with. */
export async function getParkDials(parkId: string): Promise<{
  initial: ParkDialsInput;
  longestStayDays: number | null;
  today: string;
} | null> {
  if (!(await assertMyPark(parkId))) return null;
  const admin = createServiceClient();

  const { data: p } = await admin
    .from("parks")
    .select("max_agreement_months, deposit_amount, rent_due_day, office_recording_lag_days, rent_notice_days, cutover_date")
    .eq("id", parkId)
    .maybeSingle();

  const { data: lots } = await admin
    .from("park_lots").select("id").eq("park_id", parkId);
  const lotIds = (lots ?? []).map((l) => l.id as string);

  let longestStayDays: number | null = null;
  if (lotIds.length) {
    const { data: stays } = await admin
      .from("lot_reservations")
      .select("during")
      .in("park_lot_id", lotIds)
      .in("status", ["approved", "active"]);
    for (const s of stays ?? []) {
      const r = parseDaterange(s.during as string);
      if (!r) continue;
      const days = Math.round(
        (Date.parse(`${r.end}T00:00:00Z`) - Date.parse(`${r.start}T00:00:00Z`)) / 86_400_000,
      );
      if (longestStayDays == null || days > longestStayDays) longestStayDays = days;
    }
  }

  const str = (v: unknown) => (v == null ? "" : String(v));
  return {
    initial: {
      maxAgreementMonths: str(p?.max_agreement_months),
      depositAmount: str(p?.deposit_amount),
      rentDueDay: str(p?.rent_due_day),
      officeRecordingLagDays: str(p?.office_recording_lag_days),
      rentNoticeDays: str(p?.rent_notice_days),
      cutoverOn: str(p?.cutover_date),
    },
    longestStayDays,
    today: todayLakeDate(),
  };
}

/**
 * HOW THIS PARK RUNS.
 *
 * These columns have been read by triggers and by every money screen since
 * 0061, and nothing has ever written them — so the owner's three-month rule
 * sat NULL and its trigger skipped, and the notice period sat on a 30-day
 * default he had already told us was 45.
 */
export async function saveParkDials(
  parkId: string,
  input: ParkDialsInput,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const built = buildParkDialsRow(input);
  if (!built.ok || !built.row) return { ok: false, error: built.error };

  const admin = createServiceClient();
  const { error } = await admin.from("parks").update(built.row).eq("id", parkId);
  if (error) return { ok: false, error: "Couldn't save that — try again." };

  const cap = built.row.max_agreement_months as number | null;
  revalidatePath("/park");
  revalidatePath("/park/setup");
  revalidatePath("/park/rent");
  return {
    ok: true,
    signal: cap
      ? `Saved. New agreements are capped at ${cap} ${cap === 1 ? "month" : "months"}.`
      : "Saved.",
  };
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
      .from("parks").select("slug, name, lake_id, lat, lng").eq("id", parkId).maybeSingle();

    // A PARK THE CREWS CANNOT BE SENT TO. `lake_id`, `lat` and `lng` had no
    // writer anywhere until parks could be created properly, so a park could
    // reach this gate looking complete and still be invisible to dispatch —
    // which decides who can serve a job by lake and by distance. That failure
    // is silent: no crew is offered the work and nobody is told why. Publishing
    // is the last moment it can be caught before a renter books something.
    if (!park?.lake_id) {
      return { ok: false, error: "Set the park's lake first — without it no crew can be dispatched here." };
    }
    if (park.lat == null || park.lng == null) {
      return { ok: false, error: "Set the park's map location first — routing needs it to reach you." };
    }

    if (!park?.slug) {
      const slug = await mintSlug(park?.name as string ?? "park", parkId);
      if (!slug) return { ok: false, error: "Couldn't create the park's web address — try a different name." };
    }
  }

  const { error } = await admin.from("parks").update({ active }).eq("id", parkId);
  if (error) return { ok: false, error: "Couldn't change that — try again." };

  revalidatePath("/park");
  // THE PARK'S OWN PUBLIC PAGE, by slug. `revalidatePath("/parks")` pointed at
  // a route that doesn't exist — there is no index page, only /parks/[slug] —
  // so publishing left the cached public page exactly as it was.
  const { data: published } = await admin
    .from("parks").select("slug").eq("id", parkId).maybeSingle();
  if (published?.slug) revalidatePath(`/parks/${published.slug}`);
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

  // The park's agreement cap shortens the tenancy we write. Without this the
  // silent 365-day range collides with 0062's cap trigger and every add fails
  // on a database error the moment the owner turns his rule on.
  const capAdmin = createServiceClient();
  const { data: capRow } = await capAdmin
    .from("parks").select("max_agreement_months").eq("id", parkId).maybeSingle();
  const cap = (capRow?.max_agreement_months as number | null) ?? null;

  const built = buildTenant(input, todayLakeDate(), cap);
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
    // WHEN THEY ACTUALLY ARRIVED, which is not when this agreement starts.
    // This path never recorded it at all, so a household who has lived here
    // since 2019 read as having moved in the day the office typed them in.
    tenancy_began_on: built.tenancy.beganOn,
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
    // A NO-OP IS NOT A SUCCESS. The `.eq("status","applied")` below makes a
    // stale tap change nothing — which is right — but this then reported
    // "Application declined." anyway. Two people in the office, or one with
    // two tabs, and the second is told they did something they did not do.
    const { data: done, error } = await admin
      .from("lot_reservations")
      .update({ status: "declined", decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("id", reservationId)
      .eq("status", "applied")
      .select("id");
    if (error) return { ok: false, error: "Couldn't record that — try again." };
    if (!done?.length) {
      return { ok: false, error: "Somebody already decided that one — refresh to see what happened." };
    }
    revalidatePath("/park");
    return { ok: true, signal: "Application declined." };
  }

  // Approving: re-read the lot and its other stays so the check is against the
  // CURRENT state, not what the page rendered a few minutes ago.
  const { data: lotRow } = await admin
    .from("park_lots")
    .select("id, lot_number, site_type, max_length_ft, amperage, has_water, has_sewer, slip_included, active, lifecycle, park_id, season_open_month, season_open_day, season_close_month, season_close_day")
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
      lifecycle: (lotRow.lifecycle as string) ?? "live",
    },
    season,
  );
  if (!check.ok) return { ok: false, error: decideProblemText(check.problem!) };

  const { data: approved, error } = await admin
    .from("lot_reservations")
    .update({ status: "approved", decided_by: user.id, decided_at: new Date().toISOString() })
    .eq("id", reservationId)
    .eq("status", "applied")
    .select("id");

  if (error) {
    // 23P01 = the exclusion constraint. Someone approved a conflicting stay
    // between our check and our write — the database won, which is correct.
    if (error.code === "23P01") {
      return { ok: false, error: "Someone just took those nights on that lot. Nothing was changed." };
    }
    return { ok: false, error: "Couldn't approve that — try again." };
  }
  // Same rule as the decline branch: changing no rows is not an approval, and
  // "the lot is held for those dates" would be a promise nothing is keeping.
  if (!approved?.length) {
    return { ok: false, error: "Somebody already decided that one — refresh to see what happened." };
  }

  revalidatePath("/park");
  return { ok: true, signal: "Approved. The lot is held for those dates." };
}

/** End a tenancy early, or close one out. Frees the dates for the next renter
 *  — the exclusion constraint only holds `approved` and `active` rows. */
export async function endTenancy(
  reservationId: string,
  reason: "ended" | "cancelled",
  /** The LAST DAY they lived there. Required for 'ended' — see below. */
  moveOutISO?: string | null,
): Promise<ParkResult> {
  if (!(await assertReservationIsMine(reservationId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const { data: stay } = await admin
    .from("lot_reservations")
    .select("id, during, status")
    .eq("id", reservationId)
    .maybeSingle();
  if (!stay) return { ok: false, error: "That tenancy isn't there any more." };
  if (stay.status !== "approved" && stay.status !== "active") {
    return { ok: false, error: "That one is already closed." };
  }

  // A CANCELLATION IS NOT A MOVE-OUT. Nobody ever lived there, so there is no
  // last day, nothing to prorate and nothing to bill. The range is left alone.
  if (reason === "cancelled") {
    const { data: done, error } = await admin
      .from("lot_reservations")
      .update({ status: "cancelled" })
      .eq("id", reservationId)
      .in("status", ["approved", "active"])
      .select("id");
    if (error) return { ok: false, error: "Couldn't update that — try again." };
    if (!done?.length) return { ok: false, error: "Somebody just changed that one." };
    revalidatePath("/park");
    return { ok: true, signal: "Reservation cancelled." };
  }

  // A MOVE-OUT IS A DATE, and this is the whole point of the change.
  //
  // This used to write `{ status }` alone. The range was never trimmed and the
  // charge run bills only approved/active, so a household leaving on the 20th
  // was either billed the whole month with no way back — voiding made the
  // month permanently unbillable, because an ended tenancy drops out of every
  // future run — or never billed for the twenty days, silently.
  const range = parseDaterange(stay.during as string);
  if (!range) return { ok: false, error: "That tenancy has no dates on it — call us." };

  const lastDay = (moveOutISO ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) {
    return { ok: false, error: "Pick the last day they lived there." };
  }
  if (lastDay < range.start) {
    return { ok: false, error: `They moved in on ${range.start} — the last day can't be before that.` };
  }

  // `during` is half-open: a last day of the 20th means the range ends on the
  // 21st. Storing the human date separately (moved_out_on) keeps every screen
  // out of that arithmetic.
  const newEnd = addDaysISO(lastDay, 1);

  const { data: done, error } = await admin
    .from("lot_reservations")
    .update({
      status: "ended",
      during: toDaterange({ start: range.start, end: newEnd }),
      moved_out_on: lastDay,
    })
    .eq("id", reservationId)
    .in("status", ["approved", "active"])   // one closer wins a double-tap
    .select("id");
  if (error) return { ok: false, error: `Couldn't close that out — ${error.message}` };
  if (!done?.length) return { ok: false, error: "Somebody just closed that one." };

  revalidatePath("/park");
  return {
    ok: true,
    signal: `Closed out — last day ${lastDay}. Their final month bills for the days they were here.`,
  };
}

/**
 * NOTICE TO VACATE — who is leaving, before the day it happens.
 *
 * Without it "who is leaving" could only be answered on the morning somebody
 * drove away. Two weeks of warning is the difference between showing a lot and
 * discovering a vacancy.
 *
 * Deliberately does NOT end the tenancy or touch the range: they still live
 * there, still owe rent, and may yet change their minds. The bill follows
 * `moved_out_on`, which is set when they actually go.
 */
export async function giveNotice(
  reservationId: string,
  expectedMoveOutISO: string,
  noticeGivenISO?: string,
): Promise<ParkResult> {
  if (!(await assertReservationIsMine(reservationId))) return { ok: false, error: DENIED };

  const leaving = (expectedMoveOutISO ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(leaving)) return { ok: false, error: "Pick the day they plan to leave." };
  const given = (noticeGivenISO ?? "").trim() || todayLakeDate();
  if (leaving < given) return { ok: false, error: "That day is before the notice — check the dates." };

  const admin = createServiceClient();
  const { data: done, error } = await admin
    .from("lot_reservations")
    .update({ notice_given_on: given, expected_move_out: leaving })
    .eq("id", reservationId)
    .in("status", ["approved", "active"])
    .select("id");
  if (error) return { ok: false, error: `Couldn't record that — ${error.message}` };
  if (!done?.length) return { ok: false, error: "That tenancy is already closed." };

  revalidatePath("/park");
  return { ok: true, signal: `Noted — they plan to leave on ${leaving}.` };
}

/** Take the notice back. People change their minds, and a stale one shows a lot as leaving. */
export async function clearNotice(reservationId: string): Promise<ParkResult> {
  if (!(await assertReservationIsMine(reservationId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();
  const { error } = await admin
    .from("lot_reservations")
    .update({ notice_given_on: null, expected_move_out: null })
    .eq("id", reservationId)
    .in("status", ["approved", "active"]);
  if (error) return { ok: false, error: "Couldn't clear that — try again." };
  revalidatePath("/park");
  return { ok: true, signal: "Notice cleared — they're staying." };
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

  // SPREAD, don't hand-pick. This used to be built field by field from
  // `display_name` and `confirmed_at` alone, so the email, mobile and contact
  // preference the builder now produces would have been computed, validated,
  // and then dropped on the floor — written by nothing, which is this
  // codebase's most common bug and the exact reason a household could never be
  // given a phone number.
  const { confirmed_at, ...rest } = built.renter;
  const renterPatch: Record<string, unknown> = { ...rest };
  if (confirmed_at) renterPatch.confirmed_at = new Date().toISOString();
  if (input.confirmedWithTenant) renterPatch.source = "tenant_confirmed";

  const { error: rErr } = await admin
    .from("park_renters")
    .update(renterPatch)
    .eq("id", res.renter_id as string);
  if (rErr) {
    // Say so rather than reporting a clean save. The money DID move.
    return {
      ok: false,
      error: "The rent saved, but their details didn't. Try those again.",
    };
  }

  revalidatePath("/park");
  return {
    ok: true,
    signal: input.confirmedWithTenant
      ? `Confirmed with ${built.renter.display_name}. That's confirmed with them now, not just on the old roll.`
      : "Saved.",
  };
}

// ------------------------------------------------------- lot lifecycle ----

/**
 * TAKE A LOT OUT OF SERVICE, OR PUT ONE BACK.
 *
 * `park_lots.lifecycle` has existed since 0065 with SEVEN readers and NO
 * WRITER, so every lot has been 'live' forever and none of it did anything:
 *
 *   'planned'    — a home being bought, a pad being cleared. Counted apart and
 *                  EXCLUDED from occupancy, which is the entire point: four
 *                  unbuilt homes would take a true 91% down to 77%, and that
 *                  number goes in front of a lender.
 *   'renovating' — same, but the work has started.
 *   'live'       — inventory. Billable, bookable, counted.
 *   'retired'    — gone for good: sold off, flooded, pulled. Keeps its history
 *                  and its ledger, and stops appearing as something to fill.
 *
 * RETIRING IS NOT DELETING. The lot's bills, payments and receipts stay exactly
 * where they are — 0072 makes deleting a lot with recorded money impossible
 * anyway, and a park that has taken money for a pad should never be able to
 * make that pad disappear.
 */
export async function setLotLifecycle(
  parkId: string,
  lotId: string,
  lifecycle: "planned" | "renovating" | "live" | "retired",
  expectedLiveOn?: string | null,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if ((await assertLotIsMine(lotId)) !== parkId) return { ok: false, error: DENIED };
  if (!["planned", "renovating", "live", "retired"].includes(lifecycle)) {
    return { ok: false, error: "That isn't a state a lot can be in." };
  }
  if (expectedLiveOn && !/^\d{4}-\d{2}-\d{2}$/.test(expectedLiveOn)) {
    return { ok: false, error: "That date doesn't look right." };
  }

  const admin = createServiceClient();
  const { data: lot } = await admin
    .from("park_lots").select("lot_number, lifecycle").eq("id", lotId).maybeSingle();
  if (!lot) return { ok: false, error: "That lot isn't here." };

  // TAKING A LOT OUT FROM UNDER SOMEBODY IS NOT A STATUS CHANGE. A lot with a
  // live tenancy is somebody's home; the guard in 0065 refuses new bookings on
  // a non-live lot, so quietly flipping this would strand the household —
  // billable but invisible to every screen that filters on 'live'.
  if (lifecycle !== "live") {
    const today = todayLakeDate();
    const { data: stays } = await admin
      .from("lot_reservations")
      .select("during, status")
      .eq("park_lot_id", lotId)
      .in("status", ["approved", "active"]);
    const held = (stays ?? []).some((s) => {
      const r = parseDaterange(s.during as string);
      return r != null && today < r.end;
    });
    if (held) {
      return {
        ok: false,
        error:
          `Somebody is on lot ${lot.lot_number}, or is booked onto it. End that ` +
          `first — taking the lot out from under a live tenancy would leave them ` +
          `billable but off every screen.`,
      };
    }
  }

  const row: Record<string, unknown> = { lifecycle };
  // A date only means something while the lot is still coming.
  if (lifecycle === "planned" || lifecycle === "renovating") {
    row.expected_live_on = expectedLiveOn || null;
  } else {
    row.expected_live_on = null;
  }

  const { error } = await admin.from("park_lots").update(row).eq("id", lotId);
  if (error) return { ok: false, error: "Couldn't change that — try again." };

  revalidatePath("/park");
  revalidatePath("/park/lots");
  revalidatePath("/park/today");

  const said: Record<string, string> = {
    planned: `Lot ${lot.lot_number} is planned — it's out of your occupancy until it's live.`,
    renovating: `Lot ${lot.lot_number} is being worked on — out of occupancy until it's live.`,
    live: `Lot ${lot.lot_number} is live — it counts and can be filled.`,
    retired: `Lot ${lot.lot_number} is retired. Its history and money stay put.`,
  };
  return { ok: true, signal: said[lifecycle] };
}

// ------------------------------------------------------ growing the park ----

/**
 * ADD LOTS AS THEY COME ONLINE.
 *
 * Brendon: "that should be apart of the park protal and park set up where I
 * can increase lots and add RV slots as they com online where the back end
 * should adjust accordingly for proper allocation of expenses."
 *
 * The back end already does. `allocateCost` counts rentable lots at the moment
 * of each split, and 0112 snapshots the denominator onto the cost — so a lot
 * added today changes every FUTURE split and rewrites no closed month. This is
 * the missing half: nothing could create a lot outside the importer, so a park
 * could only ever be as big as the seller's roll.
 *
 * NEW LOTS DEFAULT TO `planned`, NOT `live`. A pad that is poured but has no
 * pedestal is not rentable, and making it rentable is what moves everybody's
 * utility share — so that is a second, deliberate tap (`setLotLifecycle`)
 * rather than a side effect of typing a number.
 */
export async function addLots(
  parkId: string,
  input: {
    from: string;
    to?: string;
    siteType: string;
    /** True only when the pads are finished and rentable today. */
    liveNow?: boolean;
    rentalMode?: "long_term" | "short_term";
  },
): Promise<ParkResult & { created?: number; skipped?: string[] }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const { labels, error } = lotLabelRange(input.from, input.to ?? input.from);
  if (error) return { ok: false, error };
  if (labels.length === 0) return { ok: false, error: "Nothing to add." };

  const admin = createServiceClient();

  // Never renumber or overwrite an existing pad. A lot number is what a
  // resident, a crew and a utility all use to find the place.
  const { data: have } = await admin
    .from("park_lots").select("lot_number").eq("park_id", parkId);
  const existing = new Set((have ?? []).map((l) => String(l.lot_number).toLowerCase()));
  const fresh = labels.filter((l) => !existing.has(l.toLowerCase()));
  const skipped = labels.filter((l) => existing.has(l.toLowerCase()));
  if (fresh.length === 0) {
    return { ok: false, error: "Those lot numbers already exist.", skipped };
  }

  const defaults = SITE_DEFAULTS[input.siteType] ?? { hasWater: true, hasSewer: false };
  const { error: insErr, data: made } = await admin
    .from("park_lots")
    .insert(fresh.map((label) => ({
      park_id: parkId,
      lot_number: label,
      site_type: input.siteType,
      has_water: defaults.hasWater,
      has_sewer: defaults.hasSewer,
      rental_mode: input.rentalMode ?? "long_term",
      // See the header: rentable is a separate decision, because it is the one
      // that moves every household's share of a shared cost.
      lifecycle: input.liveNow ? "live" : "planned",
      active: Boolean(input.liveNow),
    })))
    .select("id");
  if (insErr) return { ok: false, error: `Couldn't add those — ${insErr.message}` };

  revalidatePath("/park/lots");
  revalidatePath("/park");
  const n = made?.length ?? fresh.length;
  return {
    ok: true,
    created: n,
    skipped,
    signal: input.liveNow
      ? `${n} ${n === 1 ? "lot" : "lots"} added and rentable — they now share the park's costs.`
      : `${n} ${n === 1 ? "lot" : "lots"} added as not-yet-built. Mark one live when its pedestal is in.`,
  };
}


// ------------------------------------------------ taking rent online ----

/**
 * WHETHER RESIDENTS CAN PAY RENT ONLINE, AND WHAT A CARD COSTS THEM.
 *
 * Read since 0108/0109 by `payRent` and the renter's portal; written by nothing
 * until now. `accepts_online_rent` defaults FALSE and `payRent` refuses when it
 * is false, so online rent has been off for every park with no way to turn it
 * on. The scratch fixture only ever worked because I set the flag in SQL by
 * hand — which is exactly how a column with no writer stays hidden: the demo
 * looks right.
 */
export async function getOnlineRent(parkId: string): Promise<{
  accepting: boolean;
  cardFeePct: string;
  ceiling: number;
  cautions: string[];
  canChange: boolean;
  /** Households with a CLAIMED portal account — the only ones who can pay. */
  households: number;
  /** On the roll but with no account yet, so the switch does nothing for them. */
  unclaimed: number;
} | null> {
  const membership = await assertMyPark(parkId);
  if (!membership) return null;

  const admin = createServiceClient();
  const { data: park } = await admin
    .from("parks")
    .select("accepts_online_rent, card_fee_pct")
    .eq("id", parkId)
    .maybeSingle();
  if (!park) return null;

  // WHO COULD ACTUALLY USE IT — not how many tenancies exist.
  //
  // Paying online needs a CLAIMED renter file: `payRent` matches
  // park_renters on `user_id = <signed-in user>`, and /portal only routes to
  // /parks/my for a file with one. Every tenancy the office keys in is created
  // UNCLAIMED, so counting tenancies told The Haven's owner "19 households can
  // use it" when the true answer was none of them.
  const { data: lots } = await admin.from("park_lots").select("id").eq("park_id", parkId);
  const lotIds = (lots ?? []).map((l) => l.id as string);
  let households = 0;
  let unclaimed = 0;
  if (lotIds.length) {
    const { data: stays } = await admin
      .from("lot_reservations")
      .select("renter_id")
      .in("park_lot_id", lotIds)
      .in("status", ["approved", "active"]);
    const renterIds = [...new Set((stays ?? []).map((r) => r.renter_id as string).filter(Boolean))];
    if (renterIds.length) {
      const { data: files } = await admin
        .from("park_renters")
        .select("id, user_id")
        .in("id", renterIds);
      households = (files ?? []).filter((f) => f.user_id != null).length;
      unclaimed = (files ?? []).length - households;
    }
  }

  const pct = Number(park.card_fee_pct ?? 0);
  return {
    accepting: Boolean(park.accepts_online_rent),
    // Trailing ".00" reads like a machine wrote it. 3 and 2.5 both survive.
    cardFeePct: pct === 0 ? "" : String(Number(pct.toFixed(2))),
    ceiling: CARD_FEE_CEILING,
    cautions: onlineRentCautions(pct),
    canChange: canEnableParkServices(membership.role),
    households,
    unclaimed,
  };
}

export async function saveOnlineRent(
  parkId: string,
  input: OnlineRentInput,
): Promise<ParkResult> {
  const membership = await assertMyPark(parkId);
  if (!membership) return { ok: false, error: DENIED };
  // A manager runs the park day to day. Deciding that residents' cards get
  // charged, and at what rate, is the owner's — the same line `setParkLive`
  // and the service desk draw.
  if (!canEnableParkServices(membership.role)) {
    return { ok: false, error: "Only the park's owner can change how rent is taken." };
  }

  const built = buildOnlineRentRow(input);
  if (!built.ok || !built.row) return { ok: false, error: built.error };

  const admin = createServiceClient();
  const { error } = await admin.from("parks").update(built.row).eq("id", parkId);
  if (error) {
    // 0116 refuses anything above 3% at the database, so a bad rate lands here
    // rather than being stored. Say which number was refused.
    return { ok: false, error: `Couldn't save that — ${error.message}` };
  }

  revalidatePath("/park/setup");
  revalidatePath("/park/rent");
  revalidatePath("/parks/my");

  const pct = built.row.card_fee_pct;
  if (!built.row.accepts_online_rent) {
    return { ok: true, signal: "Off. Residents pay you the way they do now — cash, check, or the office." };
  }
  return {
    ok: true,
    signal: pct > 0
      ? `On. Bank transfer is free; a card adds ${pct}%.`
      : "On. Bank transfer and card both, with no fee to the resident.",
  };
}
