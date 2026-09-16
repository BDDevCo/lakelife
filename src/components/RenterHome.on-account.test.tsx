import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RenterHome as RenterHomeView, Bill } from "@/app/parks/my-data";

/**
 * HER MONEY THAT IS NOT AGAINST A BILL.
 *
 * $600 for a $542.53 January: the ledger read "In credit +$57.47", the office
 * could see the money, and her screen said "$542.53 — Paid in full — thank
 * you." The $57.47 was invisible to the one person it belongs to, and February
 * was raised in full. The split now puts it on account; this is the screen
 * saying so.
 *
 * SINCE 0167 THE PROMISE IS KEPT. The run puts money on account against the
 * next bill it raises for her, oldest money first, and the office can put it
 * against an open bill by hand; both settle her OLDEST open bill first (R1)
 * — so "it comes off your bills, oldest first" is a fact about the software,
 * and the screen says it. The figure is what is
 * STILL on account (the view's `remaining`), and a bill settled from it says
 * so, because her payment list shows one $1,627.59 cheque and no $542.53.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));
vi.mock("@/components/PayRentButton", () => ({ PayRentButton: () => <i>pay</i> }));
vi.mock("@/components/IPaidForm", () => ({ IPaidForm: () => <i>ipaid</i> }));
vi.mock("@/components/TextOptIn", () => ({ TextOptIn: () => <i>texts</i> }));
vi.mock("@/components/EnableLotBooking", () => ({ EnableLotBooking: () => <i>booking</i> }));

const { RenterHome } = await import("./RenterHome");

const bill = (over: Partial<Bill> = {}): Bill => ({
  id: "charge-9", monthLabel: "January 2027", dueOn: "2027-01-01",
  amount: 542.53, paidTotal: 0, outstanding: 542.53, status: "open",
  disputed: false, claimedPaidOn: null, lines: [], fromOnAccount: 0, fromCancelledBill: null, ...over,
});

const view = (over: Partial<RenterHomeView> = {}): RenterHomeView => ({
  parkName: "The Haven", parkAddress: "9085 E 500 S, Wolcottville, IN 46795",
  lotNumber: "9", hasSticker: false,
  displayName: "Household 9", since: "2015-04-01",
  textsOn: false, textNumber: null, term: "monthly", leavingOn: null,
  acceptsOnlineRent: false, hasCard: false, bookingReady: false, cardFeePct: 0,
  today: "2027-01-06",
  bill: null, arrears: [], tenancyEnded: null, finalMonthBilled: false, deposit: null, depositReturned: null, onAccount: 0,
  payments: [], reported: [], reportedFailed: false,
  ...over,
});

/** Rendered markup as a person reads it: tags gone, the apostrophe React escapes decoded. */
const words = (v: RenterHomeView) =>
  renderToStaticMarkup(<RenterHome view={v} />).replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("money on account with the office", () => {
  it("is shown, as what it is, and says it comes off her bills, oldest first — which is what every door does", () => {
    const w = words(view({ onAccount: 1085.06 }));
    expect(w).toMatch(/On account/);
    expect(w).toMatch(/\$1,085\.06/);
    const card = w.slice(w.indexOf("On account"), w.indexOf("Your agreement"));
    expect(card.length).toBeGreaterThan(20);
    expect(card).toMatch(/with the office/);
    expect(card).toMatch(/comes off your bills, oldest first/);
    // Never "next": after the office takes a line back off a bill (R3) the
    // money is on account WHILE that bill is open again, and it is that
    // bill — not a next one — the next run puts it against (R1).
    expect(card).not.toMatch(/next bill/);
  });

  it("says the same true thing when a bill is open beside it — the state after a correction", () => {
    const w = words(view({ onAccount: 542.53, bill: bill({ monthLabel: "February 2027" }) }));
    const card = w.slice(w.indexOf("On account"), w.indexOf("Your agreement"));
    expect(card).toMatch(/comes off your bills, oldest first/);
    expect(w).toMatch(/February 2027/);
    expect(w).not.toMatch(/next bill/);
  });

  it("no longer calls it 'not yet against a bill' — that was the old shape, where nothing applied it", () => {
    const w = words(view({ onAccount: 57.47 }));
    expect(w).not.toMatch(/not yet against a bill/);
    // And never a promise about WHEN beyond the next bill: the run decides.
    expect(w).not.toMatch(/will be applied|automatically/i);
  });

  it("says nothing at all when there is none", () => {
    expect(words(view({ onAccount: 0 }))).not.toMatch(/On account/);
    expect(words(view({ onAccount: undefined }))).not.toMatch(/On account/);
  });
});

describe("a bill settled from money on account says so", () => {
  it("'Paid in full' names how much came from money she had on account", () => {
    const w = words(view({ bill: bill({ paidTotal: 542.53, outstanding: 0, status: "paid", fromOnAccount: 542.53 }) }));
    expect(w).toMatch(/Paid in full — thank you/);
    expect(w).toMatch(/\$542\.53 of it came from money you had on account/);
  });

  it("a bill paid the ordinary way says nothing of the kind", () => {
    const w = words(view({ bill: bill({ paidTotal: 542.53, outstanding: 0, status: "paid", fromOnAccount: 0 }) }));
    expect(w).toMatch(/Paid in full — thank you/);
    expect(w).not.toMatch(/money you had on account/);
  });

  it("a bill part-settled from it says what came off and what is left", () => {
    const w = words(view({ bill: bill({ paidTotal: 200, outstanding: 342.53, status: "open", fromOnAccount: 200 }) }));
    expect(w).toMatch(/\$342\.53/);
    expect(w).toMatch(/\$200\.00 received so far — from money you had on account/);
  });

  it("a bill part-paid by cheque AND from money on account names both", () => {
    const w = words(view({ bill: bill({ paidTotal: 300, outstanding: 242.53, status: "open", fromOnAccount: 100 }) }));
    expect(w).toMatch(/\$300\.00 received so far — \$100\.00 of it from money you had on account/);
  });

  it("an arrears month part-settled from it says so on its row", () => {
    const w = words(view({
      bill: bill({ id: "c2", monthLabel: "February 2027", dueOn: "2027-02-01" }),
      arrears: [bill({ id: "c1", monthLabel: "January 2027", dueOn: "2027-01-01", paidTotal: 300, outstanding: 242.53, fromOnAccount: 300 })],
    }));
    const row = w.slice(w.indexOf("Still owing from earlier"));
    expect(row).toMatch(/\$300\.00 came off money you had on account/);
  });

  it("an arrears month nothing on account touched keeps its plain row", () => {
    const w = words(view({
      bill: bill({ id: "c2", monthLabel: "February 2027", dueOn: "2027-02-01" }),
      arrears: [bill({ id: "c1", monthLabel: "January 2027", dueOn: "2027-01-01", paidTotal: 0, outstanding: 542.53 })],
    }));
    expect(w).not.toMatch(/money you had on account/);
  });
});

describe("a bill paid over — the older shape, before the split existed", () => {
  const over = view({ bill: bill({ paidTotal: 600, outstanding: -57.47, status: "paid" }) });

  it("never says 'Paid in full' about money that exceeded the bill", () => {
    expect(words(over)).not.toMatch(/Paid in full/);
  });

  it("prints what she paid, not the bill's face value, and names the excess", () => {
    const w = words(over);
    expect(w).toMatch(/\$600\.00/);
    expect(w).toMatch(/\$57\.47 more than this bill/);
    expect(w).toMatch(/ask them to put it toward your next one/);
  });

  it("the big number is never the bill amount over a negative balance", () => {
    const src = readFileSync(fileURLToPath(new URL("./RenterHome.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/money\(b\.outstanding > 0 \? b\.outstanding : b\.amount\)/);
    expect(src).toMatch(/money\(b\.outstanding > 0 \? b\.outstanding : b\.outstanding < 0 \? b\.paidTotal : b\.amount\)/);
  });

  // THE RIGHT THING EXISTED AND THE DOOR DID NOT USE IT: a private `usd`
  // here with the body of ledger-helpers' money() — the one shape for a
  // figure about money on account, which this screen prints in four places.
  it("prints money through the one money() in ledger-helpers, not a private copy", () => {
    const src = readFileSync(fileURLToPath(new URL("./RenterHome.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/import \{ money, monthList \} from "@\/app\/park\/ledger-helpers"/);
    expect(src).not.toMatch(/const usd = /);
    expect(src).not.toMatch(/style: "currency"/);
    expect((src.match(/\bmoney\(/g) ?? []).length).toBeGreaterThan(10);
    // And the shape on screen is the panel's: a thousands comma, two places.
    const w = words(view({ onAccount: 1627.59 }));
    expect(w).toMatch(/\$1,627\.59/);
  });

  it("'Paid in full' still stands for a bill settled to the cent", () => {
    const exact = view({ bill: bill({ paidTotal: 542.53, outstanding: 0, status: "paid" }) });
    expect(words(exact)).toMatch(/Paid in full — thank you/);
  });
});

describe("the loader hands the screen the on-account figure", () => {
  const src = readFileSync(fileURLToPath(new URL("../app/parks/my-data.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads exactly the view the office's held-money screen reads (0167), and only what is still held", () => {
    // park_on_account_payments IS 0102's predicate — kind rent, no charge,
    // not reversed, not pulled back by the bank — with the database's own
    // `remaining`. One definition, both screens.
    const at = src.indexOf('.from("park_on_account_payments")');
    expect(at).toBeGreaterThan(0);
    const read = src.slice(at, at + 300);
    expect(read).toMatch(/\.select\("payment_id, remaining"\)/);
    expect(read).toMatch(/\.eq\("renter_id", file\.id as string\)/);
    expect(read).toMatch(/\.gt\("remaining", 0\)/);
    // And the figure is remaining, not amount.
    expect(src).toMatch(/Number\(p\.remaining \?\? 0\)/);
    expect(src).not.toMatch(/\.select\("amount"\)/);
  });

  it("refuses rather than printing zero when that read fails", () => {
    expect(src).toMatch(/mustRead\("money you have on account", acctRes\)/);
  });

  it("writes the field the screen reads", () => {
    expect(src).toMatch(/^\s+onAccount,$/m);
  });

  it("writes fromOnAccount onto every bill from the allocations it read", () => {
    expect(src).toMatch(/fromOnAccount: \(fromOnAccountCents\.get\(c\.id as string\) \?\? 0\) \/ 100,/);
    expect(src).toMatch(/mustRead\("where your money on account went", allocRes\)/);
  });
});

/**
 * MONEY A CANCELLED BILL RELEASED (0169). She paid January in full; she left
 * on the 20th; the office cancelled the whole-month bill and raised the
 * part month, settled from the money the cancelled bill released. Her list
 * shows that cheque against January — so "$472.53 of it came from money you
 * had on account" is a sentence about money she never put on account. Every
 * sentence that said so now names the bill instead, and the $57.47 of a $600
 * cheque that WAS on account is still accounted for beside it.
 */
describe("a bill settled from what she had paid on a cancelled bill names that bill", () => {
  const jan = { months: ["2027-01"], amount: 472.53 };

  it("'Paid in full' says what she'd already paid on the January 2027 bill that was cancelled — never 'money you had on account'", () => {
    const w = words(view({ bill: bill({ monthLabel: "January 2027", paidTotal: 472.53, outstanding: 0, status: "paid", fromOnAccount: 472.53, fromCancelledBill: jan }) }));
    expect(w).toMatch(/Paid in full — thank you\. \$472\.53 of it came from what you'd already paid on the January 2027 bill that was cancelled\./);
    expect(w).not.toMatch(/money you had on account/);
    expect(w).not.toMatch(/2027-01/);
    // Collapsed: with no cancelled bill the old sentence stands.
    const plain = words(view({ bill: bill({ paidTotal: 472.53, outstanding: 0, status: "paid", fromOnAccount: 472.53, fromCancelledBill: null }) }));
    expect(plain).toMatch(/\$472\.53 of it came from money you had on account\./);
    expect(plain).not.toMatch(/cancelled/);
  });

  it("…and when the rest was ordinary money on account, both are named — the $57.47 is not left unaccounted for", () => {
    // A $600 cheque on January: $542.53 against the bill, $57.47 on account.
    // January cancelled; the $472.53 part month took $415.06 of the released
    // money and the $57.47 that was on account.
    const w = words(view({ bill: bill({ paidTotal: 472.53, outstanding: 0, status: "paid", fromOnAccount: 472.53, fromCancelledBill: { months: ["2027-01"], amount: 415.06 } }) }));
    expect(w).toMatch(/\$415\.06 of it came from what you'd already paid on the January 2027 bill that was cancelled, and \$57\.47 from money you had on account\./);
  });

  it("'received so far' on a part-paid part month threads it too — all of it, or the part", () => {
    // A $400 cheque paid on January, released against the $472.53 part month.
    const all = words(view({ bill: bill({ amount: 472.53, paidTotal: 400, outstanding: 72.53, status: "open", fromOnAccount: 400, fromCancelledBill: { months: ["2027-01"], amount: 400 } }) }));
    expect(all).toMatch(/\$400\.00 received so far — all of it from what you'd already paid on the January 2027 bill that was cancelled\./);
    expect(all).not.toMatch(/money you had on account/);
    // Part of it: $300 from the cancelled bill's money, $100 by a later cheque.
    const part = words(view({ bill: bill({ amount: 472.53, paidTotal: 400, outstanding: 72.53, status: "open", fromOnAccount: 300, fromCancelledBill: { months: ["2027-01"], amount: 300 } }) }));
    expect(part).toMatch(/\$400\.00 received so far — \$300\.00 of it from what you'd already paid on the January 2027 bill that was cancelled\./);
    // And released money plus ordinary money on account, by cheque for the rest.
    const both = words(view({ bill: bill({ amount: 472.53, paidTotal: 400, outstanding: 72.53, status: "open", fromOnAccount: 350, fromCancelledBill: { months: ["2027-01"], amount: 300 } }) }));
    expect(both).toMatch(/\$400\.00 received so far — \$300\.00 of it from what you'd already paid on the January 2027 bill that was cancelled, and \$50\.00 from money you had on account\./);
    // Collapsed: no cancelled bill keeps the two old shapes.
    expect(words(view({ bill: bill({ paidTotal: 200, outstanding: 342.53, status: "open", fromOnAccount: 200 }) }))).toMatch(/\$200\.00 received so far — from money you had on account\./);
    expect(words(view({ bill: bill({ paidTotal: 300, outstanding: 242.53, status: "open", fromOnAccount: 100 }) }))).toMatch(/\$300\.00 received so far — \$100\.00 of it from money you had on account\./);
  });

  it("an arrears month part-settled from released money names the bill on its row", () => {
    const w = words(view({
      bill: bill({ id: "c2", monthLabel: "February 2027", dueOn: "2027-02-01" }),
      arrears: [bill({ id: "c1", monthLabel: "January 2027", dueOn: "2027-01-01", amount: 472.53, paidTotal: 300, outstanding: 172.53, fromOnAccount: 300, fromCancelledBill: { months: ["2027-01"], amount: 300 } })],
    }));
    const row = w.slice(w.indexOf("Still owing from earlier"));
    expect(row).toMatch(/\$300\.00 of it came from what you'd already paid on the January 2027 bill that was cancelled\./);
    expect(row).not.toMatch(/came off money you had on account/);
    // Collapsed: the plain row keeps its own words.
    const plain = words(view({
      bill: bill({ id: "c2", monthLabel: "February 2027", dueOn: "2027-02-01" }),
      arrears: [bill({ id: "c1", monthLabel: "January 2027", dueOn: "2027-01-01", paidTotal: 300, outstanding: 242.53, fromOnAccount: 300 })],
    }));
    expect(plain.slice(plain.indexOf("Still owing from earlier"))).toMatch(/\$300\.00 came off money you had on account\./);
  });

  it("a part month settled from TWO cancelled bills' money names both, and none of it is 'money you had on account'", () => {
    // January part-paid $400 by cheque; February raised early and paid
    // $542.53; the move-out (27 January) recorded on 3 February. endTenancy
    // cancelled both bills and settled the $472.53 part month from both:
    // $400 of January's money and $72.53 of February's. The $72.53 was her
    // February cheque — she never put it on account.
    const w = words(view({ bill: bill({ amount: 472.53, paidTotal: 472.53, outstanding: 0, status: "paid", fromOnAccount: 472.53, fromCancelledBill: { months: ["2027-01", "2027-02"], amount: 472.53 } }) }));
    expect(w).toMatch(/Paid in full — thank you\. \$472\.53 of it came from what you'd already paid on the January 2027 and February 2027 bills that were cancelled\./);
    expect(w).not.toMatch(/money you had on account/);
    expect(w).not.toMatch(/bill that was cancelled/);
    // The month order is the list's, not the fixture's.
    const flipped = words(view({ bill: bill({ amount: 472.53, paidTotal: 472.53, outstanding: 0, status: "paid", fromOnAccount: 472.53, fromCancelledBill: { months: ["2027-02", "2027-01"], amount: 472.53 } }) }));
    expect(flipped).toMatch(/January 2027 and February 2027 bills that were cancelled/);
    // Part-paid: "all of it" reads the SUMMED figure against paidTotal, so
    // $400 of January's and $50 of February's on a $472.53 part month is
    // all of the $450 received — never "$400.00 of it" with $50 unexplained.
    const open = words(view({ bill: bill({ amount: 472.53, paidTotal: 450, outstanding: 22.53, status: "open", fromOnAccount: 450, fromCancelledBill: { months: ["2027-01", "2027-02"], amount: 450 } }) }));
    expect(open).toMatch(/\$450\.00 received so far — all of it from what you'd already paid on the January 2027 and February 2027 bills that were cancelled\./);
    expect(open).not.toMatch(/money you had on account/);
    // And the plain remainder is off the sum: $472.53 from two cancelled
    // bills plus $27.47 that WAS on account.
    const both = words(view({ bill: bill({ amount: 500, paidTotal: 500, outstanding: 0, status: "paid", fromOnAccount: 500, fromCancelledBill: { months: ["2027-01", "2027-02"], amount: 472.53 } }) }));
    expect(both).toMatch(/\$472\.53 of it came from what you'd already paid on the January 2027 and February 2027 bills that were cancelled, and \$27\.47 from money you had on account\./);
    // Collapsed to one month: the singular sentence stands.
    const one = words(view({ bill: bill({ amount: 472.53, paidTotal: 472.53, outstanding: 0, status: "paid", fromOnAccount: 472.53, fromCancelledBill: { months: ["2027-01"], amount: 472.53 } }) }));
    expect(one).toMatch(/January 2027 bill that was cancelled\./);
    expect(one).not.toMatch(/bills that were/);
  });

  it("the on-account card holds its ended-tenancy wording over released money — nothing more bills for her", () => {
    // The $70.00 left of her January cheque after the part month took its
    // share is on account by the view's word; the card reads the same
    // figure and the same two facts as for any other money.
    const w = words(view({ onAccount: 70, tenancyEnded: "2027-01-20", finalMonthBilled: true }));
    const card = w.slice(w.indexOf("On account"), w.indexOf("Your agreement"));
    expect(card).toMatch(/\$70\.00/);
    expect(card).toMatch(/with the office — nothing more bills for you/);
    expect(card).not.toMatch(/comes off your bills/);
  });

  it("the sentence is one helper in three places, each threading fromCancelledBill", () => {
    const src = readFileSync(fileURLToPath(new URL("./RenterHome.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/function cancelledBillWords\(/);
    expect((src.match(/cancelledBillWords\(c\)/g) ?? []).length, "Paid in full, received so far").toBe(2);
    expect(src).toMatch(/a\.fromCancelledBill\s*\?\s*fromOnAccountWords\(a\)/);
    // monthList from the one joiner, never a second copy of "and".
    expect(src).toMatch(/import \{ money, monthList \} from "@\/app\/park\/ledger-helpers"/);
    expect(src).toMatch(/monthList\(c\.months\)/);
    expect(src).not.toMatch(/prettyMonth\(c\.month\)/);
  });
});
