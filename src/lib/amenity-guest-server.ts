import "server-only";
import { BEARER_TOKEN } from "@/lib/token-format";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange, toDaterange, type ParkSeason } from "@/lib/parks";
import {
  offerDays, quoteAmenity, priceLine, dayWindow,
  type Amenity, type AmenityUnit, type DayState,
  type AmenityKind, type ChargeModel, type WhoMayBook,
} from "@/lib/amenities";

/**
 * THE GUEST'S HALF, behind one unguessable link and no account.
 *
 * She is staying three nights. Asking her to sign up is how she ends up ringing
 * the office on a Saturday morning, which is the entire cost this exists to
 * remove. Her stay row is her identity — the same discipline as the extend-stay
 * and confirm-a-payment links.
 *
 * AUTHORITY COMES FROM THE TOKEN AND NOTHING ELSE. Every id the browser sends
 * is re-checked against the stay the token resolves to; nothing is trusted
 * because it arrived in a form. Decisions live in `lib/amenities.ts`; this
 * reads, writes, and never decides.
 */

export interface GuestOffer {
  amenityId: string;
  name: string;
  kind: AmenityKind;
  rules: string | null;
  price: string;
  /** Per unit, so "the pontoon is taken but kayak 2 is free" is sayable. */
  units: Array<{
    unitId: string;
    label: string;
    days: DayState[];
  }>;
}

export interface GuestView {
  stayId: string;
  parkName: string;
  lotNumber: string;
  firstName: string;
  from: string;
  to: string;
  offers: GuestOffer[];
  /** What she already has, so the page can say it back to her. */
  mine: Array<{ id: string; unit: string; from: string; to: string; amount: number | null }>;
  /** Non-null when there is nothing to show and we should say why. */
  nothing: string | null;
}

// 0125-era: the shape moved to token-format.ts so /use and /d cannot drift
// apart. Alias kept so the three call sites below read as they always did.
const TOKEN = BEARER_TOKEN;

/** A date a guest reads is "Saturday, August 15" — never "2026-08-15". */
function readable(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
}

export async function loadGuestView(token: string): Promise<GuestView | null> {
  if (!token || !TOKEN.test(token)) return null;
  const admin = createServiceClient();

  const { data: stay } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, status")
    .eq("use_token", token)
    .maybeSingle();
  if (!stay) return null;
  // A finished or cancelled stay is not a door. Say nothing about the park.
  if (!["approved", "active"].includes(stay.status as string)) return null;

  const window = parseDaterange(stay.during as string);
  if (!window) return null;

  const [{ data: lot }, { data: renter }] = await Promise.all([
    admin.from("park_lots")
      .select("id, lot_number, park_id, rental_mode").eq("id", stay.park_lot_id as string).maybeSingle(),
    admin.from("park_renters")
      .select("display_name").eq("id", stay.renter_id as string).maybeSingle(),
  ]);
  if (!lot) return null;

  const parkId = lot.park_id as string;
  const isShortStay = (lot.rental_mode as string) === "short_term";

  const [{ data: park }, { data: amenities }] = await Promise.all([
    admin.from("parks")
      .select("name, season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", parkId).maybeSingle(),
    admin.from("park_amenities")
      .select("id, name, kind, charge_model, day_rate, who_may_book, max_days, season_open_month, season_open_day, season_close_month, season_close_day, rules, active")
      .eq("park_id", parkId).eq("active", true).order("name", { ascending: true }),
  ]);

  const parkSeason: ParkSeason | null = park
    ? {
        openMonth: park.season_open_month as number | null,
        openDay: park.season_open_day as number | null,
        closeMonth: park.season_close_month as number | null,
        closeDay: park.season_close_day as number | null,
      }
    : null;

  const base = {
    stayId: stay.id as string,
    parkName: (park?.name as string) ?? "the park",
    lotNumber: (lot.lot_number as string) ?? "?",
    // First name only. A page reachable by anybody holding the link should not
    // print more of somebody's name than it has to.
    firstName: ((renter?.display_name as string) ?? "").split(/[\s,]+/)[0] || "there",
    from: window.start,
    to: window.end,
  };

  if (!amenities?.length) {
    return { ...base, offers: [], mine: [], nothing: "There's nothing to book here at the moment." };
  }

  const amenityIds = amenities.map((a) => a.id as string);
  const { data: units } = await admin
    .from("park_amenity_units")
    .select("id, amenity_id, label, active")
    .in("amenity_id", amenityIds).eq("active", true)
    .order("sort_order", { ascending: true });

  const unitIds = (units ?? []).map((u) => u.id as string);
  const { data: held } = unitIds.length
    ? await admin.from("amenity_bookings")
        .select("id, unit_id, during, status, stay_id, quoted_amount")
        .in("unit_id", unitIds).neq("status", "cancelled")
    : { data: [] as Array<Record<string, unknown>> };

  const heldWindows = (held ?? []).flatMap((h) => {
    const r = parseDaterange(h.during as string);
    return r ? [{
      unitId: h.unit_id as string, during: r,
      mine: h.stay_id === stay.id,
    }] : [];
  });

  const unitLabel = new Map((units ?? []).map((u) => [u.id as string, u.label as string]));
  const mine = (held ?? [])
    .filter((h) => h.stay_id === stay.id)
    .flatMap((h) => {
      const r = parseDaterange(h.during as string);
      return r ? [{
        id: h.id as string,
        unit: unitLabel.get(h.unit_id as string) ?? "—",
        from: r.start, to: r.end,
        amount: h.quoted_amount == null ? null : Number(h.quoted_amount),
      }] : [];
    })
    .sort((a, b) => a.from.localeCompare(b.from));

  const today = todayLakeDate();
  const offers: GuestOffer[] = amenities.map((a) => {
    const amenity: Amenity = {
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
      },
      rules: (a.rules as string) ?? null,
      active: Boolean(a.active),
    };

    return {
      amenityId: amenity.id,
      name: amenity.name,
      kind: amenity.kind,
      rules: amenity.rules,
      price: priceLine(amenity),
      units: (units ?? [])
        .filter((u) => u.amenity_id === a.id)
        .map((u) => {
          const unit: AmenityUnit = {
            id: u.id as string, amenityId: a.id as string,
            label: u.label as string, active: Boolean(u.active),
          };
          return {
            unitId: unit.id,
            label: unit.label,
            days: offerDays({
              amenity, unit, stay: window, held: heldWindows,
              today, parkSeason, isShortStay,
            }),
          };
        }),
    };
  });

  // NOTHING SHE MAY BOOK IS NOT THE SAME AS NOTHING EXISTING. A monthly
  // resident at a park whose only amenity is guests-only should be told which.
  const anyOpen = offers.some((o) => o.units.some((u) => u.days.some((d) => d.open)));
  const nothing = anyOpen
    ? null
    : offers.length === 0
      ? "There's nothing to book here at the moment."
      : null;   // the per-day sentences already say why

  return { ...base, offers, mine, nothing };
}

/**
 * TAKE ONE DAY.
 *
 * One day per tap on purpose: it is how a person thinks about a boat, and it
 * keeps the form a single button rather than a date picker on a phone at the
 * lake. The park's cap is counted across the whole stay by the database (0120),
 * so tapping four times cannot defeat a two-day limit.
 */
export async function bookDayByToken(
  token: string, unitId: string, day: string,
): Promise<{ ok: boolean; error?: string; signal?: string }> {
  if (!token || !TOKEN.test(token)) return { ok: false, error: "This link isn't right." };
  if (!/^[0-9a-f-]{36}$/i.test(unitId) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, error: "Something about that didn't look right. Try again from the link." };
  }

  const admin = createServiceClient();

  // RE-DERIVE EVERYTHING FROM THE TOKEN. The unit id arrived in a form; the
  // only thing that proves who is asking is the token in the URL.
  const view = await loadGuestView(token);
  if (!view) return { ok: false, error: "This link doesn't match a stay." };

  const offer = view.offers.find((o) => o.units.some((u) => u.unitId === unitId));
  const unit = offer?.units.find((u) => u.unitId === unitId);
  if (!offer || !unit) {
    return { ok: false, error: "That isn't something you can book here." };
  }

  const state = unit.days.find((d) => d.day === day);
  if (!state) return { ok: false, error: "That day isn't part of your stay." };
  if (!state.open) return { ok: false, error: state.why };

  const { data: stay } = await admin
    .from("lot_reservations")
    .select("id, renter_id, park_lot_id")
    .eq("use_token", token).maybeSingle();
  if (!stay) return { ok: false, error: "This link doesn't match a stay." };
  const { data: lot } = await admin
    .from("park_lots").select("park_id").eq("id", stay.park_lot_id as string).maybeSingle();
  if (!lot) return { ok: false, error: "This link doesn't match a stay." };

  const { data: am } = await admin
    .from("park_amenities")
    .select("charge_model, day_rate, name")
    .eq("id", offer.amenityId).maybeSingle();
  if (!am) return { ok: false, error: "That isn't available any more." };

  const quoted = quoteAmenity(
    {
      id: offer.amenityId, name: am.name as string, kind: "other",
      chargeModel: am.charge_model as ChargeModel,
      dayRate: am.day_rate == null ? null : Number(am.day_rate),
      whoMayBook: "both", maxDays: null,
      season: { openMonth: null, openDay: null, closeMonth: null, closeDay: null },
      rules: null, active: true,
    },
    1,
  );
  if (quoted == null) {
    return { ok: false, error: "That one has no price set — give the office a ring." };
  }

  const { error } = await admin.from("amenity_bookings").insert({
    park_id: lot.park_id,
    unit_id: unitId,
    stay_id: stay.id,
    renter_id: stay.renter_id,
    during: toDaterange(dayWindow(day)),
    quoted_amount: quoted,
    // She read the park's own rules above the button and tapped it.
    acknowledged_at: new Date().toISOString(),
    // NULL means she did it herself, which is the point of the whole page.
    booked_by: null,
  });

  if (error) {
    // 23P01 = the exclusion constraint. Somebody took it between the page
    // rendering and her tap — a real answer, and the page re-renders with fresh
    // days rather than offering a retry that would fail the same way.
    if (error.code === "23P01") {
      return { ok: false, error: "Somebody just took that day. Nothing was booked — the days below are up to date." };
    }
    // The trigger speaks plain sentences. Passing its own words through beats
    // replacing them with something that says less.
    return { ok: false, error: error.message };
  }

  return {
    ok: true,
    // NAMES THE UNIT. She is being handed a specific key, and a guest who
    // cannot say which one she has is a phone call to the office.
    signal: quoted > 0
      ? `${unit.label} is yours on ${readable(day)}. $${quoted.toFixed(2)}, payable at the office.`
      : `${unit.label} is yours on ${readable(day)}. It's included with your stay.`,
  };
}

/** Give a day back. Frees it for the next guest with nothing else to do. */
export async function cancelDayByToken(
  token: string, bookingId: string,
): Promise<{ ok: boolean; error?: string; signal?: string }> {
  if (!token || !TOKEN.test(token)) return { ok: false, error: "This link isn't right." };
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return { ok: false, error: "That didn't look right." };

  const admin = createServiceClient();
  const { data: stay } = await admin
    .from("lot_reservations").select("id").eq("use_token", token).maybeSingle();
  if (!stay) return { ok: false, error: "This link doesn't match a stay." };

  // Scoped to HER stay, so a token cannot cancel somebody else's day even if
  // the id is guessed.
  const { data: gone, error } = await admin
    .from("amenity_bookings")
    .update({
      status: "cancelled", cancelled_at: new Date().toISOString(),
      cancel_reason: "Given back by the guest",
    })
    .eq("id", bookingId).eq("stay_id", stay.id).eq("status", "booked")
    .select("id");
  if (error) return { ok: false, error: "Couldn't change that — give the office a ring." };
  if (!gone?.length) return { ok: false, error: "That one was already given back." };

  return { ok: true, signal: "Given back. Somebody else can have it now." };
}
