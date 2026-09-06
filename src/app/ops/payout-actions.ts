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

/**
 * A PAYOUT THE BANK HANDED BACK.
 *
 * `markBatchesPaid` moved a batch one way and nothing moved it the other. A
 * payout leaves as a line in a bank file, and three to five business days
 * later the bank can return it — closed account, wrong routing number, a digit
 * transposed off a cheque. Until now that batch stayed 'exported' or 'paid'
 * forever, and — the half that costs real money — the crew's `payouts` rows
 * stayed stamped with its `batch_id`.
 *
 * Every re-batch query in the product filters on `batch_id is null`. So a crew
 * whose bank details were wrong by one digit was owed money this product could
 * no longer pay them, through any path, ever, and no screen said so.
 *
 * `payout_batches.status` has permitted 'failed' since 0039 and nothing had
 * ever written it. `returned_at` and `returned_reason` arrive in 0158.
 *
 * WHAT THIS DOES NOT DECIDE: whether the crew is charged for the return, or
 * whether they are chased or simply asked for new details. Those are the
 * owner's calls and none of them are encoded here. This records the fact and
 * puts the money back where the next run can reach it.
 */
export async function markBatchesReturned(batchIds: string[], reason: string): Promise<OpsResult> {
  if (!(await assertOps())) return { ok: false, error: DENIED };
  const ids = batchIds.filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  // A returned payout with no reason is a mystery six months later, and the
  // reason is the only thing that tells the crew what to fix. The bank gives
  // one on every return; it is never unknown at the moment this is clicked.
  const why = (reason ?? "").trim().slice(0, 300);
  if (!why) {
    return { ok: false, error: "Say what the bank gave back — the return code, or what they told you." };
  }

  const admin = createServiceClient();

  // ORDER MATTERS, AND IT IS THIS WAY ROUND ON PURPOSE. Marking the batch
  // failed first means the worst case is money still tied to a batch nothing
  // will export again — recoverable, and reported below. Freeing the payouts
  // first and then failing to fail the batch would leave those rows claimable
  // by the next run while the old batch was still exportable: the same money
  // in two bank files.
  //
  // Scoped to the two statuses that mean "this has been in a bank file":
  // exported (downloaded, not yet confirmed) and paid (confirmed). NEVER
  // queued — a queued batch has not been anywhere, so nothing could have come
  // back, and calling it returned would strand real money with no trail.
  // `paid_at` is deliberately left alone: it records the day ops said the file
  // went up, which did happen. The return is a later fact, not a correction.
  const { data, error } = await admin
    .from("payout_batches")
    .update({ status: "failed", returned_at: new Date().toISOString(), returned_reason: why })
    .in("id", ids)
    .in("status", ["exported", "paid"])
    .select("id");

  if (error) {
    return { ok: false, error: "Couldn't record that return — nothing was changed. Try again." };
  }

  const returned = (data ?? []).map((r) => r.id as string);
  if (returned.length === 0) {
    return {
      ok: false,
      error: "None of those have been in a bank file yet, so nothing could have come back.",
    };
  }

  // The half that lets the crew be paid again: released payouts go back to
  // un-batched, so the next month-end run picks them up for the corrected
  // account. Their status is untouched — the work was done and the money is
  // still theirs; only the envelope failed.
  const { error: freeErr } = await admin.from("payouts").update({ batch_id: null }).in("batch_id", returned);

  revalidatePath("/ops");

  if (freeErr) {
    // "Returned" is now true and "it will go out again next month" is not.
    // The crew is the one who would otherwise discover that.
    return {
      ok: false,
      error:
        `${returned.length === 1 ? "That batch is" : "Those batches are"} marked returned, but the pay is ` +
        `still attached to ${returned.length === 1 ? "it" : "them"} and won't re-batch. Run this again.`,
    };
  }

  return {
    ok: true,
    signal:
      `${returned.length} ${returned.length === 1 ? "batch" : "batches"} marked returned. ` +
      `That pay goes back in the queue for the next run — fix the crew's bank details first.`,
  };
}
