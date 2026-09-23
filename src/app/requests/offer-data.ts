import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { isEligible, scarcityOffer, type DispatchInput } from "@/lib/dispatch";
import { DEFAULT_JOB_MINUTES } from "@/lib/fleet";
import { buildCandidates, loadPricingProfileById } from "@/app/book/dispatch";
import { getPlatformSettings } from "@/lib/settings";
import type { ServiceRule } from "@/lib/pricing";
import { mustRead, ReadFailed } from "@/lib/must-read";
import { crewSetsThePrice } from "@/lib/park-rates";
import { parkRatesForProfile } from "@/app/park/rate-data";

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
 *  page (display) and the accept action (recompute before applying).
 *
 *  THROWS ReadFailed if the job read fails. `null` from here means "no offer"
 *  as a FACT, and the accept action reports that fact to the customer as a
 *  sentence about their request — so a failed read must not be able to
 *  produce it. Callers that cannot throw (the accept action, the nightly
 *  waitlist text) catch it; the pages let the error boundary have it. */
export async function computeScarcityOffer(jobId: string): Promise<ScarcityOfferView | null> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const job = mustRead("this request", await admin
    .from("jobs")
    .select("id, date, status, vendor_id, customer_price, service_id, property_id, is_rush, services(name, pricing_model, est_minutes, crew_priced), properties(lake_id)")
    .eq("id", jobId)
    .maybeSingle());
  if (!job || job.status !== "requested" || job.vendor_id != null || !job.date || (job.date as string) < today) return null;
  if ((job as { is_rush?: boolean }).is_rush) return null; // rush already carries its premium — never stack a boost
  const svc = one(job.services) as { name?: string; pricing_model?: string; est_minutes?: number; crew_priced?: boolean } | null;
  if (!svc?.name) return null;
  // NO OFFER ON A CREW-PRICED SERVICE — there is no floor here to clear, so
  // there is no bump that clears it.
  //
  // This whole function asks "would a few more dollars lift this job over the
  // margin floor?". On a crew-priced service customer_price IS
  // round2(quote x (1 + customerPct)), so marginPct is the CONSTANT
  // (c+k)/(1+c) — 21.43% at 12/12 — on every job, forever. Tune the dials to
  // 11/11 and it is 19.82%, under the live 0.20 floor, and this function would
  // compute a real uplift and ASK A CUSTOMER FOR MORE MONEY on every stuck job
  // on the platform, for a shortfall no crew's rate caused and no extra dollar
  // can fix. The guard sits HERE, not at the call sites, because there are two
  // of them — the nightly waitlist text and the requests page — and a rule in
  // one doorway of two is not a rule.
  //
  // AND IT ASKS THE PRECEDENCE RULE, NOT THE FLAG (0176). A park holding its
  // own negotiated rate is on the MENU path however the service is flagged —
  // its customer_price is a real number, the margin floor is a real test
  // against it, and an offer that lifts a stuck job over the floor means
  // exactly as much for The Haven as for a lake house. Reading the flag alone
  // switched the engine off for the one customer whose price LakeLife did not
  // set. `parkId` rides on the pricing profile, so the guard moves BELOW the
  // profile load — which was two lines away and needed anyway.
  const menuPrice = Number(job.customer_price ?? 0);
  if (!(menuPrice > 0)) return null;

  const profile = await loadPricingProfileById(admin, job.property_id as string);
  if (!profile) return null;
  // A FAILED RATE READ IS NOT AN EMPTY ONE, and the empty answer here is "a
  // crew prices this" = no offer — which this function's contract says is a
  // FACT, reported to the customer as a sentence about their request. Thrown,
  // like every other read in here; both callers already catch.
  const parkRatesRes = await parkRatesForProfile(profile);
  if (parkRatesRes.failed) throw new ReadFailed("what this park pays", undefined);
  if (crewSetsThePrice(
    { id: job.service_id as string, crew_priced: svc.crew_priced },
    parkRatesRes.rates,
  )) return null;

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
