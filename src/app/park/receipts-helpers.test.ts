import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { monthPeriod, quarterPeriod, yearPeriod, customPeriod, inPeriod, summariseReceipts, receiptsCsv, receiptsFilename, receiptsHeadline, csvText, linesCell, money, decimal, exclusionLines, type Receipt, type OtherReceipt } from "./receipts-helpers";

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
    amountCents: 50000, feeCents: 0, method: "check", reference: null, ...over,
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
