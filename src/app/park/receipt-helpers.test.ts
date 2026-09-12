import { describe, it, expect } from "vitest";
import {
  receiptRef, receiptBody, receiptCounterfoil,
  dropSlipSerials, dropSlipHalf, dropSlipSummary,
  type ReceiptLines,
} from "./receipt-helpers";

const base: ReceiptLines = {
  parkName: "The Haven",
  officeLine: "Questions? The office, or (260) 555-0100.",
  receiptNo: 47,
  lotNumber: "3",
  payerName: "Amberg, Roy",
  amount: 455,
  method: "check",
  reference: "1042",
  receivedOn: "2026-08-03",
  periodMonth: "2026-08",
  billAmount: 455,
  balanceAfter: 0,
};

describe("the receipt", () => {
  it("carries a quotable reference built from the park's own book", () => {
    expect(receiptRef("The Haven", 47, "2026-08-03")).toBe("TH-2026-0047");
    expect(receiptRef("Big Long Lake Park", 3, "2027-01-01")).toBe("BLL-2027-0003");
  });

  it("survives a park with no usable initials", () => {
    expect(receiptRef("", 1, "2026-08-03")).toBe("P-2026-0001");
  });

  it("says nothing at all when there is no receipt number", () => {
    expect(receiptRef("The Haven", null, "2026-08-03")).toBe("—");
  });

  it("states what was taken, against what, and what is left", () => {
    const b = receiptBody({ ...base, amount: 300, balanceAfter: 155 });
    expect(b).toContain("$300.00");
    expect(b).toContain("Lot             3");
    expect(b).toContain("August 2026 rent");
    expect(b).toContain("Still owing     $155.00");
    // AND THE DAY IN WORDS. "Date taken      2026-08-03" sat one line above
    // "Against August 2026 rent" — the only machine date on the paper, on a
    // receipt a resident holds next to a screen that says "August 3, 2026".
    expect(b).toContain("Date taken      August 3, 2026");
    expect(b).not.toContain("2026-08-03");
  });

  it("says plainly when nothing further is owed, rather than printing $0.00", () => {
    expect(receiptBody(base)).toContain("nothing further owing");
    expect(receiptBody(base)).not.toContain("Still owing");
  });

  it("reports an overpayment as credit rather than a negative balance", () => {
    const b = receiptBody({ ...base, amount: 500, balanceAfter: -45 });
    expect(b).toContain("In credit       $45.00");
    expect(b).not.toContain("-$45.00");
  });

  it("does NOT let a check receipt read as a guarantee the money cleared", () => {
    // A receipt for a check is a receipt for a piece of paper.
    expect(receiptBody(base)).toMatch(/If it doesn't clear/);
  });

  it("makes no such claim for cash, where there is nothing to clear", () => {
    const b = receiptBody({ ...base, method: "cash", reference: null });
    expect(b).not.toMatch(/clear/);
    expect(b).toContain("How             cash");
  });

  it("greets a 'Surname, Given' roll entry by the surname on it", () => {
    expect(receiptBody(base)).toContain("Received from   Amberg");
  });

  it("falls back to the lot when the roll names nobody", () => {
    // The Haven's real rent roll names nobody. That must still produce a
    // receipt rather than an empty line.
    expect(receiptBody({ ...base, payerName: null })).toContain("Received from   Lot 3");
  });
});

describe("drop slips", () => {
  it("issues consecutive serials from the park's counter", () => {
    const s = dropSlipSerials("The Haven", 41, 3);
    expect(s.map((x) => x.serial)).toEqual(["TH-00041", "TH-00042", "TH-00043"]);
  });

  it("returns nothing rather than throwing on a zero or negative count", () => {
    expect(dropSlipSerials("The Haven", 1, 0)).toEqual([]);
    expect(dropSlipSerials("The Haven", 1, -5)).toEqual([]);
  });

  it("prints two halves carrying the SAME serial", () => {
    const [slip] = dropSlipSerials("The Haven", 41, 1);
    const box = dropSlipHalf(slip, "box", "The office.");
    const keep = dropSlipHalf(slip, "keep", "The office.");
    expect(box).toContain("TH-00041");
    expect(keep).toContain("TH-00041");
    expect(box).toContain("PUT THIS IN THE BOX");
    expect(keep).toContain("KEEP THIS");
  });

  it("leaves the fields BLANK — a slip is picked up before anyone knows who needs it", () => {
    const [slip] = dropSlipSerials("The Haven", 1, 1);
    const half = dropSlipHalf(slip, "keep", "The office.");
    expect(half).toMatch(/Lot _+/);
    expect(half).toMatch(/Amount \$ _+/);
    expect(half).toMatch(/Cash \[ {2}\]/);
  });

  it("tells the renter what their half is FOR", () => {
    const [slip] = dropSlipSerials("The Haven", 1, 1);
    expect(dropSlipHalf(slip, "keep", "The office.")).toMatch(/isn't credited to you/);
  });

  it("warns that printing uses the numbers up", () => {
    // The only property that makes a serial evidence is that it was issued once.
    const s = dropSlipSummary(41, 20);
    expect(s).toContain("numbered 41 to 60");
    expect(s).toContain("next sheet starts at 61");
  });

  it("says nothing to print rather than describing an empty range", () => {
    expect(dropSlipSummary(41, 0)).toBe("Nothing to print.");
  });
});

describe("the renter's own confirmation", () => {
  it("puts the confirm link on a receipt that has one", () => {
    const b = receiptBody({ ...base, confirmUrl: "https://lakelife.ai/c/abc123" });
    expect(b).toContain("https://lakelife.ai/c/abc123");
    expect(b).toMatch(/match what you handed over/);
  });

  it("prints NO link when there is nowhere to tap one", () => {
    // A URL nobody can type is worse than no URL — it just makes the paper
    // household's copy look like the incomplete version.
    const b = receiptBody({ ...base, confirmUrl: null });
    expect(b).not.toMatch(/https?:\/\//);
    expect(b).not.toMatch(/Say so here/);
  });

  it("gives the office a counterfoil the renter signs, same receipt number", () => {
    const c = receiptCounterfoil(base);
    expect(c).toContain("TH-2026-0047");
    expect(c).toMatch(/Signed _+/);
    expect(c).toMatch(/matches what I handed over/);
  });

  it("counterfoil carries the money facts so a signature means something", () => {
    const c = receiptCounterfoil(base);
    expect(c).toContain("$455.00");
    expect(c).toContain("Lot 3");
    // THE DATE IN WORDS. This pinned "2026-08-03" on the half the office signs —

    // the one line on the paper that was a machine date, beside "Against

    // August 2026 rent" and under a screen that says "August 3, 2026".

    expect(c).toContain("August 3, 2026");

    expect(c).not.toContain("2026-08-03");
    expect(c).toContain("ref 1042");
  });

  it("counterfoil falls back to the lot when the roll names nobody", () => {
    expect(receiptCounterfoil({ ...base, payerName: null })).toContain("Lot 3   Lot 3");
  });
});

// ---------------------------------------------------------------------------
// MORE THAN THE BILL, ON THE PAPER THEY KEEP.
//
// $600 for a $542.53 bill is split by recordPayment: the bill's balance
// against the bill, the rest on account with its own receipt number. The
// receipt for what they handed over has to show both, or "Amount $600.00 /
// Against January rent — $542.53" is a receipt that raises the question it
// exists to answer.
// ---------------------------------------------------------------------------
describe("a receipt for more than the bill", () => {
  const split: ReceiptLines = {
    ...base, amount: 600, billAmount: 542.53, balanceAfter: 0,
    periodMonth: "2027-01", receivedOn: "2027-01-05", receiptNo: 101,
    onAccount: { amount: 57.47, receiptNo: 102 },
  };

  it("shows the whole amount, then how it was split", () => {
    const b = receiptBody(split);
    expect(b).toMatch(/Amount\s+\$600\.00/);
    expect(b).toMatch(/to this bill\s+\$542\.53/);
    expect(b).toMatch(/on account\s+\$57\.47/);
    expect(b).toContain("Against         January 2027 rent — $542.53");
    expect(b).toContain("nothing further owing on this one");
    expect(b).not.toContain("In credit");
  });

  it("says where the rest is, with its own receipt number, and promises nothing", () => {
    const b = receiptBody(split);
    expect(b).toContain("The $57.47 on account is held by the office and hasn't been put");
    expect(b).toContain("against a bill yet. It stays yours until it is (receipt TH-2027-0102).");
    // Nothing applies it to the next bill on its own.
    expect(b).not.toMatch(/next bill|will be applied|come off/i);
  });

  it("survives a missing second receipt number", () => {
    const b = receiptBody({ ...split, onAccount: { amount: 57.47, receiptNo: null } });
    expect(b).toContain("It stays yours until it is.");
    expect(b).not.toContain("(receipt");
  });

  it("prints none of it on an ordinary receipt", () => {
    for (const r of [base, { ...base, onAccount: null }, { ...base, onAccount: { amount: 0, receiptNo: null } }]) {
      const b = receiptBody(r);
      expect(b).not.toMatch(/on account/);
      expect(b).not.toMatch(/to this bill/);
    }
  });

  it("the counterfoil they sign names what they handed over", () => {
    expect(receiptCounterfoil(split)).toContain("$600.00");
  });
});

describe("how it came, in the words the form used", () => {
  it("a bank push the office keyed reads 'bank transfer', as the form called it", () => {
    // The rent screen's form says "Bank transfer" and files `transfer`; the
    // receipt used to print "transfer" for it and "bank transfer" only for
    // the processor's `ach` row.
    expect(receiptBody({ ...base, method: "transfer", reference: "Zelle" }))
      .toContain("How             bank transfer Zelle");
    expect(receiptBody({ ...base, method: "ach", reference: "ch_1" }))
      .toContain("How             bank transfer ch_1");
  });
});
