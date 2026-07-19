import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";

/** The one place margin lives (rule 1): ops-only. Everything here is service-role
 *  read, gated by assertOps — never import this into a vendor/owner surface. */

export interface OpsUser {
  id: string;
  name: string | null;
}

/** Returns the signed-in user IFF their role is 'ops', else null. */
export async function assertOps(): Promise<OpsUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("users").select("id, name, role").eq("id", user.id).maybeSingle();
  if (!data || data.role !== "ops") return null;
  return { id: data.id as string, name: (data.name as string) ?? null };
}

// ---- KPI header -----------------------------------------------------------

export interface OpsSummary {
  requestsWaiting: number;
  jobsThisWeek: number;
  weekRevenue: number; // sum of customer_price on this week's scheduled+ jobs
  weekMargin: number; // sum of margin on this week's scheduled+ jobs
  weekMarginPct: number; // blended
}

function weekBounds(): { start: string; end: string } {
  // Mon–Sun window around today's lake date (string math, no TZ surprises).
  const today = todayLakeDate();
  const d = new Date(today + "T12:00:00");
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  const mon = new Date(d);
  mon.setDate(d.getDate() - dow);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const iso = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { start: iso(mon), end: iso(sun) };
}

export async function getOpsSummary(): Promise<OpsSummary> {
  const admin = createServiceClient();
  const { start, end } = weekBounds();

  const { count: requestsWaiting } = await admin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "requested");

  const { data: week } = await admin
    .from("jobs")
    .select("customer_price, margin")
    .gte("date", start)
    .lte("date", end)
    .in("status", ["scheduled", "in_progress", "complete", "paid"]);

  const rows = week ?? [];
  const weekRevenue = rows.reduce((s, r) => s + Number(r.customer_price ?? 0), 0);
  const weekMargin = rows.reduce((s, r) => s + Number(r.margin ?? 0), 0);
  return {
    requestsWaiting: requestsWaiting ?? 0,
    jobsThisWeek: rows.length,
    weekRevenue,
    weekMargin,
    weekMarginPct: weekRevenue > 0 ? Math.round((weekMargin / weekRevenue) * 1000) / 10 : 0,
  };
}

// ---- Job board ------------------------------------------------------------

export interface OpsJob {
  id: string;
  status: string;
  date: string | null;
  slot: string | null;
  frequency: string | null;
  service_id: string | null;
  service_name: string | null;
  address: string | null;
  lake_name: string | null;
  owner_name: string | null;
  customer_price: number | null;
  vendor_cost: number | null;
  margin: number | null;
  vendor_id: string | null;
  vendor_company: string | null;
  photo_count: number;
  min_photos: number;
}

const BOARD_STATUSES = ["requested", "scheduled", "in_progress", "complete", "paid"] as const;

// Deeply-nested embeds confuse supabase-js type inference (it collapses the row
// to an error type). We assert the shape we asked for; `first()` tolerates the
// array-vs-object ambiguity the client leaves on embedded relations.
type Embed<T> = T | T[] | null;
interface JobBoardRaw {
  id: string;
  status: string;
  date: string | null;
  slot: string | null;
  frequency: string | null;
  service_id: string | null;
  customer_price: number | null;
  vendor_cost: number | null;
  margin: number | null;
  vendor_id: string | null;
  services: Embed<{ name: string | null; min_photos: number | null }>;
  properties: Embed<{ address: string | null; lakes: Embed<{ name: string | null }>; users: Embed<{ name: string | null }> }>;
  vendors: Embed<{ company: string | null }>;
}

export async function getJobBoard(): Promise<OpsJob[]> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("jobs")
    .select(
      "id, status, date, slot, frequency, service_id, customer_price, vendor_cost, margin, vendor_id, " +
        "services(name, min_photos), properties(address, lakes(name), users(name)), vendors(company)",
    )
    .in("status", BOARD_STATUSES as unknown as string[])
    .order("date", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true });

  const rows = (data ?? []) as unknown as JobBoardRaw[];
  const ids = rows.map((r) => r.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    const { data: photos } = await admin.from("job_photos").select("job_id").in("job_id", ids);
    for (const p of photos ?? []) counts.set(p.job_id, (counts.get(p.job_id) ?? 0) + 1);
  }

  const first = <T>(x: T | T[] | null | undefined): T | null =>
    x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

  return rows.map((r) => {
    const svc = first(r.services as unknown);
    const prop = first(r.properties as unknown) as
      | { address?: string; lakes?: unknown; users?: unknown }
      | null;
    const lake = first(prop?.lakes) as { name?: string } | null;
    const owner = first(prop?.users) as { name?: string } | null;
    const vend = first(r.vendors as unknown) as { company?: string } | null;
    return {
      id: r.id as string,
      status: r.status as string,
      date: (r.date as string) ?? null,
      slot: (r.slot as string) ?? null,
      frequency: (r.frequency as string) ?? null,
      service_id: (r.service_id as string) ?? null,
      service_name: (svc as { name?: string } | null)?.name ?? null,
      address: prop?.address ?? null,
      lake_name: lake?.name ?? null,
      owner_name: owner?.name ?? null,
      customer_price: r.customer_price == null ? null : Number(r.customer_price),
      vendor_cost: r.vendor_cost == null ? null : Number(r.vendor_cost),
      margin: r.margin == null ? null : Number(r.margin),
      vendor_id: (r.vendor_id as string) ?? null,
      vendor_company: vend?.company ?? null,
      photo_count: counts.get(r.id as string) ?? 0,
      min_photos: (svc as { min_photos?: number } | null)?.min_photos ?? 0,
    };
  });
}

// ---- Eligible vendors for a job (COI gate) --------------------------------

export interface EligibleVendor {
  id: string;
  company: string | null;
  coi_ok: boolean;
  coi_expiry: string | null;
  service_ok: boolean;
  daily_capacity: number;
}

/** Active vendors annotated with COI validity + whether they list this service.
 *  Spec: no valid COI ⇒ not routable. We surface all active vendors but the
 *  server assign action HARD-blocks anyone whose COI isn't valid. */
export async function getEligibleVendors(serviceName: string | null): Promise<EligibleVendor[]> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const { data } = await admin
    .from("vendors")
    .select("id, company, coi_expiry, service_types, daily_capacity, status")
    .eq("status", "active")
    .order("company", { ascending: true });

  const svc = (serviceName ?? "").toLowerCase();
  return (data ?? []).map((v) => {
    const types = (v.service_types as string[] | null) ?? [];
    // Empty service_types = generalist (matches anything); else token overlap.
    const service_ok =
      types.length === 0 ||
      types.some((t) => {
        const tt = String(t).toLowerCase();
        return svc.includes(tt) || tt.includes(svc.split(" ")[0]);
      });
    const coi_ok = v.coi_expiry != null && String(v.coi_expiry) >= today;
    return {
      id: v.id as string,
      company: (v.company as string) ?? null,
      coi_ok,
      coi_expiry: (v.coi_expiry as string) ?? null,
      service_ok,
      daily_capacity: Number(v.daily_capacity ?? 0),
    };
  });
}

export interface ActiveVendor {
  id: string;
  company: string | null;
  coi_ok: boolean;
  coi_expiry: string | null;
  service_types: string[];
  daily_capacity: number;
}

/** All active vendors, annotated with COI validity. The assign modal filters
 *  by the specific job's service; the server re-checks COI on submit. */
export async function getActiveVendors(): Promise<ActiveVendor[]> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const { data } = await admin
    .from("vendors")
    .select("id, company, coi_expiry, service_types, daily_capacity")
    .eq("status", "active")
    .order("company", { ascending: true });
  return (data ?? []).map((v) => ({
    id: v.id as string,
    company: (v.company as string) ?? null,
    coi_ok: v.coi_expiry != null && String(v.coi_expiry) >= today,
    coi_expiry: (v.coi_expiry as string) ?? null,
    service_types: (v.service_types as string[] | null) ?? [],
    daily_capacity: Number(v.daily_capacity ?? 0),
  }));
}

// ---- Revenue & margin by service line -------------------------------------

export interface MarginRow {
  service_name: string;
  jobs: number;
  customer_total: number;
  vendor_total: number;
  margin_total: number;
  margin_pct: number;
}

export async function getMarginByService(): Promise<{ rows: MarginRow[]; total: MarginRow }> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("jobs")
    .select("customer_price, vendor_cost, margin, services(name)")
    .in("status", ["scheduled", "in_progress", "complete", "paid"]);

  const byName = new Map<string, MarginRow>();
  for (const r of data ?? []) {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    const name = (svc as { name?: string } | null)?.name ?? "Unassigned service";
    const row = byName.get(name) ?? {
      service_name: name,
      jobs: 0,
      customer_total: 0,
      vendor_total: 0,
      margin_total: 0,
      margin_pct: 0,
    };
    row.jobs += 1;
    row.customer_total += Number(r.customer_price ?? 0);
    row.vendor_total += Number(r.vendor_cost ?? 0);
    row.margin_total += Number(r.margin ?? 0);
    byName.set(name, row);
  }

  const rows = [...byName.values()].map((r) => ({
    ...r,
    margin_pct: r.customer_total > 0 ? Math.round((r.margin_total / r.customer_total) * 1000) / 10 : 0,
  }));
  rows.sort((a, b) => b.customer_total - a.customer_total);

  const total = rows.reduce(
    (t, r) => ({
      service_name: "Total",
      jobs: t.jobs + r.jobs,
      customer_total: t.customer_total + r.customer_total,
      vendor_total: t.vendor_total + r.vendor_total,
      margin_total: t.margin_total + r.margin_total,
      margin_pct: 0,
    }),
    { service_name: "Total", jobs: 0, customer_total: 0, vendor_total: 0, margin_total: 0, margin_pct: 0 } as MarginRow,
  );
  total.margin_pct = total.customer_total > 0 ? Math.round((total.margin_total / total.customer_total) * 1000) / 10 : 0;

  return { rows, total };
}

// ---- Routes ----------------------------------------------------------------

export interface RouteSummary {
  id: string;
  date: string;
  vendor_company: string | null;
  stops: number;
  drive_minutes: number | null;
  map_url: string | null;
}

/** Tomorrow's built routes (or a given date's). */
export async function getRoutesForDate(dateISO: string): Promise<RouteSummary[]> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("routes")
    .select("id, date, stops_order, drive_minutes, map_url, vendors(company)")
    .eq("date", dateISO)
    .order("created_at", { ascending: true });
  return (data ?? []).map((r) => {
    const v = Array.isArray(r.vendors) ? r.vendors[0] : r.vendors;
    return {
      id: r.id as string,
      date: r.date as string,
      vendor_company: (v as { company?: string } | null)?.company ?? null,
      stops: Array.isArray(r.stops_order) ? r.stops_order.length : 0,
      drive_minutes: r.drive_minutes == null ? null : Number(r.drive_minutes),
      map_url: (r.map_url as string) ?? null,
    };
  });
}

// ---- Lake conditions ------------------------------------------------------

export interface LakeCondition {
  id: string;
  name: string;
  ice_out_actual: string | null;
  hard_freeze_est: string | null;
  pull_deadline: string | null;
  active_properties: number;
}

export async function getLakeConditions(): Promise<LakeCondition[]> {
  const admin = createServiceClient();
  const { data: lakes } = await admin
    .from("lakes")
    .select("id, name, ice_out_actual, hard_freeze_est, pull_deadline")
    .order("name", { ascending: true });

  const { data: props } = await admin.from("properties").select("lake_id");
  const byLake = new Map<string, number>();
  for (const p of props ?? []) if (p.lake_id) byLake.set(p.lake_id, (byLake.get(p.lake_id) ?? 0) + 1);

  return (lakes ?? []).map((l) => ({
    id: l.id as string,
    name: l.name as string,
    ice_out_actual: (l.ice_out_actual as string) ?? null,
    hard_freeze_est: (l.hard_freeze_est as string) ?? null,
    pull_deadline: (l.pull_deadline as string) ?? null,
    active_properties: byLake.get(l.id as string) ?? 0,
  }));
}
