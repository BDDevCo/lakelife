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
    .select("id, type, note, status, created_at, proposed_change, jobs!inner(services(name), properties!inner(address, owner_id))")
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
      };
    });
}
