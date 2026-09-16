import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PaymentTarget } from "@/app/park/pos-actions";
import type { ReceiptLines } from "@/app/park/receipt-helpers";

/**
 * ⊕ TAKE A PAYMENT, AS THE OFFICE SEES IT.
 *
 * The three steps are stateless subcomponents so a static render can draw
 * each one with the props the parent would pass. What a static render cannot
 * reach — the click handler, the key's minting, the backdrop rule — is read
 * as source, with comments stripped and every scan proving it found its
 * anchor before judging it.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/park/pos-actions", () => ({ paymentTargets: vi.fn(async () => ({ ok: true, today: "2027-01-06", targets: [] })) }));
vi.mock("@/app/park/ledger-actions", () => ({ recordPayment: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/park/money-actions", () => ({ recordOnAccount: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/components/ParkReceipt", () => ({ ReceiptPanel: () => <i>receipt</i> }));

const { TakePayment, HouseholdList, RecordForm, Recorded } = await import("./TakePayment");

/** Rendered markup as a person reads it: tags gone, React's escapes decoded. */
const words = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const today = "2027-01-06";
const lot14: PaymentTarget = {
  renterId: "r14", lotNumber: "14", name: "Jane Smith", openCount: 1,
  oldestOpen: { chargeId: "jan", month: "2027-01", balance: 542.53, disputed: false },
  onAccount: 0, nothingMoreBills: false,
};
const lot2: PaymentTarget = {
  renterId: "r2", lotNumber: "2", name: "Bob Jones", openCount: 0, oldestOpen: null, onAccount: 0, nothingMoreBills: false,
};
const lot9: PaymentTarget = {
  renterId: "r9", lotNumber: "9", name: "Household 9", openCount: 3,
  oldestOpen: { chargeId: "nov", month: "2026-11", balance: 542.53, disputed: true },
  onAccount: 0, nothingMoreBills: false,
};
const noop = () => {};

describe("closed", () => {
  it("is the gold button in the park-name row, and nothing else", () => {
    const html = renderToStaticMarkup(<TakePayment parkId="park-1" />);
    expect(html).toMatch(/⊕ Take a payment/);
    expect(html).toMatch(/class="ll-btn gold sm"/);
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html).not.toMatch(/ll-overlay/);
  });
});

describe("the list — tap two", () => {
  const list = (targets: PaymentTarget[], filter = "") =>
    renderToStaticMarkup(
      <HouseholdList loaded={{ ok: true, today, targets }} filter={filter} onFilter={noop} onPick={noop} onRetry={noop} />,
    );

  it("shows lot, name and what is owed in words, in order", () => {
    const html = list([lot2, lot9, lot14]);
    const w = words(html);
    expect(w).toMatch(/Lot 2 Bob Jones Nothing owed — goes on account/);
    expect(w).toMatch(/Lot 9 Household 9 Owes \$542\.53 for November 2026 — oldest of 3 open bills · they say they've paid it/);
    expect(w).toMatch(/Lot 14 Jane Smith Owes \$542\.53 for January 2027/);
    // Every row is a button a thumb can hit, and a button holds phrasing content only.
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).not.toMatch(/<button[^>]*>\s*<div/);
    expect(html).toMatch(/autofocus=""/);
  });

  it("a household on no lot says so", () => {
    expect(words(list([{ ...lot2, lotNumber: "—" }]))).toMatch(/No lot Bob Jones/);
  });

  it("a row says what of theirs the office already holds", () => {
    expect(words(list([{ ...lot14, onAccount: 542.53 }])))
      .toMatch(/Lot 14 Jane Smith Owes \$542\.53 for January 2027 · \$542\.53 of theirs is on account/);
  });

  it("offers the filter box only from nine households", () => {
    expect(list([lot2, lot9, lot14])).not.toMatch(/placeholder="Lot number or name"/);
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...lot2, renterId: `r${i}`, lotNumber: String(i + 1) }));
    const html = list(nine);
    expect(html).toMatch(/placeholder="Lot number or name"/);
    expect(html).toMatch(/aria-label="Find a household"/);
    expect(words(html)).toMatch(/Find them/);
    // The filter never autofocuses — the first row does.
    expect(html).not.toMatch(/<input[^>]*autofocus/);
  });

  it("filters, and says when nobody matches", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...lot2, renterId: `r${i}`, lotNumber: String(i + 1), name: `Household ${i + 1}` }));
    expect(list(nine, "4").match(/<button/g)).toHaveLength(1);
    expect(words(list(nine, "zz"))).toMatch(/Nobody matches "zz"\./);
  });

  it("a failed read is a sentence, never an empty list", () => {
    const sentence = "We couldn't load something just now, so nothing has been changed. Try again in a moment.";
    const html = renderToStaticMarkup(
      <HouseholdList loaded={{ ok: false, error: sentence, retryable: true }} filter="" onFilter={noop} onPick={noop} onRetry={noop} />,
    );
    expect(html).toMatch(/class="ll-notice" role="alert"/);
    expect(words(html)).toContain(sentence);
    expect(words(html)).toMatch(/Try again/);
    expect(html).not.toMatch(/Nobody is on your roll yet/);
    const denied = renderToStaticMarkup(
      <HouseholdList loaded={{ ok: false, error: "You don't manage that park.", retryable: false }} filter="" onFilter={noop} onPick={noop} onRetry={noop} />,
    );
    expect(words(denied)).toContain("You don't manage that park.");
    expect(denied).not.toMatch(/Try again/);
  });

  it("while reading, says so", () => {
    expect(words(renderToStaticMarkup(<HouseholdList loaded={null} filter="" onFilter={noop} onPick={noop} onRetry={noop} />)))
      .toBe("Reading your roll…");
  });

  it("an empty roll names the two doors that fill it", () => {
    const html = list([]);
    expect(words(html)).toContain("Nobody is on your roll yet, so there's nobody to take a payment from.");
    expect(html).toMatch(/href="\/park\/import"[^>]*>Load the roll</);
    expect(html).toMatch(/href="\/park\/onboard"[^>]*>Who lives here</);
  });
});

describe("the form — tap three", () => {
  const form = (target: PaymentTarget, method: "check" | "cash" | "transfer" | "other" = "check") =>
    renderToStaticMarkup(
      <RecordForm parkId="park-1" target={target} today={today} method={method} onMethod={noop} idemKey="k"
        busy={false} start={(fn) => fn()} onRecorded={noop} onBack={noop} />,
    );

  it("is pre-filled to the balance, today, and check — Enter on the focused button is the tap", () => {
    const t = { ...lot14, oldestOpen: { ...lot14.oldestOpen!, balance: 342.53 } };
    const html = form(t);
    expect(html).toMatch(/<input inputMode="decimal"[^>]*value="342.53"\/>/);
    expect(html).toMatch(/<input type="date" max="2027-01-06"[^>]*value="2027-01-06"\/>/);
    expect(html).toMatch(/<select[^>]*>\s*<option value="check" selected="">Check<\/option><option value="cash">Cash<\/option><option value="transfer">Bank transfer<\/option><option value="other">Other<\/option>\s*<\/select>/);
    const w = words(html);
    expect(w).toMatch(/How much/);
    expect(w).toMatch(/How Check Cash Bank transfer Other/);
    expect(w).toMatch(/Check number/);
    expect(w).toMatch(/When it came in/);
    expect(w).toMatch(/Settles January 2027\./);
    expect(html).toMatch(/<button[^>]*class="ll-btn gold"[^>]*autofocus=""[^>]*>Record \$342\.53<\/button>/);
    expect(html).toMatch(/placeholder="1042"/);
    expect(w).toMatch(/Back/);
    // Nothing here is disputed, so nothing says a claim will be answered.
    expect(w).not.toMatch(/claim/);
  });

  it("calls the reference a reference when it is not a check", () => {
    const w = words(form(lot14, "cash"));
    expect(w).toMatch(/Reference/);
    expect(w).not.toMatch(/Check number/);
  });

  it("nothing owed: the box is empty and focused, the note says on account, Record waits", () => {
    const html = form(lot2);
    expect(html).toMatch(/<input inputMode="decimal" autoComplete="off" autofocus=""[^>]*value=""\/>/);
    expect(words(html)).toMatch(/Nothing is owed, so this goes on account and comes off the next bill you raise for them\./);
    expect(html).toMatch(/<button[^>]*class="ll-btn gold"[^>]*disabled=""[^>]*>Record<\/button>/);
    expect(html).not.toMatch(/<button[^>]*class="ll-btn gold"[^>]*autofocus/);
  });

  it("money of theirs already on account: the note says so, and the door it names is on the form", () => {
    const html = form({ ...lot14, onAccount: 542.53 });
    const w = words(html);
    expect(w).toMatch(/Settles January 2027\. \$542\.53 of theirs is already on account and would cover this — record this and that stays on account and comes off the next bill you raise for them; to use it on this bill instead, put it on the bill from "Money not against a bill"\./);
    expect(html).toMatch(/href="\/park\/rent"[^>]*>Money not against a bill</);
    // The bare form never shows that door — copy that names no control gets none.
    expect(form(lot14)).not.toMatch(/Money not against a bill/);
  });

  it("a household nothing more bills for: no 'comes off', and the hand-back door", () => {
    const html = form({ ...lot2, lotNumber: "—", nothingMoreBills: true });
    const w = words(html);
    expect(w).toMatch(/nothing more bills for them, so it's theirs to have back from "Money not against a bill" on the Rent screen\./);
    expect(w).not.toMatch(/comes off/);
    expect(html).toMatch(/href="\/park\/rent"[^>]*>Money not against a bill</);
  });

  it("a disputed bill says what Record does to their claim, beside the door to the rent screen", () => {
    const html = form(lot9);
    expect(words(html)).toMatch(/Recording this marks their 'I paid November 2026' claim as answered\. If this money is for a different month, record it from the rent screen\./);
    expect(html).toMatch(/href="\/park\/rent\?month=2027-01"[^>]*>Open the rent screen</);
  });

  it("while busy, the button says so and Back is disabled", () => {
    const html = renderToStaticMarkup(
      <RecordForm parkId="park-1" target={lot14} today={today} method="check" onMethod={noop} idemKey="k"
        busy={true} start={(fn) => fn()} onRecorded={noop} onBack={noop} />,
    );
    expect(html).toMatch(/>Recording…<\/button>/);
    expect(html).toMatch(/<button[^>]*class="ll-btn ghost"[^>]*disabled=""[^>]*>Back<\/button>/);
  });
});

describe("recorded — after tap three", () => {
  const lines: ReceiptLines = {
    parkName: "P", officeLine: "", receiptNo: 7, feeAmount: null, lotNumber: "14", payerName: "Jane Smith",
    amount: 600, method: "check", reference: null, receivedOn: today, periodMonth: "2027-01",
    billAmount: 542.53, balanceAfter: 0, onAccount: null, confirmUrl: null,
  };

  it("names both figures of a split, then the door's sentence, the held-money door, the receipt, and another", () => {
    const html = renderToStaticMarkup(
      <Recorded parkId="park-1"
        outcome={{ path: "bill", amount: 600, against: 542.53, onAccount: 57.47, month: "2027-01", balanceAfter: 0, name: "Jane Smith", wentSomewhere: false }}
        signal="$600.00 received — $542.53 against January 2027, $57.47 on account. It comes off February 2027 when you raise it."
        receipt={lines} renterEmail={null} onClose={noop} onAnother={noop} />,
    );
    const w = words(html);
    expect(w).toContain("$600.00 received — $542.53 against January 2027; $57.47 on account.");
    expect(w).toContain("It comes off February 2027 when you raise it.");
    expect(html).toMatch(/href="\/park\/rent"[^>]*>Money not against a bill</);
    expect(html).toMatch(/<i>receipt<\/i>/);
    expect(w).toMatch(/Take another payment/);
  });

  it("a part payment says what is still outstanding, and offers no held-money door", () => {
    const html = renderToStaticMarkup(
      <Recorded parkId="park-1"
        outcome={{ path: "bill", amount: 342.53, against: 342.53, onAccount: 0, month: "2027-01", balanceAfter: 200, name: "Jane Smith", wentSomewhere: false }}
        signal="Recorded. $200.00 still outstanding." receipt={null} renterEmail={null} onClose={noop} onAnother={noop} />,
    );
    expect(words(html)).toContain("$342.53 received against January 2027 — $200.00 still outstanding.");
    expect(html).not.toMatch(/Money not against a bill/);
    expect(html).not.toMatch(/<i>receipt<\/i>/);
  });

  it("the account path leads with the door's own first sentence, bold", () => {
    const html = renderToStaticMarkup(
      <Recorded parkId="park-1"
        outcome={{ path: "account", amount: 200, against: 0, onAccount: 200, month: null, balanceAfter: null, name: "Bob Jones", wentSomewhere: false }}
        signal={`$200.00 recorded for Bob Jones. It's on account and comes off the next bill you raise for them — or put it against an open bill now from "Money not against a bill".`}
        receipt={null} renterEmail={null} onClose={noop} onAnother={noop} />,
    );
    expect(html).toMatch(/font-weight:800[^>]*>\$200\.00 recorded for Bob Jones\.<\/p>/);
    expect(words(html)).toContain(`It's on account and comes off the next bill you raise for them — or put it against an open bill now from "Money not against a bill".`);
    expect(html).toMatch(/href="\/park\/rent"[^>]*>Money not against a bill</);
  });
});

describe("TakePayment.tsx, read as source", () => {
  const src = readFileSync(fileURLToPath(new URL("./TakePayment.tsx", import.meta.url)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  /** The body of one exported function, from its `export function` to the next. */
  const fn = (name: string) => {
    const at = src.indexOf(`export function ${name}(`);
    expect(at, `${name} is gone`).toBeGreaterThan(0);
    const next = src.indexOf("\nexport function ", at + 1);
    return src.slice(at, next === -1 ? undefined : next);
  };

  it("is the app's own overlay, not a new device", () => {
    expect(src).toMatch(/className="ll-overlay"/);
    expect(src).toMatch(/className="ll-modal"/);
    expect(src).toMatch(/className="ll-modal-head"/);
    expect(src).toMatch(/className="ll-modal-body"/);
    expect(src).not.toMatch(/position: "fixed"/);
  });

  it("the backdrop closes the list only — a filled form and a receipt nothing reprints leave by ✕, Back, Done or Escape", () => {
    const parent = fn("TakePayment");
    const guard = parent.slice(parent.indexOf('className="ll-overlay"'), parent.indexOf('className="ll-modal"'));
    expect(guard).toMatch(/e\.target === e\.currentTarget && step === "pick" && !busy/);
    expect(parent).toMatch(/e\.key === "Escape" && !busy/);
    expect(parent).toMatch(/className="ll-x" onClick=\{close\} aria-label="Close" disabled=\{busy\}/);
  });

  it("holds ONE busy for the whole window and hands it to the form", () => {
    const parent = fn("TakePayment");
    expect(parent).toMatch(/const \[busy, start\] = useTransition\(\)/);
    expect(parent).toMatch(/busy=\{busy\}\s+start=\{start\}/);
    expect(fn("RecordForm")).not.toMatch(/useTransition\(/);
  });

  it("mints the key when a household is picked and on 'another' — never in the form, never shared across households", () => {
    const parent = fn("TakePayment");
    const pick = parent.slice(parent.indexOf("function pick("), parent.indexOf("function close("));
    const another = parent.slice(parent.indexOf("function another("), parent.indexOf("function recorded("));
    const openWindow = parent.slice(parent.indexOf("function openWindow("), parent.indexOf("function pick("));
    expect(pick).toMatch(/setIdemKey\(mintKey\(\)\)/);
    expect(another).toMatch(/setIdemKey\(mintKey\(\)\)/);
    expect(openWindow).not.toMatch(/mintKey\(/);
    expect(fn("RecordForm")).not.toMatch(/mintKey\(/);
    expect((src.match(/mintKey\(\)/g) ?? []).length).toBe(2);
  });

  it("calls the two doors with the key in the eighth position and nothing in the seventh, and maps each result through the tested helper", () => {
    const form = fn("RecordForm");
    expect(form).toMatch(/recordPayment\(parkId, target\.oldestOpen\.chargeId, amt, method, reference, receivedOn, undefined, idemKey\)/);
    expect(form).toMatch(/recordOnAccount\(parkId, target\.renterId, amt, method, reference, receivedOn, undefined, idemKey\)/);
    expect(form).toMatch(/outcomeFromBill\(res, target, amt\)/);
    expect(form).toMatch(/outcomeFromAccount\(res, target, amt\)/);
    // A rejected promise is not worded "try again": the money may have landed.
    expect(form).toMatch(/catch \{[\s\S]*?setRefusal\(UNREACHABLE_WRITE\)/);
    expect(src).toMatch(/UNREACHABLE_WRITE =\s*"We couldn't reach the office ledger — check the rent screen before recording it again\."/);
    expect(src).not.toMatch(/office ledger — try again/);
  });

  it("offers the four hand-keyed ways and never a processor rail", () => {
    const block = src.match(/const METHODS = \[([\s\S]*?)\] as const;/)?.[1];
    expect(block, "no METHODS literal").toBeTruthy();
    expect([...block!.matchAll(/value: "([a-z]+)"/g)].map((m) => m[1])).toEqual(["check", "cash", "transfer", "other"]);
    expect(src).not.toMatch(/value[=:]\s*"card"/);
    expect(src).not.toMatch(/value[=:]\s*"ach"/);
    expect(src).toMatch(/value: "transfer", label: "Bank transfer"/);
  });

  it("never toasts from this file, and never touches storage itself", () => {
    expect(src).not.toMatch(/@\/components\/Toast/);
    expect(src).not.toMatch(/toast\(/);
    expect(src).not.toMatch(/sessionStorage|localStorage/);
  });

  it("shows a refusal as the door's sentence in a notice, beside the door it may name", () => {
    const form = fn("RecordForm");
    expect(form).toMatch(/<div className="ll-notice" role="alert"[^>]*>\{refusal\}<\/div>/);
    expect(form).toMatch(/refusal\.includes\("Money not against a bill"\)/);
  });

  it("Back re-reads the roll — the list is never the read from before the tap", () => {
    // The prop seam, read as the assignment the parent makes: a refusal
    // ("that bill was cancelled", "already recorded") returns the office
    // here, and a list read before the tap would offer the same balance
    // against the same dead bill, with a fresh key minted on the next tap.
    const parent = fn("TakePayment");
    const back = parent.match(/onBack=\{([^}]*\{[^}]*\}[^}]*|[^}]*)\}/)?.[0];
    expect(back, "no onBack prop on the form").toBeTruthy();
    expect(back).toMatch(/setStep\("pick"\)/);
    expect(back).toMatch(/void load\(\)/);
    // Not through another(): that clears the filter that found them the row.
    expect(back).not.toMatch(/another\(/);
    // And every other way back to the list reads too — ✕ and Escape leave
    // the window, which openWindow re-reads; another() reads by itself.
    const another = parent.slice(parent.indexOf("function another("), parent.indexOf("function recorded("));
    expect(another).toMatch(/void load\(\)/);
    const openWindow = parent.slice(parent.indexOf("function openWindow("), parent.indexOf("function pick("));
    expect(openWindow).toMatch(/void load\(\)/);
  });

  it("mounts the one receipt panel once, and refreshes the screen behind the card", () => {
    expect((src.match(/<ReceiptPanel/g) ?? []).length).toBe(1);
    const parent = fn("TakePayment");
    const recorded = parent.slice(parent.indexOf("function recorded("), parent.indexOf("useEffect("));
    expect(recorded).toMatch(/router\.refresh\(\)/);
    expect(parent).toMatch(/onRecorded=\{recorded\}/);
  });

  it("the amount box takes a numeric keypad, and the first row takes focus", () => {
    expect(fn("RecordForm")).toMatch(/inputMode="decimal"/);
    expect(fn("HouseholdList")).toMatch(/autoFocus=\{i === 0\}/);
  });
});
