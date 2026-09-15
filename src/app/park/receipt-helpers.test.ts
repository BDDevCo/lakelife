import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("says where the rest is, with its own receipt number, and promises what the run keeps", () => {
    // The run puts money on account against the next bill it raises (0167),
    // so the paper may say so — and must not say "hasn't been put against a
    // bill yet" as though nothing ever would.
    const b = receiptBody(split);
    expect(b).toContain("The $57.47 on account is held by the office and comes off your next");
    expect(b).toContain("bill. It stays yours until then (receipt TH-2027-0102).");
    expect(b).not.toMatch(/hasn't been put/);
  });

  it("survives a missing second receipt number", () => {
    const b = receiptBody({ ...split, onAccount: { amount: 57.47, receiptNo: null } });
    expect(b).toContain("It stays yours until then.");
    expect(b).not.toContain("(receipt");
  });

  it("when the excess settled an older bill at record time and what is left could not be read, the paper says so — never the whole as held", () => {
    // recordPayment leaves `remaining` out when the view read failed. The
    // old fallback `?? acct.amount` then printed "$40.00 to December 2026,
    // $57.47 on account" — more than the cheque — and promised $57.47 that
    // is $40 on December.
    const b = receiptBody({
      ...split,
      onAccount: { amount: 57.47, receiptNo: 102, appliedTo: [{ periodMonth: "2026-12", amount: 40 }] },
    });
    expect(b).toContain("Of the $57.47 on account: $40.00 to December 2026 (receipt TH-2027-0102).");
    expect(b).toContain("What's still on account wasn't read when this was printed — ask at the office.");
    expect(b).not.toMatch(/December 2026, \$57\.47 on account/);
    expect(b).not.toMatch(/\$17\.47/);
    expect(b).not.toMatch(/still on account comes off/);
    expect(b).not.toMatch(/held by the office/);
  });

  it("printed at record time, says where the on-account part went", () => {
    const b = receiptBody({
      ...split,
      onAccount: { amount: 57.47, receiptNo: 102, appliedTo: [{ periodMonth: "2027-02", amount: 57.47 }], remaining: 0 },
    });
    expect(b).toContain("Of the $57.47 on account: $57.47 to February 2027 (receipt TH-2027-0102).");
    expect(b).not.toMatch(/comes off your next/);
    const part = receiptBody({
      ...split,
      onAccount: { amount: 57.47, receiptNo: 102, appliedTo: [{ periodMonth: "2027-02", amount: 40 }], remaining: 17.47 },
    });
    expect(part).toContain("Of the $57.47 on account: $40.00 to February 2027, $17.47 on account (receipt TH-2027-0102).");
    expect(part).toContain("The $17.47 still on account comes off your next bill.");
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

// ---------------------------------------------------------------------------
// MONEY OF THEIRS THE OFFICE ALREADY HELD, PUT AGAINST THIS BILL (0167). A
// household with $342.53 on account hands over $200; the bill is settled. A
// receipt reading "Amount $200.00 … nothing further owing" on a $542.53 bill
// is one the household cannot reconcile, so the paper names the other part.
// ---------------------------------------------------------------------------
describe("a receipt where money on account went in beside the cash", () => {
  const topped: ReceiptLines = {
    ...base, amount: 200, billAmount: 542.53, balanceAfter: 0, periodMonth: "2027-01", receivedOn: "2027-01-05",
    fromOnAccount: 342.53,
  };

  it("prints the part from on account as its own line, and says it in words", () => {
    const b = receiptBody(topped);
    expect(b).toMatch(/Amount\s+\$200\.00/);
    expect(b).toContain("From on account $342.53");
    expect(b).toContain("$342.53 you already had on account with the office went against this");
    expect(b).toContain("nothing further owing on this one");
  });

  it("prints none of it when nothing came from on account", () => {
    for (const r of [base, { ...base, fromOnAccount: null }, { ...base, fromOnAccount: 0 }]) {
      const b = receiptBody(r);
      expect(b).not.toMatch(/From on account/);
      expect(b).not.toMatch(/already had on account/);
    }
  });
});

// ---------------------------------------------------------------------------
// A RECEIPT FOR MONEY ON ACCOUNT ITSELF — a quarter paid ahead. There is no
// bill to print "Against … rent" for; the paper says where the money has gone
// so far and what is still held.
// ---------------------------------------------------------------------------
describe("a receipt for money on account", () => {
  const ahead: ReceiptLines = {
    ...base, kind: "on_account", amount: 1627.59, receivedOn: "2026-12-28", periodMonth: "", billAmount: 0, balanceAfter: 0,
    onAccount: {
      amount: 1627.59, receiptNo: 47,
      appliedTo: [{ periodMonth: "2027-02", amount: 542.53 }, { periodMonth: "2027-01", amount: 542.53 }],
      remaining: 542.53,
    },
  };

  it("lists its allocations in month order, then what is still on account", () => {
    const b = receiptBody(ahead);
    expect(b).toContain("Against         money on account");
    expect(b).toContain("Where it went   $542.53 to January 2027, $542.53 to February 2027, $542.53 on account");
    expect(b).toContain("The $542.53 on account is held by the office and comes off your next");
    expect(b).not.toMatch(/rent —/);
    expect(b).not.toMatch(/Still owing|In credit|nothing further owing/);
  });

  it("fresh from the window, before anything has been applied, it says only that it is held", () => {
    const b = receiptBody({ ...ahead, onAccount: { amount: 1627.59, receiptNo: 47 } });
    expect(b).not.toContain("Where it went");
    expect(b).toContain("The $1,627.59 on account is held by the office and comes off your next");
  });

  it("applied lines with no held figure: the months, then 'wasn't read' — never the whole cheque as held", () => {
    const b = receiptBody({
      ...ahead,
      onAccount: { amount: 1627.59, receiptNo: 47, appliedTo: [{ periodMonth: "2027-01", amount: 542.53 }] },
    });
    expect(b).toContain("Where it went   $542.53 to January 2027");
    expect(b).not.toMatch(/January 2027, \$1,627\.59 on account/);
    expect(b).toContain("What's still on account wasn't read when this was printed — ask at the office.");
    expect(b).not.toMatch(/held by the office/);
    // And the source never falls back to the amount for a figure it lacks.
    const src = readFileSync(join(process.cwd(), "src", "app", "park", "receipt-helpers.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/remaining \?\? r\.amount/);
    expect(src).not.toMatch(/remaining \?\? acct\.amount/);
    expect(src.match(/stillHeld\(/g)?.length, "both branches ask the one helper").toBe(3);
  });

  it("all applied: nothing is promised about a next bill", () => {
    const b = receiptBody({
      ...ahead,
      onAccount: { amount: 1085.06, receiptNo: 47, appliedTo: [{ periodMonth: "2027-01", amount: 542.53 }, { periodMonth: "2027-02", amount: 542.53 }], remaining: 0 },
    });
    expect(b).toContain("Where it went   $542.53 to January 2027, $542.53 to February 2027");
    expect(b).not.toMatch(/comes off your next/);
  });

  it("a check receipt still says what a check receipt is for", () => {
    expect(receiptBody(ahead)).toContain("This is a receipt for the check itself. If it doesn't clear, any bill");
  });
});
