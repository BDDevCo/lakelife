import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { openEnvelope } from "@/lib/gate";
import { createRecipient, recipientKey } from "@/lib/mercury";

/**
 * THE ONE PLACE A CREW'S BANK DETAILS BECOME PLAINTEXT FOR MERCURY.
 *
 * `route.test.ts` keeps a list of the only files allowed to name
 * `routing_encrypted` or `account_encrypted`, and it caught the first version
 * of the Mercury run doing it in the middle of a batch loop. That fence is
 * right, and the fix was not to widen it casually: it was to make the
 * decryption a function with ONE job, so the payout run never holds a bank
 * number at all.
 *
 * It also makes true a claim `src/lib/mercury.ts` was already making and the
 * first draft did not honour — that a crew's details are handed over ONCE
 * rather than re-sent with every run.
 *
 * ===========================================================================
 * ONCE PER CREW, AND THE ID IS THE POINT
 * ===========================================================================
 *
 * After this runs, `payout_accounts.mercury_recipient_id` addresses the crew
 * and nothing needs their numbers again. So the window in which this product
 * holds a readable routing number is one function call, the first time a crew
 * is ever paid through Mercury.
 */

export interface RecipientResult {
  ok: boolean;
  recipientId?: string;
  /** A sentence for ops. Never a raw API body, never a bank number. */
  error?: string;
}

/**
 * Get Mercury's id for this crew, creating it if this is the first time.
 *
 * `existingId` is passed in rather than re-read, because the caller has
 * already read the account row and a second read is a second chance to
 * disagree with itself.
 */
export async function ensureMercuryRecipient(
  userId: string,
  payeeName: string,
  existingId: string | null,
): Promise<RecipientResult> {
  if (existingId) return { ok: true, recipientId: existingId };

  const admin = createServiceClient();
  const res = await admin
    .from("payout_accounts")
    .select("routing_encrypted, account_encrypted")
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) {
    console.error("[mercury recipient] could not read the sealed details:", res.error.message);
    return { ok: false, error: "We couldn't read their bank details just now, so they weren't set up at Mercury." };
  }
  const row = res.data as { routing_encrypted: string | null; account_encrypted: string | null } | null;
  if (!row?.routing_encrypted || !row?.account_encrypted) {
    return { ok: false, error: "No bank details on file for them yet." };
  }

  // ONE UNOPENABLE BLOB STOPS THIS CREW, never the run. The caller asks
  // `bankKeyConfigured()` before any of this, so reaching here with a blob
  // that will not open means THIS row is corrupt rather than the key missing —
  // a distinction the CSV rail already learned to make.
  let routing = "", account = "";
  try {
    routing = openEnvelope(row.routing_encrypted) ?? "";
    account = openEnvelope(row.account_encrypted) ?? "";
  } catch {
    routing = "";
  }
  if (!routing || !account) {
    console.error(`[mercury recipient] the sealed details for ${userId} would not open`);
    return { ok: false, error: "Their saved bank details wouldn't open — they'll need to add them again." };
  }

  const made = await createRecipient(
    {
      name: payeeName,
      routing,
      account,
      // WE HAVE NEVER ASKED CHECKING OR SAVINGS. `payout_accounts` has no such
      // column: the CSV never needed one because the bank matched on the
      // routing number, and Mercury does. 'checking' is overwhelmingly the
      // common case for a business payee, so it is the assumption the first
      // run makes — and it is the FIRST THING TO CHECK if a credit comes back.
      // The real fix is a field on the crew's own bank screen, which is a
      // question for a crew rather than a guess by us.
      accountKind: "checking",
      email: null,
    },
    recipientKey(userId),
  );
  if (!made.ok || !made.data) {
    return { ok: false, error: made.error ?? "Mercury wouldn't take them as a payee." };
  }

  const saved = await admin
    .from("payout_accounts")
    .update({ mercury_recipient_id: made.data.id })
    .eq("user_id", userId);
  if (saved.error) {
    // THE PAYEE EXISTS AT MERCURY AND WE CANNOT REMEMBER ITS ID. The next run
    // would create a duplicate, so this must stop the crew here and say so
    // loudly rather than return an id we failed to persist.
    console.error(
      `[mercury recipient] created ${made.data.id} for ${userId} and could not store it:`,
      saved.error.message,
    );
    return {
      ok: false,
      error:
        "Mercury has them as a payee but we couldn't save that — fix it before the next run " +
        "or they'll be added twice.",
    };
  }

  return { ok: true, recipientId: made.data.id };
}
