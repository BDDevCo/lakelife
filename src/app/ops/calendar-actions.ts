"use server";

import { getOpsCalendar, type CalRow } from "./calendar-data";

/** Server action backing client-side year navigation on the ops calendar. */
export async function loadOpsCalendarYear(year: number): Promise<CalRow[]> {
  const y = Math.floor(Number(year));
  if (!Number.isFinite(y) || y < 2024 || y > 2035) return [];
  return getOpsCalendar(y);
}
