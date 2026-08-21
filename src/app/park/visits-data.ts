import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, mustCount } from "@/lib/must-read";
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
 * The link was to the PARK and never to the LOT in 0085; 0107 put the lot back
 * in deliberately, for liability — a landlord needs to know who is on his
 * property and where, which is again exactly what he could see from the window.
 * What stays out is structural and unchanged: no renter, no address, no price,
 * no margin, no job id to join back with. It is the VIEW that withholds those,
 * not a choice of columns on this screen.
 */

export interface SiteVisit {
  date: string;
  crew: string;
  service: string;
  status: string;
  /** "7:00am–9:30am", when we know how long it takes. */
  window: string | null;
  /**
   * WHICH LOT — or null for the common ground.
   *
   * 0085 deliberately withheld this: "THE LINK IS TO THE PARK, NEVER TO THE
   * LOT." 0107 reverses it on the owner's decision, for liability: a crew on
   * Lot 7 is on land the park owns, on utilities it maintains, under its
   * insurance. It also passes 0085's own test — a van parked at Lot 7 is
   * visible from the window, and the rent roll already says who lives there.
   *
   * What stays out permanently: price, margin, the household's name, and the
   * profile. Those are not visible from the window and are not liability
   * facts. This is a log of who is on the land, never of what anyone bought.
   */
  lotNumber: string | null;
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

  const [visitsRes, dialsRes, linkedRes] = await Promise.all([
    admin
      .from("park_site_visits")
      .select("visit_date, crew, service, status, est_minutes, lot_number")
      .eq("park_id", parkId)
      .order("visit_date", { ascending: true }),
    admin.from("platform_dials").select("sell_start_hour").maybeSingle(),
    admin
      .from("properties")
      .select("id", { count: "exact", head: true })
      .eq("park_id", parkId),
  ]);

  // A DROPPED READ IS NOT AN EMPTY DRIVE. Every read in this file used to be
  // destructured straight to `data`, so a failure arrived as null and the
  // board printed "Nothing booked yet." — on a screen whose entire job is
  // telling him whether the truck outside is meant to be there. He would go
  // and challenge his own crew.
  const rows = mustRead("the visits booked in your park", visitsRes);
  const linked = mustCount("the places in your park set up for service", linkedRes);

  // The one read worth degrading for: it only picks the hour a window label
  // starts from, and 7 is the same answer the dial itself carries. Logged,
  // because a park quietly reading the wrong sell-start is worth knowing about.
  if (dialsRes.error) {
    console.error("[read failed] the platform sell-start hour:", dialsRes.error);
  }
  const startHour = Number(dialsRes.data?.sell_start_hour ?? 7);

  const all: Array<SiteVisit & { _d: string }> = (rows ?? []).map((r) => ({
    _d: r.visit_date as string,
    date: r.visit_date as string,
    crew: (r.crew as string) ?? "Crew to be assigned",
    service: (r.service as string) ?? "Work",
    status: (r.status as string) ?? "scheduled",
    lotNumber: (r.lot_number as string) ?? null,
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
    anyLinkedProperties: linked > 0,
  };
}
