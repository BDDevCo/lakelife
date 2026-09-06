import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { mustRead } from "@/lib/must-read";

/**
 * Ops-side view of the payout queue: what's waiting for the ACH export
 * (or, once it lands, the bank API) and what's already gone out. Service-role
 * read, gated by assertOps like getStorageLedger. Bank routing/account
 * numbers never appear here — this is the ledger, not the vault; decryption
 * happens only inside the export route handler.
 */

export interface PayoutQueueRow {
  id: string;
  payee: string;
  kind: string;
  net: number;
  status: string;
  created_at: string;
}

/** A crew whose released, un-batched pay adds up to LESS than nothing. */
export interface CrewInTheRed {
  vendorId: string;
  payee: string;
  /** Negative dollars. What they owe, in the sign the ledger holds it in. */
  amount: number;
}

export interface PayoutQueue {
  queuedCount: number;
  queuedTotal: number;
  exportedCount: number;
  exportedTotal: number;
  rows: PayoutQueueRow[];
  /**
   * THE CREWS EVERY MONTH-END RUN DROPS WITHOUT SAYING SO.
   *
   * A clawback after a batch has gone out lands as a negative released payout,
   * and it is only ever recovered out of future earnings. Until those earnings
   * arrive the crew's released-and-unbatched sum is below zero, and
   * `runMonthlyPayoutBatches` skips them on a bare `if (sum <= 0) continue`:
   * no batch, no line in the run's skipped list, nothing anywhere. A crew can
   * sit in the red for months while every run reports a clean night.
   */
  owing: CrewInTheRed[];
}

type Embed<T> = T | T[] | null;
const first = <T>(x: Embed<T> | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

// Queued (actionable — waiting on the export) leads; exported (history) follows.
const STATUS_RANK: Record<string, number> = { queued: 0, exported: 1 };

interface RawRow {
  id: string;
  kind: string;
  net: number | string | null;
  status: string;
  created_at: string;
  vendors: Embed<{ company: string | null }>;
  users: Embed<{ name: string | null }>;
}

const EMPTY: PayoutQueue = { queuedCount: 0, queuedTotal: 0, exportedCount: 0, exportedTotal: 0, rows: [], owing: [] };

interface RawOwed {
  vendor_id: string;
  amount: number | string | null;
  vendors: Embed<{ company: string | null; users: Embed<{ is_fixture: boolean | null }> }>;
}

/**
 * Sum released, un-batched pay per crew and keep only the ones below zero.
 *
 * CENTS, ONCE. Two clawbacks of -59.99 and one earning of 119.98 must come to
 * exactly zero and drop off this list, not to -0.0000000001 and stay on it as
 * a crew somebody is told to ring about a debt of nothing.
 */
function crewsInTheRed(rows: RawOwed[]): CrewInTheRed[] {
  const cents = new Map<string, number>();
  const name = new Map<string, string>();

  for (const r of rows) {
    const vendor = first(r.vendors) as
      { company?: string | null; users?: Embed<{ is_fixture: boolean | null }> } | null;
    // Same fence as dispatch and the ACH export, derived from the OWNER: an
    // account we invented ourselves is not somebody to ring about a debt.
    if ((first(vendor?.users) as { is_fixture?: boolean | null } | null)?.is_fixture === true) continue;
    const id = r.vendor_id;
    cents.set(id, (cents.get(id) ?? 0) + Math.round(Number(r.amount ?? 0) * 100));
    if (!name.has(id)) name.set(id, vendor?.company || "Unknown crew");
  }

  return [...cents.entries()]
    .filter(([, c]) => c < 0)
    .map(([id, c]) => ({ vendorId: id, payee: name.get(id) ?? "Unknown crew", amount: c / 100 }))
    .sort((a, b) => a.amount - b.amount); // deepest in the red first
}

export async function getPayoutQueue(): Promise<PayoutQueue> {
  const ops = await assertOps();
  if (!ops) return EMPTY;

  const admin = createServiceClient();
  // EMPTY is "nobody is owed anything" — $0.00 queued, nothing to export. On a
  // failed read that sentence is a lie about money crews are waiting on, so
  // the screen must fail instead of quietly showing an empty queue.
  const data = mustRead(
    "the payout queue",
    await admin
      .from("payout_batches")
      .select("id, kind, net, status, created_at, vendors(company), users(name)")
      .in("status", ["queued", "exported"])
      .order("created_at", { ascending: false })
      .limit(100),
  );

  const raw = (data ?? []) as unknown as RawRow[];

  let queuedCount = 0;
  let queuedTotal = 0;
  let exportedCount = 0;
  let exportedTotal = 0;

  const rows: PayoutQueueRow[] = raw
    .map((r) => {
      const vendor = first(r.vendors) as { company?: string | null } | null;
      const payeeUser = first(r.users) as { name?: string | null } | null;
      const net = Number(r.net ?? 0);
      if (r.status === "queued") {
        queuedCount += 1;
        queuedTotal += net;
      } else if (r.status === "exported") {
        exportedCount += 1;
        exportedTotal += net;
      }
      return {
        id: r.id,
        payee: vendor?.company || payeeUser?.name || "Unknown payee",
        kind: r.kind,
        net,
        status: r.status,
        created_at: r.created_at,
      };
    })
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));

  // The same shape the month-end run sums, asked of the same rows. An empty
  // answer here means "nobody is in the red", which is a claim about money,
  // so a dropped read must fail the screen rather than make it.
  const owed = mustRead(
    "the crews carrying a balance",
    await admin
      .from("payouts")
      .select("vendor_id, amount, vendors(company, users!vendors_user_id_fkey(is_fixture))")
      .eq("status", "released")
      .is("batch_id", null)
      .not("vendor_id", "is", null),
  );

  return {
    queuedCount,
    queuedTotal: Math.round(queuedTotal * 100) / 100,
    exportedCount,
    exportedTotal: Math.round(exportedTotal * 100) / 100,
    rows,
    owing: crewsInTheRed((owed ?? []) as unknown as RawOwed[]),
  };
}
