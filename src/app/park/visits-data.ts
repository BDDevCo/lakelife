import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { clockLabel } from "@/lib/duration";

/**
 * WHO IS ON MY PROPERTY, AND WHEN.
 *
 * Brendon: "park owner should see for crew validation knowing who is on site
 * at what times but thats about it. Crew, Service, Time/date."
 *
 * THE TEST THIS PASSES, and the reason it is safe: everything here is
 * something he could learn by looking out of his own window. A truck is on his
 * land; this tells him it is expected. It adds no information he could not get
 * by standing there — and it withholds everything he could not: who booked it,
 * what they paid, which lot it is for.
 *
 * The link is to the PARK and never to the LOT (0085), so a visit cannot be
 * attributed to a household. That is structural, not a matter of which columns
 * a screen happens to render.
 */

export interface SiteVisit {
  date: string;
  crew: string;
  service: string;
  status: string;
  /** "7:00am–9:30am", when we know how long it takes. */
  window: string | null;
}

export interface VisitBoard {
  today: SiteVisit[];
  upcoming: SiteVisit[];
  recent: SiteVisit[];
  /** Nothing at all — said precisely, because "no visits" and "nobody has
   *  told us they live here" are very different facts. */
  anyLinkedProperties: boolean;
}

/**
 * The arrival window we can honestly state.
 *
 * We schedule a DAY, not an appointment — nobody has been promised a time, and
 * inventing one here would be the first broken promise. What we can say is how
 * long the work takes and that the crew's sellable day starts at 7, so this
 * reads as "expect about 2 hours, any time from 7:00am" rather than a slot.
 */
function windowFor(estMinutes: number | null, startHour: number): string | null {
  if (!estMinutes || estMinutes <= 0) return null;
  return `about ${estMinutes >= 60
    ? `${Math.round((estMinutes / 60) * 10) / 10}h`
    : `${estMinutes}m`}, any time from ${clockLabel(startHour * 60)}`;
}

export async function getSiteVisits(parkId: string): Promise<VisitBoard | null> {
  if (!(await assertMyPark(parkId))) return null;

  const admin = createServiceClient();
  const today = todayLakeDate();

  const [{ data: rows }, { data: dials }, { count: linked }] = await Promise.all([
    admin
      .from("park_site_visits")
      .select("visit_date, crew, service, status, est_minutes")
      .eq("park_id", parkId)
      .order("visit_date", { ascending: true }),
    admin.from("platform_dials").select("sell_start_hour").maybeSingle(),
    admin
      .from("properties")
      .select("id", { count: "exact", head: true })
      .eq("park_id", parkId),
  ]);

  const startHour = Number(dials?.sell_start_hour ?? 7);

  const all: Array<SiteVisit & { _d: string }> = (rows ?? []).map((r) => ({
    _d: r.visit_date as string,
    date: r.visit_date as string,
    crew: (r.crew as string) ?? "Crew to be assigned",
    service: (r.service as string) ?? "Work",
    status: (r.status as string) ?? "scheduled",
    window: windowFor((r.est_minutes as number | null) ?? null, startHour),
  }));

  // Thirty days back is enough to answer "was that truck last Tuesday ours?"
  // without turning into a history of the tenants.
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  return {
    today: all.filter((v) => v._d === today),
    upcoming: all.filter((v) => v._d > today),
    recent: all.filter((v) => v._d < today && v._d >= cutoffISO).reverse(),
    anyLinkedProperties: (linked ?? 0) > 0,
  };
}
