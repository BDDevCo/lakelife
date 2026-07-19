"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getFullProfile, toPricingProfile } from "@/app/profile/data";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { dayStatus, toISODate, todayLakeDate } from "@/lib/booking";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";

interface ServiceRow extends ServiceRule {
  is_water_work: boolean;
  daily_capacity: number;
  frequency_options: string[];
}

async function loadService(serviceId: string): Promise<ServiceRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("services")
    .select("id, name, pricing_model, base, unit_rate, band_pricing, is_water_work, daily_capacity, frequency_options")
    .eq("id", serviceId)
    .maybeSingle();
  return (data as ServiceRow | null) ?? null;
}

/** Season window (ice-out → pull deadline) for the SPECIFIC property being booked. */
async function loadSeason(propertyId: string): Promise<{ start: string | null; end: string | null }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("properties")
    .select("lakes(ice_out_actual, pull_deadline)")
    .eq("id", propertyId)
    .maybeSingle();
  const lake = Array.isArray(data?.lakes) ? data?.lakes[0] : data?.lakes;
  return {
    start: (lake as { ice_out_actual?: string })?.ice_out_actual ?? null,
    end: (lake as { pull_deadline?: string })?.pull_deadline ?? null,
  };
}

/** Count jobs per date for a service across a month (service role — capacity is shared). */
export async function getAvailability(
  serviceId: string,
  year: number,
  month: number, // 0-indexed
): Promise<{ fullDates: string[]; capacity: number }> {
  const service = await loadService(serviceId);
  if (!service) return { fullDates: [], capacity: 0 };

  const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const toDate = new Date(year, month + 1, 0);
  const to = toISODate(toDate);

  const admin = createServiceClient();
  const { data } = await admin
    .from("jobs")
    .select("date")
    .eq("service_id", serviceId)
    .in("status", ["requested", "scheduled", "in_progress"])
    .gte("date", from)
    .lte("date", to);

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const d = row.date as string;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const fullDates = [...counts.entries()]
    .filter(([, n]) => n >= service.daily_capacity)
    .map(([d]) => d);

  return { fullDates, capacity: service.daily_capacity };
}

export interface BookingResult {
  ok: boolean;
  error?: string;
  needsVerification?: boolean;
}

/**
 * Confirm a booking. Enforces rule 5 (verified email + SMS-verified mobile
 * before first booking), re-prices server-side (never trusts a client price),
 * re-validates the season window + capacity against the property's OWN lake,
 * then creates a `requested` job and fires the booking-confirmed text + email.
 * The insert runs with the service role — direct owner inserts into jobs are
 * closed at the RLS layer, so this action is the only door, and it validates.
 */
export async function createBooking(
  serviceId: string,
  date: string, // YYYY-MM-DD
  frequency: string,
): Promise<BookingResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // RULE 5: working email AND SMS-verified mobile before any booking.
  const { data: me } = await supabase
    .from("users")
    .select("email_verified, phone_verified, phone, email")
    .eq("id", user.id)
    .maybeSingle();
  const emailOk = (me?.email_verified ?? false) || Boolean(user.email_confirmed_at);
  const phoneOk = me?.phone_verified ?? false;
  if (!emailOk || !phoneOk) {
    return {
      ok: false,
      needsVerification: true,
      error: !phoneOk
        ? "One quick step first: verify your mobile so crews can reach you — it takes 30 seconds."
        : "One quick step first: confirm your email, then you're ready to book.",
    };
  }

  const profile = await getFullProfile();
  if (!profile?.hasProfile || !profile.propertyId) {
    return { ok: false, error: "Set up your property first." };
  }
  const service = await loadService(serviceId);
  if (!service) return { ok: false, error: "That service isn't available." };

  // Re-validate the day server-side, against THIS property's lake and Indiana time.
  const season = await loadSeason(profile.propertyId);
  const { fullDates } = await getAvailability(serviceId, Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1);
  const status = dayStatus(date, {
    today: todayLakeDate(),
    isWaterWork: service.is_water_work,
    seasonStart: season.start,
    seasonEnd: season.end,
    fullDates: new Set(fullDates),
  });
  if (status !== "available") {
    const why =
      status === "past" ? "That date has passed." :
      status === "off-season" ? "That date is outside this lake's water-work season." :
      "That day's crew is full — pick another.";
    return { ok: false, error: why };
  }

  // Price it here — the client's number is never trusted.
  const price = priceService(service, toPricingProfile(profile));

  const admin = createServiceClient();
  const { data: inserted, error } = await admin
    .from("jobs")
    .insert({
      property_id: profile.propertyId,
      service_id: serviceId,
      date,
      frequency,
      status: "requested",
      customer_price: price,
    })
    .select("id")
    .single();
  if (error || !inserted) return { ok: false, error: error?.message ?? "Could not book that." };

  // Capacity double-check: if a simultaneous booking pushed the day over the
  // crew's limit, back ours out rather than overbook a crew.
  const { count } = await admin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("service_id", serviceId)
    .eq("date", date)
    .in("status", ["requested", "scheduled", "in_progress"]);
  if ((count ?? 0) > service.daily_capacity) {
    await admin.from("jobs").delete().eq("id", inserted.id);
    return { ok: false, error: "That day just filled up — pick another date." };
  }

  // Notifications — best effort, never block the booking.
  const pretty = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
  if (me?.phone) {
    void sendSms(me.phone, `LakeLife: ${service.name} is booked for ${pretty}. We'll text you when a crew is on the way. 🌊`);
  }
  if (me?.email) {
    void sendEmail({
      to: me.email,
      subject: `Booked: ${service.name} 🌊`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#20343d">
          <h2>You're booked, ${profile.address ?? "friend"}.</h2>
          <p><b>${service.name}</b> — ${frequency}<br>${pretty}</p>
          <p style="color:#5D7681">Your price: <b>$${price.toLocaleString()}</b>. You're only charged after the service is completed and photos are uploaded.</p>
        </div>`,
    });
  }

  return { ok: true };
}
