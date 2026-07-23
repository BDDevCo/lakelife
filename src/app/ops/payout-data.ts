import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";

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

export interface PayoutQueue {
  queuedCount: number;
  queuedTotal: number;
  exportedCount: number;
  exportedTotal: number;
  rows: PayoutQueueRow[];
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

const EMPTY: PayoutQueue = { queuedCount: 0, queuedTotal: 0, exportedCount: 0, exportedTotal: 0, rows: [] };

export async function getPayoutQueue(): Promise<PayoutQueue> {
  const ops = await assertOps();
  if (!ops) return EMPTY;

  const admin = createServiceClient();
  const { data } = await admin
    .from("payout_batches")
    .select("id, kind, net, status, created_at, vendors(company), users(name)")
    .in("status", ["queued", "exported"])
    .order("created_at", { ascending: false })
    .limit(100);

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

  return {
    queuedCount,
    queuedTotal: Math.round(queuedTotal * 100) / 100,
    exportedCount,
    exportedTotal: Math.round(exportedTotal * 100) / 100,
    rows,
  };
}
