import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";

/**
 * Ops-side scheduling calendar: every job in a given calendar year, flattened
 * for client-side rendering (month/year views, lake filter). Logistics only —
 * no dollar amounts (rule 1 doesn't require it here, but there's nothing for
 * the calendar to show anyway). Service-role read, gated by assertOps like
 * getNeedsAttention / getMarginHealth. Never import into a vendor/owner surface.
 */

const CAL_STATUSES = ["requested", "scheduled", "in_progress", "complete", "paid"] as const;

export interface CalRow {
  id: string;
  date: string; // YYYY-MM-DD
  status: string;
  service_name: string | null;
  lake_id: string | null;
  lake_name: string | null;
  address: string | null;
  crew: string | null; // vendor company, or null when unassigned
}

type Embed<T> = T | T[] | null;
const first = <T>(x: Embed<T> | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

interface CalRaw {
  id: string;
  date: string | null;
  status: string;
  services: Embed<{ name: string | null }>;
  vendors: Embed<{ company: string | null }>;
  properties: Embed<{ address: string | null; lake_id: string | null; lakes: Embed<{ name: string | null }> }>;
}

/** All jobs dated within `year`, ops-only, for the calendar tab. */
export async function getOpsCalendar(year: number): Promise<CalRow[]> {
  const ops = await assertOps();
  if (!ops) return [];

  const admin = createServiceClient();
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  const { data } = await admin
    .from("jobs")
    .select(
      "id, date, status, services(name), vendors(company), properties(address, lake_id, lakes(name))",
    )
    .gte("date", start)
    .lte("date", end)
    .in("status", CAL_STATUSES as unknown as string[])
    .order("date", { ascending: true })
    .limit(3000); // beta volume comfortably fits a single year in one page

  const rows = (data ?? []) as unknown as CalRaw[];

  return rows
    .filter((r) => r.date != null)
    .map((r) => {
      const svc = first(r.services);
      const vend = first(r.vendors);
      const prop = first(r.properties);
      const lake = first(prop?.lakes);
      return {
        id: r.id as string,
        date: r.date as string,
        status: r.status as string,
        service_name: svc?.name ?? null,
        lake_id: prop?.lake_id ?? null,
        lake_name: lake?.name ?? null,
        address: prop?.address ?? null,
        crew: vend?.company ?? null,
      };
    });
}
