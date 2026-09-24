"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { OWNER_FIXTURE_EMBED, OWNER_FIXTURE_FILTER } from "@/lib/lake-pages";
import { getPlatformSettings } from "@/lib/settings";
import { todayLakeDate } from "@/lib/booking";
import { hasRealRate } from "@/app/vendor/rates-helpers";
import { parkMayPrice } from "@/lib/park-rates";
import type { PricingModel, PricingParams } from "@/lib/pricing";
import {
  crewCardCanPrice,
  menuPriceLine,
  flipConsequenceLines,
  parkPrecedenceLine,
  type CrewPricingVerdict,
} from "@/lib/crew-priced-eligibility";
import { assertOps } from "./data";

/**
 * THE SWITCH GETS A WRITER.
 *
 * Six commits and five migrations built a crew-priced marketplace behind one
 * per-service flag, `services.crew_priced` (0174, default false) — and until
 * this file nothing in the product could turn it on. A column read everywhere
 * and written by nothing is this codebase's oldest and most expensive bug
 * class; here it was sitting under the whole feature, and the only way to flip
 * a service onto the model he chose was to hand-edit the database.
 *
 * TWO EXPORTS, AND THEY ARE THE TWO HALVES OF NEVER FLIPPING BLIND:
 *
 *   getCrewPricedServices   what each service is, what its menu charges, how
 *                           many REAL crews could quote it, what is already
 *                           booked, which parks keep their own number, and
 *                           whether its shape can do this at all.
 *   setServiceCrewPriced    one service, one direction, ops only, re-checked
 *                           against the row as it stands right now.
 *
 * THERE IS NO BULK DOOR ON PURPOSE. "Turn crew pricing on" as one tap is a
 * pricing decision made 16 times by somebody who meant to make it once.
 *
 * NOTHING HERE FLIPS ANYTHING ON ITS OWN. Zero services are crew_priced today;
 * this module only lets HIM change that, one service at a time, with the
 * consequences printed above the button first.
 */

/** One row of the ops list — everything the screen prints about one service. */
export interface CrewPricedServiceRow {
  id: string;
  name: string;
  /** The live value of `services.crew_priced`. */
  crewPriced: boolean;
  /** Can a crew's card price this at all? `ok:false` carries the refusal. */
  verdict: CrewPricingVerdict;
  /** What the menu charges today, in words. Null = it charges nothing. */
  menuLine: string | null;
  /** Active, non-fixture crews holding a real rate card. null = read failed. */
  cardedCrews: number | null;
  /** Unfinished work dated today or later. null = read failed. */
  futureJobs: number | null;
  /** What flipping it would do, line by line. */
  consequences: string[];
  /** Which parks keep their own number here, and which do not. null = not park work. */
  parkLine: string | null;
}

export interface CrewPricedState {
  ok: boolean;
  error?: string;
  /** The two live dials, so the screen quotes the numbers actually in force. */
  fee?: { customerPct: number; crewPct: number };
  /**
   * Is the change log (0179) applied? FALSE means the switch is not armed —
   * the screen says so and draws no button, rather than offering a control
   * whose write would fail.
   */
  logReady?: boolean;
  rows?: CrewPricedServiceRow[];
}

/** The `services` columns this screen reads. Named once so the two doorways agree. */
const SERVICE_COLUMNS =
  "id, name, active, crew_priced, pricing_model, base, unit_rate, band_pricing, park_only, park_bookable";

interface ServiceRow {
  id: string;
  name: string;
  active: boolean | null;
  crew_priced: boolean | null;
  pricing_model: PricingModel | string;
  base: number | string | null;
  unit_rate: number | string | null;
  band_pricing: PricingParams | null;
  park_only: boolean | null;
  park_bookable: boolean | null;
}

/**
 * EVERYTHING HE NEEDS TO SEE BEFORE HE TOUCHES ANYTHING.
 *
 * A FAILED READ IS NOT AN EMPTY ONE, and here that rule decides the whole
 * card: a dropped `vendor_rates` query would print "no crew has priced this"
 * over a bench that is actually stocked, and a dropped `jobs` query would say
 * "nothing is booked" over a diary that is not. So a failure on any of the
 * counting reads comes back as `ok:false` with a sentence, exactly the way the
 * standing dial beside it does — and the per-row counts stay `number | null`
 * so a future partial degrade still cannot print a confident zero.
 */
export async function getCrewPricedServices(): Promise<CrewPricedState> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const settings = await getPlatformSettings();
  const fee = { customerPct: settings.platformFeeCustomerPct, crewPct: settings.platformFeeCrewPct };
  const admin = createServiceClient();
  const today = todayLakeDate();

  const svcRes = await admin.from("services").select(SERVICE_COLUMNS).eq("active", true).order("name");
  if (svcRes.error) return { ok: false, error: "We couldn't read the service list just now." };
  const services = (svcRes.data ?? []) as unknown as ServiceRow[];
  // `logReady` is LEFT UNDEFINED, not false. This branch never probed the log
  // table, and `false` renders the screen's "migration 0179 most likely hasn't
  // been applied" notice — a fact about the database asserted by a code path
  // that did not look at it. Undefined draws no notice and no button, which is
  // the honest state for a menu with nothing on it.
  if (services.length === 0) return { ok: true, fee, rows: [] };
  const serviceIds = services.map((s) => s.id);

  // THE FIXTURE FENCE IS LOAD-BEARING HERE, not decoration. All three
  // production vendors are fixtures (GreenEdge, Northshore Docks, Iso Test
  // Vendor 2), so a count that included them would say "3 crews have priced
  // this" about a bench with nobody on it — and a count of 3 reads as
  // readiness on the one screen where readiness is the decision. Joined
  // through the OWNER (`users.is_fixture`, FK named because `vendors` has two
  // paths to `users`), exactly as the dispatch pool does, so the number on
  // this card and the pool that would actually quote cannot drift.
  const [crewsRes, jobsRes, parksRes, parkRatesRes, logRes] = await Promise.all([
    admin
      .from("vendors")
      .select("id, users!vendors_user_id_fkey!inner(is_fixture)")
      .eq("status", "active")
      .eq("users.is_fixture", false),
    admin
      .from("jobs")
      .select(`id, service_id, job_items(service_id), properties!inner(${OWNER_FIXTURE_EMBED})`)
      .gte("date", today)
      .in("status", ["requested", "scheduled", "in_progress"])
      .eq(OWNER_FIXTURE_FILTER, false),
    // EVERY PARK, NOT THE ACTIVE ONES. `parks.active` is not a kill switch —
    // The Haven is inactive today and still holds the mow rate 21 households
    // sign leases against on 1 January, and `pricingPathFor` never looks at
    // that column. Filtering on it here would make this card say nothing at
    // all about park work, which reads as "no park is affected" — the exact
    // confident-empty sentence the fence is supposed to prevent.
    admin.from("parks").select("id, name"),
    admin.from("park_service_rates").select("park_id, service_id"),
    // IS THE CHANGE LOG THERE? 0179 creates it and the lead applies it. Until
    // then the switch is not armed, and saying so is better than drawing a
    // button whose write would fail with a Postgres error.
    admin.from("service_pricing_changes").select("id").limit(1),
  ]);

  if (crewsRes.error) return { ok: false, error: "We couldn't read the crew list just now." };
  if (jobsRes.error) return { ok: false, error: "We couldn't read what's already booked just now." };
  if (parksRes.error || parkRatesRes.error) {
    return { ok: false, error: "We couldn't read what the parks pay just now." };
  }

  const crewIds = (crewsRes.data ?? []).map((v) => v.id as string);

  // A crew "holds a rate card" only if the row could produce a positive price —
  // `hasRealRate`, the same test the crew's own rates page and the open board
  // use. A saved row of zeroes is not a rate, and counting it here would put a
  // crew on this card who is silently dropped from every job.
  const cardedByService = new Map<string, number>();
  let ratesFailed = false;
  if (crewIds.length > 0) {
    const ratesRes = await admin
      .from("vendor_rates")
      .select("vendor_id, service_id, base, unit_rate, band_pricing")
      .in("service_id", serviceIds)
      .in("vendor_id", crewIds);
    if (ratesRes.error) {
      ratesFailed = true;
    } else {
      for (const r of ratesRes.data ?? []) {
        if (!hasRealRate(r as { base?: number; unit_rate?: number; band_pricing?: PricingParams | null })) continue;
        const sid = r.service_id as string;
        cardedByService.set(sid, (cardedByService.get(sid) ?? 0) + 1);
      }
    }
  }
  if (ratesFailed) return { ok: false, error: "We couldn't read the crews' rate cards just now." };

  // A PACKAGE VISIT COUNTS FOR EVERY LEG IT CARRIES. `jobs.service_id` names
  // the headline service; the legs live in `job_items`, and a pier job booked
  // inside a package is still booked work on the pier service.
  const futureByService = new Map<string, number>();
  for (const j of jobsRes.data ?? []) {
    const legs = ((j as { job_items?: Array<{ service_id?: string | null }> }).job_items ?? [])
      .map((it) => it.service_id)
      .filter((s): s is string => !!s);
    const touched = new Set<string>([...(j.service_id ? [j.service_id as string] : []), ...legs]);
    for (const sid of touched) futureByService.set(sid, (futureByService.get(sid) ?? 0) + 1);
  }

  const parkNames = (parksRes.data ?? []).map((p) => p.name as string);
  const parkNameById = new Map((parksRes.data ?? []).map((p) => [p.id as string, p.name as string]));
  const ownRateParksByService = new Map<string, string[]>();
  for (const r of parkRatesRes.data ?? []) {
    const nm = parkNameById.get(r.park_id as string);
    if (!nm) continue;
    const list = ownRateParksByService.get(r.service_id as string) ?? [];
    list.push(nm);
    ownRateParksByService.set(r.service_id as string, list);
  }

  const rows: CrewPricedServiceRow[] = services.map((s) => {
    const verdict = crewCardCanPrice({ name: s.name, pricing_model: s.pricing_model, band_pricing: s.band_pricing });
    const menuLine = menuPriceLine(s);
    const cardedCrews = cardedByService.get(s.id) ?? 0;
    const futureJobs = futureByService.get(s.id) ?? 0;
    const buyable = parkMayPrice({ park_only: s.park_only, park_bookable: s.park_bookable });
    return {
      id: s.id,
      name: s.name,
      crewPriced: s.crew_priced === true,
      verdict,
      menuLine,
      cardedCrews,
      futureJobs,
      consequences: flipConsequenceLines({
        serviceName: s.name,
        menuLine,
        parkOnly: s.park_only === true,
        cardedCrews,
        futureJobs,
        customerPct: fee.customerPct,
        crewPct: fee.crewPct,
      }),
      parkLine: parkPrecedenceLine({
        serviceName: s.name,
        parksWithOwnRate: ownRateParksByService.get(s.id) ?? [],
        parksThatCouldBuy: buyable ? parkNames : [],
      }),
    };
  });

  return { ok: true, fee, logReady: !logRes.error, rows };
}

export interface FlipResult {
  ok: boolean;
  error?: string;
  /**
   * The switch moved but the change log did not record it. Not an error — the
   * decision stands — but it must be said out loud rather than swallowed.
   */
  warning?: string;
}

/**
 * THE WRITER. ONE SERVICE, ONE DIRECTION.
 *
 * Ops-gated, service-role, and RE-CHECKED against the row as it stands right
 * now rather than against whatever the screen was showing: the screen is one
 * doorway and this is the other, and a rule in one doorway of two is not a
 * rule. If somebody changes a service to a `band` model while this card is
 * open, the flip has to refuse on the way in.
 *
 * THE ORDER, AND WHY: the flag moves first, then the log row. A log row
 * written before a flip that then fails is a change log asserting a change
 * that never happened — a lie in the one place whose whole job is to be true.
 * A flip whose log row fails to write is a real change with no provenance,
 * which is worse than nothing but is at least honest about itself, and the
 * caller is handed a `warning` naming it. Both doorways check the log is
 * there before anything moves — the screen draws no button (`logReady`) and
 * this action probes it itself — so the only way to reach that branch is a
 * failure between the probe and the insert.
 */
export async function setServiceCrewPriced(serviceId: string, on: boolean): Promise<FlipResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!serviceId) return { ok: false, error: "Missing service." };

  const admin = createServiceClient();
  const svcRes = await admin.from("services").select(SERVICE_COLUMNS).eq("id", serviceId).maybeSingle();
  // NOTHING IS WRITTEN AT THIS POINT, and a swallowed read here would let the
  // shape check below pass on an empty row — which is the branch that decides
  // whether a service becomes unsellable.
  if (svcRes.error) return { ok: false, error: "We couldn't read that service just now. Nothing has changed." };
  const svc = svcRes.data as unknown as ServiceRow | null;
  if (!svc) return { ok: false, error: "Service not found." };

  const was = svc.crew_priced === true;
  if (was === on) return { ok: true };

  // THE TWO DOORWAYS MUST AGREE ABOUT WHICH SERVICES EXIST.
  //
  // `getCrewPricedServices` lists `.eq("active", true)` — 16 of the 28 rows.
  // This door had no such filter, so an id for one of the 12 INACTIVE
  // services would flip cleanly: `Winter storage — indoor` passes
  // `crewCardCanPrice`, and it would go crew-priced with no preview ever
  // rendered, no consequence line ever read, and nothing surfacing until
  // somebody activated it — at which point it is live, crew-priced and
  // unreviewed. Refused here rather than quietly listed there, because the
  // 12 inactive rows on that card would be 12 rows of noise about services
  // nobody can buy. Activate it first and it appears with everything else.
  if (svc.active !== true) {
    return {
      ok: false,
      error:
        `${svc.name} isn't active, so it isn't on the list this decision is made from — there is no menu ` +
        `price showing, no crew count and nothing booked. Turn the service on first and it appears here ` +
        `with everything a flip would do.`,
    };
  }

  if (on) {
    const verdict = crewCardCanPrice({ name: svc.name, pricing_model: svc.pricing_model, band_pricing: svc.band_pricing });
    if (!verdict.ok) return { ok: false, error: verdict.reason ?? "A crew's rate card can't price this service." };
  }

  // NO PRICING CHANGE WITHOUT A PLACE TO RECORD IT — AND THE SCREEN ALREADY
  // SAYS SO. The card prints "Nothing can be switched until it's applied" and
  // draws no button while `logReady` is false, and that sentence was a
  // promise only the SCREEN kept: this action had no such check, and the
  // CHECK constraint that would have caught a flip is in the same unapplied
  // file. Called directly today — the flip succeeded and returned `ok:true`
  // with a warning. Copy that asserts a guarantee its writer does not enforce
  // is the bug class; the writer enforces it now.
  const logProbe = await admin.from("service_pricing_changes").select("id").limit(1);
  if (logProbe.error) {
    return {
      ok: false,
      error:
        `The pricing change log isn't readable, so there is nowhere to record who moved this and when — ` +
        `migration 0179 creates it, so it most likely hasn't been applied yet. Nothing has changed.`,
    };
  }

  const upd = await admin.from("services").update({ crew_priced: on }).eq("id", serviceId);
  if (upd.error) {
    // The database has its own copy of this refusal (0179's CHECK). If it is
    // what bit, say the same thing the screen would have said rather than
    // handing him a constraint name.
    const verdict = crewCardCanPrice({ name: svc.name, pricing_model: svc.pricing_model, band_pricing: svc.band_pricing });
    if (!verdict.ok) return { ok: false, error: verdict.reason };
    return { ok: false, error: upd.error.message };
  }

  const log = await admin.from("service_pricing_changes").insert([
    {
      service_id: serviceId,
      changed_by: ops.id,
      field: "crew_priced",
      old_value: was,
      new_value: on,
      note: on
        ? `${svc.name} moved off the menu price onto the crews' own cards.`
        : `${svc.name} moved back onto the LakeLife menu price.`,
    },
  ]);
  if (log.error) {
    console.error("[write failed] the change log row for a crew-pricing flip:", log.error);
    return {
      ok: true,
      warning:
        `${svc.name} is now ${on ? "crew-priced" : "menu-priced"}, but the change didn't make it into the ` +
        `pricing change log (${log.error.message ?? "write failed"}). The switch is right; the record of who ` +
        `moved it and when is missing.`,
    };
  }

  return { ok: true };
}
