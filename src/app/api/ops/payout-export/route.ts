import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "@/app/ops/data";
import { openSecret, bankKeyConfigured } from "@/lib/gate";
import { todayLakeDate } from "@/lib/booking";
import { csvRow } from "@/lib/csv";
import { EXPORT_HEADER, planExport, trailingNotes, type PlanAccount, type PlanBatch } from "./export-plan";

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
 *
 * ============ THREE THINGS THIS ORDER OF OPERATIONS EXISTS FOR ============
 *
 * DECIDE, then MARK, then RECORD, then hand it over. Each step is a
 * precondition of the next, and a batch that fails one is simply not in the
 * file.
 *
 *   1. A FIXTURE IS NEVER A PAYEE. `planExport` refuses an account marked
 *      not-a-person before its blob is opened. Production holds three released
 *      payouts to GreenEdge Lawn Co., whose owner is `is_fixture = true`.
 *   2. THE FLIP IS NOT A SIDE EFFECT. It used to run after the body was built
 *      and log on failure — "the CSV is returned regardless" — so a batch could
 *      be in ops' hands AND still queued, and the next export would carry it
 *      again. Upload both files and the crew is paid twice.
 *   3. NOTHING LEAVES UNRECORDED. This is the most sensitive artifact this
 *      product produces: every payee's decrypted routing and account number in
 *      one download. If we cannot write who pulled it, it is not handed over —
 *      the batches stay exported and the re-download button covers the retry.
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
  users: Embed<{ name: string | null; is_fixture: boolean | null }>;
}

const CSV_HEADERS = (filename: string) => ({
  "Content-Type": "text/csv",
  "Content-Disposition": `attachment; filename="${filename}"`,
  "Cache-Control": "no-store",
});

const csvFile = (lines: string[]) =>
  new Response(lines.join("\n"), { headers: CSV_HEADERS(`lakelife-ach-${todayLakeDate()}.csv`) });

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
  // A RE-DOWNLOAD PULLS ONLY WHAT HAS ALREADY BEEN IN A FILE.
  //
  // It used to pull ['queued','exported'], while the button that sets this
  // flag reads "Re-download N already-exported" and N counts the exported ones
  // alone. So pressing it with three exported and five queued batches handed
  // over EIGHT rows, flipped those five from queued to exported, and recorded
  // the whole pull as a re-download. The label undercounted by five, a fresh
  // batch became "already exported" through a button that claimed to be
  // re-fetching old ones, and the audit row said something untrue about what
  // had just been disclosed.
  //
  // The two buttons are two acts now and each pulls its own set. Both are
  // still one click; a month with both takes two files, which is the honest
  // shape — two disclosures, logged as two.
  const redownload = new URL(req.url).searchParams.get("redownload") === "1";
  const wanted = redownload ? ["exported"] : ["queued"];

  // `is_fixture` is read from the PAYEE'S OWN USER ROW, named through its
  // foreign key. A crew is a fixture because its owner is (0126) — and a batch
  // names its payee directly, so this catches a referral or an association
  // payout too, not only a vendor.
  const { data: batchRows, error: batchErr } = await admin
    .from("payout_batches")
    .select("id, user_id, kind, net, status, vendors(company), users!payout_batches_user_id_fkey(name, is_fixture)")
    .in("status", wanted)
    .is("paid_at", null)
    .order("created_at", { ascending: true });
  if (batchErr) {
    return NextResponse.json({ error: batchErr.message }, { status: 500 });
  }

  const batches = (batchRows ?? []) as unknown as RawBatch[];

  if (batches.length === 0) {
    return csvFile([EXPORT_HEADER, "# skipped (no bank on file): 0"]);
  }

  const userIds = batches.map((b) => b.user_id);
  const acctRes = await admin
    .from("payout_accounts")
    .select("user_id, bank_name, routing_encrypted, account_encrypted")
    .in("user_id", userIds);
  // A FAILED READ IS NOT "NOBODY HAS A BANK ON FILE". Falling through on null
  // empties this map, every batch takes the `!acct` skip below, and ops is
  // handed a header-only CSV whose trailing line says the skips were for a
  // missing bank account — about crews who are set up and waiting to be paid.
  // Same 500 the batch read above returns, for the same reason.
  if (acctRes.error) {
    return NextResponse.json({ error: acctRes.error.message }, { status: 500 });
  }
  const accountsByUser = new Map<string, PlanAccount>(
    ((acctRes.data ?? []) as unknown as Array<PlanAccount & { user_id: string }>).map(
      (a) => [a.user_id, a],
    ),
  );

  const planned: PlanBatch[] = batches.map((b) => {
    const vendor = first(b.vendors) as { company?: string | null } | null;
    const payeeUser = first(b.users) as { name?: string | null; is_fixture?: boolean | null } | null;
    return {
      id: b.id,
      user_id: b.user_id,
      kind: b.kind,
      net: b.net,
      status: b.status,
      payee: vendor?.company || payeeUser?.name || "Unknown payee",
      isFixture: payeeUser?.is_fixture === true,
    };
  });

  const plan = planExport(planned, accountsByUser, openSecret);

  // ---- the flip, as a precondition -----------------------------------------
  //
  // Only the queued rows need one; an exported row being re-downloaded is
  // already where it needs to be. A batch that does not come back from the
  // ---- THE KEY IS MISSING: HAND OVER NOTHING AND FLIP NOTHING -------------
  //
  // Not a skip, and not an empty file. Every crew's bank numbers are sealed
  // with BANK_ENCRYPTION_KEY, so if it is unset or has been rotated then NONE
  // of them can be read — and the old behaviour counted each one as "no bank
  // on file", handed ops a header-only CSV, and left every payout at 'queued'
  // with a trailing note blaming the crews.
  //
  // ASKED BEFORE ANYTHING IS DECRYPTED, which is where it belongs — but the
  // POSITION is not what protects the money, and it would be easy to believe
  // it was. With no usable key every blob fails to open, so the plan comes
  // back with no rows, so there is nothing for the status flip to flip. A
  // mutation that moved this refusal below the flip changed no behaviour at
  // all, which is how that was established rather than assumed.
  //
  // What this DOES fix is the answer: a header-only CSV with a trailing note
  // reading "skipped (no bank on file or undecryptable): 12" told ops that
  // twelve crews had no bank details. All twelve had details and none could be
  // read, so the one sentence that could have explained an empty file sent
  // somebody to chase the crews instead of the configuration.
  if (!bankKeyConfigured()) {
    console.error("payout export: BANK_ENCRYPTION_KEY is missing or rotated — no file was produced.");
    return NextResponse.json(
      {
        error:
          "No bank file was produced, and nothing was marked exported. The key " +
          "that unseals crew bank details is missing or has been changed, so " +
          "none of them can be read — this is our configuration, not the crews'. " +
          "Every payout is still queued and nothing has been lost.",
      },
      { status: 503 },
    );
  }

  // guarded update — an error, or somebody marking it paid between the read
  // and the write — is withheld from the file rather than shipped anyway.
  const queued = plan.rows.filter((r) => r.status === "queued");
  let flipped = new Set<string>();
  if (queued.length > 0) {
    const flipRes = await admin
      .from("payout_batches")
      .update({ status: "exported" })
      .in("id", queued.map((r) => r.id))
      .eq("status", "queued")
      .select("id");
    if (flipRes.error) {
      console.error("payout export: status flip failed, those batches withheld", flipRes.error.message);
    } else {
      flipped = new Set(((flipRes.data ?? []) as Array<{ id: string }>).map((r) => r.id));
    }
  }
  const delivered = plan.rows.filter((r) => r.status !== "queued" || flipped.has(r.id));
  const withheld = plan.rows.length - delivered.length;

  // ---- and the record, as the other one ------------------------------------
  //
  // Who, when, which batches, how many rows. No bank numbers: this row says a
  // file was pulled, never what was inside it — a durable copy of the contents
  // would double the thing being protected. Written only when the file carries
  // something, because a header-only download discloses nothing, and a log of
  // real disclosures is worth more than one padded with empty clicks.
  if (delivered.length > 0) {
    const { error: auditErr } = await admin.from("payout_export_events").insert({
      exported_by: ops.id,
      batch_ids: delivered.map((r) => r.id),
      row_count: delivered.length,
      redownload,
    });
    if (auditErr) {
      console.error("payout export: could not record who pulled the file", auditErr.message);
      return NextResponse.json(
        {
          error:
            "The bank file wasn't handed over because we couldn't record who pulled it. " +
            "The batches are marked exported — use Re-download already-exported to try again.",
        },
        { status: 500 },
      );
    }
  }

  return csvFile([
    EXPORT_HEADER,
    // EVERY cell through the shared escaper: this is the file a bank ingests,
    // and a crew called "=HYPERLINK(…)" must open as text (src/lib/csv).
    ...delivered.map((r) => csvRow(r.cells)),
    ...trailingNotes({
      skippedNoBank: plan.skippedNoBank,
      excludedFixture: plan.excludedFixture,
      withheld,
      // Counts what is IN this file, not what was read — a withheld row was
      // never handed over, so it is not a row anybody has seen twice.
      alreadyExported: delivered.filter((r) => r.status === "exported").length,
    }),
  ]);
}
