import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";
import { seasonEndFor, overstayDays, perdiemCharge } from "@/lib/storage";
import { assertOps } from "./data";

/**
 * Ops-side view of the winter-storage program: who's holding what, how full
 * each vendor's yard is, and who's running the polite overstay meter. Prices
 * aren't broken out per-stay here (job_items carries those, already ops-only)
 * — this view is about CUSTODY, not money. Service-role reads, gated by
 * assertOps like getNeedsAttention / getMarginHealth. Never import into a
 * vendor/owner surface.
 */

export type StorageStayStatus = "reserved" | "in_storage" | "released" | "cancelled";

export interface StorageStayRow {
  id: string;
  address: string | null;
  vendor_id: string | null;
  vendor_company: string | null;
  boat_label: string | null;
  boat_feet: number;
  status: StorageStayStatus;
  intake_at: string | null; // date-only (YYYY-MM-DD), truncated from timestamptz
  out_at: string | null; // date-only
  season_end: string | null; // set only for in_storage stays with an intake date
  overstay_days: number; // 0 unless in_storage and past the season-end dial
  overstay_charge: number; // overstay_days × the per-diem dial
}

export interface StorageVendorUtilization {
  vendor_id: string;
  company: string | null;
  capacity_feet: number;
  committed_feet: number; // sum of reserved + in_storage boat_feet
  utilization_pct: number; // 0 when capacity is 0 (0-ft vendors don't divide)
  garagekeepers_expiry: string | null;
  garagekeepers_ok: boolean; // present AND unexpired — same posture as the COI gate
}

export interface StorageLedger {
  vendors: StorageVendorUtilization[];
  stays: StorageStayRow[];
}

type Embed<T> = T | T[] | null;
const first = <T>(x: Embed<T> | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

const dateOnly = (ts: string | null): string | null => (ts ? ts.slice(0, 10) : null);

// Stays ordered so the meter-running ones lead, then everything still on the
// books, then history — trouble first, same convention as margin health.
const STATUS_RANK: Record<StorageStayStatus, number> = {
  in_storage: 0,
  reserved: 1,
  released: 2,
  cancelled: 3,
};

interface RawStay {
  id: string;
  vendor_id: string | null;
  boat_label: string | null;
  boat_feet: number | null;
  intake_at: string | null;
  out_at: string | null;
  status: string;
  vendors: Embed<{ company: string | null }>;
  job_groups: Embed<{ properties: Embed<{ address: string | null }> }>;
}

export async function getStorageLedger(): Promise<StorageLedger> {
  const ops = await assertOps();
  if (!ops) return { vendors: [], stays: [] };

  const admin = createServiceClient();
  const [dials, { data: stayRows }, { data: vendorRows }] = await Promise.all([
    getPlatformSettings(),
    admin
      .from("storage_stays")
      .select(
        "id, vendor_id, boat_label, boat_feet, intake_at, out_at, status, " +
          "vendors(company), job_groups(properties(address))",
      ),
    admin
      .from("vendors")
      .select("id, company, storage_capacity_feet, garagekeepers_expiry")
      .gt("storage_capacity_feet", 0)
      .order("company", { ascending: true }),
  ]);

  const today = todayLakeDate();
  const rawStays = (stayRows ?? []) as unknown as RawStay[];

  // Committed feet per vendor = reserved + in_storage (the season's actual
  // custody commitment; released/cancelled boats no longer occupy the yard).
  const committedByVendor = new Map<string, number>();
  for (const r of rawStays) {
    if ((r.status === "reserved" || r.status === "in_storage") && r.vendor_id) {
      committedByVendor.set(r.vendor_id, (committedByVendor.get(r.vendor_id) ?? 0) + Number(r.boat_feet ?? 0));
    }
  }

  const stays: StorageStayRow[] = rawStays
    .map((r) => {
      const vend = first(r.vendors) as { company?: string } | null;
      const group = first(r.job_groups) as { properties?: Embed<{ address: string | null }> } | null;
      const prop = first(group?.properties) as { address?: string } | null;
      const status = r.status as StorageStayStatus;
      const intake = dateOnly(r.intake_at);

      let season_end: string | null = null;
      let overstay = 0;
      let charge = 0;
      if (status === "in_storage" && intake) {
        season_end = seasonEndFor(intake, dials.storageSeasonEndMonth, dials.storageSeasonEndDay);
        overstay = overstayDays(today, season_end);
        charge = perdiemCharge(overstay, dials.storagePerdiemDaily);
      }

      return {
        id: r.id,
        address: prop?.address ?? null,
        vendor_id: r.vendor_id,
        vendor_company: vend?.company ?? null,
        boat_label: r.boat_label ?? null,
        boat_feet: Number(r.boat_feet ?? 0),
        status,
        intake_at: intake,
        out_at: dateOnly(r.out_at),
        season_end,
        overstay_days: overstay,
        overstay_charge: charge,
      };
    })
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.overstay_days - a.overstay_days);

  const vendors: StorageVendorUtilization[] = (vendorRows ?? []).map((v) => {
    const capacity = Number(v.storage_capacity_feet ?? 0);
    const committed = committedByVendor.get(v.id as string) ?? 0;
    const expiry = (v.garagekeepers_expiry as string) ?? null;
    return {
      vendor_id: v.id as string,
      company: (v.company as string) ?? null,
      capacity_feet: capacity,
      committed_feet: committed,
      utilization_pct: capacity > 0 ? Math.round((committed / capacity) * 1000) / 10 : 0,
      garagekeepers_expiry: expiry,
      garagekeepers_ok: expiry != null && expiry >= today,
    };
  });

  return { vendors, stays };
}
