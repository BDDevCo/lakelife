/**
 * WHAT HAPPENS TO MONEY ON ACCOUNT — IN THE RESIDENT'S OWN LANGUAGE.
 *
 * There are two office-voiced homes for this promise already: the toasts'
 * and the notes' (`onAccountPromise`, app/park/ledger-helpers), which name
 * the office's own doors — "theirs to have back from 'Money not against a
 * bill' on the Rent screen". Neither sentence can go on a resident's page or
 * a resident's receipt: it is about a control they do not have.
 *
 * These are the resident-voiced four. They lived module-private inside
 * /paid/[token], which is why the printed receipt — the ONLY record a
 * household at a park with notices held ever gets — kept promising a next
 * bill to a household that had none. Here so the confirm page and the paper
 * cannot drift the next time one of them is reworded.
 *
 * THE PAPER READS THEM FROM HERE ALREADY (app/park/receipt-helpers). The
 * /paid page still holds its own copies of the same four sentences and
 * should import them instead — the test beside this file requires the two
 * doors to agree either way, so the drift cannot start before that lands.
 *
 * THEY SAY NOTHING ABOUT HOW MONEY COMES BACK. LakeLife handles no cash; the
 * office does. "The office has it for you" is the whole of what we know.
 */

/**
 * A next bill IS coming: the run applies money on account to it, oldest
 * first (0167). Said only of a payment that still stands.
 */
export const COMES_OFF = "It comes off the next bill the park raises for you.";

/** The same, as the tail of a sentence about part of a payment. */
export const STILL_COMES_OFF =
  "what's still on account comes off the next bill the park raises for you.";

/**
 * …UNLESS NO NEXT BILL WILL EVER COME. The household has moved out and the
 * move-out month is billed (`nothingMoreBills` — lib/tenancy-facts). Then
 * "comes off the next bill" promises a bill the park will never raise, to
 * the one person the money belongs to — and since 0169 that is the DEFAULT
 * state of every move-out overpayment: the whole month paid, the bill
 * cancelled, the part month settled from it, the rest left over. The
 * office's own screen calls that "theirs to have back".
 */
export const OFFICE_HAS_IT = "The office has it for you.";

/** The same, as the tail of a sentence about part of a payment. */
export const STILL_OFFICE_HAS_IT = "the office has what's still on account for you.";
