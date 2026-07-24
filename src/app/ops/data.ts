import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";
import { marginPct } from "@/lib/dispatch";

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
  invoice_status: string | null; // 'due' | 'paid' | 'refunded' | ... — drives the Refund button + "↩ refunded" pill
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
  const invoiceStatus = new Map<string, string>();
  if (ids.length) {
    const { data: photos } = await admin.from("job_photos").select("job_id").in("job_id", ids);
    for (const p of photos ?? []) counts.set(p.job_id, (counts.get(p.job_id) ?? 0) + 1);

    // One invoice per job (refund-actions.ts assumes the same) — used only to
    // drive the ops "Refund…" button / "↩ refunded" pill. Never joined into any
    // customer or vendor read (rule 1 doesn't apply here — this IS the ops board).
    const { data: invoices } = await admin.from("invoices").select("job_id, status").in("job_id", ids);
    for (const inv of invoices ?? []) if (inv.job_id) invoiceStatus.set(inv.job_id as string, inv.status as string);
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
      invoice_status: invoiceStatus.get(r.id as string) ?? null,
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
  unit_name: string | null; // set on fleet (per-truck) routes; null on legacy single-route
  drive_km: number | null;
  est_miles: number | null; // drive_km × 0.621, 1 decimal (display only)
  est_fuel: number | null; // est_miles × fuel_cost_per_mile dial, 2 decimals (display only)
}

const KM_TO_MILES = 0.621;

/** fuel_cost_per_mile dial (0.65 default) — the ops-display-only economics
 *  in docs/fleet-routing-design.md. getPlatformSettings doesn't carry this
 *  key yet, so read the platform_settings row directly; fall back to the
 *  migration 0042 default if the row is missing or unreachable. */
async function fuelCostPerMile(admin: ReturnType<typeof createServiceClient>): Promise<number> {
  try {
    const settings = await getPlatformSettings();
    const fromSettings = (settings as unknown as { fuelCostPerMile?: number }).fuelCostPerMile;
    if (typeof fromSettings === "number" && Number.isFinite(fromSettings)) return fromSettings;
  } catch {
    // getPlatformSettings unreachable — fall through to a direct read.
  }
  const { data } = await admin.from("platform_settings").select("value").eq("key", "fuel_cost_per_mile").maybeSingle();
  const n = Number(data?.value);
  return Number.isFinite(n) ? n : 0.65;
}

/** Tomorrow's built routes (or a given date's). */
export async function getRoutesForDate(dateISO: string): Promise<RouteSummary[]> {
  const admin = createServiceClient();
  const [{ data }, fuelDial] = await Promise.all([
    admin
      .from("routes")
      .select("id, date, stops_order, drive_minutes, map_url, unit_name, drive_km, vendors(company)")
      .eq("date", dateISO)
      .order("created_at", { ascending: true }),
    fuelCostPerMile(admin),
  ]);
  return (data ?? []).map((r) => {
    const v = Array.isArray(r.vendors) ? r.vendors[0] : r.vendors;
    const driveKm = r.drive_km == null ? null : Number(r.drive_km);
    const estMiles = driveKm == null ? null : Math.round(driveKm * KM_TO_MILES * 10) / 10;
    const estFuel = estMiles == null ? null : Math.round(estMiles * fuelDial * 100) / 100;
    return {
      id: r.id as string,
      date: r.date as string,
      vendor_company: (v as { company?: string } | null)?.company ?? null,
      stops: Array.isArray(r.stops_order) ? r.stops_order.length : 0,
      drive_minutes: r.drive_minutes == null ? null : Number(r.drive_minutes),
      map_url: (r.map_url as string) ?? null,
      unit_name: (r.unit_name as string) ?? null,
      drive_km: driveKm,
      est_miles: estMiles,
      est_fuel: estFuel,
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

// ---- Margin health (per service × lake) -----------------------------------
// The owner's menu-tuning instrument (pricing discussion, 2026-07-22): for
// each service on each lake — how much business, what blended margin, how
// many crews could actually take the work, and how much demand is WAITING.
// Reading it: high margin + waiting demand ⇒ consider a menu cut or recruit;
// margin pinned near the floor ⇒ menu price is too low for that market;
// waiting > 0 with 0 rated crews ⇒ recruiting (not pricing) is the unblock.
//
// Fill-in rates etiology (docs/margin-gap-design.md, 2026-07-23): waiting
// demand splits into two root causes and the split drives a different fix.
// capacity_stranded — a truly ready crew exists (clears every dispatch gate,
// margin floor included) but calendars are full ⇒ recruit/expand. margin_
// stranded — every crew that lists the service here HAS a rate on file but
// none of them clears the floor ⇒ the MENU is priced under the market; the
// fill-in claims proves it. Neither fires when no crew lists the service at
// all — that stays the plain recruit signal it always was.

export interface MarginHealthRow {
  service_name: string;
  lake_name: string;
  jobs: number; // booked/completed volume carrying real margin data
  margin_pct: number; // blended, one decimal
  crews_with_rate: number; // active+insured crews serving this lake whose rate ALSO clears the margin floor — i.e. truly ready to take the work, not merely priced
  waiting: number; // requested & unassigned future jobs (live demand signal)
  etiology: "capacity_stranded" | "margin_stranded" | null; // why waiting demand isn't clearing (null when waiting === 0, or when no crew lists the service at all)
  /** One-tap price-up candidate for margin_stranded rows only (never a cut).
   *  The smallest menu raise that clears the floor for the CHEAPEST
   *  floor-failing crew, translated back into the specific services field
   *  that moves for this pricing model. Absent when there's no floor-failing
   *  crew, or the raise needed would exceed the 40% sanity cap. */
  suggestion?: {
    label: string;
    serviceId: string;
    field: "base" | "unit_rate" | "band:medium" | "tier:mid";
    newValue: number;
  };
}

export async function getMarginHealth(): Promise<MarginHealthRow[]> {
  const ops = await assertOps();
  if (!ops) return [];
  const admin = createServiceClient();
  const today = todayLakeDate();
  const settings = await getPlatformSettings();

  const [{ data: jobs }, { data: waiting }, { data: vendors }, { data: rates }] = await Promise.all([
    admin
      .from("jobs")
      .select("customer_price, margin, service_id, services(name), properties(lake_id, lakes(name))")
      .in("status", ["scheduled", "in_progress", "complete", "paid"])
      .not("margin", "is", null),
    admin
      .from("jobs")
      .select("customer_price, service_id, services(name), properties(lake_id, lakes(name))")
      .eq("status", "requested")
      .is("vendor_id", null)
      .gte("date", today),
    admin.from("vendors").select("id, status, coi_expiry, service_types, service_lakes").eq("status", "active"),
    admin.from("vendor_rates").select("vendor_id, service_id, base, unit_rate, band_pricing"),
  ]);

  const key = (svc: string, lake: string) => `${svc}|${lake}`;
  const acc = new Map<
    string,
    MarginHealthRow & { price_total: number; margin_total: number; waiting_price_total: number; service_id: string | null; lake_id: string | null }
  >();
  const bump = (svcName: string, lakeName: string, svcId: string | null, lakeId: string | null) => {
    const k = key(svcName, lakeName);
    let row = acc.get(k);
    if (!row) {
      row = {
        service_name: svcName,
        lake_name: lakeName,
        jobs: 0,
        margin_pct: 0,
        crews_with_rate: 0,
        waiting: 0,
        etiology: null,
        price_total: 0,
        margin_total: 0,
        waiting_price_total: 0,
        service_id: svcId,
        lake_id: lakeId,
      };
      acc.set(k, row);
    }
    return row;
  };
  const unpack = (r: { services?: unknown; properties?: unknown; service_id?: string | null }) => {
    const svc = (Array.isArray(r.services) ? r.services[0] : r.services) as { name?: string } | null;
    const prop = (Array.isArray(r.properties) ? r.properties[0] : r.properties) as { lake_id?: string; lakes?: unknown } | null;
    const lake = (Array.isArray(prop?.lakes) ? prop?.lakes[0] : prop?.lakes) as { name?: string } | null;
    return { svcName: svc?.name ?? "Unassigned", lakeName: lake?.name ?? "No lake", svcId: (r.service_id as string) ?? null, lakeId: (prop?.lake_id as string) ?? null };
  };

  for (const r of jobs ?? []) {
    const u = unpack(r);
    const row = bump(u.svcName, u.lakeName, u.svcId, u.lakeId);
    row.jobs += 1;
    row.price_total += Number((r as { customer_price?: number }).customer_price ?? 0);
    row.margin_total += Number((r as { margin?: number }).margin ?? 0);
  }
  for (const r of waiting ?? []) {
    const u = unpack(r);
    const row = bump(u.svcName, u.lakeName, u.svcId, u.lakeId);
    row.waiting += 1;
    row.waiting_price_total += Number((r as { customer_price?: number }).customer_price ?? 0);
  }

  // Crews that could actually take the work: active, insured, do the service,
  // serve the lake, and have a rate on file for the service that ALSO clears
  // the margin floor. Split "has a rate" from "clears the floor" so a
  // service×lake with 0 truly-ready crews can still tell recruiting apart
  // from mispricing (see etiology note above).
  //
  // The floor test compares the crew's FULL rate row against the MENU's own
  // numbers, both priced the same way at a representative size per pricing
  // model (band → medium band, sqft_band → middle tier, per-unit → base +
  // unit × typical count). Apples-to-apples by construction — a base-only
  // test would blank out every band-priced crew (their base is $0) and wave
  // through per-unit crews whose margin actually erodes with size. This is
  // an aggregate instrument; exact per-job pricing stays in priceService
  // against the real property.
  const TYPICAL_PIER_SECTIONS = 6;
  const TYPICAL_BOAT_FEET = 22;
  const comparable = (
    pm: string | null,
    base: number,
    unit: number,
    bands: unknown,
  ): number | null => {
    const b = (bands ?? null) as { small?: number; medium?: number; large?: number; tiers?: { price?: number }[] } | null;
    switch (pm) {
      case "band": {
        const m = Number(b?.medium ?? 0);
        return m > 0 ? m : null;
      }
      case "per_sqft_band":
      case "sqft_band": {
        const tiers = Array.isArray(b?.tiers) ? b.tiers : [];
        const mid = Number(tiers[Math.floor(tiers.length / 2)]?.price ?? 0);
        return mid > 0 ? mid : null;
      }
      case "per_section": {
        const t = base + unit * TYPICAL_PIER_SECTIONS;
        return t > 0 ? t : null;
      }
      case "per_foot":
      case "seasonal_plus_perdiem": {
        // Storage rates are seeded base-0 with the money in unit_rate ($/ft),
        // same shape as per_foot — the default base-only branch would read
        // every storage crew as "no rate on file".
        const t = base + unit * TYPICAL_BOAT_FEET;
        return t > 0 ? t : null;
      }
      default:
        return base > 0 ? base : null;
    }
  };
  const rateRows = new Map((rates ?? []).map((r) => [`${r.vendor_id}|${r.service_id}`, r]));
  const insured = (vendors ?? []).filter((v) => v.coi_expiry != null && String(v.coi_expiry) >= today);
  const { data: svcRows } = await admin.from("services").select("id, name, pricing_model, base, unit_rate, band_pricing");
  const svcById = new Map((svcRows ?? []).map((s) => [s.id as string, s]));
  for (const row of acc.values()) {
    if (!row.service_id || !row.lake_id) continue;
    const svcRow = svcById.get(row.service_id);
    const svcName = (svcRow?.name as string) ?? row.service_name;
    const menuComparable = svcRow
      ? comparable(
          (svcRow.pricing_model as string) ?? null,
          Number(svcRow.base ?? 0),
          Number(svcRow.unit_rate ?? 0),
          svcRow.band_pricing,
        )
      : null;
    const listing = insured.filter(
      (v) =>
        ((v.service_types as string[]) ?? []).includes(svcName) &&
        ((v.service_lakes as string[]) ?? []).includes(row.lake_id as string),
    );

    let ready = 0;
    let floorFail = 0;
    let cheapestFailingComparable: number | null = null; // lowest-cost crew that STILL fails the floor — the suggestion targets this one
    for (const v of listing) {
      const vr = rateRows.get(`${v.id}|${row.service_id}`);
      if (!vr) continue; // no rate on file at all — not a floor failure, just unset
      const crewComparable = comparable(
        (svcRow?.pricing_model as string) ?? null,
        Number(vr.base ?? 0),
        Number(vr.unit_rate ?? 0),
        vr.band_pricing,
      );
      if (crewComparable == null) continue; // rate row carries no dollars — treat as unset
      if (menuComparable == null) {
        // Menu has no comparable number to test against — don't guess a
        // failure; count the crew as rated (the pre-fill-ins behavior).
        ready += 1;
        continue;
      }
      // The SAME marginPct/floor gate the dispatch and claim engines use
      // (rule 8, one formula), at the representative size.
      if (marginPct(menuComparable, crewComparable) < settings.marginFloor) {
        floorFail += 1;
        if (cheapestFailingComparable == null || crewComparable < cheapestFailingComparable) {
          cheapestFailingComparable = crewComparable;
        }
      } else ready += 1;
    }
    row.crews_with_rate = ready;
    if (row.waiting > 0) {
      if (ready > 0) row.etiology = "capacity_stranded";
      else if (floorFail > 0) row.etiology = "margin_stranded";
      // else: nobody here has priced the work at all — the plain recruit signal stands (etiology stays null).
    }

    // Suggestion (Margin Health price-up, docs/margin-gap-design.md follow-on):
    // margin_stranded only, and only when we have a concrete floor-failing
    // crew number to target. needed = smallest menu comparable that clears
    // the floor for the CHEAPEST floor-failing crew — raise that far and no
    // farther. Translated back into the specific field this pricing model
    // stores money in; never a cut, and capped at a 40% jump so a data
    // glitch can't propose something absurd.
    if (row.etiology === "margin_stranded" && cheapestFailingComparable != null && menuComparable != null && svcRow) {
      const floor = settings.marginFloor;
      const needed = Math.ceil(cheapestFailingComparable / (1 - floor));
      const deltaPct = (needed - menuComparable) / menuComparable;
      if (needed > menuComparable && deltaPct <= 0.4) {
        const pm = (svcRow.pricing_model as string) ?? null;
        const base = Number(svcRow.base ?? 0);
        const unit = Number(svcRow.unit_rate ?? 0);
        const round = (n: number) => Math.round(n);
        if (pm === "band") {
          row.suggestion = {
            label: `raise medium band $${round(menuComparable)} → $${needed}`,
            serviceId: row.service_id,
            field: "band:medium",
            newValue: needed,
          };
        } else if (pm === "per_sqft_band" || pm === "sqft_band") {
          row.suggestion = {
            label: `raise mid tier $${round(menuComparable)} → $${needed}`,
            serviceId: row.service_id,
            field: "tier:mid",
            newValue: needed,
          };
        } else if (pm === "per_section") {
          const newUnit = Math.ceil((needed - base) / TYPICAL_PIER_SECTIONS);
          if (newUnit > 0) {
            row.suggestion = {
              label: `raise per-section rate $${round(unit)} → $${newUnit}`,
              serviceId: row.service_id,
              field: "unit_rate",
              newValue: newUnit,
            };
          }
        } else if (pm === "per_foot" || pm === "seasonal_plus_perdiem") {
          const newUnit = Math.ceil((needed - base) / TYPICAL_BOAT_FEET);
          if (newUnit > 0) {
            row.suggestion = {
              label: `raise per-foot rate $${round(unit)} → $${newUnit}`,
              serviceId: row.service_id,
              field: "unit_rate",
              newValue: newUnit,
            };
          }
        } else {
          // flat (and any other base-only model)
          row.suggestion = {
            label: `raise base $${round(menuComparable)} → $${needed}`,
            serviceId: row.service_id,
            field: "base",
            newValue: needed,
          };
        }
      }
    }
  }

  const rows = [...acc.values()].map((r) => ({
    service_name: r.service_name,
    lake_name: r.lake_name,
    jobs: r.jobs,
    margin_pct: r.price_total > 0 ? Math.round((r.margin_total / r.price_total) * 1000) / 10 : 0,
    crews_with_rate: r.crews_with_rate,
    waiting: r.waiting,
    etiology: r.etiology,
    ...(r.suggestion ? { suggestion: r.suggestion } : {}),
  }));
  // Trouble first: waiting demand desc, then thin crews, then volume.
  rows.sort((a, b) => b.waiting - a.waiting || a.crews_with_rate - b.crews_with_rate || b.jobs - a.jobs);
  return rows;
}
