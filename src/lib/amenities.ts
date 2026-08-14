import {
  nightsIn, overlaps, parkOpenFor, effectiveSeason,
  type DateRange, type ParkSeason,
} from "@/lib/parks";

/**
 * WHAT THE PARK OWNS AND SOMEBODY CAN HAVE FOR A WHILE.
 *
 * Pure. No I/O, no database, no clock of its own — every date arrives as a
 * caller-supplied ISO string so the lake-time question is answered once, at the
 * edge, by `todayLakeDate()`.
 *
 * THE FENCE: if a crew gets paid for it, it is not an amenity. Mowing is a
 * LakeLife service with a vendor, a photo gate and a margin. Renting the
 * pontoon is the park renting its own boat, and the money is the park's.
 */

export type AmenityKind = "boat" | "watercraft" | "vehicle" | "space" | "other";
export type ChargeModel = "included" | "per_day";
export type WhoMayBook = "guests" | "residents" | "both";

export interface Amenity {
  id: string;
  name: string;
  kind: AmenityKind;
  chargeModel: ChargeModel;
  /** Null exactly when chargeModel is 'included'. Never 0 standing in for free. */
  dayRate: number | null;
  whoMayBook: WhoMayBook;
  maxDays: number | null;
  season: ParkSeason;
  rules: string | null;
  active: boolean;
}

export interface AmenityUnit {
  id: string;
  amenityId: string;
  label: string;
  active: boolean;
}

/** A window somebody already holds — a booking or the park's own blackout. */
export interface HeldWindow {
  unitId: string;
  during: DateRange;
}

/**
 * WHAT A DAY COSTS, or null when we cannot say.
 *
 * Null rather than 0, which is the lesson 0115 taught the hard way: a zero
 * price is indistinguishable from "does not apply", and every screen that
 * treats them the same eventually shows a confident wrong number. `included`
 * is a real, priced answer — it costs nothing — and is returned as 0. A
 * `per_day` amenity with no rate is a broken row and returns null.
 */
export function quoteAmenity(a: Amenity, days: number): number | null {
  if (!(days > 0)) return null;
  if (a.chargeModel === "included") return 0;
  if (a.dayRate == null || !(a.dayRate > 0)) return null;
  return Math.round(a.dayRate * days * 100) / 100;
}

/** "Included with your stay" / "$150 a day" — never "$0.00 a day". */
export function priceLine(a: Amenity): string {
  if (a.chargeModel === "included") return "Included with your stay";
  if (a.dayRate == null) return "No price set yet";
  return `$${a.dayRate.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a day`;
}

/** Every whole day in a half-open window, as ISO dates. */
export function daysIn(r: DateRange): string[] {
  const out: string[] = [];
  const n = nightsIn(r);
  const start = Date.parse(`${r.start}T00:00:00Z`);
  for (let i = 0; i < n; i += 1) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** One day as a half-open window — the shape everything else here speaks. */
export function dayWindow(iso: string): DateRange {
  return { start: iso, end: new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) };
}

export type DayState =
  | { day: string; open: true }
  | { day: string; open: false; why: string };

/**
 * WHICH DAYS OF THIS STAY THIS PERSON CAN ACTUALLY HAVE — and, for the rest, a
 * sentence saying why not.
 *
 * A greyed-out square with no explanation is the thing that makes somebody ring
 * the office, which is the whole cost this feature exists to remove. So every
 * refusal carries its own words, in the voice `fitProblemText` established.
 *
 * The database is still the referee: this decides what to OFFER, and the
 * exclusion constraint decides what is actually taken. The two can disagree for
 * the length of one tap, and when they do the constraint wins.
 */
export function offerDays(opts: {
  amenity: Amenity;
  unit: AmenityUnit;
  /** The guest's stay. Only days inside it are ever offered. */
  stay: DateRange;
  /** Bookings and blackouts already on THIS unit. */
  held: readonly HeldWindow[];
  /** Lake-time today, from the caller. Past days are never offered. */
  today: string;
  /** The park's season, for the fallback when the amenity sets none. */
  parkSeason: ParkSeason | null;
  /** Short-stay guest or a resident — decides eligibility. */
  isShortStay: boolean;
}): DayState[] {
  const { amenity, unit, stay, held, today, parkSeason, isShortStay } = opts;

  // WHOLE-AMENITY REFUSALS come first and answer for every day at once. Saying
  // "someone has it" for a boat that is out of the water would be a lie about
  // the wrong thing.
  const blanket =
    !amenity.active ? "This one isn't open for booking at the moment."
    : !unit.active ? "This one is out of service."
    : amenity.whoMayBook === "guests" && !isShortStay
      ? "This one is for short-stay guests."
    : amenity.whoMayBook === "residents" && isShortStay
      ? "This one is for residents."
    : null;

  const season = effectiveSeason(amenity.season, parkSeason ?? undefined);
  const mine = held.filter((h) => h.unitId === unit.id);

  return daysIn(stay).map((day): DayState => {
    if (blanket) return { day, open: false, why: blanket };
    if (day < today) return { day, open: false, why: "That day has passed." };

    const w = dayWindow(day);
    if (!parkOpenFor(season, w)) {
      return { day, open: false, why: "It's out of the water then." };
    }
    if (mine.some((h) => overlaps(w, h.during))) {
      // Deliberately not "booked by Lot 7". Who has it is the park's business
      // and the next guest's curiosity, not their right.
      return { day, open: false, why: "Someone has it that day." };
    }
    return { day, open: true };
  });
}

/**
 * Can this run of days be taken as ONE booking?
 *
 * Separate from `offerDays` because a run has a rule a single day does not: the
 * park's cap on how long one party may hold the thing.
 */
export function canTakeRun(
  a: Amenity,
  days: readonly string[],
  states: readonly DayState[],
): { ok: true } | { ok: false; why: string } {
  if (days.length === 0) return { ok: false, why: "Pick a day first." };

  const byDay = new Map(states.map((s) => [s.day, s]));
  for (const d of days) {
    const s = byDay.get(d);
    if (!s) return { ok: false, why: "That day isn't part of your stay." };
    if (!s.open) return { ok: false, why: s.why };
  }

  if (a.maxDays != null && days.length > a.maxDays) {
    return {
      ok: false,
      why: `This park allows ${a.maxDays} ${a.maxDays === 1 ? "day" : "days"} at a time.`,
    };
  }

  // A run has to be contiguous — the exclusion constraint stores ONE window, so
  // Monday-and-Thursday is two bookings, not one with a hole in it.
  const sorted = [...days].sort();
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = Date.parse(`${sorted[i - 1]}T00:00:00Z`);
    if (Date.parse(`${sorted[i]}T00:00:00Z`) !== prev + 86_400_000) {
      return { ok: false, why: "Pick days that run together — book the others separately." };
    }
  }
  return { ok: true };
}

/** The half-open window a run of days becomes. */
export function runWindow(days: readonly string[]): DateRange | null {
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  return { start: sorted[0], end: dayWindow(sorted[sorted.length - 1]).end };
}

/**
 * WHAT THE OWNER SEES ABOUT TODAY. Counts and names, never a percentage —
 * at one boat and 21 lots a percentage is noise pretending to be signal.
 */
export function whoHasIt(
  units: readonly AmenityUnit[],
  held: readonly (HeldWindow & { who: string | null; status: string })[],
  day: string,
): { taken: Array<{ unit: string; who: string }>; free: string[] } {
  const w = dayWindow(day);
  const taken: Array<{ unit: string; who: string }> = [];
  const free: string[] = [];

  for (const u of units) {
    const hit = held.find(
      (h) => h.unitId === u.id && h.status !== "cancelled" && overlaps(w, h.during),
    );
    if (hit) {
      taken.push({ unit: u.label, who: hit.status === "blackout" ? "held back" : (hit.who ?? "a guest") });
    } else if (u.active) {
      free.push(u.label);
    }
  }
  return { taken, free };
}
