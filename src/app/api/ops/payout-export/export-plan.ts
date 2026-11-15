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
  /**
   * THE SAME ROW, STRUCTURED, for the rail that is not a file.
   *
   * Mercury originates these credits over an API and needs fields, not cells
   * in header order. Both rails read ONE plan on purpose: who is owed, who is
   * skipped and why is a single decision, and two copies of it would be two
   * answers the day somebody changes one. The fixture fence and the
   * no-bank-on-file skip in particular must mean the same thing on both.
   */
  wire: {
    userId: string;
    payee: string;
    kind: string;
    /** Cents, because the ledger is cents and only the boundary converts. */
    netCents: number;
    routing: string;
    account: string;
    bankName: string | null;
  };
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
/**
 * MAY THIS BATCH BE PAID AT ALL, AND IF NOT WHY NOT.
 *
 * Extracted so the two rails cannot disagree. The CSV calls it below; the
 * Mercury run calls it directly, because that rail never holds a bank number
 * and so cannot use the rest of this module.
 *
 * The fixture fence is the one that matters most: production holds three
 * released payouts to a crew whose OWNER is `is_fixture`, and the batch query
 * knew nothing about that until it reached here.
 */
export type Eligibility = "pay" | "fixture" | "no-bank";

export function payoutEligibility(b: PlanBatch, hasBankOnFile: boolean): Eligibility {
  if (b.isFixture) return "fixture";
  if (!hasBankOnFile) return "no-bank";
  return "pay";
}

export function planExport(
  batches: PlanBatch[],
  accountsByUser: Map<string, PlanAccount>,
  open: (blob: string) => string | null,
): ExportPlan {
  const rows: PlannedRow[] = [];
  let skippedNoBank = 0;
  let excludedFixture = 0;

  for (const b of batches) {
    const acct = accountsByUser.get(b.user_id);
    // ONE RULE, shared with the Mercury rail. Presence is asked of the sealed
    // columns here because this module has them; the Mercury run asks it of
    // `account_last4`, which `setPayoutAccount` writes in the same statement.
    const verdict = payoutEligibility(b, Boolean(acct?.routing_encrypted && acct?.account_encrypted));
    if (verdict === "fixture") {
      excludedFixture += 1;
      continue;
    }
    if (verdict === "no-bank") {
      skippedNoBank += 1;
      continue;
    }
    // A verdict of "pay" means the account and both blobs are there, but the
    // compiler cannot see that through the helper. Narrowing rather than
    // asserting, so a future change to `payoutEligibility` that stops implying
    // it fails here instead of reaching `open()` with an undefined.
    if (!acct?.routing_encrypted || !acct?.account_encrypted) {
      skippedNoBank += 1;
      continue;
    }

    // ONE CORRUPT BLOB SKIPS ITS BATCH, never the whole export.
    //
    // A MISSING KEY IS NOT THIS CASE and is not handled here. It would make
    // EVERY blob fail, and counting each one as "no bank on file" produced a
    // header-only file with a trailing note blaming the crews. The route now
    // asks `bankKeyConfigured()` before it plans and refuses outright — which
    // also keeps this module free of the gate module, so the one place bank numbers
    // become plaintext is still the route handler.
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
      wire: {
        userId: b.user_id,
        payee: b.payee,
        kind: b.kind,
        netCents: Math.round(Number(b.net ?? 0) * 100),
        routing,
        account,
        bankName: acct.bank_name ?? null,
      },
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
