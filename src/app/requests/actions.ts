"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";

export interface CancelResult {
  ok: boolean;
  error?: string;
}

/**
 * Cancel one of the customer's own requests. Allowed while the job is still
 * `requested`, or `scheduled` with the service date still in the future —
 * once a crew is rolling (day-of or in progress), they call us instead.
 * Ownership and status are verified server-side; the delete runs with the
 * service role (owners have no direct write access to jobs).
 */
export async function cancelRequest(jobId: string): Promise<CancelResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const admin = createServiceClient();
  const { data: job } = await admin
    .from("jobs")
    .select("id, status, date, properties(owner_id)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "That request no longer exists." };

  const owner = (Array.isArray(job.properties) ? job.properties[0] : job.properties) as
    | { owner_id?: string }
    | null;
  if (owner?.owner_id !== user.id) {
    return { ok: false, error: "That request isn't yours to cancel." };
  }

  const cancellable =
    job.status === "requested" ||
    (job.status === "scheduled" && (!job.date || (job.date as string) > todayLakeDate()));
  if (!cancellable) {
    return {
      ok: false,
      error: "A crew is already on this one — text or call us and we'll sort it out.",
    };
  }

  // Status re-checked in the delete itself: if ops flipped this job to
  // in-progress between our read and now, nothing is deleted.
  const { error } = await admin
    .from("jobs")
    .delete()
    .eq("id", jobId)
    .in("status", ["requested", "scheduled"]);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
