import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { assertOps } from "./data";

/**
 * Ops-side view of the auto-dispatch machine (Phase 8). Everything here is
 * service-role read, gated by assertOps — margin/customer price appear only
 * because this is the ops console (rule 1). Never import into a vendor/owner
 * surface.
 */

// ---- Needs-attention bucket -----------------------------------------------

export interface NeedsAttentionJob {
  id: string;
  property_id: string | null;
  service_name: string | null;
  address: string | null;
  lake_name: string | null;
  date: string | null;
  customer_price: number | null;
  reason: string; // best-effort human label for why no crew took it
  preferred_vendor: string | null; // property's preferred crew, if set
  preferred_company: string | null; // that crew's company name, if resolvable
}

type Embed<T> = T | T[] | null;
const first = <T>(x: Embed<T> | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

/**
 * Jobs the machine couldn't crew: still `requested`, no vendor, and dated today
 * or later. Best-effort reason:
 *  - if no active/insured crew even lists the service ⇒ "no crew for service",
 *  - otherwise ⇒ "all full or below the margin floor" (capacity/rate/price).
 * Newest date first (the most imminent unmet demand at the top).
 */
export async function getNeedsAttention(): Promise<NeedsAttentionJob[]> {
  const ops = await assertOps();
  if (!ops) return [];

  const admin = createServiceClient();
  const today = todayLakeDate();

  const { data } = await admin
    .from("jobs")
    .select(
      "id, property_id, date, customer_price, service_id, " +
        "services(name), properties(address, preferred_vendor, lake_id, lakes(name))",
    )
    .eq("status", "requested")
    .is("vendor_id", null)
    .gte("date", today)
    .order("date", { ascending: false });

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    property_id: string | null;
    date: string | null;
    customer_price: number | null;
    service_id: string | null;
    services: Embed<{ name: string | null }>;
    properties: Embed<{ address: string | null; preferred_vendor: string | null; lake_id: string | null; lakes: Embed<{ name: string | null }> }>;
  }>;

  if (rows.length === 0) return [];

  // Active, insured crews (for the reason heuristic — incl. WHICH lakes).
  const { data: vendors } = await admin
    .from("vendors")
    .select("service_types, service_lakes, coi_expiry, status")
    .eq("status", "active");
  const insured = (vendors ?? []).filter((v) => v.coi_expiry != null && String(v.coi_expiry) >= today);

  // Resolve preferred-crew company names in one shot.
  const prefIds = Array.from(
    new Set(
      rows
        .map((r) => (first(r.properties) as { preferred_vendor?: string } | null)?.preferred_vendor)
        .filter((x): x is string => !!x),
    ),
  );
  const companyById = new Map<string, string | null>();
  if (prefIds.length) {
    const { data: prefVendors } = await admin.from("vendors").select("id, company").in("id", prefIds);
    for (const v of prefVendors ?? []) companyById.set(v.id as string, (v.company as string) ?? null);
  }

  return rows.map((r) => {
    const svc = first(r.services) as { name?: string } | null;
    const prop = first(r.properties) as
      | { address?: string; preferred_vendor?: string; lake_id?: string; lakes?: Embed<{ name: string | null }> }
      | null;
    const lake = first(prop?.lakes) as { name?: string } | null;
    const serviceName = svc?.name ?? null;

    // Distinct unblocks, told apart honestly — and matched to what dispatch
    // ACTUALLY checks (exact service-name membership, not fuzzy matching, so
    // this label never disagrees with the engine's verdict).
    const doesSvc = (v: { service_types?: string[] | null }) =>
      !!serviceName && ((v.service_types as string[]) ?? []).includes(serviceName);
    const onLakeOf = (v: { service_lakes?: string[] | null }) =>
      !prop?.lake_id || (((v.service_lakes ?? []) as string[]).includes(prop.lake_id as string));
    const insuredForService = insured.filter(doesSvc);
    // Uninsured-but-otherwise-fitting crews mean the unblock is COI renewal,
    // not recruiting — say so instead of sending ops recruiting for nothing.
    const lapsedWouldFit = (vendors ?? []).some((v) => doesSvc(v) && onLakeOf(v)) && !insured.some((v) => doesSvc(v) && onLakeOf(v));
    const reason =
      insuredForService.length === 0
        ? lapsedWouldFit
          ? "A crew fits but their insurance lapsed — COI renewal is the unblock"
          : "No active, insured crew signed up for this service"
        : !insuredForService.some(onLakeOf)
          ? lapsedWouldFit
            ? "A crew fits but their insurance lapsed — COI renewal is the unblock"
            : `No crew serves ${lake?.name ?? "this lake"} yet — recruiting is the unblock`
          : "All crews are full or below the margin floor";

    const preferred_vendor = prop?.preferred_vendor ?? null;
    return {
      id: r.id as string,
      property_id: r.property_id ?? null,
      service_name: serviceName,
      address: prop?.address ?? null,
      lake_name: lake?.name ?? null,
      date: r.date ?? null,
      customer_price: r.customer_price == null ? null : Number(r.customer_price),
      reason,
      preferred_vendor,
      preferred_company: preferred_vendor ? (companyById.get(preferred_vendor) ?? null) : null,
    };
  });
}

// ---- All properties + their preferred crew ---------------------------------

export interface PropertyPreferred {
  property_id: string;
  address: string | null;
  lake_name: string | null;
  owner_name: string | null;
  preferred_vendor: string | null; // property's preferred crew, if set
  preferred_company: string | null; // that crew's company name, if resolvable
}

/**
 * Every property with its preferred crew (ops only). Lets ops set/see a
 * property's preferred crew even when dispatch is healthy and nothing is in the
 * needs-attention bucket. Ordered by lake, then address. Preferred-crew company
 * names resolved in one shot, same as getNeedsAttention.
 */
export async function getPropertiesWithPreferred(): Promise<PropertyPreferred[]> {
  const ops = await assertOps();
  if (!ops) return [];

  const admin = createServiceClient();

  const { data } = await admin
    .from("properties")
    .select("id, address, preferred_vendor, lakes(name), users(name)");

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    address: string | null;
    preferred_vendor: string | null;
    lakes: Embed<{ name: string | null }>;
    users: Embed<{ name: string | null }>;
  }>;

  if (rows.length === 0) return [];

  // Resolve preferred-crew company names in one shot.
  const prefIds = Array.from(
    new Set(rows.map((r) => r.preferred_vendor).filter((x): x is string => !!x)),
  );
  const companyById = new Map<string, string | null>();
  if (prefIds.length) {
    const { data: prefVendors } = await admin.from("vendors").select("id, company").in("id", prefIds);
    for (const v of prefVendors ?? []) companyById.set(v.id as string, (v.company as string) ?? null);
  }

  const out: PropertyPreferred[] = rows.map((r) => {
    const lake = first(r.lakes) as { name?: string } | null;
    const owner = first(r.users) as { name?: string } | null;
    const preferred_vendor = r.preferred_vendor ?? null;
    return {
      property_id: r.id as string,
      address: r.address ?? null,
      lake_name: lake?.name ?? null,
      owner_name: owner?.name ?? null,
      preferred_vendor,
      preferred_company: preferred_vendor ? (companyById.get(preferred_vendor) ?? null) : null,
    };
  });

  // Order by lake, then address (embedded columns — sort in JS).
  out.sort(
    (a, b) =>
      (a.lake_name ?? "").localeCompare(b.lake_name ?? "") ||
      (a.address ?? "").localeCompare(b.address ?? ""),
  );
  return out;
}

// ---- Preferred-crew indicator for the job board ----------------------------

/**
 * Ids of board jobs whose assigned crew IS that property's preferred crew —
 * drives the "⭐ preferred" pill on the Jobs board. Compared in JS since PostgREST
 * can't equate two columns directly.
 */
export async function getPreferredJobIds(): Promise<string[]> {
  const ops = await assertOps();
  if (!ops) return [];

  const admin = createServiceClient();
  const { data } = await admin
    .from("jobs")
    .select("id, vendor_id, properties(preferred_vendor)")
    .not("vendor_id", "is", null)
    .in("status", ["scheduled", "in_progress", "complete", "paid"]);

  const out: string[] = [];
  for (const r of data ?? []) {
    const prop = first(r.properties as Embed<{ preferred_vendor: string | null }>) as
      | { preferred_vendor?: string | null }
      | null;
    if (prop?.preferred_vendor && prop.preferred_vendor === r.vendor_id) out.push(r.id as string);
  }
  return out;
}
