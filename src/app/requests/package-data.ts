import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { getPlatformSettings } from "@/lib/settings";
import { seasonEndFor, overstayDays, perdiemCharge } from "@/lib/storage";
import { todayLakeDate } from "@/lib/booking";

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

/**
 * STORAGE STATUS for the owner's requests page ("your boat is tucked in"
 * card). Trust boundary: same pattern as getPackageBreakdowns above — the
 * caller passes job_group ids straight from its own RLS-scoped job_groups
 * query (job_groups_read policy already lets the owner see their own
 * groups directly), so no extra ownership check is needed before the
 * service-role reads below.
 *
 * storage_stays is OPS/vendor-only at RLS (0032_storage_schema.sql —
 * "homeowners get status through the requests UI server-side"), so this
 * function is that server-side shaping. Only customer-safe fields are
 * selected: the crew's public company name, the intake date, the season
 * end (computed from the platform dials), the spring quote (customer
 * price, quoted at booking), and the per-diem dollar rate/running meter.
 * NEVER vendor_cost, boat rates, or anything else off job_items/vendors.
 */

export interface StorageStatusCard {
  groupId: string;
  vendorCompany: string;
  intakeAt: string; // ISO date (YYYY-MM-DD)
  seasonEnd: string; // ISO date (YYYY-MM-DD)
  springQuote: number;
  perdiemDaily: number;
  meterDollars: number | null; // null until today is past season end
}

/** Status cards for every job_group id (already owner-verified) that has a
 *  boat currently in_storage. Groups with no matching in_storage stay are
 *  simply absent from the result. */
export async function getStorageStatusCards(groupIds: string[]): Promise<StorageStatusCard[]> {
  const out: StorageStatusCard[] = [];
  if (groupIds.length === 0) return out;
  const admin = createServiceClient();

  const [{ data: groupRows }, settings] = await Promise.all([
    admin.from("job_groups").select("id, spring_quote").in("id", groupIds),
    getPlatformSettings(),
  ]);
  const groups = (groupRows ?? []) as { id: string; spring_quote: number }[];
  if (groups.length === 0) return out;

  const { data: stayRows } = await admin
    .from("storage_stays")
    .select("group_id, intake_at, vendors(company)")
    .in("group_id", groups.map((g) => g.id))
    .eq("status", "in_storage");

  const springQuoteByGroup = new Map(groups.map((g) => [g.id, Number(g.spring_quote ?? 0)]));
  const today = todayLakeDate();

  for (const stay of (stayRows ?? []) as { group_id: string; intake_at: string | null; vendors: unknown }[]) {
    if (!stay.intake_at) continue;
    const vendor = one(stay.vendors as { company?: string } | { company?: string }[] | null);
    const intakeAt = stay.intake_at.slice(0, 10);
    const seasonEnd = seasonEndFor(intakeAt, settings.storageSeasonEndMonth, settings.storageSeasonEndDay);
    const days = overstayDays(today, seasonEnd);
    const meterDollars = days > 0 ? perdiemCharge(days, settings.storagePerdiemDaily) : null;
    out.push({
      groupId: stay.group_id,
      vendorCompany: vendor?.company ?? "your crew",
      intakeAt,
      seasonEnd,
      springQuote: springQuoteByGroup.get(stay.group_id) ?? 0,
      perdiemDaily: settings.storagePerdiemDaily,
      meterDollars,
    });
  }

  return out;
}
