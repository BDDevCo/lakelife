/**
 * EVERY MONTH A HELD ROW SHOULD HAVE A BILL FOR, AND DOESN'T.
 *
 * The nightly read used to ask ONE question — "does this lot have a charge
 * for the current month?" — which was the right question for as long as
 * every row began in the past and the run visited every month in order. It
 * stopped being the right question the day a successor could be written from
 * a lapsed agreement's own end (decision 3): that row starts in February,
 * it is written in March, and the run keys "already billed" per reservation
 * and visits a month once. Nothing would ever raise its February. And the
 * one-month question answered "yes, March is billed" about that lot every
 * night, forever.
 *
 * So this asks the wider question, per RESERVATION (the run's own key, 0081):
 * which months does this row cover, from the first month LakeLife may bill,
 * up to and including the current one, that have no live charge on THIS
 * row? The prior's February bill never covers the successor's February —
 * they are different rows, and the ledger keys them apart on purpose.
 *
 * Pure. Reads nothing; the caller (park-machine, or Today if it ever wants
 * the same fact) hands it rows and a map of what is billed.
 */

import { daysCovered } from "./statement-helpers";
import { currentPeriod, shiftMonth } from "./ledger-helpers";
import { firstBillablePeriod } from "@/lib/billing-start";
import type { DateRange } from "@/lib/parks";

const PERIOD = /^\d{4}-\d{2}$/;

/**
 * Every YYYY-MM in [fromMonth, toMonth] the range actually covers.
 *
 * Half-open, like the database and `daysCovered`: a row ending on the 1st
 * was not there in that month at all, so a row [2027-01-01, 2027-02-01)
 * covers January only. Anything that is not a well-formed period comes back
 * as no months — `shiftMonth` returns a malformed period unchanged, and a
 * loop stepping on it would never end.
 */
export function monthsCovered(range: DateRange, fromMonth: string, toMonth: string): string[] {
  if (!PERIOD.test(fromMonth) || !PERIOD.test(toMonth)) return [];
  const out: string[] = [];
  for (let m = fromMonth; m <= toMonth; m = shiftMonth(m, 1)) {
    if (daysCovered(range, m) > 0) out.push(m);
  }
  return out;
}

export interface HeldRowForMonths {
  reservationId: string;
  lotId: string;
  /** The agreement window, half-open. Null when it could not be read — contributes nothing. */
  range: DateRange | null;
  /**
   * How the tenancy is paid. THE RUN BILLS MONTHS ONLY (ledger-helpers
   * `classifyForRun`, "notMonthly"): a row filed as paid yearly, or by the
   * night, is one the run refuses with its own sentence, so a month it has
   * no bill for is not a month anybody could bill from the rent screen — and
   * naming it here would instruct exactly that, every night, forever. Absent
   * reads as monthly, the same way the run reads it.
   */
  term?: string | null;
}

/**
 * Per lot: every month with no bill, sorted, deduplicated — the current month
 * included. Every lot that appears in `rows` has an entry; an empty array
 * means every month it should have a bill for has one.
 *
 *   `billed` is reservation id → the months with a LIVE charge on that row
 *     (void excluded — a cancelled bill leaves the month billable, which is
 *     what the run's own "already billed" set says too).
 *   The floor is the first billable period from the park's go-live day —
 *     a month before go-live was somebody else's to collect and is never
 *     called unbilled. No go-live means no floor, the ledger's own reading.
 *   The cap is the current month: a month that has not started has nothing
 *     to bill.
 */
export function unbilledMonthsFor(
  rows: readonly HeldRowForMonths[],
  billed: ReadonlyMap<string, ReadonlySet<string>>,
  opts: { today: string; cutoverDate: string | null },
): Map<string, string[]> {
  const floor = firstBillablePeriod(opts.cutoverDate) ?? "0000-01";
  const to = currentPeriod(opts.today);
  const none: ReadonlySet<string> = new Set();

  const perLot = new Map<string, Set<string>>();
  for (const row of rows) {
    const lot = perLot.get(row.lotId) ?? new Set<string>();
    perLot.set(row.lotId, lot);
    if (!row.range) continue;
    if (row.term != null && row.term !== "monthly") continue;
    const startMonth = row.range.start.slice(0, 7);
    const from = startMonth > floor ? startMonth : floor;
    const have = billed.get(row.reservationId) ?? none;
    for (const m of monthsCovered(row.range, from, to)) {
      if (!have.has(m)) lot.add(m);
    }
  }

  const out = new Map<string, string[]>();
  for (const [lotId, months] of perLot) out.set(lotId, [...months].sort());
  return out;
}
