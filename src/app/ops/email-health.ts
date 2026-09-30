import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { addDays } from "@/app/park/today-helpers";
import { emailDeliveryReport, type EmailDeliveryReport } from "@/lib/email-delivery";

/**
 * IS EMAIL ACTUALLY LANDING, AND WOULD WE KNOW IF IT STOPPED?
 *
 * ============================================================================
 * WHY THIS PANEL IS THE LOAD-BEARING ONE.
 * ============================================================================
 * The nightly digest carries a line about email delivery, and on a healthy
 * night that is enough. But THE DIGEST IS AN EMAIL. When email is what breaks,
 * the report about email breaking is the thing that does not arrive — the same
 * inversion automation-health.ts is built around, where an alarm sent BY the
 * scheduler cannot fire when the scheduler is what died.
 *
 * So this is computed when he opens the console, from data, through a channel
 * that is not the channel under test.
 *
 * ============================================================================
 * THREE SILENCES THAT LOOK IDENTICAL, AND ONLY ONE OF THEM IS FINE.
 * ============================================================================
 *   1. Nothing was sent. At 21 lots with notices held, plausible.
 *   2. Things were sent and NOTHING FILED A RECEIPT — the send path stopped
 *      recording. Every screen then reads clean because nothing is counted.
 *   3. Things were sent, receipts were filed, and NO VERDICT HAS EVER COME
 *      BACK — the webhook is not arriving. Every row sits at what Resend said
 *      the moment it took the message, which is precisely the sentence that
 *      hid the text outage for a month: accepted, and never anything else.
 *
 * TELLING (1) FROM (2) NEEDS A WITNESS OUTSIDE THE TABLE. There is one, and it
 * is already trusted: the nightly run writes a park_machine_runs row on its
 * LAST step (api/cron/nightly/route.ts:183) and sends the digest email
 * immediately afterwards (:281). A finished run in the window is therefore
 * proof that at least one email was attempted — provided somebody could
 * receive it, which is why the ops recipients are counted too.
 *
 * A FAILED COUNT MUST NOT MAKE THE SILENCE EXPLAINABLE. Null on either witness
 * is "we cannot rule it out", and it lands on the alarm side, never on the
 * side that says the quiet week was fine.
 */

/** How many days back the panel looks. Counts, never a percentage. */
export const WINDOW_DAYS = 7;

export interface EmailHealth {
  /** The receipts themselves. `week === null` means THAT read failed. */
  report: EmailDeliveryReport;
  /**
   * Distinct nights in the window on which the nightly run finished cleanly.
   * Each one attempted a digest email. Null means the read failed — not zero,
   * because zero is the value that would explain the silence away.
   */
  nightsFinished: number | null;
  /**
   * Accounts with role 'ops' and an email on them: who the digest would have
   * gone to. Zero means a finished night sent nothing, so it proves nothing.
   * Null means the read failed.
   */
  opsRecipients: number | null;
}

export type EmailState =
  /** We could not read the receipts. Not a yes and not a no. */
  | "unreadable"
  /** No receipts, and we know mail went out. The send path is not filing. */
  | "nothing-filed"
  /** No receipts, and nothing proves any mail went out either. */
  | "nothing-filed-unproven"
  /** Receipts exist and not one verdict has ever landed on any of them. */
  | "no-verdicts"
  /** Verdicts are arriving and none of them says delivered. */
  | "none-delivered"
  /** Mail is confirmed landing. The only healthy answer. */
  | "delivered";

export interface EmailVerdict {
  state: EmailState;
  /**
   * Set whenever email CANNOT be shown as landing — including when we could
   * not check. Null is reserved for confirmed deliveries in the window.
   */
  alarm: string | null;
  /** The quiet footer. Only ever non-empty when `alarm` is null. */
  line: string;
  /** THE COMPARISON. Accepted by Resend, versus confirmed delivered. */
  accepted: number;
  delivered: number;
  failed: number;
  waiting: number;
  /** How many rows a verdict has ever touched. */
  verdicts: number;
  /** Worst first, in the provider's own words. */
  reasons: Array<{ text: string; count: number }>;
  /** Stored statuses we do not classify, by name. */
  unknownStatuses: string[];
}

const NO_COUNTS = { accepted: 0, delivered: 0, failed: 0, waiting: 0, verdicts: 0 };

/** Pure. Given what we read, what may this screen say? */
export function emailVerdict(h: EmailHealth): EmailVerdict {
  const { report } = h;
  const reasons = report.reasons ?? [];
  const unknownStatuses = report.unknownStatuses ?? [];

  // A FAILED READ IS NOT AN EMPTY ONE, and email has no second copy to fall
  // back on — Twilio's log answers this question independently for texts and
  // nothing answers it independently for mail.
  if (report.week === null) {
    return {
      state: "unreadable",
      alarm:
        "We couldn't read the email delivery record" +
        (report.error ? ` — ${report.error}.` : ".") +
        " This panel is not saying email is fine. Our receipts are the only " +
        "record we keep, so there is no second copy to check instead.",
      line: "",
      ...NO_COUNTS,
      reasons,
      unknownStatuses,
    };
  }

  const week = report.week;
  const verdicts = report.verdicts ?? 0;
  const counts = {
    accepted: week.attempted,
    delivered: week.delivered,
    failed: week.failed,
    waiting: week.waiting,
    verdicts,
  };

  if (week.attempted === 0) {
    // WAS ANY MAIL ACTUALLY SENT? Only a witness outside this table can say.
    const proven =
      h.nightsFinished !== null &&
      h.opsRecipients !== null &&
      h.nightsFinished > 0 &&
      h.opsRecipients > 0;

    if (proven) {
      const n = h.nightsFinished as number;
      return {
        state: "nothing-filed",
        alarm:
          `Not one email receipt has been filed in the last ${WINDOW_DAYS} days, ` +
          `and the nightly run finished on ${n} of those nights — each one sends ` +
          "the digest by email. Mail went out and nothing recorded it, so every " +
          "screen that reads these receipts is reading an empty table rather than " +
          "a quiet week.",
        line: "",
        ...counts,
        reasons,
        unknownStatuses,
      };
    }

    // SAY WHAT WE CHECKED. "Nothing to judge" on its own is the sentence that
    // hid a month of silence; this one names both witnesses and what each
    // of them said, including that it could not be read.
    const nights =
      h.nightsFinished === null
        ? "we couldn't check whether the nightly run finished"
        : h.nightsFinished === 0
          ? "no nightly run finished in that time either"
          : `the nightly run finished on ${h.nightsFinished} of those nights`;
    const who =
      h.opsRecipients === null
        ? "and we couldn't check whether any ops account has an email on it"
        : h.opsRecipients === 0
          ? "and no ops account has an email on it, so a finished night would have sent nothing"
          : `and ${h.opsRecipients} ops account${h.opsRecipients === 1 ? " has" : "s have"} an email on them`;
    return {
      state: "nothing-filed-unproven",
      alarm:
        `No email receipt has been filed in the last ${WINDOW_DAYS} days — ${nights}, ${who}. ` +
        "So this cannot tell a genuinely quiet week from a send path that has " +
        "stopped recording, and it is not claiming the first.",
      line: "",
      ...counts,
      reasons,
      unknownStatuses,
    };
  }

  if (verdicts === 0) {
    // THE JULY SHAPE, ONE LAYER DOWN. Every row still says what Resend said
    // when it took the message, because nothing has ever said anything else.
    return {
      state: "no-verdicts",
      alarm:
        `${week.attempted} email${week.attempted === 1 ? "" : "s"} went to Resend in the ` +
        `last ${WINDOW_DAYS} days and not one verdict has come back for any of them. ` +
        "Every row still says only what Resend said the instant it took the " +
        "message. That is not the same as nothing arriving — it means a bounce " +
        "and an arrival currently look identical here. Check the webhook in " +
        "Resend and the door at /api/resend.",
      line: "",
      ...counts,
      reasons,
      unknownStatuses,
    };
  }

  if (week.delivered === 0) {
    return {
      state: "none-delivered",
      alarm:
        `${week.attempted} email${week.attempted === 1 ? "" : "s"} went out in the last ` +
        `${WINDOW_DAYS} days and not one is confirmed delivered. ` +
        (week.failed > 0
          ? `${week.failed} came back refused.`
          : `${week.waiting} ${week.waiting === 1 ? "is" : "are"} still without a verdict.`) +
        " Every ops alarm in this product travels by email.",
      line: "",
      ...counts,
      reasons,
      unknownStatuses,
    };
  }

  return {
    state: "delivered",
    alarm: null,
    line:
      `${week.delivered} of ${week.attempted} confirmed delivered in the last ${WINDOW_DAYS} days.` +
      (week.failed > 0 ? ` ${week.failed} refused.` : "") +
      (week.waiting > 0
        ? ` ${week.waiting} still without a verdict.`
        : ""),
    ...counts,
    reasons,
    unknownStatuses,
  };
}

/**
 * Reads the receipts and the two witnesses. NEVER THROWS — the console and the
 * texting page both call it alongside other loaders, and a thrown loader that
 * takes a page down is a worse outcome than a panel that says it could not
 * look. Every failure path returns a shape that alarms.
 */
export async function getEmailHealth(): Promise<EmailHealth> {
  const since = addDays(todayLakeDate(), -(WINDOW_DAYS - 1));

  try {
    const admin = createServiceClient();
    const [report, runsRes, opsRes] = await Promise.all([
      emailDeliveryReport(),
      admin
        .from("park_machine_runs")
        .select("run_on, ok, finished_at")
        .gte("run_on", since),
      admin
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("role", "ops")
        .not("email", "is", null),
    ]);

    // A FAILED READ IS NOT AN EMPTY ONE — and here an empty one would EXPLAIN
    // AWAY the silence, which is the direction that costs the most.
    let nightsFinished: number | null = null;
    if (runsRes.error) {
      console.error("[ops] email health: nightly runs read failed", runsRes.error.message);
    } else {
      nightsFinished = new Set(
        (runsRes.data ?? [])
          // `=== true`, not `!== false`: a value that is not plainly true
          // belongs on the side that proves nothing.
          .filter((r) => r.ok === true && r.finished_at != null)
          .map((r) => String(r.run_on)),
      ).size;
    }

    const opsRecipients = opsRes.error ? null : (opsRes.count ?? null);
    if (opsRes.error) {
      console.error("[ops] email health: ops recipients count failed", opsRes.error.message);
    }

    return { report, nightsFinished, opsRecipients };
  } catch (e) {
    const why = e instanceof Error ? e.message : "could not read the email receipts";
    console.error("[ops] email health lookup failed", why);
    return {
      report: { day: null, week: null, verdicts: null, reasons: [], unknownStatuses: [], error: why },
      nightsFinished: null,
      opsRecipients: null,
    };
  }
}
