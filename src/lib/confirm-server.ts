import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage, ReadFailed } from "@/lib/must-read";
import { isBearerToken } from "@/lib/token-format";
import { receiptRef, METHOD_WORD } from "@/app/park/receipt-helpers";
import { splitSiblingKey, prettyMonth } from "@/app/park/ledger-helpers";
import { notCollectedAt, takenBackWhy, takenBackOfRow } from "@/app/park/receipts-helpers";
import { longDate } from "@/lib/lake-time";
import { describeAllocations, withRaisedAgain, money, type AllocationLine } from "@/lib/allocations";
import { tenancyFactsFor, nothingMoreBills } from "@/lib/tenancy-facts";

/**
 * THE RENTER'S OWN CONFIRMATION — the only part of the ledger they can act on.
 *
 * There is no bank in the middle of these lakes. Cash sits in a drawer until
 * somebody drives to town, and often longer than that, so nothing external will
 * ever tell us who paid or when. The record can only be validated by the two
 * people who were there.
 *
 * WHY A LINK AND NOT A TICKBOX. "The owner ticked a box saying the renter
 * agreed" is still ONE party — it has exactly the flaw the whole exercise is
 * trying to fix. A tap that arrives from the renter's own phone, on a token
 * only they were sent, is an act the owner did not perform. That distinction is
 * the entire value.
 *
 * NO ACCOUNT REQUIRED, deliberately. Most of this park will never make one, and
 * a confirmation that only signed-in renters can give would protect precisely
 * the households least at risk. Same one-tap, no-account discipline as the
 * extend-stay links.
 *
 * DISAGREEING IS AS EASY AS AGREEING. A page with only a "yes" button is a
 * rubber stamp. "That's not what I paid" files a claim against the bill, which
 * marks it disputed and stops the reminders — the same machinery a renter gets
 * when they tell the office in person.
 */

export interface ConfirmView {
  parkName: string;
  lotNumber: string;
  /**
   * WHAT THEY HANDED OVER — the whole of it. A payment for more than the bill
   * is recorded as two rows (recordPayment: the bill's share against the
   * charge, the rest on account), and the receipt's link carries the bill
   * row's token. Asking "does this match what you handed over?" against
   * $542.53 when she handed $600 manufactures a dispute, so the on-account
   * sibling is folded back in here. What the card was actually charged is
   * amount + fee.
   */
  amount: number;
  /** The part of `amount` that went on account with the office, or null when none did. */
  onAccount: number | null;
  /**
   * Whether any of that part has since been put against a bill. This page is
   * a permanent URL printed on paper, and "held for you, not yet put against
   * a bill" was true the day the receipt was written and false from the day
   * the run or the office allocated it (0167). Read, never assumed.
   */
  onAccountApplied: boolean;
  /**
   * WHAT IS STILL HELD of the on-account part — the database's `remaining`,
   * not `amount`. Null when nothing went on account. A quarter paid ahead
   * with two months applied is one month here.
   */
  onAccountRemaining: number | null;
  /**
   * WHERE THE MONEY ON ACCOUNT HAS GONE: which bill months, how much to each.
   * For a split receipt these are the sibling's; for a receipt that IS money
   * on account (a cheque taken before its bill existed) they are its own.
   * Empty when nothing has been applied.
   */
  allocations: AllocationLine[];
  /** The same, as one sentence: "$542.53 to January 2027, $57.47 on account". Empty when nothing to say. */
  whereItWent: string;
  /**
   * THIS PAYMENT NO LONGER STANDS. The office reversed it (a bounced cheque,
   * a typo) or the bank returned it. The link is a permanent URL on paper:
   * read a month later, "held for you — it comes off the next bill" about
   * money the office has recorded as never having arrived is a promise the
   * park cannot keep. Null while the payment stands. `takenBackWhy` is the
   * office's reason or the bank's return code, for the sentence.
   */
  takenBackOn: string | null;
  takenBackWhy: string | null;
  /**
   * THE OTHER HALF'S OWN STANDING. On a split receipt `takenBackOn` is the
   * bill row's; the $57.47 sibling is its own row with its own reversed_at.
   * reversePayment takes both halves back together (it is one cheque), so
   * ordinarily these agree — but the page must never SAY "that no longer
   * stands" about the sibling's allocations from the bill row's standing,
   * nor "held for you" about a sibling that was taken back on its own.
   * Null when there is no sibling, or it still stands. `onAccount`,
   * `allocations` and `whereItWent` are still the sibling's whether or not
   * it stands: what she handed over does not change when the office
   * corrects the record; the record of the correction is these two.
   */
  siblingTakenBackOn: string | null;
  siblingTakenBackWhy: string | null;
  /**
   * MONEY SENT BACK THROUGH THE PROCESSOR (0142), one entry per refund — off
   * this row and off its split sibling both. The page asked her to confirm
   * $600 and listed $560 of it against bills with nothing about the $40 that
   * went back to her card; the view's `remaining` had already netted it, so
   * the arithmetic on the page could not be tied to the paper. Read, never
   * derived. Empty for every payment nothing has been refunded from.
   * `method` is the refunded payment's rail — "card" or "ach" — so the page
   * says "your card" or "your bank account" and not the wrong one.
   */
  sentBack: Array<{ amount: number; fee: number; on: string; method: string }>;
  /**
   * MONEY HANDED BACK ACROSS THE WINDOW — a deposit returned (0102), rent on
   * account handed back to a household that has left (0168) — off this row
   * or its split sibling, oldest first. A hand-back is a stamp on the payment
   * (returned_on, returned_amount, return_note), recorded once, so there is
   * at most one per row. The fourth way money leaves, and the one page a
   * household keeps said nothing about it: "$542.53 to January 2027" for a
   * $600 cheque with $57.47 unexplained. Read, never derived. `note` is the
   * office's reason, carried for the record; the page prints the amount and
   * the day.
   */
  handedBack: Array<{ amount: number; on: string; note: string | null }>;
  /**
   * THE BILL THIS PAID WAS CANCELLED AFTER IT WAS PAID, and the money was
   * released onto account (0169) — which month's bill, and the day it was
   * cancelled. The payment row never moved: it is still against that bill,
   * and the view park_on_account_payments now lists it, with `remaining`
   * as the one remainder. `allocations` / `whereItWent` / `onAccountRemaining`
   * are then this row's own — and, on a split receipt, the sibling's as
   * well, summed: the page must never say "$57.47 held for you" when $127.47
   * is. Null for every other receipt. Read from the view, never inferred
   * from the bill's status: a void bill from before 0169, or a released row
   * since taken back, has nothing on account.
   */
  releasedFrom: { month: string; on: string } | null;
  /**
   * NO FURTHER BILL WILL BE RAISED FOR THIS HOUSEHOLD: their tenancy has
   * ended AND the move-out month is already billed — the same two facts the
   * resident's home screen reads (my-data tenancyEnded / finalMonthBilled)
   * for the same sentence. "It comes off the next bill the park raises for
   * you" is true right up to the last bill; after it, the page would be
   * promising a bill that will never come, on the receipt of the one person
   * the money belongs to — and since 0169 that is the DEFAULT shape of a
   * move-out overpayment. Read only when something is still held (that is
   * the only sentence it changes); false otherwise, and false while the
   * final month is still to be billed, because the money WILL come off it.
   */
  nothingMoreBills: boolean;
  /**
   * WHETHER "THAT'S NOT WHAT I PAID" CAN BE SAVED. A claim hangs off a bill
   * (park_payment_claims.charge_id is NOT NULL), so a receipt for money on
   * account or a deposit has nowhere to file one — and the page used to
   * offer the button anyway, promise "nothing will be chased while they
   * look", and then answer "We couldn't save that". False here means the
   * page renders no second button and names the real path instead.
   *
   * AND THE BILL MUST BE LIVE. A released row (0169) still carries its
   * charge_id, but that bill is void: a claim against it would be one the
   * rent screen never lists (it gates on the bill's state) while the
   * machine counts it as an open claim aging toward the chase. So a
   * released row is disputed the way money on account is — through the
   * office, quoting the receipt — or not at all.
   */
  canDispute: boolean;
  /** Card convenience fee charged on top, or null. */
  fee: number | null;
  method: string;
  reference: string | null;
  receivedOn: string;
  ref: string;
  alreadyConfirmedAt: string | null;
}

/**
 * The key the other half of a split is written under — from the ONE
 * spelling in ledger-helpers, the same one recordPayment writes and
 * reversePayment reads. Null for a row that has no other half.
 */
function siblingKey(key: string | null, chargeId: unknown): string | null {
  return splitSiblingKey(key, chargeId);
}

/**
 * WHERE A PAYMENT ON ACCOUNT HAS GONE (0167): its live allocations, with the
 * month of each bill, and what is still unapplied. Read, never derived from
 * `charge_id` — the payment row never moves; the allocations are the record.
 *
 * `remaining` IS THE VIEW'S, not `amount − allocations` here. The one
 * definition lives in park_payment_remaining (amount − live allocations −
 * refunds − a hand-back), and the view lists only payments that still stand
 * and are on account: a row absent from it is reversed, bank-returned, or
 * against a LIVE bill, and has NOTHING on account — whatever a subtraction
 * here would have said. A bounced quarter-ahead cheque's own link used to
 * read "held for you" because this file did the arithmetic itself.
 *
 * OVER SEVERAL ROWS AT ONCE (0169). A split receipt whose bill was cancelled
 * has TWO rows on account — the released $542.53 against the void bill and
 * the $57.47 sibling recorded on account from the start — and the page must
 * name where both went and what is held of both: reading the sibling alone
 * printed "$57.47 held for you" when $127.47 was. `candidates` are the rows
 * that MAY be on account; the view says which are (`members`), and
 * `remaining` is summed over those. `recordIds` are the rows whose
 * allocations are read whether or not they still stand — a row recorded on
 * account (charge_id null) keeps its allocations as the record of where the
 * money HAD gone after a reversal. A bill row's allocations are read only
 * while the view lists it: a live bill's payment has none, and a released
 * row since taken back is a plain taken-back receipt again.
 *
 * `releasedFrom` is the one candidate the view marks as released — the bill
 * row, never the sibling.
 *
 * mustRead, for the same reason the sibling read is: a failed read rendering
 * as "nothing applied" would tell a resident in March that her January
 * cheque is still in a drawer.
 */
async function whereItWent(
  admin: ReturnType<typeof createServiceClient>,
  candidates: string[],
  recordIds: string[],
): Promise<{ allocations: AllocationLine[]; remaining: number; releasedFrom: { month: string; on: string } | null; members: Set<string> }> {
  const held = mustRead("what is still on account", await admin
    .from("park_on_account_payments")
    .select("payment_id, remaining, released_from_month, released_on")
    .in("payment_id", candidates)) ?? [];
  const members = new Set(held.map((h) => String(h.payment_id)));
  const remaining = Math.round(held.reduce((s, h) => s + Number(h.remaining ?? 0) * 100, 0)) / 100;
  const releasedRow = held.find((h) => h.released_from_month != null);
  const releasedFrom = releasedRow
    ? { month: String(releasedRow.released_from_month), on: String(releasedRow.released_on ?? "") }
    : null;
  const allocIds = [...new Set([...recordIds, ...candidates.filter((id) => members.has(id))])];
  if (allocIds.length === 0) return { allocations: [], remaining, releasedFrom, members };
  const allocs = mustRead("where that money has gone", await admin
    .from("park_payment_allocations")
    .select("charge_id, amount")
    .in("payment_id", allocIds)
    .is("removed_at", null)) ?? [];
  if (allocs.length === 0) return { allocations: [], remaining, releasedFrom, members };
  const charges = mustRead("the bills it was put against", await admin
    .from("park_charges")
    .select("id, period_month, amount, lines")
    .in("id", allocs.map((a) => a.charge_id as string))) ?? [];
  const billOf = new Map(charges.map((c) => [c.id as string, c]));
  // THE BILL RAISED AGAIN FOR THE CANCELLED MONTH is named apart (0169). A
  // move-out cancels January and raises January again for the days they
  // were here — same month, two bills — and "$472.53 to January 2027" one
  // sentence after "the January 2027 bill this paid was cancelled" read as
  // money put against the bill just cancelled. The one decision of which
  // line collides is lib/allocations' (withRaisedAgain: the line whose
  // month is the released-from month — every live line in that month IS
  // the re-raise, since 0169's guard refuses to cancel a bill with live
  // lines on it), the way the office's receipts and the reversal sentence
  // mark it; the re-raised bill's own amount rides on that line alone so
  // every ordinary line keeps its shape.
  const allocations = allocs.map((a) => {
    const bill = billOf.get(a.charge_id as string);
    const line = withRaisedAgain(
      { periodMonth: (bill?.period_month as string | undefined) ?? "", amount: Number(a.amount ?? 0) },
      releasedFrom?.month ?? null,
      bill?.lines,
    );
    return line.raisedAgain && bill?.amount != null ? { ...line, billAmount: Number(bill.amount) } : line;
  });
  return { allocations, remaining, releasedFrom, members };
}

/**
 * THE OTHER HALF OF A SPLIT PAYMENT — one helper, because three doors read it.
 *
 * recordPayment writes the on-account row under the bill row's key +
 * ":onaccount", in the same insert, and the receipt's link carries the bill
 * row's token. The page that asks "does this match what you handed over?",
 * the claim filed when the answer is "no", and the stamp written when the
 * answer is "yes" must therefore all cover the SAME money: she reads $600 on
 * the page, taps "That's not what I paid", and the office must see a claim
 * about $600 — not one that says the receipt records $542.53, a number nobody
 * printed for her. Taps "Yes, that's right", and both rows carry her
 * confirmation, not just the one whose token she had. One rule in one place,
 * so the next door that quotes a receipt cannot fold half of it in.
 *
 * WHERE THE REST SITS is read, not assumed (0167): the run or the office puts
 * it against bills as `park_payment_allocations` rows, and the receipt's link
 * is a permanent URL. `onAccountApplied` and `allocations` are how the page
 * stops saying "held for you" about money that was put against February a
 * month ago — and says which month.
 *
 * Only a row against a bill can have a sibling. A row that IS money on
 * account (no charge, kind rent) reports its own allocations instead, so the
 * link on a quarter-ahead cheque's receipt says where the quarter went. A
 * row whose bill was CANCELLED after it was paid (0169) reports its own as
 * well — the money was released onto account, the row never moved — and on
 * a split both halves at once, since both are on account then.
 * mustRead, never maybe: a failed read here would show the bill's share as
 * the whole and ask her to agree to it (or file a claim about it). Callers
 * that return `{ ok, error }` rather than throw must catch ReadFailed.
 */
/** A hand-back off one payment row, or null when the row carries no stamp. */
function handBackOf(p: { returned_on?: unknown; returned_amount?: unknown; return_note?: unknown }): { amount: number; on: string; note: string | null } | null {
  if (p.returned_on == null || Number(p.returned_amount ?? 0) <= 0) return null;
  return { amount: Number(p.returned_amount), on: String(p.returned_on), note: (p.return_note as string | null) ?? null };
}

async function wholeHandedOver(
  admin: ReturnType<typeof createServiceClient>,
  pay: {
    id?: unknown; charge_id: unknown; amount: unknown; idempotency_key: unknown; kind?: unknown; method?: unknown;
    returned_on?: unknown; returned_amount?: unknown; return_note?: unknown;
  },
): Promise<{
  amount: number;
  onAccount: number | null;
  onAccountApplied: boolean;
  onAccountRemaining: number | null;
  allocations: AllocationLine[];
  /** The sibling row's id WHILE IT STANDS, so a stamp can land on both halves in one update. A taken-back sibling is never stamped. */
  siblingId: string | null;
  /** The sibling's own reversed_at / returned_at, and the reason — null while it stands or when there is none. */
  siblingTakenBackOn: string | null;
  siblingTakenBackWhy: string | null;
  /** Every refund off this row or its sibling, oldest first. */
  sentBack: Array<{ amount: number; fee: number; on: string; method: string }>;
  /** Every hand-back off this row or its sibling, oldest first — at most one each. */
  handedBack: Array<{ amount: number; on: string; note: string | null }>;
  /** This row's bill was cancelled and its money released (0169) — the view lists the row. */
  released: boolean;
  releasedFrom: { month: string; on: string } | null;
}> {
  // ONLY A BILL ROW LOOKS FOR A SIBLING HERE. The link on an on-account
  // row's own receipt reports that row (its allocations, its standing);
  // folding its bill half in would print the bill's $542.53 on a receipt
  // that was written for $57.47.
  const key = pay.charge_id ? siblingKey((pay.idempotency_key as string | null) ?? null, pay.charge_id) : null;
  // READ WHETHER OR NOT IT STANDS. What she handed over was $600, and a
  // page that drops the $57.47 the office has since taken back is a page
  // that hides the correction rather than stating it. The standing comes
  // along so the page can say which half no longer stands.
  // `returned_on` / `returned_amount` / `return_note`: the sibling handed
  // back across the window (0168) — a different act from `returned_at`, the
  // bank pulling money back, and read here for the same reason the standing
  // is: the page must say where the $57.47 went.
  const sibling = key
    ? mustRead("the rest of that payment", await admin
        .from("park_payments")
        .select("id, amount, charge_id, method, reversed_at, reversed_reason, returned_at, return_code, returned_on, returned_amount, return_note")
        .eq("idempotency_key", key)
        .maybeSingle())
    : null;
  const onAccount = sibling ? Number(sibling.amount) : null;
  const siblingStands = !!sibling && notCollectedAt(takenBackOfRow(sibling)) == null;

  // WHOSE MONEY MAY BE ON ACCOUNT: the sibling's on a split receipt; the
  // row's own when it was recorded on account (no bill) — and, since 0169,
  // the row's own when its bill was CANCELLED and the money released. That
  // last case is decided by VIEW MEMBERSHIP, never by dropping the
  // charge_id test: an ordinary receipt against a live bill has nothing on
  // account and must keep `onAccountRemaining` null, or /paid prints "none
  // of it is still held" on every plain receipt. A deposit has none (0102),
  // and nothing is read for it.
  const rent = pay.kind == null || pay.kind === "rent";
  const own = rent && pay.id ? String(pay.id) : null;
  const candidates = [...(sibling ? [String(sibling.id)] : []), ...(own ? [own] : [])];
  const recordIds = [...(sibling ? [String(sibling.id)] : []), ...(own && !pay.charge_id ? [own] : [])];
  const went = candidates.length
    ? await whereItWent(admin, candidates, recordIds)
    : { allocations: [], remaining: 0, releasedFrom: null, members: new Set<string>() };
  const released = !!pay.charge_id && own != null && went.members.has(own);
  const onAccountByRecord = own != null && !pay.charge_id;

  // WHAT WENT BACK TO THE CARD — off this row and off the sibling, in one
  // read. A refund is its own row (park_refunds, 0142); the payment row
  // never changes, so nothing above could have said it. mustRead: a failed
  // read here would ask her to confirm $600 with no word that $40 of it is
  // back on her statement.
  const refundIds = [...(pay.id ? [String(pay.id)] : []), ...(sibling ? [sibling.id as string] : [])];
  const refundRows = refundIds.length
    ? (mustRead("what went back to your card", await admin
        .from("park_refunds")
        .select("payment_id, amount, fee_amount, created_at")
        .in("payment_id", refundIds)) ?? [])
    : [];
  // The rail each refund went back on is the refunded PAYMENT's — this row's
  // or the sibling's — so the page can say "your card" or "your bank
  // account" by the row, not by a fixed word.
  const railOf = (paymentId: unknown) =>
    String((sibling && String(sibling.id) === String(paymentId) ? sibling.method : pay.method) ?? "card");
  const sentBack = refundRows
    .map((r) => ({ amount: Number(r.amount ?? 0), fee: Number(r.fee_amount ?? 0), on: String(r.created_at ?? ""), method: railOf(r.payment_id) }))
    .sort((a, b) => a.on.localeCompare(b.on));

  // WHAT WENT BACK ACROSS THE WINDOW — the stamp on this row (a deposit
  // returned, or the row's own on-account money handed back) and on the
  // sibling (the $57.47 of a split handed back after the household left).
  // Already on the rows read above; nothing more to fetch.
  const handedBack = [handBackOf(pay), ...(sibling ? [handBackOf(sibling)] : [])]
    .filter((h): h is { amount: number; on: string; note: string | null } => h != null)
    .sort((a, b) => a.on.localeCompare(b.on));

  return {
    amount: Math.round((Number(pay.amount) + (onAccount ?? 0)) * 100) / 100,
    onAccount,
    onAccountApplied: went.allocations.length > 0,
    // The view's figure — over both rows on a released split — or null when
    // nothing of this receipt was ever on account.
    onAccountRemaining: sibling || onAccountByRecord || released ? went.remaining : null,
    allocations: went.allocations,
    siblingId: siblingStands ? (sibling!.id as string) : null,
    // The sibling's own standing, in the one derivation every reader of
    // these four fields shares (receipts-helpers).
    siblingTakenBackOn: sibling && !siblingStands ? notCollectedAt(takenBackOfRow(sibling)) : null,
    siblingTakenBackWhy: sibling && !siblingStands ? takenBackWhy(takenBackOfRow(sibling)) : null,
    sentBack,
    handedBack,
    released,
    releasedFrom: released ? went.releasedFrom : null,
  };
}

/**
 * WHETHER ANYTHING MORE WILL EVER BILL FOR THIS HOUSEHOLD — the ONE reader
 * (@/lib/tenancy-facts), read here for the one sentence it changes. This
 * page carried its own copy, and its copy said "still here" whenever any
 * held link existed — so a household closed out THROUGH their renewal (the
 * link before it approved/active, run out; the successor `ended`) was told
 * their $70.00 "comes off the next bill", a bill that will never come. The
 * shared reader asks the roll's own rule. Both facts read, neither assumed:
 * a failed read must not render "it comes off the next bill", so mustRead
 * throws inside it and the page says it couldn't load.
 */
async function nothingMoreBillsFor(
  admin: ReturnType<typeof createServiceClient>,
  renterId: string,
): Promise<boolean> {
  return nothingMoreBills((await tenancyFactsFor(admin, [renterId])).get(renterId));
}

export async function loadPaymentByToken(token: string): Promise<ConfirmView | null> {
  // Was `token.length < 12` — a length floor is not a shape check, so any
  // 12-character string reached `.eq()`. park_payments.confirm_token is minted
  // as 32 hex + 8 hex (park/ledger-actions.ts, park/money-actions.ts), so the
  // shared 32-char default fits it with room to spare.
  if (!isBearerToken(token)) return null;
  const admin = createServiceClient();

  // `return null` renders "This link doesn't match a payment" — a flat denial
  // that their receipt exists. Only say it when we actually looked.
  // reversed_at / returned_at / their reasons: the row's OWN standing. Every
  // other reader of park_payments filters these; this one must SHOW them,
  // because the page is the household's permanent record of the money.
  // returned_on / returned_amount / return_note: money from this row handed
  // back across the window — a deposit at move-out, rent on account after
  // they left — the same record, for the same reason.
  const pay = mustRead("your receipt", await admin
    .from("park_payments")
    .select("id, charge_id, park_id, renter_id, kind, amount, fee_amount, method, reference, received_on, receipt_no, renter_confirmed_at, idempotency_key, reversed_at, reversed_reason, returned_at, return_code, returned_on, returned_amount, return_note")
    .eq("confirm_token", token)
    .maybeSingle());
  if (!pay) return null;

  const { amount, onAccount, onAccountApplied, onAccountRemaining, allocations, siblingTakenBackOn, siblingTakenBackWhy, sentBack, handedBack, released, releasedFrom } = await wholeHandedOver(admin, pay);

  // A PAYMENT NEED NOT HAVE A CHARGE ANY MORE (0102). This resolved the park by
  // reading it OFF the charge and bailed when there wasn't one — so the
  // confirmation link minted for a deposit, or for a cheque handed over before
  // the bill existed, pointed at a "not found" page. The renter's own
  // confirmation is the only second party this ledger will ever have, and it
  // matters MOST for money with no bill to check it against.
  const charge = mustRead("the bill behind it", pay.charge_id
    ? await admin
        .from("park_charges").select("park_id, park_lot_id, renter_id").eq("id", pay.charge_id as string).maybeSingle()
    : { data: null, error: null });

  const parkId = (charge?.park_id as string) ?? (pay.park_id as string) ?? null;
  if (!parkId) return null;

  // Whether a next bill will ever come — read only while something is held,
  // because that is the only sentence it changes. The household is the
  // bill's, else the row's own (a cheque before its bill existed).
  const householdId = (charge?.renter_id as string | null) ?? (pay.renter_id as string | null) ?? null;
  const nothingMoreBills = (onAccountRemaining ?? 0) > 0 && householdId
    ? await nothingMoreBillsFor(admin, householdId)
    : false;

  const [parkRes, lotRes] = await Promise.all([
    admin.from("parks").select("name").eq("id", parkId).maybeSingle(),
    charge?.park_lot_id
      ? admin.from("park_lots").select("lot_number").eq("id", charge.park_lot_id as string).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  // "the park" and "?" are the fallbacks for rows that genuinely carry neither.
  // A failed read reaching them would print a receipt with the park's name
  // rubbed off, and ask somebody to agree to it.
  const park = mustRead("the park", parkRes);
  const lot = mustRead("the lot", lotRes);

  const parkName = (park?.name as string) ?? "the park";
  return {
    parkName,
    // A deposit or a cheque with no bill has no lot on the record. Say so
    // rather than printing "?" as though something were missing.
    lotNumber: (lot?.lot_number as string) ?? (pay.charge_id ? "?" : "—"),
    amount,
    onAccount,
    onAccountApplied,
    onAccountRemaining,
    allocations,
    whereItWent: describeAllocations(allocations, onAccountRemaining ?? 0),
    // The row's own standing — the one derivation (receipts-helpers), the
    // same words the statement's file and the resident's home screen use.
    takenBackOn: notCollectedAt(takenBackOfRow(pay)),
    takenBackWhy: takenBackWhy(takenBackOfRow(pay)),
    siblingTakenBackOn,
    siblingTakenBackWhy,
    sentBack,
    handedBack,
    releasedFrom,
    nothingMoreBills,
    // Keyed on a LIVE bill, exactly as disputeByToken refuses: a claim needs
    // a charge to hang on, and money on account or a deposit has none — even
    // when the money has since been put against bills, because 0167's
    // settle_claims_on_allocation would close a claim on that bill the moment
    // the office re-applied during its own look. A released row's bill is
    // void (0169): a claim on it would sit where no screen lists it. Widening
    // claims to hang off a payment is the owner's call, not this page's.
    canDispute: !!pay.charge_id && !released,
    // Asking "does this match what you handed over?" while showing a figure
    // smaller than the one on their bank statement invites a dispute we caused.
    fee: pay.fee_amount == null ? null : Number(pay.fee_amount),
    method: METHOD_WORD[pay.method as string] ?? (pay.method as string),
    reference: (pay.reference as string) ?? null,
    receivedOn: pay.received_on as string,
    ref: receiptRef(parkName, (pay.receipt_no as number) ?? null, pay.received_on as string),
    alreadyConfirmedAt: (pay.renter_confirmed_at as string) ?? null,
  };
}

/**
 * "Yes, that's right." Recorded as the renter's act, not the park's.
 *
 * BOTH HALVES OR NEITHER. The page asked whether $600 matches what she
 * handed over; her "yes" is about $600. This stamped the bill row alone, so
 * the $57.47 sibling — the row the office later moves to February, and the
 * one most likely to be argued about — sat in park_payments_unconfirmed_idx
 * (0077) with no account of how it was given. One update over both ids, so
 * the record cannot say she confirmed half of what she was shown. A sibling
 * already confirmed on its own (a reversed one is never returned) keeps its
 * stamp: the update touches only rows still unconfirmed.
 */
export async function confirmByToken(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const payRes = await admin
    .from("park_payments")
    .select("id, charge_id, amount, idempotency_key, renter_confirmed_at")
    .eq("confirm_token", token)
    .maybeSingle();
  if (payRes.error) return { ok: false, error: readFailedMessage("your receipt", payRes.error) };
  const pay = payRes.data;
  if (!pay) return { ok: false, error: "This link doesn't match a payment." };
  // Confirming twice is not an error — people tap links twice.
  if (pay.renter_confirmed_at) return { ok: true };

  // A failed sibling read refuses rather than stamping the bill's share as
  // the whole — that is the half-confirmation this exists to prevent.
  let whole: { siblingId: string | null };
  try {
    whole = await wholeHandedOver(admin, pay);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("the rest of that payment", e) };
  }

  const ids = [pay.id as string, ...(whole.siblingId ? [whole.siblingId] : [])];
  const { error } = await admin
    .from("park_payments")
    .update({ renter_confirmed_at: new Date().toISOString(), renter_confirmed_via: "link" })
    .in("id", ids)
    .is("renter_confirmed_at", null);
  if (error) return { ok: false, error: "That didn't save — try again." };
  return { ok: true };
}

/**
 * "That's not what I paid."
 *
 * Files a claim against the BILL rather than editing the payment. The renter is
 * not given the power to rewrite the park's record — nobody should have that
 * unilaterally — but the disagreement now exists, the charge reads as disputed,
 * and the reminders stop until a person has looked at it.
 */
export async function disputeByToken(
  token: string,
): Promise<{ ok: boolean; error?: string; unsupported?: boolean }> {
  const admin = createServiceClient();
  const payRes = await admin
    .from("park_payments").select("id, charge_id, park_id, amount, method, received_on, receipt_no, idempotency_key, returned_on, returned_amount, return_note").eq("confirm_token", token).maybeSingle();
  if (payRes.error) return { ok: false, error: readFailedMessage("your receipt", payRes.error) };
  const pay = payRes.data;
  if (!pay) return { ok: false, error: "This link doesn't match a payment." };

  // `park_payment_claims.charge_id` is NOT NULL, so a disagreement about money
  // with no bill behind it — a deposit, or a cheque taken before the bill
  // existed — has nowhere to be recorded, EVEN once the run has put that
  // money against bills: a claim on those bills would be closed as "matched"
  // by settle_claims_on_allocation (0167) the moment the office re-applied
  // during its own look. The page no longer offers the button for these
  // (`canDispute`), so this answers only a crafted POST — and it is a
  // by-design refusal, not a failed write, which `unsupported` says so the
  // page does not title it "We couldn't save that". Widening the claims
  // table to hang off a payment is the owner's call.
  // The reference the paper and the page print, not the bare number.
  const refForOffice = async () => {
    const parkRes = await admin.from("parks").select("name").eq("id", pay.park_id as string).maybeSingle();
    return !parkRes.error && parkRes.data?.name && pay.receipt_no != null
      ? receiptRef(String(parkRes.data.name), pay.receipt_no as number, String(pay.received_on ?? ""))
      : pay.receipt_no != null ? String(pay.receipt_no) : "on this page";
  };
  if (!pay.charge_id) {
    return {
      ok: false,
      unsupported: true,
      error: `This one was recorded as money on account or a deposit, and that can't be flagged from this link yet. Ring the office and quote receipt ${await refForOffice()} — they can log it for you.`,
    };
  }

  // THE FIGURE SHE WAS SHOWN. The page said $600 (bill share + on account);
  // the claim must say $600, or the office reads a dispute about a number
  // nobody printed. A failed sibling read refuses rather than filing the
  // bill's share as the whole — that would write the very lie this fixes into
  // the claim log, where nothing later corrects it.
  let whole: Awaited<ReturnType<typeof wholeHandedOver>>;
  try {
    whole = await wholeHandedOver(admin, pay);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("the rest of that payment", e) };
  }

  // THE BILL IS VOID (0169): the money was released onto account, and a
  // claim against a cancelled bill is one the rent screen never lists while
  // the machine counts it toward the chase. The page hides the button
  // (`canDispute`); this answers a stray POST the same way an on-account
  // link is answered — by design, not a failed write.
  if (whole.released) {
    const month = whole.releasedFrom ? `${prettyMonth(whole.releasedFrom.month)} bill` : "bill";
    return {
      ok: false,
      unsupported: true,
      error: `The ${month} this paid was cancelled, so this money is on account with the office now, and that can't be flagged from this link yet. Ring the office and quote receipt ${await refForOffice()} — they can log it for you.`,
    };
  }

  const openRes = await admin
    .from("park_payment_claims")
    .select("id")
    .eq("charge_id", pay.charge_id as string)
    .is("resolved_at", null)
    .maybeSingle();
  // FAILS OPEN IF LEFT ALONE. This is the don't-stack-duplicates guard, and a
  // failed read looks exactly like "nothing flagged yet" — so a dropped
  // connection files a second claim against the same bill.
  if (openRes.error) return { ok: false, error: readFailedMessage("what's already flagged", openRes.error) };
  const open = openRes.data;
  if (open) return { ok: true }; // already flagged; don't stack duplicates

  const { error } = await admin.from("park_payment_claims").insert({
    charge_id: pay.charge_id,
    asserted_by: "renter",
    note:
      `They say the receipt is wrong — it records ${money(whole.amount)} ` +
      `taken on ${longDate(pay.received_on as string)}` +
      // Where the rest sits, as of the day she taps — a claim note is never
      // corrected later, so it must not say "on account" about money the
      // office has already put against a bill.
      (whole.onAccount == null
        ? ""
        : whole.siblingTakenBackOn
          // The office has already taken that half back: it is not on
          // account and not on a bill, and the note must not say either.
          ? ` (${money(whole.onAccount)} of it had gone on account and was taken back on ${longDate(whole.siblingTakenBackOn)}${whole.siblingTakenBackWhy ? ` — ${whole.siblingTakenBackWhy}` : ""})`
          : whole.onAccountApplied
            ? ` (${money(whole.onAccount)} of it on account: ${describeAllocations(whole.allocations, whole.onAccountRemaining ?? 0)})`
            : ` (${money(whole.onAccount)} of it on account with the office)`) +
      // What has gone back since — through the processor, or across the
      // window — a claim note is never corrected later, and a dispute about
      // $600 of which $40 is back on her statement must say so.
      whole.sentBack.map((r) => ` (${money(r.amount)} of it was sent back to their ${r.method === "ach" ? "bank account" : "card"} on ${longDate(r.on)})`).join("") +
      whole.handedBack.map((h) => ` (${money(h.amount)} of it was handed back to them on ${longDate(h.on)})`).join("") +
      `. Raised from their own confirmation link.`,
  });
  if (error) return { ok: false, error: "That didn't save — try again." };
  return { ok: true };
}
