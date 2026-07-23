import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { isEligible, scarcityOffer, type DispatchInput } from "@/lib/dispatch";
import { DEFAULT_JOB_MINUTES } from "@/lib/fleet";
import { buildCandidates, loadPricingProfileById } from "@/app/book/dispatch";
import { getPlatformSettings } from "@/lib/settings";
import type { ServiceRule } from "@/lib/pricing";

/**
 * SCARCITY OFFERS for the owner's requests page (Phase C, ladder rung 3).
 * For a stuck job (requested, no crew, future date), work out whether a
 * price bump would unlock a crew: take the cheapest ELIGIBLE crew's rate
 * (lake gate ON — these are crews who could genuinely do it) and compute the
 * smallest whole-dollar uplift that clears the margin floor, capped by the
 * surge dial. The customer sees ONLY the new all-in price and the uplift —
 * never any crew rate or margin. If the floor already clears, or no eligible
 * crew has a rate, or the cap is busted, there is no offer (null) — the job
 * rides the claim board instead.
 */

export interface ScarcityOfferView {
  jobId: string;
  serviceName: string;
  date: string;
  uplift: number; // dollars added
  newPrice: number; // new all-in total
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

/** Compute the offer for ONE job id. Server-side authority — used by both the
 *  page (display) and the accept action (recompute before applying). */
export async function computeScarcityOffer(jobId: string): Promise<ScarcityOfferView | null> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const { data: job } = await admin
    .from("jobs")
    .select("id, date, status, vendor_id, customer_price, service_id, property_id, is_rush, services(name, pricing_model, est_minutes), properties(lake_id)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || job.status !== "requested" || job.vendor_id != null || !job.date || (job.date as string) < today) return null;
  if ((job as { is_rush?: boolean }).is_rush) return null; // rush already carries its premium — never stack a boost
  const svc = one(job.services) as { name?: string; pricing_model?: string; est_minutes?: number } | null;
  if (!svc?.name) return null;
  const menuPrice = Number(job.customer_price ?? 0);
  if (!(menuPrice > 0)) return null;

  const profile = await loadPricingProfileById(admin, job.property_id as string);
  if (!profile) return null;

  const [settings, crews] = await Promise.all([
    getPlatformSettings(),
    buildCandidates(admin, {
      serviceId: job.service_id as string,
      serviceName: svc.name,
      pricingModel: svc.pricing_model as ServiceRule["pricing_model"],
      dateISO: job.date as string,
      profile,
    }),
  ]);

  const input = {
    date: job.date as string,
    weekday: WEEKDAYS[new Date((job.date as string) + "T12:00:00").getDay()],
    serviceName: svc.name,
    todayISO: today,
    lakeId: ((one(job.properties) as { lake_id?: string } | null)?.lake_id as string) ?? null,
    // Real duration, not the 60-min default — a time-full fleet crew must
    // not trigger an offer the accept path's re-gate can never honor.
    jobMinutes: Number(svc.est_minutes ?? 0) > 0 ? Number(svc.est_minutes) : DEFAULT_JOB_MINUTES,
  } as DispatchInput;

  // Cheapest crew that could genuinely take it (all hard gates incl. lake).
  const rates = crews
    .filter((c) => isEligible(c, input) && c.crewRate != null && (c.crewRate as number) > 0)
    .map((c) => c.crewRate as number);
  if (rates.length === 0) return null; // price isn't the blocker — no offer
  const bestRate = Math.min(...rates);

  const offer = scarcityOffer(menuPrice, bestRate, settings.marginFloor, settings.surgeCapPct);
  if (!offer) return null;
  return { jobId: job.id as string, serviceName: svc.name, date: job.date as string, ...offer };
}

/** Offers for a set of job ids the caller ALREADY verified it may see (the
 *  requests page passes ids from its own RLS-scoped owner_jobs query). */
export async function getScarcityOffers(jobIds: string[]): Promise<ScarcityOfferView[]> {
  const out: ScarcityOfferView[] = [];
  for (const id of jobIds.slice(0, 10)) {
    const o = await computeScarcityOffer(id);
    if (o) out.push(o);
  }
  return out;
}
