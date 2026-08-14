"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange, toDaterange, type ParkSeason } from "@/lib/parks";
import {
  quoteAmenity, runWindow, daysIn,
  type Amenity, type AmenityUnit, type AmenityKind, type ChargeModel, type WhoMayBook,
} from "@/lib/amenities";
import type { ParkResult } from "./actions";

/**
 * THINGS THE PARK OWNS AND RENTS OUT — the owner's write path.
 *
 * The Haven comes with a boat for short-stay guests; the model is general
 * because a park also has a pavilion, a cart, kayaks, a slip. See 0119.
 *
 * THE FENCE, restated where somebody editing this will see it: if a crew gets
 * paid for it, it is not an amenity — that is a LakeLife service with a vendor,
 * a photo gate and a margin. Amenity money is the PARK'S money and never nets
 * against anything LakeLife bills.
 */

const DENIED = "You don't manage that park.";

export interface AmenityInput {
  id?: string;
  name: string;
  kind: string;
  chargeModel: string;
  dayRate: string;
  whoMayBook: string;
  maxDays: string;
  seasonOpen: string;   // "MM-DD" or ""
  seasonClose: string;
  rules: string;
}

export interface AmenityRow extends Amenity {
  units: AmenityUnit[];
  /** Live bookings and blackouts, for the calendar and the day sheet. */
  held: Array<{
    id: string; unitId: string; unitLabel: string;
    from: string; to: string; status: string;
    who: string | null; lotNumber: string | null;
    quotedAmount: number | null;
    /** Money actually taken against this booking. Derived, never stored. */
    collected: number;
  }>;
}

function splitMd(raw: string): { m: number | null; d: number | null } | null {
  const s = raw.trim();
  if (!s) return { m: null, d: null };
  const hit = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!hit) return null;
  const m = Number(hit[1]);
  const d = Number(hit[2]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { m, d };
}

/** Everything the amenities screen needs, park-scoped, in one read. */
export async function listAmenities(parkId: string): Promise<AmenityRow[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();

  const { data: rows } = await admin
    .from("park_amenities")
    .select("id, name, kind, charge_model, day_rate, who_may_book, max_days, season_open_month, season_open_day, season_close_month, season_close_day, rules, active")
    .eq("park_id", parkId)
    .order("name", { ascending: true });
  if (!rows?.length) return [];

  const ids = rows.map((a) => a.id as string);
  const [{ data: units }, { data: books }] = await Promise.all([
    admin.from("park_amenity_units")
      .select("id, amenity_id, label, active, sort_order")
      .in("amenity_id", ids).order("sort_order", { ascending: true }),
    admin.from("amenity_bookings")
      .select("id, unit_id, during, status, quoted_amount, renter_id, stay_id")
      .eq("park_id", parkId).neq("status", "cancelled"),
  ]);

  const unitById = new Map((units ?? []).map((u) => [u.id as string, u]));
  const bookingIds = (books ?? []).map((b) => b.id as string);
  const renterIds = [...new Set((books ?? []).map((b) => b.renter_id as string).filter(Boolean))];
  const stayIds = [...new Set((books ?? []).map((b) => b.stay_id as string).filter(Boolean))];

  // WHAT HAS ACTUALLY BEEN COLLECTED, derived from park_payments rather than
  // stored as a flag. A stored `paid` boolean and a payments table are two
  // places to be told the same thing, and they drift.
  const [{ data: names }, { data: stays }, { data: paid }] = await Promise.all([
    renterIds.length
      ? admin.from("park_renters").select("id, display_name").in("id", renterIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    stayIds.length
      ? admin.from("lot_reservations").select("id, park_lot_id").in("id", stayIds)
      : Promise.resolve({ data: [] as { id: string; park_lot_id: string }[] }),
    bookingIds.length
      ? admin.from("park_payments")
          .select("amenity_booking_id, amount, reversed_at").in("amenity_booking_id", bookingIds)
      : Promise.resolve({ data: [] as { amenity_booking_id: string; amount: number; reversed_at: string | null }[] }),
  ]);

  const nameById = new Map((names ?? []).map((r) => [r.id as string, r.display_name as string]));
  const lotIdByStay = new Map((stays ?? []).map((s) => [s.id as string, s.park_lot_id as string]));
  const lotIds = [...new Set([...lotIdByStay.values()])];
  const { data: lots } = lotIds.length
    ? await admin.from("park_lots").select("id, lot_number").in("id", lotIds)
    : { data: [] as { id: string; lot_number: string }[] };
  const lotNumberById = new Map((lots ?? []).map((l) => [l.id as string, l.lot_number as string]));

  const collectedByBooking = new Map<string, number>();
  for (const p of paid ?? []) {
    if (p.reversed_at) continue;   // a bounced payment is not money
    const k = p.amenity_booking_id as string;
    collectedByBooking.set(k, Math.round(((collectedByBooking.get(k) ?? 0) + Number(p.amount ?? 0)) * 100) / 100);
  }

  return rows.map((a): AmenityRow => {
    const mine = (units ?? []).filter((u) => u.amenity_id === a.id);
    const myUnitIds = new Set(mine.map((u) => u.id as string));
    return {
      id: a.id as string,
      name: a.name as string,
      kind: a.kind as AmenityKind,
      chargeModel: a.charge_model as ChargeModel,
      dayRate: a.day_rate == null ? null : Number(a.day_rate),
      whoMayBook: a.who_may_book as WhoMayBook,
      maxDays: a.max_days == null ? null : Number(a.max_days),
      season: {
        openMonth: a.season_open_month as number | null,
        openDay: a.season_open_day as number | null,
        closeMonth: a.season_close_month as number | null,
        closeDay: a.season_close_day as number | null,
      } as ParkSeason,
      rules: (a.rules as string) ?? null,
      active: Boolean(a.active),
      units: mine.map((u) => ({
        id: u.id as string, amenityId: u.amenity_id as string,
        label: u.label as string, active: Boolean(u.active),
      })),
      held: (books ?? [])
        .filter((b) => myUnitIds.has(b.unit_id as string))
        .map((b) => {
          const r = parseDaterange(b.during as string);
          const stayLot = b.stay_id ? lotIdByStay.get(b.stay_id as string) : null;
          return {
            id: b.id as string,
            unitId: b.unit_id as string,
            unitLabel: (unitById.get(b.unit_id as string)?.label as string) ?? "?",
            from: r?.start ?? "",
            to: r?.end ?? "",
            status: b.status as string,
            who: b.renter_id ? (nameById.get(b.renter_id as string) ?? null) : null,
            lotNumber: stayLot ? (lotNumberById.get(stayLot) ?? null) : null,
            quotedAmount: b.quoted_amount == null ? null : Number(b.quoted_amount),
            collected: collectedByBooking.get(b.id as string) ?? 0,
          };
        })
        .sort((x, y) => x.from.localeCompare(y.from)),
    };
  });
}

export async function saveAmenity(parkId: string, input: AmenityInput): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) {
    return { ok: false, error: "Give it a name a guest would recognise." };
  }
  if (!["boat", "watercraft", "vehicle", "space", "other"].includes(input.kind)) {
    return { ok: false, error: "Pick what sort of thing it is." };
  }
  if (!["guests", "residents", "both"].includes(input.whoMayBook)) {
    return { ok: false, error: "Say who's allowed to book it." };
  }

  // INCLUDED AND FREE ARE DIFFERENT FACTS. The database refuses a per-day
  // amenity with no rate and an included one that carries a number; this says
  // the same thing in English first.
  const charged = input.chargeModel === "per_day";
  if (!charged && input.chargeModel !== "included") {
    return { ok: false, error: "Say whether it's included or charged by the day." };
  }
  let dayRate: number | null = null;
  if (charged) {
    const n = Number(input.dayRate.trim().replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: "What does a day cost? Use 'included with the stay' if it's free." };
    }
    if (n > 100_000) return { ok: false, error: "That rate looks like a typo." };
    dayRate = Math.round(n * 100) / 100;
  }

  let maxDays: number | null = null;
  const rawMax = input.maxDays.trim();
  if (rawMax) {
    if (!/^\d+$/.test(rawMax)) return { ok: false, error: "The longest booking needs to be a whole number of days." };
    maxDays = Number(rawMax);
    if (maxDays < 1 || maxDays > 60) return { ok: false, error: "Pick between 1 and 60 days, or leave it blank for no limit." };
  }

  const open = splitMd(input.seasonOpen);
  const close = splitMd(input.seasonClose);
  if (!open || !close) return { ok: false, error: "The season dates should look like 05-01." };
  if ((open.m == null) !== (close.m == null)) {
    return { ok: false, error: "Give both season dates, or neither." };
  }

  const row = {
    park_id: parkId,
    name,
    kind: input.kind,
    charge_model: input.chargeModel,
    day_rate: dayRate,
    who_may_book: input.whoMayBook,
    max_days: maxDays,
    season_open_month: open.m, season_open_day: open.d,
    season_close_month: close.m, season_close_day: close.d,
    rules: input.rules.trim() || null,
  };

  const admin = createServiceClient();
  if (input.id) {
    const { error } = await admin.from("park_amenities")
      .update(row).eq("id", input.id).eq("park_id", parkId);
    if (error) {
      if (error.code === "23505") return { ok: false, error: "You already have one called that." };
      return { ok: false, error: `Couldn't save that — ${error.message}` };
    }
    revalidatePath("/park/amenities");
    revalidatePath("/park/today");
    return { ok: true, signal: `${name} saved.` };
  }

  const { data: made, error } = await admin.from("park_amenities")
    .insert(row).select("id").single();
  if (error || !made) {
    if (error?.code === "23505") return { ok: false, error: "You already have one called that." };
    return { ok: false, error: `Couldn't save that — ${error?.message ?? "try again"}` };
  }

  // ONE THING MEANS ONE UNIT, made for him. He should not have to learn the
  // word "unit" to rent out a boat — that only surfaces when he has four
  // kayaks and needs to say which one somebody has.
  await admin.from("park_amenity_units").insert({ amenity_id: made.id, label: name });

  revalidatePath("/park/amenities");
  revalidatePath("/park/today");
  return { ok: true, signal: `${name} added. It's off until you switch it on.` };
}

export async function setAmenityActive(
  parkId: string, amenityId: string, active: boolean,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();
  const { error } = await admin.from("park_amenities")
    .update({ active }).eq("id", amenityId).eq("park_id", parkId);
  if (error) return { ok: false, error: "Couldn't change that — try again." };
  revalidatePath("/park/amenities");
  revalidatePath("/park/today");
  return {
    ok: true,
    signal: active ? "On — guests can book it now." : "Off. Nothing already booked was cancelled.",
  };
}

export async function addAmenityUnit(
  parkId: string, amenityId: string, label: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const clean = label.trim();
  if (!clean || clean.length > 60) return { ok: false, error: "Give it a short name — 'Kayak 3 (green)'." };

  const admin = createServiceClient();
  // The amenity must be THIS park's. Without this check a browser could hang a
  // unit off another park's amenity, and every later read is park-scoped so it
  // would never show up here again.
  const { data: mine } = await admin.from("park_amenities")
    .select("id").eq("id", amenityId).eq("park_id", parkId).maybeSingle();
  if (!mine) return { ok: false, error: DENIED };

  const { error } = await admin.from("park_amenity_units")
    .insert({ amenity_id: amenityId, label: clean });
  if (error) {
    if (error.code === "23505") return { ok: false, error: "There's already one called that." };
    return { ok: false, error: "Couldn't add that — try again." };
  }
  revalidatePath("/park/amenities");
  return { ok: true, signal: `${clean} added.` };
}

/** Take days off the calendar for the park's own reasons. */
export async function blackoutDays(
  parkId: string, unitId: string, from: string, to: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { ok: false, error: "Pick the days to hold back." };
  }
  if (to <= from) return { ok: false, error: "The last day has to be after the first — use the next day as the end." };

  const admin = createServiceClient();
  const { data: unit } = await admin
    .from("park_amenity_units")
    .select("id, park_amenities!inner(park_id)")
    .eq("id", unitId).maybeSingle();
  const owner = (unit?.park_amenities as unknown as { park_id: string } | null)?.park_id;
  if (!unit || owner !== parkId) return { ok: false, error: DENIED };

  const { error } = await admin.from("amenity_bookings").insert({
    park_id: parkId, unit_id: unitId, during: toDaterange({ start: from, end: to }),
    status: "blackout",
  });
  if (error) {
    // 23P01 = the exclusion constraint. Somebody already has it — a real
    // answer, not a crash, and never a "try again" for a path that cannot work.
    if (error.code === "23P01") {
      return { ok: false, error: "Somebody already has it on one of those days. Cancel that first." };
    }
    return { ok: false, error: `Couldn't hold those days — ${error.message}` };
  }
  revalidatePath("/park/amenities");
  revalidatePath("/park/today");
  return { ok: true, signal: "Held back. Nobody can book those days." };
}

/**
 * THE OWNER BOOKING ON SOMEBODY'S BEHALF — the office phone, which is how most
 * of this will happen in the first season.
 */
export async function bookAmenityForStay(
  parkId: string, unitId: string, stayId: string, days: string[],
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const window = runWindow(days);
  if (!window) return { ok: false, error: "Pick at least one day." };

  const admin = createServiceClient();
  const { data: unit } = await admin
    .from("park_amenity_units")
    .select("id, amenity_id, park_amenities!inner(park_id, charge_model, day_rate, who_may_book, max_days, name, kind, rules, active, season_open_month, season_open_day, season_close_month, season_close_day)")
    .eq("id", unitId).maybeSingle();
  const am = unit?.park_amenities as unknown as {
    park_id: string; charge_model: string; day_rate: number | null;
    who_may_book: string; max_days: number | null; name: string;
  } | null;
  if (!unit || !am || am.park_id !== parkId) return { ok: false, error: DENIED };

  const { data: stay } = await admin
    .from("lot_reservations").select("id, renter_id").eq("id", stayId).maybeSingle();
  if (!stay) return { ok: false, error: "That stay is gone." };

  const quoted = quoteAmenity(
    {
      id: unit.amenity_id as string, name: am.name, kind: "other",
      chargeModel: am.charge_model as ChargeModel,
      dayRate: am.day_rate == null ? null : Number(am.day_rate),
      whoMayBook: am.who_may_book as WhoMayBook, maxDays: am.max_days,
      season: { openMonth: null, openDay: null, closeMonth: null, closeDay: null },
      rules: null, active: true,
    },
    daysIn(window).length,
  );
  if (quoted == null) {
    return { ok: false, error: `${am.name} has no price set. Set what a day costs first.` };
  }

  const { error } = await admin.from("amenity_bookings").insert({
    park_id: parkId,
    unit_id: unitId,
    stay_id: stayId,
    renter_id: stay.renter_id,
    during: toDaterange(window),
    quoted_amount: quoted,
    booked_by: user?.id ?? null,
  });
  if (error) {
    if (error.code === "23P01") {
      // True whether it was a race or he simply booked the same days twice —
      // "while you were typing" would be a confident guess about which.
      return { ok: false, error: "Somebody already has it on one of those days. Nothing was booked." };
    }
    // The containment trigger raises a plain sentence — outside their stay,
    // guests only, longer than the cap. Pass it through rather than replacing
    // it with a generic failure that says less than the database did.
    return { ok: false, error: error.message };
  }

  revalidatePath("/park/amenities");
  revalidatePath("/park/today");
  return {
    ok: true,
    signal: quoted > 0
      ? `Booked — $${quoted.toFixed(2)} to collect.`
      : "Booked. Included with their stay.",
  };
}

export async function cancelAmenityBooking(
  parkId: string, bookingId: string, reason: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const why = reason.trim() || "Cancelled by the office";

  const admin = createServiceClient();
  const { error } = await admin.from("amenity_bookings")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: why })
    .eq("id", bookingId).eq("park_id", parkId);
  if (error) return { ok: false, error: "Couldn't cancel that — try again." };

  revalidatePath("/park/amenities");
  revalidatePath("/park/today");
  // Cancelled rows drop out of the exclusion constraint's predicate, so the day
  // is free again with nothing else to do.
  return { ok: true, signal: "Cancelled. Those days are free again." };
}

/**
 * MONEY IN, AND IT IS THE PARK'S.
 *
 * Its own `kind` and its own foreign key (0119), never a charge_id: park_charges
 * is one row per household per month, and putting a boat day in it would refuse
 * that household's actual rent bill.
 */
export async function collectAmenityMoney(
  parkId: string, bookingId: string, amount: string, method: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const n = Number(amount.trim().replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "That amount isn't a number." };
  if (!["cash", "check", "card", "transfer", "other"].includes(method)) {
    return { ok: false, error: "How did they pay?" };
  }

  const admin = createServiceClient();
  const { data: booking } = await admin
    .from("amenity_bookings")
    .select("id, renter_id, status")
    .eq("id", bookingId).eq("park_id", parkId).maybeSingle();
  if (!booking) return { ok: false, error: DENIED };
  if (!booking.renter_id) return { ok: false, error: "There's nobody to take money from on that one." };
  if (booking.status === "cancelled") {
    return { ok: false, error: "That booking was cancelled — nothing to collect." };
  }

  const { error } = await admin.from("park_payments").insert({
    park_id: parkId,
    renter_id: booking.renter_id,
    amenity_booking_id: bookingId,
    amount: Math.round(n * 100) / 100,
    method,
    received_on: todayLakeDate(),
    kind: "amenity",
  });
  if (error) return { ok: false, error: `Couldn't record that — ${error.message}` };

  revalidatePath("/park/amenities");
  revalidatePath("/park/statements");
  return { ok: true, signal: `$${(Math.round(n * 100) / 100).toFixed(2)} recorded.` };
}

/** The stays a booking could hang off — for the office's own booking form. */
export async function staysOverlapping(
  parkId: string, from: string, to: string,
): Promise<Array<{ id: string; who: string; lotNumber: string; shortStay: boolean }>> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();

  const { data: lots } = await admin
    .from("park_lots").select("id, lot_number, rental_mode").eq("park_id", parkId);
  const lotIds = (lots ?? []).map((l) => l.id as string);
  if (!lotIds.length) return [];

  const { data: stays } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during")
    .in("park_lot_id", lotIds)
    .in("status", ["approved", "active"])
    .overlaps("during", toDaterange({ start: from, end: to }));
  if (!stays?.length) return [];

  const renterIds = [...new Set(stays.map((s) => s.renter_id as string).filter(Boolean))];
  const { data: names } = renterIds.length
    ? await admin.from("park_renters").select("id, display_name").in("id", renterIds)
    : { data: [] as { id: string; display_name: string }[] };
  const nameById = new Map((names ?? []).map((r) => [r.id as string, r.display_name as string]));
  const lotById = new Map((lots ?? []).map((l) => [l.id as string, l]));

  return stays.map((s) => {
    const lot = lotById.get(s.park_lot_id as string);
    return {
      id: s.id as string,
      who: nameById.get(s.renter_id as string) ?? "—",
      lotNumber: (lot?.lot_number as string) ?? "?",
      shortStay: (lot?.rental_mode as string) === "short_term",
    };
  }).sort((a, b) => a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true }));
}

/** Lake-time today, for a client component that must not use its own clock. */
export async function amenityToday(): Promise<string> {
  return todayLakeDate();
}
