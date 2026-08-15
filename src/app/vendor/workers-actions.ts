"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { likeLiteral } from "@/lib/sql-like";
import { getMyVendorId } from "./data";

/**
 * WHO WAS ACTUALLY HERE — the vendor's own roster, and who was on a job.
 *
 * OPTIONAL EVERYWHERE. A vendor who keeps no roster loses nothing they have
 * today: their statement attributes tips by truck (`routes.unit_name`) or says
 * "Crew not recorded", exactly as before. Nothing here gates a completion —
 * the photo gate is the only gate, and adding a second one would be a way to
 * stop a crew going home rather than a way to help an owner split a tip.
 *
 * THE LINE (0099, and it is the legal footing of the company): a worker is the
 * VENDOR'S data, held for them. It is never an input to LakeLife's routing,
 * pricing, crew standing or dispatch. Nothing in this file is imported by
 * anything under src/lib/router, src/app/book/dispatch or lake-standing, and
 * that is not an accident.
 */

/**
 * Is this job on the signed-in crew's route?
 *
 * A LOCAL copy rather than an import: the equivalent guard lives in
 * `actions.ts`, which carries "use server" — exporting it would turn a private
 * check into a server action reachable from any browser. That is exactly the
 * hole `raiseTripFees` had, and the fix is not to widen the export surface of
 * a "use server" file to save nine lines.
 */
async function myJob(jobId: string): Promise<{ id: string; property_id: string | null } | null> {
  const vendorId = await getMyVendorId();
  if (!vendorId || !jobId) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("jobs")
    // No customer_price / vendor_cost — rule 1 keeps price and margin out of
    // reach on the crew path by construction, not by remembering.
    .select("id, vendor_id, property_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!data || data.vendor_id !== vendorId) return null;
  return { id: data.id as string, property_id: (data.property_id as string) ?? null };
}

export interface Worker {
  id: string;
  name: string;
  active: boolean;
}

export interface WorkerResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

/** The signed-in vendor's roster, active first then alphabetical. */
export async function listWorkers(): Promise<Worker[]> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return [];
  const admin = createServiceClient();
  const { data } = await admin
    .from("crew_workers")
    .select("id, name, active")
    .eq("vendor_id", vendorId)
    .order("active", { ascending: false })
    .order("name", { ascending: true });
  return (data ?? []).map((w) => ({
    id: w.id as string,
    name: w.name as string,
    active: !!w.active,
  }));
}

export async function addWorker(rawName: string): Promise<WorkerResult> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return { ok: false, error: "Crews only." };

  const name = (rawName ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) return { ok: false, error: "Give them a name." };

  const admin = createServiceClient();
  const { error } = await admin
    .from("crew_workers")
    .insert({ vendor_id: vendorId, name });

  // 23505 is the per-vendor unique name. Read it as "already there" rather
  // than letting a raw constraint reach a person — and note the row may be
  // INACTIVE, which is the likelier reason somebody is re-adding a name.
  if (error) {
    if (error.code === "23505") {
      const { data: existing } = await admin
        .from("crew_workers")
        .select("id, active")
        .eq("vendor_id", vendorId)
        // Escaped like every other user-supplied value: a worker called
        // "Jo_Ann" would otherwise match "JoAnn" and reactivate the wrong
        // person. Scoped to this vendor's own roster, so the blast radius is
        // small — but an exception is how a rule stops being a rule.
        .ilike("name", likeLiteral(name))
        .maybeSingle();
      if (existing && !existing.active) {
        await admin.from("crew_workers").update({ active: true }).eq("id", existing.id);
        revalidatePath("/vendor/crew");
        return { ok: true, signal: `${name} is back on the list.` };
      }
      return { ok: false, error: `${name} is already on your list.` };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/vendor/crew");
  return { ok: true, signal: `${name} added.` };
}

/**
 * Take somebody off the picker without touching history.
 *
 * Never a delete. Seasonal crews turn over constantly, and last season's
 * statement must keep saying who did the work — `job_workers.name` is a
 * snapshot, but deleting the roster row for somebody who is merely gone for
 * the winter is a decision nobody meant to make.
 */
export async function setWorkerActive(workerId: string, active: boolean): Promise<WorkerResult> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return { ok: false, error: "Crews only." };

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("crew_workers")
    .update({ active })
    .eq("id", workerId)
    .eq("vendor_id", vendorId)      // scoped: never somebody else's roster
    .select("id, name")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That isn't on your list." };

  revalidatePath("/vendor/crew");
  return { ok: true, signal: active ? `${data.name} is back on.` : `${data.name} is off the list.` };
}

/** Who the crew said was on a job. */
export async function getJobWorkers(jobId: string): Promise<Worker[]> {
  if (!(await myJob(jobId))) return [];
  const admin = createServiceClient();
  const { data } = await admin
    .from("job_workers")
    .select("worker_id, name")
    .eq("job_id", jobId)
    .order("name", { ascending: true });
  return (data ?? []).map((r) => ({
    id: (r.worker_id as string) ?? "",
    name: r.name as string,
    active: true,
  }));
}

/**
 * Record who was on this job. Replaces whatever was there — the crew is
 * correcting a list, not appending to one.
 *
 * An EMPTY list is a legitimate answer and clears the record: somebody who
 * tapped the wrong name must be able to take it off, and refusing to store
 * "nobody, actually" would leave a wrong name on a statement forever.
 */
export async function setJobWorkers(jobId: string, workerIds: string[]): Promise<WorkerResult> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return { ok: false, error: "Crews only." };
  if (!(await myJob(jobId))) return { ok: false, error: "That job isn't on your route." };

  const admin = createServiceClient();

  // Resolve names from the roster, SCOPED TO THIS VENDOR — the id list comes
  // from a browser, so a worker id belonging to another company must resolve
  // to nothing rather than to a name.
  const ids = [...new Set((workerIds ?? []).filter(Boolean))].slice(0, 12);
  let rows: Array<{ job_id: string; worker_id: string; name: string }> = [];
  if (ids.length > 0) {
    const { data: roster } = await admin
      .from("crew_workers")
      .select("id, name")
      .eq("vendor_id", vendorId)
      .in("id", ids);
    rows = (roster ?? []).map((w) => ({
      job_id: jobId,
      worker_id: w.id as string,
      // THE SNAPSHOT. Copied now so renaming or removing somebody next season
      // cannot rewrite what this job's statement says (same reasoning as
      // `routes.unit_name`).
      name: w.name as string,
    }));
    if (rows.length === 0) return { ok: false, error: "We couldn't find those names on your list." };
  }

  await admin.from("job_workers").delete().eq("job_id", jobId);
  if (rows.length > 0) {
    const { error } = await admin.from("job_workers").insert(rows);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath("/vendor");
  revalidatePath(`/vendor/jobs/${jobId}`);
  return {
    ok: true,
    signal: rows.length === 0 ? "Cleared." : `Noted — ${rows.map((r) => r.name).join(", ")}.`,
  };
}

/**
 * WHO WAS HERE LAST TIME, for this property.
 *
 * The reason the picker is realistic rather than aspirational. A crew standing
 * in a driveway at four o'clock will not build a list from scratch; they will
 * confirm one. Weekly mowing is the same two people at the same house all
 * summer, so the right default is whoever came last — one tap to accept.
 *
 * Returns [] when we have never recorded anybody here, which is simply the
 * first visit and should read as an empty picker, not as an error.
 */
export async function lastWorkersAtProperty(jobId: string): Promise<string[]> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return [];
  const job = await myJob(jobId);
  if (!job?.property_id) return [];

  const admin = createServiceClient();

  // The vendor's own recent jobs at this property, newest first.
  const { data: priorJobs } = await admin
    .from("jobs")
    .select("id, date")
    .eq("property_id", job.property_id)
    .eq("vendor_id", vendorId)
    .neq("id", jobId)
    .order("date", { ascending: false })
    .limit(10);
  const priorIds = (priorJobs ?? []).map((j) => j.id as string);
  if (priorIds.length === 0) return [];

  const { data: recorded } = await admin
    .from("job_workers")
    .select("job_id, worker_id")
    .in("job_id", priorIds)
    .not("worker_id", "is", null);
  if (!recorded?.length) return [];

  // Take the most recent job that actually has names on it, not a blend of
  // several visits — "who came last time" is one visit, not an average.
  const firstWithNames = priorIds.find((id) => recorded.some((r) => r.job_id === id));
  if (!firstWithNames) return [];
  return recorded
    .filter((r) => r.job_id === firstWithNames)
    .map((r) => r.worker_id as string);
}

export interface WhoWasHereView {
  /** The vendor's active roster. Empty = they keep no list; show nothing. */
  roster: Worker[];
  /** Already recorded on this job. */
  selected: string[];
  /** Who came last time to this property — the one-tap default. */
  suggested: string[];
}

/**
 * Everything the driveway picker needs, in ONE call, loaded only when a crew
 * actually opens it.
 *
 * Lazily rather than with the day's stops on purpose. This is optional data on
 * an optional feature, and paying for it on every page load of the busiest
 * screen in the product — the one a crew opens at 6:55am on a phone with two
 * bars — to serve the minority who tap it would be the wrong trade.
 */
export async function getWhoWasHere(jobId: string): Promise<WhoWasHereView> {
  const empty: WhoWasHereView = { roster: [], selected: [], suggested: [] };
  const vendorId = await getMyVendorId();
  if (!vendorId) return empty;
  if (!(await myJob(jobId))) return empty;

  const [roster, already, suggested] = await Promise.all([
    listWorkers(),
    getJobWorkers(jobId),
    lastWorkersAtProperty(jobId),
  ]);

  const active = roster.filter((w) => w.active);
  if (active.length === 0) return empty;

  const known = new Set(active.map((w) => w.id));
  return {
    roster: active,
    selected: already.map((w) => w.id).filter((id) => known.has(id)),
    // Never suggest somebody who has since left the roster — the picker would
    // pre-tick a name that isn't on screen to untick.
    suggested: suggested.filter((id) => known.has(id)),
  };
}
