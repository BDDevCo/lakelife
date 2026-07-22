/**
 * Autopilot proposal engine (§8d) — PURE, no I/O, fully unit-testable.
 *
 * Autopilot is a per-service toggle. Each season the machine proposes ONE
 * visit per enrolled service and texts the customer a one-tap confirm/skip.
 * This module only answers: "given the service and the lake's season dates,
 * what date should we propose (if any)?" The server wraps it with data.
 *
 * Rules (v1):
 *  - Spring-ish water services (name has "spring"/"open"): ice-out + 14 days.
 *  - Fall-ish water services (name has "fall"/"winter"): pull deadline − 14 days.
 *  - Other water work (pier/lift set OR pull): whichever season edge is next.
 *  - Non-water recurring (lawn, housekeeping): last completed visit + interval
 *    (default 30 days); never sooner than the lead time.
 *  - Every proposal must be at least `leadDays` out (default 7) so the
 *    customer has room to confirm; a season already past ⇒ null (no spam).
 */

export interface ProposalInput {
  serviceName: string;
  isWaterWork: boolean;
  iceOutISO: string | null; // lake spring gate
  pullDeadlineISO: string | null; // lake fall gate
  lastCompletedISO: string | null; // most recent completed job of this service here
  todayISO: string;
  intervalDays?: number; // recurring cadence for non-water (default 30)
  leadDays?: number; // min notice (default 7)
  seasonOffsetDays?: number; // distance from the season gate (default 14)
}

function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function proposeAutopilotDate(input: ProposalInput): string | null {
  const lead = input.leadDays ?? 7;
  const offset = input.seasonOffsetDays ?? 14;
  const earliest = addDaysISO(input.todayISO, lead);
  const name = input.serviceName.toLowerCase();

  if (input.isWaterWork) {
    const spring = input.iceOutISO ? addDaysISO(input.iceOutISO, offset) : null;
    const fall = input.pullDeadlineISO ? addDaysISO(input.pullDeadlineISO, -offset) : null;
    const usable = (d: string | null) => (d && d >= earliest ? d : null);

    if (/(spring|open)/.test(name)) return usable(spring);
    if (/(fall|winter|clos)/.test(name)) return usable(fall);
    // Both-ways services (pier install / removal, lift set / pull): next edge.
    return usable(spring) ?? usable(fall);
  }

  // Recurring land work: cadence from the last completed visit.
  const interval = input.intervalDays ?? 30;
  const fromLast = input.lastCompletedISO ? addDaysISO(input.lastCompletedISO, interval) : earliest;
  return fromLast >= earliest ? fromLast : earliest;
}
