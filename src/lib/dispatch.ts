/**
 * Dispatch engine (Phase 8) — PURE, no I/O, fully unit-testable. The server
 * actions load the inputs and apply the winner; every decision rule lives here
 * so it can be tested in isolation.
 *
 * Owner intent: ZERO manual dispatch. The machine picks a crew at booking and
 * self-heals nightly. Customer price is fixed (menu); each crew sets their own
 * private rate; margin = menu − crew rate, and a floor protects LakeLife.
 */

export interface CrewCandidate {
  vendorId: string;
  status: string; // 'active' | 'invited' | 'suspended'
  coiExpiry: string | null; // YYYY-MM-DD
  serviceTypes: string[]; // service NAMES the crew does
  serviceLakes: string[]; // lake IDs the crew services (Phase B geo gate)
  workDays: string[]; // e.g. ['Mon','Tue',...]
  dailyCapacity: number;
  assignedThatDay: number; // jobs already on this crew for the target date
  blockedThatDay: boolean; // any vendor_availability block on the date
  crewRate: number | null; // this crew's price for THIS service (from vendor_rates); null = no rate set
  score: number; // performance tier score (higher = better); 0 if unrated
  baseLat: number | null; // crew home base — for proximity ranking (null = unknown)
  baseLng: number | null;
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
  crewRate: number;
  margin: number; // menuPrice − crewRate
  marginPct: number; // margin / menuPrice
  preferred: boolean; // won by preferred-crew right of refusal
  reason: string;
}

export interface DispatchDecision {
  ok: boolean;
  result?: DispatchResult;
  /** Why no crew could take it — drives the ops "needs attention" signal. */
  reasonNoFit?: "no_crew_for_service" | "all_full_or_blocked" | "no_qualifying_rate" | "below_floor";
  eligibleCount?: number; // crews that cleared the hard gates (pre-rate)
}

/** Hard eligibility gates every crew must clear for a given date + service. */
export function isEligible(c: CrewCandidate, input: DispatchInput): boolean {
  if (c.status !== "active") return false;
  if (!c.coiExpiry || String(c.coiExpiry) < input.todayISO) return false; // no COI, no jobs
  if (!c.serviceTypes.includes(input.serviceName)) return false;
  // Geo gate: when the job has a lake, the crew must service it. A crew with no
  // lakes serves nowhere. (lakeId null ⇒ no gate, e.g. a property without a lake.)
  if (input.lakeId && !(c.serviceLakes ?? []).includes(input.lakeId)) return false;
  if (!c.workDays.includes(input.weekday)) return false;
  if (c.blockedThatDay) return false;
  const cap = c.dailyCapacity > 0 ? c.dailyCapacity : 0;
  if (cap <= 0 || c.assignedThatDay >= cap) return false;
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
 */
export function rankCrews(
  crews: CrewCandidate[], menuPrice: number, jobLat: number | null = null, jobLng: number | null = null,
): CrewCandidate[] {
  return [...crews].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.assignedThatDay !== a.assignedThatDay) return b.assignedThatDay - a.assignedThatDay;
    const da = milesBetween(jobLat, jobLng, a.baseLat, a.baseLng);
    const db = milesBetween(jobLat, jobLng, b.baseLat, b.baseLng);
    if (da !== db) return da - db; // nearer base first (Infinity ties fall through)
    const ma = marginPct(menuPrice, a.crewRate ?? menuPrice);
    const mb = marginPct(menuPrice, b.crewRate ?? menuPrice);
    if (mb !== ma) return mb - ma;
    if (a.assignedThatDay !== b.assignedThatDay) return a.assignedThatDay - b.assignedThatDay;
    return a.vendorId < b.vendorId ? -1 : 1;
  });
}

/**
 * The whole decision. Preferred crew gets first right of refusal (if eligible +
 * their rate clears the floor); otherwise rank the affordable eligible pool.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  const forService = input.crews.filter((c) => c.serviceTypes.includes(input.serviceName));
  if (forService.length === 0) return { ok: false, reasonNoFit: "no_crew_for_service", eligibleCount: 0 };

  const eligible = input.crews.filter((c) => isEligible(c, input));
  if (eligible.length === 0) return { ok: false, reasonNoFit: "all_full_or_blocked", eligibleCount: 0 };

  // A crew must have a POSITIVE rate to be routable — a $0/blank rate is not a
  // real rate (it would otherwise rank first at "100% margin" and get paid $0).
  const withRate = eligible.filter((c) => c.crewRate != null && (c.crewRate as number) > 0);
  if (withRate.length === 0) return { ok: false, reasonNoFit: "no_qualifying_rate", eligibleCount: eligible.length };

  const affordable = withRate.filter((c) => marginPct(input.menuPrice, c.crewRate as number) >= input.marginFloor);
  if (affordable.length === 0) return { ok: false, reasonNoFit: "below_floor", eligibleCount: eligible.length };

  const build = (c: CrewCandidate, preferred: boolean, reason: string): DispatchResult => {
    const rate = c.crewRate as number;
    return {
      vendorId: c.vendorId,
      crewRate: rate,
      margin: Math.round((input.menuPrice - rate) * 100) / 100,
      marginPct: marginPct(input.menuPrice, rate),
      preferred,
      reason,
    };
  };

  // Preferred crew: first right of refusal when they're in the affordable pool.
  if (input.preferredVendorId) {
    const pref = affordable.find((c) => c.vendorId === input.preferredVendorId);
    if (pref) return { ok: true, result: build(pref, true, "preferred crew"), eligibleCount: eligible.length };
  }

  const winner = rankCrews(affordable, input.menuPrice, input.jobLat, input.jobLng)[0];
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
  | "no_rate" | "rate_too_high";

export function canClaim(
  c: CrewCandidate,
  input: Pick<DispatchInput, "serviceName" | "weekday" | "todayISO" | "menuPrice" | "marginFloor">,
): { ok: boolean; blocker?: ClaimBlocker } {
  if (c.status !== "active") return { ok: false, blocker: "not_active" };
  if (!c.coiExpiry || String(c.coiExpiry) < input.todayISO) return { ok: false, blocker: "no_coi" };
  if (!c.serviceTypes.includes(input.serviceName)) return { ok: false, blocker: "wrong_service" };
  if (!c.workDays.includes(input.weekday)) return { ok: false, blocker: "off_day" };
  if (c.blockedThatDay) return { ok: false, blocker: "day_blocked" };
  const cap = c.dailyCapacity > 0 ? c.dailyCapacity : 0;
  if (cap <= 0 || c.assignedThatDay >= cap) return { ok: false, blocker: "day_full" };
  if (c.crewRate == null || c.crewRate <= 0) return { ok: false, blocker: "no_rate" };
  if (marginPct(input.menuPrice, c.crewRate) < input.marginFloor) return { ok: false, blocker: "rate_too_high" };
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
