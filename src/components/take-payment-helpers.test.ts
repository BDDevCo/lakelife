import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PaymentTarget } from "@/app/park/pos-actions";
import type { ReceiptLines } from "@/app/park/receipt-helpers";
import { onAccountPromise } from "@/app/park/ledger-helpers";
import {
  FILTER_FROM, owedWords, prefillAmount, parseAmount, amountNote, noteNamesHeldDoor, disputedNote,
  receivedOnProblem, filterTargets, confirmationHeadline, recordedWords,
  outcomeFromBill, outcomeFromAccount, rememberedMethod, rememberMethod, mintKey,
  type Outcome,
} from "./take-payment-helpers";

/**
 * EVERY SENTENCE THE ⊕ TAKE A PAYMENT WINDOW SAYS, pinned both ways — and
 * the mapping from a door's result to the words on the card, which used to
 * be an inline expression in a click handler no static render ever fires.
 */

const bill = (over: Partial<PaymentTarget> = {}): PaymentTarget => ({
  renterId: "renter-14", lotNumber: "14", name: "Jane Smith", openCount: 1,
  oldestOpen: { chargeId: "jan", month: "2027-01", balance: 542.53, disputed: false },
  onAccount: 0, nothingMoreBills: false,
  ...over,
});
const none: PaymentTarget = {
  renterId: "renter-2", lotNumber: "2", name: "Bob Jones", openCount: 0, oldestOpen: null, onAccount: 0, nothingMoreBills: false,
};
/** Moved out, final month billed: nothing more will ever bill for them. */
const gone = (over: Partial<PaymentTarget> = {}): PaymentTarget => ({ ...none, lotNumber: "—", nothingMoreBills: true, ...over });
/** Whether anything more bills could not be read. */
const unknown = (over: Partial<PaymentTarget> = {}): PaymentTarget => ({ ...none, nothingMoreBills: null, ...over });
const DOOR = `"Money not against a bill"`;

describe("owedWords", () => {
  it("names the oldest bill and its balance", () => {
    expect(owedWords(bill())).toBe("Owes $542.53 for January 2027");
  });
  it("says how many are open when there is more than one", () => {
    expect(owedWords(bill({ openCount: 3 }))).toBe("Owes $542.53 for January 2027 — oldest of 3 open bills");
  });
  it("says when they have told the office they paid it", () => {
    expect(owedWords(bill({ openCount: 3, oldestOpen: { chargeId: "jan", month: "2027-01", balance: 542.53, disputed: true } })))
      .toBe("Owes $542.53 for January 2027 — oldest of 3 open bills · they say they've paid it");
  });
  it("says where money goes when nothing is owed", () => {
    expect(owedWords(none)).toBe("Nothing owed — goes on account");
  });
  it("names money of theirs the office already holds, on both shapes of row — and not when there is none", () => {
    expect(owedWords(bill({ onAccount: 542.53 }))).toBe("Owes $542.53 for January 2027 · $542.53 of theirs is on account");
    expect(owedWords(bill({ openCount: 3, onAccount: 200, oldestOpen: { chargeId: "jan", month: "2027-01", balance: 542.53, disputed: true } })))
      .toBe("Owes $542.53 for January 2027 — oldest of 3 open bills · they say they've paid it · $200.00 of theirs is on account");
    expect(owedWords({ ...none, onAccount: 57.47 })).toBe("Nothing owed — goes on account · $57.47 of theirs is on account");
    expect(owedWords(bill({ onAccount: 0 }))).not.toMatch(/on account/);
  });
});

describe("prefillAmount and parseAmount", () => {
  it("fills the balance to the cent, or nothing", () => {
    expect(prefillAmount(bill({ oldestOpen: { chargeId: "jan", month: "2027-01", balance: 342.53, disputed: false } }))).toBe("342.53");
    expect(prefillAmount(none)).toBe("");
  });
  it("strips the sign, comma and spaces the way ParkRent does", () => {
    expect(parseAmount("$1,085.06")).toBe(1085.06);
    expect(parseAmount(" 542.53 ")).toBe(542.53);
    expect(Number.isNaN(parseAmount("abc"))).toBe(true);
  });
});

describe("amountNote", () => {
  it("is silent on an empty box when a bill is owed — and says on account before they type when none is", () => {
    expect(amountNote("", bill())).toBeNull();
    expect(amountNote("   ", bill())).toBeNull();
    expect(amountNote("", none)).toBe("Nothing is owed, so this goes on account and comes off the next bill you raise for them.");
    expect(amountNote("0", none)).toBe("That payment amount needs to be more than zero.");
  });
  it("reads the door's own refusals before the tap", () => {
    expect(amountNote("0", bill())).toBe("That payment amount needs to be more than zero.");
    expect(amountNote("-5", bill())).toBe("That payment amount needs to be more than zero.");
    expect(amountNote("abc", bill())).toBe("That payment amount isn't a number.");
    expect(amountNote("0.004", bill())).toBe("That payment amount is less than a cent.");
  });
  it("equal settles the month — 542.53 against 542.53 is equal, not over", () => {
    expect(amountNote("542.53", bill())).toBe("Settles January 2027.");
    expect(amountNote("$542.53", bill())).toBe("Settles January 2027.");
  });
  it("less is a part payment, and says what will still be owing", () => {
    expect(amountNote("342.53", bill())).toBe("Part of January 2027 — $200.00 will still be owing.");
  });
  it("more goes on account when this is their only open bill — and names the month it comes off, the one the door's toast names", () => {
    expect(amountNote("600", bill())).toBe("$542.53 settles January 2027; the other $57.47 goes on account and comes off February 2027 when you raise it.");
    // December's excess comes off January: the month after THIS bill, whatever today is.
    expect(amountNote("600", bill({ oldestOpen: { chargeId: "dec", month: "2026-12", balance: 542.53, disputed: false } })))
      .toBe("$542.53 settles December 2026; the other $57.47 goes on account and comes off January 2027 when you raise it.");
  });
  it("more goes against their next open bill when they have another — money on account settles it now", () => {
    expect(amountNote("1085.06", bill({ openCount: 2 })))
      .toBe("$542.53 settles January 2027; the other $542.53 goes against their next open bill.");
    expect(amountNote("1085.06", bill({ openCount: 2 }))).not.toMatch(/on account/);
  });
  it("nothing owed goes on account", () => {
    expect(amountNote("200", none)).toBe("Nothing is owed, so this goes on account and comes off the next bill you raise for them.");
  });

  // THE PROMISE, KEYED ON THE FACT — never on the dash. A household on no lot
  // whose final month is not yet billed (moved out on the 2nd, before the
  // run) still gets a next bill, and the promise is TRUE for them.
  describe("'comes off their next bill' is said only when a next bill is coming", () => {
    it("nothing owed, nothing more bills: theirs to have back — no 'comes off', and the door named", () => {
      const note = amountNote("", gone());
      expect(note).toBe(`Nothing is owed, so this goes on account — nothing more bills for them, so it's theirs to have back from ${DOOR} on the Rent screen.`);
      expect(note).not.toMatch(/comes off/);
      expect(amountNote("200", gone())).toBe(note);
      expect(noteNamesHeldDoor(note)).toBe(true);
    });
    it("nothing owed, on no lot but a bill still to come: the promise stands", () => {
      const note = amountNote("200", gone({ nothingMoreBills: false }));
      expect(note).toBe("Nothing is owed, so this goes on account and comes off the next bill you raise for them.");
      expect(noteNamesHeldDoor(note)).toBe(false);
    });
    it("nothing owed, fact unknown: no promise either way", () => {
      const note = amountNote("200", unknown());
      expect(note).toBe("Nothing is owed, so this goes on account.");
      expect(note).not.toMatch(/comes off|theirs to have back/);
    });
    it("over-payment on the only open bill, nothing more bills: the excess is theirs to have back", () => {
      const t = gone({ oldestOpen: bill().oldestOpen, openCount: 1 });
      const note = amountNote("600", t);
      expect(note).toBe(`$542.53 settles January 2027; the other $57.47 goes on account — nothing more bills for them, so it's theirs to have back from ${DOOR} on the Rent screen.`);
      expect(note).not.toMatch(/comes off/);
      // On no lot with the final month NOT billed, the same over-payment keeps the promise.
      expect(amountNote("600", bill({ lotNumber: "—", nothingMoreBills: false })))
        .toBe("$542.53 settles January 2027; the other $57.47 goes on account and comes off February 2027 when you raise it.");
      expect(amountNote("600", bill({ nothingMoreBills: null })))
        .toBe("$542.53 settles January 2027; the other $57.47 goes on account.");
    });
    it("with another bill open the excess goes against it now, whatever the tenancy", () => {
      expect(amountNote("1085.06", gone({ oldestOpen: bill().oldestOpen, openCount: 2 })))
        .toBe("$542.53 settles January 2027; the other $542.53 goes against their next open bill.");
    });
  });

  // MONEY OF THEIRS ALREADY IN THE OFFICE — the state after a line was taken
  // off a bill or a paid month cancelled (no auto-settle). What recordPayment
  // does with it is settleOnAccount, run inside the door after the insert.
  describe("money they already have on account", () => {
    it("the exact amount: says the held money would cover this, what recording leaves held, and the door that uses it instead", () => {
      const note = amountNote("542.53", bill({ onAccount: 542.53 }));
      expect(note).toBe(`Settles January 2027. $542.53 of theirs is already on account and would cover this — record this and that stays on account and comes off the next bill you raise for them; to use it on this bill instead, put it on the bill from ${DOOR}.`);
      expect(noteNamesHeldDoor(note)).toBe(true);
      // Never turns the money away.
      expect(note).not.toMatch(/instead of taking/);
    });
    it("held money short of the bill does not 'cover' it", () => {
      expect(amountNote("542.53", bill({ onAccount: 200 })))
        .toBe(`Settles January 2027. $200.00 of theirs is already on account — record this and that stays on account and comes off the next bill you raise for them; to use it on this bill instead, put it on the bill from ${DOOR}.`);
    });
    it("with another bill open the held money goes against THAT one the moment this is recorded", () => {
      expect(amountNote("542.53", bill({ onAccount: 542.53, openCount: 2 })))
        .toBe(`Settles January 2027. $542.53 of theirs is already on account and would cover this — record this and that goes against their next open bill instead; to use it on this bill instead, put it on the bill from ${DOOR}.`);
    });
    it("what is left held is keyed on the tenancy fact — theirs to have back, or no promise", () => {
      expect(amountNote("542.53", bill({ onAccount: 542.53, nothingMoreBills: true })))
        .toBe(`Settles January 2027. $542.53 of theirs is already on account and would cover this — record this and that stays on account — nothing more bills for them, so it's theirs to have back from ${DOOR} on the Rent screen; to use it on this bill instead, put it on the bill from ${DOOR}.`);
      expect(amountNote("542.53", bill({ onAccount: 542.53, nothingMoreBills: true }))).not.toMatch(/comes off/);
      expect(amountNote("542.53", bill({ onAccount: 542.53, nothingMoreBills: null })))
        .toBe(`Settles January 2027. $542.53 of theirs is already on account and would cover this — record this and that stays on account; to use it on this bill instead, put it on the bill from ${DOOR}.`);
    });
    it("a part payment: the rest comes off the held money the moment Record is tapped — never 'will still be owing'", () => {
      const note = amountNote("300", bill({ onAccount: 542.53 }));
      expect(note).toBe("Part of January 2027 — the other $242.53 comes off the $542.53 they have on account the moment you record this.");
      expect(note).not.toMatch(/still be owing/);
      // Exactly enough held is still "the other $242.53 comes off" — no "leaving".
      expect(amountNote("300", bill({ onAccount: 242.53 })))
        .toBe("Part of January 2027 — the other $242.53 comes off the $242.53 they have on account the moment you record this.");
    });
    it("a part payment with too little held: what comes off, and what is then still owing", () => {
      expect(amountNote("300", bill({ onAccount: 100 })))
        .toBe("Part of January 2027 — the $100.00 they have on account comes off it the moment you record this, leaving $142.53 still owing.");
    });
    it("with nothing held, the part-payment sentence is unchanged", () => {
      expect(amountNote("300", bill({ onAccount: 0 }))).toBe("Part of January 2027 — $242.53 will still be owing.");
    });
    it("an over-payment names the held money and the door beside the split", () => {
      expect(amountNote("600", bill({ onAccount: 542.53 })))
        .toBe(`$542.53 settles January 2027; the other $57.47 goes on account and comes off February 2027 when you raise it. $542.53 of theirs is already on account; to use it on this bill instead, put it on the bill from ${DOOR}.`);
      expect(amountNote("1085.06", bill({ onAccount: 200, openCount: 2 })))
        .toBe("$542.53 settles January 2027; the other $542.53 goes against their next open bill. So does the $200.00 of theirs already on account.");
    });
    it("the exact-amount and over sentences are unchanged with nothing held", () => {
      expect(amountNote("542.53", bill({ onAccount: 0 }))).toBe("Settles January 2027.");
      expect(noteNamesHeldDoor(amountNote("542.53", bill({ onAccount: 0 })))).toBe(false);
      expect(noteNamesHeldDoor(null)).toBe(false);
    });
  });
});

/**
 * THE PROMISE IS THE SHARED HELPER'S, WORD FOR WORD. The note before the
 * tap and the two doors' toasts after it used to carry their own copies,
 * and the toasts' were unconditional — "comes off the next bill you raise
 * for them" to a household nothing more bills for, under a note that had
 * just said "theirs to have back". Every sentence here that makes the
 * promise contains onAccountPromise's clause for the same fact, and this
 * file holds no private copy of its words.
 */
describe("the promise under the amount is onAccountPromise's, not this file's", () => {
  const contains = (note: string | null, clause: string) => {
    expect(clause, "an empty clause would match anything").not.toBe("");
    expect(note).toContain(clause);
  };

  it("nothing owed, every shape of the fact", () => {
    contains(amountNote("200", none), onAccountPromise(false));
    contains(amountNote("200", gone()), onAccountPromise(true));
    expect(amountNote("200", unknown())).toBe(`Nothing is owed, so this goes on account${onAccountPromise(null)}.`);
  });

  it("an over-payment on the only open bill: the month after the bill, the way recordPayment's toast says it", () => {
    contains(amountNote("600", bill()), onAccountPromise(false, { next: "February 2027" }));
    contains(amountNote("600", gone({ oldestOpen: bill().oldestOpen, openCount: 1 })), onAccountPromise(true));
    expect(amountNote("600", bill({ nothingMoreBills: null }))).toBe(`$542.53 settles January 2027; the other $57.47 goes on account${onAccountPromise(null)}.`);
  });

  it("what stays held when they already have money on account", () => {
    contains(amountNote("542.53", bill({ onAccount: 542.53 })), onAccountPromise(false));
    contains(amountNote("542.53", bill({ onAccount: 542.53, nothingMoreBills: true })), onAccountPromise(true));
  });

  it("this file imports the helper and carries no copy of its words", () => {
    const src = readFileSync(fileURLToPath(new URL("./take-payment-helpers.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/onAccountPromise/);
    expect(src).toMatch(/from "@\/app\/park\/ledger-helpers"/);
    // The scanner can see the words it is looking for: the clause it must NOT find here IS in the helper.
    expect(onAccountPromise(true)).toMatch(/nothing more bills for them/);
    expect(onAccountPromise(false)).toMatch(/comes off the next bill/);
    expect(src).not.toMatch(/nothing more bills for them/);
    expect(src).not.toMatch(/comes off the next bill|comes off their next bill/);
    expect(src).not.toMatch(/function afterwards/);
  });
});

describe("disputedNote", () => {
  it("says what Record does to their claim, and where to go if the money is for another month", () => {
    expect(disputedNote(bill({ oldestOpen: { chargeId: "jan", month: "2027-01", balance: 542.53, disputed: true } })))
      .toBe("Recording this marks their 'I paid January 2027' claim as answered. If this money is for a different month, record it from the rent screen.");
  });
  it("is silent when nothing is disputed, or nothing is owed", () => {
    expect(disputedNote(bill())).toBeNull();
    expect(disputedNote(none)).toBeNull();
  });
});

describe("receivedOnProblem", () => {
  it("allows today and earlier, refuses tomorrow", () => {
    expect(receivedOnProblem("2027-01-06", "2027-01-06")).toBeNull();
    expect(receivedOnProblem("2027-01-05", "2027-01-06")).toBeNull();
    expect(receivedOnProblem("2027-01-07", "2027-01-06")).toBe("Money in hand came in today or earlier — pick that day.");
  });
});

describe("filterTargets", () => {
  const rows = [
    bill({ renterId: "r1", lotNumber: "1", name: "Alice Adams" }),
    bill({ renterId: "r14", lotNumber: "14", name: "Jane Smith" }),
    bill({ renterId: "r2", lotNumber: "2", name: "Bob Jones" }),
    bill({ renterId: "rx", lotNumber: "—", name: "Carol Smithson" }),
  ];
  it("empty shows everybody", () => {
    expect(filterTargets(rows, "")).toHaveLength(4);
    expect(filterTargets(rows, "  ")).toHaveLength(4);
  });
  it("'14' finds Lot 14 and not Lot 1", () => {
    expect(filterTargets(rows, "14").map((t) => t.renterId)).toEqual(["r14"]);
  });
  it("'1' finds Lot 1 and Lot 14 — a prefix — but not Lot 2", () => {
    expect(filterTargets(rows, "1").map((t) => t.renterId)).toEqual(["r1", "r14"]);
  });
  it("'lot 14' works because that is how he says it", () => {
    expect(filterTargets(rows, "lot 14").map((t) => t.renterId)).toEqual(["r14"]);
    expect(filterTargets(rows, "Lot 14").map((t) => t.renterId)).toEqual(["r14"]);
  });
  it("a name matches anywhere, case-insensitively", () => {
    expect(filterTargets(rows, "smi").map((t) => t.renterId)).toEqual(["r14", "rx"]);
    expect(filterTargets(rows, "JONES").map((t) => t.renterId)).toEqual(["r2"]);
  });
  it("nobody matches nonsense", () => {
    expect(filterTargets(rows, "zzz")).toEqual([]);
  });
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  path: "bill", amount: 600, name: "Jane Smith", month: "2027-01",
  against: 542.53, onAccount: 57.47, balanceAfter: 0, wentSomewhere: false,
  ...over,
});

describe("confirmationHeadline", () => {
  it("names both figures of a split", () => {
    expect(confirmationHeadline(outcome())).toBe("$600.00 received — $542.53 against January 2027; $57.47 on account.");
  });
  it("stops at what went against this bill when the excess already went onto another — never 'on account' over 'nothing stays on account'", () => {
    const h = confirmationHeadline(outcome({ amount: 1085.06, onAccount: 542.53, wentSomewhere: true }));
    expect(h).toBe("$1,085.06 received — $542.53 against January 2027.");
    expect(h).not.toMatch(/on account/);
  });
  it("says what is still outstanding after a part payment, in the door's word", () => {
    expect(confirmationHeadline(outcome({ amount: 342.53, against: 342.53, onAccount: 0, balanceAfter: 200 })))
      .toBe("$342.53 received against January 2027 — $200.00 still outstanding.");
  });
  it("says settled when nothing is left", () => {
    expect(confirmationHeadline(outcome({ amount: 542.53, against: 542.53, onAccount: 0, balanceAfter: 0 })))
      .toBe("$542.53 received against January 2027 — that one's settled.");
    expect(confirmationHeadline(outcome({ amount: 542.53, against: 542.53, onAccount: 0, balanceAfter: null })))
      .toBe("$542.53 received against January 2027 — that one's settled.");
  });
  it("says the bill was already settled when nothing went against it", () => {
    expect(confirmationHeadline(outcome({ amount: 100, against: 0, onAccount: 100 })))
      .toBe("$100.00 received — January 2027 was already settled, so all of it is on account.");
  });
  it("composes nothing on the account path — the door's sentence leads", () => {
    expect(confirmationHeadline(outcome({ path: "account", month: null, against: 0, onAccount: 200, amount: 200 }))).toBeNull();
  });
});

describe("recordedWords", () => {
  it("bill path: the composed headline over the door's full sentence", () => {
    const w = recordedWords(outcome(), "$600.00 received — $542.53 against January 2027, $57.47 on account. It comes off February 2027 when you raise it.");
    expect(w.headline).toBe("$600.00 received — $542.53 against January 2027; $57.47 on account.");
    expect(w.detail).toBe("$600.00 received — $542.53 against January 2027, $57.47 on account. It comes off February 2027 when you raise it.");
  });
  it("account path: the door's first sentence, then the rest", () => {
    const w = recordedWords(
      outcome({ path: "account", month: null, against: 0, onAccount: 200, amount: 200 }),
      "$200.00 recorded for Jane Smith. It's on account and comes off the next bill you raise for them — or put it against an open bill now from \"Money not against a bill\".",
    );
    expect(w.headline).toBe("$200.00 recorded for Jane Smith.");
    expect(w.detail).toBe("It's on account and comes off the next bill you raise for them — or put it against an open bill now from \"Money not against a bill\".");
  });
  it("account path with a one-sentence signal: all headline, no detail", () => {
    const w = recordedWords(outcome({ path: "account" }), "Recorded.");
    expect(w).toEqual({ headline: "Recorded.", detail: "" });
  });
});

const lines = (over: Partial<ReceiptLines> = {}): ReceiptLines => ({
  parkName: "P", officeLine: "", receiptNo: 7, feeAmount: null, lotNumber: "14", payerName: "Jane Smith",
  amount: 600, method: "check", reference: null, receivedOn: "2027-01-06", periodMonth: "2027-01",
  billAmount: 542.53, balanceAfter: 0, onAccount: null, confirmUrl: null,
  ...over,
});

describe("outcomeFromBill — the caller's mapping, both ways on every field", () => {
  it("reads the door's split, the receipt's month and balance, and the signal", () => {
    const d = outcomeFromBill(
      { ok: true, against: 542.53, onAccount: 57.47, signal: "sig", renterEmail: "j@x.com", receipt: lines({ balanceAfter: 0, onAccount: { amount: 57.47, receiptNo: 8 } }) },
      bill(), 600,
    );
    expect(d.outcome).toEqual({
      path: "bill", amount: 600, name: "Jane Smith", month: "2027-01",
      against: 542.53, onAccount: 57.47, balanceAfter: 0, wentSomewhere: false,
    });
    expect(d.signal).toBe("sig");
    expect(d.renterEmail).toBe("j@x.com");
    expect(d.receipt?.receiptNo).toBe(7);
  });
  it("wentSomewhere is the receipt's appliedTo, non-empty", () => {
    const d = outcomeFromBill(
      { ok: true, against: 542.53, onAccount: 542.53, receipt: lines({ onAccount: { amount: 542.53, receiptNo: 8, appliedTo: [{ periodMonth: "2027-02", amount: 542.53 }] } }) },
      bill(), 1085.06,
    );
    expect(d.outcome.wentSomewhere).toBe(true);
    const e = outcomeFromBill(
      { ok: true, against: 542.53, onAccount: 542.53, receipt: lines({ onAccount: { amount: 542.53, receiptNo: 8, appliedTo: [] } }) },
      bill(), 1085.06,
    );
    expect(e.outcome.wentSomewhere).toBe(false);
  });
  it("against undefined reads as 0; 0 stays 0; a figure stays itself", () => {
    expect(outcomeFromBill({ ok: true }, bill(), 100).outcome.against).toBe(0);
    expect(outcomeFromBill({ ok: true, against: 0, onAccount: 100 }, bill(), 100).outcome.against).toBe(0);
    expect(outcomeFromBill({ ok: true, against: 100, onAccount: 0 }, bill(), 100).outcome.against).toBe(100);
  });
  it("no receipt: the month is the list's, the balance is unknown, nothing went anywhere", () => {
    const d = outcomeFromBill({ ok: true, against: 342.53, onAccount: 0 }, bill(), 342.53);
    expect(d.outcome.month).toBe("2027-01");
    expect(d.outcome.balanceAfter).toBeNull();
    expect(d.outcome.wentSomewhere).toBe(false);
    expect(d.receipt).toBeNull();
    expect(d.renterEmail).toBeNull();
    expect(d.signal).toBe("Recorded.");
  });
  it("a receipt with an empty month falls back to the list's", () => {
    const d = outcomeFromBill({ ok: true, receipt: lines({ periodMonth: "" }) }, bill(), 100);
    expect(d.outcome.month).toBe("2027-01");
  });
});

describe("outcomeFromAccount", () => {
  it("is the account path, all of it on account, with the receipt's appliedTo both ways", () => {
    const a = outcomeFromAccount(
      { ok: true, signal: "sig", renterEmail: null, receipt: lines({ kind: "on_account", onAccount: { amount: 200, receiptNo: 9, appliedTo: [{ periodMonth: "2027-01", amount: 200 }] } }) },
      none, 200,
    );
    expect(a.outcome).toEqual({
      path: "account", amount: 200, name: "Bob Jones", month: null,
      against: 0, onAccount: 200, balanceAfter: null, wentSomewhere: true,
    });
    expect(a.signal).toBe("sig");
    expect(a.receipt?.kind).toBe("on_account");
    expect(a.renterEmail).toBeNull();
    const b = outcomeFromAccount({ ok: true, receipt: lines({ kind: "on_account", onAccount: { amount: 200, receiptNo: 9, appliedTo: [] } }) }, none, 200);
    expect(b.outcome.wentSomewhere).toBe(false);
    const c = outcomeFromAccount({ ok: true }, none, 200);
    expect(c.outcome.wentSomewhere).toBe(false);
    expect(c.receipt).toBeNull();
    expect(c.signal).toBe("Recorded.");
  });
});

describe("rememberedMethod", () => {
  const g = globalThis as { sessionStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  afterEach(() => {
    if (had) Object.defineProperty(globalThis, "sessionStorage", had);
    else delete g.sessionStorage;
  });
  const stub = (store: Record<string, string>) =>
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
    });

  it("is check with no storage at all", () => {
    delete g.sessionStorage;
    expect(rememberedMethod()).toBe("check");
  });
  it("is the last method recorded in this tab", () => {
    stub({ "ll-pos-method": "cash" });
    expect(rememberedMethod()).toBe("cash");
  });
  it("never a processor rail, whatever is stored", () => {
    stub({ "ll-pos-method": "card" });
    expect(rememberedMethod()).toBe("check");
    stub({ "ll-pos-method": "ach" });
    expect(rememberedMethod()).toBe("check");
  });
  it("is check when storage throws", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } },
    });
    expect(rememberedMethod()).toBe("check");
    expect(() => rememberMethod("cash")).not.toThrow();
  });
  it("rememberMethod writes what rememberedMethod reads", () => {
    const store: Record<string, string> = {};
    stub(store);
    rememberMethod("transfer");
    expect(store["ll-pos-method"]).toBe("transfer");
    expect(rememberedMethod()).toBe("transfer");
  });
});

describe("the constants", () => {
  it("the filter box appears from nine households", () => {
    expect(FILTER_FROM).toBe(9);
  });
  it("mintKey mints something different each time", () => {
    expect(mintKey()).not.toBe(mintKey());
    const spy = vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
    expect(mintKey()).toBe("00000000-0000-4000-8000-000000000000");
    spy.mockRestore();
  });
});
