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
 * saying so — as what it is, not as a promise about the next bill.
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
  disputed: false, claimedPaidOn: null, lines: [], ...over,
});

const view = (over: Partial<RenterHomeView> = {}): RenterHomeView => ({
  parkName: "The Haven", parkAddress: "9085 E 500 S, Wolcottville, IN 46795",
  lotNumber: "9", hasSticker: false,
  displayName: "Household 9", since: "2015-04-01",
  textsOn: false, textNumber: null, term: "monthly", leavingOn: null,
  acceptsOnlineRent: false, hasCard: false, bookingReady: false, cardFeePct: 0,
  today: "2027-01-06",
  bill: null, arrears: [], tenancyEnded: null, deposit: null, onAccount: 0,
  payments: [], reported: [], reportedFailed: false,
  ...over,
});

const words = (v: RenterHomeView) =>
  renderToStaticMarkup(<RenterHome view={v} />).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("money on account with the office", () => {
  it("is shown, as what it is", () => {
    const w = words(view({ onAccount: 57.47 }));
    expect(w).toMatch(/On account/);
    expect(w).toMatch(/\$57\.47/);
    expect(w).toMatch(/with the office — paid, not yet against a bill/);
  });

  it("makes no promise the software does not keep", () => {
    // Nothing applies it to the next bill on its own; the office does, by hand.
    const w = words(view({ onAccount: 57.47 }));
    const card = w.slice(w.indexOf("On account"), w.indexOf("Your agreement"));
    expect(card.length).toBeGreaterThan(20);
    expect(card).not.toMatch(/come off|will be applied|next bill|toward/i);
  });

  it("says nothing at all when there is none", () => {
    expect(words(view({ onAccount: 0 }))).not.toMatch(/On account/);
    expect(words(view({ onAccount: undefined }))).not.toMatch(/On account/);
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
    expect(src).not.toMatch(/usd\(b\.outstanding > 0 \? b\.outstanding : b\.amount\)/);
    expect(src).toMatch(/b\.outstanding < 0 \? b\.paidTotal/);
  });

  it("'Paid in full' still stands for a bill settled to the cent", () => {
    const exact = view({ bill: bill({ paidTotal: 542.53, outstanding: 0, status: "paid" }) });
    expect(words(exact)).toMatch(/Paid in full — thank you/);
  });
});

describe("the loader hands the screen the on-account figure", () => {
  const src = readFileSync(fileURLToPath(new URL("../app/parks/my-data.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads exactly the rows the office's held-money screen reads", () => {
    // kind 'rent', no charge, not reversed, not pulled back by the bank —
    // 0102's partial index, and getHeldMoney's filter.
    const read = src.slice(src.indexOf('.select("amount")'));
    expect(read).toMatch(/\.eq\("kind", "rent"\)/);
    expect(read).toMatch(/\.is\("charge_id", null\)/);
    expect(read).toMatch(/\.is\("reversed_at", null\)/);
    expect(read).toMatch(/\.is\("returned_at", null\)/);
  });

  it("refuses rather than printing zero when that read fails", () => {
    expect(src).toMatch(/mustRead\("money you have on account", acctRes\)/);
  });

  it("writes the field the screen reads", () => {
    expect(src).toMatch(/^\s+onAccount,$/m);
  });
});
