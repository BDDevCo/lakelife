import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { mustRead } from "@/lib/must-read";
import { getMyVendorId } from "./data";
import {
  periodRanges,
  weekStartMonday,
  sumInRange,
  type EarningRow,
  type DateRange,
  reportedPayoutStatus,
  sumEverReleased,
  completedJobCount,
} from "./earnings-helpers";
import { lakeDateOf } from "@/lib/booking";

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

  const vendor = mustRead(
    "your company name",
    await admin
      .from("vendors")
      .select("company")
      .eq("id", vendorId)
      .maybeSingle(),
  );

  // NOTE: the jobs embed lists ONLY date / service name / address — no price,
  // no margin (CLAUDE.md rule 1). amount is the crew's own take-home. No
  // `kind` filter — 'earning' (job pay) and 'adjustment' (negative refund
  // clawback, migration 0043) rows both belong here so totals stay accurate.
  //
  // THIS IS THE READ. Everything a crew is owed comes off these rows: the
  // dashboard totals, the statement, the CSV their accountant gets. A failed
  // read used to produce $0.00 across every window and a statement with no
  // lines on it — which is not "you earned nothing", it is a document that
  // could cost them a tax return.
  const payouts = mustRead(
    "your earnings",
    await admin
      .from("payouts")
      // batch_id + the batch's own status: the payout row never advances past
      // 'released', so the batch is the only record of the money moving.
      .select("id, amount, status, kind, created_at, job_id, batch_id, payout_batches(status), jobs(date, route_id, services(name), properties(address))")
      .eq("vendor_id", vendorId)
      .order("created_at", { ascending: false }),
  );

  // WHICH CREW WAS ON EACH JOB — fetched separately and joined in code, NOT
  // embedded. `jobs.route_id` has no foreign key to `routes` (checked against
  // production: the column exists, 4 of 8 jobs carry one, zero orphans, and no
  // constraint). PostgREST can only embed across a declared relationship, so
  // `jobs(..., routes(unit_name))` would come back as an error — which
  // supabase-js hands over as `{error, data:null}`, i.e. an empty earnings
  // page that looks exactly like a crew who has never worked.
  //
  // Adding the FK would enable the embed and is arguably the right schema, but
  // a new FK is precisely what blanked two live screens in this codebase (see
  // 0084/0086). Not on the same day as a feature.
  const routeIds = [...new Set(
    (payouts ?? [])
      .map((p) => (one(p.jobs) as { route_id?: string | null } | null)?.route_id)
      .filter((id): id is string => !!id),
  )];
  const unitByRoute = new Map<string, string>();
  if (routeIds.length > 0) {
    const routeRows = mustRead(
      "which truck was on each job",
      await admin.from("routes").select("id, unit_name").in("id", routeIds),
    );
    for (const r of routeRows ?? []) {
      const name = (r.unit_name as string | null)?.trim();
      if (name) unitByRoute.set(r.id as string, name);
    }
  }

  // WHO THE CREW SAID WAS THERE (0099) — and it BEATS the truck name.
  //
  // The truck is an inference: it is whoever the nightly router assigned, and
  // it is silent on a hand-assigned job. A name the crew tapped in the
  // driveway is a statement of fact by the only people who were present. When
  // both exist, the fact wins.
  //
  // Names are read from `job_workers.name` — the SNAPSHOT — not by joining the
  // roster, so a worker renamed or removed since does not rewrite an old
  // statement.
  const payoutJobIds = [...new Set(
    (payouts ?? []).map((p) => (p as { job_id?: string | null }).job_id).filter((id): id is string => !!id),
  )];
  const workersByJob = new Map<string, string[]>();
  if (payoutJobIds.length > 0) {
    const jw = mustRead(
      "who the crew said was there",
      await admin.from("job_workers").select("job_id, name").in("job_id", payoutJobIds),
    );
    for (const r of jw ?? []) {
      const list = workersByJob.get(r.job_id as string) ?? [];
      list.push(r.name as string);
      workersByJob.set(r.job_id as string, list);
    }
    for (const [, list] of workersByJob) list.sort((a, b) => a.localeCompare(b));
  }

  const rows: EarningRow[] = (payouts ?? []).map((p) => {
    const job = one(p.jobs) as
      | { date: string | null; route_id?: string | null; services: unknown; properties: unknown }
      | null;
    const service = (one(job?.services) as { name?: string } | null)?.name ?? null;
    const address = (one(job?.properties) as { address?: string } | null)?.address ?? null;
    // Prefer the job date; fall back to the payout's created date so grouping
    // and period math always have a real day to work with.
    // Adjustments (clawbacks) date to WHEN THEY WERE APPLIED, not the
    // original job — a September clawback must land in September's period
    // totals/statement, never restate a July statement the crew already
    // downloaded (review finding, 2026-07-23).
    // LAKE-LOCAL, NOT THE UTC SLICE. `created_at` is a timestamptz served as
    // UTC; every window this is compared against — this week, this month, YTD,
    // the statement's from/to — is built from todayLakeDate(). A clawback
    // applied 31 Dec at 7:15pm EST is 2027-01-01 in UTC, so it dropped off the
    // crew's 2026 statement entirely and landed on a year it has nothing to do
    // with. BOTH branches: a tip or trip row whose job has no date falls
    // through to the same slice.
    const stamped = lakeDateOf(String(p.created_at ?? "")) ?? "";
    const jobDate = (p as { kind?: string }).kind === "adjustment"
      ? stamped
      : job?.date ?? stamped;
    // CARRY THE KIND THROUGH. This was `=== "adjustment" ? "adjustment" :
    // "earning"`, which quietly relabelled 0090's trip fees and 0091's tips as
    // ordinary job pay on the crew's statement and CSV. Anything unrecognised
    // still falls back to 'earning', which is the safe default for a number a
    // crew is owed — but the two kinds we actually have now say what they are.
    const raw = (p.kind as string) ?? "earning";
    const kind = raw === "adjustment" || raw === "trip" || raw === "tip" ? raw : "earning";
    return {
      id: p.id as string,
      jobDate,
      service,
      address,
      amount: Number(p.amount) || 0,
      // The row's own status, kept beside the reported one so a lifetime
      // total is not computed from a label that changes when money moves.
      rawStatus: (p.status as string) ?? "pending",
      status: reportedPayoutStatus(
        (p.status as string) ?? "pending",
        ((Array.isArray(p.payout_batches) ? p.payout_batches[0] : p.payout_batches) as { status?: string } | null)?.status ?? null,
      ),
      kind,
      crew: (() => {
        const jid = (p as { job_id?: string | null }).job_id ?? null;
        const named = jid ? workersByJob.get(jid) : undefined;
        if (named && named.length > 0) return named.join(" & ");
        return job?.route_id ? unitByRoute.get(job.route_id) ?? null : null;
      })(),
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
    allTimeReleased: sumEverReleased(rows),
    jobCount: completedJobCount(rows),
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
