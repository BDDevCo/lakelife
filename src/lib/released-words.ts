import { prettyMonth } from "@/app/park/ledger-helpers";
import { longDay } from "@/lib/lake-time";

/**
 * THE BILL THIS PAID WAS CANCELLED (0169), AND THE MONEY WENT ON ACCOUNT —
 * the one sentence that leads every standing shape of a released receipt,
 * wherever the household reads it: the /paid/[token] page, and the line
 * under the cheque on their own front page. It lived as two literals, one
 * in each, and "in the same words" was a comment holding them together;
 * the day a word changed on one page the other would have gone on saying
 * the old sentence to the same household about the same cheque.
 *
 * Read without it, "That money went on account with the office" on a
 * receipt that plainly says "against your January bill" reads as a
 * mistake. A void bill may carry no cancellation day (0070 allows
 * voided_at null with no reason), and the front page's loader does not
 * read the day at all; then the sentence names the bill and not a day.
 *
 * A plain module on purpose: a "use server" file's every export is an
 * endpoint, and a component is not a place to import a sentence from.
 */
export function releasedLead(month: string, on?: string | null): string {
  const day = on ? ` on ${longDay(on)}` : "";
  return `The ${prettyMonth(month)} bill this paid was cancelled${day}, so this money went on account with the office.`;
}
