/**
 * MONEY ASKED FOR, AND WHAT HAPPENS WHEN IT LANDS OR COMES BACK.
 *
 * 0155 gave `park_payments` a bank return (`returned_at` / `return_code`) and
 * 0191 gave it a settlement (`settled_at`), and both shipped with every READER
 * in place and no writer — deliberately, and said so: "the writer is the
 * webhook that does not exist". The webhook landed with 0157. The drain did
 * not, so between them the bank rail is a full-length pipe with no outlet:
 *
 *   `ParkRent` has a `clearing` pill. `ParkToday` has a clearing line —
 *   "$X from earlier months is on its way... that is time, not arrears".
 *   `ParkStatements` has a clearing pill. `bill-notice-helpers` skips
 *   chasing a clearing bill. And `RenterHome` tells the household, in so
 *   many words, "$X is on its way from your bank and takes a few days."
 *
 * Every one of those is correct, and not one of them can ever stop being true,
 * because nothing in the application can write either stamp. This file is the
 * half the rail needs to be finishable: what a return MEANS, and how long a
 * debit is allowed to take before somebody should ask about it.
 *
 * ============ A RETURN IS NOT ONE THING, IT IS THREE ============
 *
 * The office's next move is completely different depending on the code, and
 * getting it wrong is not merely untidy:
 *
 *   THEY DIDN'T HAVE IT (R01, R09). Ordinary. The debit may be presented
 *   again — NACHA allows two retries of the original authorisation, and a
 *   third is a violation.
 *
 *   THEY DIDN'T AUTHORISE IT (R05, R07, R08, R10, R11, R29). The account
 *   holder has denied or withdrawn permission. **Debiting that account again
 *   is an ACH rule violation**, it will be returned again, and each return
 *   costs the park a fee. This is the one a human reading "returned —
 *   insufficient funds" in a single sentence would get wrong.
 *
 *   THE ACCOUNT ISN'T THERE (R02, R03, R04, R16, R20). Nothing is wrong with
 *   the permission; the numbers are wrong or the account is dead. What is
 *   needed is different details, not a different mood.
 *
 * So the code carries the class, the class carries the sentence, and the
 * sentence names the next act. Nothing here decides POLICY — whether a return
 * costs the household a fee, whether their receipt is withdrawn, whether the
 * reopened bill is late from its original due date. 0155 left those to the
 * owner on purpose and they are still his.
 */

/** What a bank says when it sends a debit back, and what that leaves to do. */
export interface ReturnReason {
  /** The NACHA code, as it appears on a statement or a processor notice. */
  code: string;
  /** What it means, in the words the office would use. */
  said: string;
  /**
   * MAY THE SAME ACCOUNT BE DEBITED AGAIN for this bill?
   *
   *   retry      — yes, up to RETRIES_ALLOWED times. They were short.
   *   reauthorise— NO. Permission is gone; asking again breaks the rules.
   *   redetails  — not until somebody gives different account details.
   */
  next: "retry" | "reauthorise" | "redetails";
}

/**
 * THE CODES THAT ACTUALLY ARRIVE on consumer debits, and nothing else.
 *
 * There are over eighty NACHA return codes and a list of eighty is a list
 * nobody reads, so a picker offering all of them would be answered with
 * whichever looked closest. These are the ones a mobile-home park's rent
 * debits produce; anything else is recorded under `OTHER_CODE` with the note
 * carrying what the bank actually said, which is honest and is searchable
 * later. R01 will be almost all of them.
 */
export const RETURN_REASONS: readonly ReturnReason[] = [
  { code: "R01", said: "Not enough in the account", next: "retry" },
  { code: "R09", said: "The money wasn't collected yet", next: "retry" },
  { code: "R02", said: "The account is closed", next: "redetails" },
  { code: "R03", said: "No such account at that bank", next: "redetails" },
  { code: "R04", said: "The account number isn't right", next: "redetails" },
  { code: "R16", said: "The account is frozen", next: "redetails" },
  { code: "R20", said: "That account can't take debits", next: "redetails" },
  { code: "R05", said: "They say it wasn't authorised", next: "reauthorise" },
  { code: "R07", said: "They cancelled the authorisation", next: "reauthorise" },
  { code: "R08", said: "They stopped the payment", next: "reauthorise" },
  { code: "R10", said: "They say they didn't authorise it", next: "reauthorise" },
  { code: "R11", said: "They say it wasn't what they agreed to", next: "reauthorise" },
  { code: "R29", said: "A business account says it wasn't authorised", next: "reauthorise" },
] as const;

/**
 * THE SHAPE OF A RETURN CODE, and this application is the only thing checking.
 *
 * Verified against production: `return_code` has no CHECK of any kind, so the
 * database accepted `R73` and accepted the string "the bank phoned" just as
 * readily. 0155 gave the column no format on purpose — it did not yet know
 * what a processor would send — which leaves every guard here.
 *
 * `R` and two digits is the whole NACHA vocabulary, so nothing honest is
 * excluded by requiring it, and a free-text code would make this column
 * unreadable by anything that ever has to count returns by reason.
 */
const CODE_SHAPE = /^R\d{2}$/;

/**
 * A code we don't have words for, kept as the bank sent it.
 *
 * There are over eighty codes and the list above is the dozen that reach a
 * park's rent debits. The rest are real and must be recordable — an
 * unrecognised return the office cannot write down is a return that gets
 * written down as whichever listed code looked closest, which is worse than
 * having no words for it.
 *
 * IT IS `redetails`, THE ONE THAT STOPS. Guessing "retry" on an unknown code
 * costs a second return fee and may be a rule violation; guessing "stop"
 * costs a phone call. The asymmetry decides it.
 */
function unlistedReason(code: string): ReturnReason {
  return {
    code,
    said: `The bank's code ${code}, which we don't have words for`,
    next: "redetails",
  };
}

/** The reason behind a code, or null if it is not one we accept. */
export function returnReason(code: string | null | undefined): ReturnReason | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!CODE_SHAPE.test(c)) return null;
  return RETURN_REASONS.find((r) => r.code === c) ?? unlistedReason(c);
}

/** True when the code is one the picker offers words for. */
export function isListedReturnCode(code: string | null | undefined): boolean {
  const c = (code ?? "").trim().toUpperCase();
  return RETURN_REASONS.some((r) => r.code === c);
}

/**
 * NACHA allows a returned debit to be presented twice more under the same
 * authorisation. A third is a violation, so this is a ceiling and not a
 * suggestion — named here so the number is in one place when the retry
 * machinery exists to read it.
 */
export const RETRIES_ALLOWED = 2;

/**
 * A CONSUMER MAY CLAIM AN UNAUTHORISED DEBIT FOR SIXTY DAYS after their
 * statement shows it. So `settled_at` means the money arrived — it does not
 * mean the money is safe. Anything that eventually treats a cleared debit as
 * final (a payout, a statement the park's accountant closes, a deposit
 * released) has to reckon with this window, and naming it here is how the
 * next reader finds out before building on the wrong assumption.
 */
export const UNAUTHORISED_RETURN_WINDOW_DAYS = 60;

/**
 * Why a return cannot be recorded as asked — or null.
 *
 * THERE IS NO FREE-TEXT NOTE HERE, and that is not an omission. The first
 * draft of this feature appended what the bank said to `park_payments.note`;
 * 0191 FREEZES that column ("the note that went on the receipt") and
 * production refused the write. The code is the record instead — it is the
 * bank's own vocabulary, it is what a person would have to read off the
 * notice anyway, and unlike a note it can be counted.
 */
export function returnRefusal(input: {
  code: string | null | undefined;
  method: string | null | undefined;
  alreadyReturnedAt: string | null | undefined;
  reversedAt: string | null | undefined;
}): string | null {
  // 0155: `check (returned_at is null or method in ('card', 'ach'))`. Cash and
  // cheques are not on a rail that can take money back, and a hand-keyed bank
  // transfer is the office reading its own statement — if that was wrong it is
  // a reversal, which is a different act with a different sentence.
  if (input.method !== "card" && input.method !== "ach") {
    return "Only card and bank-transfer money can be sent back by a bank. If this was keyed wrongly, take the record back instead.";
  }
  if (input.alreadyReturnedAt) {
    return "The bank already sent that one back. A return is recorded once.";
  }
  if (input.reversedAt) {
    return "That record was already taken back, so there is nothing for a bank to return.";
  }
  if (!returnReason(input.code)) {
    return "Pick what the bank said, or type the code off their notice — they all look like R01 or R10.";
  }
  return null;
}

/** Why a payment cannot be marked as cleared — or null. */
export function clearingRefusal(input: {
  settledAt: string | null | undefined;
  returnedAt: string | null | undefined;
  reversedAt: string | null | undefined;
  method: string | null | undefined;
}): string | null {
  if (input.settledAt) {
    // 0191 makes settlement one-way at the database, with a better sentence
    // for a re-stamp than a constraint name. This is the ordinary case: two
    // people on the same screen, or a reload, not an error.
    return "That one has already landed.";
  }
  if (input.returnedAt) {
    return "The bank sent that one back, so it cannot also have landed.";
  }
  if (input.reversedAt) {
    return "That record was taken back, so there is nothing to land.";
  }
  // Everything except ACH is stamped as settled by the database the moment it
  // is written (0191's `payment_settles_on_arrival`), so an unsettled row
  // reaching here on any other rail means something upstream is wrong and a
  // button must not paper over it.
  if (input.method !== "ach") {
    return "Only a bank debit waits to land — everything else counts the moment it is written down.";
  }
  return null;
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * WEEKDAYS from one day to another, not counting the day it started.
 *
 * THE SHAPE IS CHECKED, NOT THE NUMBER. `Number("")` is 0 and 0 is finite,
 * which is how a blank date once produced a real-looking answer elsewhere in
 * this codebase. A date this cannot read returns null rather than a figure.
 *
 * WEEKDAYS, NOT BANKING DAYS, and the difference is deliberate. A federal
 * holiday table is a list that silently goes stale, and the only thing this
 * feeds is "has this taken too long" — where being one day optimistic across
 * Thanksgiving costs nothing and a wrong table would be believed for years.
 * The sentence it produces says "working days" and never claims otherwise.
 */
export function weekdaysBetween(fromISO: string, toISO: string): number | null {
  const from = (fromISO ?? "").trim();
  const to = (toISO ?? "").trim();
  if (!DAY.test(from) || !DAY.test(to)) return null;
  if (to <= from) return 0;

  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  let n = 0;
  const cursor = new Date(start);
  // Walks forward a day at a time, which is exact and is bounded by the cap
  // below. A closed-form week count is three lines of off-by-one risk for a
  // loop that runs at most ninety times.
  for (let guard = 0; guard < 400; guard += 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor > end) break;
    const d = cursor.getUTCDay();
    if (d !== 0 && d !== 6) n += 1;
  }
  return n;
}

/**
 * A bank debit normally lands the next banking day and is in the account
 * within two or three. Past a week something has gone wrong that nobody has
 * been told about — most often the processor never sent it, which is invisible
 * from this side and looks exactly like patience.
 */
export const LANDS_WITHIN_WEEKDAYS = 3;
export const STUCK_AFTER_WEEKDAYS = 7;

export type InFlightKind = "landing" | "slow" | "stuck" | "unknown";

/**
 * WHERE A DEBIT IS IN ITS LIFE, and what to say about it.
 *
 * Three states rather than two, because "it's fine" and "ask somebody" need a
 * middle: a debit on its fourth day is not yet wrong, and a screen that jumps
 * from silence to alarm trains the reader to ignore the alarm.
 */
export function inFlight(input: { receivedOn: string; today: string }): {
  kind: InFlightKind;
  weekdays: number | null;
  said: string;
} {
  const weekdays = weekdaysBetween(input.receivedOn, input.today);
  if (weekdays == null) {
    return {
      kind: "unknown",
      weekdays: null,
      said: "We can't tell how long this has been on its way.",
    };
  }
  if (weekdays >= STUCK_AFTER_WEEKDAYS) {
    return {
      kind: "stuck",
      weekdays,
      said:
        `Asked for ${weekdays} working days ago and still hasn't landed. ` +
        "That is longer than a bank debit takes — check it actually went, " +
        "and ask the household whether anything came out.",
    };
  }
  if (weekdays > LANDS_WITHIN_WEEKDAYS) {
    return {
      kind: "slow",
      weekdays,
      said: `On its way for ${weekdays} working days. A day or two more than usual.`,
    };
  }
  return {
    kind: "landing",
    weekdays,
    said:
      weekdays <= 0
        ? "Asked for today. A bank debit takes a few working days."
        : `On its way — ${weekdays} working ${weekdays === 1 ? "day" : "days"} so far.`,
  };
}

/**
 * WHAT TO DO NOW, said to the office, for each of the three classes.
 *
 * The `reauthorise` sentence is the one that earns this function. "Returned —
 * they say they didn't authorise it" reads to a reasonable person as "try
 * again", and trying again is a rule violation that will be returned again
 * with a fee each time. So the sentence says the act, not the feeling.
 */
export function whatToDoAfterReturn(code: string | null | undefined): string {
  const reason = returnReason(code);
  if (!reason) return "Find out what the bank said before asking for it again.";
  // AN UNLISTED CODE GETS THE STOP WITHOUT THE REASON. It is classed
  // `redetails` so nothing retries it, but saying "that account can't be used"
  // would be claiming to know something only the bank's notice says.
  if (!isListedReturnCode(reason.code)) {
    return (
      "The bill is open again. We don't have words for that code — read what " +
      "the bank sent before asking for it again, because some returns mean " +
      "you must not debit that account a second time."
    );
  }
  switch (reason.next) {
    case "retry":
      return (
        "The bill is open again. You can ask their bank again — up to " +
        `${RETRIES_ALLOWED} more times on the same authorisation — or ask them ` +
        "to pay another way."
      );
    case "reauthorise":
      return (
        "The bill is open again. Do NOT debit that account again: they have " +
        "told their bank not to allow it, every attempt will come back, and " +
        "each one costs a fee. They have to set the payment up afresh, or pay " +
        "another way."
      );
    case "redetails":
      return (
        "The bill is open again. That account can't be used — ask them for " +
        "different details or another way to pay."
      );
  }
}

/**
 * THE SAME FACT SAID TO THE HOUSEHOLD, who have done nothing wrong until
 * proven otherwise and may well not know yet.
 *
 * Two audiences, two sentences, as `rentCapability` already splits them: the
 * office's version names the rule and the fee risk, and this one names the
 * money and what to do, with no accusation in it. The retry classes read very
 * differently from the outside — "there wasn't enough in the account" is a
 * thing that happens, and so the words for it are plain.
 */
export function returnSaidToResident(input: {
  code: string | null | undefined;
  amount: string;
}): string {
  const reason = returnReason(input.code);
  const base = `Your bank sent back the ${input.amount} payment, so that bill is open again.`;
  // An unlisted code is told to the household as the fact without the
  // explanation, for the same reason the office's version is: we do not know.
  if (!reason || !isListedReturnCode(reason.code)) {
    return `${base} Please get in touch so we can sort out how to pay it.`;
  }
  switch (reason.next) {
    case "retry":
      return `${base} There wasn't enough in the account when it was taken. You can pay it again whenever you're ready.`;
    case "reauthorise":
      return `${base} Your bank has it marked as not authorised, so we can't take it from that account again. You'll need to set the payment up afresh or pay another way.`;
    case "redetails":
      return `${base} That account couldn't be used. Please add different details or pay another way.`;
  }
}

/**
 * ONE LINE FOR A RETURNED PAYMENT, wherever a screen shows one.
 *
 * `returned_at` has had ten readers and no writer since 0155. Now that a row
 * can carry one, every screen that shows one says the same thing about it —
 * the mistake `canReverse` was extracted to fix, avoided in advance this time.
 */
export function describeReturn(input: {
  code: string | null | undefined;
  returnedAt: string | null | undefined;
  periodMonth: string | null | undefined;
  prettyMonth: (period: string) => string;
  dayInWords: (iso: string) => string;
}): string {
  const reason = returnReason(input.code);
  const when = input.returnedAt ? ` on ${input.dayInWords(input.returnedAt.slice(0, 10))}` : "";
  const what = reason ? reason.said.toLowerCase() : "the bank didn't say why";
  const bill = input.periodMonth
    ? ` The ${input.prettyMonth(input.periodMonth)} bill is open again.`
    : " It has come off their account again.";
  return `The bank sent this back${when} — ${what}.${bill}`;
}

/** One line summing up everything still on its way, or null if nothing is. */
export function inFlightSummary(input: {
  rows: { amountCents: number; kind: InFlightKind }[];
  money: (cents: number) => string;
}): string | null {
  const { rows } = input;
  if (rows.length === 0) return null;
  const totalCents = rows.reduce((n, r) => n + r.amountCents, 0);
  const wrong = rows.filter((r) => r.kind === "stuck").length;
  const head =
    `${input.money(totalCents)} is on its way from ${rows.length} ` +
    `${rows.length === 1 ? "payment" : "payments"} and hasn't landed yet. ` +
    "None of it is arrears.";
  if (wrong === 0) return head;
  return (
    `${head} ${wrong} of ${wrong === 1 ? "them has" : "them have"} been waiting ` +
    `longer than a bank debit takes — worth checking.`
  );
}
