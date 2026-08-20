import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { isCoolingDown } from "@/lib/lake-standing";
import { getPlatformSettings } from "@/lib/settings";

/**
 * WHAT NEEDS THIS CREW, ON THE SCREEN THEY ALREADY OPEN.
 *
 * A crew has no surface that answers "is anything waiting on me?". Each thing
 * that is lives on its own screen, and the two below are only reachable if you
 * already know to go and look:
 *
 *   A HELD JOB. A customer thumbs-down freezes the pay for that job and starts
 *   a cure window with a deadline on it. Until now the only notice was a text,
 *   on a channel that has delivered nothing since July — so a crew could be
 *   inside a running clock, with money held, having been told by nothing. The
 *   text goes by email as well now; this is the same fact on the screen they
 *   open every morning, which is where somebody actually looks.
 *
 *   A PAUSED LAKE. Auto-demotion drops a lake out of their service area and
 *   starts a cooldown. Their work there simply stops — no jobs, no offers, no
 *   explanation — and nothing tells them it happened or when it lifts.
 *
 * The COI is deliberately NOT here: VendorDocs already renders it on this page,
 * quiet when in date and loud when not. Two cards about one certificate would
 * be worse than one.
 *
 * READS, NOT DECISIONS. Nothing here changes anything; it is the existing data
 * put where the person it concerns can see it.
 */

export interface NeedsYou {
  /** Jobs whose pay is frozen behind an open dispute, soonest deadline first. */
  held: Array<{
    disputeId: string;
    jobId: string;
    service: string | null;
    where: string | null;
    /** ISO instant the cure window closes, when one is set. */
    respondBy: string | null;
    /** The three one-tap links, already minted. */
    token: string | null;
  }>;
  /** Lakes they have been paused off, and when each pause lifts. */
  pausedLakes: Array<{ lake: string; liftsOn: string }>;
  /**
   * True when a read failed and we do not actually know. An empty card and a
   * card we could not fill look identical, and only one of them means
   * "nothing needs you" — so the difference gets carried, and said out loud.
   */
  checkFailed?: boolean;
}

/** Statuses where the customer is still waiting on the crew, or on a fix. */
const OPEN_TO_CREW = ["crew_review", "verifying", "talk", "fixing"] as const;

export async function getNeedsYou(vendorId: string | null): Promise<NeedsYou> {
  const empty: NeedsYou = { held: [], pausedLakes: [] };
  if (!vendorId) return empty;

  const admin = createServiceClient();

  // OPEN DISPUTES FIRST, THEN THE JOBS THEY POINT AT.
  //
  // The other order — every job this crew has ever done, then its disputes —
  // grows with the crew's whole history and drags two embeds along with it. A
  // crew four seasons in would pull thousands of rows to find, almost always,
  // nothing. Open disputes platform-wide is a handful at any moment.
  //
  // Scoping still holds: the jobs read carries `.eq("vendor_id", vendorId)`,
  // so a dispute on somebody else's job finds no job here and drops out.
  const [disputesRes, pausesRes, settings] = await Promise.all([
    admin
      .from("disputes")
      .select("id, job_id, status, respond_by, crew_token")
      .in("status", OPEN_TO_CREW as unknown as string[])
      .is("resolved_at", null),
    admin
      .from("vendor_lake_demotions")
      .select("lake_id, demoted_at, lakes(name)")
      .eq("vendor_id", vendorId),
    getPlatformSettings(),
  ]);

  // An empty list here reads as "nothing needs you", which is the single most
  // reassuring sentence on the page and the one it must never guess at.
  const disputes = mustRead("what's waiting on you", disputesRes);
  const pauses = mustRead("your standing on each lake", pausesRes);

  const disputedJobIds = [...new Set((disputes ?? []).map((d) => d.job_id as string).filter(Boolean))];
  const jobs = disputedJobIds.length
    ? mustRead(
        "the jobs those are about",
        await admin
          .from("jobs")
          .select("id, services(name), properties(address, nickname)")
          .eq("vendor_id", vendorId)
          .in("id", disputedJobIds),
      )
    : [];

  const jobById = new Map((jobs ?? []).map((j) => [j.id as string, j]));
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);

  const held = (disputes ?? [])
    // Not this crew's job — or a job we could not match — is not their problem.
    .filter((d) => jobById.has(d.job_id as string))
    .map((d) => {
      const job = jobById.get(d.job_id as string);
      const svc = job && (one((job as { services?: unknown }).services) as { name?: string } | null);
      const prop = job && (one((job as { properties?: unknown }).properties) as { address?: string; nickname?: string } | null);
      return {
        disputeId: d.id as string,
        jobId: d.job_id as string,
        service: svc?.name ?? null,
        where: prop?.nickname || prop?.address || null,
        respondBy: (d.respond_by as string | null) ?? null,
        token: (d.crew_token as string | null) ?? null,
      };
    })
    // Soonest deadline first — the one with a clock is the one to answer.
    // A dispute with no deadline set sorts last rather than first, which is
    // what `respondBy ?? "9999"` is doing.
    .sort((a, b) => (a.respondBy ?? "9999").localeCompare(b.respondBy ?? "9999"));

  const now = Date.now();
  const pausedLakes = (pauses ?? [])
    .filter((p) => isCoolingDown(p.demoted_at as string, settings.lakeDemotionCooldownDays, now))
    .map((p) => {
      const lake = one((p as { lakes?: unknown }).lakes) as { name?: string } | null;
      const lifts = new Date(Date.parse(p.demoted_at as string) + settings.lakeDemotionCooldownDays * 86_400_000);
      return { lake: lake?.name ?? "a lake", liftsOn: lifts.toISOString().slice(0, 10) };
    })
    .sort((a, b) => a.liftsOn.localeCompare(b.liftsOn));

  return { held, pausedLakes };
}
