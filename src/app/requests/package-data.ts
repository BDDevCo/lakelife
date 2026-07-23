import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * PACKAGE BREAKDOWNS for the owner's requests table (storage packages —
 * "package visits" whose per-leg pricing lives in job_items, OPS-ONLY at
 * RLS per 0032_storage_schema.sql).
 *
 * Trust boundary: the caller passes ids straight from its own RLS-scoped
 * owner_jobs query (same pattern as offer-data.ts's getScarcityOffers —
 * "ids the caller ALREADY verified it may see"), so no extra ownership
 * check is needed before the service-role reads below.
 *
 * job_items carries BOTH customer_price and vendor_cost on the SAME row
 * (rule 1 by arithmetic: owners must not see vendor_cost, vendors must
 * not see customer_price). Only customer_price is ever selected here —
 * vendor_cost never touches this function, this file, or the client.
 */

const one = <T,>(x: T | T[] | null | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

export interface PackageLeg {
  name: string;
  price: number;
}

export interface PackageBreakdown {
  legs: PackageLeg[];
  spring: { names: string[]; quote: number } | null;
}

/** Breakdown for every package-visit job among the given ids. Jobs with no
 *  group_id (ordinary, non-package jobs) are simply absent from the result. */
export async function getPackageBreakdowns(jobIds: string[]): Promise<Record<string, PackageBreakdown>> {
  const out: Record<string, PackageBreakdown> = {};
  if (jobIds.length === 0) return out;
  const admin = createServiceClient();

  const { data: jobRows } = await admin
    .from("jobs")
    .select("id, group_id")
    .in("id", jobIds)
    .not("group_id", "is", null);
  const packageJobs = (jobRows ?? []) as { id: string; group_id: string }[];
  if (packageJobs.length === 0) return out;

  const jobIdsWithGroup = packageJobs.map((j) => j.id);
  const groupIds = [...new Set(packageJobs.map((j) => j.group_id))];

  const [{ data: itemRows }, { data: groupRows }] = await Promise.all([
    // NEVER select vendor_cost — job_items is OPS-ONLY at RLS precisely
    // because that column lives on this same row.
    admin.from("job_items").select("job_id, customer_price, services(name)").in("job_id", jobIdsWithGroup),
    admin.from("job_groups").select("id, spring_quote, spring_service_ids").in("id", groupIds),
  ]);

  const springIds = [
    ...new Set((groupRows ?? []).flatMap((g) => ((g as { spring_service_ids?: string[] }).spring_service_ids ?? []))),
  ];
  const springNameById = new Map<string, string>();
  if (springIds.length > 0) {
    const { data: svcRows } = await admin.from("services").select("id, name").in("id", springIds);
    for (const s of svcRows ?? []) springNameById.set(s.id as string, s.name as string);
  }

  const groupById = new Map((groupRows ?? []).map((g) => [g.id as string, g as { spring_quote: number; spring_service_ids: string[] }]));

  const legsByJobId = new Map<string, PackageLeg[]>();
  for (const item of (itemRows ?? []) as { job_id: string; customer_price: number; services: unknown }[]) {
    const svc = one(item.services as { name?: string } | { name?: string }[] | null);
    const list = legsByJobId.get(item.job_id) ?? [];
    list.push({ name: svc?.name ?? "Service", price: Number(item.customer_price ?? 0) });
    legsByJobId.set(item.job_id, list);
  }

  for (const job of packageJobs) {
    const group = groupById.get(job.group_id);
    const springServiceIds = group?.spring_service_ids ?? [];
    const spring =
      springServiceIds.length > 0
        ? { names: springServiceIds.map((id) => springNameById.get(id) ?? "Service"), quote: Number(group?.spring_quote ?? 0) }
        : null;
    out[job.id] = { legs: legsByJobId.get(job.id) ?? [], spring };
  }

  return out;
}
