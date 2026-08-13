/**
 * TIPPING THE CREW.
 *
 * Brendon: "its a tip, so its at the home owners discretion, but the
 * suggestion needs to be within reason and probably shouldn't be based on the
 * $$ amount."
 *
 * He is right, and the numbers are worse than an instinct. At 20% of the bill,
 * the implied tip PER HOUR OF WORK across our own seeded services runs from
 * $9.60 to $126.67 — a thirteenfold spread for the same kind of careful work:
 *
 *   Housekeeping, 4,200 sq ft   2h 30m   $24 at 20%    $9.60/hour
 *   Boat winterize, 19 ft       1h 30m   $190 at 20%   $126.67/hour
 *
 * The cleaner works two and a half hours for twenty-four dollars; the boat
 * crew works ninety minutes for a hundred and ninety. A percentage is nearly
 * RANDOM with respect to effort here, and it is random in a way that always
 * favours whoever touched the most expensive object.
 *
 * WHY THE BILL IS THE WRONG BASIS, specifically for this business:
 *
 *   IT SCALES WITH THE ASSET, NOT THE SERVICE. Boat work prices per foot. A
 *   thirty-footer bills 58% more than a nineteen — the crew does not take 58%
 *   more care. The tip would track how big your boat is, which is a proxy for
 *   your wealth, not for anybody's effort.
 *
 *   NOBODY WAS THERE. The product promise is that we handle it while you are
 *   three hours away; the homeowner judges the work from PHOTOS. Restaurant
 *   percentages encode "you attended my table for ninety minutes". There is no
 *   analogue when the two people never met.
 *
 *   SEASONAL BILLS ARE LUMPY. A fall package runs past $1,500. A percentage
 *   prompt on that is a $300 ask, which reads as a second invoice — so people
 *   tip NOTHING, and the crew ends up worse off than a modest flat suggestion
 *   they would have accepted without thinking about it.
 *
 *   IT IS PARTLY A PERCENTAGE OF OUR OWN MARGIN. The all-in price carries
 *   LakeLife's 30%. A crew's tip should not grow because our markup did.
 *
 * SO IT IS ANCHORED TO TIME ON SITE, which 0083 finally made real. Duration
 * is what a tip is actually about — somebody's afternoon — and it is the one
 * axis that moves with effort without moving with the invoice.
 *
 * AND IT IS A SUGGESTION, NOT A DEFAULT. Nothing is pre-selected, declining
 * takes one tap and says nothing disapproving, and the amounts stay small
 * enough to be an easy yes. A tip prompt that shames people is a tip prompt
 * that costs you customers to buy the crew twenty dollars.
 */

/** One band of the ladder: visits up to `maxMinutes` get these options. */
export interface TipBand {
  maxMinutes: number | null;
  options: number[];
}

export interface TipDials {
  bands: TipBand[];
  /** Nobody may type a tip larger than this. Protects against a fat finger. */
  maxCustom: number;
  /**
   * How long after the visit a thank-you may still be added.
   *
   * Everyone who does this has a window — Uber's runs about a month, Lyft's a
   * few days — and we had NONE: `canTip` would have accepted a tip on a job
   * from any date, forever. Three reasons that is wrong, and none of them are
   * about the customer:
   *
   *   The card on file goes stale. A tip charged against a card replaced in
   *   the meantime declines, and the crew never learns there was one.
   *
   *   The crew may have moved on. 0091 pays the tip to the vendor on the job;
   *   eight months later that may be somebody who no longer works these lakes.
   *
   *   The payout lands in a batch unrelated to the work. A crew's month-end
   *   statement should be recognisable as the month they worked.
   *
   * Thirty days rather than Uber-tight, because our customer is often three
   * hours away and judges the work from photos — somebody who checks in
   * fortnightly must still get the chance.
   */
  windowDays: number;
}

/**
 * Deliberately modest. These are meant to be an easy yes on a phone, not a
 * negotiation — and the ladder is short so the middle option is an obvious
 * "normal", which is the only thing a suggestion is really for.
 */
export const DEFAULT_TIP_DIALS: TipDials = {
  bands: [
    { maxMinutes: 60,   options: [5, 10, 20] },
    { maxMinutes: 180,  options: [10, 20, 35] },
    { maxMinutes: null, options: [20, 35, 50] },
  ],
  maxCustom: 200,
  windowDays: 30,
};

/**
 * Whole days between two ISO dates (`b - a`), read at NOON.
 *
 * Noon, not midnight, because `new Date("2026-08-12")` is UTC midnight — which
 * in Indiana is the evening of the 11th, and a window computed from it is off
 * by one for every customer in the state. Both ends are anchored the same way
 * so the difference is exact whatever the offset.
 */
export function daysBetweenISO(a: string, b: string): number | null {
  const ms = Date.parse(`${a}T12:00:00Z`);
  const ns = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(ms) || !Number.isFinite(ns)) return null;
  return Math.round((ns - ms) / 86_400_000);
}

/**
 * Days left to add a thank-you. Null when we cannot tell, negative once shut.
 */
export function tipDaysLeft(
  jobDateISO: string | null | undefined,
  todayISO: string,
  dials: TipDials = DEFAULT_TIP_DIALS,
): number | null {
  if (!jobDateISO) return null;
  const elapsed = daysBetweenISO(jobDateISO, todayISO);
  if (elapsed == null) return null;
  return dials.windowDays - elapsed;
}

export interface TipSuggestion {
  options: number[];
  /** The one rendered as the middle/likely choice. Never PRE-SELECTED. */
  typical: number;
  maxCustom: number;
  /** Why these numbers and not others, in the customer's language. */
  basis: string;
}

/**
 * What to offer, from how long the crew was there.
 *
 * An unknown duration takes the SMALLEST band, which is the opposite of how
 * `serviceMinutes` treats an unknown size — and deliberately so. There, an
 * unknown books the longest slot because the cost of under-booking lands on
 * the crew's evening. Here, an unknown suggests the smallest amount because
 * the cost of over-suggesting lands on the customer as a too-big ask. Both
 * rules point the same way: the party who did not cause the uncertainty
 * should not pay for it.
 */
export function suggestTip(
  estMinutes: number | null | undefined,
  dials: TipDials = DEFAULT_TIP_DIALS,
): TipSuggestion {
  const bands = dials.bands.length ? dials.bands : DEFAULT_TIP_DIALS.bands;
  const mins = Number(estMinutes);
  const usable = Number.isFinite(mins) && mins > 0 ? mins : 0;

  let band = bands[0];
  if (usable > 0) {
    band = bands.find((b) => b.maxMinutes == null || usable <= b.maxMinutes) ?? bands[bands.length - 1];
  }

  const options = [...band.options].filter((n) => n > 0).sort((a, b) => a - b);
  const safe = options.length ? options : DEFAULT_TIP_DIALS.bands[0].options;

  return {
    options: safe,
    typical: safe[Math.floor(safe.length / 2)],
    maxCustom: dials.maxCustom > 0 ? dials.maxCustom : DEFAULT_TIP_DIALS.maxCustom,
    basis: basisFor(usable),
  };
}

function basisFor(minutes: number): string {
  if (minutes <= 0) return "A thank-you for the visit — entirely up to you.";
  const h = minutes / 60;
  const spent =
    minutes < 60 ? `about ${Math.round(minutes)} minutes`
    : Math.abs(h - Math.round(h)) < 0.1 ? `about ${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`
    : `about ${h.toFixed(1).replace(/\.0$/, "")} hours`;
  return `They were at your place ${spent}. Entirely up to you — the price you paid already covers the work.`;
}

/**
 * Validate what the customer actually chose.
 *
 * Zero is a first-class answer, not a failure. It is the most common one and
 * the screen should never make it feel like an error.
 */
export function validateTip(
  raw: string | number | null | undefined,
  dials: TipDials = DEFAULT_TIP_DIALS,
): { ok: boolean; amount: number; error?: string } {
  if (raw == null || raw === "") return { ok: true, amount: 0 };
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return { ok: false, amount: 0, error: "That isn't an amount." };
  if (n === 0) return { ok: true, amount: 0 };

  const cap = dials.maxCustom > 0 ? dials.maxCustom : DEFAULT_TIP_DIALS.maxCustom;
  if (n > cap) {
    return {
      ok: false,
      amount: 0,
      error: `That's more than $${cap} — give us a call if you really mean it.`,
    };
  }
  return { ok: true, amount: Math.round(n * 100) / 100 };
}

/**
 * EVERY CENT GOES TO THE CREW.
 *
 * Stated as a function so it is a rule with a name rather than a convention
 * somebody has to remember, and so the one place that would ever change it is
 * findable. LakeLife's 30% is on the WORK. Taking a cut of a thank-you is the
 * kind of thing crews find out about and never forgive.
 */
export function tipSplit(amount: number): { toCrew: number; toLakeLife: number } {
  return { toCrew: Math.max(0, Math.round(amount * 100) / 100), toLakeLife: 0 };
}

/**
 * May this visit be tipped at all?
 *
 * Only completed work, and only once. A tip offered before the job is done
 * would quietly turn into a bid for better service — which is exactly the
 * thing that makes tipping corrosive, and the reason a crew must never see a
 * tip (or its absence) until after they have finished.
 */
export function canTip(
  job: {
    status: string;
    tip_amount?: number | null;
    no_show_at?: string | null;
    stood_down_at?: string | null;
    /** The visit's own date — the clock the window runs on. */
    date?: string | null;
  },
  todayISO?: string,
  dials: TipDials = DEFAULT_TIP_DIALS,
): { ok: boolean; why?: string } {
  if (job.no_show_at || job.stood_down_at) {
    return { ok: false, why: "No work happened on that visit." };
  }
  if (job.status !== "complete" && job.status !== "paid") {
    return { ok: false, why: "You can add a thank-you once the work is done." };
  }
  // ZERO IS AN ANSWER, AND IT IS FINAL. `> 0` let a declined tip fall through
  // as still-tippable: the button came back, a second tap passed every gate,
  // and the `.is("tip_amount", null)` write matched nothing — so the action
  // reported success while changing nothing and charging nothing. Asked and
  // answered is answered, whichever way.
  if (job.tip_amount != null) {
    return {
      ok: false,
      why: job.tip_amount > 0
        ? "You've already sent them one — thank you."
        : "You've already answered this one.",
    };
  }
  // THE WINDOW, CHECKED LAST — so somebody who already tipped is told that,
  // rather than being told they are too late for a thing they already did.
  //
  // An unknown date does NOT close it. We would be shutting the door on the
  // strength of our own missing data, and the same rule runs through this
  // file: whoever did not cause the uncertainty should not pay for it.
  if (todayISO) {
    const left = tipDaysLeft(job.date, todayISO, dials);
    if (left != null && left < 0) {
      return {
        ok: false,
        why: `That visit was over ${dials.windowDays} days ago — give us a call if you'd still like to send the crew something.`,
      };
    }
  }
  return { ok: true };
}
