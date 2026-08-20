import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { runRouteBuild, revalidateAssignments, recordNoShows, sendNightBeforeReminders, reconcileUnsettledJobs, reconcileCancelledFees, sendCoiRevalidations, generateAutopilotProposals, demoteLakeStrikes, selfHealCrewBases, sweepWaitlist, expireUnfilledJobs, resolveRushFallbacks, matureReferralEarnings, runReferralPayoutBatch, runNudges, birthSpringJobs, overstayNotices, runMonthlyPayoutBatches, sweepStrandedPayoutBatches, runFillInDigest, gapSlaAlerts, reconcileRefunds, learnServiceDurations, autoApplyPriceSuggestions, sendNightlyDigest, remindExpiringStays,
  proposeOverdueFees,
  raiseTripFees,
  tipsCollectedSinceLastNight,
} from "@/lib/automation";
// The all-parks sweep calls the ENGINE, not the authorized wrapper: this
// route is cron-authenticated and deliberately has no single park.
import { applyDueRentChangesFor } from "@/lib/rent-changes";

import { runParkNightly } from "@/lib/park-machine";
import { sweepDisputeDeadlines } from "@/lib/disputes";

export const dynamic = "force-dynamic";
// TWENTY-SEVEN SEQUENTIAL STEPS. On the default serverless ceiling this run
// gets cut off partway through, which looks exactly like nothing happening:
// the steps after the cut simply don't run, and the digest — the last one, and
// the only thing that reports the night — is the first casualty.
export const maxDuration = 300;

/**
 * Nightly job (Vercel Cron, 8pm America/Indiana/Indianapolis). Builds
 * tomorrow's routes and texts each crew, then sends the night-before reminder
 * to owners with a job tomorrow. Protected by CRON_SECRET (fails closed).
 * Optional ?date=YYYY-MM-DD for manual/backfill runs.
 */
/**
 * ONE STEP MUST NEVER TAKE DOWN THE REST.
 *
 * This job is 27 sequential awaits with no guard, so a throw anywhere — a park
 * query naming a column that does not exist, say — 500s the whole run and skips
 * tomorrow's crew routes, the night-before reminders and the dispatch self-heal.
 * The park module is the newest and least-exercised code in here; it must not
 * be able to stop the business that has real customers.
 *
 * Failures are COLLECTED and returned, never swallowed. A step that dies shows
 * up by name in the response and in the digest.
 */
const failures: { step: string; error: string }[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    failures.push({ step: name, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * A STEP THAT DIDN'T THROW CAN STILL HAVE FAILED SOMEBODY.
 *
 * `step()` only sees a throw. But the cron rule for these runners is the
 * opposite of throwing: a read that fails inside a loop SKIPS that one job,
 * crew or property and carries on — which is right, and which used to be
 * completely invisible. The step returned `ok:true` with counts that looked
 * exactly like a quiet night, and the only trace was a console line on a
 * server nobody reads. (That is how the COI check reported `{ok:true, due:0}`
 * every night for months while no crew was ever warned.)
 *
 * So the steps that skip now say what they skipped, in words, and those land
 * in the SAME digest section as a thrown step — because to the person reading
 * it at 8am, "the step died" and "the step quietly didn't do it" need the same
 * response.
 */
function noteSkips(name: string, r: { skipped?: string[] } | null | undefined) {
  for (const s of r?.skipped ?? []) failures.push({ step: name, error: s });
}

async function run(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  failures.length = 0;
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  // Flag yesterday's ghosted jobs (records the no-show, releases for free reschedule)
  // BEFORE self-heal, so released jobs re-enter the dispatch pool the same run.
  const noShows = await step("noShows", () => recordNoShows());
  // Phase E: pause crews on lakes they keep ghosting (BEFORE re-dispatch, so
  // tonight's waterfall never re-hands a job to the crew that just lost the lake).
  const lakeStanding = await step("lakeStanding", () => demoteLakeStrikes());
  // Rush stragglers first (their fallback is kinder than a blunt expiry),
  // then the honest terminal for jobs whose date passed unfilled (+ the
  // T-minus warning), then try to fill every future waiting job.
  const rushFallbacks = await step("rushFallbacks", () => resolveRushFallbacks());
  const springBirths = await step("springBirths", () => birthSpringJobs()); // before the sweep: home-variant spring jobs get filled the same night
  const waitlist = await step("waitlist", () => expireUnfilledJobs());
  // Ask a renter before they pack, and roll a month-to-month tenancy forward
  // before it lapses. Both are the same mechanism — see lib/extend-stay.ts.
  const extendReminders = await step("extendReminders", () => remindExpiringStays());
  // Scheduled rent changes that have come due AND were properly served. The
  // database refuses any that weren't, so this can only ever apply the ones
  // with notice on the record.
  const rentChanges = await step("rentChanges", () => applyDueRentChangesFor());
  // A visit where no work happened and the customer never picked another day.
  // This PROPOSES a fee onto an ops screen; it never charges one. Charging a
  // card because a crew tapped a button on a doorstep a week ago is not a
  // decision a cron gets to make (0089).
  const visitFees = await step("visitFees", () => proposeOverdueFees());
  // The crew drove there. Accrues unattended on purpose (0090): the worst case
  // if it misfires is that we pay a crew $35 they didn't earn — recoverable,
  // and nowhere near a customer's card.
  const tripFees = await step("tripFees", () => raiseTripFees());
  // Not a step that DOES anything — a read, so the digest can report the money
  // that came in as well as the money that went out.
  const tipsCollected = await step("tipsCollected", () => tipsCollectedSinceLastNight());
  const sweep = await step("sweep", () => sweepWaitlist());
  const overstay = await step("overstay", () => overstayNotices());
  // Self-heal assignments (re-home lapsed crews, fill stragglers), then route.
  const dispatch = await step("dispatch", () => revalidateAssignments(date));
  const learning = await step("learning", () => learnServiceDurations());
  const routes = await step("routes", () => runRouteBuild(date));
  const reminders = await step("reminders", () => sendNightBeforeReminders(date));
  // Catch any job completed but left partially billed (e.g. a mid-write crash),
  // and retry uncollected late-cancellation fees (crew share releases on collect).
  const reconcile = await step("reconcile", () => reconcileUnsettledJobs());
  const refundReconcile = await step("refundReconcile", () => reconcileRefunds());
  const feeReconcile = await step("feeReconcile", () => reconcileCancelledFees());
  // Referral accruals past the clawback window become spendable credits.
  const referrals = await step("referrals", () => matureReferralEarnings());
  // Yearly COI re-attest nudge (fires on an exact boundary, so once per crew).
  const coi = await step("coi", () => sendCoiRevalidations());
  // Autopilot: propose enrolled services' next visits (one-tap confirm texts).
  const autopilot = await step("autopilot", () => generateAutopilotProposals());
  // Phase E: re-pin crew bases from where they actually complete jobs.
  const bases = await step("bases", () => selfHealCrewBases());
  // Growth: month-end referral payout batch (self-gates to the last lake-day)
  // + the frequency-capped, prefs-gated nudge engine.
  const payoutBatch = await step("payoutBatch", () => runReferralPayoutBatch());
  const monthlyPayouts = await step("monthlyPayouts", () => runMonthlyPayoutBatches());
  // BEFORE the month-end batch would be wrong and after is right: a stranded
  // 'building' batch holds payouts that are invisible to the export AND to the
  // crew's own screen, so freeing them lets the very next run pick them up.
  // Only ever moves money backwards into the pool — a batch that never reached
  // 'queued' has never been sent to a bank.
  const strandedPayouts = await step("strandedPayouts", () => sweepStrandedPayoutBatches());
  const fillInDigest = await step("fillInDigest", () => runFillInDigest());
  // Autonomy Ladder (2026-07-23): silent-crew disputes fire their policy,
  // margin_stranded prices within the dial apply themselves.
  const disputeSweep = await step("disputeSweep", () => sweepDisputeDeadlines());
  const autoPricing = await step("autoPricing", () => autoApplyPriceSuggestions());
  const gapSla = await step("gapSla", () => gapSlaAlerts());
  const nudges = await step("nudges", () => runNudges());
  // THE nightly digest — always last, carries everything above to ops in one email.
  // The park's evening read. Guarded like everything else, and it writes its
  // own run row so a night it never ran is visible on his screen tomorrow.
  const park = await step("park", () => runParkNightly());
  // The scheduling-lifecycle steps: what each of them SKIPPED tonight, into
  // the same digest section as an outright failure. See noteSkips above.
  noteSkips("strandedPayouts", strandedPayouts);
  noteSkips("noShows", noShows);
  noteSkips("lakeStanding", lakeStanding);
  noteSkips("springBirths", springBirths);
  noteSkips("waitlist", waitlist);
  noteSkips("extendReminders", extendReminders);
  noteSkips("sweep", sweep);
  noteSkips("overstay", overstay);
  noteSkips("dispatch", dispatch);
  noteSkips("routes", routes);
  noteSkips("autopilot", autopilot);
  noteSkips("bases", bases);
  // The TELLING steps. These four decide who hears from us — a crew's fill-in
  // digest, a homeowner's credit nudge, ops' one text about a job nobody has
  // claimed, and a price the machine moved. None of them reports a count the
  // digest renders, so before this the only trace of one skipping somebody was
  // a console line. (gapSla's `alerted` IS rendered — its SKIPS were not.)
  noteSkips("nudges", nudges);
  noteSkips("fillInDigest", fillInDigest);
  noteSkips("gapSla", gapSla);
  noteSkips("autoPricing", autoPricing);
  // THE MONEY STEPS, which is where a silent skip costs the most. Each of these
  // now names what it did not do — a fee not charged, a crew's month not
  // batched, a referral not credited — and every one of those was previously a
  // console line and a count that read identically to a quiet night.
  noteSkips("feeReconcile", feeReconcile);
  noteSkips("referrals", referrals);
  noteSkips("payoutBatch", payoutBatch);
  noteSkips("monthlyPayouts", monthlyPayouts);
  // reconcileUnsettledJobs reports `failures: string[]` rather than `skipped`,
  // because every entry is a settle that refused — the customer was not charged
  // and the crew was not paid. Same destination, so ops reads one list.
  for (const f of reconcile?.failures ?? []) failures.push({ step: "reconcile", error: f });
  // THE PARK MACHINE'S URGENT FINDINGS. It has always produced them — "N
  // occupied lots have no bill for August 2026" is the standing answer to
  // nobody having raised the rent — and they only ever reached a count in an
  // HTTP response. The nightly is the one thing the owner actually reads.
  //
  // Reporting, never raising: billing nineteen households unattended asserts
  // that money is owed, which the park autonomy rule reserves for a human tap.
  for (const u of park?.urgent ?? []) failures.push({ step: "park", error: u });
  // A step that died contributes its empty shape rather than blocking the
  // digest — the digest is how ops finds out, so it must survive the failure
  // it is reporting. `failures` carries what actually broke.
  const digest = await step("digest", () => sendNightlyDigest({
    learning: learning ?? { changes: [] },
    autoPricing: autoPricing ?? { changes: [] },
    disputeSweep: disputeSweep ?? { fired: 0, escalated: 0 },
    routes: routes ?? {},
    gapSla: gapSla ?? { alerted: 0 },
    // WHAT BROKE TONIGHT, FIRST. These were collected all the way down this
    // function and then dropped on the floor: a night where a step threw
    // produced the same email as a clean one, often literally "Quiet night —
    // nothing needed a human." The digest is how ops finds out, so it has to
    // survive — and report — the failure it is reporting.
    failures,
    // MONEY THAT MOVED TONIGHT. Every one of these was already sitting in a
    // local, and went only into an HTTP response nobody reads — so month-end,
    // the night the largest sum of the month leaves the account, read as a
    // quiet night. The fields have existed on DigestSections since the
    // two-season audit; nothing ever passed them.
    payoutBatch: payoutBatch ?? undefined,
    monthlyPayouts: monthlyPayouts ?? undefined,
    referrals: referrals ?? undefined,
    feeReconcile: feeReconcile ?? undefined,
    refundReconcile: refundReconcile ?? undefined,
    visitFees: visitFees ?? undefined,
    tripFees: tripFees ?? undefined,
    tipsCollected: tipsCollected ?? undefined,
  }));
  // The digest cannot report its own non-delivery by email. This lands it in
  // the cron response instead — the only place left.
  noteSkips("digest", digest);
  return NextResponse.json({ ok: failures.length === 0, failures, park, noShows, lakeStanding, rushFallbacks, springBirths, overstay, waitlist, extendReminders, rentChanges, sweep, dispatch, learning, routes, reminders, reconcile, refundReconcile, feeReconcile, referrals, coi, autopilot, bases, payoutBatch, monthlyPayouts, fillInDigest, disputeSweep, autoPricing, gapSla, nudges, visitFees, tripFees, digest });
}

export const GET = run; // Vercel Cron issues GET
export const POST = run; // allow manual POST trigger
