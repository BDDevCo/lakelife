import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export interface OwnerFlag {
  id: string;
  type: string | null;
  note: string | null;
  status: string;
  created_at: string;
  service_name: string | null;
  address: string | null;
  proposed_change: Record<string, unknown> | null;
  /** Raised by the crew standing on site, before starting (0084). */
  at_arrival: boolean;
  /**
   * The crew's answer to "if they say no, can you still do what was booked?"
   * FALSE means declining stands them down — no work today. It has to reach
   * this screen, or the owner taps "no" believing they'll get a smaller job
   * when what they'll actually get is a crew driving away (0088).
   */
  crew_can_proceed: boolean | null;
  crew_cannot_reason: string | null;
}

/** Flags awaiting the signed-in owner's decision (plus recent decided ones). */
export async function getOwnerFlags(): Promise<OwnerFlag[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  // Service role + an explicit owner filter through the join: reliable
  // regardless of RLS, and the nested job/service/property embed (otherwise
  // RLS-blocked on the ops-only jobs table) resolves.
  const admin = createServiceClient();
  const { data } = await admin
    .from("flags")
    // `jobs!flags_job_id_fkey` NAMES THE RELATIONSHIP ON PURPOSE.
    // 0084 added jobs.held_flag_id -> flags(id), so there are now TWO
    // foreign keys between these tables. A bare `jobs(...)` became
    // ambiguous and PostgREST answers 300 PGRST201 — which supabase-js
    // surfaces as {error, data:null}, i.e. an EMPTY approvals screen with
    // nothing logged. Naming the key is the fix and the documentation.
    .select("id, type, note, status, created_at, proposed_change, at_arrival, crew_can_proceed, crew_cannot_reason, jobs!flags_job_id_fkey!inner(services(name), properties!inner(address, owner_id))")
    .eq("jobs.properties.owner_id", user.id)
    .order("created_at", { ascending: false });

  return (data ?? [])
    .map((f) => {
      const job = Array.isArray(f.jobs) ? f.jobs[0] : f.jobs;
      const svc = job && (Array.isArray(job.services) ? job.services[0] : job.services);
      const prop = job && (Array.isArray(job.properties) ? job.properties[0] : job.properties);
      return {
        id: f.id as string,
        type: f.type as string | null,
        note: f.note as string | null,
        status: f.status as string,
        created_at: f.created_at as string,
        service_name: (svc as { name?: string } | null)?.name ?? null,
        address: (prop as { address?: string } | null)?.address ?? null,
        proposed_change: (f.proposed_change as Record<string, unknown> | null) ?? null,
        at_arrival: !!f.at_arrival,
        crew_can_proceed: (f.crew_can_proceed as boolean | null) ?? null,
        crew_cannot_reason: (f.crew_cannot_reason as string | null) ?? null,
      };
    });
}
