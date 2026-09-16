import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE PREVIEW SAYS WHOSE MONEY ON ACCOUNT COMES OFF (0167).
 *
 * `runSummary` (ledger-helpers) already says "$742.53 of it already on
 * account" in the headline; the run's toast says "$742.53 of it settled from
 * money on account". Between them the owner had a total and no names — and
 * the point of the figure is that he can tie it to the cheque in the drawer.
 * The sentence is built from the same per-bill `fromOnAccount` the run then
 * applies, so it cannot name a lot the run would treat differently.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { ok: () => {}, err: () => {} }) }));
vi.mock("@/app/park/ledger-actions", () => ({
  previewChargeRun: async () => ({ ok: true }), runCharges: async () => ({ ok: true }),
  recordPayment: async () => ({ ok: true }), voidCharge: async () => ({ ok: true }),
}));
vi.mock("@/app/park/reminder-actions", () => ({ previewReminders: async () => ({ ok: true }), sendReminders: async () => ({ ok: true }) }));
vi.mock("@/components/ClaimForm", () => ({ ClaimForm: () => null }));
vi.mock("@/components/ResolveClaimForm", () => ({ ResolveClaimForm: () => null }));
vi.mock("@/components/ParkReceipt", () => ({ ReceiptPanel: () => null, DropSlips: () => null }));

const { fromOnAccountSentence, ParkRent } = await import("./ParkRent");
const { renderToStaticMarkup } = await import("react-dom/server");
const { summarise, toRows } = await import("@/app/park/ledger-helpers");

const bill = (lotNumber: string, fromOnAccount?: number) => ({ reservationId: `r-${lotNumber}`, lotNumber, amount: 542.53, fromOnAccount });

describe("the sentence under the preview", () => {
  it("names one lot and its figure", () => {
    expect(fromOnAccountSentence({ toBill: [bill("9", 542.53), bill("14"), bill("2", 0)] }))
      .toBe("$542.53 of Lot 9's money on account comes off its bill the moment it's raised — only what's left is ever chased.");
  });

  it("names every lot with money coming off, in plan order, and says oldest money first", () => {
    const s = fromOnAccountSentence({ toBill: [bill("9", 542.53), bill("14", 200), bill("2")] });
    expect(s).toBe("Money on account comes off each bill the moment it's raised, oldest money first — Lot 9 $542.53, Lot 14 $200.00 — and only what's left is ever chased.");
  });

  it("says nothing when nobody being billed has money on account", () => {
    expect(fromOnAccountSentence({ toBill: [bill("9"), bill("14", 0)] })).toBe("");
    expect(fromOnAccountSentence({ toBill: [] })).toBe("");
  });

  it("never promises the money is applied BEFORE the bill exists — it is 'the moment it's raised'", () => {
    const s = fromOnAccountSentence({ toBill: [bill("9", 542.53)] });
    expect(s).toMatch(/the moment it's raised/);
    expect(s).not.toMatch(/already paid|has been paid/);
  });
});

describe("the preview renders it, guarded on the plan's total", () => {
  const src = readFileSync(fileURLToPath(new URL("./ParkRent.tsx", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("inside the plan card, before 'Raising bills tells nobody'", () => {
    const at = src.indexOf("{plan.fromOnAccount > 0 && (");
    expect(at, "the guard is gone").toBeGreaterThan(0);
    const para = src.slice(at, src.indexOf("Raising bills tells nobody", at));
    expect(para.length).toBeGreaterThan(20);
    expect(para).toMatch(/\{fromOnAccountSentence\(plan\)\}/);
    // The headline it sits under is the shared helper's, so the total and
    // the names come from one plan.
    expect(src).toMatch(/<strong>\{runSummary\(plan, page\.month\)\}<\/strong>/);
  });
});

/**
 * A MONTH THAT HAS NOT STARTED HAS NO BILL BUTTON. The forward link stopped
 * at the current month on purpose, and a typed `?month=` still reached the
 * page with the button live — both actions refuse it now
 * (notYetBillableRefusal), so a button that would always say no goes, with
 * the one line saying why. Rendered both ways.
 */
describe("the Bill button on a month that has not started", () => {
  const page = (month: string) => ({ month, rows: [], claims: {}, summary: summarise([]), lagDays: 3, today: "2027-01-28" });

  it("February on 28 January: the sentence, no button", () => {
    const html = renderToStaticMarkup(<ParkRent parkId="park-haven" page={page("2027-02")} />);
    expect(html).toContain("February 2027 hasn&#x27;t started — bill it on the 1st.");
    expect(html).not.toMatch(/>Bill February 2027</);
  });

  it("January on 28 January: the button, no sentence — collapsed the other way", () => {
    const html = renderToStaticMarkup(<ParkRent parkId="park-haven" page={page("2027-01")} />);
    expect(html).toMatch(/>Bill January 2027</);
    expect(html).not.toMatch(/hasn&#x27;t started/);
    // And an earlier month still bills — a June bill still open in August.
    const past = renderToStaticMarkup(<ParkRent parkId="park-haven" page={page("2026-12")} />);
    expect(past).toMatch(/>Bill December 2026</);
  });

  it("is the same helper the two actions refuse with", () => {
    const src = readFileSync(fileURLToPath(new URL("./ParkRent.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/import \{ notYetBillableRefusal \} from "@\/lib\/billing-start"/);
    expect(src).toMatch(/const notYet = notYetBillableRefusal\(page\.month, page\.today, prettyMonth\)/);
    expect(src).toMatch(/\{notYet \? \(/);
  });
});

/**
 * A FULLY-PAID BILL HAS A CANCEL DOOR. "Cancel this bill" sat inside the
 * Record-payment panel, which only opens on a balance, so a bill paid in
 * full — the January the sign door refuses a signing over — could not be
 * cancelled from anywhere. It is a row control now, on every live row; a
 * void row has no button, and the prompt states only what the ledger says
 * (voidCharge decides where the money goes, and refuses money on account
 * by name — the row cannot tell the two kinds apart, so it must not claim).
 */
describe("Cancel this bill on the ledger rows", () => {
  const charge = (over: Partial<{ paidTotal: number; status: "open" | "paid" | "void" }>) => ({
    id: "chg-jan", lotNumber: "14", renterName: "Test Household", periodMonth: "2027-01",
    dueOn: "2027-01-01", amount: 542.53, paidTotal: 0, status: "open" as const, ...over,
  });
  const page = (row: ReturnType<typeof charge>) => {
    // The 2nd: due yesterday, inside the catch-up window, so nobody is late
    // and no reminder button joins the list.
    const rows = toRows([row], "2027-01-02", 3);
    return { month: "2027-01", rows, claims: {}, summary: summarise(rows), lagDays: 3, today: "2027-01-02" };
  };
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

  it("a bill paid in full — balance 0, no Record payment — still has it", () => {
    const html = renderToStaticMarkup(<ParkRent parkId="park-haven" page={page(charge({ paidTotal: 542.53, status: "paid" }))} />);
    expect(buttons(html)).toEqual(["Bill January 2027", "They say they paid", "Cancel this bill"]);
  });

  it("a bill with nothing on it has it next to Record payment", () => {
    const html = renderToStaticMarkup(<ParkRent parkId="park-haven" page={page(charge({}))} />);
    expect(buttons(html)).toEqual(["Bill January 2027", "Record payment", "They say they paid", "Cancel this bill"]);
  });

  it("a cancelled bill does not — collapsed the other way", () => {
    const html = renderToStaticMarkup(<ParkRent parkId="park-haven" page={page(charge({ status: "void" }))} />);
    expect(buttons(html)).toEqual(["Bill January 2027"]);
  });

  it("is a row control calling voidCharge, not a corner of the payment form, and the prompt quotes the ledger's figure without saying where it goes", () => {
    const src = readFileSync(fileURLToPath(new URL("./ParkRent.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src.match(/Cancel this bill/g)).toHaveLength(1);
    expect(src.match(/voidCharge\(/g)).toHaveLength(1);
    const form = src.slice(src.indexOf("function PaymentForm("));
    expect(form).not.toMatch(/voidCharge|Cancel this bill/);
    expect(src).toMatch(/r\.state !== "void" && payingId !== r\.id && claimingId !== r\.id && resolvingId !== r\.id && \(/);
    expect(src).toMatch(/\$\{money\(r\.paidTotal\)\} is recorded against this bill\. Why are you cancelling it\?/);
    expect(src).not.toMatch(/puts that money on their account|goes on their account/);
  });
});
