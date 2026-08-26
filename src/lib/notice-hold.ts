import { createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { likeLiteral } from "@/lib/sql-like";

/**
 * IS THIS PERSON SOMEBODY WE HAVE PROMISED NOT TO WRITE TO YET?
 *
 * The owner's instruction: nothing reaches a park renter until the roll is
 * loaded, the leases are executed, and he says they are comfortable. Nothing
 * enforced it. `parks.active` is an inbound visibility flag and gates no send;
 * the one unattended path was held shut only by a column nobody writes.
 *
 * So the switch lives HERE, inside the transports, and not at the call sites.
 * That is the whole design decision: there are a dozen places that can write to
 * a renter today and there will be more, and a guard each of them has to
 * remember is a guard the next one forgets. `sendEmail` and `sendSms` are two
 * doors, and everything leaves through one of them.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS CLOSED, WHICH IS THE OPPOSITE OF ITS NEIGHBOUR, AND DELIBERATELY.
 *
 * `recipientIsFixture` fails OPEN because it is a second gate and the cost of
 * missing one is an email to a mailbox we invented ourselves.
 *
 * The cost of missing one HERE is a real household — somebody who has signed
 * nothing and been told nothing — receiving a demand, an invite or a one-tap
 * link before anyone is ready for it. That is not a bug you fix forward; it is
 * a first impression, and there are twenty of them. A database blip must never
 * be the reason it happens.
 *
 * The price of failing closed is a send that is refused and reported, which
 * every caller in this codebase already surfaces as a sentence. A delayed
 * notice is recoverable. The other direction is not.
 *
 * ---------------------------------------------------------------------------
 * ONE ROUND TRIP, AND ALMOST ALWAYS AN INDEX-ONLY MISS. The question is asked
 * of `park_renters` joined to a HELD park, so when no park is holding — the
 * normal state once a park is running — the partial index answers immediately
 * and no renter row is examined.
 *
 * EMAIL USES ilike AND PHONE USES eq, for the same reasons recipient-gate.ts
 * gives: an address may be stored in any case, so it is a LIKE pattern and must
 * go through likeLiteral() or a `_` in somebody's address becomes a wildcard.
 * Numbers we write ourselves in E.164, so exact match is correct and safer.
 *
 * BOTH PHONE COLUMNS ARE CHECKED. `mobile_e164` is a number the resident gave
 * us and verified; `phone_on_file_with_park` is one the office wrote down. A
 * hold that only covered the first would let a text reach exactly the people
 * who never asked to be texted.
 */
export interface NoticeHold {
  /** True when this recipient belongs to a park that is holding notices. */
  held: boolean;
  /** The owner's own words for why, when he gave them. */
  reason: string | null;
  /** True when we could not find out. Treated as held; see above. */
  failed: boolean;
}

const CLEAR: NoticeHold = { held: false, reason: null, failed: false };

export async function recipientIsHeld(
  kind: "email" | "phone",
  value: string | null | undefined,
): Promise<NoticeHold> {
  const v = (value ?? "").trim();
  // Nothing to look up. The shape gates upstream have already refused an empty
  // recipient, so this is not the case that matters.
  if (!v) return CLEAR;

  // No database configured (tests, an env-less build). Nothing can be held
  // because nothing can be sent — and failing closed here would make every
  // unit test that touches a send fail for a reason unrelated to its subject.
  if (!hasSupabaseEnv() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return CLEAR;

  try {
    const admin = createServiceClient();
    // The join does the work: only renters of a park with a non-null
    // notices_held_at come back at all.
    const q = admin
      .from("park_renters")
      .select("id, parks!inner(notices_held_at, notices_held_reason)")
      .not("parks.notices_held_at", "is", null)
      .limit(1);

    const { data, error } = kind === "email"
      ? await q.ilike("email", likeLiteral(v.toLowerCase()))
      // A number the office wrote down is still a number this park owns.
      : await q.or(`mobile_e164.eq.${v},phone_on_file_with_park.eq.${v}`);

    if (error) {
      // `{error, data:null}` reads exactly like "no rows" — the house bug, and
      // here "no rows" means SEND. Say which one happened and refuse.
      console.error(`[notice-hold] lookup failed, HOLDING the send: ${error.message}`);
      return { held: true, reason: null, failed: true };
    }

    const row = data?.[0] as { parks?: { notices_held_reason?: string | null } } | undefined;
    if (!row) return CLEAR;
    const park = Array.isArray(row.parks) ? row.parks[0] : row.parks;
    return { held: true, reason: park?.notices_held_reason ?? null, failed: false };
  } catch (e) {
    console.error(`[notice-hold] lookup threw, HOLDING the send: ${e instanceof Error ? e.message : e}`);
    return { held: true, reason: null, failed: true };
  }
}

/** What the caller says out loud when a send is refused. */
export function holdRefusal(hold: NoticeHold): string {
  if (hold.failed) {
    return "We couldn't check whether this park is holding notices, so nothing was sent. Try again in a minute.";
  }
  return hold.reason
    ? `Notices are on hold for this park — ${hold.reason}`
    : "Notices are on hold for this park. Lift the hold in Park setup when everyone is ready.";
}
