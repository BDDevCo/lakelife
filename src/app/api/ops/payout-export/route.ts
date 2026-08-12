import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "@/app/ops/data";
import { openSecret } from "@/lib/gate";
import { todayLakeDate } from "@/lib/booking";

/**
 * POST /api/ops/payout-export — the ACH export the bank API will eventually
 * replace. Pulls the QUEUED batches, decrypts the payee's routing and account
 * numbers SERVER-SIDE ONLY, and flips queued→exported. POST because this
 * mutates state: a prefetcher or cross-site GET can never trigger it, and
 * the response is never cacheable (no-store, plaintext bank numbers).
 * Batches with no bank on file or an undecryptable blob are left queued
 * and counted in trailing comment lines.
 *
 * `?redownload=1` also pulls exported-but-unpaid batches, for an aborted
 * download. That used to be the unconditional default, which — since nothing
 * ever wrote `paid_at` — quietly put every earlier month's rows into every
 * later file. Marking a batch paid (ops/payout-actions.ts) is what closes it.
 */

type Embed<T> = T | T[] | null;
const first = <T>(x: Embed<T> | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

interface RawBatch {
  id: string;
  user_id: string;
  kind: string;
  net: number | string;
  status: string;
  vendors: Embed<{ company: string | null }>;
  users: Embed<{ name: string | null }>;
}

interface RawAccount {
  user_id: string;
  bank_name: string | null;
  routing_encrypted: string | null;
  account_encrypted: string | null;
}

/** CSV field escaping + formula-injection guard: a crew named
 *  "=HYPERLINK(...)" must open as text, not execute, in the one file
 *  that also carries decrypted bank numbers. */
function csvField(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADERS = (filename: string) => ({
  "Content-Type": "text/csv",
  "Content-Disposition": `attachment; filename="${filename}"`,
  "Cache-Control": "no-store",
});

export async function GET() {
  // The export mutates state and carries plaintext bank numbers — GET is
  // never allowed (link prefetch / cross-site navigation safety).
  return NextResponse.json({ error: "Use the download button (POST)." }, { status: 405 });
}

export async function POST(req: Request) {
  const ops = await assertOps();
  if (!ops) {
    return NextResponse.json({ error: "Ops access required." }, { status: 401 });
  }

  const admin = createServiceClient();

  // RE-INCLUDING AN ALREADY-EXPORTED BATCH IS NOW A DELIBERATE ACT.
  //
  // This used to always pull ['queued','exported'] where paid_at is null —
  // and since nothing on earth wrote paid_at, that meant every month's file
  // silently carried every previous month's rows, bank details and all.
  // Upload that and the crews are paid twice.
  //
  // The default is now the queued batches only. A genuine re-download is
  // still one click, but it says so in the file and it is asked for.
  const redownload = new URL(req.url).searchParams.get("redownload") === "1";
  const wanted = redownload ? ["queued", "exported"] : ["queued"];

  const { data: batchRows, error: batchErr } = await admin
    .from("payout_batches")
    .select("id, user_id, kind, net, status, vendors(company), users(name)")
    .in("status", wanted)
    .is("paid_at", null)
    .order("created_at", { ascending: true });
  if (batchErr) {
    return NextResponse.json({ error: batchErr.message }, { status: 500 });
  }

  const batches = (batchRows ?? []) as unknown as RawBatch[];

  const header = "batch_id,payee,kind,net,routing,account,bank_name";
  if (batches.length === 0) {
    return new Response(`${header}\n# skipped (no bank on file): 0`, {
      headers: CSV_HEADERS(`lakelife-ach-${todayLakeDate()}.csv`),
    });
  }

  const userIds = batches.map((b) => b.user_id);
  const { data: acctRows } = await admin
    .from("payout_accounts")
    .select("user_id, bank_name, routing_encrypted, account_encrypted")
    .in("user_id", userIds);
  const accountsByUser = new Map<string, RawAccount>(
    ((acctRows ?? []) as unknown as RawAccount[]).map((a) => [a.user_id, a]),
  );

  const lines: string[] = [header];
  let skipped = 0;
  const exportedIds: string[] = [];

  for (const b of batches) {
    const acct = accountsByUser.get(b.user_id);
    if (!acct || !acct.routing_encrypted || !acct.account_encrypted) {
      skipped += 1;
      continue;
    }

    const vendor = first(b.vendors) as { company?: string | null } | null;
    const payeeUser = first(b.users) as { name?: string | null } | null;
    const payee = vendor?.company || payeeUser?.name || "Unknown payee";

    // Decrypted here, in this route handler, and nowhere else — the plaintext
    // never leaves this function except baked into the CSV response body.
    // One corrupt/key-rotated blob skips ITS batch, never the whole export.
    let routing = "", account = "";
    try {
      routing = openSecret(acct.routing_encrypted) ?? "";
      account = openSecret(acct.account_encrypted) ?? "";
    } catch {
      skipped += 1;
      continue;
    }
    if (!routing || !account) {
      skipped += 1;
      continue;
    }

    lines.push(
      [
        csvField(b.id),
        csvField(payee),
        csvField(b.kind),
        csvField(Number(b.net ?? 0).toFixed(2)),
        csvField(routing),
        csvField(account),
        csvField(acct.bank_name ?? ""),
      ].join(","),
    );
    exportedIds.push(b.id);
  }

  // Flip only queued→exported (already-exported rows stay as they are);
  // the CSV is returned regardless — the file in ops' hands is the point,
  // and it remains re-downloadable until batches are marked paid.
  if (exportedIds.length > 0) {
    const { error: flipErr } = await admin
      .from("payout_batches").update({ status: "exported" }).in("id", exportedIds).eq("status", "queued");
    if (flipErr) console.error("payout export: status flip failed (file still delivered)", flipErr.message);
  }

  lines.push(`# skipped (no bank on file or undecryptable): ${skipped}`);
  // SAID OUT LOUD, IN THE FILE ITSELF. Whoever uploads this needs to know it
  // contains rows that have already been in an earlier file — that is the
  // difference between a re-send and a double payment.
  const alreadyExported = batches.filter((b) => b.status === "exported").length;
  if (alreadyExported > 0) {
    lines.push(
      `# WARNING: ${alreadyExported} of these ${alreadyExported === 1 ? "row was" : "rows were"} ` +
      `in an earlier export and ${alreadyExported === 1 ? "has" : "have"} not been marked paid. ` +
      `If that money already went out, mark those batches paid in ops before uploading this.`,
    );
  }

  return new Response(lines.join("\n"), {
    headers: CSV_HEADERS(`lakelife-ach-${todayLakeDate()}.csv`),
  });
}
