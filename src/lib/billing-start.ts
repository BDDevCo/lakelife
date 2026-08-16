/**
 * WHERE OUR LEDGER BEGINS.
 *
 * A park arrives on LakeLife with a history that is not ours. Somebody was
 * collecting rent before us — a seller, or the same owner on a paper ledger —
 * and the day we go live does not erase what they already took.
 *
 * THE CASE THIS EXISTS FOR. A park changes hands on the 15th. The seller
 * collected the whole month on the 1st, and the buyer is made whole for the
 * back half at the closing table, in one number, between the two of them. The
 * RESIDENT is not part of that transaction: they paid their month, they owe
 * nobody anything for it. If our roll then prorates from the day each
 * household is filed, the new owner's first screen reads "$2,834 owed this
 * month" for rent that is already in the seller's account — and the button
 * next to it raises nineteen real bills for it.
 *
 * THE RULE, AND IT IS ONE COMPARISON: a period is ours only if it BEGINS on or
 * after the park's go-live date.
 *
 *   go live Dec 15 → December began on the 1st, before us → not ours.
 *                    January begins after → ours. First bill is January.
 *   go live Dec 1  → December begins the day we start → ours.
 *
 * So the part-month at the start is never billed by us. That is deliberate: it
 * is the one period where what the resident owes depends on a settlement we
 * cannot see, and a park that genuinely needs to collect it can say so by
 * setting go-live to the first of that month — which is exactly the claim
 * "this whole month is mine to bill".
 *
 * NULL MEANS NO RESTRICTION, not "block everything". Plenty of parks join with
 * no handover at all and no meaningful start date; refusing to bill them would
 * be a worse failure than the one this prevents.
 */

/** The first period LakeLife may bill, as `YYYY-MM`. Null when unrestricted. */
export function firstBillablePeriod(cutoverDate: string | null | undefined): string | null {
  const cut = (cutoverDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cut)) return null;

  const month = cut.slice(0, 7);
  // Go-live on the 1st means that month is wholly ours; any later day means
  // the month began before us and belongs to whoever was collecting then.
  if (cut.endsWith("-01")) return month;

  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return m === 12
    ? `${y + 1}-01`
    : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** May we bill this period at all? */
export function periodIsBillable(
  month: string,
  cutoverDate: string | null | undefined,
): boolean {
  const first = firstBillablePeriod(cutoverDate);
  if (first == null) return true;
  return month >= first;   // both are YYYY-MM, so string order is date order
}

/**
 * Why not, in words the owner can act on — or null when it is billable.
 *
 * Names the date they set and the month we start, because the fix is either
 * "that's right, wait" or "my go-live date is wrong", and the sentence has to
 * be enough to tell which.
 */
export function preCutoverRefusal(
  month: string,
  cutoverDate: string | null | undefined,
  prettyMonth: (period: string) => string,
): string | null {
  if (periodIsBillable(month, cutoverDate)) return null;
  const first = firstBillablePeriod(cutoverDate)!;
  return (
    `${prettyMonth(month)} started before you went live on ${prettyDay(cutoverDate!)}, ` +
    `so it isn't ours to bill — whoever was collecting rent then keeps that ` +
    `month. LakeLife starts with ${prettyMonth(first)}.`
  );
}

/**
 * A date a person reads, never "2026-12-15".
 *
 * The same rule the months already follow. This sentence is shown to an owner
 * at the moment he is confused about why a button did nothing, which is the
 * worst possible moment to make him parse a database format.
 */
function prettyDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}
