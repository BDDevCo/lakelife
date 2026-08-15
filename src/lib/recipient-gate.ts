import { createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { likeLiteral } from "@/lib/sql-like";

/**
 * IS THERE A PERSON BEHIND THIS ADDRESS?
 *
 * The shape gate in contactable.ts answers a question about a STRING — is this
 * address reserved as unroutable — and it answers it perfectly, because RFC
 * 2606 and the 555 exchange are facts no data can contradict. What it cannot
 * see is a fixture wearing `jane.doe@gmail.com`, which is a perfectly good
 * mailbox belonging to a perfectly real stranger.
 *
 * That question is about a ROW, so this asks the row. `users.is_fixture` (0126)
 * is set by whoever creates a fixture and, as a convenience, by a trigger when
 * the contact details are already in reserved space.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS OPEN, ON PURPOSE, AND THAT IS THE ONLY SAFE DIRECTION HERE.
 *
 * If the database is unreachable, or the query errors, or there is no such
 * user, this returns FALSE — meaning "no evidence this is a fixture", meaning
 * the send proceeds. The alternative is that a database blip silences every
 * receipt, confirmation and crew dispatch text in the product at once, and
 * nobody finds out until a customer complains.
 *
 * That is safe because it is the SECOND gate, not the only one. The shape gate
 * has already run and cannot fail open — it is pure, it touches nothing, and it
 * catches every address that is provably unroutable. This layer only adds the
 * plausible-address case, and the cost of missing one of those is an email to a
 * mailbox that we ourselves invented.
 *
 * ---------------------------------------------------------------------------
 * WHY EMAIL USES ilike AND PHONE USES eq.
 *
 * `users.email` is synced from Supabase auth (0003), so this repo cannot
 * promise what case it is stored in — the lookup has to be case-insensitive.
 * That makes it a LIKE PATTERN, where `_` and `%` are wildcards, so the value
 * goes through likeLiteral() first. Skipping that is the bug d5fe0d9 fixed
 * nine times over: an address is not a search pattern, and here an unescaped
 * `_` would let one fixture's flag suppress a real customer's mail.
 *
 * `users.phone` we write ourselves, in E.164, from the verification flow — so
 * exact match is both correct and strictly safer than any pattern.
 */
export async function recipientIsFixture(
  kind: "email" | "phone",
  value: string | null | undefined,
): Promise<boolean> {
  const v = (value ?? "").trim();
  if (!v) return false;

  try {
    // No database configured (tests, an env-less build) — nothing to ask, and
    // the shape gate has already had its say.
    if (!hasSupabaseEnv() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return false;

    const admin = createServiceClient();
    const { data, error } = kind === "email"
      ? await admin.from("users").select("is_fixture").ilike("email", likeLiteral(v.toLowerCase())).limit(1)
      : await admin.from("users").select("is_fixture").eq("phone", v).limit(1);

    // `{error, data:null}` reads exactly like "no rows" — the house bug. Say
    // which one happened rather than letting an error masquerade as an answer.
    if (error) {
      console.warn(`[recipient-gate] lookup failed, allowing send: ${error.message}`);
      return false;
    }
    return data?.[0]?.is_fixture === true;
  } catch (e) {
    console.warn(`[recipient-gate] lookup threw, allowing send: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
