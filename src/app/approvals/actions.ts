"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getFullProfile, toPricingProfile, type FullProfile } from "@/app/profile/data";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { serviceMinutes, type DurationBands } from "@/lib/duration";
import { summariseCorrection, scopeNoteFor, type TimedRule } from "@/lib/arrival";
import { todayLakeDate } from "@/lib/booking";
import { planRecovery } from "@/lib/recovery";
import { notify } from "@/lib/notify";
import { withParkRate, crewSetsThePrice, type ParkRates } from "@/lib/park-rates";
import { loadParkRatesChecked } from "@/app/park/rate-data";
import { mustRead, softRead, readFailedMessage } from "@/lib/must-read";
import { rushPrice, fillInRate } from "@/lib/rush";
import { getPlatformSettings } from "@/lib/settings";
import { marginPct } from "@/lib/dispatch";
import {
  customerPrice as feeCustomerPrice,
  crewPayout as feeCrewPayout,
  round2,
} from "@/lib/platform-fee";
import { money } from "@/app/park/ledger-helpers";
import { withAddons } from "@/lib/addons";

export interface ApprovalResult {
  ok: boolean;
  error?: string;
  /** How many still-open jobs on this property were repriced. */
  repriced?: number;
  /**
   * Visits whose price was AGREED at something other than the menu — a
   * scarcity uplift the customer tapped Accept on, or a below-floor take-home
   * a crew tapped Claim on. The correction changes the size of the job, but
   * nothing records what that uplift or that offer was, so it cannot be
   * re-derived at the new size. Rewriting them to the menu discarded an
   * agreement; inventing a new one would be worse. They are left exactly as
   * agreed and named here so a person decides.
   */
  heldAgreements?: number;
  /**
   * Visits left alone because the corrected size prices them UNDER the margin
   * floor — the dial dispatch, canClaim and ops' manual assign all refuse to
   * route below. Approval was the one doorway that re-derived both sides and
   * never looked at it, so a crew's own rate card could write a job dispatch
   * would have declined, and a shrinking job could invert it outright.
   *
   * Deliberately NOT folded into `heldAgreements`: that counter's one sentence
   * tells the homeowner we kept a price THEY agreed to, and neither half of
   * that is true here — the price is the ordinary menu price and the reason is
   * our margin. It is also not the homeowner's problem to solve, which is why
   * the detail goes to ops by email and this number carries only "we've held
   * one visit for a check" to the person who tapped Approve.
   */
  heldForMargin?: number;
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
  let heldAgreements = 0;
  let heldForMargin = 0;
  /** What ops is told about each margin hold. Never shown to a homeowner. */
  const marginHolds: { jobId: string; service: string; price: number; cost: number }[] = [];
  if (ctx.flag.status === "pending") {
    // Atomic: apply the proposed profile change + mark the flag approved.
    const { error: rpcErr } = await admin.rpc("apply_flag_change", { p_flag_id: flagId });
    if (rpcErr) return { ok: false, error: rpcErr.message };
  }

  // NOTHING PROPOSED, NOTHING TO REPRICE. The crew's "something else is wrong"
  // door files a flag carrying words and no counts, so apply_flag_change above
  // applies nothing to the profile — and running the loop below would rewrite
  // customer_price and vendor_cost on every open job at the property from an
  // unchanged profile. That should compute the same numbers, and "should
  // compute the same numbers" is not a thing to run across somebody's money.
  const proposedOnFlag = ctx.flag.proposed_change as Record<string, unknown> | null;
  const hasProposal = !!proposedOnFlag && Object.keys(proposedOnFlag).length > 0;

  // Re-price the owner's open jobs on this property from the updated profile.
  // vendor_cost/margin are preserved; margin is re-derived when a cost exists.
  if (ctx.propertyId && hasProposal) {
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
        .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands, crew_priced");
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
        /** 0174: the crew's own card is the price; there is no menu here. */
        crew_priced?: boolean | null;
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
        // is_rush and gap_claim are what say this job's money is not the menu
        // price. Without them the loop could not tell an agreed number from a
        // stale one, and overwrote both.
        // crew_quote / fee_customer_pct / fee_crew_pct are THIS JOB'S OWN frozen
        // three (0174). A crew-priced job reprices from the percentages that
        // were in force when the customer said yes — never from the live dial,
        // or tuning a dial would silently reprice sold work through this door.
        .select("id, service_id, vendor_id, vendor_cost, customer_price, is_rush, gap_claim, crew_quote, fee_customer_pct, fee_crew_pct")
        .eq("property_id", ctx.propertyId)
        .is("group_id", null) // package jobs price as a SUM of legs — repricing by the anchor alone would collapse the bundle (component-aware reprice = S3)
        .in("status", ["requested", "scheduled"]);
      // The visits we cannot read are not visits that do not exist: the loop
      // below would run zero times and report "0 re-priced" as a success.
      if (openJobsRes.error) {
        return { ok: false, error: readFailedMessage("your upcoming visits", openJobsRes.error, { money: true }) };
      }
      const openJobs = openJobsRes.data;

      // THE EXTRAS THE OWNER ALREADY AGREED (0180) ARE NOT PART OF THE MENU,
      // AND THIS LOOP REWRITES THE MENU.
      //
      // An accepted add-on adds its two numbers to `jobs.customer_price` and
      // `jobs.vendor_cost`. Re-deriving a job's price from the profile and
      // writing the bare result would silently delete work the owner had said
      // yes to and the crew was expecting to be paid for — the flag being
      // approved has nothing to do with the extra, so the extra survives it.
      //
      // Read once for every open job, summed per job below. A FAILED READ IS
      // NOT "NO EXTRAS": swallowing it here is exactly how an agreed $44.80
      // would vanish off a bill with nothing logged, so it stops.
      const openJobIds = (openJobs ?? []).map((j) => j.id as string);
      const addonByJob = new Map<string, { customer: number; payout: number }>();
      if (openJobIds.length > 0) {
        const addonRes = await admin
          .from("job_addons")
          .select("job_id, customer_price, crew_payout")
          .in("job_id", openJobIds)
          .eq("status", "accepted");
        if (addonRes.error) {
          return { ok: false, error: readFailedMessage("the extras you've already agreed", addonRes.error, { money: true }) };
        }
        for (const a of addonRes.data ?? []) {
          const k = a.job_id as string;
          const cur = addonByJob.get(k) ?? { customer: 0, payout: 0 };
          addonByJob.set(k, {
            customer: cur.customer + Number(a.customer_price ?? 0),
            payout: cur.payout + Number(a.crew_payout ?? 0),
          });
        }
      }
      const NO_EXTRAS = { customer: 0, payout: 0 };

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

      // The rush premium is a PERCENTAGE, so it re-derives correctly at any
      // size — unlike the two agreements below it.
      const rushSettings = await getPlatformSettings();

      for (const j of openJobs ?? []) {
        const raw = j.service_id ? byId.get(j.service_id) : undefined;
        if (!raw) continue;
        const rule = parkRates ? withParkRate(raw, parkRates) : raw;
        /** What this visit already carries in agreed extras. Both ends. */
        const extra = addonByJob.get(j.id as string) ?? NO_EXTRAS;

        // ============ THE CREW SET THIS PRICE, SO THE CREW RESETS IT (0174) ============
        //
        // On a crew-priced job there is no menu to re-derive from: `menu`
        // below would price the global row, which carries the SHAPE of a rate
        // card and not a price. What moves is the crew's own card at the
        // corrected size — twelve pier sections instead of eight — and both
        // ends of the job follow from it through the frozen percentages.
        //
        // THE PERCENTAGES ARE THE JOB'S OWN. Reading the live dial here would
        // make this door the one place where changing a dial reprices work
        // already sold; the whole point of freezing three columns at booking
        // is that this cannot happen. A job missing either percentage is not a
        // crew-priced job (0174's all-or-nothing CHECK), so the pair is read
        // together or not at all.
        //
        // NO MARGIN FLOOR HERE, deliberately, and that is not the same
        // omission the menu branch below was fixed for. Under crew pricing
        // LakeLife keeps (c + k) / (1 + c) of the bill — the SAME fraction on
        // every job, whatever the crew charges. A floor test against a
        // constant is not a filter; it is a platform-wide on/off switch, which
        // is exactly why dispatch retires it on this path too. Consulting it
        // here would hold every crew-priced approval on the platform the day
        // somebody nudged a dial.
        //
        // A PARK REACHES THIS BRANCH TOO, SINCE 0176 — and it used to be fenced
        // out of it by hand. The line read `raw.crew_priced === true &&
        // !parkRates`, which is the old "a park is never crew-priced" sentence
        // in its fourth spelling, and `parkRates` is a Map (often empty) for
        // EVERY park, so the test was "never, for any park".
        //
        // What that cost: a park with no rate of its own books snow from a crew
        // who onboarded with a card, the crew flags a bigger drive at arrival,
        // the owner reads "your crew prices this one, so they'll re-quote it at
        // the corrected size" (arrival.ts, which now answers the same rule) and
        // taps Approve — and the job fell past here to the menu branch, where
        // the park's zeroed global row prices to 0, `!(price > 0)` continues,
        // and NOTHING moved on either end. The promise on the screen and the
        // money in the row disagreed, silently, with no counter to say so.
        //
        // `crewSetsThePrice` is the one precedence rule: false for The Haven's
        // mow (the park HAS a row, so the park's number governs and the menu
        // branch below reprices it through `withParkRate` exactly as before),
        // true for a park with no row on a crew-priced service, and byte for
        // byte unchanged for every lake house.
        const jobCustomerPct = j.fee_customer_pct == null ? null : Number(j.fee_customer_pct);
        const jobCrewPct = j.fee_crew_pct == null ? null : Number(j.fee_crew_pct);
        //
        // THE ID COMES OFF THE JOB, not off `raw`. `pricingPathFor` matches a
        // park's rate row BY service id, and a rule with no id finds no row,
        // calls the park unrated and hands the mow to a crew's card. `raw` was
        // looked up by this very id, so they are the same value — naming the
        // job's column is what stops a future `select` losing the one field the
        // whole rule turns on.
        const whoPrices = { id: j.service_id as string, crew_priced: raw.crew_priced };
        if (crewSetsThePrice(whoPrices, parkRates) && jobCustomerPct != null && jobCrewPct != null) {
          const fee = { customerPct: jobCustomerPct, crewPct: jobCrewPct };
          const vrCrew = j.vendor_id && j.service_id
            ? rateByVendorService.get(`${j.vendor_id}:${j.service_id}`)
            : undefined;
          // THREE KINDS OF JOB WHOSE NUMBER WE CANNOT RE-DERIVE, held whole.
          //
          //   NO CARD ON FILE — there is no quote to recompute, and on this
          //   path the customer's price IS the quote. Moving one end without
          //   the other is the "owner pays for twelve, crew paid for eight"
          //   bug with the sides swapped.
          //
          //   A GAP CLAIM, whose take-home the crew negotiated against inputs
          //   that have all moved (same reason as the menu branch).
          //
          //   A SAME-DAY RUSH job. A crew-priced service refuses same-day at
          //   the booking door, so this can only be a job that predates the
          //   flag being switched on — and its premium is a percentage of a
          //   menu price that no longer exists.
          //
          // Counted as an agreement held, because that is precisely what it
          // is: the price the customer agreed to stays exactly as agreed.
          const isRushJob = (j as { is_rush?: boolean }).is_rush === true;
          const isGap = (j as { gap_claim?: boolean }).gap_claim === true;
          if (!vrCrew || isGap || isRushJob) {
            heldAgreements += 1;
            continue;
          }
          const quote = priceService({
            name: rule.name,
            pricing_model: rule.pricing_model,
            base: Number(vrCrew.base ?? 0),
            unit_rate: Number(vrCrew.unit_rate ?? 0),
            band_pricing: (vrCrew.band_pricing as ServiceRule["band_pricing"]) ?? null,
          }, pp);
          // NEVER REPRICE A SOLD JOB TO NOTHING — the same backstop the menu
          // branch has. A card that prices to zero at the new size leaves the
          // agreed numbers alone rather than making the visit free.
          if (!(quote > 0)) continue;
          // WHAT LAKELIFE KEEPS IS STILL THE DIFFERENCE OF THE TWO ROUNDED
          // ENDS, never a separately rounded percentage — `withAddons` returns
          // customer − cost by construction, which is the same identity
          // `platformTake` guarantees, extended over the agreed extras. Both
          // ends are already whole cents, so its round2 only repairs float
          // dust, and guard_job_money_shape reconciles to the cent.
          const crewTotals = withAddons(
            { customer: feeCustomerPrice(quote, fee), cost: feeCrewPayout(quote, fee) },
            extra,
          );
          const { error: crewUpErr } = await admin
            .from("jobs")
            .update({
              customer_price: crewTotals.customer,
              est_minutes: serviceMinutes(rule, pp),
              vendor_cost: crewTotals.cost,
              margin: crewTotals.margin,
              crew_quote: quote,
            })
            .eq("id", j.id);
          if (!crewUpErr) repriced += 1;
          continue;
        }

        const menu = priceService(rule, pp);

        // AN AGREED PRICE IS NOT A STALE ONE.
        //
        // This loop used to write the bare menu price over every open job on
        // the property. Two kinds of job carry a price that is deliberately
        // NOT the menu:
        //
        //   A SAME-DAY RUSH job, priced menu + same_day_surcharge_pct and
        //   confirmed to the customer at that number. That is a percentage, so
        //   it re-derives at the new size and is re-applied below.
        //
        //   A SCARCITY-BUMPED job, where the customer tapped Accept on a
        //   specific uplift so the cheapest crew could clear the margin floor.
        //   acceptScarcityOffer writes that straight into customer_price and
        //   records the uplift NOWHERE, so at a new size it cannot be
        //   re-derived — only the offer engine, with the crew in front of it,
        //   could choose a new one.
        //
        // Worked: an 8-section pier books same-day at ceil(604 × 1.25) = $755.
        // The crew finds a 9th section, the owner approves, and the old code
        // wrote the menu price for 9 sections — $652. The owner said yes to
        // MORE work and the bill fell $103 below what they had agreed to, and
        // $163 below the correct rush figure. The row still said is_rush.
        const isRush = (j as { is_rush?: boolean }).is_rush === true;
        // `agreed` ALREADY CARRIES THE EXTRAS. An accepted add-on was added
        // straight into customer_price (0180), so the stored figure is the
        // base plus everything the owner has said yes to.
        const agreed = Number((j as { customer_price?: number }).customer_price ?? 0);
        const base = isRush ? rushPrice(menu, rushSettings.sameDaySurchargePct) : menu;
        // The bill this visit should carry: the re-derived base, with the
        // agreed extras put back on top of it.
        const price = round2(base + extra.customer);

        // Not rush, and priced above menu: an uplift we cannot re-derive.
        // Leave the whole job alone — price, minutes and cost — and name it.
        // A half-updated job (new minutes, old price) is worse than an
        // untouched one.
        //
        // COMPARED AGAINST base + extras, NOT against the bare menu. A visit
        // carrying an agreed $44.80 add-on is ALWAYS priced above the menu, so
        // the bare comparison would hold every such job as an
        // un-re-derivable agreement and the correction would never land — and
        // the owner would be told "we left one visit exactly as it was" about
        // a pier they had just told us was bigger.
        if (!isRush && agreed > price) {
          heldAgreements += 1;
          continue;
        }

        // NEVER REPRICE A SOLD JOB TO NOTHING.
        //
        // The backstop for this whole class, not just for parks: any future
        // path that loses a rule's numbers produces 0 here, and 0 is a job the
        // dispatcher will not fill and the owner is not charged for. Leaving
        // the agreed price alone and moving on is always safer than writing a
        // zero nobody chose.
        if (!(base > 0)) continue;

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
        // THE CREW'S NUMBER WAS AGREED TOO.
        //
        // Re-deriving vendor_cost from the raw rate card undoes whatever the
        // crew actually tapped Claim on:
        //
        //   A GAP CLAIM is below-floor BY DEFINITION — canClaim refused the
        //   card rate for exactly that reason, and the gap engine offered a
        //   lower take-home the crew accepted. Its inputs (the customer price
        //   at claim time, the crew's own rate-history anchor, a per-job
        //   jitter) have all moved, so re-running it would produce a different
        //   number than the one they agreed to. Recomputing from the card
        //   instead pays them MORE and drops margin below the floor dispatch
        //   enforces — the job ends up carrying the exact rate the system
        //   refused to route at, with gap_claim still true.
        //
        //   A SAME-DAY FILL-IN took their standing rate minus the fill-in
        //   discount. That IS a percentage of the card rate, so it re-derives.
        //
        // Worked: pier at 14 sections, card $728, gap offer $690 accepted.
        // Crew flags 15; the old code paid the card rate 52 × 15 = $780 on a
        // $940 job — 17.0% margin, under the 20% floor.
        const isGapClaim = (j as { gap_claim?: boolean }).gap_claim === true;
        if (vr && !isGapClaim) {
          const card = priceService({
            name: rule.name,
            pricing_model: rule.pricing_model,
            base: Number(vr.base ?? 0),
            unit_rate: Number(vr.unit_rate ?? 0),
            band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
          }, pp);
          // Mirror the claim: a rush job's take-home is the card rate less the
          // fill-in discount, exactly as claimJob computed it.
          const cardCost = isRush ? fillInRate(card, rushSettings.sameDayFillDiscountPct) : card;
          // BOTH ENDS OF THE EXTRA, OR NEITHER. Re-deriving the crew's cost
          // from their card produces the BASE cost, so the add-on's payout has
          // to go back on beside its customer price — otherwise the owner
          // keeps paying for the extra and the crew stops being paid for it,
          // which is the "owner pays for twelve, crew paid for eight" bug in
          // its newest clothes.
          const totals = withAddons({ customer: base, cost: cardCost }, extra);
          const cost = totals.cost;

          // THE FLOOR IS A RULE, AND THIS WAS THE ONE DOORWAY WITHOUT IT.
          //
          // Every other door that puts a crew's number on a job tests it:
          // dispatch refuses to route below the floor, canClaim refuses a
          // crew's own claim with `rate_too_high`, ops' manual assign refuses
          // it by name, and the gap engine exists SOLELY to price a
          // below-floor crew down to something that clears. Approval
          // re-derived both sides from scratch and tested neither — so the
          // worked example in the comment above (pier at 15 sections, card
          // $780 on a $940 job = 17.0% against a live 0.20 floor) was written
          // straight into the row, at the exact rate dispatch had refused.
          //
          // The floor was even loaded three lines away as `rushSettings` and
          // never read: a dial present and never consulted enforces nothing.
          // The database does not catch it either — guard_job_money_shape
          // refuses a loss only when vendor_id CHANGES, and this update never
          // touches vendor_id.
          //
          // Held whole, for the reason the rush guard above is held whole: a
          // job carrying new minutes and an old price is worse than one left
          // alone. Ops is emailed below, because ops is the only party who can
          // do anything about it.
          // `totals.customer` is `price` by construction — both are the base
          // plus the agreed extras — so the floor is tested on the same pair
          // the row will carry, and the line still reads the way it reads in
          // dispatch, canClaim and ops' manual assign.
          if (marginPct(price, cost) < rushSettings.marginFloor) {
            heldForMargin += 1;
            marginHolds.push({ jobId: j.id as string, service: rule.name, price, cost });
            continue;
          }
          update.vendor_cost = cost;
          update.margin = totals.margin;
        } else if (j.vendor_cost != null) {
          // No card to re-derive from, OR a gap claim we must not re-derive —
          // keep what was agreed and let the margin follow the new price
          // rather than inventing a crew number.
          // THIS ONE ALREADY CARRIES THE EXTRAS. `vendor_cost` is the stored
          // figure, and an accepted add-on's payout was added straight into
          // it — so adding `extra.payout` again here would pay the crew for
          // the same extra twice. The customer side is symmetric: `price`
          // above is base + extras, and this cost is base + extras, so the
          // margin below is the right subtraction on both ends.
          const cost = Number(j.vendor_cost);

          // THE SAME RULE, THE SECOND DOORWAY — AND ON A RUSH JOB THIS ONE
          // CAN GO NEGATIVE.
          //
          // Here the crew's number is fixed and the customer's moves, so a
          // flag that SHRINKS the job drags the margin down with the price.
          // On an ordinary job the `agreed > menu` guard above already holds
          // that case: a non-rush price only falls when it was above the menu,
          // and that guard stops the loop before it gets here. A RUSH job
          // skips that guard on purpose — the premium is a percentage and
          // re-derives at any size — so this is the branch where a falling
          // price still lands.
          //
          // Worked: a same-day pier removal at 14 sections, menu $892,
          // confirmed to the customer at $1,115 with the 25% premium, and a
          // gap-claimed take-home of $690 the crew tapped Claim on. The crew
          // flags 8 sections; the new price is $755 and this line wrote margin
          // = 755 − 690 = $65, an 8.6% job. At a $800 take-home it writes
          // −$45 outright — LakeLife paying the crew more than it bills the
          // owner, with the payout releasing at vendor_cost. The database
          // permits every one of those: guard_job_money_shape refuses a loss
          // only when vendor_id changes, and this update never touches it.
          //
          // But the floor ALONE is the wrong test on this branch: a gap claim
          // is below the floor BY DESIGN — that is what the gap engine
          // negotiated and the crew accepted — so holding everything under the
          // floor would freeze every gap-claimed job the moment its owner
          // approved anything. What must never happen is the reprice making it
          // WORSE than what both sides agreed. The cost is unchanged here, so
          // a falling price is exactly a falling margin: hold only when the
          // price drops AND the result lands under the floor.
          const noAgreedPrice = !(agreed > 0);
          if ((noAgreedPrice || price < agreed) && marginPct(price, cost) < rushSettings.marginFloor) {
            heldForMargin += 1;
            marginHolds.push({ jobId: j.id as string, service: rule.name, price, cost });
            continue;
          }
          update.margin = round2(price - cost);
        }
        // COUNT WHAT LANDED, not what was attempted. The result was discarded
        // and the counter incremented regardless, so a failed write reported
        // "3 visits repriced" to somebody who then had no reason to look.
        const { error: upErr } = await admin.from("jobs").update(update).eq("id", j.id);
        if (!upErr) repriced += 1;
      }
    }
  }

  // A HELD JOB IS A DECISION SOMEBODY HAS TO MAKE, not a thing that resolves
  // itself. Margin Health would never name it — it tests rate CARDS at a
  // representative size and aggregates jobs by service and lake, so one
  // below-floor visit is diluted, never listed. So it is emailed.
  await tellOpsMarginHeld(admin, marginHolds);

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

  return { ok: true, repriced, heldAgreements, heldForMargin, flaggedJobAlreadyDone };
}

/**
 * TELL OPS THAT A CORRECTION PRICED ITSELF UNDER THE FLOOR.
 *
 * The margin floor is an ops dial, set on the ops console, and the homeowner
 * who tapped Approve can do nothing about it — so the detail goes to the
 * people who can. Three real options each time, none of which code may pick:
 * re-route to a crew whose card clears the floor at the new size, put a
 * scarcity offer to the owner, or take the thin job this once.
 *
 * WHAT IT SAYS AND WHY IT SAYS IT TO OPS ONLY: it names the customer price and
 * the crew's cost side by side. That is exactly the pair vendors may never see
 * and homeowners have no use for, which is why it is an ops address or
 * nothing.
 *
 * Never throws at its caller. Everything above it is already written — the
 * profile change applied, the other visits repriced, the crew told — and an
 * alarm must never undo the thing it is alarming about.
 */
async function tellOpsMarginHeld(
  admin: ReturnType<typeof createServiceClient>,
  holds: { jobId: string; service: string; price: number; cost: number }[],
): Promise<void> {
  if (holds.length === 0) return;
  const n = holds.length;
  const visits = `${n} visit${n === 1 ? "" : "s"}`;
  try {
    const opsRes = await admin.from("users").select("phone, email").eq("role", "ops");
    // A failed read here is not "there is nobody in ops". Nothing retries this
    // alert, so the log is the last line of defence.
    if (opsRes.error) {
      console.error(
        "[read failed] the ops team for a MARGIN-HELD alert:",
        opsRes.error.code ?? "", opsRes.error.message ?? opsRes.error,
      );
    }
    const lines = holds
      .map((h) => `${h.service} (visit ${h.jobId}): ${money(h.price)} to the customer against ${money(h.cost)} to the crew`)
      .join("\n");
    let reached = 0;
    for (const u of opsRes.data ?? []) {
      const told = await notify(
        "ops that an approved correction priced under the margin floor",
        { phone: u.phone as string | null, email: u.email as string | null },
        {
          sms: `LakeLife: ${visits} held after an owner approved a crew's correction — at the corrected size ${n === 1 ? "it prices" : "they price"} under the margin floor. Needs a decision.`,
          subject: `${visits} held under the margin floor after an approval`,
          body:
            `An owner approved a crew's correction. At the corrected size, ${visits} would have priced under the margin floor, ` +
            `so nothing was rewritten: ${n === 1 ? "it stands" : "they stand"} at the old size, the old price and the old crew cost.\n\n` +
            `${lines}\n\n` +
            `The crew is expecting the corrected job, so this will not sit still on its own. ` +
            `Each one needs a choice: re-route to a crew that clears the floor at the new size, ` +
            `put a scarcity offer to the owner, or take it thin this once.`,
        },
      );
      if (told.reached) reached += 1;
    }
    if (reached === 0) {
      console.error(
        `[alert unsent] ${visits} held under the margin floor after an approval and NOBODY was reached:\n${lines}`,
      );
    }
  } catch {
    /* The approval is recorded. A failed alarm must never undo it. */
  }
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
      .select("vendor_id, vendors!jobs_vendor_id_fkey(user_id)")
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
  // THE STATUS FLIP IS THE LOCK, the way approveFlag's apply_flag_change RPC
  // already does it ("select ... where id = p_flag_id and status = 'pending'
  // for update", raising for the loser). The check above is a read from a
  // moment earlier, and the UPDATE carried no status predicate — so a
  // homeowner with /approvals open on a phone and a laptop could decline
  // twice, and everything below runs twice: a second append-only stand-down
  // attempt row, a second $35 trip payout the nightly funds out of LakeLife's
  // own money, and a second "pack up and head to your next stop" to the crew.
  //
  // Writing status='declined' twice is harmless in itself; what is not
  // harmless is the work underneath it, which is why the guard belongs here
  // rather than on each of those writes.
  const declined = await admin
    .from("flags")
    .update({ status: "declined" })
    .eq("id", flagId)
    .eq("status", "pending")
    .select("id");
  if (declined.error) return { ok: false, error: declined.error.message };
  if (!declined.data || declined.data.length === 0) {
    return { ok: false, error: "Already decided." };
  }

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
        // `proposed` IS NO LONGER REQUIRED. Both sides are promised this note —
        // declineMeans tells the owner "we'll note on the job what was and
        // wasn't done" and now tells the crew the same — and a note-only flag
        // ("a car is parked across half the lawn") is exactly the case where
        // the record matters most: there is no count to re-derive it from
        // later. scopeNoteFor already writes the right sentence for an empty
        // diff, so only this guard was refusing.
        if (svcId && ctx.propertyId) {
          // mustRead, not a bare read: an unread service rule reads as "no such
          // service" and the job silently loses its scope note — the invoice
          // then says "Pier install ✓" over a pier ending in open water. It
          // throws into the catch below, which is the right place: the decline
          // is already written and must not be undone over a note.
          // (getFullProfile throws for the same reason and lands there too.)
          const [ruleRes, profile] = await Promise.all([
            admin.from("services")
              .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands, crew_priced")
              .eq("id", svcId).maybeSingle(),
            getFullProfile(ctx.propertyId),
          ]);
          const rule = mustRead("this service's pricing rule", ruleRes);
          if (rule && profile?.hasProfile) {
            // No proposal means no diff to describe — scopeNoteFor's empty
            // branch says "done as booked; a correction was declined on X",
            // which is the whole of what happened.
            const lines = proposed
              ? summariseCorrection(
                  rule as unknown as TimedRule,
                  toPricingProfile(profile),
                  proposed as Parameters<typeof summariseCorrection>[2],
                ).lines
              : [];
            scopeNote = scopeNoteFor(lines, {
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
