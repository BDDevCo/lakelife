/**
 * THE CREW IS IN THE DRIVEWAY.
 *
 * They pulled in at 7:40, walked the pier, and counted twelve sections where
 * the profile says eight. Or the lawn is clearly not the "medium" somebody
 * ticked eighteen months ago. Or nobody is answering the door on a
 * housekeeping visit.
 *
 * Rule 6 already said a correction changes nothing and bills nothing until the
 * homeowner approves. What was missing is that nothing STOPPED: a crew could
 * flag twelve sections and complete the job in the same visit, so the owner
 * was billed for eight, the crew was paid for eight, and the approval landed
 * afterwards with nothing left to decide. The crew who told us the truth was
 * the only party who lost by it.
 *
 * TWO RULES DECIDE EVERYTHING HERE, AND BOTH ARE THE OWNER'S:
 *
 *   1. THE CREW STATES FACTS, THE SYSTEM STATES THE PRICE. He asked that the
 *      crew "give added pricing"; rule 1 forbids a vendor from ever seeing a
 *      customer price or margin. Both hold at once if the crew sends the
 *      COUNT — twelve, not eight — and the pricing engine turns it into money
 *      for the homeowner's eyes only. It is also simply better: the crew
 *      cannot mis-quote, and the same pier costs the same on every lake.
 *
 *   2. NOBODY ANSWERS -> IT DEPENDS WHETHER THEY NEED TO GET INSIDE.
 *      "If the crew doesnt need to get into the house then do the work or it
 *      becomes a no show, reschedule if both parties agree or they get
 *      charged." Outside work proceeds at the scope booked. Inside work with
 *      no access is a no-show — not a completion, not a cancellation, its own
 *      fact. That turns a judgement a tired crew makes at 7:40am into
 *      something the service already knows about itself.
 */

import { priceService, type ServiceRule, type PricingProfile } from "./pricing";
import { serviceMinutes, type DurationBands } from "./duration";

export type TimedRule = ServiceRule & {
  est_minutes?: number | null;
  duration_bands?: DurationBands | null;
  needs_interior_access?: boolean | null;
};

/** The profile fields a crew is allowed to correct. Mirrors sanitizeProposed. */
export const CORRECTABLE = [
  "pier_sections", "boat_lifts", "pwc_lifts", "jet_skis", "toy_lifts", "lawn_band",
] as const;
export type CorrectableField = (typeof CORRECTABLE)[number];

/** What the homeowner reads, not what the column is called. */
export const FIELD_LABEL: Record<CorrectableField, string> = {
  pier_sections: "pier sections",
  boat_lifts: "boat lifts",
  pwc_lifts: "PWC lifts",
  jet_skis: "jet skis",
  toy_lifts: "toy lifts",
  lawn_band: "lawn size",
};

const LAWN_WORD: Record<string, string> = {
  small: "small (under ¼ acre)",
  medium: "medium (¼–½ acre)",
  large: "large (over ½ acre)",
};

function readable(field: CorrectableField, value: unknown): string {
  if (field === "lawn_band") return LAWN_WORD[String(value)] ?? String(value);
  return String(value);
}

export interface CorrectionLine {
  field: CorrectableField;
  label: string;
  from: string;
  to: string;
}

export interface CorrectionSummary {
  lines: CorrectionLine[];
  priceBefore: number;
  priceAfter: number;
  priceDelta: number;
  minutesBefore: number;
  minutesAfter: number;
  minutesDelta: number;
  /** Nothing actually changed — a crew confirming the profile is correct. */
  noChange: boolean;
}

/**
 * What the homeowner is being asked to approve, in both currencies that matter.
 *
 * THE TIME IS SHOWN, NOT JUST THE MONEY. Since 0083 a bigger job is also a
 * longer one, and a homeowner deciding at 7:45am on their phone should see
 * that saying yes means the crew is there another hour and a quarter — that
 * is often the part they actually care about.
 */
export function summariseCorrection(
  rule: TimedRule,
  before: PricingProfile,
  proposed: Partial<Record<CorrectableField, string | number>>,
): CorrectionSummary {
  const after = { ...before } as PricingProfile;
  const lines: CorrectionLine[] = [];

  for (const field of CORRECTABLE) {
    if (!(field in proposed)) continue;
    const next = proposed[field];
    if (next == null) continue;
    const current = (before as unknown as Record<string, unknown>)[field];
    if (String(current) === String(next)) continue;
    (after as unknown as Record<string, unknown>)[field] = next;
    lines.push({
      field,
      label: FIELD_LABEL[field],
      from: readable(field, current),
      to: readable(field, next),
    });
  }

  const priceBefore = priceService(rule, before);
  const priceAfter = priceService(rule, after);
  const minutesBefore = serviceMinutes(rule, before);
  const minutesAfter = serviceMinutes(rule, after);

  return {
    lines,
    priceBefore, priceAfter, priceDelta: priceAfter - priceBefore,
    minutesBefore, minutesAfter, minutesDelta: minutesAfter - minutesBefore,
    noChange: lines.length === 0,
  };
}

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "about an hour and a quarter longer" beats "+75 minutes" at 7:45am. */
export function humanDuration(minutes: number): string {
  const m = Math.abs(Math.round(minutes));
  if (m < 45) return `${m} minutes`;
  const hours = m / 60;
  if (Math.abs(hours - Math.round(hours)) < 0.09) {
    const h = Math.round(hours);
    return h === 1 ? "an hour" : `${h} hours`;
  }
  const whole = Math.floor(hours);
  const rest = m - whole * 60;
  const frac = rest < 23 ? "a quarter" : rest < 38 ? "a half" : "three quarters";
  if (whole === 0) return `${rest} minutes`;
  return `${whole === 1 ? "an hour" : `${whole} hours`} and ${frac}`;
}

/**
 * The sentence the homeowner gets on their phone.
 *
 * Deliberately leads with what the crew FOUND, not with the money. They are
 * being asked to confirm a fact about their own property; the price follows
 * from it. Leading with the number reads like an upsell from someone standing
 * in the driveway.
 */
export function correctionMessage(
  s: CorrectionSummary,
  opts: { serviceName: string; crewName?: string | null },
): string {
  if (s.noChange) return `${opts.serviceName}: nothing to change — the profile matches.`;

  const found = s.lines
    .map((l) => `${l.label} ${l.from} → ${l.to}`)
    .join(", ");

  const parts = [
    `${opts.crewName ? `${opts.crewName} is` : "Your crew is"} at your place for ${opts.serviceName} and found ${found}.`,
  ];

  if (s.priceDelta !== 0) {
    parts.push(
      `That makes it ${money(s.priceAfter)} instead of ${money(s.priceBefore)} — ` +
      `${s.priceDelta > 0 ? "up" : "down"} ${money(s.priceDelta)}.`,
    );
  } else {
    parts.push(`The price doesn't change.`);
  }

  if (s.minutesDelta !== 0) {
    parts.push(
      `They'll be there about ${humanDuration(s.minutesDelta)} ` +
      `${s.minutesDelta > 0 ? "longer" : "less"} than planned.`,
    );
  }

  parts.push(`They're waiting on your yes before they start.`);
  return parts.join(" ");
}

// ---------------------------------------------- nobody is answering ---------

export type NoAnswerOutcome = "proceed_as_booked" | "no_show";

/**
 * THE DRIVEWAY RULE, in one function.
 *
 * The crew cannot reach the homeowner. Whether that stops the visit depends on
 * one fact the service already carries: do they need to get inside?
 */
export function noAnswerOutcome(rule: Pick<TimedRule, "needs_interior_access">): NoAnswerOutcome {
  return rule.needs_interior_access ? "no_show" : "proceed_as_booked";
}

export function noAnswerExplainer(
  rule: Pick<TimedRule, "needs_interior_access">,
  serviceName: string,
): string {
  return noAnswerOutcome(rule) === "proceed_as_booked"
    ? `No answer is fine for ${serviceName} — do the work as booked and we'll bill the ` +
      `original amount. Anything you flagged goes to them separately.`
    : `${serviceName} needs to get inside. If you can't, record a no-show — don't ` +
      `mark it complete. We'll ask them to reschedule; if they'd rather not, the ` +
      `cancellation policy applies.`;
}

/**
 * May this visit be closed out?
 *
 * Mirrors 0084's trigger so a screen can grey the button and say why, rather
 * than letting a crew tap Complete and meet a database error. The DATABASE is
 * the real gate and stays the real gate.
 */
export function completionBlock(job: {
  held_at?: string | null;
  no_show_at?: string | null;
}): string | null {
  if (job.no_show_at) {
    return "This one is recorded as a no-show — it can't be completed. Ops will sort the reschedule.";
  }
  if (job.held_at) {
    return "Waiting on the owner to approve what you found. You'll get a text the moment they answer.";
  }
  return null;
}
