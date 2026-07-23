"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getFullProfile, toPricingProfile, getActivePropertyId } from "@/app/profile/data";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { dayStatus, toISODate, todayLakeDate } from "@/lib/booking";
import { rushPrice, validRushFallback } from "@/lib/rush";
import { getPlatformSettings } from "@/lib/settings";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { autoAssignJob, getServiceAvailability } from "./dispatch";
import { ensureTos } from "@/lib/tos-server";

/** Current hour (0–23) in lake time — the rush-window clock. */
function lakeHour(): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Indiana/Indianapolis", hour12: false, hour: "2-digit" }).format(new Date());
  return Number(h) % 24;
}

interface ServiceRow extends ServiceRule {
  is_water_work: boolean;
  daily_capacity: number;
  frequency_options: string[];
}

async function loadService(serviceId: string): Promise<ServiceRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("services")
    .select("id, name, pricing_model, base, unit_rate, band_pricing, is_water_work, daily_capacity, frequency_options, kind, active")
    .eq("id", serviceId)
    .eq("active", true)
    .eq("kind", "standalone") // components/add-ons book only inside packages
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

/**
 * Calendar availability for a service in a month — now CAPACITY-AWARE: a date is
 * "full" only when no eligible crew has an open slot that day (real per-crew
 * capacity via the dispatch engine), not the old service-level count. Keeps the
 * same { fullDates, capacity } shape the calendar consumes.
 */
export interface RushWindow {
  nowHour: number; // current lake-time hour (server truth — client TZ lies)
  cutoffHour: number; // same_day_cutoff_hour dial
  surchargePct: number; // same_day_surcharge_pct dial (for display pricing)
}

export async function getAvailability(
  serviceId: string,
  year: number,
  month: number, // 0-indexed
  propertyId?: string, // defaults to the active property; used to scope by lake
): Promise<{ fullDates: string[]; capacity: number; findingCrew: boolean; rush: RushWindow }> {
  const settings = await getPlatformSettings();
  const rush: RushWindow = { nowHour: lakeHour(), cutoffHour: settings.sameDayCutoffHour, surchargePct: settings.sameDaySurchargePct };
  const service = await loadService(serviceId);
  if (!service) return { fullDates: [], capacity: 0, findingCrew: false, rush };
  // Scope capacity to crews that service THIS property's lake (Phase B): a date
  // is only bookable if a crew who works this lake has an open slot.
  const pid = propertyId ?? (await getActivePropertyId());
  let lakeId: string | null = null;
  if (pid) {
    const admin = createServiceClient();
    const { data } = await admin.from("properties").select("lake_id").eq("id", pid).maybeSingle();
    lakeId = (data?.lake_id as string) ?? null;
  }
  const avail = await getServiceAvailability(service.name, year, month, lakeId);
  return { ...avail, rush };
}

export interface BookingResult {
  ok: boolean;
  error?: string;
  needsVerification?: boolean;
  /** First service request: show the scroll-and-agree, retry with tosAccepted. */
  needsTos?: boolean;
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
  rushFallback?: string, // same-day only: 'roll' (tomorrow at standard price) | 'cancel'
  tosAccepted?: boolean, // set by the agree modal's retry — stamps and proceeds
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

  // THE AGREEMENT, at the moment of service: one quick scroll-and-agree the
  // first time, stamped forever (until a version bump), then the booking
  // pushes straight through on the retry.
  if ((await ensureTos(user.id, tosAccepted)) === "needs") {
    return { ok: false, needsTos: true };
  }

  const profile = await getFullProfile();
  if (!profile?.hasProfile || !profile.propertyId) {
    return { ok: false, error: "Set up your property first." };
  }
  const service = await loadService(serviceId);
  if (!service) return { ok: false, error: "That service isn't available." };

  // Re-validate the day server-side, against THIS property's lake and Indiana time.
  const settings = await getPlatformSettings();
  const season = await loadSeason(profile.propertyId);
  const { fullDates } = await getAvailability(serviceId, Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, profile.propertyId);
  const status = dayStatus(date, {
    today: todayLakeDate(),
    isWaterWork: service.is_water_work,
    seasonStart: season.start,
    seasonEnd: season.end,
    fullDates: new Set(fullDates),
    rushNowHour: lakeHour(),
    rushCutoffHour: settings.sameDayCutoffHour,
  });
  if (status !== "available" && status !== "rush") {
    const why =
      status === "past" ? "That date has passed." :
      status === "off-season" ? "That date is outside this lake's water-work season." :
      "That day's crew is full — pick another.";
    return { ok: false, error: why };
  }
  const isRush = status === "rush";

  // Price it here — the client's number is never trusted. Rush pays the
  // premium; the crew side gets its fill-in discount at claim time.
  const standardPrice = priceService(service, toPricingProfile(profile));
  // SIM-FOUND (Wave 1): a $0 price means the profile has none of what this
  // service counts (0 PWC lifts booking a PWC pull). A $0 job can never
  // assign and sits as phantom "demand" — refuse with the honest fix.
  if (standardPrice <= 0) {
    return { ok: false, error: `${service.name} prices to $0 for your place — your profile shows none of the equipment it covers. Update your property profile and the real price appears.` };
  }
  const price = isRush ? rushPrice(standardPrice, settings.sameDaySurchargePct) : standardPrice;

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
      ...(isRush ? { is_rush: true, rush_fallback: validRushFallback(rushFallback) } : {}),
    })
    .select("id")
    .single();
  if (error || !inserted) return { ok: false, error: error?.message ?? "Could not book that." };

  // Auto-dispatch: pick the crew now (preferred first, else best-ranked eligible).
  // RUSH jobs are the exception — they NEVER auto-dispatch. Same-day push is
  // unsafe (today's capacity math can't see a crew's real remaining day), so a
  // rush job is born on the claim board: picking it up is the crew's consent.
  // If the day genuinely filled between page-load and submit (every eligible
  // crew is now full/blocked), back the booking out and ask for another date.
  // Any OTHER no-fit reason (no crew does it yet, or none clears the margin
  // floor) still confirms the booking as a "Finding a crew" waitlist row —
  // the customer isn't blocked, the claim board and nightly sweeps hunt for
  // a crew, and the demand itself is the recruiting signal.
  let assigned = false;
  if (!isRush) {
    try {
      const outcome = await autoAssignJob(inserted.id);
      assigned = outcome.assigned;
      if (!outcome.assigned && outcome.decision.reasonNoFit === "all_full_or_blocked") {
        await admin.from("jobs").delete().eq("id", inserted.id);
        return { ok: false, error: "That day just filled up — pick another date." };
      }
    } catch {
      /* leave as requested; the waitlist sweeps will keep hunting */
    }
  } else {
    // ⚡ Blast the crews best placed to say yes: anyone already working THIS
    // lake today (they're physically there — a rush job fills a gap in their
    // route). If nobody's out there today, fall back to every active crew
    // serving the lake. Content is rule-1 clean: no prices, just the board.
    try {
      const { data: propRow } = await admin.from("properties").select("lake_id, lakes(name)").eq("id", profile.propertyId).maybeSingle();
      const jobLake = (propRow?.lake_id as string) ?? null;
      const lakeName = ((Array.isArray(propRow?.lakes) ? propRow?.lakes[0] : propRow?.lakes) as { name?: string } | null)?.name ?? "your lake";
      if (jobLake) {
        const { data: outToday } = await admin
          .from("jobs")
          .select("vendor_id, properties!inner(lake_id)")
          .eq("date", date)
          .eq("properties.lake_id", jobLake)
          .in("status", ["scheduled", "in_progress"])
          .not("vendor_id", "is", null);
        let crewIds = [...new Set((outToday ?? []).map((r) => r.vendor_id as string))];
        if (crewIds.length === 0) {
          const { data: lakeCrews } = await admin
            .from("vendors")
            .select("id")
            .eq("status", "active")
            .contains("service_lakes", [jobLake]);
          crewIds = (lakeCrews ?? []).map((v) => v.id as string);
        }
        if (crewIds.length > 0) {
          const { data: crewRows } = await admin.from("vendors").select("user_id").in("id", crewIds).not("user_id", "is", null);
          const userIds = (crewRows ?? []).map((v) => v.user_id as string);
          if (userIds.length > 0) {
            const { data: phones } = await admin.from("users").select("phone").in("id", userIds).not("phone", "is", null);
            const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
            for (const p of phones ?? []) {
              void sendSms(p.phone as string, `LakeLife ⚡ same-day ${service.name} just posted on ${lakeName} — fits a gap in your day, first crew to claim gets it: ${site}/vendor/open 🌊`);
            }
          }
        }
      }
    } catch {
      /* the board itself is the source of truth; the blast is best-effort */
    }
  }

  // Notifications — best effort, never block the booking. Be HONEST about
  // whether a crew is locked in or we're still hunting one down.
  const pretty = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
  if (me?.phone) {
    void sendSms(
      me.phone,
      isRush
        ? `LakeLife ⚡: got it — same-day ${service.name} at the rush rate ($${price}). We're offering it to crews already out on your lake right now. If nobody frees up by ${settings.sameDayCutoffHour > 12 ? settings.sameDayCutoffHour - 12 + "pm" : settings.sameDayCutoffHour + "am"}, we'll ${validRushFallback(rushFallback) === "roll" ? "move it to tomorrow at the standard price" : "cancel it — no charge"}. 🌊`
        : assigned
          ? `LakeLife: ${service.name} is booked for ${pretty}. We'll text you when a crew is on the way. 🌊`
          : `LakeLife: got it — ${service.name} for ${pretty}. We're lining up a crew now and you'll hear the moment one's locked in. You're never charged until the work is done. 🌊`,
    );
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
