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
  workDays: string[]; // e.g. ['Mon','Tue',...]
  dailyCapacity: number;
  assignedThatDay: number; // jobs already on this crew for the target date
  blockedThatDay: boolean; // any vendor_availability block on the date
  crewRate: number | null; // this crew's price for THIS service (from vendor_rates); null = no rate set
  score: number; // performance tier score (higher = better); 0 if unrated
}

export interface DispatchInput {
  date: string; // target date, YYYY-MM-DD
  weekday: string; // 'Mon'... for the target date
  serviceName: string; // the service being booked
  menuPrice: number; // customer's fixed all-in price
  todayISO: string; // lake-today, for COI expiry check
  marginFloor: number; // e.g. 0.25
  preferredVendorId: string | null; // property's preferred crew, if any
  crews: CrewCandidate[];
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
 *  3) margin to LakeLife (higher margin first)
 *  4) load fairness — fewer jobs so far, then stable by vendorId
 */
export function rankCrews(crews: CrewCandidate[], menuPrice: number): CrewCandidate[] {
  return [...crews].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.assignedThatDay !== a.assignedThatDay) return b.assignedThatDay - a.assignedThatDay;
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

  const winner = rankCrews(affordable, input.menuPrice)[0];
  return { ok: true, result: build(winner, false, "best-ranked eligible crew"), eligibleCount: eligible.length };
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
