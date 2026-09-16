import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { monthPeriod, quarterPeriod, yearPeriod, customPeriod, inPeriod, summariseReceipts, receiptsCsv, receiptsFilename, receiptsHeadline, csvText, linesCell, money, decimal, exclusionLines, handedBackWhere, onAccountKindLabel, otherKindLabel, isOnAccountRow, appliedToCell, billStatusCell, takenBackCells, notCollectedAt, takenBackWhy, takenBackOfRow, METHOD_LABEL, type Receipt, type OtherReceipt } from "./receipts-helpers";
import { METHOD_WORD } from "./receipt-helpers";

const TODAY = "2026-08-11";

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    paymentId: "p1",
    chargeId: "c1",
    amountCents: 45500,
    feeCents: 0,
    method: "check",
    reference: "1042",
    receivedOn: "2026-07-03",
    reversedAt: null,
    reversedReason: null,
    bankReturnedAt: null,
    returnCode: null,
    lotNumber: "3",
    payerName: "Roy Amberg",
    periodMonth: "2026-07",
    chargeAmountCents: 45500,
    chargeStatus: "paid",
    chargeLines: [
      { label: "Lot rent", amountCents: 39500 },
      { label: "Grounds fee", amountCents: 6000 },
    ],
    ...over,
  };
}

const JULY = monthPeriod("2026-07", TODAY)!;

describe("periods", () => {
  it("month runs first to last day, leap year included", () => {
    expect(monthPeriod("2026-02", TODAY)!.to).toBe("2026-02-28");
    expect(monthPeriod("2028-02", TODAY)!.to).toBe("2028-02-29");
    expect(monthPeriod("2026-04", TODAY)!.to).toBe("2026-04-30");
  });

  it("quarters and years cover the right spans", () => {
    expect(quarterPeriod(2026, 1, TODAY).from).toBe("2026-01-01");
    expect(quarterPeriod(2026, 1, TODAY).to).toBe("2026-03-31");
    expect(quarterPeriod(2026, 4, TODAY).to).toBe("2026-12-31");
    expect(yearPeriod(2026, TODAY).from).toBe("2026-01-01");
    expect(yearPeriod(2026, TODAY).to).toBe("2026-12-31");
  });

  it("a window reaching today or beyond is OPEN — more may still come in", () => {
    expect(monthPeriod("2026-08", TODAY)!.open).toBe(true);
    expect(monthPeriod("2026-07", TODAY)!.open).toBe(false);
    expect(yearPeriod(2026, TODAY).open).toBe(true);
  });

  it("refuses a backwards or malformed custom window", () => {
    expect(customPeriod("2026-07-31", "2026-07-01", TODAY)).toBeNull();
    expect(customPeriod("July", "2026-07-01", TODAY)).toBeNull();
    expect(monthPeriod("2026-13", TODAY)).toBeNull();
    expect(customPeriod("2026-12-15", "2026-12-31", TODAY)!.label).toBe("2026-12-15 to 2026-12-31");
  });

  it("both boundaries are INCLUSIVE", () => {
    expect(inPeriod(receipt({ receivedOn: "2026-07-01" }), JULY)).toBe(true);
    expect(inPeriod(receipt({ receivedOn: "2026-07-31" }), JULY)).toBe(true);
    expect(inPeriod(receipt({ receivedOn: "2026-06-30" }), JULY)).toBe(false);
    expect(inPeriod(receipt({ receivedOn: "2026-08-01" }), JULY)).toBe(false);
  });
});

describe("cash basis — what counts as income", () => {
  it("dates the cash by received_on, NOT by the month the bill was for", () => {
    // Billed for June, paid in July. On cash basis this is July income.
    const s = summariseReceipts(
      [receipt({ periodMonth: "2026-06", receivedOn: "2026-07-03" })],
      JULY,
    );
    expect(s.totalCents).toBe(45500);
    expect(s.otherMonthCount).toBe(1);
  });

  it("COUNTS cash taken against a bill that was later cancelled, and names it", () => {
    // The accrual ledger skips void charges. A cash statement must not --
    // that money is in the bank.
    const s = summariseReceipts([receipt({ chargeStatus: "void" })], JULY);
    expect(s.totalCents).toBe(45500);
    expect(s.againstVoided).toHaveLength(1);
  });

  it("never clamps a receipt to the bill — an overpayment is cash received", () => {
    const s = summariseReceipts(
      [receipt({ amountCents: 50000, chargeAmountCents: 45500 })],
      JULY,
    );
    expect(s.totalCents).toBe(50000);
    expect(s.overpaidCents).toBe(4500);
  });

  it("counts an overpayment once per BILL, not once per part-payment", () => {
    const s = summariseReceipts(
      [
        receipt({ paymentId: "a", amountCents: 30000 }),
        receipt({ paymentId: "b", amountCents: 30000 }),
      ],
      JULY,
    );
    expect(s.totalCents).toBe(60000);
    expect(s.overpaidCents).toBe(14500); // 60000 - 45500, not counted twice
  });

  it("a part-payment contributes only what actually arrived", () => {
    const s = summariseReceipts(
      [receipt({ amountCents: 20000, chargeAmountCents: 45500 })],
      JULY,
    );
    expect(s.totalCents).toBe(20000);
    expect(s.overpaidCents).toBe(0);
  });

  it("sums exactly in integer cents across many rows", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      receipt({ paymentId: `p${i}`, chargeId: `c${i}` }));
    expect(summariseReceipts(rows, JULY).totalCents).toBe(9_100_000);
  });
});

describe("grouping", () => {
  it("groups by method in a FIXED order and drops empty buckets", () => {
    const s = summariseReceipts(
      [
        receipt({ paymentId: "a", method: "cash", amountCents: 10000 }),
        receipt({ paymentId: "b", method: "check", amountCents: 20000 }),
      ],
      JULY,
    );
    expect(s.byMethod.map((b) => b.key)).toEqual(["check", "cash"]);
    expect(s.byMethod.find((b) => b.key === "check")!.cents).toBe(20000);
  });

  it("groups by the month cash arrived, ascending, across a quarter", () => {
    const q3 = quarterPeriod(2026, 3, TODAY);
    const s = summariseReceipts(
      [
        receipt({ paymentId: "a", receivedOn: "2026-09-02" }),
        receipt({ paymentId: "b", receivedOn: "2026-07-02" }),
        receipt({ paymentId: "c", receivedOn: "2026-08-02" }),
      ],
      q3,
    );
    expect(s.byMonth.map((b) => b.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("orders households by money, then by lot NUMERICALLY", () => {
    const s = summariseReceipts(
      [
        receipt({ paymentId: "a", lotNumber: "10", amountCents: 10000 }),
        receipt({ paymentId: "b", lotNumber: "2", amountCents: 10000 }),
        receipt({ paymentId: "c", lotNumber: "7", amountCents: 90000 }),
      ],
      JULY,
    );
    expect(s.byHousehold.map((b) => b.key)).toEqual(["7", "2", "10"]);
  });

  it("reports the first and last cash date actually seen", () => {
    const s = summariseReceipts(
      [
        receipt({ paymentId: "a", receivedOn: "2026-07-28" }),
        receipt({ paymentId: "b", receivedOn: "2026-07-02" }),
      ],
      JULY,
    );
    expect(s.firstOn).toBe("2026-07-02");
    expect(s.lastOn).toBe("2026-07-28");
  });
});

describe("the file", () => {
  it("emits a header plus exactly one row per payment — no total row", () => {
    const rows = [receipt({ paymentId: "a" }), receipt({ paymentId: "b" })];
    const csv = receiptsCsv(rows, [], { parkName: "The Haven", generatedAt: "2026-08-11T12:00:00Z" });
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    // No trailing total/metadata row — a ragged tail breaks the pivot.
    expect(lines.slice(1).every((l) => l.startsWith("The Haven,"))).toBe(true);
  });

  it("neutralises a cell that a spreadsheet would run as a FORMULA", () => {
    // Prefixed with ' so it displays instead of executing. No CSV quoting here:
    // the string holds no comma, quote or newline, so quoting would be noise.
    expect(csvText("=cmd|' /c calc'!A1")).toBe("'=cmd|' /c calc'!A1");
    expect(csvText("-Smith")).toBe("'-Smith");
    expect(csvText("+1")).toBe("'+1");
    // And a formula that DOES contain a comma gets both treatments.
    expect(csvText("=SUM(A1,B2)")).toBe("\"'=SUM(A1,B2)\"");
  });

  it("quotes commas and doubles embedded quotes", () => {
    expect(csvText("Amberg, Roy")).toBe('"Amberg, Roy"');
    expect(csvText('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvText(null)).toBe("");
  });

  it("marks a cancelled bill in the file rather than hiding the row", () => {
    const csv = receiptsCsv([receipt({ chargeStatus: "void" })], [], {
      parkName: "P", generatedAt: "t",
    });
    expect(csv).toContain("CANCELLED");
  });

  it("carries the bill's frozen breakdown verbatim, and survives an empty one", () => {
    expect(linesCell(receipt().chargeLines)).toBe("Lot rent: 395.00; Grounds fee: 60.00");
    expect(linesCell([])).toBe("");
  });

  it("never produces NaN from a zero-total bill", () => {
    const csv = receiptsCsv(
      [receipt({ amountCents: 0, chargeAmountCents: 0, chargeLines: [] })],
      [],
      { parkName: "P", generatedAt: "t" },
    );
    expect(csv).not.toMatch(/NaN/);
  });

  it("names the file for the window and flags a partial one", () => {
    expect(receiptsFilename("The Haven", JULY)).toBe("the-haven-receipts-2026-07-01-to-2026-07-31.csv");
    expect(receiptsFilename("The Haven", monthPeriod("2026-08", TODAY)!)).toMatch(/-partial\.csv$/);
  });
});

describe("what it says", () => {
  it("says nothing came in rather than reporting a measured $0.00", () => {
    const s = summariseReceipts([], JULY);
    expect(receiptsHeadline(s, JULY)).toMatch(/No money is recorded/);
    expect(receiptsHeadline(s, JULY)).not.toContain("$0.00");
  });

  it("formats money and plain decimals correctly", () => {
    expect(money(541200)).toBe("$5,412.00");
    expect(decimal(541200)).toBe("5412.00");
    expect(decimal(5)).toBe("0.05");
    expect(money(-4500)).toBe("-$45.00");
  });

  it("always names the expense, deposit and billed-vs-received gaps", () => {
    const lines = exclusionLines({
      recordsBeginOn: "2026-07-01", lagDays: 3,
      unbilledFeeLabels: [], anyMissingPayerName: false,
    });
    expect(lines.some((l) => /Expenses aren't in here/.test(l))).toBe(true);
    // The old line read "Deposits and refunds aren't in here either — there's
    // nowhere in the system to record them yet." 0102 made that false.
    expect(lines.some((l) => /Deposits and money held on account/.test(l))).toBe(true);
    expect(lines.some((l) => /nowhere in the system/.test(l))).toBe(false);
    expect(lines.some((l) => /not money billed/.test(l))).toBe(true);
    expect(lines.some((l) => /3 days behind/.test(l))).toBe(true);
  });

  it("only mentions an unbilled fee when one exists", () => {
    const none = exclusionLines({
      recordsBeginOn: null, lagDays: 0,
      unbilledFeeLabels: [], anyMissingPayerName: false,
    });
    expect(none.some((l) => /never been billed/.test(l))).toBe(false);

    const some = exclusionLines({
      recordsBeginOn: null, lagDays: 0,
      unbilledFeeLabels: ["grounds fee"], anyMissingPayerName: false,
    });
    expect(some.some((l) => /grounds fee/.test(l))).toBe(true);
  });
});

describe("a payment that was taken back is not income", () => {
  // A bounced check and a transposed digit are the same shape, and until 0081
  // both were permanent. Now they can be reversed — and a reversal that
  // silently vanished from the statement would be its own problem: the receipt
  // number still exists, and an accountant who finds a gap in the sequence
  // stops trusting the whole file.
  const period = monthPeriod("2026-07", TODAY)!;

  it("keeps reversed cash out of the total", () => {
    const s = summariseReceipts([
      receipt({ paymentId: "good", amountCents: 45500 }),
      receipt({ paymentId: "bounced", amountCents: 30000, reversedAt: "2026-07-20T12:00:00Z", reversedReason: "check bounced" }),
    ], period);
    expect(s.totalCents).toBe(45500);
    expect(s.count).toBe(1);
  });

  it("reports it separately, with its own total", () => {
    const s = summariseReceipts([
      receipt({ paymentId: "bounced", amountCents: 30000, reversedAt: "2026-07-20T12:00:00Z", reversedReason: "check bounced" }),
    ], period);
    expect(s.reversed).toHaveLength(1);
    expect(s.reversedCents).toBe(30000);
    expect(s.reversed[0].reversedReason).toBe("check bounced");
  });

  it("keeps it out of the method and household breakdowns too", () => {
    const s = summariseReceipts([
      receipt({ paymentId: "bounced", amountCents: 30000, reversedAt: "2026-07-20T12:00:00Z", reversedReason: "bounced" }),
    ], period);
    expect(s.byMethod).toEqual([]);
    expect(s.byHousehold).toEqual([]);
  });

  it("does not count a reversal as an overpayment", () => {
    // Two payments that together exceed the bill, one of which bounced, is not
    // an overpayment — it is one payment.
    const s = summariseReceipts([
      receipt({ paymentId: "a", amountCents: 45500, chargeAmountCents: 45500 }),
      receipt({ paymentId: "b", amountCents: 45500, chargeAmountCents: 45500,
                reversedAt: "2026-07-21T12:00:00Z", reversedReason: "entered twice" }),
    ], period);
    expect(s.overpaidCents).toBe(0);
  });
});

describe("cash that came in but is not rent received", () => {
  const base = {
    recordsBeginOn: "2026-07-01", lagDays: 0,
    unbilledFeeLabels: [], anyMissingPayerName: false,
  };

  it("SAYS THE AMOUNTS OUT LOUD, so the statement reconciles to a bank statement", () => {
    // Silently omitting them is what makes a cash statement impossible to tie
    // back to the bank — and the first person to notice is an accountant a
    // year later.
    const lines = exclusionLines({
      ...base, depositsReceivedCents: 30_000, onAccountReceivedCents: 50_000,
    });
    const said = lines.find((l) => /NOT in the total above/.test(l));
    expect(said).toBeTruthy();
    expect(said).toContain("$300.00 in deposits taken");
    expect(said).toContain("$500.00 received on account");
  });

  it("names only the one that happened", () => {
    const dep = exclusionLines({ ...base, depositsReceivedCents: 30_000, onAccountReceivedCents: 0 });
    const line = dep.find((l) => /NOT in the total above/.test(l))!;
    expect(line).toContain("deposits taken");
    expect(line).not.toContain("on account");
  });

  it("stays quiet when there is none — a zero is not a disclosure", () => {
    const lines = exclusionLines({ ...base, depositsReceivedCents: 0, onAccountReceivedCents: 0 });
    expect(lines.some((l) => /NOT in the total above/.test(l))).toBe(false);
  });

  it("and when the caller doesn't pass them at all", () => {
    expect(exclusionLines(base).some((l) => /NOT in the total above/.test(l))).toBe(false);
  });

  // MONEY ON ACCOUNT THAT HAS SINCE BEEN PUT AGAINST BILLS (0167). Cash basis
  // is untouched — it is counted on the day it arrived — but the statement
  // must not say "hasn't been put against a bill" about a quarter that paid
  // for January, February and March.
  it("says how much of the on-account money has since gone against bills, and how much is still held — the VIEW's figure", () => {
    const part = exclusionLines({ ...base, onAccountReceivedCents: 162_759, onAccountAppliedCents: 108_506, onAccountHeldCents: 54_253 })
      .find((l) => /NOT in the total above/.test(l))!;
    expect(part).toContain("$1,627.59 received on account");
    expect(part).toContain("$1,085.06 of the money on account has since been put against bills — the file says which months — and $542.53 is still held.");
    const all = exclusionLines({ ...base, onAccountReceivedCents: 162_759, onAccountAppliedCents: 162_759, onAccountHeldCents: 0 })
      .find((l) => /NOT in the total above/.test(l))!;
    expect(all).toContain("All of the money on account has since been put against bills — the file says which months.");
    const none = exclusionLines({ ...base, onAccountReceivedCents: 162_759, onAccountAppliedCents: 0, onAccountHeldCents: 162_759 })
      .find((l) => /NOT in the total above/.test(l))!;
    expect(none).not.toMatch(/since been put against/);
  });

  it("'is still held' is never received minus applied: a refund the arithmetic would miss, and a figure nobody read is not printed", () => {
    // $600 on account by card: $542.53 to January, $57.47 refunded. The
    // old subtraction printed "$57.47 is still held" in the accountant's
    // file about money that went back to a card. The view says 0.
    const refunded = exclusionLines({ ...base, onAccountReceivedCents: 60_000, onAccountAppliedCents: 54_253, onAccountHeldCents: 0 })
      .find((l) => /NOT in the total above/.test(l))!;
    expect(refunded).toContain("$542.53 of the money on account has since been put against bills — the file says which months — and none of it is still held.");
    // The held sentence never invents the refunded slice from arithmetic…
    expect(refunded).not.toMatch(/\$57\.47/);
    expect(refunded).not.toMatch(/All of the money/);
    // …and the refund IS named, as its own sentence, when the loader read it
    // (park_refunds, 0142). This test used to PIN the omission: code, comment
    // and test all agreed the $57.47 that went back to a card was in no note.
    const named = exclusionLines({ ...base, onAccountReceivedCents: 60_000, onAccountAppliedCents: 54_253, onAccountHeldCents: 0,
      refunds: [{ amountCents: 5_747, feeCents: 0, refundedOn: "2027-01-25", lotNumber: "15", payerName: "Household 15", method: "card" }] });
    const sentence = named.find((l) => /sent back to a card/.test(l))!;
    expect(sentence).toBeTruthy();
    expect(sentence).toContain("$57.47 was sent back to a card in this period — Lot 15 $57.47 on January 25, 2027.");
    expect(sentence).toMatch(/NOT taken off the total above/);
    expect(sentence).toMatch(/negative amount/);
    // The loader did not read the view: no held figure at all, not a guess.
    const unread = exclusionLines({ ...base, onAccountReceivedCents: 162_759, onAccountAppliedCents: 108_506 })
      .find((l) => /NOT in the total above/.test(l))!;
    expect(unread).toContain("$1,085.06 of the money on account has since been put against bills — the file says which months.");
    expect(unread).not.toMatch(/still held/);
    expect(unread).not.toMatch(/All of the money/);
  });

  it("no longer asserts that money on account has not been put against a bill", () => {
    const standing = exclusionLines(base);
    expect(standing.some((l) => /hasn't been put against a bill/.test(l))).toBe(false);
    expect(standing.some((l) => /counted here on the day it arrived, not on the bills it later pays/.test(l))).toBe(true);
  });
});

describe("where money on account went, in the file", () => {
  const acct = (over: Partial<OtherReceipt> = {}): OtherReceipt => ({
    paymentId: "q", kind: "rent", receivedOn: "2026-12-28", amountCents: 162_759, feeCents: 0, method: "check", reference: "1042",
    payerName: "Household 9", lotNumber: "9", reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null, ...over,
  });
  const cellsOf = (csv: string, line: number) => {
    const header = csv.split("\r\n")[0].split(",");
    const row = csv.split("\r\n")[line].split(",");
    return (name: string) => row[header.indexOf(name)];
  };

  it("labels the kind by how much has been applied — still filterable", () => {
    expect(onAccountKindLabel(acct())).toBe("On account (not yet applied)");
    expect(onAccountKindLabel(acct({ appliedTo: [{ periodMonth: "2027-01", amountCents: 54_253 }] }))).toBe("On account (partly applied)");
    expect(onAccountKindLabel(acct({ appliedTo: [
      { periodMonth: "2027-01", amountCents: 54_253 }, { periodMonth: "2027-02", amountCents: 54_253 }, { periodMonth: "2027-03", amountCents: 54_253 },
    ] }))).toBe("On account (applied)");
  });

  it("'applied' means nothing is left — the view's word when the loader carried it, not applied >= amount", () => {
    // $600 by card: $542.53 on January, $57.47 refunded. Applied < amount,
    // yet nothing is on account — the row is "applied", not "partly".
    expect(onAccountKindLabel(acct({ amountCents: 60_000, appliedTo: [{ periodMonth: "2027-01", amountCents: 54_253 }], remainingCents: 0 }))).toBe("On account (applied)");
    expect(onAccountKindLabel(acct({ amountCents: 60_000, appliedTo: [{ periodMonth: "2027-01", amountCents: 54_253 }], remainingCents: 5_747 }))).toBe("On account (partly applied)");
    // Nothing applied and nothing held: it went back, and "not yet applied"
    // would send the office looking for money to apply.
    expect(onAccountKindLabel(acct({ appliedTo: [], remainingCents: 0 }))).toBe("On account (given back)");
    expect(onAccountKindLabel(acct({ appliedTo: [], remainingCents: 162_759 }))).toBe("On account (not yet applied)");
  });

  it("names the months and the split in the Bill month cell, in month order", () => {
    const row = acct({ appliedTo: [{ periodMonth: "2027-02", amountCents: 54_253 }, { periodMonth: "2027-01", amountCents: 54_253 }] });
    expect(appliedToCell(row)).toBe("2027-01: 542.53; 2027-02: 542.53");
    const csv = receiptsCsv([], [row], { parkName: "P", generatedAt: "t" });
    const at = cellsOf(csv, 1);
    expect(at("Kind")).toBe("On account (partly applied)");
    expect(at("Bill month")).toBe("2027-01: 542.53; 2027-02: 542.53");
    // Still one row, dated the day it arrived, at the amount that arrived.
    expect(at("Date received")).toBe("2026-12-28");
    expect(at("Amount")).toBe("1627.59");
    expect(at("Bill total")).toBe("");
    expect(at("Charge ID")).toBe("");
  });

  it("a deposit and amenity money carry no months, whatever is passed", () => {
    const csv = receiptsCsv([], [
      acct({ kind: "deposit", paymentId: "d", appliedTo: [{ periodMonth: "2027-01", amountCents: 1 }] }),
      acct({ kind: "amenity", paymentId: "a" }),
    ], { parkName: "P", generatedAt: "t" });
    expect(cellsOf(csv, 1)("Bill month")).toBe("");
    expect(cellsOf(csv, 1)("Kind")).toBe("Deposit (not income)");
    expect(cellsOf(csv, 2)("Bill month")).toBe("");
  });
});


describe("the card fee on a statement", () => {
  /**
   * 0109 wrote `park_payments.fee_amount` and NOTHING read it. A resident's
   * card was debited rent + fee while every screen, receipt and CPA file showed
   * rent alone — so the processor's deposit and the park's books disagreed by
   * exactly the fee, with nothing on any page to explain the gap.
   *
   * The fee is real money that arrived and is NOT the park's income. These pin
   * the shape that makes both of those true at once.
   */
  const period = monthPeriod("2026-07", TODAY)!;
  const card = (over: Partial<Receipt> = {}) =>
    receipt({ method: "card", feeCents: 1365, ...over });

  it("keeps the fee out of the rent total", () => {
    const s = summariseReceipts([card()], period);
    expect(s.totalCents).toBe(45500);
    expect(s.cardFeesCents).toBe(1365);
  });

  it("keeps the by-method rows summing to the total", () => {
    // The property that makes a statement reconcilable against itself. If a fee
    // leaked into a bucket, the breakdown would exceed the headline and an
    // accountant would be the one to find it.
    const s = summariseReceipts([card(), receipt({ paymentId: "p2", chargeId: "c2" })], period);
    const bucketed = s.byMethod.reduce((n, b) => n + b.cents, 0);
    expect(bucketed).toBe(s.totalCents);
    expect(s.cardFeesCents).toBe(1365);
  });

  it("does not let a fee make a household look overpaid", () => {
    // Overpayment is paid-vs-billed. A fee is neither.
    const s = summariseReceipts([card()], period);
    expect(s.overpaidCents).toBe(0);
  });

  it("does not count the fee on a payment that was reversed", () => {
    // A bounced card payment took the fee back with it.
    const s = summariseReceipts(
      [card({ reversedAt: "2026-07-09", reversedReason: "chargeback" })],
      period,
    );
    expect(s.totalCents).toBe(0);
    expect(s.cardFeesCents).toBe(0);
    expect(s.reversed).toHaveLength(1);
  });

  it("carries both figures into the CSV so the bank can be reconciled", () => {
    const csv = receiptsCsv([card()], [], { parkName: "The Haven", generatedAt: "2026-08-11T12:00:00Z" });
    const [head, row] = csv.split("\r\n");
    expect(head).toContain("Card fee");
    expect(head).toContain("Charged total");
    expect(row).toContain("455.00");   // rent — the park's income
    expect(row).toContain("13.65");    // the fee — not the park's income
    expect(row).toContain("468.65");   // what actually left the resident's card
  });

  it("says out loud that the bank deposit will be bigger than the total", () => {
    const said = exclusionLines({
      recordsBeginOn: "2026-01-01", lagDays: 0, unbilledFeeLabels: [],
      anyMissingPayerName: false, cardFeesReceivedCents: 1365,
    });
    const line = said.find((l) => l.includes("card fees"));
    expect(line).toBeTruthy();
    expect(line).toContain("13.65");
    expect(line).toContain("not your income");
    // The figure is EVERY fee that reached the processor — on rent, on money
    // on account, on amenity money — so the sentence no longer says "on top
    // of their rent" about a number that includes the on-account card's fee.
    expect(line).not.toMatch(/on top of their rent/);
    expect(line).toMatch(/on rent, on money on account, or for things you rent out/);
  });

  it("says nothing at all when no card fee was taken", () => {
    // A statement that carries a disclaimer about money nobody paid is noise,
    // and noise is how a reader learns to skip the notes.
    const said = exclusionLines({
      recordsBeginOn: "2026-01-01", lagDays: 0, unbilledFeeLabels: [],
      anyMissingPayerName: false, cardFeesReceivedCents: 0,
    });
    expect(said.some((l) => l.includes("card fees"))).toBe(false);
  });
});

describe("money from things the park rents out", () => {
  /**
   * The park's first boat day would have printed on the CPA statement as
   * "received on account" — the off-book bucket was `kind !== 'deposit'`, so
   * amenity money fell straight into it. "On account" means money not yet put
   * against a bill; a boat day is paid in full and is never going to reach a
   * rent bill, because it is not rent.
   */
  it("names amenity income as income, and not as rent", () => {
    const said = exclusionLines({
      recordsBeginOn: "2026-01-01", lagDays: 0, unbilledFeeLabels: [],
      anyMissingPayerName: false, amenityReceivedCents: 30000,
    });
    const line = said.find((l) => l.includes("rent out"));
    expect(line).toBeTruthy();
    expect(line).toContain("300.00");
    expect(line).toContain("IS your income");
    expect(line).toContain("not rent");
  });

  it("does not confuse it with money held on account", () => {
    const said = exclusionLines({
      recordsBeginOn: "2026-01-01", lagDays: 0, unbilledFeeLabels: [],
      anyMissingPayerName: false, amenityReceivedCents: 30000,
    });
    expect(said.some((l) => l.includes("rent out") && l.includes("on account"))).toBe(false);
  });

  it("says nothing when the park rents nothing out", () => {
    const said = exclusionLines({
      recordsBeginOn: "2026-01-01", lagDays: 0, unbilledFeeLabels: [],
      anyMissingPayerName: false, amenityReceivedCents: 0,
    });
    expect(said.some((l) => l.includes("rent out"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("the file adds up to the bank", () => {
  /**
   * The screen said "Also received in this period, and NOT in the total above:
   * $500.00 in deposits taken" and "$250.00 for things you rent out… That IS
   * your income". The button beneath it said "Download N payments for your
   * accountant", and the file had no row, no total and no sentence for any of
   * it — because those three figures reached the caller only as prose in
   * `notes`, and `receiptsCsv` never receives notes.
   *
   * The accountant sums Amount, ties it to the bank, and is short by exactly
   * that money. The amenity part is real, taxable park income appearing in no
   * book anywhere.
   */
  const other = (over: Partial<OtherReceipt> = {}): OtherReceipt => ({
    paymentId: "p-other-1",
    kind: "amenity",
    receivedOn: "2026-08-14",
    amountCents: 25000,
    feeCents: 0,
    method: "cash",
    reference: null,
    payerName: null, lotNumber: null,
    reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null,
    ...over,
  });

  it("writes a row for money that is not rent", () => {
    const csv = receiptsCsv([], [other()], { parkName: "P", generatedAt: "t" });
    const lines = csv.split("\r\n");
    expect(lines.length).toBe(2);           // header + the one row
    expect(lines[1]).toContain("250.00");
  });

  it("names what each kind is, so deposits stay out of income", () => {
    const csv = receiptsCsv([], [
      other({ kind: "deposit", amountCents: 50000, paymentId: "d1" }),
      other({ kind: "amenity", amountCents: 25000, paymentId: "a1" }),
      other({ kind: "on_account", amountCents: 10000, paymentId: "o1" }),
    ], { parkName: "P", generatedAt: "t" });
    expect(csv).toContain("Deposit (not income)");
    expect(csv).toContain("Rented out (income)");
    expect(csv).toContain("On account (not yet applied)");
  });

  /**
   * Column INDEX resolved from the header, never hardcoded — adding Kind
   * shifted every money column right by one, and a test that counted from the
   * left would have gone on passing while reading the wrong cell. (It did:
   * my first version asserted Amount at index 4, which is now Date received.)
   */
  const cellsOf = (csv: string, line: number) => {
    const header = csv.split("\r\n")[0].split(",");
    const row = csv.split("\r\n")[line].split(",");
    return (name: string) => row[header.indexOf(name)];
  };

  it("marks the rent rows as rent, so Kind is never blank", () => {
    const csv = receiptsCsv([receipt({})], [], { parkName: "P", generatedAt: "t" });
    expect(cellsOf(csv, 1)("Kind")).toBe("Rent");
  });

  it("the Amount column now totals everything that hit the bank", () => {
    const csv = receiptsCsv(
      [receipt({ amountCents: 45500 })],
      [other({ kind: "deposit", amountCents: 50000 }), other({ kind: "amenity", amountCents: 25000, paymentId: "a2" })],
      { parkName: "P", generatedAt: "t" },
    );
    const header = csv.split("\r\n")[0].split(",");
    const amountAt = header.indexOf("Amount");
    const amounts = csv.split("\r\n").slice(1)
      .map((r) => Number(r.split(",")[amountAt].replace(/"/g, "")));
    expect(amounts).toEqual([455, 500, 250]);
    // The whole point: the column now sums to everything that hit the bank.
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1205);
  });

  it("leaves the bill columns EMPTY rather than zero", () => {
    // A zero is a figure somebody can sum. A deposit has no bill at all.
    const csv = receiptsCsv([], [other()], { parkName: "P", generatedAt: "t" });
    const at = cellsOf(csv, 1);
    expect(at("Bill total")).toBe("");
    expect(at("Bill status")).toBe("");
    expect(at("Charge ID")).toBe("");
  });

  it("still carries the payment id, so a row can be traced", () => {
    const csv = receiptsCsv([], [other({ paymentId: "pay-xyz" })], { parkName: "P", generatedAt: "t" });
    expect(csv).toContain("pay-xyz");
  });
});

// ---------------------------------------------------------------------------
// THE COUNT ON THE BUTTON IS THE ROW COUNT OF THE FILE.
//
// "Download N payments for your accountant" is a promise about a spreadsheet
// somebody else opens. It has now been broken twice by the same mechanism:
// the count was ASSEMBLED on the screen from the screen's own totals, while
// the file was built from arrays. First `s.count` excluded reversed payments
// and the file included them — 11 promised, 12 delivered. That was patched by
// adding the reversed length. Then the export route started writing
// `otherReceipts` as well, and the gap reopened one array later.
//
// The fix is not a third addend. It is to derive the count from exactly what
// the file is built from.
// ---------------------------------------------------------------------------
describe("the button's count and the file's rows", () => {
  const dataRows = (csv: string) => csv.split("\r\n").length - 1; // less header

  const other = (over: Partial<OtherReceipt> = {}): OtherReceipt => ({
    paymentId: "p-other", kind: "deposit", receivedOn: "2026-07-09",
    amountCents: 50000, feeCents: 0, method: "check", reference: null,
    payerName: "Roy Amberg", lotNumber: "3", reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null, ...over,
  });

  it("a file of rent, a bounced cheque and a deposit is three rows", () => {
    const receipts = [
      receipt({ paymentId: "a" }),
      receipt({ paymentId: "b", reversedAt: "2026-07-20T00:00:00Z", reversedReason: "bounced" }),
    ];
    const others = [other()];
    const csv = receiptsCsv(receipts, others, { parkName: "The Haven", generatedAt: "t" });

    // What the screen now computes: page.receipts.length + page.otherReceipts.length.
    expect(dataRows(csv)).toBe(receipts.length + others.length);
    expect(dataRows(csv)).toBe(3);
  });

  it("the deposit is NOT in the rent summary — which is why the old sum was short", () => {
    // summariseReceipts never sees otherReceipts, and correctly so: a deposit
    // is not rent. That is exactly why a count built from the summary could
    // never match a file that carries both.
    const s = summariseReceipts([receipt({ paymentId: "a" })], JULY);
    expect(s.count).toBe(1);
    const csv = receiptsCsv([receipt({ paymentId: "a" })], [other()], { parkName: "P", generatedAt: "t" });
    expect(dataRows(csv)).toBe(2);
    expect(dataRows(csv)).toBeGreaterThan(s.count + s.reversed.length);
  });

  it("and the button on the screen uses that, not the summary", () => {
    // receipts-helpers is pure and testable; ParkStatements is a client
    // component whose only job here is to print a number. Read as source
    // because the arithmetic, not the markup, is what went wrong twice.
    const src = readFileSync(
      fileURLToPath(new URL("../../components/ParkStatements.tsx", import.meta.url)),
      "utf8",
    );
    const decl = src.match(/const fileRows = [^\n]*/)?.[0] ?? "";
    expect(decl, "fileRows is gone — the count is being assembled again").not.toBe("");
    expect(decl).toMatch(/page\.receipts\.length/);
    expect(decl).toMatch(/page\.otherReceipts\.length/);

    // And the button prints THAT, not a figure rebuilt from the screen totals.
    const button = src.match(/\{fileRows > 0[\s\S]{0,300}?\}/)?.[0] ?? "";
    expect(button, "the download button no longer reads fileRows").not.toBe("");
    expect(button, "the summary count is back on the button")
      .not.toMatch(/s\.count/);
  });

  it("holds for every mix, including none of one kind", () => {
    for (const nR of [0, 1, 3]) {
      for (const nO of [0, 1, 2]) {
        const receipts = Array.from({ length: nR }, (_, i) => receipt({ paymentId: `r${i}` }));
        const others = Array.from({ length: nO }, (_, i) => other({ paymentId: `o${i}` }));
        const csv = receiptsCsv(receipts, others, { parkName: "P", generatedAt: "t" });
        expect(dataRows(csv), `${nR} rent + ${nO} other`).toBe(nR + nO);
      }
    }
  });
});

/**
 * A BOUNCED ACH IS NOT INCOME EITHER.
 *
 * The reversal handling in this file exists because "a bounced check counted
 * as income is how a park pays tax on money it never had". 0142 then made the
 * database REFUSE to reverse a card or ACH payment — correctly, the money
 * really moved — which means every chargeback and every ACH return arrives on
 * `bankReturnedAt` and on no other field. Until it was threaded through here,
 * this file excluded the bounced cheque and counted the bounced ACH.
 */
function csvCells(line: string): string[] {
  // A real parse, not split(","): the bill-breakdown cell contains commas and
  // is quoted, so a naive split reports the wrong width and the assertion
  // below would pass on a file that is genuinely ragged.
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

describe("money the bank pulled back", () => {
  // JULY, the file's existing non-null period, rather than a second one.
  const returned = receipt({
    paymentId: "bounced-ach",
    amountCents: 54253,
    method: "ach",
    bankReturnedAt: "2026-07-20T12:00:00Z",
    returnCode: "R01 insufficient funds",
  });

  it("stays out of the total, exactly as a reversal does", () => {
    const s = summariseReceipts([receipt(), returned], JULY);
    expect(s.totalCents, "a returned ACH was counted as rent collected").toBe(45500);
    expect(s.count).toBe(1);
  });

  it("is reported rather than dropped, so the receipt number is not lost", () => {
    const s = summariseReceipts([receipt(), returned], JULY);
    expect(s.reversed.map((r) => r.paymentId)).toContain("bounced-ach");
    expect(s.reversedCents).toBe(54253);
  });

  it("keeps a plain reversal working alongside it", () => {
    const office = receipt({ paymentId: "bounced-cheque", amountCents: 30000, reversedAt: "2026-07-21T12:00:00Z", reversedReason: "cheque bounced" });
    const s = summariseReceipts([receipt(), returned, office], JULY);
    expect(s.totalCents).toBe(45500);
    expect(s.reversedCents).toBe(54253 + 30000);
  });

  it("is marked in the file an accountant actually sums", () => {
    const csv = receiptsCsv([returned], [], { parkName: "The Haven", generatedAt: "2026-08-11T00:00:00Z" });
    const head = csvCells(csv.split("\r\n")[0]);
    const row = csvCells(csv.split("\r\n")[1]);
    const at = (col: string) => row[head.indexOf(col)];

    // Filtering "Taken back = YES" is how this column was designed to be used.
    // If a bank return did not set it, that filter books the ACH as income.
    expect(at("Taken back"), "a returned ACH is not marked in the CSV").toBe("YES");
    expect(at("Taken back how")).toBe("bank return");
    expect(at("Taken back on")).toBe("2026-07-20");
    expect(at("Reason")).toBe("R01 insufficient funds");
  });

  it("still says 'office correction' for a reversal", () => {
    const office = receipt({ reversedAt: "2026-07-21T12:00:00Z", reversedReason: "entered twice" });
    const csv = receiptsCsv([office], [], { parkName: "The Haven", generatedAt: "2026-08-11T00:00:00Z" });
    const head = csvCells(csv.split("\r\n")[0]);
    const row = csvCells(csv.split("\r\n")[1]);
    const at = (col: string) => row[head.indexOf(col)];
    expect(at("Taken back")).toBe("YES");
    expect(at("Taken back how")).toBe("office correction");
    expect(at("Reason")).toBe("entered twice");
  });
});

describe("every CSV row is as wide as the header", () => {
  it("holds for payment rows and for the billless ones beside them", () => {
    // THE FAILURE THIS PREVENTS: the two row writers in receipts-helpers.ts
    // list their cells by hand, in two places, and the second pads the
    // taken-back columns with hand-counted blanks. Adding "Taken back how" to
    // HEADERS shifted every later cell in those rows by one — a payment ID
    // printed under "Bill status" — and the only thing that caught it was an
    // unrelated assertion about an empty bill column.
    const csv = receiptsCsv(
      [
        receipt(),
        receipt({ paymentId: "r2", reversedAt: "2026-07-21T00:00:00Z", reversedReason: "typed twice" }),
        receipt({ paymentId: "r3", bankReturnedAt: "2026-07-22T00:00:00Z", returnCode: "R02" }),
        // A receipt whose bill was cancelled after it was paid (0169): the
        // Bill status cell carries where the money went — one cell, not more.
        receipt({ paymentId: "r4", chargeStatus: "void", released: { allocations: [{ periodMonth: "2026-07", amount: 400 }], remainingCents: 5500, handedBackCents: 0, handedBackOn: null, handedBackInFile: false, refundedCents: 0, refundedInFile: false } }),
      ],
      [
        { paymentId: "o1", kind: "deposit", amountCents: 50000, feeCents: 0, method: "check", reference: "88", receivedOn: "2026-07-04",
          payerName: "Roy Amberg", lotNumber: "3", reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null },
        { paymentId: "o2", kind: "amenity", amountCents: 7500, feeCents: 225, method: "card", reference: null, receivedOn: "2026-07-06",
          payerName: null, lotNumber: null, reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null },
        // A bounced on-account cheque and a refund — the two new shapes.
        { paymentId: "o3", kind: "rent", amountCents: 162759, feeCents: 0, method: "check", reference: "3300", receivedOn: "2026-07-04",
          payerName: "Household 10", lotNumber: "10", reversedAt: "2026-07-21T00:00:00Z", reversedReason: "cheque bounced", bankReturnedAt: null, returnCode: null, appliedTo: [] },
        { paymentId: "p1", kind: "refund", amountCents: -10000, feeCents: -300, method: "card", reference: "re_1", receivedOn: "2026-07-26",
          payerName: "Roy Amberg", lotNumber: "3", reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null },
      ],
      { parkName: "The Haven", generatedAt: "2026-08-11T00:00:00Z" },
    );
    const lines = csv.split("\r\n");
    const width = csvCells(lines[0]).length;
    expect(width, "the header collapsed — this assertion would pass on anything")
      .toBeGreaterThan(15);
    lines.forEach((line, i) => {
      expect(csvCells(line).length, `row ${i} has the wrong number of cells`).toBe(width);
    });
  });
});

describe("the statement calls a row what the resident's receipt calls it", () => {
  /**
   * SAME ROW, TWO NAMES. The receipt in a resident's hand said "bank transfer"
   * for `transfer`; the accountant's statement and CSV said "Transfer" and
   * kept "Bank transfer" for processor `ach`. Two people comparing paper
   * would find the same $542.53 under two different words. Both buckets stay
   * distinct on the statement — who recorded it differs — but both now say
   * what the receipt says.
   */
  it("both bank rails are a 'Bank transfer', told apart by who recorded them", () => {
    expect(METHOD_LABEL.ach).toBe("Bank transfer (processor)");
    expect(METHOD_LABEL.transfer).toBe("Bank transfer (to the park)");
    expect(METHOD_LABEL.ach).not.toBe(METHOD_LABEL.transfer);
    // And the receipt's word is inside each — the paper and the statement agree.
    for (const m of ["ach", "transfer"] as const) {
      expect(METHOD_LABEL[m].toLowerCase()).toContain(METHOD_WORD[m]);
    }
  });

  it("the CSV carries the label, not the raw value", () => {
    const csv = receiptsCsv(
      [receipt({ paymentId: "t1", method: "transfer" }), receipt({ paymentId: "a1", method: "ach", reference: "px_1" })],
      [],
      { parkName: "The Haven", generatedAt: "2026-08-11T00:00:00Z" },
    );
    expect(csv).toContain("Bank transfer (to the park)");
    expect(csv).toContain("Bank transfer (processor)");
    expect(csv).not.toMatch(/,Transfer,/);
  });
});

/**
 * MONEY THAT WAS NOT AGAINST A BILL AND DID NOT STAY.
 *
 * A bounced cheque against a bill was kept in the file and marked "Taken
 * back". The same cheque recorded ON ACCOUNT — a quarter paid ahead, the
 * excess over a bill — was filtered out of the off-book read, so it left the
 * file with no row, no note, and a hole in the receipt-number sequence. The
 * rule is one rule, and these pin it for the rows beside the rent.
 */
describe("a deposit or on-account row that was taken back is kept, marked, and counts toward nothing", () => {
  const acct = (over: Partial<OtherReceipt> = {}): OtherReceipt => ({
    paymentId: "acct-10", kind: "rent", receivedOn: "2027-01-04", amountCents: 162_759, feeCents: 0, method: "check", reference: "3300",
    payerName: "Household 10", lotNumber: "10", reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null, appliedTo: [], ...over,
  });
  const cellsOf = (csv: string, line: number) => {
    const header = csv.split("\r\n")[0].split(",");
    const row = csv.split("\r\n")[line].split(",");
    return (name: string) => row[header.indexOf(name)];
  };

  it("one writer for the four Taken-back cells, shared by both kinds of row", () => {
    expect(takenBackCells(acct())).toEqual(["", "", "", ""]);
    expect(takenBackCells(acct({ reversedAt: "2027-02-10T20:30:00Z", reversedReason: "cheque bounced" })))
      // 8:30pm UTC on 10 Feb is 3:30pm on the lakes — same day. The lake date, never a UTC slice.
      .toEqual(["YES", "office correction", "2027-02-10", "cheque bounced"]);
    expect(takenBackCells(acct({ bankReturnedAt: "2027-02-11T02:30:00Z", returnCode: "R01" })))
      // 2:30am UTC on the 11th is the evening of the 10th on the lakes.
      .toEqual(["YES", "bank return", "2027-02-10", "R01"]);
    // And the rent rows go through the very same function.
    expect(takenBackCells(receipt({ reversedAt: "2026-07-21T12:00:00Z", reversedReason: "entered twice" })))
      .toEqual(["YES", "office correction", "2026-07-21", "entered twice"]);
    // notCollectedAt decides for both shapes.
    expect(notCollectedAt(acct({ reversedAt: "2027-02-10T20:30:00Z" }))).toBe("2027-02-10T20:30:00Z");
    expect(notCollectedAt(acct())).toBeNull();
  });

  it("the file marks a bounced on-account cheque exactly as it marks a bounced bill cheque", () => {
    const csv = receiptsCsv([], [acct({ reversedAt: "2027-02-10T20:30:00Z", reversedReason: "cheque bounced" })], { parkName: "The Haven", generatedAt: "t" });
    const at = cellsOf(csv, 1);
    expect(at("Taken back")).toBe("YES");
    expect(at("Taken back how")).toBe("office correction");
    expect(at("Taken back on")).toBe("2027-02-10");
    expect(at("Reason")).toBe("cheque bounced");
    expect(at("Kind")).toBe("On account (taken back)");
    // Still one row, at what arrived, on the day it arrived — the receipt number is not lost.
    expect(at("Amount")).toBe("1627.59");
    expect(at("Date received")).toBe("2027-01-04");
    expect(csv).toContain("acct-10");
  });

  it("the Kind says taken back before it says anything about applying — never 'not yet applied' about a bounced cheque", () => {
    expect(onAccountKindLabel(acct({ reversedAt: "2027-02-10T20:30:00Z" }))).toBe("On account (taken back)");
    expect(onAccountKindLabel(acct({ bankReturnedAt: "2027-02-10T20:30:00Z", method: "ach" }))).toBe("On account (taken back)");
    // Even with allocations on the record (they survive a reversal as record, 0167).
    expect(onAccountKindLabel(acct({ reversedAt: "2027-02-10T20:30:00Z", appliedTo: [{ periodMonth: "2027-01", amountCents: 54_253 }] }))).toBe("On account (taken back)");
    // A standing row is unchanged.
    expect(onAccountKindLabel(acct({ remainingCents: 162_759 }))).toBe("On account (not yet applied)");
    // And a deposit or amenity row that went back says so in its own words.
    expect(otherKindLabel(acct({ kind: "deposit", reversedAt: "2027-02-10T20:30:00Z" }))).toBe("Deposit (taken back)");
    expect(otherKindLabel(acct({ kind: "amenity", bankReturnedAt: "2027-02-10T20:30:00Z" }))).toBe("Rented out (taken back)");
    expect(otherKindLabel(acct({ kind: "deposit" }))).toBe("Deposit (not income)");
    expect(otherKindLabel(acct({ kind: "rent", remainingCents: 162_759 }))).toBe("On account (not yet applied)");
  });

  it("the Lot and Payer cells name the household — no more anonymous $1,627.59", () => {
    const csv = receiptsCsv([], [acct()], { parkName: "The Haven", generatedAt: "t" });
    const at = cellsOf(csv, 1);
    expect(at("Lot")).toBe("10");
    expect(at("Payer")).toBe("Household 10");
    // A row whose record names nobody prints blank, not "null".
    const anon = receiptsCsv([], [acct({ payerName: null, lotNumber: null })], { parkName: "The Haven", generatedAt: "t" });
    expect(cellsOf(anon, 1)("Lot")).toBe("");
    expect(cellsOf(anon, 1)("Payer")).toBe("");
    expect(anon).not.toMatch(/null/);
  });

  it("the note names the money that went back out, separately from rent taken back", () => {
    const lines = exclusionLines({ recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false, otherTakenBackCents: 162_759 });
    const line = lines.find((l) => /later taken back/.test(l))!;
    expect(line).toBeTruthy();
    expect(line).toContain("$1,627.59 that arrived in this period as a deposit, on account or for something you rent out was later taken back");
    expect(line).toMatch(/counts toward nothing above/);
    expect(line).toMatch(/marked "Taken back"/);
    // Silent when nothing was.
    expect(exclusionLines({ recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false, otherTakenBackCents: 0 })
      .some((l) => /later taken back/.test(l))).toBe(false);
  });
});

/**
 * A REFUND IS ITS OWN NEGATIVE ROW (0142). Money received stays the row it
 * was; the refund is the correction, as a new row dated the day it went
 * back — so the Amount column sums to the bank and the original receipt is
 * untouched. Member 12's alternative (subtract it from the total, or a
 * column on the original row) would break the file's own rule that byMethod
 * and byHousehold sum to totalCents, and re-read a row that already
 * happened.
 */
describe("a refund to a card, in the file", () => {
  const refund = (over: Partial<OtherReceipt> = {}): OtherReceipt => ({
    paymentId: "pay-card-26", kind: "refund", receivedOn: "2027-01-26", amountCents: -10_000, feeCents: -300, method: "card", reference: "re_abc",
    payerName: "Household 26", lotNumber: "26", reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null, ...over,
  });
  const cellsOf = (csv: string, line: number) => {
    const header = csv.split("\r\n")[0].split(",");
    const row = csv.split("\r\n")[line].split(",");
    return (name: string) => row[header.indexOf(name)];
  };

  it("is not money on account", () => {
    expect(isOnAccountRow(refund())).toBe(false);
    expect(isOnAccountRow({ kind: "rent" })).toBe(true);
    expect(isOnAccountRow({ kind: "on_account" })).toBe(true);
    expect(isOnAccountRow({ kind: "deposit" })).toBe(false);
  });

  it("prints negative, dated the day it went back, tied to the payment it came off", () => {
    const csv = receiptsCsv([], [refund()], { parkName: "The Haven", generatedAt: "t" });
    const at = cellsOf(csv, 1);
    expect(at("Kind")).toBe("Refund (given back)");
    expect(at("Date received")).toBe("2027-01-26");
    // A well-formed negative decimal passes through csvCell as a NUMBER, not
    // as text — the formula guard exempts it (lib/csv).
    expect(at("Amount")).toBe("-100.00");
    expect(at("Card fee")).toBe("-3.00");
    expect(at("Charged total")).toBe("-103.00");
    expect(at("Method")).toBe("Card");
    expect(at("Reference")).toBe("re_abc");
    expect(at("Lot")).toBe("26");
    expect(at("Payer")).toBe("Household 26");
    expect(at("Taken back")).toBe("");
    expect(at("Payment ID")).toBe("pay-card-26");
    expect(at("Bill month")).toBe("");
  });

  it("the Amount column still sums to the bank: received, less what went back", () => {
    const csv = receiptsCsv(
      [receipt({ amountCents: 54_253, method: "card", feeCents: 1_628 })],
      [refund({ amountCents: -10_000, feeCents: 0 })],
      { parkName: "P", generatedAt: "t" },
    );
    const header = csv.split("\r\n")[0].split(",");
    const amountAt = header.indexOf("Amount");
    const amounts = csv.split("\r\n").slice(1).map((r) => Number(r.split(",")[amountAt].replace(/"/g, "")));
    expect(amounts).toEqual([542.53, -100]);
    expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100)).toBe(44_253);
  });

  it("the note names each refund and says it is NOT taken off the total", () => {
    const lines = exclusionLines({
      recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false,
      refunds: [
        { amountCents: 10_000, feeCents: 0, refundedOn: "2027-01-26", lotNumber: "26", payerName: "Household 26", method: "card" },
        { amountCents: 4_000, feeCents: 120, refundedOn: "2027-01-25", lotNumber: null, payerName: "Household 15", method: "card" },
      ],
    });
    const line = lines.find((l) => /sent back to cards/.test(l))!;
    expect(line).toBeTruthy();
    expect(line).toContain("$140.00 was sent back to cards in this period — Lot 26 $100.00 on January 26, 2027; Household 15 $40.00 on January 25, 2027.");
    expect(line).toContain("$1.20 of card fee went back with it.");
    expect(line).toMatch(/It is NOT taken off the total above/);
    // Silent when there were none.
    expect(exclusionLines({ recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false, refunds: [] })
      .some((l) => /sent back/.test(l))).toBe(false);
  });

  it("every money figure in the notes goes through money() — a thousands comma, never toFixed", () => {
    const lines = exclusionLines({
      recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false,
      depositsReceivedCents: 150_000, onAccountReceivedCents: 162_759, onAccountAppliedCents: 108_506, onAccountHeldCents: 54_253,
      amenityReceivedCents: 120_000, cardFeesReceivedCents: 100_000, otherTakenBackCents: 162_759,
      refunds: [{ amountCents: 162_759, feeCents: 0, refundedOn: "2027-01-26", lotNumber: "9", payerName: null, method: "card" }],
      handedBack: [{ amountCents: 108_506, on: "2027-02-03", lotNumber: "9", payerName: null, kind: "rent", note: "moved out" }],
      releasedFromCancelled: [{ amountCents: 162_759, billMonth: "2027-01", releasedOn: "2027-01-20T16:00:00Z", lotNumber: "9", payerName: null,
        allocations: [{ periodMonth: "2027-01", amount: 1085.06 }], remainingCents: 54_253, handedBackCents: 0, handedBackOn: null, handedBackInFile: false }],
    });
    const joined = lines.join(" ");
    for (const figure of ["$1,500.00", "$1,627.59", "$1,085.06", "$1,200.00", "$1,000.00", "$1,085.06 of their money on account", "$1,085.06 to January 2027, $542.53 still held"]) {
      expect(joined).toContain(figure);
    }
    // The bare four-digit form is the toFixed shape, and it is gone.
    expect(joined).not.toMatch(/\$\d{4,}\.\d{2}/);
    const src = readFileSync(fileURLToPath(new URL("./receipts-helpers.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/toFixed/);
  });
});

/**
 * ONE DERIVATION OF "WHY IT DID NOT STAY". The rule — the bank's code for a
 * return (or "returned by the bank"), the office's words for a reversal —
 * existed four times: the file's Reason cell, the statement screen, the
 * resident's home screen and her /paid link, each a copy. The helper is the
 * one writer; the row adapter lets a loader that reads snake_case columns
 * ask it without spelling the rule out again.
 */
describe("takenBackWhy — the one derivation, and the row adapter", () => {
  it("a bank return reads the code, or 'returned by the bank' when there is none", () => {
    expect(takenBackWhy({ reversedAt: null, reversedReason: null, bankReturnedAt: "2027-01-08T14:00:00Z", returnCode: "R01" })).toBe("R01");
    expect(takenBackWhy({ reversedAt: null, reversedReason: null, bankReturnedAt: "2027-01-08T14:00:00Z", returnCode: null })).toBe("returned by the bank");
  });

  it("a reversal reads the office's reason, or null when it carries none — never 'returned by the bank'", () => {
    expect(takenBackWhy({ reversedAt: "2027-02-10T20:30:00Z", reversedReason: "cheque 1042 bounced", bankReturnedAt: null, returnCode: null })).toBe("cheque 1042 bounced");
    expect(takenBackWhy({ reversedAt: "2027-02-10T20:30:00Z", reversedReason: null, bankReturnedAt: null, returnCode: null })).toBeNull();
  });

  it("a payment that stands has no reason", () => {
    expect(takenBackWhy({ reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null })).toBeNull();
  });

  it("the Reason cell IS this helper — the file and every screen say the same words", () => {
    const r = { reversedAt: "2027-02-10T20:30:00Z", reversedReason: "cheque 1042 bounced", bankReturnedAt: null, returnCode: null };
    expect(takenBackCells(r)[3]).toBe(takenBackWhy(r));
    const bank = { reversedAt: null, reversedReason: null, bankReturnedAt: "2027-01-08T14:00:00Z", returnCode: null };
    expect(takenBackCells(bank)[3]).toBe("returned by the bank");
  });

  it("takenBackOfRow maps a park_payments row and reads returned_at, never returned_on", () => {
    const row = takenBackOfRow({ reversed_at: null, reversed_reason: null, returned_at: "2027-01-08T14:00:00Z", return_code: "R01", returned_on: "2027-02-03" } as Record<string, unknown>);
    expect(row).toEqual({ reversedAt: null, reversedReason: null, bankReturnedAt: "2027-01-08T14:00:00Z", returnCode: "R01" });
    expect(notCollectedAt(row)).toBe("2027-01-08T14:00:00Z");
    // A deposit handed back across the window still STANDS.
    const handed = takenBackOfRow({ returned_on: "2027-02-03", returned_amount: 500 } as Record<string, unknown>);
    expect(notCollectedAt(handed)).toBeNull();
    expect(takenBackWhy(handed)).toBeNull();
  });

  it("no second copy of the rule survives in the screens or the loaders that read these fields", () => {
    const strip = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const rel of ["../../components/ParkStatements.tsx", "../parks/my-data.ts", "../../lib/confirm-server.ts"]) {
      const src = strip(rel);
      expect(src, `${rel} still derives the reason itself`).not.toMatch(/"returned by the bank"/);
      expect(src, `${rel} does not import the one helper`).toMatch(/takenBackWhy/);
    }
    // And this file holds the ONE literal.
    const here = strip("./receipts-helpers.ts");
    expect((here.match(/"returned by the bank"/g) ?? []).length).toBe(1);
  });
});

/**
 * THE FOURTH WAY MONEY LEAVES — handed back across the window. A deposit
 * returned (0102), rent on account handed back to a household that has gone
 * (0168): no processor, a park cheque or cash over a counter. It is a row
 * of the same shape as a refund — negative, on the day it went back — and
 * the note names it, or February's file is short by exactly the cheque the
 * park wrote.
 */
describe("money handed back across the window", () => {
  const handed = (over: Partial<OtherReceipt> = {}): OtherReceipt => ({
    paymentId: "pay-acct", kind: "handed_back", receivedOn: "2027-01-28", amountCents: -5_747, feeCents: 0,
    method: "check", reference: "moved out 27 January; nothing more bills", payerName: "Household 9", lotNumber: "9",
    reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null, ...over,
  });

  it("is its own Kind, never on account, and the label survives being taken back (it cannot be)", () => {
    expect(otherKindLabel(handed())).toBe("Handed back (given back)");
    expect(isOnAccountRow(handed())).toBe(false);
  });

  it("prints as a negative line in the file, dated the day it went back, the reason where the reference goes, tied to the payment", () => {
    const csv = receiptsCsv([], [handed()], { parkName: "The Haven", generatedAt: "t" });
    const header = csv.split("\r\n")[0].split(",");
    const cells = csv.split("\r\n")[1].split(",");
    const at = (h: string) => cells[header.indexOf(h)].replace(/^"|"$/g, "");
    expect(at("Kind")).toBe("Handed back (given back)");
    expect(at("Date received")).toBe("2027-01-28");
    expect(at("Amount")).toBe("-57.47");
    expect(at("Card fee")).toBe("0.00");
    expect(at("Charged total")).toBe("-57.47");
    expect(at("Method")).toBe("Check");
    expect(at("Payment ID")).toBe("pay-acct");
    expect(at("Lot")).toBe("9");
    expect(at("Payer")).toBe("Household 9");
    expect(at("Taken back")).toBe("");
    expect(csv).toContain("moved out 27 January; nothing more bills");
    expect(cells.length).toBe(header.length);
  });

  it("the Amount column still sums to the bank: the cheque in, the hand-back out", () => {
    const csv = receiptsCsv([], [
      { ...handed({ kind: "rent", receivedOn: "2027-01-05", amountCents: 60_000, reference: "1042", appliedTo: [{ periodMonth: "2027-01", amountCents: 54_253 }], remainingCents: 0 }) },
      handed(),
    ], { parkName: "P", generatedAt: "t" });
    const header = csv.split("\r\n")[0].split(",");
    const amountAt = header.indexOf("Amount");
    const amounts = csv.split("\r\n").slice(1).map((r) => Number(r.split(",")[amountAt].replace(/"/g, "")));
    expect(amounts).toEqual([600, -57.47]);
    expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100)).toBe(54_253);
  });

  it("the note names each hand-back — what it was, the day, the reason — and says it is NOT taken off the total", () => {
    const lines = exclusionLines({
      recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false,
      handedBack: [
        { amountCents: 5_747, on: "2027-01-28", lotNumber: "9", payerName: "Household 9", kind: "rent", note: "moved out 27 January; nothing more bills" },
        { amountCents: 50_000, on: "2027-02-03", lotNumber: null, payerName: "Household 14", kind: "deposit", note: null },
      ],
    });
    const line = lines.find((l) => /handed back across the window/.test(l))!;
    expect(line).toBeTruthy();
    expect(line).toContain("$557.47 was handed back across the window in this period — Lot 9 $57.47 of their money on account on January 28, 2027 (moved out 27 January; nothing more bills); Household 14 $500.00 of their deposit on February 3, 2027.");
    expect(line).toMatch(/It is NOT taken off the total above/);
    expect(line).toMatch(/negative amount/);
    expect(line).not.toMatch(/null/);
    // Silent when there were none.
    expect(exclusionLines({ recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false, handedBack: [] })
      .some((l) => /handed back/.test(l))).toBe(false);
  });

  it("a refund's note names the rail it went back on — a card, or a bank account (0142 refunds ACH too)", () => {
    const ctx = { recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false };
    const one = (method: string) => ({ amountCents: 4_000, feeCents: 0, refundedOn: "2027-01-25", lotNumber: "15", payerName: null, method });
    expect(exclusionLines({ ...ctx, refunds: [one("ach")] }).find((l) => /sent back/.test(l))).toContain("$40.00 was sent back to a bank account in this period");
    expect(exclusionLines({ ...ctx, refunds: [one("ach"), one("ach")] }).find((l) => /sent back/.test(l))).toContain("was sent back to bank accounts in this period");
    expect(exclusionLines({ ...ctx, refunds: [one("card"), one("ach")] }).find((l) => /sent back/.test(l))).toContain("was sent back to cards and bank accounts in this period");
    expect(exclusionLines({ ...ctx, refunds: [one("card")] }).find((l) => /sent back/.test(l))).toContain("was sent back to a card in this period");
  });
});

/**
 * A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT (0169). The receipt
 * against the cancelled bill stays a receipt — counted once as rent, on the
 * day it arrived — and the file and the note must say where that money went
 * since: the part month it settled has the SAME Bill month as the cancelled
 * bill, so "CANCELLED" alone could not tie the two. Its own sentence and its
 * own cell; never folded into the on-account figures, whose population is
 * money received ON ACCOUNT.
 */
describe("money released from a cancelled bill, in the file and the note", () => {
  const released = { allocations: [{ periodMonth: "2027-01", amount: 472.53 }], remainingCents: 7_000, handedBackCents: 0, handedBackOn: null, handedBackInFile: false, refundedCents: 0, refundedInFile: false };

  it("the Bill status cell ties the cancelled bill to the months its money paid, what is still held, and what was handed back", () => {
    expect(billStatusCell(receipt({ chargeStatus: "void", released }))).toBe("CANCELLED — money released on account: 2027-01: 472.53; still held: 70.00");
    expect(billStatusCell(receipt({ chargeStatus: "void", released: { ...released, remainingCents: 0, handedBackCents: 7_000, handedBackOn: "2027-01-22" } })))
      .toBe("CANCELLED — money released on account: 2027-01: 472.53; handed back 2027-01-22: 70.00");
    // Months in order; nothing applied and nothing held reads as none held
    // (it went back through the processor — the refund is its own row).
    expect(billStatusCell(receipt({ chargeStatus: "void", released: { ...released, allocations: [{ periodMonth: "2027-02", amount: 1 }, { periodMonth: "2027-01", amount: 2 }], remainingCents: 0 } })))
      .toBe("CANCELLED — money released on account: 2027-01: 2.00; 2027-02: 1.00");
    expect(billStatusCell(receipt({ chargeStatus: "void", released: { ...released, allocations: [], remainingCents: 0 } })))
      .toBe("CANCELLED — money released on account: none still held");
    // Collapsed both ways: a cancelled bill the loader found nothing released
    // for is CANCELLED and no more; a live bill is its own status.
    expect(billStatusCell(receipt({ chargeStatus: "void" }))).toBe("CANCELLED");
    expect(billStatusCell(receipt({ chargeStatus: "paid" }))).toBe("paid");
    expect(billStatusCell(receipt({ chargeStatus: "open", released }))).toBe("open");
  });

  it("the file carries that cell in the Bill status column, and the row stays Rent on the day it arrived", () => {
    const csv = receiptsCsv([receipt({ chargeStatus: "void", released })], [], { parkName: "P", generatedAt: "t" });
    const header = csv.split("\r\n")[0].split(",");
    const cells = csv.split("\r\n")[1];
    // No comma in the cell, so it goes unquoted — a filter on CANCELLED still finds it.
    expect(cells.split(",")[header.indexOf("Bill status")]).toBe("CANCELLED — money released on account: 2027-01: 472.53; still held: 70.00");
    expect(cells.split(",")[header.indexOf("Kind")]).toBe("Rent");
    expect(cells.split(",")[header.indexOf("Date received")]).toBe("2026-07-03");
  });

  it("the note gives it its own sentence — in words, and never through the on-account figures", () => {
    const base = { recordsBeginOn: "2027-01-01", lagDays: 0, unbilledFeeLabels: [], anyMissingPayerName: false };
    const lines = exclusionLines({ ...base, onAccountReceivedCents: 10_000, onAccountAppliedCents: 0, onAccountHeldCents: 10_000,
      releasedFromCancelled: [{ amountCents: 54_253, billMonth: "2027-01", releasedOn: "2027-01-20T16:00:00Z", lotNumber: "9", payerName: "Household 9", ...released }] });
    const own = lines.find((l) => /bill was cancelled/.test(l))!;
    expect(own).toBe(
      "$542.53 that Lot 9 paid on their January 2027 bill went on account for them when that bill was cancelled on January 20, 2027. " +
      "It IS in the total above — it arrived as rent — and the file marks that bill CANCELLED and says where the money went: $472.53 to January 2027, $70.00 still held.",
    );
    // The on-account sentence is about the $100 received on account, untouched.
    const acct = lines.find((l) => /NOT in the total above/.test(l))!;
    expect(acct).toContain("$100.00 received on account");
    expect(acct).not.toMatch(/\$70\.00|\$170\.00|still held/);
    expect(lines.join(" ")).not.toMatch(/2027-01/);
    // The hand-back clause, the household by name when there is no lot, and
    // no date clause when the record lacks one.
    const handed = exclusionLines({ ...base, releasedFromCancelled: [{ amountCents: 54_253, billMonth: "2027-01", releasedOn: null, lotNumber: null, payerName: "Household 9",
      allocations: released.allocations, remainingCents: 0, handedBackCents: 7_000, handedBackOn: "2027-01-22", handedBackInFile: true }] }).find((l) => /bill was cancelled/.test(l))!;
    expect(handed).toContain("$542.53 that Household 9 paid on their January 2027 bill went on account for them when that bill was cancelled. It IS in the total above");
    expect(handed).toContain("$472.53 to January 2027, $70.00 handed back on January 22, 2027 — its own line below and in the file.");
    // WHICH FILE THE HAND-BACK'S LINE IS IN. The stamp is read off the view
    // with no window; the negative row by the day it went back. A $70.00
    // handed back on 3 February is in FEBRUARY's file, and January's note
    // promised "its own line below and in the file" about a line it did
    // not carry. The loader's own windowed read decides (handedBackInFile).
    const later = exclusionLines({ ...base, releasedFromCancelled: [{ amountCents: 54_253, billMonth: "2027-01", releasedOn: null, lotNumber: "9", payerName: null,
      allocations: released.allocations, remainingCents: 0, handedBackCents: 7_000, handedBackOn: "2027-02-03", handedBackInFile: false }] }).find((l) => /bill was cancelled/.test(l))!;
    expect(later).toContain("$472.53 to January 2027, $70.00 handed back on February 3, 2027 — its own line in the statement for February 2027.");
    expect(later).not.toMatch(/below and in the file/);
    // The one helper, both ways, and as a sentence for the screen.
    expect(handedBackWhere({ handedBackCents: 7_000, handedBackOn: "2027-02-03", handedBackInFile: false }, { asSentence: true }))
      .toBe("$70.00 was handed back on February 3, 2027 — its own line in the statement for February 2027");
    expect(handedBackWhere({ handedBackCents: 7_000, handedBackOn: "2027-01-22", handedBackInFile: true }))
      .toBe("$70.00 handed back on January 22, 2027 — its own line below and in the file");
    expect(handedBackWhere({ handedBackCents: 7_000, handedBackOn: null, handedBackInFile: false }))
      .toBe("$70.00 handed back — its own line in the statement for the month it went back");
    // THE PART MONTH SHARES THE CANCELLED BILL'S MONTH (0169): a line the
    // loader marked as the re-raise is named as such, apart from the
    // cancelled January the sentence just named.
    const collide = exclusionLines({ ...base, releasedFromCancelled: [{ ...released, amountCents: 54_253, billMonth: "2027-01", releasedOn: null, lotNumber: "9", payerName: null,
      allocations: [{ periodMonth: "2027-01", amount: 472.53, raisedAgain: { basis: "27 of 31 days" } }] }] }).find((l) => /bill was cancelled/.test(l))!;
    expect(collide).toContain("says where the money went: $472.53 to the bill raised again for January 2027 (27 of 31 days), $70.00 still held.");
    // Nothing released: no sentence.
    expect(exclusionLines({ ...base }).some((l) => /bill was cancelled/.test(l))).toBe(false);
    expect(exclusionLines({ ...base, releasedFromCancelled: [] }).some((l) => /bill was cancelled/.test(l))).toBe(false);
  });
});
