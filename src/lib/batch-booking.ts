/**
 * MULTI-DATE BOOKING — several committed visits, booked in one motion, with
 * no standing enrolment (owner, 2026-08-14: "lock in multiple schedules for
 * say house cleaning so I can book out a few weeks or months, but not go on
 * auto pilot").
 *
 * Between a one-off and Autopilot there was nothing. Autopilot proposes each
 * visit and waits for a text back; this is the opposite — the customer names
 * the days, every one is priced and committed NOW, and nothing repeats on its
 * own. Cancelling one Tuesday leaves the other five standing.
 *
 * PARTIAL SUCCESS IS THE NORMAL CASE, not an error. Six dates are six separate
 * capacity questions, so the rule is: book what can be booked and NAME every
 * day that could not. A silently dropped visit is a house someone believes is
 * being cleaned.
 *
 * Pure — no clock, no I/O. `today`, the lake's season and the full days are
 * handed in by the caller, exactly as the single-date path does it.
 */

import { dayStatus, isRealDate, type DayContext, type DayStatus } from "./booking";

/**
 * How many visits one batch may commit. Weekly housekeeping across three
 * months is ~13, so this is a real limit and not a formality: it is said on
 * screen before the pick, and any date past it comes back as a NAMED refusal
 * rather than a silent truncation.
 */
export const MAX_BATCH_DATES = 12;

export interface PlannedDate {
  date: string;
  ok: boolean;
  /** Same-day: priced at the rush premium, claim-board only (never dispatched). */
  isRush: boolean;
  /** Present exactly when !ok — the sentence the customer reads. */
  reason?: string;
}

/**
 * Why the calendar cannot sell a day, in the customer's words — null when it
 * can. Single-date and multi-date bookings share this so the two can never
 * drift into telling the same person two different stories about one day.
 */
export function refusalFor(status: DayStatus): string | null {
  switch (status) {
    case "available":
    case "rush":
      return null;
    case "past":
      return "That date has passed.";
    case "off-season":
      return "That date is outside this lake's water-work season.";
    case "full":
      return "That day's crew is full — pick another.";
  }
}

export interface NormalizedDates {
  /** Real, unique, ascending, within the cap — the days worth pricing. */
  dates: string[];
  /** Garbage and over-the-cap days, each already carrying its refusal. */
  refused: PlannedDate[];
}

/**
 * Clean the list the browser sent. The same day twice is ONE visit (dedupe, no
 * refusal); a string that isn't a date and anything past the cap come back
 * named, because the whole promise of this feature is that nothing vanishes.
 */
export function normalizeBatchDates(raw: readonly string[] | null | undefined): NormalizedDates {
  const refused: PlannedDate[] = [];
  const seen = new Set<string>();
  const good: string[] = [];
  for (const entry of raw ?? []) {
    const iso = typeof entry === "string" ? entry.trim() : "";
    if (!isRealDate(iso)) {
      refused.push({ date: iso || String(entry ?? ""), ok: false, isRush: false, reason: "That isn't a real date." });
      continue;
    }
    if (seen.has(iso)) continue; // picking a day twice is one visit, not a problem
    seen.add(iso);
    good.push(iso);
  }
  good.sort();
  for (const over of good.slice(MAX_BATCH_DATES)) {
    refused.push({
      date: over,
      ok: false,
      isRush: false,
      reason: `Only ${MAX_BATCH_DATES} visits can be locked in at once — book this one next.`,
    });
  }
  return { dates: good.slice(0, MAX_BATCH_DATES), refused };
}

/**
 * Classify EVERY date against the same gate the single-date confirm uses:
 * this property's lake season, the same-day cutoff, and that day's crew
 * capacity. Each date is judged on its own — a batch is never waved through
 * on the strength of its first day.
 */
export function planBatchDates(dates: readonly string[], ctx: DayContext): PlannedDate[] {
  return dates.map((date) => {
    const status = dayStatus(date, ctx);
    const reason = refusalFor(status);
    return reason
      ? { date, ok: false, isRush: false, reason }
      : { date, ok: true, isRush: status === "rush" };
  });
}

/** "Jun 3" — the short form a list of dates can actually be read in. A string
 *  that isn't a date comes back as itself: a refusal that names "Invalid Date"
 *  names nothing. */
export function shortDay(iso: string): string {
  if (!isRealDate(iso)) return iso;
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Jun 3", "Jun 3 and Jun 10", "Jun 3, Jun 10 and Jun 17" — capped for SMS. */
export function prettyDateList(dates: readonly string[], max = Number.POSITIVE_INFINITY): string {
  const shown = dates.slice(0, max).map(shortDay);
  const hidden = dates.length - shown.length;
  if (hidden > 0) return `${shown.join(", ")} and ${hidden} more`;
  if (shown.length === 0) return "";
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/**
 * One line per REASON, not per date — six days refused for the same reason is
 * one sentence, not six. Dates stay in the order they were planned.
 */
export function refusalLines(refused: readonly PlannedDate[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const r of refused) {
    const reason = r.reason ?? "That day couldn't be booked.";
    byReason.set(reason, [...(byReason.get(reason) ?? []), r.date]);
  }
  return [...byReason].map(([reason, dates]) => `${prettyDateList(dates)}: ${reason}`);
}

export interface BatchOutcomeCopy {
  headline: string;
  /** The named refusals — always present when anything was refused. */
  lines: string[];
}

/**
 * What the customer is told after a batch. Never "done" when it was partly
 * done: the headline carries the arithmetic (4 of 6) and the lines carry the
 * two that didn't land.
 */
export function batchOutcomeCopy(
  serviceName: string,
  booked: readonly string[],
  refused: readonly PlannedDate[],
): BatchOutcomeCopy {
  const lines = refusalLines(refused);
  const total = booked.length + refused.length;
  if (booked.length === 0) {
    return { headline: `None of those days could be booked for ${serviceName}.`, lines };
  }
  const visits = `${booked.length} ${serviceName} visit${booked.length === 1 ? "" : "s"}`;
  if (refused.length === 0) {
    return { headline: `${visits} booked — see “My requests.”`, lines };
  }
  return { headline: `${booked.length} of ${total} ${serviceName} visits booked.`, lines };
}
