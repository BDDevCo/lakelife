"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { mintClaimCode, normalizeClaimCode } from "@/lib/claim-code";
import {
  claimSays, claimWorked, issueSays, issueWorked, officeCanReprint,
} from "@/lib/park-claim-copy";

/**
 * THE TWO ENDS OF A SLIP OF PAPER.
 *
 * Everything of consequence happens in the database (0128, 0129). These
 * functions carry a string there and a sentence back; they decide nothing.
 * That is on purpose — every rule that matters is in a trigger or a SECURITY
 * DEFINER function, so a future caller written in a hurry cannot skip one.
 *
 * ============================================================================
 * THE USER-SCOPED CLIENT, NOT THE SERVICE ROLE.
 *
 * Every other file under src/app/park* reaches for `createServiceClient()`,
 * which bypasses RLS and carries no session. Claiming must NOT: the whole
 * design rests on the person being `auth.uid()` — a fact the database reads
 * off the session — rather than an id this code passes in. `claim_park_file`
 * accepts no user id and no renter id precisely so there is nothing on the
 * wire to forge, and calling it with the service role would hand it a null
 * identity and refuse every time.
 *
 * That is the crew-invite lesson, kept: claimCrewInvite took the email as an
 * ARGUMENT and anyone signed in could pass somebody else's. The fix there was
 * to derive it from the session. Here the database does that itself.
 */

export interface ClaimResult {
  ok: boolean;
  /** Already a sentence for the screen. Never a raw reason code. */
  message: string;
  /** True when the office can fix this by printing another slip. */
  reprintable?: boolean;
  outcome: string;
}

/**
 * A resident attaches their own account to their own file.
 *
 * Takes what is on the slip and what she already knows — the park, her lot,
 * and the code. Nothing about her identity is a parameter.
 */
export async function claimMyFile(input: {
  parkSlug: string;
  lotNumber: string;
  code: string;
}): Promise<ClaimResult> {
  const supabase = await createClient();

  // Shape-check here as well as in SQL. Not distrust of the database — it is
  // the difference between a helpful sentence about the code and a round trip
  // that comes back saying the same thing more slowly.
  const code = normalizeClaimCode(input.code);
  if (!code) {
    return {
      ok: false,
      outcome: "claim_code_malformed",
      message: claimSays("claim_code_malformed"),
    };
  }

  const parkSlug = (input.parkSlug ?? "").trim().toLowerCase();
  const lotNumber = (input.lotNumber ?? "").trim();
  if (!parkSlug || !lotNumber) {
    return { ok: false, outcome: "claim_no_open_lot", message: claimSays("claim_no_open_lot") };
  }

  const { data, error } = await supabase.rpc("claim_park_file", {
    p_park_slug: parkSlug,
    p_lot_number: lotNumber,
    p_code: code,
  });

  if (error) {
    // A transport or permission failure is not a refusal. Saying "that code
    // isn't right" here would send her back to a slip that is perfectly fine.
    console.error("[claim] rpc failed", error.message);
    return {
      ok: false,
      outcome: "rpc_error",
      message: "We couldn't reach your records just now. Try again in a minute.",
    };
  }

  const outcome = String(data ?? "");
  if (claimWorked(outcome)) {
    revalidatePath("/parks/my");
    revalidatePath("/portal");
  }
  return {
    ok: claimWorked(outcome),
    outcome,
    message: claimSays(outcome),
    reprintable: !claimWorked(outcome) && officeCanReprint(outcome),
  };
}

export interface SlipResult {
  ok: boolean;
  message: string;
  /**
   * THE ONLY TIME THIS STRING EXISTS. It is minted here, hashed by Postgres,
   * and never stored in a form we can read back. If this response is lost, the
   * slip is lost — print another.
   */
  code?: string;
  outcome: string;
}

/**
 * The office mints a slip for one household.
 *
 * The PLAINTEXT is generated here rather than in SQL so it can be shown once
 * and printed; the database stores only a bcrypt hash of it. Nothing in this
 * app can recover the code afterwards, including us.
 *
 * NEVER TEXT OR EMAIL THE RESULT. A code arriving by the same channel as the
 * scam it resembles is not a credential — it is handed over, on paper, by a
 * person she recognises.
 */
export async function issueClaimSlip(renterId: string, days = 30): Promise<SlipResult> {
  const supabase = await createClient();
  const code = mintClaimCode();

  const { data, error } = await supabase.rpc("issue_park_claim_code", {
    p_renter_id: renterId,
    p_code: code,
    p_days: days,
  });

  if (error) {
    console.error("[claim] issue rpc failed", error.message);
    return { ok: false, outcome: "rpc_error", message: "Couldn't create a slip just now." };
  }

  const outcome = String(data ?? "");
  if (!issueWorked(outcome)) {
    return { ok: false, outcome, message: issueSays(outcome) };
  }

  revalidatePath("/park");
  return { ok: true, outcome, message: issueSays(outcome), code };
}

/** The office records that a household said no thanks. Permanent, and fine. */
export async function declineClaim(renterId: string): Promise<ClaimResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decline_park_claim", { p_renter_id: renterId });
  if (error) return { ok: false, outcome: "rpc_error", message: "That didn't save." };
  const outcome = String(data ?? "");
  if (outcome === "declined") {
    revalidatePath("/park");
    return { ok: true, outcome, message: "Noted — we won't ask them again." };
  }
  return { ok: false, outcome, message: issueSays(outcome) };
}

/** Release a claimed file: the resident themselves, the park, or ops. */
export async function releaseClaim(renterId: string): Promise<ClaimResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("release_park_claim", { p_renter_id: renterId });
  if (error) return { ok: false, outcome: "rpc_error", message: "That didn't save." };
  const outcome = String(data ?? "");
  if (outcome === "released") {
    revalidatePath("/park");
    revalidatePath("/parks/my");
    return { ok: true, outcome, message: "Released — a fresh slip will set it up again." };
  }
  return { ok: false, outcome, message: "That couldn't be released." };
}

/**
 * What the owner may see about a household's slip: a fact about the CODE,
 * never a fact about a person. 'none' | 'open' | 'used' | 'expired' |
 * 'locked' | 'declined'.
 *
 * The refusal log itself is ops-only on purpose — a failed attempt must not
 * become a durable record about a resident rendered on their landlord's
 * screen.
 */
export async function claimStatusFor(renterIds: string[]): Promise<Record<string, string>> {
  if (!renterIds.length) return {};
  const supabase = await createClient();
  const out: Record<string, string> = {};
  await Promise.all(
    renterIds.map(async (id) => {
      const { data } = await supabase.rpc("park_claim_code_status", { p_renter_id: id });
      if (data) out[id] = String(data);
    }),
  );
  return out;
}
