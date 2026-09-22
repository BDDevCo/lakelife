import {
  money, prettyMonth, shiftMonth, paymentAmountRefusal, onAccountPromise, HELD_DOOR, HAND_KEYED,
  type HandKeyedMethod,
} from "@/app/park/ledger-helpers";
import type { PaymentTarget } from "@/app/park/pos-actions";
import type { recordPayment } from "@/app/park/ledger-actions";
import type { recordOnAccount } from "@/app/park/money-actions";
import type { ReceiptLines } from "@/app/park/receipt-helpers";
import { planAllocations, type BillOwing } from "@/lib/allocations";

/**
 * EVERY SENTENCE AND EVERY PURE RULE OF THE ⊕ TAKE A PAYMENT WINDOW.
 *
 * The window is a client component over two server doors that already exist
 * (recordPayment, recordOnAccount). What it says BEFORE the tap — what is
 * owed, where an over-payment will go, why an amount is refused — and what
 * it says AFTER — the headline over the door's own sentence — lives here, as
 * plain functions, so each can be pinned without a DOM and so the mapping
 * from a door's result to the words on the card is a tested caller rather
 * than an inline expression nobody exercises.
 *
 * Money figures are `money()` and months are `prettyMonth()`, the one copy
 * of each in ledger-helpers, so "$1,085.06" and "January 2027" are the same
 * shapes the receipt and the rent screen print.
 *
 * NOT ONLY THIS WINDOW'S. The line under the amount (amountNote) is also the
 * line under the amount on the rent screen's own Record payment form
 * (ParkRent), read off the ledger row's household facts instead of a
 * PaymentTarget — the same household, in the same state, described one way
 * on both forms. It reads only MoneyFacts, so a row need not invent a
 * renter id or a lot to ask it.
 */

/**
 * Rows at which the type-to-filter box appears. Eight rows fit under the
 * modal head on a 375×667 phone without scrolling; from nine the box is
 * faster than the scroll.
 */
export const FILTER_FROM = 9;

const cents = (n: number) => Math.round(n * 100);

/**
 * The line under a household's name on the list. Money of theirs the office
 * already holds is said on the row, beside what is owed — "Owes $542.53"
 * alone, over a household whose own $542.53 is in the drawer, is the row
 * that gets the office taking the same rent twice.
 */
export function owedWords(t: PaymentTarget): string {
  const o = t.oldestOpen;
  const held = cents(t.onAccount) > 0 ? ` · ${money(t.onAccount)} of theirs is on account` : "";
  if (!o) return `Nothing owed — goes on account${held}`;
  return `Owes ${money(o.balance)} for ${prettyMonth(o.month)}`
    + (t.openCount > 1 ? ` — oldest of ${t.openCount} open bills` : "")
    + (o.disputed ? " · they say they've paid it" : "")
    + held;
}

/**
 * The amount box, pre-filled to the oldest open bill's balance — ParkRent's
 * own default, because the overwhelmingly common case is somebody handing
 * over the exact amount. Empty when nothing is owed: the box is the next
 * thing the office needs, and a guessed figure there is a guess about money.
 */
export function prefillAmount(t: PaymentTarget): string {
  return t.oldestOpen ? t.oldestOpen.balance.toFixed(2) : "";
}

/** ParkRent's own strip — "$1,085.06" typed with the sign and comma is 1085.06. */
export function parseAmount(text: string): number {
  return Number(text.replace(/[$,\s]/g, ""));
}

/**
 * WHAT THE LINE UNDER THE AMOUNT READS OFF A ROW: the bill, and the three
 * household facts beside it. The ⊕ window's PaymentTarget carries all of
 * them; so does the rent screen's LedgerRow since the on-account figure
 * joined the ledger (ledger-helpers HouseholdMoney) — and the form there
 * shapes its row to this rather than inventing a renter id it never uses.
 */
export type MoneyFacts =
  Pick<PaymentTarget, "openCount" | "oldestOpen" | "onAccount" | "nothingMoreBills">
  & {
    /**
     * THEIR OTHER OPEN BILLS THAT SETTLE BEFORE THIS ONE, oldest first —
     * the ordering already done by `oldestFirst`, the ONE sort every door
     * plans from (lib/allocations). Absent or empty means this bill IS
     * their oldest, which is true BY CONSTRUCTION in the ⊕ window: its
     * list is built from `oldestFirst(list)[0]`, so its `oldestOpen`
     * really is the oldest and there is nothing older to carry.
     *
     * The rent screen's form is the one that needed it. It is scoped to
     * one month while a household's money on account is not, and it filled
     * a field named `oldestOpen` with THIS row — so on a February row with
     * January still open it told the office the held money would come off
     * February. It goes to January.
     */
    olderOpen?: readonly BillOwing[];
  };

/** One household's money, for a projection that never leaves this function. */
const THEM = "them";

/**
 * WHAT THE MONEY THEY ALREADY HAVE ON ACCOUNT WILL ACTUALLY DO when Record
 * is tapped — not asserted, PLANNED, by the same pure function the door
 * writes from (planAllocations, what planSettlement delegates to).
 *
 * The bills are handed over in the order they settle — their older open
 * bills, then this one at what it would still owe — so this holds no second
 * copy of "oldest first": the loader sorted once with `oldestFirst` and this
 * walks that order. Re-sorting here would mean inventing a due date for this
 * row that MoneyFacts does not carry, which is how a same-month sibling
 * (a final part-month and a renewal) would silently jump the queue.
 *
 * Whether this bill gets topped up at all depends on the older bills'
 * BALANCES, not on their existence — held $400 against January owing
 * $180.65 and February owing $97.51 settles BOTH, and a flag saying merely
 * "you are not paying the oldest" would make the note lie the other way.
 */
function heldProjection(
  t: MoneyFacts,
  thisKey: string,
  shortCents: number,
): { toThis: number; toOlder: number } {
  const older = t.olderOpen ?? [];
  const plan = planAllocations(
    [
      ...older.map((b) => ({ ...b, renterId: THEM })),
      { key: thisKey, renterId: THEM, owing: shortCents / 100 },
    ],
    [{ paymentId: "held", renterId: THEM, remaining: t.onAccount, receivedOn: "" }],
  );
  let toThis = 0;
  let toOlder = 0;
  for (const line of plan) {
    if (line.key === thisKey) toThis += cents(line.amount);
    else toOlder += cents(line.amount);
  }
  return { toThis: toThis / 100, toOlder: toOlder / 100 };
}

/**
 * WHICH OF THEIR BILLS THE SPILL GOES ON. Money on account settles their
 * OLDEST open bill, so "their next open bill" is only the right word when
 * this row IS the oldest — which it always is in the ⊕ window and often is
 * not on the rent screen, where the office may be keying February with
 * January still open and off-screen.
 */
function otherBillWords(t: MoneyFacts): string {
  return (t.olderOpen?.length ?? 0) > 0 ? "their oldest open bill" : "their next open bill";
}

/** "their older open bill" / "their older open bills" — one of them is not plural. */
function olderBillWords(t: MoneyFacts): string {
  return (t.olderOpen?.length ?? 0) === 1 ? "their older open bill" : "their older open bills";
}

/**
 * WHAT THE OFFICE ALREADY HOLDS OF THEIRS, when a bill is open and they are
 * handing over the whole of it or more: the fact the row never used to
 * read. Recording the cash is the office's call — a household may hand over
 * this month and keep what is held against the next — so this states what
 * recording does to the held money and names the door that uses it on this
 * bill instead; it never turns money away. With another bill open the held
 * money goes against THAT one the moment this is recorded (settleOnAccount
 * runs inside recordPayment, oldest bill first); with only this one open it
 * stays on account, and what happens to it then is the one promise
 * (onAccountPromise) — no month named, because the bill it would come off
 * is whichever the run raises next, not this one.
 */
function heldInstead(t: MoneyFacts): string {
  if (cents(t.onAccount) <= 0 || !t.oldestOpen) return "";
  const covers = cents(t.onAccount) >= cents(t.oldestOpen.balance) ? " and would cover this" : "";
  const use = `to use it on this bill instead, put it on the bill from ${HELD_DOOR}.`;
  if (t.openCount > 1) {
    return ` ${money(t.onAccount)} of theirs is already on account${covers} — record this and that goes against ${otherBillWords(t)} instead; ${use}`;
  }
  return ` ${money(t.onAccount)} of theirs is already on account${covers} — record this and that stays on account${onAccountPromise(t.nothingMoreBills)}; ${use}`;
}

/**
 * THE LINE UNDER THE AMOUNT, recomputed on every keystroke: a refusal the
 * door would make (paymentAmountRefusal — read here so the office sees it
 * before tapping, not after), or where the money will go. An over-payment is
 * never refused and never silently credited: recordPayment takes min(amount,
 * owing) against the bill and puts the rest on account — and money on
 * account settles the household's next open bill the moment it is recorded
 * (0167, R1), so with more than one bill open the truth is "goes against
 * their next open bill", not "comes off the next bill you raise". Money
 * they ALREADY have on account moves by the same rule inside the same door:
 * a part payment is topped up from it the moment Record is tapped, so
 * "$242.53 will still be owing" is false whenever $242.53 of theirs is
 * held, and the sentence says what comes off instead.
 *
 * WHAT HAPPENS TO MONEY LEFT ON ACCOUNT AFTER THIS is a promise, keyed on
 * the one fact it depends on (lib/tenancy-facts, carried on the row), the
 * way the void door keys its own (whatBillsNext, ledger-actions). The words
 * are onAccountPromise's (ledger-helpers): the SAME clause the two doors
 * put on their toasts after the tap, so what this line promises before the
 * tap and what the door says after it cannot disagree about the same
 * $57.47. On the bill path the month the excess comes off is named, the way
 * recordPayment's toast names it — the month after the bill being paid.
 */
export function amountNote(text: string, t: MoneyFacts): string | null {
  const o = t.oldestOpen;
  // With nothing owed the box opens EMPTY, and where the money will go does
  // not depend on the figure — so that sentence is there before they type.
  const onAccount = `Nothing is owed, so this goes on account${onAccountPromise(t.nothingMoreBills)}.`;
  if (text.trim() === "") return o ? null : onAccount;
  const amount = parseAmount(text);
  const refusal = paymentAmountRefusal(amount);
  if (refusal) return refusal;
  if (!o) return onAccount;
  const a = cents(amount);
  const b = cents(o.balance);
  const held = cents(t.onAccount);
  const month = prettyMonth(o.month);
  if (a === b) return `Settles ${month}.${heldInstead(t)}`;
  if (a < b) {
    // The projection the office reads before the tap — what the door will
    // find still owing after its own settlement runs. Never the ledger's
    // figure; the receipt re-reads that after the insert.
    const short = b - a;
    if (held <= 0) return `Part of ${month} — ${money(short / 100)} will still be owing.`;
    // WHERE THE HELD MONEY GOES, PLANNED WITH THE DOOR'S OWN ARITHMETIC.
    // This branch was the only one that never asked whether this row was
    // the household's oldest open bill: it promised "the other $97.51 comes
    // off the $150.00 they have on account" on a February row whose January
    // bill took the whole $150.00, and the bill just keyed still owed the
    // $97.51 the office had been told was covered.
    const p = heldProjection(t, o.chargeId, short);
    const leftCents = short - cents(p.toThis);
    if (cents(p.toOlder) === 0) {
      // Nothing older to pay — this bill is the queue, and the held money
      // reaches it in full or as far as it goes.
      if (held >= short) {
        return `Part of ${month} — the other ${money(short / 100)} comes off the ${money(t.onAccount)} they have on account the moment you record this.`;
      }
      return `Part of ${month} — the ${money(t.onAccount)} they have on account comes off it the moment you record this, leaving ${money((short - held) / 100)} still owing.`;
    }
    const goesOlder = `the ${money(t.onAccount)} they have on account goes against ${olderBillWords(t)} first the moment you record this`;
    if (leftCents <= 0) {
      return `Part of ${month} — ${goesOlder}, and what's left of it covers the other ${money(short / 100)} of this one.`;
    }
    if (cents(p.toThis) > 0) {
      return `Part of ${month} — ${goesOlder}; ${money(p.toThis)} of it reaches this one, leaving ${money(leftCents / 100)} still owing.`;
    }
    return `Part of ${month} — ${money(short / 100)} will still be owing: ${goesOlder}.`;
  }
  const over = money((a - b) / 100);
  if (t.openCount > 1) {
    return `${money(o.balance)} settles ${month}; the other ${over} goes against ${otherBillWords(t)}.`
      + (held > 0 ? ` So does the ${money(t.onAccount)} of theirs already on account.` : "");
  }
  // The month the excess comes off is the month after THIS bill — the same
  // label recordPayment's toast names, computed the same way.
  return `${money(o.balance)} settles ${month}; the other ${over} goes on account${onAccountPromise(t.nothingMoreBills, { next: prettyMonth(shiftMonth(o.month, 1)) })}.`
    + (held > 0 ? ` ${money(t.onAccount)} of theirs is already on account; to use it on this bill instead, put it on the bill from ${HELD_DOOR}.` : "");
}

/**
 * Whether the line under the amount names the held-money door — so the form
 * shows the link it instructs (copy never names a control the screen lacks).
 * The same test the refusal notice makes.
 */
export function noteNamesHeldDoor(note: string | null): boolean {
  return note != null && note.includes("Money not against a bill");
}

/**
 * The door's own window allows 31 days ahead, because a form can be typed
 * ahead; this window cannot — the money is on the counter, so it arrived
 * today or earlier. The server still runs its own check; this only stops a
 * wrong tap. ISO dates compare as strings.
 */
export function receivedOnProblem(receivedOn: string, today: string): string | null {
  if (receivedOn > today) return "Money in hand came in today or earlier — pick that day.";
  return null;
}

/**
 * The line the office says when there is a queue: the disputed bill is the
 * one this window will put the money on, and 0074's trigger closes the
 * household's "I paid" claim as matched the moment a payment lands against
 * it. Said on the form, so the office knows tapping Record answers that
 * claim — and knows where to go when the cash is for a different month.
 */
export function disputedNote(t: PaymentTarget): string | null {
  const o = t.oldestOpen;
  if (!o || !o.disputed) return null;
  return `Recording this marks their 'I paid ${prettyMonth(o.month)}' claim as answered. `
    + "If this money is for a different month, record it from the rent screen.";
}

/**
 * "14" finds Lot 14 and not Lot 1; "lot 14" works because that is how he
 * says it; a name matches anywhere, case-insensitively.
 */
export function filterTargets(targets: readonly PaymentTarget[], q: string): PaymentTarget[] {
  const needle = q.trim().toLowerCase().replace(/^lot\s+/, "");
  if (needle === "") return [...targets];
  return targets.filter((t) => {
    const lot = t.lotNumber.toLowerCase();
    return lot === needle || lot.startsWith(needle) || t.name.toLowerCase().includes(needle);
  });
}

export interface Outcome {
  path: "bill" | "account";
  amount: number;
  name: string;
  month: string | null;
  against: number;
  onAccount: number;
  balanceAfter: number | null;
  /** True when some of the money went onto ANOTHER bill the moment it was recorded (0167, R1). */
  wentSomewhere: boolean;
}

/** Everything the Recorded step needs, from one door's result. */
export interface RecordedOutcome {
  outcome: Outcome;
  signal: string;
  receipt: ReceiptLines | null;
  renterEmail: string | null;
}

type BillDoorResult = Awaited<ReturnType<typeof recordPayment>>;
type AccountDoorResult = Awaited<ReturnType<typeof recordOnAccount>>;

/**
 * THE DOOR'S RESULT, AS THE CARD READS IT — the bill path. `against` and
 * `onAccount` are the door's own split; the month and the balance after are
 * the receipt's (re-read after the insert), falling back to what the list
 * showed only when the receipt did not come back. `wentSomewhere` is the
 * receipt's `appliedTo`: the excess landed on an older open bill just now,
 * and the headline must not then say "on account".
 */
export function outcomeFromBill(res: BillDoorResult, target: PaymentTarget, amt: number): RecordedOutcome {
  return {
    outcome: {
      path: "bill",
      amount: amt,
      name: target.name,
      month: res.receipt?.periodMonth || target.oldestOpen?.month || null,
      against: res.against ?? 0,
      onAccount: res.onAccount ?? 0,
      balanceAfter: res.receipt?.balanceAfter ?? null,
      wentSomewhere: (res.receipt?.onAccount?.appliedTo?.length ?? 0) > 0,
    },
    signal: res.signal ?? "Recorded.",
    receipt: res.receipt ?? null,
    renterEmail: res.renterEmail ?? null,
  };
}

/** The same, for money taken when nothing was owed. */
export function outcomeFromAccount(res: AccountDoorResult, target: PaymentTarget, amt: number): RecordedOutcome {
  return {
    outcome: {
      path: "account",
      amount: amt,
      name: target.name,
      month: null,
      against: 0,
      onAccount: amt,
      balanceAfter: null,
      wentSomewhere: (res.receipt?.onAccount?.appliedTo?.length ?? 0) > 0,
    },
    signal: res.signal ?? "Recorded.",
    receipt: res.receipt ?? null,
    renterEmail: res.renterEmail ?? null,
  };
}

/**
 * THE ONE SENTENCE THE OFFICE READS FIRST, on the bill path — composed from
 * the door's own figures so the money is the first line on the card. Null on
 * the account path: the door's signal already leads with "$200.00 recorded
 * for Jane Smith." and a second sentence saying the same thing is one more
 * figure to read twice (recordedWords bolds the signal's first sentence
 * instead).
 *
 * When some of the money went onto another bill the moment it landed, the
 * headline stops at what went against THIS bill and the signal beneath says
 * the rest — "$542.53 on account" over "nothing stays on account" is the
 * sentence this must never print.
 */
export function confirmationHeadline(o: Outcome): string | null {
  if (o.path === "account") return null;
  const month = prettyMonth(o.month ?? "");
  const got = money(o.amount);
  if (cents(o.against) === 0) {
    return `${got} received — ${month} was already settled, so all of it is on account.`;
  }
  if (cents(o.onAccount) > 0) {
    return o.wentSomewhere
      ? `${got} received — ${money(o.against)} against ${month}.`
      : `${got} received — ${money(o.against)} against ${month}; ${money(o.onAccount)} on account.`;
  }
  if (o.balanceAfter != null && cents(o.balanceAfter) > 0) {
    return `${got} received against ${month} — ${money(o.balanceAfter)} still outstanding.`;
  }
  return `${got} received against ${month} — that one's settled.`;
}

/**
 * The headline and the detail under it. Bill path: the composed headline over
 * the door's full sentence, verbatim (it carries what only the door knows —
 * older money moved, a ⚠️ line, a claim still open). Account path: the
 * door's first sentence, bold, and the rest beneath.
 */
export function recordedWords(o: Outcome, signal: string): { headline: string; detail: string } {
  const composed = confirmationHeadline(o);
  if (composed != null) return { headline: composed, detail: signal };
  const m = /^(.*?[.!?])\s+([\s\S]*)$/.exec(signal.trim());
  if (!m) return { headline: signal.trim(), detail: "" };
  return { headline: m[1], detail: m[2] };
}

/**
 * WHICH METHOD THE FORM OPENS ON. The first payment of a session defaults
 * to CHECK — ParkRent chose it because that is what actually comes through
 * the office door, and on a real roll most households pay cash or check.
 * After that, the last method recorded in THIS tab: a shift at the window is
 * a session, and sessionStorage dies with the tab, so it cannot leak onto
 * next month's phone. Validated against HAND_KEYED so a stored "card" can
 * never become the default; the select is always on screen and the receipt
 * prints the method, so a wrong default is visible twice before it matters.
 */
const METHOD_KEY = "ll-pos-method";

export function rememberedMethod(): HandKeyedMethod {
  try {
    const v = globalThis.sessionStorage?.getItem(METHOD_KEY);
    if (v && (HAND_KEYED as readonly string[]).includes(v)) return v as HandKeyedMethod;
  } catch {
    // Storage blocked or absent — the first-of-session default is the answer.
  }
  return "check";
}

export function rememberMethod(m: HandKeyedMethod): void {
  try {
    globalThis.sessionStorage?.setItem(METHOD_KEY, m);
  } catch {
    // Nothing to do: the default is still on screen next time.
  }
}

/** ParkRent's own guard around crypto.randomUUID. */
export function mintKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `pos:${Date.now()}:${Math.random()}`;
}
