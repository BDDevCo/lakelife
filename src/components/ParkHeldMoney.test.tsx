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
  amount: 1627.59, remaining: 542.53, allocated: 1085.06,
  method: "check", receivedOn: "2026-12-28", reference: "1042", receiptNo: 12, partOfSplit: false,
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

const words = (p: Props) =>
  renderToStaticMarkup(<ParkHeldMoney {...p} />).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

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
