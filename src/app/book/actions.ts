"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { withParkRate } from "@/lib/park-rates";
import { loadParkRatesChecked } from "@/app/park/rate-data";
import { getFullProfile, toPricingProfile, getActivePropertyId } from "@/app/profile/data";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { serviceMinutes } from "@/lib/duration";
import { todayLakeDate } from "@/lib/booking";
import {
  batchOutcomeCopy,
  normalizeBatchDates,
  planBatchDates,
  prettyDateList,
  type PlannedDate,
} from "@/lib/batch-booking";
import { rushPrice, validRushFallback } from "@/lib/rush";
import { getPlatformSettings } from "@/lib/settings";
import { sendSms } from "@/lib/sms";
import { notify } from "@/lib/notify";
import { allowsNotification } from "@/lib/notif-gate";
import { sendEmail } from "@/lib/email";
import { autoAssignJob, getServiceAvailability } from "./dispatch";
import { ensureTos } from "@/lib/tos-server";
import { mustRead, ReadFailed, readFailedMessage } from "@/lib/must-read";

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
  // Null here means "no such bookable service", and the caller answers it with
  // an EMPTY calendar that has no `unavailable` flag — so every square draws
  // white and clickable. A failed read must not reach that branch.
  const data = mustRead("this service", await supabase
    .from("services")
    .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands, is_water_work, daily_capacity, frequency_options, kind, active")
    .eq("id", serviceId)
    .eq("active", true)
    .eq("kind", "standalone") // components/add-ons book only inside packages
    .maybeSingle());
  return (data as ServiceRow | null) ?? null;
}

/** Season window (ice-out → pull deadline) for the SPECIFIC property being booked. */
async function loadSeason(propertyId: string): Promise<{ start: string | null; end: string | null }> {
  const supabase = await createClient();
  // HALF A WINDOW IS NOT A WINDOW, AND NO WINDOW IS NOT AN ANSWER. dayStatus
  // fails closed on a missing season, so a dropped read here refuses every
  // water-work date with "That date is outside this lake's water-work season"
  // — a confident statement about a lake nobody managed to read. Throws; the
  // caller turns it into a sentence that says nothing about the lake.
  const data = mustRead("this lake's season dates", await supabase
    .from("properties")
    .select("lakes(ice_out_actual, pull_deadline)")
    .eq("id", propertyId)
    .maybeSingle());
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
): Promise<{ fullDates: string[]; capacity: number; findingCrew: boolean; crewGap?: "lake" | "service" | null; rush: RushWindow; today: string; unavailable?: boolean }> {
  const settings = await getPlatformSettings();
  const rush: RushWindow = { nowHour: lakeHour(), cutoffHour: settings.sameDayCutoffHour, surchargePct: settings.sameDaySurchargePct };
  let service: ServiceRow | null;
  try {
    service = await loadService(serviceId);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return {
      fullDates: [], capacity: 0, findingCrew: false,
      rush, today: todayLakeDate(), unavailable: true,
    };
  }
  // TODAY IN LAKE TIME, DECIDED SERVER-SIDE.
  //
  // The calendar was deriving "today" from the BROWSER clock while the confirm
  // uses `todayLakeDate()`. A Chicago owner at 11:40pm CT — 12:40am the next
  // day in Indiana — was shown a date the server then rejected with "That date
  // has passed", on a screen that had just offered it. Same for anyone
  // travelling. The server decides which day it is on the lake; the calendar
  // draws what the server says.
  const today = todayLakeDate();
  if (!service) return { fullDates: [], capacity: 0, findingCrew: false, rush, today };
  // Scope capacity to crews that service THIS property's lake (Phase B): a date
  // is only bookable if a crew who works this lake has an open slot.
  // A FAILED READ IS NOT AN OPEN CALENDAR.
  //
  // getActivePropertyId (through listProperties) and getServiceAvailability
  // both throw now, and this is a "use server" action: the calendar awaits it
  // in an effect with no catch, so a rejection left every square drawn white
  // and bookable. `unavailable` is the honest third answer — not "full", not
  // "open", but "we couldn't look" — and every caller below refuses on it
  // rather than reading the empty fullDates as a green light.
  try {
    const pid = propertyId ?? (await getActivePropertyId());
    let lakeId: string | null = null;
    if (pid) {
      const admin = createServiceClient();
      // lakeId scopes capacity to crews who work THIS lake. Swallowed, a failed
      // read reads as "no lake", which counts every crew everywhere and offers
      // days nobody serving this water can take — and can trip the cold-start
      // "New water for us" banner on an established lake.
      const data = mustRead("this property's lake", await admin
        .from("properties").select("lake_id").eq("id", pid).maybeSingle());
      lakeId = (data?.lake_id as string) ?? null;
    }
    const avail = await getServiceAvailability(service.name, year, month, lakeId);
    return { ...avail, rush, today };
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { fullDates: [], capacity: 0, findingCrew: false, rush, today, unavailable: true };
  }
}

export interface BookingResult {
  ok: boolean;
  error?: string;
  needsVerification?: boolean;
  /** First service request: show the scroll-and-agree, retry with tosAccepted. */
  needsTos?: boolean;
}

export interface BatchBookingResult extends BookingResult {
  /** The days that became jobs, ascending. */
  booked?: string[];
  /** The days that did NOT, each carrying the sentence explaining why. */
  refused?: PlannedDate[];
  /** Ready-made copy for the toast — headline plus one line per reason. */
  headline?: string;
  lines?: string[];
}

/**
 * Confirm ONE booking. Thin wrapper over the batch path so a single date and
 * six dates can never drift into validating, pricing, or refusing differently.
 */
export async function createBooking(
  serviceId: string,
  date: string, // YYYY-MM-DD
  frequency: string,
  rushFallback?: string, // same-day only: 'roll' (tomorrow at standard price) | 'cancel'
  tosAccepted?: boolean, // set by the agree modal's retry — stamps and proceeds
): Promise<BookingResult> {
  const res = await createBookingBatch(serviceId, [date], frequency, rushFallback, tosAccepted);
  if (res.ok) return { ok: true };
  return {
    ok: false,
    // A one-date batch has exactly one story to tell: the batch-level error if
    // the whole thing was refused, else that date's own reason.
    error: res.error ?? res.refused?.[0]?.reason ?? "Could not book that.",
    ...(res.needsVerification ? { needsVerification: true } : {}),
    ...(res.needsTos ? { needsTos: true } : {}),
  };
}

/**
 * ⚡ Blast the crews best placed to say yes to a same-day job: anyone already
 * working THIS lake today (they're physically there — a rush job fills a gap
 * in their route). If nobody's out there today, fall back to every active crew
 * serving the lake. Content is rule-1 clean: no prices, just the board.
 * Best-effort — the board itself is the source of truth.
 */
async function blastRushToCrews(
  admin: ReturnType<typeof createServiceClient>,
  opts: { propertyId: string; serviceName: string; date: string },
): Promise<void> {
  try {
    // Every read in here throws and lands in this function's own catch below:
    // the blast is best-effort either way, but a failed read now says so in
    // the log instead of quietly blasting the wrong crews (an unread
    // `outToday` reads as "nobody is out there", which falls through to
    // texting every crew on the lake) or nobody at all.
    const propRow = mustRead("this property's lake", await admin.from("properties").select("lake_id, lakes(name)").eq("id", opts.propertyId).maybeSingle());
    const jobLake = (propRow?.lake_id as string) ?? null;
    const lakeName = ((Array.isArray(propRow?.lakes) ? propRow?.lakes[0] : propRow?.lakes) as { name?: string } | null)?.name ?? "your lake";
    if (!jobLake) return;
    const outToday = mustRead("who's out on this lake today", await admin
      .from("jobs")
      .select("vendor_id, properties!inner(lake_id)")
      .eq("date", opts.date)
      .eq("properties.lake_id", jobLake)
      .in("status", ["scheduled", "in_progress"])
      .not("vendor_id", "is", null));
    let crewIds = [...new Set((outToday ?? []).map((r) => r.vendor_id as string))];
    if (crewIds.length === 0) {
      const lakeCrews = mustRead("the crews who work this lake", await admin
        .from("vendors")
        .select("id")
        .eq("status", "active")
        .contains("service_lakes", [jobLake]));
      crewIds = (lakeCrews ?? []).map((v) => v.id as string);
    }
    if (crewIds.length === 0) return;
    const crewRows = mustRead("those crews' accounts", await admin.from("vendors").select("user_id").in("id", crewIds).not("user_id", "is", null));
    const userIds = (crewRows ?? []).map((v) => v.user_id as string);
    if (userIds.length === 0) return;
    // REACHABLE, NOT PHONED. This still filtered `.not("phone","is",null)`
    // after the send widened to email — so a crew with an address and no mobile
    // on file was excluded from a rush blast they could have claimed, by a
    // guard written when a phone was the only door. A rush job goes to whoever
    // sees it first, and since July nobody has seen a text.
    const phones = mustRead("those crews' contact details", await admin
      .from("users").select("phone, email").in("id", userIds)
      .or("phone.not.is.null,email.not.is.null"));
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    for (const p of phones ?? []) {
      // EVERY DOOR: a rush job is claimed by whoever sees it first, and text
      // alone has been seen by nobody since July.
      await notify(
        "a crew that a same-day job just posted on their lake",
        { phone: p.phone as string | null, email: p.email as string | null },
        {
          sms: `LakeLife ⚡ same-day ${opts.serviceName} just posted on ${lakeName} — fits a gap in your day, first crew to claim gets it: ${site}/vendor/open 🌊`,
          subject: `Same-day ${opts.serviceName} just posted on ${lakeName}`,
        },
      );
    }
  } catch {
    /* the board itself is the source of truth; the blast is best-effort */
  }
}

/**
 * Confirm ONE OR SEVERAL bookings in a single motion — the middle rung between
 * a one-off and Autopilot (owner, 2026-08-14). Every date is validated on its
 * own, priced on its own, and dispatched on its own; the jobs are INDEPENDENT
 * rows with no group, so cancelling one Tuesday leaves the rest standing.
 *
 * Enforces rule 5 (verified email + SMS-verified mobile before first booking),
 * re-prices server-side (never trusts a client price), re-validates the season
 * window + capacity against the property's OWN lake, then creates `requested`
 * jobs and fires ONE booking-confirmed text + email for the whole batch — not
 * six. The agreement gate likewise fires once. The inserts run with the
 * service role: direct owner inserts into jobs are closed at the RLS layer, so
 * this action is the only door, and it validates.
 *
 * PARTIAL SUCCESS IS EXPECTED. Days fill independently, so the answer is book
 * what can be booked and name every day that could not.
 */
export async function createBookingBatch(
  serviceId: string,
  dates: string[], // YYYY-MM-DD, any order
  frequency: string,
  rushFallback?: string, // same-day only: 'roll' (tomorrow at standard price) | 'cancel'
  tosAccepted?: boolean, // set by the agree modal's retry — stamps and proceeds
): Promise<BatchBookingResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // RULE 5: working email AND SMS-verified mobile before any booking.
  // A FAILED READ IS NOT AN UNVERIFIED ACCOUNT. Unread, both flags fall to
  // false and the refusal below tells somebody who verified their mobile
  // months ago to go and verify it — a statement about their account made
  // with no fact behind it, and a dead end, since the verify screen will
  // show them a number that is already confirmed. Nothing is written yet.
  const meRes = await supabase
    .from("users")
    .select("email_verified, phone_verified, phone, email")
    .eq("id", user.id)
    .maybeSingle();
  if (meRes.error) return { ok: false, error: readFailedMessage("your account", meRes.error) };
  const me = meRes.data;
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

  // "Set up your property first" is a statement about their account, and a
  // failed read must not make it. getFullProfile throws ReadFailed; this is a
  // "use server" action, so a rejection would reach the booking screen as a
  // blank failure with no sentence. Nothing has been written at this point.
  let profile;
  try {
    profile = await getFullProfile();
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("your property", e) };
  }
  if (!profile?.hasProfile || !profile.propertyId) {
    return { ok: false, error: "Set up your property first." };
  }
  // Same seam as getAvailability's: loadService throws now, and "That service
  // isn't available" is the one sentence that must NOT be reachable by a
  // failed read — it sends somebody away from a service that is on sale.
  let service;
  try {
    service = await loadService(serviceId);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("this service", e) };
  }
  if (!service) return { ok: false, error: "That service isn't available." };

  // Nothing vanishes: garbage dates and anything past the batch cap come back
  // NAMED, alongside whatever the calendar itself refuses below.
  const { dates: wanted, refused } = normalizeBatchDates(dates);
  if (wanted.length === 0 && refused.length === 0) {
    return { ok: false, error: "Pick at least one date." };
  }

  // Re-validate EVERY day server-side, against THIS property's lake and
  // Indiana time — a batch is never waved through on its first date. Capacity
  // is read once per calendar month the batch touches, then every date is
  // judged against it individually.
  const settings = await getPlatformSettings();
  // loadSeason throws rather than handing back an empty window; this is a
  // "use server" action, so a rejection would reach the booking screen as a
  // blank failure. Nothing has been written or charged at this point.
  let season;
  try {
    season = await loadSeason(profile.propertyId);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("this lake's season dates", e) };
  }
  const months = [...new Set(wanted.map((d) => d.slice(0, 7)))];
  const monthFulls = await Promise.all(
    months.map((m) => getAvailability(serviceId, Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, profile.propertyId)),
  );
  // If the calendar couldn't be read for any month this batch touches, its
  // empty fullDates would wave every day through — including the full ones.
  // Nothing is booked and nothing is charged, so say exactly that.
  if (monthFulls.some((a) => a.unavailable)) {
    return { ok: false, error: readFailedMessage("which days the crews still have open", null) };
  }
  const fullDates = new Set(monthFulls.flatMap((a) => a.fullDates));
  const plan = planBatchDates(wanted, {
    today: todayLakeDate(),
    isWaterWork: service.is_water_work,
    seasonStart: season.start,
    seasonEnd: season.end,
    fullDates,
    rushNowHour: lakeHour(),
    rushCutoffHour: settings.sameDayCutoffHour,
  });
  refused.push(...plan.filter((p) => !p.ok));
  const bookable = plan.filter((p) => p.ok);
  if (bookable.length === 0) {
    const copy = batchOutcomeCopy(service.name, [], refused);
    return {
      ok: false,
      booked: [],
      refused,
      headline: copy.headline,
      lines: copy.lines,
      // One refused date has one story; several have a list, so let the caller
      // render the lines rather than flattening them into a single sentence.
      error: refused.length === 1 ? refused[0].reason : copy.headline,
    };
  }

  // Price it here — the client's number is never trusted. Rush pays the
  // premium; the crew side gets its fill-in discount at claim time.
  //
  // A PARK PAYS ITS OWN RATE (0115). The global row for a grounds service
  // carries no price at all, so without this overlay a mow books at $0 and the
  // refusal below fires with a message about boat lifts.
  // THE CHECKED VARIANT, because the refusal below speaks to a person.
  // loadParkRates swallows by design (the nightly must not die over one park's
  // prices). Here an unread map leaves 0115's zeroed global base in place,
  // standardPrice comes out $0, and the owner is told to "set what you pay for
  // it on your park's Services page" — a confident statement about their setup,
  // sent to somebody who has already set it, pointing at a page where it is
  // already correct. rate-data.ts exports loadParkRatesChecked for exactly this.
  let parkRates = new Map();
  if (profile.groundsForParkId) {
    const checked = await loadParkRatesChecked(profile.groundsForParkId);
    if (checked.failed) {
      return { ok: false, error: readFailedMessage("what your park pays for this", null) };
    }
    parkRates = checked.rates;
  }
  const priceRule = profile.groundsForParkId
    ? withParkRate(service, parkRates)
    : service;
  const standardPrice = priceService(priceRule, toPricingProfile(profile));
  // SIM-FOUND (Wave 1): a $0 price means the profile has none of what this
  // service counts (0 PWC lifts booking a PWC pull). A $0 job can never
  // assign and sits as phantom "demand" — refuse with the honest fix.
  if (standardPrice <= 0) {
    return {
      ok: false,
      error: profile.groundsForParkId
        ? `${service.name} has no price for your park yet. Set what you pay for it on your park's Services page and it becomes bookable.`
        : `${service.name} prices to $0 for your place — your profile shows none of the equipment it covers. Update your property profile and the real price appears.`,
    };
  }
  const rushAllIn = rushPrice(standardPrice, settings.sameDaySurchargePct);

  // HOW LONG, from the same profile that decided how much (0083). Frozen onto
  // the job the way the price is, so tuning a ladder later cannot silently
  // rewrite a day that is already sold. A 12-section pier is 255 minutes here
  // where it used to be a flat 180 for every pier on the lake.
  const estMinutes = serviceMinutes(priceRule, toPricingProfile(profile));

  const admin = createServiceClient();
  const booked: Array<{ date: string; price: number; isRush: boolean }> = [];
  // Only meaningful for a one-date booking, where the text says whether a crew
  // is already locked in. A batch's text speaks for the whole list instead.
  let soloAssigned = false;

  // ONE DATE AT A TIME. Each day is its own job, its own price, its own crew
  // question — and its own refusal if it loses the race. Nothing here is
  // transactional across dates ON PURPOSE: five visits that landed are worth
  // more to the customer than an all-or-nothing rollback because the sixth
  // Tuesday filled up while they were choosing.
  for (const day of bookable) {
    const price = day.isRush ? rushAllIn : standardPrice;
    const { data: inserted, error } = await admin
      .from("jobs")
      .insert({
        property_id: profile.propertyId,
        service_id: serviceId,
        date: day.date,
        frequency,
        status: "requested",
        customer_price: price,
        est_minutes: estMinutes,
        ...(day.isRush ? { is_rush: true, rush_fallback: validRushFallback(rushFallback) } : {}),
      })
      .select("id")
      .single();
    if (error || !inserted) {
      refused.push({ ...day, ok: false, reason: error?.message ?? "Could not book that day." });
      continue;
    }

    // Auto-dispatch: pick the crew now (preferred first, else best-ranked eligible).
    // RUSH jobs are the exception — they NEVER auto-dispatch. Same-day push is
    // unsafe (today's capacity math can't see a crew's real remaining day), so a
    // rush job is born on the claim board: picking it up is the crew's consent.
    // If the day genuinely filled between page-load and submit (every eligible
    // crew is now full/blocked), back THAT day's booking out and name it — the
    // other days in the batch are untouched.
    // Any OTHER no-fit reason (no crew does it yet, or none clears the margin
    // floor) still confirms the booking as a "Finding a crew" waitlist row —
    // the customer isn't blocked, the claim board and nightly sweeps hunt for
    // a crew, and the demand itself is the recruiting signal.
    if (!day.isRush) {
      try {
        const outcome = await autoAssignJob(inserted.id);
        soloAssigned = outcome.assigned;
        if (!outcome.assigned && outcome.decision.reasonNoFit === "all_full_or_blocked") {
          await admin.from("jobs").delete().eq("id", inserted.id);
          refused.push({ ...day, ok: false, reason: "That day just filled up — pick another date." });
          continue;
        }
      } catch {
        /* leave as requested; the waitlist sweeps will keep hunting */
      }
    } else {
      await blastRushToCrews(admin, { propertyId: profile.propertyId, serviceName: service.name, date: day.date });
    }
    booked.push({ date: day.date, price, isRush: day.isRush });
  }

  refused.sort((a, b) => a.date.localeCompare(b.date));
  const bookedDates = booked.map((b) => b.date);
  const copy = batchOutcomeCopy(service.name, bookedDates, refused);
  if (booked.length === 0) {
    return {
      ok: false,
      booked: [],
      refused,
      headline: copy.headline,
      lines: copy.lines,
      error: refused.length === 1 ? refused[0].reason : copy.headline,
    };
  }

  // Notifications — best effort, never block the booking. ONE message for the
  // batch, not one per visit: six texts for one decision is spam, and the
  // person who just booked six days already knows they booked six days.
  // Be HONEST about whether a crew is locked in or we're still hunting one.
  const solo = booked.length === 1 && refused.length === 0;
  const only = booked[0];
  const pretty = new Date(only.date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
  const cutoffLabel = settings.sameDayCutoffHour > 12 ? settings.sameDayCutoffHour - 12 + "pm" : settings.sameDayCutoffHour + "am";
  const total = booked.reduce((sum, b) => sum + b.price, 0);
  const visits = `${booked.length} visit${booked.length === 1 ? "" : "s"}`;
  const missed = refused.length > 0 ? ` We couldn't get ${prettyDateList(refused.map((r) => r.date), 3)} — pick those again anytime.` : "";

  // GATED, at last. Six switches have existed on the settings screen since the
  // start and no send path ever read one, so a customer who turned texts off
  // kept getting them. A switch that does nothing is worse than no switch.
  if (me?.phone && (await allowsNotification(user.id, "book", "sms"))) {
    void sendSms(
      me.phone,
      solo
        ? only.isRush
          ? `LakeLife ⚡: got it — same-day ${service.name} at the rush rate ($${only.price}). We're offering it to crews already out on your lake right now. If nobody frees up by ${cutoffLabel}, we'll ${validRushFallback(rushFallback) === "roll" ? "move it to tomorrow at the standard price" : "cancel it — no charge"}. 🌊`
          : soloAssigned
            ? `LakeLife: ${service.name} is booked for ${pretty}. We'll text you when a crew is on the way. 🌊`
            : `LakeLife: got it — ${service.name} for ${pretty}. We're lining up a crew now and you'll hear the moment one's locked in. You're never charged until the work is done. 🌊`
        : `LakeLife: ${visits} of ${service.name} locked in — ${prettyDateList(bookedDates, 6)}.${missed} We'll text you before each one, and you're never charged until the work is done. 🌊`,
    );
  }
  if (me?.email && (await allowsNotification(user.id, "book", "email"))) {
    void sendEmail({
      to: me.email,
      subject: solo ? `Booked: ${service.name} 🌊` : `Booked: ${visits} of ${service.name} 🌊`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#20343d">
          <h2>You're booked, ${profile.address ?? "friend"}.</h2>
          ${solo
            ? `<p><b>${service.name}</b> — ${frequency}<br>${pretty}</p>
          <p style="color:#5D7681">Your price: <b>$${only.price.toLocaleString()}</b>. You're only charged after the service is completed and photos are uploaded.</p>`
            : `<p><b>${service.name}</b> — ${visits}</p>
          <ul style="color:#20343d;padding-left:18px">${booked
            .map((b) => `<li>${new Date(b.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} — $${b.price.toLocaleString()}${b.isRush ? " (same-day rush)" : ""}</li>`)
            .join("")}</ul>
          <p style="color:#5D7681">Total across ${visits}: <b>$${total.toLocaleString()}</b>. Each visit is charged only after it's completed and its photos are uploaded — never before, and cancelling one visit never touches the others.</p>
          ${refused.length > 0 ? `<p style="color:#8a6d3b">We couldn't book ${prettyDateList(refused.map((r) => r.date))}: ${copy.lines.join(" ")} Pick those days again anytime.</p>` : ""}`}
        </div>`,
    });
  }

  return { ok: true, booked: bookedDates, refused, headline: copy.headline, lines: copy.lines };
}
