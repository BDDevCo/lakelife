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
    expect(c).toContain("2026-08-03");
    expect(c).toContain("ref 1042");
  });

  it("counterfoil falls back to the lot when the roll names nobody", () => {
    expect(receiptCounterfoil({ ...base, payerName: null })).toContain("Lot 3   Lot 3");
  });
});
