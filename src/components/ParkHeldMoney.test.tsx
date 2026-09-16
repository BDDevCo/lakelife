import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OnAccountRow } from "@/app/park/money-actions";
import type { ReceiptLines } from "@/app/park/receipt-helpers";

/**
 * MONEY NOT AGAINST A BILL, AFTER 0167.
 *
 * The panel printed each on-account payment's AMOUNT — what arrived. Since
 * 0167 the payment row never moves: a quarter paid ahead keeps `charge_id
 * null` while the run puts $542.53 of it against January, then February. So
 * "$1,627.59 · Household 9" over money two-thirds spent was a number the
 * office would act on — offer it against March, or hand it back. The bold
 * figure is now what is STILL on account, and the months it already paid
 * sit under it, from the allocations the page reads.
 *
 * ROUND 2 (R3 and the two [must]s): a cheque every cent of which has gone
 * to bills stays LISTED, under "Applied in full", with Take it back and
 * nothing else — it is the only screen with a reversal for a cheque with no
 * bill, and a quarter-ahead cheque bounces AFTER the run has spent it. Each
 * allocation line carries a ghost "Take it off this bill" (unapplyAllocation,
 * reason required, the same shape as Take it back). And the on-account
 * receipt recordOnAccount now returns is shown through the ONE ReceiptPanel
 * the rent screen already has.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { ok: () => {}, err: () => {} }) }));
vi.mock("@/app/park/money-actions", () => ({
  recordOnAccount: async () => ({ ok: true }),
  recordDeposit: async () => ({ ok: true }),
  returnDeposit: async () => ({ ok: true }),
  applyOnAccount: async () => ({ ok: true }),
  unapplyAllocation: async () => ({ ok: true }),
  handBackOnAccount: async () => ({ ok: true }),
}));
vi.mock("@/app/park/ledger-actions", () => ({
  reversePayment: async () => ({ ok: true }),
  emailReceipt: async () => ({ ok: true }),
  takeDropSlipSerials: async () => ({ ok: true }),
}));

const { ParkHeldMoney } = await import("./ParkHeldMoney");
const { ReceiptPanel } = await import("./ParkReceipt");
type Props = Parameters<typeof ParkHeldMoney>[0];

const quarter: OnAccountRow = {
  paymentId: "pay-acct", renterId: "renter-9", renterName: "Household 9",
  amount: 1627.59, remaining: 542.53, allocated: 1085.06, refunded: 0, refunds: [], handedBack: 0, handedBackOn: null, handedBackNote: null,
  method: "check", receivedOn: "2026-12-28", reference: "1042", receiptNo: 12, split: null, releasedFrom: null,
  tenancyEnded: false, movedOutOn: null, finalMonthBilled: false,
};

const props = (over: Partial<Props> = {}): Props => ({
  parkId: "park-haven", today: "2027-02-02", households: [{ id: "renter-9", name: "Household 9" }],
  onAccount: [quarter], deposits: [], onAccountTotal: 542.53, depositsHeldTotal: 0,
  openCharges: [{ id: "charge-mar", renterId: "renter-9", label: "March 2027 — $542.53 owing" }],
  allocations: {
    "pay-acct": [
      { id: "al-1", periodMonth: "2027-01", amount: 542.53, appliedOn: "2027-01-01T06:00:00Z", via: "run", removedOn: null, removedWhy: null },
      { id: "al-2", periodMonth: "2027-02", amount: 542.53, appliedOn: "2027-02-01T06:00:00Z", via: "run", removedOn: null, removedWhy: null },
    ],
  },
  ...over,
});

/** Rendered markup as a person reads it: tags gone, the apostrophe React escapes decoded. */
const words = (p: Props) =>
  renderToStaticMarkup(<ParkHeldMoney {...p} />).replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("an on-account row shows what is still held, not what arrived", () => {
  it("the bold figure is the remaining $542.53, and the $1,627.59 is named as what was received", () => {
    const html = renderToStaticMarkup(<ParkHeldMoney {...props()} />);
    expect(html).toMatch(/<b>\$542\.53<\/b>/);
    expect(html).not.toMatch(/<b>\$1,?627\.59<\/b>/);
    const w = words(props());
    expect(w).toMatch(/\$542\.53 still on account/);
    expect(w).toMatch(/Of \$1,627\.59 received, \$1,085\.06 is against bills/);
  });

  it("lists the months it already paid, in month order, with how each was applied", () => {
    const w = words(props());
    const jan = w.indexOf("$542.53 to January 2027");
    const feb = w.indexOf("$542.53 to February 2027");
    expect(jan).toBeGreaterThan(0);
    expect(feb).toBeGreaterThan(jan);
    expect(w).toMatch(/when January 2027 was billed/);
  });

  it("an allocation the office made by hand says so", () => {
    const w = words(props({
      allocations: { "pay-acct": [{ id: "al-1", periodMonth: "2027-01", amount: 542.53, appliedOn: "2027-01-03T15:00:00Z", via: "office", removedOn: null, removedWhy: null }] },
    }));
    expect(w).toMatch(/\$542\.53 to January 2027 · by the office, January 3, 2027/);
  });

  it("money nothing has touched yet has no list under it and no 'against bills' sentence", () => {
    const fresh: OnAccountRow = { ...quarter, remaining: 1627.59, allocated: 0 };
    const w = words(props({ onAccount: [fresh], allocations: {}, onAccountTotal: 1627.59 }));
    expect(w).toMatch(/\$1,627\.59 still on account/);
    expect(w).not.toMatch(/received/);
    expect(w).not.toMatch(/to January 2027/);
  });

  it("dates are words, never 2026-12-28", () => {
    const w = words(props());
    expect(w).toMatch(/December 28, 2026/);
    expect(w).not.toMatch(/2026-12-28/);
  });

  it("the header total is what is still held", () => {
    expect(words(props())).toMatch(/\$542\.53 on account/);
  });

  it("says money on account comes off the next bill — which the run now does — and never 'until you put it against a bill'", () => {
    const w = words(props());
    expect(w).toMatch(/comes off the next bill you raise/);
    expect(w).not.toMatch(/until you put it against a bill/);
  });

  it("still offers Apply against the household's open bills", () => {
    const html = renderToStaticMarkup(<ParkHeldMoney {...props()} />);
    expect(html).toMatch(/March 2027 — \$542\.53 owing/);
    expect(html).toMatch(/>Apply</);
  });
});

/**
 * THE BOUNCED QUARTER. 17 of 18 Haven households pay cash or cheque, and a
 * cheque bounces days after it is keyed — by which time the run may have put
 * all of it against January, February and March. This panel is the only
 * screen with "Take it back" for a payment with no bill; dropped from the
 * list the morning March was applied, the cheque could never be reversed in
 * exactly the case the reversal was built for.
 */
describe("a cheque every cent of which is against bills stays listed, under Applied in full", () => {
  const spent: OnAccountRow = { ...quarter, remaining: 0, allocated: 1627.59 };
  const three = {
    "pay-acct": [
      { id: "al-1", periodMonth: "2027-01", amount: 542.53, appliedOn: "2027-01-01T06:00:00Z", via: "run" as const, removedOn: null, removedWhy: null },
      { id: "al-2", periodMonth: "2027-02", amount: 542.53, appliedOn: "2027-02-01T06:00:00Z", via: "run" as const, removedOn: null, removedWhy: null },
      { id: "al-3", periodMonth: "2027-03", amount: 542.53, appliedOn: "2027-03-01T06:00:00Z", via: "run" as const, removedOn: null, removedWhy: null },
    ],
  };
  const p = () => props({ onAccount: [spent], allocations: three, onAccountTotal: 0 });

  it("is listed under its own heading, with the household, the cheque and every month it paid", () => {
    const w = words(p());
    expect(w).toMatch(/Applied in full/);
    expect(w).not.toMatch(/still on account/);
    const section = w.slice(w.indexOf("Applied in full"));
    expect(section).toMatch(/Household 9/);
    expect(section).toMatch(/\$1,627\.59/);
    expect(section).toMatch(/check #1042/);
    expect(section).toMatch(/receipt 12/);
    expect(section).toMatch(/\$542\.53 to March 2027/);
    // And the header total is what is still held: nothing.
    expect(w).toMatch(/\$0\.00 on account/);
  });

  it("offers Take it back and nothing else — no Apply, no 'no open bill' sentence", () => {
    const html = renderToStaticMarkup(<ParkHeldMoney {...p()} />);
    const section = html.slice(html.indexOf("Applied in full"));
    expect(section).toMatch(/Take it back/);
    expect(section).not.toMatch(/>Apply</);
    expect(section).not.toMatch(/Put against/);
    expect(section).not.toMatch(/No open bill for them yet/);
  });

  it("says 'All of it is against bills' only when it is — a part-refunded card payment with the rest applied is not", () => {
    const w = words(p());
    expect(w).toMatch(/All \$1,627\.59 of it is against bills/);
    const refunded: OnAccountRow = { ...spent, allocated: 1085.06 };
    const w2 = words(props({ onAccount: [refunded], allocations: three, onAccountTotal: 0 }));
    expect(w2).not.toMatch(/All \$1,627\.59 of it/);
    expect(w2).toMatch(/Of \$1,627\.59 received, \$1,085\.06 is against bills/);
  });

  it("is not under the 'On account' heading, and the two headings are separate lists", () => {
    const w = words(props({ onAccount: [quarter, { ...spent, paymentId: "pay-spent", renterName: "Household 14" }],
      allocations: { ...props().allocations, "pay-spent": three["pay-acct"] }, onAccountTotal: 542.53 }));
    const on = w.indexOf("On account");
    const applied = w.indexOf("Applied in full");
    expect(on).toBeGreaterThan(0);
    expect(applied).toBeGreaterThan(on);
    expect(w.slice(on, applied)).toMatch(/Household 9/);
    expect(w.slice(on, applied)).not.toMatch(/Household 14/);
    expect(w.slice(applied)).toMatch(/Household 14/);
  });
});

/**
 * TAKING IT BACK OFF A BILL (R3). The run and the office can both be wrong
 * about which month the household meant; until this door the only exit was
 * reversing the whole cheque. A ghost control on each line, a reason
 * required — the same shape as Take it back.
 */
describe("each allocation line carries a ghost 'Take it off this bill'", () => {
  it("one per live line, on a row still on account and on one applied in full", () => {
    const html = renderToStaticMarkup(<ParkHeldMoney {...props()} />);
    expect(html.match(/Take it off this bill/g) ?? []).toHaveLength(2);
    const spent: OnAccountRow = { ...quarter, remaining: 0, allocated: 1085.06 };
    const html2 = renderToStaticMarkup(<ParkHeldMoney {...props({ onAccount: [spent], onAccountTotal: 0 })} />);
    expect(html2.match(/Take it off this bill/g) ?? []).toHaveLength(2);
  });

  it("is a ghost button, not the gold one", () => {
    const html = renderToStaticMarkup(<ParkHeldMoney {...props()} />);
    const at = html.indexOf("Take it off this bill");
    const tag = html.slice(html.lastIndexOf("<button", at), at);
    expect(tag).toMatch(/ll-btn ghost sm/);
  });

  it("a line taken off its bill is shown as the record — the month, the day, the reason — and not as money against the bill", () => {
    const w = words(props({
      onAccount: [{ ...quarter, remaining: 1085.06, allocated: 542.53 }],
      allocations: { "pay-acct": [
        { id: "al-1", periodMonth: "2027-01", amount: 542.53, appliedOn: "2027-01-01T06:00:00Z", via: "run", removedOn: null, removedWhy: null },
        { id: "al-2", periodMonth: "2027-02", amount: 542.53, appliedOn: "2027-02-01T06:00:00Z", via: "run", removedOn: "2027-02-03T15:00:00Z", removedWhy: "they meant it for March" },
      ] },
      onAccountTotal: 1085.06,
    }));
    expect(w).toMatch(/Of \$1,627\.59 received, \$542\.53 is against bills/);
    expect(w).toMatch(/\$542\.53 to January 2027/);
    expect(w).not.toMatch(/\$542\.53 to February 2027 ·/);
    expect(w).toMatch(/\$542\.53 taken off February 2027 on February 3, 2027 — “they meant it for March”/);
    const html = renderToStaticMarkup(<ParkHeldMoney {...props({
      onAccount: [{ ...quarter, remaining: 1085.06, allocated: 542.53 }],
      allocations: { "pay-acct": [
        { id: "al-2", periodMonth: "2027-02", amount: 542.53, appliedOn: "2027-02-01T06:00:00Z", via: "run", removedOn: "2027-02-03T15:00:00Z", removedWhy: "they meant it for March" },
      ] },
    })} />);
    // A removed line has no control — it is already off the bill.
    expect(html).not.toMatch(/Take it off this bill/);
  });
});

/**
 * PAPER FOR THE QUARTER-AHEAD CHEQUE. recordOnAccount returns a receipt
 * (kind "on_account"); the household walked away with none because no screen
 * showed it. The rent screen's ReceiptPanel prints it — one panel, not a
 * second copy of it here.
 */
describe("the on-account receipt is shown through the rent screen's ReceiptPanel", () => {
  const receipt: ReceiptLines = {
    kind: "on_account", parkName: "The Haven", officeLine: "Questions? Ask at the office.", receiptNo: 12,
    feeAmount: null, lotNumber: "9", payerName: "Household 9", amount: 1627.59, method: "check", reference: "1042",
    receivedOn: "2026-12-28", periodMonth: "", billAmount: 0, balanceAfter: 0,
    onAccount: { amount: 1627.59, receiptNo: 12, appliedTo: [{ periodMonth: "2027-01", amount: 542.53 }], remaining: 1085.06 },
    confirmUrl: "https://lakelife.test/paid/abc",
  };

  it("the ONE panel prints the on-account receipt: against money on account, where it went, what is held", () => {
    const html = renderToStaticMarkup(<ReceiptPanel parkId="park-haven" receipt={receipt} renterEmail={null} onClose={() => {}} />);
    const w = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(w).toMatch(/Their receipt/);
    expect(w).toMatch(/Against money on account/);
    expect(w).toMatch(/Where it went \$542\.53 to January 2027, \$1,085\.06 on account/);
    expect(w).toMatch(/The \$1,085\.06 on account is held by the office and comes off your next bill/);
    expect(w).not.toMatch(/Against .* rent —/);
    expect(w).toMatch(/Print both halves/);
  });
});

describe("the page that mounts it is the one writer of the allocations it shows", () => {
  const page = readFileSync(fileURLToPath(new URL("../app/park/rent/page.tsx", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const held = readFileSync(fileURLToPath(new URL("./ParkHeldMoney.tsx", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads park_payment_allocations for the listed payments, scoped to the park, and refuses a failed read", () => {
    expect(page).toMatch(/\.from\("park_payment_allocations"\)/);
    expect(page).toMatch(/park_charges!inner\(period_month\)/);
    expect(page).toMatch(/\.in\("payment_id", paymentIds\)/);
    expect(page).toMatch(/\.eq\("park_id", parkId\)/);
    expect(page).toMatch(/mustRead\("where the money on account has gone"/);
  });

  it("reads each line's id and its removal, so the panel can take one off and show one taken off", () => {
    expect(page).toMatch(/\.select\("id, payment_id, amount, applied_at, applied_via, removed_at, removed_reason, park_charges!inner\(period_month\)"\)/);
    expect(page).toMatch(/removedOn: /);
    expect(page).toMatch(/removedWhy: /);
    // The record is READ, never filtered out here: a removed line is shown as
    // taken off, and the view's `allocated` (live rows only) is the figure.
    expect(page).not.toMatch(/\.is\("removed_at", null\)/);
  });

  it("passes them to the panel, which renders them", () => {
    expect(page).toMatch(/allocations=\{allocations\}/);
    expect(held).toMatch(/allocations\[r\.paymentId\]/);
  });

  it("the panel's bold figure is `remaining`, and `amount` is only ever 'received'", () => {
    const line = held.slice(held.indexOf("function OnAccountLine"), held.indexOf("function DepositLine"));
    expect(line).toMatch(/<b>\{money\(row\.remaining\)\}<\/b>/);
    expect(line).not.toMatch(/<b>\{money\(row\.amount\)\}<\/b>/);
  });

  // THE RIGHT THING EXISTED AND THE DOOR DID NOT USE IT: a private `usd` with
  // the body of ledger-helpers' money() — the one shape for a figure about
  // money on account — while the file already imported prettyMonth from
  // there. One formatter, so the panel and the run's toast cannot drift.
  it("prints money through the one money() in ledger-helpers, not a private copy", () => {
    expect(held).toMatch(/import \{[^}]*\bmoney\b[^}]*\} from "@\/app\/park\/ledger-helpers"/);
    expect(held).not.toMatch(/const usd = /);
    expect(held).not.toMatch(/toLocaleString\(/);
    expect((held.match(/money\(/g) ?? []).length).toBeGreaterThan(8);
  });

  // THE TICK IS EARNED. A bare toast() draws nothing either way, so a refused
  // un-apply and a done one looked the same in the one place the office
  // looks. toast.ok for what went right, toast.err for what did not — on
  // every door in this panel, never a bare toast().
  it("every outcome toast is toast.ok or toast.err — never a bare toast() that cannot tell the two apart", () => {
    expect(held).toMatch(/import \{ toast \} from "@\/components\/Toast"/);
    const bare = held.match(/(?<![.\w])toast\(/g) ?? [];
    expect(bare, "bare toast() calls").toHaveLength(0);
    const ok = held.match(/toast\.ok\(/g) ?? [];
    const err = held.match(/toast\.err\(/g) ?? [];
    // Record (on account / deposit share one button), Apply, Record a
    // deposit's return, and WithReason: four doors, each with both.
    expect(ok.length).toBe(4);
    expect(err.length).toBe(4);
    // WithReason's own: the shared shape for Take it back and Take it off.
    const shape = held.slice(held.indexOf("function WithReason"));
    expect(shape).toMatch(/toast\.ok\(res\.signal/);
    expect(shape).toMatch(/toast\.err\(res\.error/);
  });

  it("'Take it off this bill' calls unapplyAllocation with the line's id and a reason the office must type", () => {
    expect(held).toMatch(/import \{[^}]*unapplyAllocation[^}]*\} from "@\/app\/park\/money-actions"/);
    expect(held).toMatch(/unapplyAllocation\(parkId, a\.id, why\)/);
    // ONE reason shape for both corrections: Take it back and Take it off
    // this bill both go through WithReason, whose confirm is dead until a
    // reason is typed.
    const shape = held.slice(held.indexOf("function WithReason"));
    expect(shape.length).toBeGreaterThan(200);
    expect(shape).toMatch(/disabled=\{busy \|\| !why\.trim\(\)\}/);
    expect(held).toMatch(/reversePayment\(parkId, paymentId, why\)/);
    expect((held.match(/<WithReason/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the on-account receipt through ParkReceipt's panel — no second receipt panel here", () => {
    expect(held).toMatch(/import \{ ReceiptPanel \} from "@\/components\/ParkReceipt"/);
    expect(held).toMatch(/<ReceiptPanel/);
    expect(held).toMatch(/res\.receipt/);
    expect(held).toMatch(/res\.renterEmail/);
    expect(held).not.toMatch(/receiptBody\(/);
    expect(held).not.toMatch(/<pre/);
  });

  it("lists a spent row under Applied in full with WithReason (Take it back) and never the Apply picker", () => {
    const applied = held.slice(held.indexOf("Applied in full"), held.indexOf("function OnAccountLine"));
    expect(applied.length).toBeGreaterThan(50);
    expect(held).toMatch(/const spent = /);
    expect(held).toMatch(/const stillHeld = /);
  });
});

/**
 * CASH HANDED BACK ACROSS THE WINDOW (0168). A household leaves with money
 * on account and nothing more bills for them; the only control used to be
 * Take it back — a reversal, which reopens January on every screen. Now the
 * row has a hand-back beside it, with the deposit's own form, and says
 * "theirs to have back" only when BOTH facts are read.
 */
describe("Hand it back, beside Take it back", () => {
  const gone: OnAccountRow = { ...quarter, amount: 57.47, remaining: 57.47, allocated: 0, receiptNo: 102, tenancyEnded: true, movedOutOn: "2027-01-27", finalMonthBilled: true };
  const noBills = (over: Partial<Props> = {}) => props({ onAccount: [gone], allocations: {}, onAccountTotal: 57.47, openCharges: [], ...over });

  it("offers Hand it back on money still on account, and never on a cheque spent in full", () => {
    const html = renderToStaticMarkup(<ParkHeldMoney {...props()} />);
    expect(html).toMatch(/>Hand it back</);
    expect(html).toMatch(/Take it back/);
    const spent: OnAccountRow = { ...quarter, remaining: 0, allocated: 1627.59 };
    const html2 = renderToStaticMarkup(<ParkHeldMoney {...props({ onAccount: [spent], onAccountTotal: 0 })} />);
    expect(html2).not.toMatch(/Hand it back/);
    expect(html2).toMatch(/Take it back/);
    // Card and ACH money goes back through the processor, never by hand
    // (0142): the server refuses it, so the button is not offered.
    for (const method of ["card", "ach"]) {
      const byCard: OnAccountRow = { ...quarter, method };
      expect(renderToStaticMarkup(<ParkHeldMoney {...props({ onAccount: [byCard] })} />)).not.toMatch(/Hand it back/);
    }
  });

  it("says they moved out and nothing more bills — ONLY when the tenancy has ended AND the final month is billed", () => {
    const w = words(noBills());
    expect(w).toMatch(/They moved out January 27, 2027 — nothing more bills for them; this is theirs to have back\./);
    expect(w).not.toMatch(/No open bill for them yet/);
    // Collapsed both ways: either fact alone keeps the old sentence, which is
    // the truth — a move-out recorded before the run gets a prorated final
    // bill, and the run takes this money for it.
    for (const half of [{ tenancyEnded: false }, { finalMonthBilled: false }, { movedOutOn: null }]) {
      const w2 = words(noBills({ onAccount: [{ ...gone, ...half }] }));
      expect(w2, JSON.stringify(half)).toMatch(/No open bill for them yet/);
      expect(w2).not.toMatch(/theirs to have back/);
    }
    // And with an open bill of theirs, the picker wins — money against a bill first.
    const w3 = words(props({ onAccount: [gone], allocations: {}, onAccountTotal: 57.47 }));
    expect(w3).not.toMatch(/theirs to have back/);
    expect(renderToStaticMarkup(<ParkHeldMoney {...props({ onAccount: [gone], allocations: {}, onAccountTotal: 57.47 })} />)).toMatch(/>Apply</);
  });

  it("the confirm on Take it back names both halves only when the bill's half STANDS, and never says 'cheque' about cash", () => {
    // The confirm lives behind WithReason's open state, so the expression
    // is read: it branches on `row.split` (read from the sibling row by
    // getHeldMoney), mirrors reversalSentence's "both halves of it", and
    // carries no method word — "the whole cheque" about $542.53 in cash
    // was the lie.
    const src = readFileSync(fileURLToPath(new URL("./ParkHeldMoney.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const line = src.slice(src.indexOf("function OnAccountLine"), src.indexOf("function DepositLine"));
    const what = line.slice(line.indexOf("what={row.releasedFrom"), line.indexOf("busy={busy}", line.indexOf("what={row.releasedFrom")));
    expect(what.length).toBeGreaterThan(80);
    expect(what).toMatch(/row\.split\.billCancelled\s*\?[\s\S]*?:\s*`both halves of it — the \$\{money\(row\.split\.against\)\} against \$\{row\.split\.billMonth \? prettyMonth\(row\.split\.billMonth\) : "the bill"\} and the \$\{money\(row\.amount\)\} on account go back together`\s*:\s*"it"/);
    expect(what).not.toMatch(/cheque/);
    expect(line).not.toMatch(/partOfSplit/);
  });

  it("shows what went back on the row — each refund with its day, and the hand-back with its day", () => {
    const back: OnAccountRow = { ...quarter, remaining: 0, allocated: 1085.06, refunded: 40, refunds: [{ amount: 40, on: "2027-01-09" }], handedBack: 502.53, handedBackOn: "2027-01-28", handedBackNote: "moved out; nothing more bills" };
    const w = words(props({ onAccount: [back], onAccountTotal: 0 }));
    expect(w).toMatch(/\$40\.00 went back to the card on January 9, 2027/);
    expect(w).toMatch(/\$502\.53 handed back to them on January 28, 2027 — “moved out; nothing more bills”/);
    expect(w).not.toMatch(/2027-01-28|2027-01-09/);
    // Nothing went back: no such lines.
    expect(words(props())).not.toMatch(/went back to the card|handed back to them/);
  });

  it("a row with nothing left because part of it went back is NOT 'Applied in full' — it has its own true heading", () => {
    const back: OnAccountRow = { ...quarter, remaining: 0, allocated: 1085.06, handedBack: 542.53, handedBackOn: "2027-02-16", handedBackNote: "moved out 15 Feb" };
    const w = words(props({ onAccount: [back], onAccountTotal: 0 }));
    expect(w).not.toMatch(/Applied in full|Every cent of these is against bills/);
    expect(w).toMatch(/Nothing left on account Part or all of these went back/);
    // "the rest is against bills" was untrue of the walked row — $57.47 on
    // account handed back in full has nothing against bills; the $542.53
    // is a different row.
    expect(w).not.toMatch(/the rest is against bills/);
    expect(w).toMatch(/\$542\.53 handed back to them on February 16, 2027/);
    // A part-refunded card payment with nothing left is the same shape.
    const refunded: OnAccountRow = { ...quarter, method: "card", reference: null, remaining: 0, allocated: 1587.59, refunded: 40, refunds: [{ amount: 40, on: "2027-01-09" }] };
    const w2 = words(props({ onAccount: [refunded], onAccountTotal: 0 }));
    expect(w2).not.toMatch(/Applied in full/);
    expect(w2).toMatch(/Nothing left on account/);
    // Collapsed the other way: every cent against bills is still "Applied in full".
    const spentRow: OnAccountRow = { ...quarter, remaining: 0, allocated: 1627.59 };
    const w3 = words(props({ onAccount: [spentRow], onAccountTotal: 0 }));
    expect(w3).toMatch(/Applied in full/);
    expect(w3).not.toMatch(/Nothing left on account/);
  });

  it("a row already handed back offers neither Take it back nor Hand it back — both can only be refused", () => {
    // Part went back, part is still on account: the database refuses a
    // second stamp and a reversal by name, so the controls go and the line
    // says what happened. The reason rides with it.
    const part: OnAccountRow = { ...quarter, remaining: 17.47, allocated: 1085.06, handedBack: 525.06, handedBackOn: "2027-01-28", handedBackNote: "overpaid" };
    const html = renderToStaticMarkup(<ParkHeldMoney {...props({ onAccount: [part], onAccountTotal: 17.47 })} />);
    expect(html).not.toMatch(/Take it back|Hand it back/);
    expect(html).toMatch(/\$525\.06 handed back to them on January 28, 2027/);
    // Collapsed the other way: the same row with nothing handed back has both.
    const both = renderToStaticMarkup(<ParkHeldMoney {...props()} />);
    expect(both).toMatch(/Take it back/);
    expect(both).toMatch(/Hand it back/);
  });

  it("…and when that household has gone with the final month billed, the row says the money is stuck — never 'theirs to have back'", () => {
    // $40 of $57.47 handed back while they were here; they leave, January
    // is billed, $17.47 is still on account. No door moves it: a hand-back
    // is recorded once, the reversal is refused, and there is no bill to
    // apply it to. The row used to read "this is theirs to have back" over
    // money nothing on the screen could move.
    const stuck: OnAccountRow = { ...quarter, amount: 57.47, remaining: 17.47, allocated: 0, handedBack: 40, handedBackOn: "2027-01-10", handedBackNote: "overpaid; $40 back", tenancyEnded: true, movedOutOn: "2027-01-27", finalMonthBilled: true };
    const w = words(props({ onAccount: [stuck], allocations: {}, onAccountTotal: 17.47, openCharges: [] }));
    expect(w).toMatch(/They moved out January 27, 2027 — nothing more bills for them\. \$17\.47 of it is still on account; a hand-back is recorded once, so it can’t go back from here\./);
    expect(w).not.toMatch(/theirs to have back|No open bill for them yet/);
    expect(w).not.toMatch(/Take it back|Hand it back/);
    // Collapsed both ways: nothing handed back keeps "theirs to have back"
    // (and the Hand it back door); still here keeps "No open bill".
    const fresh = words(props({ onAccount: [{ ...stuck, handedBack: 0, handedBackOn: null, handedBackNote: null, remaining: 57.47 }], allocations: {}, onAccountTotal: 57.47, openCharges: [] }));
    expect(fresh).toMatch(/theirs to have back/);
    expect(fresh).toMatch(/Hand it back/);
    const here = words(props({ onAccount: [{ ...stuck, tenancyEnded: false, movedOutOn: null, finalMonthBilled: false }], allocations: {}, onAccountTotal: 17.47, openCharges: [] }));
    expect(here).toMatch(/No open bill for them yet/);
    expect(here).not.toMatch(/recorded once/);
  });

  it("the hand-back and the deposit's return share ONE form, and the hand-back's button is dead until a reason is typed", () => {
    const src = readFileSync(fileURLToPath(new URL("./ParkHeldMoney.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect((src.match(/<GiveBackForm/g) ?? []).length).toBe(2);
    expect(src).toMatch(/act=\{\(amt, when, why\) => handBackOnAccount\(parkId, row\.paymentId, amt, when, why\)\}/);
    expect(src).toMatch(/act=\{\(amt, when, why\) => returnDeposit\(parkId, row\.paymentId, amt, when, why\)\}/);
    const form = src.slice(src.indexOf("function GiveBackForm"));
    expect(form).toMatch(/disabled=\{busy \|\| !\(amt > 0\) \|\| amt > max \|\| \(needsWhy === true && !why\.trim\(\)\)\}/);
    // The rent door demands the reason at the form; the deposit door leaves it to the server's kept-with-reason rule.
    const acct = src.slice(src.indexOf("function OnAccountLine"), src.indexOf("function DepositLine"));
    expect(acct).toMatch(/needsWhy\s/);
    const dep = src.slice(src.indexOf("function DepositLine"), src.indexOf("function GiveBackForm"));
    expect(dep).not.toMatch(/needsWhy/);
    expect(src).not.toMatch(/partOfSplit/);
  });

  it("a departed household's deposit says so on its line", () => {
    const dep = {
      ...quarter, paymentId: "dep-1", amount: 500, remaining: 500, allocated: 0, method: "cash", reference: null, receiptNo: 3,
      returnedOn: null, returnedAmount: null, note: null, returnNote: null, tenancyEnded: true, movedOutOn: "2027-01-27", finalMonthBilled: true,
    };
    const w = words(props({ onAccount: [], allocations: {}, onAccountTotal: 0, deposits: [dep], depositsHeldTotal: 500 }));
    expect(w).toMatch(/\$500\.00 · Household 9 · taken December 28, 2026 · receipt 3 · they moved out January 27, 2027/);
    expect(w).toMatch(/Give it back/);
  });
});

/**
 * MONEY RELEASED FROM A CANCELLED BILL (0169). A cheque keyed straight
 * against January; the household leaves on the 20th; the office cancels the
 * whole-month bill and raises the part month. The row never moves, the view
 * lists it, and this panel has to say where it came from — on the row, and
 * in Take it back's confirm on BOTH halves of a split.
 */
describe("a row released from a cancelled bill says where it came from", () => {
  const released: OnAccountRow = {
    ...quarter, paymentId: "pay-direct", amount: 542.53, remaining: 70, allocated: 472.53, receiptNo: 14, receivedOn: "2027-01-04",
    releasedFrom: { chargeId: "chg-jan", month: "2027-01", on: "2027-01-20T15:00:00Z", sibling: null },
    tenancyEnded: true, movedOutOn: "2027-01-20", finalMonthBilled: true,
  };
  const lines = { "pay-direct": [{ id: "al-p", periodMonth: "2027-01", amount: 472.53, appliedOn: "2027-01-20T15:05:00Z", via: "office" as const, removedOn: null, removedWhy: null }] };
  const p = (over: Partial<Props> = {}) => props({ onAccount: [released], allocations: lines, onAccountTotal: 70, openCharges: [], ...over });

  it("the lead line: what is held, the household, and released from which bill, cancelled on what day — in words", () => {
    const w = words(p());
    expect(w).toMatch(/\$70\.00 still on account · Household 9 · released from January 2027's cancelled bill \(cancelled January 20, 2027\) · January 4, 2027 · check #1042 · receipt 14/);
    expect(w).not.toMatch(/2027-01/);
    // And the rest of the row is the ordinary row: the part month it
    // settled, the move-out sentence, Hand it back, Take it off this bill.
    expect(w).toMatch(/Of \$542\.53 received, \$472\.53 is against bills/);
    expect(w).toMatch(/\$472\.53 to January 2027 · by the office, January 20, 2027/);
    expect(w).toMatch(/They moved out January 20, 2027 — nothing more bills for them; this is theirs to have back\./);
    const html = renderToStaticMarkup(<ParkHeldMoney {...p()} />);
    expect(html).toMatch(/>Hand it back</);
    expect(html).toMatch(/Take it back/);
    expect(html).toMatch(/Take it off this bill/);
    // Collapsed: a row with no releasedFrom says nothing of the kind.
    expect(words(props())).not.toMatch(/released from|cancelled/);
  });

  it("a released row spent in full names the bill without the day", () => {
    const spentRow: OnAccountRow = { ...released, remaining: 0, allocated: 542.53 };
    const w = words(p({ onAccount: [spentRow], onAccountTotal: 0 }));
    expect(w).toMatch(/Applied in full/);
    expect(w).toMatch(/Household 9 · \$542\.53 · January 4, 2027 · check #1042 · receipt 14 · released from January 2027's cancelled bill/);
    expect(w).not.toMatch(/cancelled January 20/);
  });

  it("Take it back's confirm on a released row names the cancelled bill, and its on-account sibling when one stands", () => {
    // The confirm lives behind WithReason's open state, so the expression
    // is read: released first, then the split's two shapes, then "it".
    const src = readFileSync(fileURLToPath(new URL("./ParkHeldMoney.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const line = src.slice(src.indexOf("function OnAccountLine"), src.indexOf("function DepositLine"));
    const what = line.slice(line.indexOf("what={row.releasedFrom"), line.indexOf("busy={busy}", line.indexOf("what={row.releasedFrom")));
    expect(what.length).toBeGreaterThan(80);
    expect(what).toMatch(/row\.releasedFrom\s*\?\s*`it — the \$\{money\(row\.amount\)\} paid on \$\{prettyMonth\(row\.releasedFrom\.month\)\}'s bill, which was cancelled`/);
    expect(what).toMatch(/row\.releasedFrom\.sibling \? `; the \$\{money\(row\.releasedFrom\.sibling\.onAccount\)\} of the same payment on account goes back with it` : ""/);
    // THE SIBLING'S OWN CONFIRM: "which was cancelled", never "against
    // January 2027" as if the bill stood — read from split.billCancelled.
    expect(what).toMatch(/row\.split\.billCancelled\s*\?\s*`both halves of it — the \$\{money\(row\.split\.against\)\} paid on \$\{row\.split\.billMonth \? `\$\{prettyMonth\(row\.split\.billMonth\)\}'s bill` : "the bill"\}, which was cancelled, and the \$\{money\(row\.amount\)\} on account go back together`/);
    // Rendered both ways, so the words are proven and not just the source:
    // the strings the three shapes produce, evaluated the way the panel does.
    const say = (row: OnAccountRow) => row.releasedFrom
      ? `it — the $${row.amount.toFixed(2)} paid on January 2027's bill, which was cancelled` + (row.releasedFrom.sibling ? `; the $${row.releasedFrom.sibling.onAccount.toFixed(2)} of the same payment on account goes back with it` : "")
      : "";
    expect(say(released)).toBe("it — the $542.53 paid on January 2027's bill, which was cancelled");
    expect(say({ ...released, releasedFrom: { ...released.releasedFrom!, sibling: { onAccount: 57.47 } } }))
      .toBe("it — the $542.53 paid on January 2027's bill, which was cancelled; the $57.47 of the same payment on account goes back with it");
  });

  it("the header total counts released money like any other", () => {
    expect(words(p())).toMatch(/\$70\.00 on account/);
  });
});

/**
 * A CARD-PAID JANUARY RELEASED ONTO THIS PANEL is the ordinary move-out
 * shape once 0169 exists — and before it no card row could sit here at all
 * (recordOnAccount refuses hand-keyed card). Take it back was gated only on
 * "not handed back", so the one control on the row was a reversal that
 * reversePayment refuses by name (0142), beside "theirs to have back" and
 * no door that could move it. Hand it back two lines up already hid itself
 * by rail. Now one predicate (`canReverse`) gates both, and the sentence
 * that stands in the control's place names the rail as the server does and
 * says where the refund lives — not "Refund to card", which Statements
 * itself hides until the processor is connected.
 */
describe("a released row paid by card or ACH offers no Take it back", () => {
  const released: OnAccountRow = {
    ...quarter, paymentId: "pay-direct", amount: 542.53, remaining: 70, allocated: 472.53, receiptNo: 14, receivedOn: "2027-01-04",
    releasedFrom: { chargeId: "chg-jan", month: "2027-01", on: "2027-01-20T15:00:00Z", sibling: null },
    tenancyEnded: true, movedOutOn: "2027-01-20", finalMonthBilled: true,
  };
  const p = (row: OnAccountRow) => props({ onAccount: [row], allocations: {}, onAccountTotal: 70, openCharges: [] });

  it("card: no Take it back, no Hand it back — the sentence names the rail and points at Statements", () => {
    const html = renderToStaticMarkup(<ParkHeldMoney {...p({ ...released, method: "card" })} />);
    expect(html).not.toMatch(/Take it back/);
    expect(html).not.toMatch(/Hand it back/);
    const w = words(p({ ...released, method: "card" }));
    expect(w).toMatch(/Came in by card, so the money really did arrive — it goes back through the processor, from Statements\./);
    expect(w).not.toMatch(/Refund to card/);
  });

  it("ACH is named as bank transfer, never as card", () => {
    const w = words(p({ ...released, method: "ach" }));
    expect(w).toMatch(/Came in by bank transfer, so the money really did arrive — it goes back through the processor, from Statements\./);
    expect(w).not.toMatch(/by card/);
    expect(renderToStaticMarkup(<ParkHeldMoney {...p({ ...released, method: "ach" })} />)).not.toMatch(/Take it back|Hand it back/);
  });

  it("collapsed the other way: the same row by cheque still offers Take it back, and no processor sentence", () => {
    const html = renderToStaticMarkup(<ParkHeldMoney {...p(released)} />);
    expect(html).toMatch(/Take it back/);
    expect(html).toMatch(/>Hand it back</);
    expect(words(p(released))).not.toMatch(/through the processor/);
    // And a cheque spent in full keeps its Take it back — the bounced-after-
    // allocation case this screen exists for.
    const spent = renderToStaticMarkup(<ParkHeldMoney {...props({ onAccount: [{ ...quarter, remaining: 0, allocated: 1627.59 }], onAccountTotal: 0 })} />);
    expect(spent).toMatch(/Take it back/);
  });

  it("both doors read the ONE predicate — no inline rail test survives on this panel", () => {
    const src = readFileSync(fileURLToPath(new URL("./ParkHeldMoney.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/method\s*[!=]==\s*"(card|ach)"/);
    const line = src.slice(src.indexOf("function OnAccountLine"), src.indexOf("function DepositLine"));
    expect(line.match(/canReverse\(row\.method\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(line).toMatch(/<UndoMoney[\s\S]*?\/>/);
    expect(line.slice(0, line.indexOf("<UndoMoney"))).toMatch(/canReverse\(row\.method\) && \(\s*$/);
  });
});
