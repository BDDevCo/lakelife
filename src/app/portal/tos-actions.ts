"use server";

import { createClient } from "@/lib/supabase/server";
import { ensureTos } from "@/lib/tos-server";
import { ReadFailed, readFailedMessage } from "@/lib/must-read";

export interface AcceptResult {
  ok: boolean;
  /** Already a sentence for the screen. Never a raw reason code. */
  error?: string;
}

/**
 * RECORD THAT SOMEBODY AGREED, AND SAY WHETHER IT WORKED.
 *
 * One writer for all four doors — the crew's gate, the park owner's, the
 * resident's, and the grandfathered-crew card — so four screens cannot record
 * four slightly different things. It goes through `ensureTos`, which carries
 * the exact words into the ledger.
 *
 * IT USED TO REDIRECT AND SAY NOTHING. As a bare form action it returned
 * `void`: on a failed write it simply returned, the page re-rendered
 * identically, and the person who had just tapped "I agree" was left looking
 * at the same card with no idea whether anything had happened. Tapping again
 * might work or might do the same nothing. That is the worst shape a failure
 * can take — indistinguishable from success on a slow connection, and
 * indistinguishable from a broken button.
 *
 * So it returns a RESULT, and the button reports it. Navigation moved to the
 * client for the same reason: a redirect cannot carry a sentence.
 */
export async function acceptTos(): Promise<AcceptResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You're signed out. Sign in again and this will be here." };
  }

  try {
    // "needs" here means the write itself failed — this call already carries
    // accepted=true, so there is nothing else it can mean.
    if ((await ensureTos(user.id, true)) !== "ok") {
      return { ok: false, error: "We couldn't record that just now. Try once more." };
    }
  } catch (e) {
    if (e instanceof ReadFailed) {
      return { ok: false, error: readFailedMessage("what you've already agreed to", e) };
    }
    throw e;
  }

  return { ok: true };
}
