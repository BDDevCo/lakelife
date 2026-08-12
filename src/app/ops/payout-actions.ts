"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";

/**
 * CLOSING A PAYOUT BATCH.
 *
 * `payout_batches.paid_at` was declared in 0039 and written by NOTHING. The
 * export route filtered on `.is("paid_at", null)` and the route's own comment
 * said the file "remains re-downloadable until batches are marked paid" — but
 * no code marked them, so the condition was true forever.
 *
 * The consequence was not cosmetic. Batches flip queued → exported on
 * download, and the export pulled `['queued','exported']` where paid_at is
 * null. So month two's ACH file contained month one's rows again, with
 * decrypted routing and account numbers. Uploading it pays every crew twice.
 *
 * This is the missing half: the human who uploads the file says so, and the
 * batch stops being re-emitted. Nothing infers payment — a bank upload is not
 * observable from here, and guessing that money moved is exactly the kind of
 * write that must never happen unattended.
 */

export interface OpsResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

const DENIED = "Operations access required.";

/**
 * Mark exported batches as paid — the bank file went up, the money is gone.
 *
 * Scoped to `exported` on purpose: a queued batch has not been in a file yet,
 * so calling it paid would strand real money owed to a crew with no trail.
 */
export async function markBatchesPaid(batchIds: string[]): Promise<OpsResult> {
  if (!(await assertOps())) return { ok: false, error: DENIED };
  const ids = batchIds.filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("payout_batches")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "exported") // only something that has actually been in a file
    .select("id");

  if (error) return { ok: false, error: "Couldn't close those out — try again." };

  const n = (data ?? []).length;
  if (n === 0) {
    return {
      ok: false,
      error: "None of those were waiting to be marked paid — they may already be closed.",
    };
  }
  revalidatePath("/ops");
  return {
    ok: true,
    signal:
      `${n} ${n === 1 ? "batch" : "batches"} marked paid. ` +
      `They won't appear in another export.`,
  };
}
