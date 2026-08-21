import "server-only";
import { isBearerToken } from "@/lib/token-format";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage } from "@/lib/must-read";
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
  mine: Array<{
    id: string; unit: string; from: string; to: string;
    amount: number | null;
    /**
     * What the office has already taken for this day. The total on her page
     * summed `amount` alone, so a day she had ALREADY PAID FOR still counted
     * toward "to pay at the office" — sending her back to the window with a
     * number bigger than she owes. Money lives in `park_payments` keyed by
     * `amenity_booking_id`; the booking's own status never changes when it is
     * paid (0119 allows only booked/cancelled/blackout), so the booking row
     * alone can never answer this.
     */
    paid: number;
  }>;
  /** Non-null when there is nothing to show and we should say why. */
  nothing: string | null;
}

// The shape lives in token-format.ts so /use and /d cannot drift apart. The
// bare-regex alias that used to sit here is gone on purpose: once BEARER_TOKEN
// was widened to 20 so the QR sticker could use it, `BEARER_TOKEN.test()` no
// longer meant what this file needs. `isBearerToken` defaults to 32, so the
// guest link keeps the floor it always had — and gets it from one place.

/** A date a guest reads is "Saturday, August 15" — never "2026-08-15". */
function readable(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
}

export async function loadGuestView(token: string): Promise<GuestView | null> {
  if (!isBearerToken(token)) return null;
  const admin = createServiceClient();

  // `return null` renders "this link doesn't match a stay" to a guest standing
  // at the park. Only true when the lookup ran.
  const stay = mustRead("your stay", await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, status")
    .eq("use_token", token)
    .maybeSingle());
  if (!stay) return null;
  // A finished or cancelled stay is not a door. Say nothing about the park.
  if (!["approved", "active"].includes(stay.status as string)) return null;

  const window = parseDaterange(stay.during as string);
  if (!window) return null;

  const [lotRes, renterRes] = await Promise.all([
    admin.from("park_lots")
      .select("id, lot_number, park_id, rental_mode").eq("id", stay.park_lot_id as string).maybeSingle(),
    admin.from("park_renters")
      .select("display_name").eq("id", stay.renter_id as string).maybeSingle(),
  ]);
  const lot = mustRead("your lot", lotRes);
  const renter = mustRead("your name", renterRes);
  if (!lot) return null;

  const parkId = lot.park_id as string;
  const isShortStay = (lot.rental_mode as string) === "short_term";

  const [parkRes, amenitiesRes] = await Promise.all([
    admin.from("parks")
      .select("name, season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", parkId).maybeSingle(),
    admin.from("park_amenities")
      .select("id, name, kind, charge_model, day_rate, who_may_book, max_days, season_open_month, season_open_day, season_close_month, season_close_day, rules, active")
      .eq("park_id", parkId).eq("active", true).order("name", { ascending: true }),
  ]);
  // A failed `parks` read drops parkSeason to null, which stops the season
  // check running at all — the boat would be offered in January. A failed
  // `park_amenities` read prints "There's nothing to book here at the moment"
  // at a park with a pontoon and four kayaks.
  const park = mustRead("the park", parkRes);
  const amenities = mustRead("what the park rents out", amenitiesRes);

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
  const units = mustRead("the park's kayaks and boats", await admin
    .from("park_amenity_units")
    .select("id, amenity_id, label, active")
    .in("amenity_id", amenityIds).eq("active", true)
    .order("sort_order", { ascending: true }));

  const unitIds = (units ?? []).map((u) => u.id as string);
  // FAILS OPEN IF LEFT ALONE. Nothing held reads as everything free, so every
  // day of every unit would render bookable — and two guests get handed the
  // same pontoon on the same Saturday. The exclusion constraint would refuse
  // the second insert, but only after she has been told it is hers.
  const held = mustRead("what's already taken", unitIds.length
    ? await admin.from("amenity_bookings")
        .select("id, unit_id, during, status, stay_id, quoted_amount")
        .in("unit_id", unitIds).neq("status", "cancelled")
    : { data: [] as Array<Record<string, unknown>>, error: null });

  const heldWindows = (held ?? []).flatMap((h) => {
    const r = parseDaterange(h.during as string);
    return r ? [{
      unitId: h.unit_id as string, during: r,
      mine: h.stay_id === stay.id,
    }] : [];
  });

  const unitLabel = new Map((units ?? []).map((u) => [u.id as string, u.label as string]));

  // WHAT SHE HAS ALREADY SETTLED, so the total is what she still owes.
  // Scoped to her own bookings' ids and nothing else. A failed read here would
  // silently re-bill her for days she has paid for, which is the one direction
  // this number must never be wrong in.
  const myBookingIds = (held ?? [])
    .filter((h) => h.stay_id === stay.id)
    .map((h) => h.id as string);
  const paidRows = myBookingIds.length
    ? mustRead(
        "what you've already settled",
        await admin
          .from("park_payments")
          .select("amenity_booking_id, amount, reversed_at")
          .in("amenity_booking_id", myBookingIds),
      )
    : [];
  const paidByBooking = new Map<string, number>();
  for (const p of paidRows ?? []) {
    // A reversed payment is money that came back — it is owed again.
    if (p.reversed_at != null) continue;
    const k = p.amenity_booking_id as string;
    paidByBooking.set(k, (paidByBooking.get(k) ?? 0) + Number(p.amount ?? 0));
  }

  const mine = (held ?? [])
    .filter((h) => h.stay_id === stay.id)
    .flatMap((h) => {
      const r = parseDaterange(h.during as string);
      return r ? [{
        id: h.id as string,
        unit: unitLabel.get(h.unit_id as string) ?? "—",
        from: r.start, to: r.end,
        amount: h.quoted_amount == null ? null : Number(h.quoted_amount),
        paid: paidByBooking.get(h.id as string) ?? 0,
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
  if (!isBearerToken(token)) return { ok: false, error: "This link isn't right." };
  if (!/^[0-9a-f-]{36}$/i.test(unitId) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, error: "Something about that didn't look right. Try again from the link." };
  }

  const admin = createServiceClient();

  // RE-DERIVE EVERYTHING FROM THE TOKEN. The unit id arrived in a form; the
  // only thing that proves who is asking is the token in the URL.
  //
  // The loader THROWS on a failed read; a button awaiting { ok, error } can't,
  // so it is turned back into a sentence here rather than becoming "this link
  // doesn't match a stay".
  let view: GuestView | null;
  try {
    view = await loadGuestView(token);
  } catch (e) {
    return { ok: false, error: readFailedMessage("what's free", e, { money: true }) };
  }
  if (!view) return { ok: false, error: "This link doesn't match a stay." };

  const offer = view.offers.find((o) => o.units.some((u) => u.unitId === unitId));
  const unit = offer?.units.find((u) => u.unitId === unitId);
  if (!offer || !unit) {
    return { ok: false, error: "That isn't something you can book here." };
  }

  const state = unit.days.find((d) => d.day === day);
  if (!state) return { ok: false, error: "That day isn't part of your stay." };
  // ALREADY HERS IS NOT A REFUSAL.
  //
  // A slow connection at the lake means she taps "Take it" twice. The second
  // POST finds the day closed — closed by her OWN booking — and answered with
  // ok:false, which the page paints in the amber failure box. The sentence
  // shown after successfully booking a boat looked like the booking had been
  // rejected, and the honest next move from there is to ring the office about
  // a day she is already holding.
  //
  // Idempotent: the same tap twice reports the same true thing.
  if (!state.open) {
    if (state.mine) {
      return { ok: true, signal: `${unit.label} is already yours on ${readable(day)}. Nothing else to do.` };
    }
    return { ok: false, error: state.why };
  }

  const stayRes = await admin
    .from("lot_reservations")
    .select("id, renter_id, park_lot_id")
    .eq("use_token", token).maybeSingle();
  if (stayRes.error) return { ok: false, error: readFailedMessage("your stay", stayRes.error, { money: true }) };
  const stay = stayRes.data;
  if (!stay) return { ok: false, error: "This link doesn't match a stay." };
  const lotRes = await admin
    .from("park_lots").select("park_id").eq("id", stay.park_lot_id as string).maybeSingle();
  if (lotRes.error) return { ok: false, error: readFailedMessage("your lot", lotRes.error, { money: true }) };
  const lot = lotRes.data;
  if (!lot) return { ok: false, error: "This link doesn't match a stay." };

  // This read sets the PRICE. "That isn't available any more" on a failed read
  // is the wrong answer, and quoting off a half-read row would be worse.
  const amRes = await admin
    .from("park_amenities")
    .select("charge_model, day_rate, name")
    .eq("id", offer.amenityId).maybeSingle();
  if (amRes.error) return { ok: false, error: readFailedMessage("the price", amRes.error, { money: true }) };
  const am = amRes.data;
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
    // WHAT SHE TICKED, AND THE WORDS SHE TICKED IT ON.
    //
    // `acknowledged_at` alone records THAT she agreed and cannot say what to —
    // park_amenities.rules is live, and the day the owner tightens the
    // life-jacket line, every past acknowledgement re-points at wording nobody
    // was shown. The same row already snapshots `quoted_amount` for exactly
    // this reason; the words are the part somebody would actually argue about,
    // and they are not even LakeLife's words to stand behind.
    //
    // `offer.rules` is the value THIS request rendered — bookDayByToken and the
    // page both come from loadGuestView — so the sentence in the record is by
    // construction the sentence on her screen (0133's rule, applied to a
    // column instead of a constant).
    //
    // BOTH OR NEITHER. The page prints the rules only `if (o.rules)`, so an
    // amenity with none showed her a bare button; stamping "she ticked the
    // rules" there asserts she agreed to nothing at all. 0138 makes the
    // database refuse the mismatched pair either way round.
    acknowledged_at: offer.rules ? new Date().toISOString() : null,
    rules_text: offer.rules ?? null,
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
  if (!isBearerToken(token)) return { ok: false, error: "This link isn't right." };
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return { ok: false, error: "That didn't look right." };

  const admin = createServiceClient();
  const stayRes = await admin
    .from("lot_reservations").select("id").eq("use_token", token).maybeSingle();
  if (stayRes.error) return { ok: false, error: readFailedMessage("your stay", stayRes.error) };
  const stay = stayRes.data;
  if (!stay) return { ok: false, error: "This link doesn't match a stay." };

  // A DAY THAT HAS STARTED IS NOT HERS TO GIVE BACK.
  //
  // This had no date condition at all — only `status = 'booked'`. So she could
  // take the boat out at nine, bring it back at six, and tap "give it back" on
  // the way to the car. The owner's screen reads `.neq("status","cancelled")`,
  // so the booking AND the money quoted against it left his view together. A
  // day on the water, billed to nobody, with nothing anywhere saying it
  // happened.
  //
  // Giving back tomorrow is still one tap — that is the whole point of the
  // feature, and it puts the day back on the board for somebody else. Today
  // and anything past it is the office's call, because only a person can know
  // whether she actually went out.
  const bookRes = await admin
    .from("amenity_bookings")
    .select("id, during")
    .eq("id", bookingId).eq("stay_id", stay.id).eq("status", "booked")
    .maybeSingle();
  if (bookRes.error) return { ok: false, error: readFailedMessage("that day", bookRes.error) };
  if (!bookRes.data) return { ok: false, error: "That one was already given back." };

  const when = parseDaterange(bookRes.data.during as string);
  const today = todayLakeDate();
  if (when && when.start <= today) {
    return {
      ok: false,
      error:
        "That day has already started, so it's not one you can give back here. " +
        "If you didn't take it out, ring the office and they'll sort it.",
    };
  }

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
