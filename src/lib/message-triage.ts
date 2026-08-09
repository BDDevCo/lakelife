import "server-only";
import { sendSms } from "@/lib/sms";
import { screenMessage, type Population, type FenceVerdict } from "@/lib/comms-fence";

/**
 * THE PAGE CHANNEL — where a message the fence refused actually goes.
 *
 * The fence (lib/comms-fence.ts) decides a machine must not answer something.
 * Before this module existed, that decision went nowhere: maybeAutoReply()
 * returned, nothing was flagged, and the nightly digest only reported messages
 * the MACHINE wrote. "I smell gas by the trailer" was correctly refused an
 * automated reply and then sat silently in a thread nobody watches.
 *
 * That made the safety fence QUIETER than the thing it replaced, which is the
 * one outcome a safety change must never have. Hence: refusing to answer and
 * telling someone are the same commit.
 *
 * The rule is simple and it is about trust:
 *   emergency  -> page a human OUT OF BAND, now, by text
 *   never_ai   -> the ops queue, with the reason
 *   hold       -> the ops queue, with the reason
 *   allow      -> nothing; the machine may proceed
 *
 * Only `emergency` texts anybody. An on-call who is paged for rain learns in
 * ten days that the page means weather, and then does not open the one that
 * means gas. Protecting the page is protecting the person.
 */

/** How many ops phones a single emergency reaches. Small on purpose — this is
 *  a page, not a broadcast, and everyone being responsible is nobody being
 *  responsible. */
const PAGE_FANOUT = 2;

export interface TriageResult {
  verdict: FenceVerdict;
  /** Persisted onto the message row so ops sees WHY, and so the record of what
   *  we knew at the time cannot be rewritten by a later rule edit. */
  columns: {
    fence_outcome: string;
    fence_reason: string | null;
    paged_at: string | null;
  };
  paged: boolean;
}

type Admin = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (a: string, b: string) => {
        not: (a: string, op: string, c: null) => {
          limit: (n: number) => Promise<{ data: { phone?: string | null }[] | null }>;
        };
      };
    };
  };
};

/**
 * Screen a message, and — if it needs a human NOW — page one before returning.
 *
 * Paging is best-effort and deliberately never throws: a failed text must not
 * roll back the customer's message, and it must not stop the row being marked
 * `emergency`. An emergency row with a null `paged_at` is a monitorable
 * failure, which is exactly why that column is a timestamp rather than a
 * boolean — "we tried and could not reach anyone" has to be visible.
 */
export async function triageInboundMessage(
  admin: unknown,
  body: string,
  population: Population,
  context: { where?: string | null },
): Promise<TriageResult> {
  const verdict = screenMessage(body, population);

  if (verdict.outcome === "allow") {
    return {
      verdict,
      columns: { fence_outcome: "allow", fence_reason: null, paged_at: null },
      paged: false,
    };
  }

  let pagedAt: string | null = null;

  if (verdict.outcome === "emergency") {
    try {
      const db = admin as Admin;
      const { data: ops } = await db
        .from("users")
        .select("phone")
        .eq("role", "ops")
        .not("phone", "is", null)
        .limit(PAGE_FANOUT);

      const phones = (ops ?? [])
        .map((o) => o.phone)
        .filter((p): p is string => typeof p === "string" && p.length > 0);

      if (phones.length > 0) {
        // The page carries the customer's OWN WORDS, trimmed. A page that says
        // "a message needs attention" makes someone open an app to find out
        // whether to get in the truck; the words are what let them decide from
        // the driveway.
        const excerpt = body.trim().replace(/\s+/g, " ").slice(0, 140);
        const where = context.where ? ` — ${context.where}` : "";
        const text =
          `LakeLife URGENT${where}: "${excerpt}"\n` +
          `${verdict.opsLine ?? "Needs a person now."} Call them.`;
        await Promise.all(phones.map((p) => sendSms(p, text)));
        pagedAt = new Date().toISOString();
      }
    } catch {
      // Swallowed on purpose. The row is still marked `emergency` with a null
      // paged_at, which is the signal that nobody was reached.
    }
  }

  return {
    verdict,
    columns: {
      fence_outcome: verdict.outcome,
      fence_reason: verdict.opsLine,
      paged_at: pagedAt,
    },
    paged: pagedAt != null,
  };
}

/**
 * Which population is on the other end of a property thread?
 *
 * FAILS CLOSED. Anything we cannot positively identify as a lake customer is
 * `unknown`, which runs every rule and auto-sends nothing. The failure this
 * guards against is specific and was found by red-teaming the fence: a park
 * applicant with no membership row currently lands on /book, the homeowner
 * product, whose whole job is to get them to add a property — at which point a
 * naive check would stamp them `lake_customer` and hand them the one channel
 * where housing rules are off.
 *
 * So the test is not "are they a park member?". It is "is there ANY park trace
 * on this person?" — a renter file or a reservation is enough to disqualify
 * the loose lane.
 */
export async function populationForOwner(
  admin: unknown,
  ownerId: string,
): Promise<Population> {
  const db = admin as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (a: string, b: string) => { limit: (n: number) => Promise<{ data: unknown[] | null }> };
      };
    };
  };

  try {
    const [{ data: member }, { data: renter }] = await Promise.all([
      db.from("park_members").select("park_id").eq("user_id", ownerId).limit(1),
      db.from("park_renters").select("id").eq("user_id", ownerId).limit(1),
    ]);
    if ((member ?? []).length > 0) return "park_owner";
    if ((renter ?? []).length > 0) return "park_tenant";
    return "lake_customer";
  } catch {
    // We could not tell. That is not a reason to pick the permissive answer.
    return "unknown";
  }
}
