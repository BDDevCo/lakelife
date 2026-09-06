/**
 * WHAT GOES IN THE BANK FILE, DECIDED BEFORE ANYTHING IS HANDED OVER.
 *
 * Pure, and separate from the route handler, because the route's job is now an
 * ORDER OF OPERATIONS — decide, then mark exported, then record who pulled it,
 * and only then hand over the rows that survived all three. Deciding used to
 * be tangled through the same loop that built the response body, which is how
 * a batch could end up in ops' hands and still be sitting at 'queued'.
 *
 * Nothing here touches the database and nothing here decrypts on its own: the
 * opener is passed in, so the one place bank numbers become plaintext is still
 * the route handler. It emits no CSV either — the cells come back raw and the
 * route escapes them through src/lib/csv, because a second file that writes
 * its own CSV is exactly the drift csv.test.ts exists to refuse.
 */

export const EXPORT_HEADER = "batch_id,payee,kind,net,routing,account,bank_name";

export interface PlanBatch {
  id: string;
  user_id: string;
  kind: string;
  net: number | string | null;
  status: string;
  payee: string;
  /** True when the payee's account is one we invented (users.is_fixture). */
  isFixture: boolean;
}

export interface PlanAccount {
  bank_name: string | null;
  routing_encrypted: string | null;
  account_encrypted: string | null;
}

export interface PlannedRow {
  id: string;
  /** The batch's status as READ — 'queued' still needs its flip. */
  status: string;
  /** Raw, unescaped, in EXPORT_HEADER order. The route escapes them. */
  cells: Array<string | number>;
}

export interface ExportPlan {
  rows: PlannedRow[];
  /** No bank on file, or a blob that would not open. */
  skippedNoBank: number;
  /** Accounts marked not-a-person. Never decrypted, never counted as a skip. */
  excludedFixture: number;
}

/**
 * Decide the file's contents.
 *
 * A FIXTURE IS REFUSED BEFORE ITS BLOB IS EVEN OPENED. Production holds three
 * released payouts to GreenEdge Lawn Co., an account whose owner is
 * `is_fixture = true`, and the batch query knew nothing about that. The same
 * fence dispatch and the nightly broadcast use (derived from the OWNER, never
 * from the crew row) belongs on the one file a bank actually pays.
 */
export function planExport(
  batches: PlanBatch[],
  accountsByUser: Map<string, PlanAccount>,
  open: (blob: string) => string | null,
): ExportPlan {
  const rows: PlannedRow[] = [];
  let skippedNoBank = 0;
  let excludedFixture = 0;

  for (const b of batches) {
    if (b.isFixture) {
      excludedFixture += 1;
      continue;
    }

    const acct = accountsByUser.get(b.user_id);
    if (!acct || !acct.routing_encrypted || !acct.account_encrypted) {
      skippedNoBank += 1;
      continue;
    }

    // One corrupt or key-rotated blob skips ITS batch, never the whole export.
    let routing = "", account = "";
    try {
      routing = open(acct.routing_encrypted) ?? "";
      account = open(acct.account_encrypted) ?? "";
    } catch {
      skippedNoBank += 1;
      continue;
    }
    if (!routing || !account) {
      skippedNoBank += 1;
      continue;
    }

    rows.push({
      id: b.id,
      status: b.status,
      cells: [b.id, b.payee, b.kind, Number(b.net ?? 0).toFixed(2), routing, account, acct.bank_name ?? ""],
    });
  }

  return { rows, skippedNoBank, excludedFixture };
}

export interface NoteCounts {
  skippedNoBank: number;
  excludedFixture: number;
  /** Rows planned but withheld because their queued → exported flip did not land. */
  withheld: number;
  /** Rows in this file that were in an earlier one and are not marked paid. */
  alreadyExported: number;
}

/**
 * The trailing comment lines. Whoever uploads this needs to be able to read
 * the difference between "nobody has a bank account on file" and "we could not
 * mark these exported, so they are not here" — the second one is money that is
 * still owed and will be in the next file.
 */
export function trailingNotes(n: NoteCounts): string[] {
  const out = [`# skipped (no bank on file or undecryptable): ${n.skippedNoBank}`];

  if (n.excludedFixture > 0) {
    out.push(
      `# excluded (test accounts, not real crews): ${n.excludedFixture}. ` +
      `These are accounts LakeLife created itself. They are still queued and ` +
      `they will never be in a bank file.`,
    );
  }

  if (n.withheld > 0) {
    const s = n.withheld === 1;
    out.push(
      `# WITHHELD: ${n.withheld} ${s ? "batch" : "batches"} could not be marked exported, ` +
      `so ${s ? "it is" : "they are"} NOT in this file. ` +
      `Nothing is lost — ${s ? "it stays" : "they stay"} queued and ${s ? "goes" : "go"} in the next export. ` +
      `A batch in a file that is still queued is how a crew gets paid twice.`,
    );
  }

  if (n.alreadyExported > 0) {
    const s = n.alreadyExported === 1;
    out.push(
      `# WARNING: ${n.alreadyExported} of these ${s ? "row was" : "rows were"} ` +
      `in an earlier export and ${s ? "has" : "have"} not been marked paid. ` +
      `If that money already went out, mark those batches paid in ops before uploading this.`,
    );
  }

  return out;
}
