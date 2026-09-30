import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";

/**
 * HOW MANY VERIFICATION CODES ONE PARTY MAY ASK FOR.
 *
 * Every other gate in front of a send answers "may we contact this person at
 * all" — reserved space (contactable.ts), a fixture account (recipient-gate),
 * a park holding its notices (notice-hold). None of them answers "how often",
 * and the Twilio VERIFY path had no answer to that question from either of its
 * two doors: the sign-up route and the park opt-in action both walked straight
 * from a shape check into `verifications.create`.
 *
 * That is a loop somebody can run. Accounts are free, the route is behind a
 * session and nothing more, and each turn of the loop is a real text to a real
 * handset and a real line on the Twilio bill. Twilio's own caps are per
 * DESTINATION NUMBER; a loop that walks numbers is unbounded by them.
 *
 * THE SHAPE IS THE ONE THIS CODEBASE ALREADY USES. The park claim door counts
 * attempts and locks (0166); slip issuance counts a 24-hour window and refuses
 * at 40 (0129). This is that, for a different door, on its own table.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS CLOSED. A limiter that cannot read its own table is not a limiter,
 * and the failure it would wave through is spend and a stranger's phone
 * ringing. The cost of failing closed is a resident told to try again in a
 * minute — the sentence every other refused send in this app already says.
 */

/** The table. One name, so a rename is one edit. */
export const VERIFY_ATTEMPTS = "verify_attempts";

/**
 * FOUR CEILINGS, BECAUSE THERE ARE FOUR DIFFERENT ABUSES.
 *
 * numberHour/numberDay protect the HANDSET — somebody else's phone made to
 * buzz. userDay protects the BILL from one account. ipHour protects the bill
 * from one machine holding many accounts, which is the case the other three
 * cannot see.
 *
 * A resident who mistypes her number twice and then gets it right uses three.
 * Nobody honest uses a fourth in the same hour.
 */
export const VERIFY_LIMITS = {
  numberHour: 3,
  numberDay: 6,
  userDay: 10,
  ipHour: 15,
} as const;

export type VerifyLimitCode = "number_hour" | "number_day" | "user_day" | "ip_hour";

/** What the window holds, INCLUDING the attempt being decided. */
export interface VerifyTally {
  numberHour: number;
  numberDay: number;
  userDay: number;
  ipHour: number;
}

/**
 * Which ceiling this attempt breaks, or null.
 *
 * STRICTLY GREATER, NOT GREATER-OR-EQUAL, and that is not a taste: the tally
 * passed in already counts the attempt we are deciding. `numberHour: 3` means
 * three codes to one handset in an hour are fine and the fourth is not.
 *
 * Pure and dependency-free so the test can put every tally through it, and so
 * the four clauses can be collapsed one at a time.
 */
export function verifyLimitVerdict(
  t: VerifyTally,
  limits: typeof VERIFY_LIMITS = VERIFY_LIMITS,
): VerifyLimitCode | null {
  if (t.numberHour > limits.numberHour) return "number_hour";
  if (t.numberDay > limits.numberDay) return "number_day";
  if (t.userDay > limits.userDay) return "user_day";
  if (t.ipHour > limits.ipHour) return "ip_hour";
  return null;
}

export interface VerifyGate {
  /** True when a code may be sent. */
  allowed: boolean;
  /** Which ceiling stopped it, for the log. Never shown to a person. */
  code: VerifyLimitCode | null;
  /** True when we could not find out. Treated as refused; see above. */
  failed: boolean;
}

/**
 * The caller's address, as Vercel wrote it.
 *
 * A COARSE KEY AND A SECOND ONE, NEVER THE ONLY ONE. `x-forwarded-for` is set
 * by the platform in front of this function and is not the client's to choose
 * there, but it is shared by everybody behind one NAT and absent on a local
 * run — so it widens the net and never carries the decision alone. Null is an
 * ordinary answer and simply drops that clause.
 *
 * Works in a route handler and in a server action alike: both are request
 * scoped. Outside one, `headers()` throws and null is the honest answer.
 */
async function callerIp(): Promise<string | null> {
  try {
    const h = await headers();
    const first = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim();
    return first || h.get("x-real-ip") || null;
  } catch {
    return null;
  }
}

/**
 * RECORD THE ATTEMPT, THEN COUNT IT.
 *
 * That order is the whole concurrency story. Counting first and writing after
 * lets two requests arriving together both read "two so far" and both send —
 * the read-then-write race that 0171's header describes for status callbacks.
 * Writing first means each request's own row is in the window it then counts,
 * so the pair cannot both come in under the same ceiling.
 *
 * ONE READ, TALLIED HERE, like smsDeliveryReport: the day's rows touching this
 * number OR this user OR this address come back once and the four windows are
 * counted in this process. Four separate counts would be four ways for the
 * answer to be half true.
 */
export async function mayStartVerification(
  e164: string,
  userId: string | null,
  nowMs: number = Date.now(),
): Promise<VerifyGate> {
  // NO SUPABASE AT ALL means this is not a deployment — a unit test, or an
  // env-less build — and refusing here would fail every test that touches a
  // send for a reason unrelated to its subject. Same carve-out, and the same
  // narrowness, as recipientIsHeld.
  //
  // A CONFIGURED SUPABASE WITH NO SERVICE KEY IS A DIFFERENT FACT and gets the
  // opposite answer: that is a real deployment whose limiter cannot run, and
  // waving it through is how a guard becomes decorative.
  if (!hasSupabaseEnv()) return { allowed: true, code: null, failed: false };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[verify-rate] no service key, REFUSING the code");
    return { allowed: false, code: null, failed: true };
  }

  const ip = await callerIp();
  const dayAgo = new Date(nowMs - 24 * 3_600_000).toISOString();
  const hourAgo = new Date(nowMs - 3_600_000).toISOString();

  try {
    const admin = createServiceClient();

    const wrote = await admin
      .from(VERIFY_ATTEMPTS)
      .insert({ to_e164: e164, user_id: userId, ip });
    if (wrote.error) {
      // `{error}` here means the attempt is not in the window anybody will
      // count next — the limiter is blind from this moment on. Refuse.
      console.error(`[verify-rate] could not file the attempt, REFUSING: ${wrote.error.message}`);
      return { allowed: false, code: null, failed: true };
    }

    // `or` takes bare values; e164 is '+' and digits from toE164, a user id is
    // a uuid, and an address holds dots or colons. None can carry the comma
    // that would split this filter.
    const keys = [`to_e164.eq.${e164}`];
    if (userId) keys.push(`user_id.eq.${userId}`);
    if (ip) keys.push(`ip.eq.${ip}`);

    const { data, error } = await admin
      .from(VERIFY_ATTEMPTS)
      .select("to_e164, user_id, ip, created_at")
      .gte("created_at", dayAgo)
      .or(keys.join(","))
      .limit(1000);

    if (error) {
      // A failed COUNT must not make a guard PASS. {data:null,error} reads
      // exactly like "nobody has asked for a code today", and that reading
      // sends one.
      console.error(`[verify-rate] count failed, REFUSING the code: ${error.message}`);
      return { allowed: false, code: null, failed: true };
    }

    const tally: VerifyTally = { numberHour: 0, numberDay: 0, userDay: 0, ipHour: 0 };
    for (const row of data ?? []) {
      const r = row as { to_e164?: unknown; user_id?: unknown; ip?: unknown; created_at?: unknown };
      const at = String(r.created_at ?? "");
      const thisHour = at >= hourAgo;
      if (String(r.to_e164 ?? "") === e164) {
        tally.numberDay++;
        if (thisHour) tally.numberHour++;
      }
      if (userId && String(r.user_id ?? "") === userId) tally.userDay++;
      if (ip && String(r.ip ?? "") === ip && thisHour) tally.ipHour++;
    }

    const over = verifyLimitVerdict(tally);
    if (over) {
      console.warn(`[verify-rate] refused ${e164}: ${over}`);
      return { allowed: false, code: over, failed: false };
    }
    return { allowed: true, code: null, failed: false };
  } catch (e) {
    console.error(`[verify-rate] threw, REFUSING the code: ${e instanceof Error ? e.message : e}`);
    return { allowed: false, code: null, failed: true };
  }
}

/**
 * The sentence a person reads when they are refused.
 *
 * IT NAMES A WAIT, WHICH IS AN ACTION THIS SCREEN SUPPORTS. "Ring the office"
 * would be copy instructing an action the screen lacks — and for a homeowner
 * signing up there is no office. It never names which ceiling was hit: that is
 * a map of the limiter, drawn for whoever is probing it.
 */
export function verifyGateRefusal(gate: VerifyGate): string {
  return gate.failed
    ? "We couldn't check that just now, so no code was sent. Try again in a minute."
    : "That's a lot of codes in a short while. Wait an hour and try again.";
}

/**
 * WHO KEEPS THE TABLE SMALL. Called from the nightly cron — a counter table
 * with no sweeper is a table that grows for ever, and the widest window this
 * file asks about is 24 hours. Seven days is kept so a morning-after question
 * ("what did last night look like") still has rows to look at.
 */
export async function sweepVerifyAttempts(
  nowMs: number = Date.now(),
): Promise<{ swept: boolean; error?: string }> {
  if (!hasSupabaseEnv() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { swept: false, error: "no database configured" };
  }
  const cutoff = new Date(nowMs - 7 * 24 * 3_600_000).toISOString();
  try {
    const admin = createServiceClient();
    const { error } = await admin.from(VERIFY_ATTEMPTS).delete().lt("created_at", cutoff);
    if (error) {
      console.error(`[verify-rate] sweep failed: ${error.message}`);
      return { swept: false, error: error.message };
    }
    return { swept: true };
  } catch (e) {
    const why = e instanceof Error ? e.message : "sweep failed";
    console.error(`[verify-rate] sweep threw: ${why}`);
    return { swept: false, error: why };
  }
}
