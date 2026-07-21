import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { getMyVendorId } from "./data";
import {
  periodRanges,
  weekStartMonday,
  sumInRange,
  sumByStatus,
  type EarningRow,
  type DateRange,
} from "./earnings-helpers";

/**
 * CREW EARNINGS reads. Every read is service-role AFTER asserting the caller
 * owns a vendors row (getMyVendorId uses the session client), then scoped hard
 * to `vendor_id = <that vendor>` — a crew only ever sees their own payouts.
 *
 * CLAUDE.md rule 1 (ABSOLUTE): payout.amount is the crew's OWN take-home
 * (their vendor_cost) and is safe for them. We join to jobs ONLY for context —
 * date, service name, property address — and NEVER select jobs.customer_price
 * or jobs.margin. Those columns are not read anywhere in this file.
 */

export interface EarningsTotals {
  thisWeek: number;
  thisMonth: number;
  ytd: number;
  allTimeReleased: number;
  jobCount: number;
}

export interface MyEarnings {
  rows: EarningRow[];
  totals: EarningsTotals;
  /** The window used for the returned rows (all-time when no range was given). */
  range: DateRange | null;
}

/** A statement/CSV payload: the crew's rows for a period plus its header data. */
export interface EarningsStatement {
  company: string | null;
  from: string;
  to: string;
  rows: EarningRow[];
  periodTotal: number;
  generatedAt: string; // "YYYY-MM-DD" at the lakes
}

const one = <T>(x: T | T[] | null | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? x[0] ?? null : x;

interface LoadedEarnings {
  vendorId: string;
  company: string | null;
  rows: EarningRow[]; // newest first, every payout for this vendor
}

/**
 * Load the signed-in crew's full payout history (newest first). Returns null if
 * the caller isn't a vendor. Service-role read, hard-scoped to their vendor_id.
 */
async function loadEarnings(): Promise<LoadedEarnings | null> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return null;

  const admin = createServiceClient();

  const { data: vendor } = await admin
    .from("vendors")
    .select("company")
    .eq("id", vendorId)
    .maybeSingle();

  // NOTE: the jobs embed lists ONLY date / service name / address — no price,
  // no margin (CLAUDE.md rule 1). amount is the crew's own take-home.
  const { data: payouts } = await admin
    .from("payouts")
    .select("id, amount, status, created_at, jobs(date, services(name), properties(address))")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false });

  const rows: EarningRow[] = (payouts ?? []).map((p) => {
    const job = one(p.jobs) as
      | { date: string | null; services: unknown; properties: unknown }
      | null;
    const service = (one(job?.services) as { name?: string } | null)?.name ?? null;
    const address = (one(job?.properties) as { address?: string } | null)?.address ?? null;
    // Prefer the job date; fall back to the payout's created date so grouping
    // and period math always have a real day to work with.
    const jobDate = job?.date ?? String(p.created_at ?? "").slice(0, 10);
    return {
      id: p.id as string,
      jobDate,
      service,
      address,
      amount: Number(p.amount) || 0,
      status: (p.status as string) ?? "pending",
    };
  });

  // Sort newest job-date first; created_at order (already desc) breaks ties.
  rows.sort((a, b) => (a.jobDate < b.jobDate ? 1 : a.jobDate > b.jobDate ? -1 : 0));

  return { vendorId, company: (vendor?.company as string | null) ?? null, rows };
}

function computeTotals(rows: EarningRow[], todayISO: string): EarningsTotals {
  const ranges = periodRanges(todayISO);
  const weekStart = weekStartMonday(todayISO);
  return {
    thisWeek: sumInRange(rows, weekStart, todayISO),
    thisMonth: sumInRange(rows, ranges.thisMonth.from, ranges.thisMonth.to),
    ytd: sumInRange(rows, ranges.ytd.from, ranges.ytd.to),
    allTimeReleased: sumByStatus(rows, "released"),
    jobCount: rows.length,
  };
}

const EMPTY_TOTALS: EarningsTotals = {
  thisWeek: 0,
  thisMonth: 0,
  ytd: 0,
  allTimeReleased: 0,
  jobCount: 0,
};

/**
 * The signed-in crew's earnings. `rows` is filtered to `range` when given
 * (else all-time); the dashboard `totals` are always the fixed running windows
 * (this week / month / YTD / all-time released) over the crew's full history.
 */
export async function getMyEarnings(range?: DateRange): Promise<MyEarnings> {
  const loaded = await loadEarnings();
  if (!loaded) return { rows: [], totals: EMPTY_TOTALS, range: range ?? null };

  const today = todayLakeDate();
  const totals = computeTotals(loaded.rows, today);
  const rows = range
    ? loaded.rows.filter((r) => r.jobDate >= range.from && r.jobDate <= range.to)
    : loaded.rows;

  return { rows, totals, range: range ?? null };
}

/**
 * The crew's earnings for a specific [from, to] window plus statement header
 * data (company, period total). Backs the print statement and CSV routes.
 * Returns null if the caller isn't a vendor (routes turn that into a 401).
 */
export async function getMyEarningsFor(from: string, to: string): Promise<EarningsStatement | null> {
  const loaded = await loadEarnings();
  if (!loaded) return null;

  const rows = loaded.rows.filter((r) => r.jobDate >= from && r.jobDate <= to);
  const periodTotal = sumInRange(loaded.rows, from, to);

  return {
    company: loaded.company,
    from,
    to,
    rows,
    periodTotal,
    generatedAt: todayLakeDate(),
  };
}
