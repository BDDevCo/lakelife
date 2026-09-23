/**
 * Dispatch engine (Phase 8) — PURE, no I/O, fully unit-testable. The server
 * actions load the inputs and apply the winner; every decision rule lives here
 * so it can be tested in isolation.
 *
 * Owner intent: ZERO manual dispatch. The machine picks a crew at booking and
 * self-heals nightly. Customer price is fixed (menu); each crew sets their own
 * private rate; margin = menu − crew rate, and a floor protects LakeLife.
 *
 * SINCE 0174 THERE ARE TWO MONEY MODELS HERE, and which one runs is decided by
 * one optional field. `input.platformFee` absent = the paragraph above, byte
 * for byte: a menu price, a per-crew margin, a floor. `input.platformFee` set =
 * the service is crew-priced, the crew's own card IS the price, and LakeLife
 * adds a published percentage on top and takes a published percentage out.
 * Both live here rather than in two engines because every OTHER rule —
 * insurance, standing, geography, work days, capacity, the fleet minute budget,
 * custody — is identical under both, and a second copy of those is how a gate
 * starts lying.
 */
import { fitsTimeBudget, DEFAULT_JOB_MINUTES } from "@/lib/fleet";
import { checkNamedInsured } from "@/lib/named-insured";
import {
  customerPrice as feeCustomerPrice,
  crewPayout as feeCrewPayout,
  platformTake as feePlatformTake,
  platformTakePct,
  type PlatformFee,
} from "@/lib/platform-fee";

export type { PlatformFee };

export interface CrewCandidate {
  vendorId: string;
  status: string; // 'active' | 'invited' | 'suspended'
  coiExpiry: string | null; // YYYY-MM-DD
  /**
   * The insured name typed off the certificate, and the business name on the
   * account (0152). NULL named-insured means a crew who onboarded before the
   * check existed — see the grandfather rule in isEligible.
   */
  coiNamedInsured?: string | null;
  company?: string | null;
  serviceTypes: string[]; // service NAMES the crew does
  serviceLakes: string[]; // lake IDs the crew services (Phase B geo gate)
  workDays: string[]; // e.g. ['Mon','Tue',...]
  dailyCapacity: number; // fleet vendors: Σ active trucks' capacity (loader's job)
  assignedThatDay: number; // jobs already on this crew for the target date
  blockedThatDay: boolean; // any vendor_availability block on the date
  /** Fleet time budget (docs/fleet-routing-design.md): Σ trucks' working
   *  minutes for the day. null/undefined = vendor has no trucks = the
   *  time-budget gate is OFF (legacy count-only behavior, the invariant). */
  minuteBudget?: number | null;
  /** Σ est_minutes of jobs already assigned that day (0 when unknown). */
  assignedMinutes?: number;
  crewRate: number | null; // this crew's price for THIS service (from vendor_rates); null = no rate set
  score: number; // performance tier score (higher = better); 0 if unrated
  baseLat: number | null; // crew home base — for proximity ranking (null = unknown)
  baseLng: number | null;
  /** Storage capability (S2): a seasonal FEET pool, not daily slots. */
  storageCapacityFeet?: number;
  /** Feet already committed to reserved/in_storage stays this winter. */
  storageCommittedFeet?: number;
  storageTypes?: string[]; // 'outdoor' | 'indoor'
  /** Bailee/garagekeepers doc — a standard COI excludes custody (hard gate). */
  garagekeepersExpiry?: string | null;
}

export interface DispatchInput {
  date: string; // target date, YYYY-MM-DD
  weekday: string; // 'Mon'... for the target date
  serviceName: string; // the service being booked
  menuPrice: number; // customer's fixed all-in price
  todayISO: string; // lake-today, for COI expiry check
  marginFloor: number; // e.g. 0.25
  preferredVendorId: string | null; // property's preferred crew, if any
  lakeId: string | null; // the job's lake — a crew must service it (null = no geo gate)
  jobLat: number | null; // the job's location — for proximity ranking
  jobLng: number | null;
  /** Multi-component visit (storage packages): the crew must cover EVERY
   *  name; the loader already summed component rates into crewRate. */
  componentNames?: string[];
  /** This job's duration (services.est_minutes; packages = Σ legs). Only
   *  consulted when a candidate carries a minute budget (has trucks). */
  jobMinutes?: number;
  /** Present when the visit HOLDS the customer's property: the custody gates.
   *  `tier` is null for a standalone custody service, which declares no
   *  building — the insurance and the space still gate, the barn type cannot. */
  storage?: { tier: "outdoor" | "indoor" | null; boatFeet: number } | null;
  /**
   * SET WHEN THIS SERVICE IS CREW-PRICED (services.crew_priced): the crew's own
   * card IS the price and `menuPrice` is not a price at all.
   *
   * Null or absent — which is every service today and every park job forever —
   * means the menu path, unchanged. The caller passes the dials frozen onto the
   * job at booking, never the live settings, so tuning a dial can never reprice
   * work already sold.
   */
  platformFee?: PlatformFee | null;
  /**
   * THE CREW THE CUSTOMER PICKED (jobs.chosen_vendor_id, 0178).
   *
   * Written by the offers screen when the buyer chose off a list of every crew
   * who could take the job. CONSULTED ONLY ON THE CREW-PRICED PATH, because it
   * is only there that the choice means anything: on a menu-priced service the
   * price is the same whoever comes and the router picks, exactly as it always
   * has.
   *
   * When it is set and that crew is no longer in the pool, the answer is
   * `chosen_crew_unavailable` — NEVER a quiet substitution. The customer chose
   * a name and a number; handing the job to a different crew at a different
   * price is the one outcome that screen exists to prevent.
   */
  chosenVendorId?: string | null;
  crews: CrewCandidate[];
}

/**
 * Great-circle distance in miles between two points. Any null coordinate ⇒
 * Infinity (unknown base ranks as "farthest", never eligibility-excluding).
 * Straight-line is deliberate: cheap, no API call — Directions is reserved for
 * the actual daily route, not the match (these lakes are ~10–25 mi apart).
 */
export function milesBetween(
  aLat: number | null, aLng: number | null, bLat: number | null, bLng: number | null,
): number {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return Infinity;
  const R = 3958.8; // earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface DispatchResult {
  vendorId: string;
  /** THE CREW'S OWN NUMBER, both models. On the menu path it is their private
   *  rate; on the crew-priced path it is the quote they typed, BEFORE either
   *  fee — not what they are paid. `crewPayout` is what they are paid. */
  crewRate: number;
  /** WHAT LAKELIFE KEEPS. Menu path: menuPrice − crewRate. Crew-priced path:
   *  customerPrice − crewPayout. Same meaning both ways, which is why every
   *  existing reader of this field stays honest. */
  margin: number;
  /** margin / customerPrice. On the crew-priced path this is a CONSTANT on
   *  purpose — (c + k) / (1 + c), 21.43% at 12/12 — the same for every crew
   *  and every quote. See the floor note in decideDispatch. */
  marginPct: number;
  /** What the customer is billed. Menu path: the menu price, unchanged. */
  customerPrice: number;
  /** What we actually PAY the crew — payouts.amount and jobs.vendor_cost.
   *  Menu path: their rate. Crew-priced path: their quote minus the crew fee,
   *  which is NOT the number they typed. Every crew-facing screen showing a
   *  rate must print both, in words. */
  crewPayout: number;
  /** === margin. Named for what it is on the crew-priced path so a screen
   *  never has to subtract two numbers and drift. */
  platformTake: number;
  preferred: boolean; // won by preferred-crew right of refusal
  reason: string;
}

export interface DispatchDecision {
  ok: boolean;
  result?: DispatchResult;
  /** Why no crew could take it — drives the ops "needs attention" signal.
   *  no_crew_on_lake is the geographic dead-end (cold-start lake): crews do
   *  this service, just not HERE — distinct from all_full_or_blocked so the
   *  booking flow never mistakes "no crew yet" for "day genuinely full".
   *  no_routable_crew is its paperwork twin: a crew IS on this lake doing this
   *  service, and not one of them can be sent on any day — still onboarding,
   *  suspended, or no certificate in date. Named apart from no_crew_on_lake
   *  because that one asserts geography, which would be a lie here. */
  reasonNoFit?: "no_crew_for_service" | "no_crew_on_lake" | "all_full_or_blocked" | "no_qualifying_rate" | "below_floor" | "no_custody_crew" | "no_full_coverage_crew" | "no_routable_crew" | "chosen_crew_unavailable";
  eligibleCount?: number; // crews that cleared the hard gates (pre-rate)
}

/** Hard eligibility gates every crew must clear for a given date + service. */
/**
 * COULD THIS CREW EVER DO THIS WORK — the half of eligibility that has nothing
 * to do with a date.
 *
 * Split out of `isEligible`, which asks a narrower question than it appears
 * to: it answers "can this crew take THIS job on THIS day", so a `false` from
 * it means any of "they are booked", "they do not work Tuesdays", "their
 * certificate lapsed", or "nobody on this platform does this at all". Those
 * are wildly different problems and only the last one is a hole you can do
 * something about three months early.
 *
 * `isEligible` calls this first, so the two can never drift apart — a coverage
 * board built on a hand-copied version of these rules would agree with
 * dispatch today and quietly disagree the first time either changed.
 *
 * DELIBERATELY EXCLUDED: work days, day blocks, daily capacity, the fleet
 * minute budget, and the storage gates. Every one is about a particular day or
 * a particular job, not about capability.
 */
export type CrewCapability = Pick<
  CrewCandidate,
  "status" | "coiExpiry" | "coiNamedInsured" | "company" | "serviceTypes" | "serviceLakes"
>;

export function canEverDo(
  // NARROWED TO WHAT IT ACTUALLY READS. Taking a whole CrewCandidate would
  // force a caller who only knows capability — the coverage board — to invent
  // a daily capacity and a home base, and an invented number in a gate is how
  // a gate starts lying.
  c: CrewCapability,
  input: Pick<DispatchInput, "serviceName" | "componentNames" | "lakeId" | "todayISO">,
): boolean {
  if (c.status !== "active") return false;
  if (!c.coiExpiry || String(c.coiExpiry) < input.todayISO) return false; // no COI, no jobs

  // THE CERTIFICATE HAS TO BELONG TO THIS CREW (0152). Activation checks this
  // too, but activation runs once — a crew who goes live and then replaces
  // their certificate with one naming a different business would otherwise
  // keep being routed forever on paperwork that is not theirs.
  //
  // GRANDFATHERED ON PURPOSE. A null named-insured is a crew who onboarded
  // before the field existed, not a crew who failed the check — and refusing
  // them here would have stopped routing for every crew on the platform the
  // moment this shipped. That is the "migration breaks what already worked"
  // failure, and it would have been silent: an empty board, no error. Only a
  // name that is PRESENT and WRONG blocks.
  if (c.coiNamedInsured != null && !checkNamedInsured(c.coiNamedInsured, c.company).ok) return false;
  // Capability: single-service jobs check the one name; package visits
  // demand EVERY component — the legs ARE the capability flags.
  const needed = input.componentNames?.length ? input.componentNames : [input.serviceName];
  if (!needed.every((n) => c.serviceTypes.includes(n))) return false;
  // Geo gate: when the job has a lake, the crew must service it. A crew with no
  // lakes serves nowhere. (lakeId null ⇒ no gate, e.g. a property without a lake.)
  if (input.lakeId && !(c.serviceLakes ?? []).includes(input.lakeId)) return false;
  return true;
}

/**
 * THE WORK-DAY HALF OF `isEligible`, ON ITS OWN — and it is exported for one
 * reason only.
 *
 * `all_full_or_blocked` is the CATCH-ALL after `isEligible`, which bundles
 * work days, day blocks, the job cap and the minute budget into a single
 * verdict. On a platform with nothing booked, one crew working Mon–Fri makes
 * every Saturday read "every crew who could take this is already full" — a
 * sentence about somebody's calendar that is simply untrue, and the very lie
 * the cold-start fix above was written to kill.
 *
 * The offers screen asks THIS function rather than re-testing `workDays`
 * itself, so the sentence it prints and the gate the router applies can never
 * drift into two different ideas of which days a crew works.
 */
export function worksThatWeekday(c: CrewCandidate, input: Pick<DispatchInput, "weekday">): boolean {
  return c.workDays.includes(input.weekday);
}

export function isEligible(c: CrewCandidate, input: DispatchInput): boolean {
  // Capability, insurance, standing and geography — one shared rule.
  if (!canEverDo(c, input)) return false;
  // Custody gates (storage visits only): unexpired garagekeepers doc, the
  // right building, and free feet in the seasonal pool. Hard by owner decision.
  if (input.storage) {
    if (!c.garagekeepersExpiry || String(c.garagekeepersExpiry) < input.todayISO) return false;
    // The barn TYPE is only checkable when the visit named one. A package with
    // a seasonal leg does; a standalone custody service does not, and refusing
    // every crew for failing to match a tier that was never asked for would
    // shut the gate on the wrong thing. Insurance and space still bite.
    if (input.storage.tier && !(c.storageTypes ?? []).includes(input.storage.tier)) return false;
    const free = (c.storageCapacityFeet ?? 0) - (c.storageCommittedFeet ?? 0);
    if (free < input.storage.boatFeet) return false;
  }
  if (!worksThatWeekday(c, input)) return false;
  if (c.blockedThatDay) return false;
  const cap = c.dailyCapacity > 0 ? c.dailyCapacity : 0;
  if (cap <= 0 || c.assignedThatDay >= cap) return false;
  // Fleet time budget: a day full of 3-hour pier installs is FULL long
  // before the job COUNT says so. Only active for vendors with trucks
  // (minuteBudget null/undefined = legacy count-only, unchanged).
  if (
    c.minuteBudget != null &&
    !fitsTimeBudget(c.assignedMinutes ?? 0, input.jobMinutes ?? DEFAULT_JOB_MINUTES, c.minuteBudget)
  ) {
    return false;
  }
  return true;
}

/** Margin fraction for a crew's rate against the menu price. */
export function marginPct(menuPrice: number, crewRate: number): number {
  if (!(menuPrice > 0)) return 0;
  return (menuPrice - crewRate) / menuPrice;
}

/**
 * Rank comparator for eligible+affordable crews (best first):
 *  1) performance tier (score desc)
 *  2) route density — already has jobs that day (assignedThatDay desc)
 *  3) proximity — nearer home base to the job (distance asc)  [Phase B]
 *  4) margin to LakeLife (higher margin first)
 *  5) load fairness — fewer jobs so far, then stable by vendorId
 *
 * Proximity sits ABOVE margin so a distant, cheaper crew never wins over a local
 * one on money alone (a 40-mi round trip is a false economy) — but BELOW density
 * (a crew already routing this lake today is effectively local) and below quality
 * (a better crew is worth a little drive). Unknown bases tie at Infinity and fall
 * through to margin, so nothing regresses until crews set a base.
 *
 * KEY 4 INVERTS ON THE CREW-PRICED PATH (0174). "Higher margin first" is a
 * sentence about a menu: the price is fixed, so the cheaper crew leaves us
 * more. Under crew pricing LakeLife's share is a fixed MULTIPLE of whatever
 * the crew charges, so the exact same line ranks THE MOST EXPENSIVE CREW
 * FIRST — it would quietly hand every job to the priciest card on the lake and
 * bill the customer for it. When `fee` is present the key becomes crewRate
 * ASCENDING: cheapest for the customer, which is also the owner's own words
 * ("the homeowner should be given the options available ... then they make the
 * decision" — the machine's default must be the one he would pick).
 *
 * `fee` null/absent = the menu comparator, unchanged. Passed in rather than
 * read from a global because a job must rank against the dials FROZEN on it.
 */
export function rankCrews(
  crews: CrewCandidate[], menuPrice: number, jobLat: number | null = null, jobLng: number | null = null,
  fee: PlatformFee | null = null,
): CrewCandidate[] {
  return [...crews].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.assignedThatDay !== a.assignedThatDay) return b.assignedThatDay - a.assignedThatDay;
    const da = milesBetween(jobLat, jobLng, a.baseLat, a.baseLng);
    const db = milesBetween(jobLat, jobLng, b.baseLat, b.baseLng);
    if (da !== db) return da - db; // nearer base first (Infinity ties fall through)
    if (fee) {
      // Cheapest quote first — the inverse of the menu key, deliberately.
      const ra = a.crewRate ?? Infinity, rb = b.crewRate ?? Infinity;
      if (ra !== rb) return ra - rb;
    } else {
      const ma = marginPct(menuPrice, a.crewRate ?? menuPrice);
      const mb = marginPct(menuPrice, b.crewRate ?? menuPrice);
      if (mb !== ma) return mb - ma;
    }
    if (a.assignedThatDay !== b.assignedThatDay) return a.assignedThatDay - b.assignedThatDay;
    return a.vendorId < b.vendorId ? -1 : 1;
  });
}

/**
 * THE GEOGRAPHIC DEAD END, AS ONE FUNCTION THAT EVERYBODY ASKS.
 *
 * `decideDispatch` returns `no_crew_on_lake` here, and for a long time NOTHING
 * READ IT. The only consumer of `reasonNoFit` anywhere was
 * `all_full_or_blocked` (book/actions.ts and book/storage/actions.ts); every
 * other code fell off the end of the world, so a Haven job that found no
 * lake-ticked crew left no trace on any screen — not the crew's, not ops'.
 *
 * THAT IS NO LONGER TRUE, and this comment said it was long after it stopped
 * being: `NO_FIT_LABEL` below gives every code words, and three doorways read
 * them — the ops job file, the ops needs-attention board, and `retryAssign`,
 * which is the one place a person presses a button and the engine answers
 * live.
 *
 * The ops needs-attention board DID reach the same conclusion, from its own
 * hand-rolled copy of this membership test. A hand-copied rule agrees with
 * dispatch today and drifts the first time either changes — the exact hazard
 * `canEverDo` was split out to end. So the test lives here, once, and the
 * board and the job file both call it.
 *
 * @param forService crews who cover EVERY leg of the work — pre-filtered.
 * @param lakeId     null/absent means no lake to fail on: never a dead end.
 */
export function noCrewOnLake(
  forService: Pick<CrewCandidate, "serviceLakes">[],
  lakeId: string | null | undefined,
): boolean {
  if (!lakeId) return false;
  return !forService.some((c) => (c.serviceLakes ?? []).includes(lakeId));
}

/**
 * THE CAPABILITY STAGE OF THE VERDICT, AS ONE FUNCTION EVERYBODY ASKS.
 *
 * Three of the eight reasons are settled before capacity, rates or the
 * calendar are consulted at all — they are facts about who exists and what
 * they have ticked, and they do not change hour to hour:
 *
 *   no_crew_for_service   nobody covers this work
 *   no_full_coverage_crew somebody on this lake covers SOME legs of a package
 *   no_crew_on_lake       crews cover the work, none has ticked this lake
 *
 * WHY IT IS A FUNCTION. `decideDispatch` used to hold this inline, and the
 * ops job file re-derived it from `header.serviceName` alone — with no
 * package-leg test at all. A grouped visit with a pier crew on Pretty Lake and
 * an opening crew on Big Turkey would therefore print "No crew has ticked this
 * lake yet — recruiting is the unblock" on the ops job page while the engine
 * said `no_full_coverage_crew`. Recruiting is not the cure for a coverage gap,
 * and ops would have gone looking for a crew who is already there. Same hazard
 * `noCrewOnLake` was split out to end, one stage up.
 *
 * @param crews  the pool to judge. Callers outside the engine must pre-filter
 *               to crews who could EVER be sent — see canEverDo — because this
 *               stage asks only about capability, never paperwork.
 * @param input  serviceName / componentNames / lakeId. `lakeId` null means no
 *               lake to fail on.
 * @returns the reason code, or null when capability is not the problem.
 */
export function capabilityNoFit(
  crews: Pick<CrewCandidate, "serviceTypes" | "serviceLakes">[],
  input: Pick<DispatchInput, "serviceName" | "componentNames" | "lakeId">,
): NonNullable<DispatchDecision["reasonNoFit"]> | null {
  const neededNames = input.componentNames?.length ? input.componentNames : [input.serviceName];
  const forService = crews.filter((c) => neededNames.every((n) => c.serviceTypes.includes(n)));
  // SIM-FOUND (Wave 2): a crew ON the lake covering SOME of a package's legs
  // is a coverage gap, not "no crew on this lake" — the alarming message was
  // firing on lakes with a real (partial) crew. Name it honestly.
  const partialOnLake = (): boolean =>
    !!input.componentNames?.length && !!input.lakeId &&
    crews.some((c) =>
      (c.serviceLakes ?? []).includes(input.lakeId as string) &&
      neededNames.some((n) => c.serviceTypes.includes(n)) &&
      !neededNames.every((n) => c.serviceTypes.includes(n)));
  if (forService.length === 0) {
    return partialOnLake() ? "no_full_coverage_crew" : "no_crew_for_service";
  }
  // Geographic dead-end BEFORE the capacity read: crews do this service but
  // none serves THIS lake — that's a recruiting problem, not a full calendar.
  if (noCrewOnLake(forService, input.lakeId)) {
    return partialOnLake() ? "no_full_coverage_crew" : "no_crew_on_lake";
  }
  return null;
}

/**
 * EVERY REASON CODE, IN WORDS A PERSON CAN ACT ON.
 *
 * One home for the sentences, so a new reason code cannot be added without a
 * reader — and so the ops job file, the ops board and anything later all say
 * the same thing about the same verdict. `no_crew_on_lake` is the recruiting
 * signal: it is the only one of these that names a crew who does not exist yet.
 */
export const NO_FIT_LABEL: Record<NonNullable<DispatchDecision["reasonNoFit"]>, string> = {
  no_crew_for_service: "No active, insured crew does this work yet",
  no_crew_on_lake: "No crew has ticked this lake yet — recruiting is the unblock",
  no_full_coverage_crew: "A crew here covers only part of this visit",
  no_routable_crew: "A crew here does this work, but none can be sent on any day — paperwork, not the calendar",
  all_full_or_blocked: "Every crew who could take it is full or blocked that day",
  no_qualifying_rate: "No crew here has set a rate for this work",
  below_floor: "No crew here clears the margin floor at their rate",
  no_custody_crew: "No crew here is cleared to hold a boat",
  chosen_crew_unavailable: "The crew the customer picked can no longer take that day",
};

/**
 * The whole decision. Preferred crew gets first right of refusal (if eligible +
 * their rate clears the floor); otherwise rank the affordable eligible pool.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  // THE CAPABILITY STAGE, ASKED THROUGH THE SHARED FUNCTION rather than
  // inline — see capabilityNoFit. Two ops screens re-derive this verdict from
  // their own queries, and a hand-copy of a three-way branch drifts.
  const capability = capabilityNoFit(input.crews, input);
  if (capability) return { ok: false, reasonNoFit: capability, eligibleCount: 0 };

  const eligible = input.crews.filter((c) => isEligible(c, input));
  if (eligible.length === 0) {
    // Custody honesty (S2, found live): when crews could take the visit but
    // NONE clears the storage gates (garagekeepers doc / building type /
    // feet), that's a RECRUITING gap, not a full calendar. Telling the
    // customer "that day just filled up" would be the same lie the lake
    // cold-start fix killed — surface it as its own reason so the booking
    // flow keeps the demand as an honest Finding-a-crew row.
    if (input.storage && input.crews.some((c) => isEligible(c, { ...input, storage: null }))) {
      return { ok: false, reasonNoFit: "no_custody_crew", eligibleCount: 0 };
    }
    // STANDING AND PAPERWORK ARE NOT A FULL CALENDAR.
    //
    // An empty `eligible` has two completely different causes. Every capable
    // crew's DAY is full — which is what the two callers of this value act on:
    // book/actions.ts and book/storage/actions.ts DELETE the booking row and
    // answer "That day just filled up — pick another date." Or no crew here
    // could be sent on ANY day: still `invited` and onboarding, suspended by
    // ops, certificate lapsed or absent, certificate naming somebody else's
    // business. Every one of those gates is date-independent, so the advice to
    // pick another date can never come true — each new date deletes the
    // booking again with the same false sentence, and the demand never becomes
    // the Finding-a-crew row that is both the honest answer and the recruiting
    // signal. The first real crew on a lake makes it WORSE than no crew at
    // all: with nobody listed, the lake gate above keeps the booking.
    //
    // Asked with `canEverDo` rather than a fresh status check, so this can
    // never drift from the rule the router, the coverage board and the claim
    // board already share.
    if (!input.crews.some((c) => canEverDo(c, input))) {
      return { ok: false, reasonNoFit: "no_routable_crew", eligibleCount: 0 };
    }
    return { ok: false, reasonNoFit: "all_full_or_blocked", eligibleCount: 0 };
  }

  // A crew must have a POSITIVE rate to be routable — a $0/blank rate is not a
  // real rate (it would otherwise rank first at "100% margin" and get paid $0).
  const withRate = eligible.filter((c) => c.crewRate != null && (c.crewRate as number) > 0);
  if (withRate.length === 0) return { ok: false, reasonNoFit: "no_qualifying_rate", eligibleCount: eligible.length };

  // THE MARGIN FLOOR RETIRES ON THE CREW-PRICED PATH (0174).
  //
  // The floor is a per-crew test: against a fixed menu price, one crew's card
  // can leave LakeLife 30% and another's 12%, and the floor refuses the second.
  // Under crew pricing there is no such spread — LakeLife keeps
  // (c + k) / (1 + c) of the bill, the same fraction on every job, whatever the
  // crew charges. So the comparison stops being a filter and becomes a GLOBAL
  // ON/OFF SWITCH: at 11%/11% it computes 19.82%, falls under the live 0.20
  // dial, and refuses EVERY job on the platform with `below_floor` — a reason
  // no screen prints, so the symptom would be bookings silently going nowhere
  // platform-wide the day somebody nudged a dial by one point.
  //
  // What protects LakeLife on this path is not a floor, it is the arithmetic:
  // the take is a fixed share of the bill and cannot be negative while both
  // dials are in [0, 0.5].
  const affordable = input.platformFee
    ? withRate
    : withRate.filter((c) => marginPct(input.menuPrice, c.crewRate as number) >= input.marginFloor);
  if (affordable.length === 0) return { ok: false, reasonNoFit: "below_floor", eligibleCount: eligible.length };

  const build = (c: CrewCandidate, preferred: boolean, reason: string): DispatchResult => {
    const rate = c.crewRate as number;
    const fee = input.platformFee;
    if (fee) {
      // THE CREW'S CARD IS THE PRICE. `crewRate` stays the quote they typed;
      // what they are PAID is the quote minus the crew-side fee, and that is
      // the number that becomes jobs.vendor_cost and payouts.amount — so those
      // two still tie, and the columns keep their existing meanings.
      const customer = feeCustomerPrice(rate, fee);
      const payout = feeCrewPayout(rate, fee);
      const take = feePlatformTake(rate, fee);
      return {
        vendorId: c.vendorId,
        crewRate: rate,
        // margin has always meant "what LakeLife keeps". It still does.
        margin: take,
        // A CONSTANT ON PURPOSE — identical for every crew and every quote.
        marginPct: platformTakePct(fee),
        customerPrice: customer,
        crewPayout: payout,
        platformTake: take,
        preferred,
        reason,
      };
    }
    // The menu path, unchanged. The three derived fields restate what has
    // always been true here so a caller never has to know which model ran:
    // the customer pays the menu price, the crew is paid their rate, and the
    // difference is ours.
    const margin = Math.round((input.menuPrice - rate) * 100) / 100;
    return {
      vendorId: c.vendorId,
      crewRate: rate,
      margin,
      marginPct: marginPct(input.menuPrice, rate),
      customerPrice: input.menuPrice,
      crewPayout: rate,
      platformTake: margin,
      preferred,
      reason,
    };
  };

  // ================= WHO GETS IT, AND WHO DECIDED (0178) =================
  //
  // Brendon, 23 September 2026: "the owner needing the service should still see
  // all the options, if any, for the crews available and their pricing" — and,
  // on the pricing itself, "then they make the decision."
  //
  // THE MENU PATH IS UNCHANGED, BYTE FOR BYTE. There is no choice to make: the
  // price is LakeLife's and identical whoever comes, so the crew a property
  // brought keeps its first right of refusal and the router picks otherwise.
  //
  // THE CREW-PRICED PATH IS WHERE THE MEANING OF `preferred_vendor` CHANGES.
  // There, every crew quotes their own number and the customer is shown all of
  // them side by side. First right of refusal was invisible under the old model
  // — the router picked and the customer never saw options at all — but under a
  // model where the customer chooses it is a soft exclusivity: the crew someone
  // brought would take the job before the customer's own pick was consulted.
  // So on this path preferred becomes a BADGE AND A SORT ON THE OFFERS SCREEN
  // and nothing here. It is never a filter and never a first refusal.
  //
  // What DOES decide here is `chosenVendorId` — the customer's own pick. With
  // no pick recorded (autopilot, the nightly self-heal, anything booked before
  // the offers screen existed) the pool is ranked, exactly as it is for
  // everyone else.
  if (input.platformFee) {
    if (input.chosenVendorId) {
      const picked = affordable.find((c) => c.vendorId === input.chosenVendorId);
      if (picked) {
        return {
          ok: true,
          // `preferred` still reports the FACT — this is the crew the property
          // brought — because the badge is drawn from it. It is no longer the
          // reason they won; the customer choosing them is.
          result: build(picked, picked.vendorId === input.preferredVendorId, "the crew the customer chose"),
          eligibleCount: eligible.length,
        };
      }
      // NO SILENT SUBSTITUTE. Their crew's day filled between the offers screen
      // and the tap, or a certificate lapsed in between. Handing the job to
      // somebody else — at somebody else's price — is exactly the swap this
      // whole package exists to stop, so the caller is told which it was and
      // gets to say so.
      return { ok: false, reasonNoFit: "chosen_crew_unavailable", eligibleCount: eligible.length };
    }
  } else if (input.preferredVendorId) {
    // Preferred crew: first right of refusal when they're in the affordable pool.
    const pref = affordable.find((c) => c.vendorId === input.preferredVendorId);
    if (pref) return { ok: true, result: build(pref, true, "preferred crew"), eligibleCount: eligible.length };
  }

  const winner = rankCrews(affordable, input.menuPrice, input.jobLat, input.jobLng, input.platformFee ?? null)[0];
  return { ok: true, result: build(winner, false, "best-ranked eligible crew"), eligibleCount: eligible.length };
}

/**
 * CLAIM BOARD gate (Phase D). Can this crew claim an open job? Same hard gates
 * as isEligible with ONE deliberate difference: the LAKE gate is skipped —
 * claiming a job on a new lake is how a crew opts INTO that lake (the claim
 * action appends it to service_lakes). That's the cold-start unlock: a lake
 * with zero crews gets its first one the moment a nearby crew grabs a job.
 * Unlike auto-dispatch, a claim also requires the crew's OWN rate to exist and
 * clear the margin floor — crews compete on speed, never on price.
 */
export type ClaimBlocker =
  | "not_active" | "no_coi" | "wrong_service" | "off_day" | "day_blocked" | "day_full"
  | "no_rate" | "rate_too_high"
  | "lake_paused" // Phase E cooldown — set by the data layer, not canClaim (it's per-job DB state)
  | "custody_job"; // storage visits never appear as cold-claim prizes (S2)

export function canClaim(
  c: CrewCandidate,
  input: Pick<DispatchInput, "serviceName" | "weekday" | "todayISO" | "menuPrice" | "marginFloor"> &
    Partial<Pick<DispatchInput, "componentNames" | "storage" | "jobMinutes" | "platformFee">>,
): { ok: boolean; blocker?: ClaimBlocker } {
  // Custody is never a first-tap prize: a stranger crew must not win six
  // months of holding a customer's boat off the claim board (owner decision).
  if (input.storage) return { ok: false, blocker: "custody_job" };
  if (input.componentNames?.length && !input.componentNames.every((n) => c.serviceTypes.includes(n))) {
    return { ok: false, blocker: "wrong_service" };
  }
  if (c.status !== "active") return { ok: false, blocker: "not_active" };
  if (!c.coiExpiry || String(c.coiExpiry) < input.todayISO) return { ok: false, blocker: "no_coi" };
  // Same rule, third doorway (0152). Grandfathered identically: a null name is
  // a crew who predates the field, a present-and-wrong one is somebody else's
  // certificate. Reported as `no_coi` rather than a new blocker because the
  // crew-facing sentence is the same either way — their paperwork is not in
  // order, and the detail belongs on their own documents page, not on a board.
  if (c.coiNamedInsured != null && !checkNamedInsured(c.coiNamedInsured, c.company).ok) {
    return { ok: false, blocker: "no_coi" };
  }
  if (!c.serviceTypes.includes(input.serviceName)) return { ok: false, blocker: "wrong_service" };
  if (!c.workDays.includes(input.weekday)) return { ok: false, blocker: "off_day" };
  if (c.blockedThatDay) return { ok: false, blocker: "day_blocked" };
  const cap = c.dailyCapacity > 0 ? c.dailyCapacity : 0;
  if (cap <= 0 || c.assignedThatDay >= cap) return { ok: false, blocker: "day_full" };
  // Same fleet time budget as auto-dispatch — the claim board can't
  // overstuff a fleet's hours any more than the machine can.
  if (
    c.minuteBudget != null &&
    !fitsTimeBudget(c.assignedMinutes ?? 0, input.jobMinutes ?? DEFAULT_JOB_MINUTES, c.minuteBudget)
  ) {
    return { ok: false, blocker: "day_full" };
  }
  if (c.crewRate == null || c.crewRate <= 0) return { ok: false, blocker: "no_rate" };
  // `rate_too_high` is a sentence about a menu: the customer's price is already
  // fixed, so a card above menu × (1 − floor) cannot be paid out of it. On the
  // crew-priced path the crew's own rate IS the price — the customer's bill is
  // built FROM it — so there is no number it could be too high against, and the
  // floor here would be the same platform-wide on/off switch it is in
  // decideDispatch. A crew is never refused their own board for the price they
  // set; the customer chooses between the crews they can see.
  if (!input.platformFee && marginPct(input.menuPrice, c.crewRate) < input.marginFloor) {
    return { ok: false, blocker: "rate_too_high" };
  }
  return { ok: true };
}

/**
 * SCARCITY OFFER (Phase C, ladder rung 3). When every willing crew prices a
 * job below the margin floor, the machine doesn't page a human to "adjust" —
 * it computes the smallest whole-dollar price bump that would clear the floor
 * for the cheapest crew and OFFERS it to the customer (accept/decline). The
 * bump is capped at menu × (1 + capPct); past the cap the machine stays
 * honest and lets the job ride the claim board / waitlist instead.
 * Returns null when no offer makes sense: no rate, floor already clears, or
 * the needed price busts the cap. RULE 1 note: the customer only ever sees
 * the new all-in price; the crew rate and margin stay hidden.
 */
export function scarcityOffer(
  menuPrice: number, bestRate: number, floor: number, capPct: number,
): { newPrice: number; uplift: number } | null {
  if (!(menuPrice > 0) || !(bestRate > 0) || floor >= 1) return null;
  if (marginPct(menuPrice, bestRate) >= floor) return null; // already clears — no offer
  const needed = Math.ceil(bestRate / (1 - floor)); // whole dollars, rounded UP to clear
  const cap = menuPrice * (1 + Math.max(0, capPct));
  if (needed > cap) return null; // can't fix within the cap — honest dead end
  const uplift = needed - menuPrice;
  if (uplift <= 0) return null; // floor clears at (rounded) menu already
  return { newPrice: needed, uplift };
}

/**
 * Capacity for the booking calendar: how many open service-slots exist for a
 * service on a date across all eligible crews. 0 ⇒ the date must not be
 * offered. (Rate/floor is checked at assignment, not calendar time — a date
 * with capacity but no affordable crew escalates to ops as a price signal.)
 */
export function remainingCapacity(input: Omit<DispatchInput, "menuPrice" | "marginFloor" | "preferredVendorId">): number {
  return input.crews.reduce((sum, c) => {
    if (!isEligible(c, input as DispatchInput)) return sum;
    const cap = c.dailyCapacity > 0 ? c.dailyCapacity : 0;
    return sum + Math.max(0, cap - c.assignedThatDay);
  }, 0);
}

// ============================================================================
// FILL-IN RATES (docs/margin-gap-design.md) — the zero-stranded-jobs margin
// mechanism. A job that failed dispatch on margin becomes a POSTED-PRICE
// offer on the claim board; one tap = consent, exactly the rush pattern.
// ============================================================================

/**
 * Deterministic per-job jitter for menu-derived offers: $0/$5/$10, hashed
 * from the job id. Two jobs at the SAME menu price show different ceilings,
 * so equal offers can't confirm equal menu prices across properties — and
 * the [t/(1−f), (t+5)/(1−f)) back-solve band widens to three steps. Only
 * ever subtracted (downward), so margin ≥ floor survives by construction.
 * Board and claim hash the same id → the posted price IS the paid price.
 */
export function gapJitter(jobId: string): number {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < jobId.length; i++) {
    h ^= jobId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 3) * 5;
}

/**
 * The floor-clearing take-home ceiling for a job: menu × (1 − floor),
 * rounded DOWN to a $5 step, minus the per-job jitter. Rounding down does
 * two jobs at once — margin stays ≥ floor by construction, and the
 * ÷(1−floor) inversion breaks so a crew can't back-solve the menu price
 * (rule 1 by arithmetic). Null when the number would be silly (no price,
 * degenerate floor, offer under the minimum). The $5 step is structural —
 * it IS the fuzz — so it stays in code; the minimum is a rule-8 dial.
 */
export function gapTakeHome(menuPrice: number, floor: number, jitter = 0, minOffer = 20): number | null {
  if (!(menuPrice > 0) || !(floor > 0) || floor >= 1) return null;
  const t = Math.floor((menuPrice * (1 - floor)) / 5) * 5 - jitter;
  return t >= Math.max(20, minOffer) ? t : null;
}

/**
 * The crew's actual fill-in offer: never more than the ceiling, and never
 * more than anchorPct (dial, default 95%) of THEIR OWN trailing anchor rate
 * (their lowest card of the last 90 days, priced against this job). Hiking
 * your card can never raise your offer — the harvest play strictly loses.
 * Crews with no anchor (no history and no current rate) see the fuzzed
 * ceiling.
 */
export function gapOfferFor(tStar: number | null, crewAnchorRate: number | null, anchorPct = 0.95, minOffer = 20): number | null {
  if (tStar == null) return null;
  if (crewAnchorRate == null || !(crewAnchorRate > 0)) return tStar;
  const anchored = Math.floor((crewAnchorRate * anchorPct) / 5) * 5;
  if (anchored < Math.max(20, minOffer)) return null; // an offer this small is noise, not work
  return Math.min(tStar, anchored);
}
