/**
 * THE PERIOD A COST COVERED, IN WORDS — "for February 2027", "for 2027".
 *
 * A resident's bill line used to read "Sewer — your share · for 2027-02-01
 * to 2027-03-01" beside "Lot rent · for the month" and "27 of 31 days".
 * Worse, the basis is FROZEN into park_charges.lines the moment the run
 * raises the bill, so nothing can edit it out afterwards — it had to be
 * right before the first run, and the first run is 1 January 2027. A
 * whole-year cost was the worst of it: the property-tax share read "for
 * 2027-01-01 to 2028-01-01".
 *
 * The owner settled months-in-words for anything a person reads. The house
 * already words exactly these periods in `billPeriod`'s covered labels
 * (cost-helpers) — "for February 2027", "for January 2027 to March 2027",
 * "for 2027" — but those are keyed on a schedule and carry a trailing "(bill
 * due 5 November)", so they cannot be imported onto a bill line. This is the
 * same wording as a pure function of the two dates, and it is the ONE copy:
 * the resident's bill line (charge-edits' unbilledCostShares) and the
 * owner's costs table both read it, so the two doors cannot drift.
 *
 * ENDS ARE EXCLUSIVE where the product generates them — `billPeriod` emits
 * `to: 1 March` for February — so [the 1st, the 1st of a later month) is
 * named by the months it covers, never by the end date. The cost form is two
 * free date inputs with no prefill, validated only as `end > start`, so an
 * owner who types 28 February gets the days in words and NEVER a claim of a
 * whole month he did not enter.
 */

import { prettyMonth } from "@/app/park/ledger-helpers";
import { dayInWords } from "@/app/park/park-helpers";

/** YYYY-MM-DD → its parts, or null when it is not a date at all. */
function parts(iso: string): { y: number; m: number; d: number } | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/**
 * "for February 2027" · "for January 2027 to March 2027" · "for 2027" ·
 * "for February 1, 2027 to February 28, 2027" · "as allocated".
 *
 * `end` is the day AFTER the period when it falls on the 1st, which is how
 * every period this product generates is shaped. Either date missing — or
 * either unreadable — is "as allocated", the same words the bill line has
 * always used when a cost carried no period at all.
 */
export function costPeriodInWords(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return "as allocated";
  const a = parts(String(start));
  const b = parts(String(end));
  if (!a || !b) return "as allocated";

  // WHOLE MONTHS, named by the months they cover. Both ends on the 1st is
  // the shape billPeriod emits for every cadence.
  const months = (b.y - a.y) * 12 + (b.m - a.m);
  if (a.d === 1 && b.d === 1 && months >= 1) {
    const from = `${a.y}-${String(a.m).padStart(2, "0")}`;
    if (months === 1) return `for ${prettyMonth(from)}`;
    // A calendar year, said as the year — the property-tax share's shape.
    // Twelve months from any other start is still named by its months:
    // March 2027 to February 2028 is not "2027".
    if (months === 12 && a.m === 1) return `for ${a.y}`;
    const lastMonth = b.m === 1 ? { y: b.y - 1, m: 12 } : { y: b.y, m: b.m - 1 };
    const to = `${lastMonth.y}-${String(lastMonth.m).padStart(2, "0")}`;
    return `for ${prettyMonth(from)} to ${prettyMonth(to)}`;
  }

  // ANYTHING THE OWNER TYPED BY HAND. In words, like every other date a
  // person reads, and stated as the two days he entered — this function does
  // not know whether he meant the end day to be included, and a guessed
  // "to 27 February" on a frozen bill line would be a claim nobody made.
  return `for ${dayInWords(String(start))} to ${dayInWords(String(end))}`;
}
