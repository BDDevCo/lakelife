"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import {
  REVENUE_STREAMS, allStreamStatuses,
  type ParkFacts, type StreamStatus,
} from "./revenue-streams";
import type { ParkResult } from "./actions";

const DENIED = "You don't manage that park.";

/** Save which streams this park runs. Allowlisted here as well as in the
 *  database — an unknown value is dropped rather than stored and ignored. */
export async function saveRevenueStreams(
  parkId: string,
  streams: string[],
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const allowed = new Set<string>(REVENUE_STREAMS);
  const clean = [...new Set(streams.filter((s) => allowed.has(s)))];

  const admin = createServiceClient();
  const { error } = await admin
    .from("parks").update({ revenue_streams: clean }).eq("id", parkId);
  if (error) return { ok: false, error: "Couldn't save that — try again." };

  revalidatePath("/park/setup");
  revalidatePath("/park");
  return {
    ok: true,
    signal: clean.length === 0
      ? "Nothing selected — pick what your park earns from when you're ready."
      : `Saved. ${clean.length} income ${clean.length === 1 ? "stream" : "streams"}.`,
  };
}

/**
 * The park's actual facts, for the readiness check.
 *
 * Counted from the park's own data every time rather than cached: a stored
 * "ready" goes stale the moment somebody deletes a lot.
 */
export async function parkStreamStatuses(parkId: string): Promise<StreamStatus[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();

  const [{ data: park }, { data: lots }, { data: costs }] = await Promise.all([
    admin.from("parks").select("revenue_streams").eq("id", parkId).maybeSingle(),
    admin.from("park_lots")
      .select("id, site_type, rental_mode, lifecycle, park_owned_home")
      .eq("park_id", parkId),
    admin.from("park_costs").select("id").eq("park_id", parkId).limit(1),
  ]);

  const { data: fees } = await admin
    .from("park_fees").select("id").eq("park_id", parkId).eq("active", true);

  const all = lots ?? [];
  const live = all.filter((l) => (l.lifecycle as string) === "live");

  const ids = live.map((l) => l.id as string);
  let lotsWithRates = 0;
  if (ids.length) {
    const { data: rates } = await admin
      .from("lot_rates").select("park_lot_id").in("park_lot_id", ids);
    lotsWithRates = new Set((rates ?? []).map((r) => r.park_lot_id as string)).size;
  }

  const facts: ParkFacts = {
    longTermLots: live.filter(
      (l) => (l.rental_mode as string) !== "short_term"
        && !["slip", "storage"].includes(l.site_type as string),
    ).length,
    shortTermLots: live.filter((l) => (l.rental_mode as string) === "short_term").length,
    slipLots: live.filter((l) => (l.site_type as string) === "slip").length,
    storageLots: live.filter((l) => (l.site_type as string) === "storage").length,
    parkOwnedHomes: live.filter((l) => l.park_owned_home === true).length,
    notYetLive: all.filter((l) =>
      ["planned", "renovating"].includes(l.lifecycle as string)).length,
    lotsWithRates,
    costsRecorded: (costs ?? []).length,
    feesConfigured: (fees ?? []).length,
  };

  return allStreamStatuses((park?.revenue_streams as string[]) ?? [], facts);
}
