import "server-only";
import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { computeScore, type CrewScore } from "@/lib/scoring";

/** Calendar date (YYYY-MM-DD) of a timestamp in lake time — for on-time checks. */
function lakeDateOf(ts: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Indiana/Indianapolis" }).format(new Date(ts));
}

/**
 * Compute every vendor's crew score from the data the platform already captures:
 * completed jobs (volume), on-time completions (completed_at date <= scheduled
 * date), and flag accuracy (owner-approved vs declined flags). Service-role read
 * — this is ops authority + the dispatch score source. Returns a map by
 * vendor_id; a vendor with no history still gets a computed (new-crew) score.
 * Wrapped in React cache(): deduped per request, so a waitlist sweep that
 * auto-assigns dozens of jobs does these 3 table scans ONCE, not once per job.
 */
export const getVendorScores = cache(async (): Promise<Map<string, CrewScore>> => {
  const admin = createServiceClient();
  const [{ data: jobs }, { data: flags }, { data: noShows }] = await Promise.all([
    admin.from("jobs").select("vendor_id, date, completed_at").in("status", ["complete", "paid"]).not("vendor_id", "is", null),
    admin.from("flags").select("vendor_id, status").in("status", ["approved", "declined"]).not("vendor_id", "is", null),
    admin.from("vendor_no_shows").select("vendor_id"),
  ]);

  interface Agg { completedCount: number; onTimeCount: number; ratedCount: number; flagsApproved: number; flagsDeclined: number; noShows: number }
  const by = new Map<string, Agg>();
  const get = (id: string): Agg => {
    let a = by.get(id);
    if (!a) { a = { completedCount: 0, onTimeCount: 0, ratedCount: 0, flagsApproved: 0, flagsDeclined: 0, noShows: 0 }; by.set(id, a); }
    return a;
  };

  for (const j of jobs ?? []) {
    const a = get(j.vendor_id as string);
    a.completedCount++;
    if (j.completed_at && j.date) {
      a.ratedCount++;
      if (lakeDateOf(j.completed_at as string) <= (j.date as string)) a.onTimeCount++;
    }
  }
  for (const f of flags ?? []) {
    const a = get(f.vendor_id as string);
    if (f.status === "approved") a.flagsApproved++;
    else if (f.status === "declined") a.flagsDeclined++;
  }
  for (const n of noShows ?? []) get(n.vendor_id as string).noShows++;

  const out = new Map<string, CrewScore>();
  for (const [id, a] of by) out.set(id, computeScore(a));
  return out;
});

/** The signed-in crew's own standing (or null if the caller isn't a vendor).
 *  Imported lazily by the vendor surface; never exposes peers. */
export async function getMyStanding(vendorId: string | null): Promise<CrewScore | null> {
  if (!vendorId) return null;
  const scores = await getVendorScores();
  // A vendor with zero history isn't in the map yet — return a fresh new-crew score.
  return scores.get(vendorId) ?? computeScore({ completedCount: 0, onTimeCount: 0, ratedCount: 0, flagsApproved: 0, flagsDeclined: 0 });
}
