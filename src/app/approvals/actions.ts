"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getFullProfile, toPricingProfile, type FullProfile } from "@/app/profile/data";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { serviceMinutes, type DurationBands } from "@/lib/duration";
import { summariseCorrection, scopeNoteFor, type TimedRule } from "@/lib/arrival";
import { todayLakeDate } from "@/lib/booking";
import { planRecovery } from "@/lib/recovery";
import { notify } from "@/lib/notify";
import { withParkRate, type ParkRates } from "@/lib/park-rates";
import { loadParkRatesChecked } from "@/app/park/rate-data";
import { mustRead, softRead, readFailedMessage } from "@/lib/must-read";

export interface ApprovalResult {
  ok: boolean;
  error?: string;
  /** How many still-open jobs on this property were repriced. */
  repriced?: number;
  /**
   * The visit the crew was standing on when they raised this is already
   * finished and billed. Repricing only touches `requested`/`scheduled`, so
   * that one visit keeps its old numbers on BOTH sides — the owner pays the
   * old price and the crew keeps the old cost. That may well be the right
   * product answer (you don't re-bill someone for a job that's done), but it
   * must be SAID rather than silently done, because it is the most common
   * shape: the crew flags on site, finishes the work, and the owner approves
   * that evening.
   */
  flaggedJobAlreadyDone?: boolean;
}

/** Confirm this flag belongs to a property the signed-in owner owns. */
async function assertOwnerFlag(flagId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const res = await admin
    .from("flags")
    // `jobs!flags_job_id_fkey` NAMES THE RELATIONSHIP ON PURPOSE.
    // 0084 added jobs.held_flag_id -> flags(id), so there are now TWO
    // foreign keys between these tables. A bare `jobs(...)` became
    // ambiguous and PostgREST answers 300 PGRST201 — which supabase-js
    // surfaces as {error, data:null}, i.e. an EMPTY approvals screen with
    // nothing logged. Naming the key is the fix and the documentation.
    .select("id, status, job_id, vendor_id, proposed_change, at_arrival, crew_can_proceed, crew_cannot_reason, jobs!flags_job_id_fkey(property_id, service_id, properties(owner_id))")
    .eq("id", flagId)
    .maybeSingle();
  // A FAILED READ IS NOT SOMEBODY ELSE'S FLAG. Both callers turn `null` into
  // "That approval isn't yours." — an accusation made about the owner's own
  // property at the exact moment the code has no fact to assert, and the exact
  // moment a crew is standing in their driveway waiting on the answer. The
  // failure is kept as a THIRD state so each caller can say what happened;
  // `null` goes back to meaning only "no such flag, or not yours".
  if (res.error) return { readFailed: true as const, error: res.error };
  const data = res.data;
  if (!data) return null;
  const job = Array.isArray(data.jobs) ? data.jobs[0] : data.jobs;
  const prop = job && (Array.isArray(job.properties) ? job.properties[0] : job.properties);
  if ((prop as { owner_id?: string } | null)?.owner_id !== user.id) return null;
  return {
    readFailed: false as const,
    flag: data,
    propertyId: (job as { property_id?: string } | null)?.property_id ?? null,
  };
}

/**
 * Owner approves a vendor flag (rule 6): the profile change and the flag
 * approval happen atomically in the DB (apply_flag_change), THEN every open
 * job on that property is re-priced from the new profile — so approval and
 * repricing move together, and nothing bills until the owner says yes.
 */
export async function approveFlag(flagId: string): Promise<ApprovalResult> {
  const ctx = await assertOwnerFlag(flagId);
  if (ctx?.readFailed) {
    return { ok: false, error: readFailedMessage("this approval", ctx.error, { money: true }) };
  }
  if (!ctx) return { ok: false, error: "That approval isn't yours." };
  // Pending -> apply the change. Already-approved -> allow a re-price retry
  // (if the profile change landed but repricing failed the first time).
  if (ctx.flag.status === "declined") return { ok: false, error: "Already declined." };

  const admin = createServiceClient();
  let repriced = 0;
  if (ctx.flag.status === "pending") {
    // Atomic: apply the proposed profile change + mark the flag approved.
    const { error: rpcErr } = await admin.rpc("apply_flag_change", { p_flag_id: flagId });
    if (rpcErr) return { ok: false, error: rpcErr.message };
  }

  // Re-price the owner's open jobs on this property from the updated profile.
  // vendor_cost/margin are preserved; margin is re-derived when a cost exists.
  if (ctx.propertyId) {
    // getFullProfile THROWS when one of its reads fails (a half-read profile
    // is what reprices a twelve-section pier as an eight). A server action
    // cannot throw — its caller is a button awaiting { ok, error } — so the
    // failure is caught here and returned as a sentence. Nothing is charged by
    // this action, and the retry path above is designed for exactly this: the
    // flag may already be approved, and approving again re-runs the repricing.
    let profile: FullProfile | null = null;
    try {
      profile = await getFullProfile(ctx.propertyId);
    } catch (e) {
      return { ok: false, error: readFailedMessage("the updated profile", e, { money: true }) };
    }
    if (profile?.hasProfile) {
      const servicesRes = await admin
        .from("services")
        .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands");
      // An unread price list is an EMPTY price list one line below: every job
      // misses `byId`, every job `continue`s, and the owner is told "nothing
      // upcoming to re-price yet" about a season that is fully booked.
      if (servicesRes.error) {
        return { ok: false, error: readFailedMessage("the price list", servicesRes.error, { money: true }) };
      }
      const services = servicesRes.data;
      // Typed to INCLUDE the duration fields, not merely to carry them at
      // runtime — a plain ServiceRule cast would still compile if the select
      // above dropped them, and serviceMinutes would quietly return the flat
      // figure forever. That is the failure mode this codebase keeps hitting.
      type TimedRule = ServiceRule & {
        est_minutes?: number | null;
        duration_bands?: DurationBands | null;
      };
      const byId = new Map((services ?? []).map((s) => [s.id, s as unknown as TimedRule]));
      const pp = toPricingProfile(profile);

      // A PARK PAYS ITS OWN RATE (0115), and this path did not know it. The
      // global row for a park_only service carries base 0 / unit_rate 0 on
      // purpose, so approving a crew's correction on a park's grounds repriced
      // a $100 mow to $0 — the crew files "the lawn is large, not medium", the
      // owner taps Approve, and the job silently becomes free.
      //
      // AND AN UNREAD RATE MAP IS INDISTINGUISHABLE FROM A PARK THAT SET NO
      // PRICES. `loadParkRates` swallows the failure — right for the nightly,
      // wrong here, because the swallow leaves the zeroed global base in place,
      // `price` comes out 0, the backstop below skips the job, and the owner is
      // told "nothing upcoming to re-price". Take the checked read and stop.
      let parkRates: ParkRates | null = null;
      if (profile.groundsForParkId) {
        const got = await loadParkRatesChecked(profile.groundsForParkId);
        if (got.failed) {
          return {
            ok: false,
            error: readFailedMessage("what this park pays", "park_service_rates read failed", { money: true }),
          };
        }
        parkRates = got.rates;
      }
      const openJobsRes = await admin
        .from("jobs")
        .select("id, service_id, vendor_id, vendor_cost")
        .eq("property_id", ctx.propertyId)
        .is("group_id", null) // package jobs price as a SUM of legs — repricing by the anchor alone would collapse the bundle (component-aware reprice = S3)
        .in("status", ["requested", "scheduled"]);
      // The visits we cannot read are not visits that do not exist: the loop
      // below would run zero times and report "0 re-priced" as a success.
      if (openJobsRes.error) {
        return { ok: false, error: readFailedMessage("your upcoming visits", openJobsRes.error, { money: true }) };
      }
      const openJobs = openJobsRes.data;

      // THE CREW'S SIDE HAS TO MOVE TOO.
      //
      // This used to reprice the CUSTOMER off the corrected profile and keep
      // the crew on the old `vendor_cost` — so a flag reading "twelve pier
      // sections, not eight" billed the owner for twelve and paid the crew for
      // eight, with our margin silently absorbing the whole difference. The
      // crew who told us the truth was the only party who lost by it.
      //
      // Re-derived from THAT crew's own rate card, the same way dispatch
      // derives it. No rate on file means we leave their cost alone rather
      // than invent one — an unset rate is not a rate of zero.
      const vendorIds = [...new Set((openJobs ?? []).map((j) => j.vendor_id).filter(Boolean))] as string[];
      const rateByVendorService = new Map<string, { base: unknown; unit_rate: unknown; band_pricing: unknown }>();
      if (vendorIds.length > 0) {
        const rateRes = await admin
          .from("vendor_rates")
          .select("vendor_id, service_id, base, unit_rate, band_pricing")
          .in("vendor_id", vendorIds);
        // A FAILED RATE READ IS "NO RATE ON FILE" TO THE CODE BELOW — and "no
        // rate on file" means keep the crew's old cost while the customer's
        // price moves. That is precisely the bug the comment above describes:
        // the owner pays for twelve sections and the crew is paid for eight.
        if (rateRes.error) {
          return { ok: false, error: readFailedMessage("the crew's rates", rateRes.error, { money: true }) };
        }
        const rateRows = rateRes.data;
        for (const r of rateRows ?? []) {
          rateByVendorService.set(`${r.vendor_id}:${r.service_id}`, r);
        }
      }

      for (const j of openJobs ?? []) {
        const raw = j.service_id ? byId.get(j.service_id) : undefined;
        if (!raw) continue;
        const rule = parkRates ? withParkRate(raw, parkRates) : raw;
        const price = priceService(rule, pp);

        // NEVER REPRICE A SOLD JOB TO NOTHING.
        //
        // The backstop for this whole class, not just for parks: any future
        // path that loses a rule's numbers produces 0 here, and 0 is a job the
        // dispatcher will not fill and the owner is not charged for. Leaving
        // the agreed price alone and moving on is always safer than writing a
        // zero nobody chose.
        if (!(price > 0)) continue;

        // THE DAY HAS TO MOVE TOO.
        //
        // Approving "twelve pier sections, not eight" used to change the money
        // and nothing else. Since 0083 the job also carries the minutes it was
        // budgeted, and twelve sections is 255 minutes where eight was 180 —
        // so leaving the old figure would bill the owner for the bigger job
        // and still hand the crew a day sized for the smaller one. The
        // afternoon is where that difference gets paid.
        const minutes = serviceMinutes(rule, pp);

        const update: {
          customer_price: number; est_minutes: number; vendor_cost?: number; margin?: number;
        } = { customer_price: price, est_minutes: minutes };

        const vr = j.vendor_id && j.service_id
          ? rateByVendorService.get(`${j.vendor_id}:${j.service_id}`)
          : undefined;
        if (vr) {
          const cost = priceService({
            name: rule.name,
            pricing_model: rule.pricing_model,
            base: Number(vr.base ?? 0),
            unit_rate: Number(vr.unit_rate ?? 0),
            band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
          }, pp);
          update.vendor_cost = cost;
          update.margin = price - cost;
        } else if (j.vendor_cost != null) {
          // No rate card to re-derive from — keep what was agreed and let the
          // margin follow the new price rather than inventing a crew number.
          update.margin = price - Number(j.vendor_cost);
        }
        // COUNT WHAT LANDED, not what was attempted. The result was discarded
        // and the counter incremented regardless, so a failed write reported
        // "3 visits repriced" to somebody who then had no reason to look.
        const { error: upErr } = await admin.from("jobs").update(update).eq("id", j.id);
        if (!upErr) repriced += 1;
      }
    }
  }

  // RELEASE THE CREW.
  //
  // 0084 holds an at-arrival job so it cannot be completed while the owner is
  // deciding. Now they have decided, so the hold comes off — and it comes off
  // whether they said yes or no, because a hold nobody can clear is a job that
  // can never be finished and a crew that can never be paid.
  if (ctx.flag.job_id) {
    await admin
      .from("jobs")
      .update({ held_at: null, held_flag_id: null })
      .eq("id", ctx.flag.job_id as string);
    await tellTheCrew(
      admin,
      ctx.flag.job_id as string,
      "the owner approved what you found — go ahead with the corrected job. 🌊",
    );
  }

  // Was the job they flagged already finished? Reported, not acted on.
  let flaggedJobAlreadyDone = false;
  if (ctx.flag.job_id) {
    // DEGRADED, NOT SILENT, AND DELIBERATELY NOT FATAL. Everything above has
    // already happened — the profile change is applied, the jobs are repriced,
    // the crew has been told. This read only decides whether we ADD a sentence
    // about the flagged visit keeping its old numbers, so a failure here must
    // not fail an approval that has already succeeded. softRead logs it and
    // the extra sentence is simply not offered.
    const [flagged] = softRead(
      "whether the flagged visit is already finished",
      await admin.from("jobs").select("status").eq("id", ctx.flag.job_id as string).maybeSingle(),
      null,
    );
    const st = flagged?.status as string | undefined;
    flaggedJobAlreadyDone = st === "complete" || st === "paid";
  }

  return { ok: true, repriced, flaggedJobAlreadyDone };
}


/**
 * TELL THE CREW. They are standing in a driveway.
 *
 * Every screen in the arrival flow promises this — "you'll get a text either
 * way", "you'll get a text the moment they answer" — and nothing sent one.
 * Three release paths, all silent: approve, decline-and-proceed, and
 * decline-and-stand-down. In the stand-down case the answer had already
 * arrived and it was "go home", and the crew had no way to know.
 *
 * Failure-tolerant by construction: the owner's decision is already written
 * and must never be undone by a texting problem.
 */
async function tellTheCrew(
  admin: ReturnType<typeof createServiceClient>,
  jobId: string,
  line: string,
): Promise<void> {
  try {
    // mustRead here so a failed lookup is LOGGED rather than read as "this job
    // has no crew" — the silent version of that is a crew left in a driveway
    // with no text, which is the whole failure this function exists to end.
    // It throws into the catch below, where the decision is already safe.
    const job = mustRead("the crew to text", await admin
      .from("jobs")
      .select("vendor_id, vendors(user_id)")
      .eq("id", jobId)
      .maybeSingle());
    const v = (Array.isArray(job?.vendors) ? job?.vendors[0] : job?.vendors) as
      { user_id?: string } | null;
    if (!v?.user_id) return;

    const u = mustRead("the crew's phone number", await admin
      .from("users").select("phone, email").eq("id", v.user_id).maybeSingle());

    // EVERY DOOR. The promise on the arrival screens is "you'll get a text
    // either way", and text alone has delivered nothing since July — so the
    // crew waiting on this answer is written to as well, and the day A2P
    // clears the same call sends both.
    await notify(
      "the crew what the owner decided about their flag",
      { phone: u?.phone as string | null, email: u?.email as string | null },
      {
        sms: `LakeLife: ${line}`,
        subject: "The owner answered your flag",
      },
    );
  } catch {
    /* The decision is recorded. A failed text must never undo it. */
  }
}

/**
 * Owner declines a flag — nothing reprices. But "no" is not always a smaller
 * job, and this is where that matters.
 *
 * If the crew said they could work around it, the visit goes ahead at the
 * booked scope and the job carries a note saying exactly what was and was not
 * done — so a completed job never silently claims more than happened.
 *
 * If the crew said they COULD NOT (a pier removal that would leave four
 * sections in the water for the ice), the crew is stood down instead. No work,
 * no charge, ops picks it up. Sending them at an impossible scope would be
 * worse than not going.
 */
export async function declineFlag(flagId: string): Promise<ApprovalResult> {
  const ctx = await assertOwnerFlag(flagId);
  if (ctx?.readFailed) {
    return { ok: false, error: readFailedMessage("this approval", ctx.error, { money: true }) };
  }
  if (!ctx) return { ok: false, error: "That approval isn't yours." };
  if (ctx.flag.status !== "pending") return { ok: false, error: "Already decided." };
  const admin = createServiceClient();
  const { error } = await admin.from("flags").update({ status: "declined" }).eq("id", flagId);
  if (error) return { ok: false, error: error.message };

  // DECLINING IS AN ANSWER, AND IT UNBLOCKS THE CREW — one way or the other.
  if (ctx.flag.job_id) {
    const jobId = ctx.flag.job_id as string;
    const cannot = (ctx.flag as { crew_can_proceed?: boolean | null }).crew_can_proceed === false;

    if (cannot) {
      // THE CREW SAID THE BOOKED JOB IS IMPOSSIBLE. Standing them down is the
      // honest outcome: no work happened, so the job must not be completable
      // (0088's trigger enforces that), and nothing is charged for the visit.
      const why =
        ((ctx.flag as { crew_cannot_reason?: string | null }).crew_cannot_reason ?? "").trim() ||
        "The crew could not do the job at the size on file.";
      const today = todayLakeDate();

      // Append-only first (0089): the crew made this trip, and rescheduling
      // must not be able to erase that it happened.
      // VENDOR_ID OR THE CREW IS NEVER PAID. `raiseTripFees` filters
      // `.not("vendor_id","is",null)`, so an attempt without it is skipped
      // every night forever, silently — and this is the exact branch 0090
      // exists for: the crew drove out because OUR profile was wrong.
      // `recordNoShow` passed it, which is why no-shows worked and
      // stand-downs did not. It has to come off the FLAG (selected above);
      // reading it from a field that was never fetched would write undefined
      // and look identical.
      await admin.from("job_visit_attempts").insert({
        job_id: jobId,
        vendor_id: (ctx.flag as { vendor_id?: string | null }).vendor_id ?? null,
        attempted_on: today,
        outcome: "stood_down",
        reason: why,
      });

      // A stand-down is NEVER fee-eligible — the profile was ours and it was
      // wrong. planRecovery encodes that so no screen has to remember it.
      const plan = planRecovery("stood_down", today, { serviceName: "this visit" });

      await admin
        .from("jobs")
        .update({
          held_at: null,
          held_flag_id: null,
          stood_down_at: new Date().toISOString(),
          stood_down_reason: `Owner declined the correction. ${why}`,
          recovery_state: "awaiting_customer",
          reschedule_deadline: plan.deadline,
        })
        .eq("id", jobId);
      await tellTheCrew(
        admin,
        jobId,
        "the owner said no and you can't do this one as booked — pack up and " +
        "head to your next stop. You'll be paid for the trip.",
      );
    } else {
      // The crew can work around it, so the visit goes ahead at the booked
      // scope — AND the job records what was left undone. Without this the
      // invoice reads "Pier install ✓" while the owner looks at a pier ending
      // in open water.
      let scopeNote: string | null = null;
      try {
        const proposed = (ctx.flag as { proposed_change?: Record<string, unknown> | null })
          .proposed_change ?? null;
        const svcId = (ctx.flag.jobs as { service_id?: string } | null)?.service_id;
        if (proposed && svcId && ctx.propertyId) {
          // mustRead, not a bare read: an unread service rule reads as "no such
          // service" and the job silently loses its scope note — the invoice
          // then says "Pier install ✓" over a pier ending in open water. It
          // throws into the catch below, which is the right place: the decline
          // is already written and must not be undone over a note.
          // (getFullProfile throws for the same reason and lands there too.)
          const [ruleRes, profile] = await Promise.all([
            admin.from("services")
              .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands")
              .eq("id", svcId).maybeSingle(),
            getFullProfile(ctx.propertyId),
          ]);
          const rule = mustRead("this service's pricing rule", ruleRes);
          if (rule && profile?.hasProfile) {
            const summary = summariseCorrection(
              rule as unknown as TimedRule,
              toPricingProfile(profile),
              proposed as Parameters<typeof summariseCorrection>[2],
            );
            scopeNote = scopeNoteFor(summary.lines, {
              serviceName: (rule.name as string) ?? "This visit",
              decidedOn: todayLakeDate(),
            });
          }
        }
      } catch {
        /* A note we cannot build must not block the crew. */
      }

      await admin
        .from("jobs")
        .update({
          held_at: null,
          held_flag_id: null,
          ...(scopeNote ? { scope_note: scopeNote } : {}),
        })
        .eq("id", jobId);
      await tellTheCrew(
        admin,
        jobId,
        "the owner said no to the change — do the job as it was booked and " +
        "leave the rest. Nothing else needed from you.",
      );
    }
  }

  return { ok: true };
}
