/**
 * WHAT A CUSTOMER IS TOLD THE MOMENT THEY BOOK — the two sentences that were
 * true of some states and printed for all of them.
 *
 * Both are pure so every state has a test. The action supplies the facts; this
 * turns them into a sentence that is true of exactly those facts.
 */

/**
 * A MULTI-DATE BOOKING. "3 visits of Mowing locked in" was printed whether or
 * not a single one of them had a crew. Each day goes through autoAssignJob
 * on its own, and the loop kept only the LAST answer (in `soloAssigned`), so
 * a batch had no idea how many of its days were actually staffed.
 *
 * "Locked in" is reserved for a visit with a crew. The rest are "booked" —
 * which is true: the job row exists and nothing is charged until it is done —
 * with the honest count of how many still need one.
 */
export function batchBookedLine(input: {
  visits: string;        // "3 visits" — already pluralised by the caller
  serviceName: string;
  dateList: string;      // prettyDateList output
  assigned: number;
  total: number;
  missed: string;        // the refused-days clause, possibly ""
}): string {
  const { visits, serviceName, dateList, assigned, total, missed } = input;
  const tail = "We'll text you before each one, and you're never charged until the work is done. 🌊";
  if (total > 0 && assigned === total) {
    return `LakeLife: ${visits} of ${serviceName} locked in — ${dateList}.${missed} ${tail}`;
  }
  if (assigned === 0) {
    return `LakeLife: ${visits} of ${serviceName} booked — ${dateList}.${missed} We're lining up crews now and you'll hear as each one is locked in. ${tail}`;
  }
  const waiting = total - assigned;
  return `LakeLife: ${visits} of ${serviceName} booked — ${dateList}.${missed} ${assigned} ${assigned === 1 ? "has" : "have"} a crew; we're still lining ${waiting === 1 ? "one up" : `${waiting} up`}, and you'll hear as each is locked in. ${tail}`;
}

/**
 * A SAME-DAY RUSH. "We're offering it to crews already out on your lake right
 * now" was printed whether or not anybody was out — and today, with every crew
 * in production a fixture, whether or not anybody exists. blastRushToCrews now
 * reports whom it actually reached, and this says exactly that much.
 */
export function rushOfferLine(input: {
  serviceName: string;
  price: number;
  reached: number;
  /** true when the crews reached were ones with a job on this lake TODAY. */
  outToday: boolean;
  cutoffLabel: string;
  fallback: "roll" | "cancel";
}): string {
  const { serviceName, price, reached, outToday, cutoffLabel, fallback } = input;
  const ifNobody = fallback === "roll"
    ? "move it to tomorrow at the standard price"
    : "cancel it — no charge";
  const offered =
    reached === 0
      ? "We're hunting for a crew for it now."
      : outToday
        ? `We're offering it to ${reached === 1 ? "a crew that's" : "the crews"} already out on your lake right now.`
        : `We've posted it to ${reached === 1 ? "the crew" : `the ${reached} crews`} who work your lake.`;
  return `LakeLife ⚡: got it — same-day ${serviceName} at the rush rate ($${price}). ${offered} If nobody frees up by ${cutoffLabel}, we'll ${ifNobody}. 🌊`;
}
