import "server-only";

/**
 * WHICH DEPLOYMENT THIS IS, AND WHETHER IT IS ALLOWED TO ACT ON THE WORLD.
 *
 * ============ WHAT WAS TRUE BEFORE THIS FILE ============
 *
 * Read off Vercel on 20 October 2026, not remembered:
 *
 *   SUPABASE_SERVICE_ROLE_KEY   target: ["production", "preview"]
 *   NEXT_PUBLIC_SUPABASE_URL    target: ["production", "preview"]
 *   CRON_SECRET                 target: ["production", "preview"]
 *   GATE_ENCRYPTION_KEY         target: ["production", "preview"]
 *   TWILIO_*, RESEND_API_KEY    target: ["production", "preview"]
 *
 * There is no staging database. **Every pull-request preview deployment runs
 * against the live database, with the live service-role key, holding the live
 * cron secret and live Twilio and Resend credentials.** And nothing in the
 * application knew it was a preview: a grep for `VERCEL_ENV` across src/
 * returned nothing at all.
 *
 * So a branch deploy could run the nightly against production data — emailing
 * real homeowners, writing real payout batches — and on the day
 * `LAKELIFE_PAYMENTS_LIVE` is set, charging real cards. Not through any
 * exotic attack: by Vercel firing a cron at an alias, by somebody replaying a
 * cron request to a preview URL with a secret that preview legitimately holds,
 * or by a developer clicking a button on their own branch to see if it works.
 *
 * ============ WHY A CODE GUARD AND NOT JUST SCOPING ============
 *
 * The real fix is a second Supabase project so preview has its own database,
 * and that is a cost and a decision that are Brendon's. This is what can be
 * true today without spending anything, and it is the safe direction: a
 * preview deployment refuses to act, which costs a developer a sentence on
 * screen, where the alternative costs a homeowner a wrongly charged card.
 *
 * It is NOT a substitute for the staging split. When preview gets its own
 * database the scoping changes and this can be revisited — deliberately, with
 * the reason written down, rather than by discovering it is in the way.
 *
 * ============ FAIL CLOSED ON "I DO NOT KNOW" ============
 *
 * `VERCEL_ENV` is `production`, `preview` or `development`, and is UNSET when
 * the code is not running on Vercel at all — local `next dev`, vitest, a
 * script. Unset therefore cannot mean "refuse", or every test and every local
 * run would be blocked. So the predicate asks the narrow question — *is this
 * the string `preview`* — rather than the broad one, and anything else is
 * allowed through to the gates that already exist.
 *
 * That is the one place this file is deliberately permissive, and it is safe
 * because a deployment that is not a Vercel preview is either production
 * (where these actions are the point) or a developer's own machine (which has
 * no production credentials unless they went and fetched them).
 */

/** The outward-facing acts a preview deployment must not perform. */
export type WorldAction = "send" | "charge" | "cron" | "payout";

/**
 * True only on a Vercel PREVIEW deployment.
 *
 * Narrow on purpose — see the header. `development` and unset are not preview,
 * and must not be, or nothing would run locally or under test.
 */
export function isPreviewDeployment(): boolean {
  return process.env.VERCEL_ENV === "preview";
}

/**
 * Why this deployment may not do that — or null when it may.
 *
 * One predicate, four call sites, because a rule each doorway has to remember
 * is a rule the next doorway forgets. The four doors are the ones that reach
 * past the database into somebody's life: a message, a card, a crew's bank
 * account, and the nightly run that does all three on a timer.
 */
export function worldActionRefusal(action: WorldAction): string | null {
  if (!isPreviewDeployment()) return null;
  switch (action) {
    case "send":
      return "preview deployment — nothing is sent to a real person from a branch";
    case "charge":
      return "preview deployment — no card or bank account is touched from a branch";
    case "cron":
      return "preview deployment — the scheduled run belongs to production";
    case "payout":
      // ADDED 29 Oct 2026, when Mercury gave us a way to originate ACH from
      // the application. `src/lib/mercury.ts` asks before every call.
      //
      // THE TEST BELOW THIS FILE FOUND IT. `a-branch-deploy-cannot-act.test.ts`
      // pins the WorldAction union with a note saying a fourth act "should
      // reach this predicate rather than invent its own test — and this is the
      // scan that notices". It noticed.
      return "preview deployment — no money is sent to anybody's bank from a branch";
  }
}

/**
 * The same fact for a log line, naming the deployment so a developer wondering
 * why nothing happened is not left guessing.
 *
 * `VERCEL_GIT_COMMIT_REF` is the branch. It is not a secret and it is the one
 * detail that makes the line useful.
 */
export function previewRefusalNote(action: WorldAction): string {
  const branch = process.env.VERCEL_GIT_COMMIT_REF ?? "an unnamed branch";
  return `[${action}] refused: this is a preview deployment of ${branch}, ` +
    "and it shares the production database. Run it in production, or on a " +
    "staging database once there is one.";
}
