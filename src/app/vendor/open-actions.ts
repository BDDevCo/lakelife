"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { todayLakeDate } from "@/lib/booking";
import { canClaim, type ClaimBlocker, type CrewCandidate } from "@/lib/dispatch";
import { isCoolingDown } from "@/lib/lake-standing";
import { fillInRate, rushWindowOpen } from "@/lib/rush";
import { loadPricingProfileById } from "@/app/book/dispatch";
import { getPlatformSettings } from "@/lib/settings";
import { sendSms } from "@/lib/sms";

/**
 * CLAIM a job off the open board (Phase D). First qualified crew wins — the
 * claim is one atomic guarded UPDATE (status='requested' AND vendor_id IS NULL)
 * so two crews racing for the same job can never both get it. The crew is paid
 * THEIR OWN standing rate (no bidding); the margin floor is enforced against
 * the hidden customer price server-side. Claiming a job on a lake the crew
 * doesn't serve yet auto-adds that lake to their service area — that's how a
 * brand-new lake gets its first crew with zero human involvement.
 */

export interface ClaimResult {
  ok: boolean;
  error?: string;
}

const BLOCKER_MSG: Record<ClaimBlocker, string> = {
  not_active: "Your crew account isn't active — finish onboarding first.",
  no_coi: "Your insurance on file is missing or expired — update it to claim jobs.",
  wrong_service: "This job isn't one of your work types.",
  off_day: "This job lands on a day you don't work. Update your work days to claim it.",
  day_blocked: "You've blocked this day off.",
  day_full: "Your day is already full.",
  no_rate: "Set your rate for this service first — then you can claim jobs like this.",
  rate_too_high: "This one doesn't clear at your current rate for the service.",
  lake_paused: "You're paused on this lake for now — keep completing jobs on your other lakes and it reopens automatically.",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Current lake-time hour — the rush-window clock. */
function lakeHour(): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Indiana/Indianapolis", hour12: false, hour: "2-digit" }).format(new Date());
  return Number(h) % 24;
}
const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

export async function claimJob(jobId: string): Promise<ClaimResult> {
  // Identity: session user → own vendors row (never trust a vendorId from the browser).
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const admin = createServiceClient();
  const { data: vendor } = await admin
    .from("vendors")
    .select("id, status, coi_expiry, service_types, service_lakes, work_days, daily_capacity, base_lat, base_lng, company")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet." };
  if (!jobId) return { ok: false, error: "No job selected." };

  const today = todayLakeDate();
  const { data: job } = await admin
    .from("jobs")
    .select("id, date, status, vendor_id, customer_price, service_id, property_id, is_rush, services(name, pricing_model), properties(lake_id, address, users(phone))")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || job.status !== "requested" || job.vendor_id != null || !job.date || (job.date as string) < today) {
    return { ok: false, error: "That job was already taken — grab the next one. 🌊" };
  }

  const svc = one(job.services) as { name?: string; pricing_model?: string } | null;
  if (!svc?.name) return { ok: false, error: "That job isn't claimable." };

  // Phase E: a crew paused on this job's lake can't claim there (and therefore
  // can't auto-re-opt into the lake) until the cooldown runs out.
  const jobLakeId = (one(job.properties) as { lake_id?: string } | null)?.lake_id ?? null;
  if (jobLakeId) {
    const settingsEarly = await getPlatformSettings();
    const { data: pause } = await admin
      .from("vendor_lake_demotions")
      .select("demoted_at")
      .eq("vendor_id", vendor.id as string)
      .eq("lake_id", jobLakeId)
      .maybeSingle();
    if (pause && isCoolingDown(pause.demoted_at as string, settingsEarly.lakeDemotionCooldownDays, Date.now())) {
      return { ok: false, error: BLOCKER_MSG.lake_paused };
    }
  }

  // Price the job at THIS crew's standing rate (no bidding, ever).
  const { data: vr } = await admin
    .from("vendor_rates")
    .select("base, unit_rate, band_pricing")
    .eq("vendor_id", vendor.id as string)
    .eq("service_id", job.service_id as string)
    .maybeSingle();
  let myRate: number | null = null;
  if (vr) {
    const rule: ServiceRule = {
      name: svc.name,
      pricing_model: svc.pricing_model as ServiceRule["pricing_model"],
      base: Number(vr.base ?? 0),
      unit_rate: Number(vr.unit_rate ?? 0),
      band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
    };
    const profile = await loadPricingProfileById(admin, job.property_id as string);
    if (profile) myRate = priceService(rule, profile);
  }

  // ⚡ Same-day rush: claimable only inside the window (today, pre-cutoff) and
  // paid at the fill-in rate — the discounted number the board showed. Tapping
  // Claim IS accepting it; the discount is a dial, never a negotiation.
  const isRush = !!(job as { is_rush?: boolean }).is_rush;
  const settingsRush = await getPlatformSettings();
  if (isRush) {
    if ((job.date as string) !== today || !rushWindowOpen(lakeHour(), settingsRush.sameDayCutoffHour)) {
      return { ok: false, error: "This same-day job is past the cutoff — it's being rolled or cancelled automatically. 🌊" };
    }
    if (myRate != null) myRate = fillInRate(myRate, settingsRush.sameDayFillDiscountPct);
  }

  // Re-check the full claim gate server-side (fresh counts — the board may be stale).
  const [{ count: assignedCount }, { data: blockRow }] = await Promise.all([
    admin.from("jobs").select("id", { count: "exact", head: true })
      .eq("vendor_id", vendor.id as string).eq("date", job.date as string).in("status", ["scheduled", "in_progress"]),
    admin.from("vendor_availability").select("id")
      .eq("vendor_id", vendor.id as string).eq("date", job.date as string).eq("status", "blocked").maybeSingle(),
  ]);
  const candidate: CrewCandidate = {
    vendorId: vendor.id as string,
    status: vendor.status as string,
    coiExpiry: (vendor.coi_expiry as string) ?? null,
    serviceTypes: (vendor.service_types as string[]) ?? [],
    serviceLakes: (vendor.service_lakes as string[]) ?? [],
    workDays: (vendor.work_days as string[]) ?? [],
    dailyCapacity: Number(vendor.daily_capacity ?? 0),
    assignedThatDay: assignedCount ?? 0,
    blockedThatDay: !!blockRow,
    crewRate: myRate != null && myRate > 0 ? myRate : null,
    score: 0,
    baseLat: vendor.base_lat != null ? Number(vendor.base_lat) : null,
    baseLng: vendor.base_lng != null ? Number(vendor.base_lng) : null,
  };
  const settings = await getPlatformSettings();
  const verdict = canClaim(candidate, {
    serviceName: svc.name,
    weekday: WEEKDAYS[new Date((job.date as string) + "T12:00:00").getDay()],
    todayISO: today,
    menuPrice: Number(job.customer_price ?? 0),
    marginFloor: settings.marginFloor,
  });
  if (!verdict.ok) return { ok: false, error: BLOCKER_MSG[verdict.blocker ?? "not_active"] };

  const rate = myRate as number;
  const margin = Math.round((Number(job.customer_price ?? 0) - rate) * 100) / 100;

  // THE CLAIM — atomic, first valid claim wins.
  const { data: won } = await admin
    .from("jobs")
    .update({ vendor_id: vendor.id, vendor_cost: rate, margin, status: "scheduled" })
    .eq("id", jobId)
    .eq("status", "requested")
    .is("vendor_id", null)
    .select("id");
  if (!won || won.length === 0) return { ok: false, error: "That job was already taken — grab the next one. 🌊" };

  // Capacity backstop (same as autoAssignJob): if a concurrent claim pushed us
  // over our own daily cap, release this one back rather than overbook the day.
  const cap = Number(vendor.daily_capacity ?? 0);
  const { count: afterCount } = await admin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendor.id as string).eq("date", job.date as string).in("status", ["scheduled", "in_progress"]);
  if (cap > 0 && (afterCount ?? 0) > cap) {
    await admin.from("jobs").update({ vendor_id: null, vendor_cost: null, margin: null, status: "requested" }).eq("id", jobId);
    return { ok: false, error: "Your day filled up before this claim landed." };
  }

  // Claiming a new lake = opting into it. Append so future jobs there auto-route,
  // and immediately sweep that lake's waitlist — this crew may unlock several
  // customers stuck in "Finding a crew", not just the one they tapped.
  const prop = one(job.properties) as { lake_id?: string; address?: string; users?: unknown } | null;
  const lakes = (vendor.service_lakes as string[]) ?? [];
  if (prop?.lake_id && !lakes.includes(prop.lake_id)) {
    await admin.from("vendors").update({ service_lakes: [...lakes, prop.lake_id] }).eq("id", vendor.id as string);
    try {
      const { sweepWaitlist } = await import("@/lib/automation");
      await sweepWaitlist(prop.lake_id);
    } catch {
      /* nightly sweep is the backstop */
    }
  }

  // Recovery notify: the waiting owner instantly hears a crew picked it up.
  const ownerPhone = (one(prop?.users) as { phone?: string } | null)?.phone;
  if (ownerPhone) {
    const pretty = new Date((job.date as string) + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    void sendSms(ownerPhone, `LakeLife: good news — a crew picked up your ${svc.name} for ${pretty}. We'll text you when it's done, with photos. 🌊`);
  }

  return { ok: true };
}
