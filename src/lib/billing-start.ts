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
 * THE SAME BOUNDARY, ON THE COST DOOR — or null when the bill is ours.
 *
 * A park_costs row is the other half of the ledger: it is split across the
 * lots, it lands on the residents' next bill, and it is what the CPA statement
 * and the "is my fee covering my costs" comparison are built from. The rent
 * run refused a month that began before go-live; the cost door did not, so
 * the seller's 2026 property tax — a credit at the closing table, never a
 * park_costs row — could be typed in from the reminder that told him to, and
 * its shares would have landed on nineteen January bills.
 *
 * `month` is the month the bill's period BEGINS (`period_start`), because
 * that is the comparison the rule is made of — and the sentence says so.
 * It used to open "That bill is for December 2026", which is true of a
 * monthly bill and false of a yearly one: the 2026 property tax runs
 * January to January and was described as a January bill. What is compared
 * is where the period STARTS, so that is what is named.
 *
 * The closing statement is named conditionally: most parks were never
 * bought, and the person reading this may be the one who was collecting
 * before. And it is "anything from before closing", not "this bill" — a
 * plough paid for between closing and go-live is on nobody's closing
 * statement; it is simply not ours to split.
 *
 * This refuses only the branches that reach a bill or the park's own books
 * (the split and park-carries). A bill a fee already covers is recorded as
 * evidence for the fee comparison at any date — `preCutoverEvidenceSignal`
 * — so WHAT AN EARLIER BILL CAN BE depends on whether a fee covers it, and
 * the sentence has to know. `coveredBy` is that fee's label, or null.
 *
 *   null  → the bill counts as nothing here: the fee-covered branch will not
 *           take it and the other two refuse. The sentence promises no
 *           evidence door, because there is none — snow at The Haven, tax
 *           anywhere. (It used to promise one on exactly these refusals.)
 *   label → it can still go in as evidence, and the sentence names EVERY
 *           press on the costs screen that gets it there, in order. Choosing
 *           "Split it across the lots" is a toggle that resets the preview;
 *           the next control he sees is "Show me the split", and only after
 *           it does the screen offer "Record it" — for a covered category
 *           the save behind that button records the bill under the fee and
 *           divides nothing. A sentence that named the toggle alone skipped
 *           one press, and the press it skipped is labelled as the opposite
 *           of what it does for this bill. Each of the three is pinned to a
 *           real button's own label in billing-start.test.ts.
 */
export function preCutoverCostRefusal(
  month: string,
  cutoverDate: string | null | undefined,
  prettyMonth: (period: string) => string,
  coveredBy: string | null,
): string | null {
  if (periodIsBillable(month, cutoverDate)) return null;
  const first = firstBillablePeriod(cutoverDate)!;
  return (
    `That bill's period starts in ${prettyMonth(month)}, before you went live on ` +
    `${prettyDay(cutoverDate!)} — so it isn't ours to split across the lots or to carry. ` +
    `If the park changed hands, anything from before closing belongs on the closing ` +
    `statement, not on the residents' bills. Your books here start with ` +
    `${prettyMonth(first)}.` +
    (coveredBy
      ? ` Because your "${coveredBy}" fee covers this, it can still go in as evidence ` +
        `for the fee comparison: choose "Split it across the lots", press "Show me the split", ` +
        `and it will offer "Record it".`
      : "")
  );
}

/**
 * THE ONE BRANCH THAT TAKES A BILL FROM BEFORE GO-LIVE — and says what it is.
 *
 * A bill a fee already covers is never split and never lands on anybody's
 * statement: its only reader is the "is my fee covering my costs" check,
 * which averages each category over the months it has rows for. A
 * typical-month figure from before go-live is exactly the evidence that
 * check is built from — The Haven's whole comparison rests on four June 2026
 * rows entered as annual-divided-by-twelve baselines. So the row goes in,
 * and the signal says it is evidence and not a bill, because the same words
 * on the same screen refuse the split a minute later.
 *
 * Null when the period is ours — the ordinary "Recorded" signal applies.
 */
export function preCutoverEvidenceSignal(
  month: string,
  cutoverDate: string | null | undefined,
  prettyMonth: (period: string) => string,
  feeLabel: string,
): string | null {
  if (periodIsBillable(month, cutoverDate)) return null;
  return (
    `Recorded as evidence only — its period starts in ${prettyMonth(month)}, before you ` +
    `went live on ${prettyDay(cutoverDate!)}, so it feeds the check on your "${feeLabel}" ` +
    `fee and never a bill.`
  );
}

/**
 * WHY A JOB IS SHOWN WITHOUT ITS BUTTON — or null when it may be filed.
 *
 * The costs screen lists work LakeLife has done at the park with a one-tap
 * "File as …" that submits the job's own month as the period. A job done
 * between closing and go-live — a plough on 20 December at a park going
 * live 1 January — would sit there with a button that always refuses, and
 * the refusal would send it to a closing statement it is not on either. So
 * the row stays (he paid for it; hiding it would look like a dropped read)
 * and the button goes, with one line saying why.
 */
export function preCutoverJobNote(
  month: string,
  cutoverDate: string | null | undefined,
  prettyMonth: (period: string) => string,
): string | null {
  if (periodIsBillable(month, cutoverDate)) return null;
  return (
    `Done in ${prettyMonth(month)}, before you went live on ${prettyDay(cutoverDate!)} — ` +
    `not ours to split across the lots.`
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
