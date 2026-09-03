import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { opsReasonText, REISSUABLE } from "@/lib/claim-reasons";
import { mustRead } from "@/lib/must-read";

/**
 * THE READER THE CLAIM LOG NEVER HAD.
 *
 * `park_renter_claim_events` has recorded every slip printed, every invite
 * sent, every refusal and every claim since 0128 — and nothing has ever
 * displayed one. Ops-only by RLS, ops-visible by nothing. `actor_email` was
 * given a writer in 0130 and still had no reader; this is it.
 *
 * ---------------------------------------------------------------------------
 * NOT A LOG DUMP. A log with a hundred rows and no question attached is a
 * thing nobody opens twice.
 *
 * The question worth asking is: WHO IS STUCK. A household that has been
 * refused more than once and still cannot get in is a person who needs a phone
 * call, and they are invisible everywhere else — the park owner's roll shows
 * "Slip out" whether they tried nine times or never opened the envelope.
 *
 * ---------------------------------------------------------------------------
 * AND IT STAYS AWAY FROM THE PARK OWNER, ON PURPOSE.
 *
 * A failed attempt must not become a durable note about a resident rendered on
 * their landlord's screen (0128). That is why the log's only policy is
 * `ll_is_ops()` and why this module lives under /ops. The park owner sees a
 * fact about a CODE — out, expired, used — and never a fact about a person's
 * struggle with it.
 */

/** How many refusals before somebody is "stuck" rather than fat-fingered. */
const STUCK_AT = 2;

export interface StuckHousehold {
  renterId: string;
  parkName: string;
  lotNumber: string;
  displayName: string;
  /** Refusals since their last fresh start. */
  attempts: number;
  /** The newest refusal, already in words. */
  latest: string;
  latestAt: string;
  /** True when the office could fix it by sending or printing another. */
  reissue: boolean;
}

/**
 * Households who have tried and failed, and still cannot get in.
 *
 * A refusal only counts if it is still UNRESOLVED: anyone who has since
 * claimed, or who has said no thanks, is nobody's problem. Counting raw
 * refusals would keep a household on this list forever because they mistyped
 * once in December.
 */
export async function getStuckHouseholds(): Promise<StuckHousehold[]> {
  const admin = createServiceClient();

  const { data: events, error } = await admin
    .from("park_renter_claim_events")
    .select("renter_id, park_id, event, refusal_reason, occurred_at")
    .eq("event", "refused")
    .order("occurred_at", { ascending: false })
    .limit(500);

  // NOT SWALLOWED. An error here reads as "nobody is stuck", which is the most
  // reassuring possible way to be wrong.
  if (error) {
    console.error("[ops] claim log read failed", error.message);
    return [];
  }
  if (!events || events.length === 0) return [];

  const byRenter = new Map<string, typeof events>();
  for (const e of events) {
    // Since 0153 a refusal may name no household — a wrong lot number, or a
    // code typed against a park with no such lot. Those are real refusals and
    // they COUNT in the tally, but there is nobody to ring about them, so
    // they cannot join a list whose every row is a person to call. Skipping
    // them here rather than at the query keeps that distinction one place.
    const id = e.renter_id as string | null;
    if (id == null) continue;
    const list = byRenter.get(id);
    if (list) list.push(e); else byRenter.set(id, [e]);
  }
  if (byRenter.size === 0) return [];

  const ids = [...byRenter.keys()];
  // These two DECIDE WHO APPEARS. The refusals are already in hand at this
  // point, so a lost read below does not produce "nobody is stuck" out of thin
  // air — it drops people who ARE stuck out of a list built from their own
  // failures. /ops wraps this loader in its own try/catch, so the throw is
  // logged there rather than becoming a shorter, plausible list.
  const files = mustRead(
    "the household files behind those refusals",
    await admin
      .from("park_renters")
      .select("id, park_id, display_name, user_id, claim_declined_at, parks(name)")
      .in("id", ids),
  );

  // Still-open files only. Claimed or declined means the story ended well
  // enough, whatever happened on the way.
  const open = (files ?? []).filter(
    (f) => f.user_id == null && f.claim_declined_at == null,
  );
  if (open.length === 0) return [];

  const stays = mustRead(
    "which lot each of those households is on",
    await admin
      .from("lot_reservations")
      .select("renter_id, park_lots(lot_number)")
      .in("renter_id", open.map((f) => f.id as string))
      .in("status", ["approved", "active"]),
  );
  const lotBy = new Map<string, string>();
  for (const s of stays ?? []) {
    const n = (s.park_lots as { lot_number?: string } | null)?.lot_number;
    if (n) lotBy.set(s.renter_id as string, n);
  }

  const out: StuckHousehold[] = [];
  for (const f of open) {
    const list = byRenter.get(f.id as string) ?? [];
    if (list.length < STUCK_AT) continue;
    const newest = list[0];
    const reason = (newest.refusal_reason as string) ?? "";
    out.push({
      renterId: f.id as string,
      parkName: ((f.parks as { name?: string } | null)?.name as string) ?? "—",
      lotNumber: lotBy.get(f.id as string) ?? "—",
      displayName: (f.display_name as string) ?? "—",
      attempts: list.length,
      latest: opsReasonText(reason),
      latestAt: newest.occurred_at as string,
      reissue: REISSUABLE.has(reason),
    });
  }

  // Most attempts first: the person who has tried six times is having a worse
  // day than the one who has tried twice.
  return out.sort((a, b) => b.attempts - a.attempts).slice(0, 25);
}

export interface ClaimTally {
  invitesSent: number;
  slipsPrinted: number;
  claimed: number;
  refused: number;
  /**
   * Refusals with no household to trace them to (0153): a wrong lot number,
   * or a code typed against a park that has no such lot. They are somebody's
   * bad morning, but nobody's phone number — so the card must not fold them
   * into a sentence about people who "got in or said no thanks".
   */
  refusedUnattributed: number;
  declined: number;
  /** True when the log has never been written to at all. */
  empty: boolean;
}

/**
 * The counts, over the last 30 days.
 *
 * COUNTS, NOT PERCENTAGES. At one park with nineteen households "68%
 * converted" is a number with thirteen people behind it and no useful
 * precision; "13 of 19 are in" is the same fact without the false confidence.
 */
export async function getClaimTally(): Promise<ClaimTally> {
  const admin = createServiceClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data, error } = await admin
    .from("park_renter_claim_events")
    .select("event, renter_id")
    .gte("occurred_at", since);

  if (error) {
    console.error("[ops] claim tally read failed", error.message);
    // KNOWN RESIDUAL, and it is a lie: `empty: true` is what the card reads as
    // "nobody has started onboarding a park yet". Ending it needs a third state
    // on OpsStuckClaims — "we couldn't check" — rather than a different value
    // for a flag that only has two meanings. Until then it at least logs, and
    // /ops no longer manufactures this branch out of the OTHER read's failure.
    return {
      invitesSent: 0, slipsPrinted: 0, claimed: 0,
      refused: 0, refusedUnattributed: 0, declined: 0, empty: true,
    };
  }

  const n = (kind: string) => (data ?? []).filter((r) => r.event === kind).length;
  return {
    invitesSent: n("invite_sent"),
    slipsPrinted: n("code_issued"),
    claimed: n("claimed"),
    refused: n("refused"),
    refusedUnattributed: (data ?? []).filter(
      (r) => r.event === "refused" && r.renter_id == null,
    ).length,
    declined: n("declined"),
    empty: (data ?? []).length === 0,
  };
}
