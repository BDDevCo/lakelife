/**
 * Cancellation policy (delight layer) — PURE, no I/O, fully unit-testable.
 *
 * The deal, in plain terms (dials live in platform_settings, rule 8):
 *  - A job nobody has claimed yet (`requested`) cancels free, always — no
 *    crew reserved the slot, nobody burned time.
 *  - A scheduled job cancels free OUTSIDE the notice window: 48h for routine
 *    work, 7 days for water work (piers/lifts/boats need real lead time).
 *  - INSIDE the window, a late fee (25% of the all-in price) applies — and
 *    the crew is paid the same share of THEIR rate, because they held the
 *    slot. LakeLife keeps the difference.
 *  - Day-of or in-progress: not self-serve — call us (unchanged behavior).
 */

export interface CancelDials {
  cancelFeePct: number; // e.g. 0.25
  cancelRoutineHours: number; // e.g. 48
  cancelWaterDays: number; // e.g. 7
}

export interface CancelQuote {
  allowed: boolean; // can the customer self-serve cancel at all?
  free: boolean; // no fee?
  feePct: number; // 0 when free
  fee: number; // dollars, rounded to cents
  crewShare: number; // what the crew is owed out of the fee (their rate share)
  reason: "not_cancellable" | "no_crew_reserved" | "outside_window" | "inside_window" | "zero_fee_dial";
}

/** Job-start hour by slot (lake wall-clock). Unknown/absent slot = 8am. */
const SLOT_HOUR: Record<string, number> = { "8a": 8, "10a": 10, "1p": 13, "3p": 15 };

/**
 * Hours from "now" until the job's start, computed entirely in lake wall-clock
 * space (both sides use the same clock, so no timezone drift). `nowMinutes` is
 * minutes past midnight, lake time.
 */
export function hoursUntilStart(jobDateISO: string, slot: string | null, nowDateISO: string, nowMinutes: number): number {
  const [jy, jm, jd] = jobDateISO.split("-").map(Number);
  const [ny, nm, nd] = nowDateISO.split("-").map(Number);
  const startMs = Date.UTC(jy, jm - 1, jd, SLOT_HOUR[slot ?? ""] ?? 8, 0);
  const nowMs = Date.UTC(ny, nm - 1, nd, 0, nowMinutes);
  return (startMs - nowMs) / 3_600_000;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function cancellationQuote(
  input: {
    status: string;
    hasCrew: boolean;
    isWaterWork: boolean;
    jobDateISO: string | null;
    slot: string | null;
    nowDateISO: string;
    nowMinutes: number;
    customerPrice: number;
    vendorCost: number | null;
  },
  dials: CancelDials,
): CancelQuote {
  const none = { feePct: 0, fee: 0, crewShare: 0 };

  // Self-serve cancel exists only for requested, or scheduled with the date
  // still ahead (same rule the old cancel had: day-of = call us).
  const futureDate = !!input.jobDateISO && input.jobDateISO > input.nowDateISO;
  if (input.status === "requested") {
    return { allowed: true, free: true, reason: "no_crew_reserved", ...none };
  }
  if (input.status !== "scheduled" || !futureDate) {
    return { allowed: false, free: false, reason: "not_cancellable", ...none };
  }
  if (!input.hasCrew) {
    // Scheduled-but-unassigned shouldn't exist, but never charge for it.
    return { allowed: true, free: true, reason: "no_crew_reserved", ...none };
  }

  const windowHours = input.isWaterWork ? dials.cancelWaterDays * 24 : dials.cancelRoutineHours;
  const hoursOut = hoursUntilStart(input.jobDateISO as string, input.slot, input.nowDateISO, input.nowMinutes);
  if (hoursOut >= windowHours) {
    return { allowed: true, free: true, reason: "outside_window", ...none };
  }
  if (!(dials.cancelFeePct > 0)) {
    return { allowed: true, free: true, reason: "zero_fee_dial", ...none };
  }
  return {
    allowed: true,
    free: false,
    feePct: dials.cancelFeePct,
    fee: cents(dials.cancelFeePct * Math.max(0, input.customerPrice)),
    crewShare: cents(dials.cancelFeePct * Math.max(0, input.vendorCost ?? 0)),
    reason: "inside_window",
  };
}
