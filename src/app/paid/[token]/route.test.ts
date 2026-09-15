import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfirmView } from "@/lib/confirm-server";

/**
 * "DOES THIS LOOK RIGHT?" READS WHERE THE MONEY ON ACCOUNT WENT (0167).
 *
 * The link is printed on paper and outlives the day it was written. The
 * loader now hands the page `whereItWent` ("$542.53 to January 2027, $542.53
 * on account") and `onAccountRemaining`; the page used to read neither, so a
 * resident opening a March receipt read "has since been put against a bill"
 * with no month, and the quarter-ahead cheque's OWN link said nothing about
 * where the quarter went at all. The real GET, with the loader faked.
 */

const view: { current: ConfirmView | null } = { current: null };
vi.mock("server-only", () => ({}));
vi.mock("@/lib/confirm-server", () => ({
  loadPaymentByToken: async () => view.current,
  confirmByToken: async () => ({ ok: true }),
  disputeByToken: async () => ({ ok: true }),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));

const { GET } = await import("./route");

const TOKEN = "a".repeat(40);
const base = (over: Partial<ConfirmView> = {}): ConfirmView => ({
  parkName: "The Haven", lotNumber: "9", amount: 600, onAccount: 57.47, onAccountApplied: false,
  onAccountRemaining: 57.47, allocations: [], whereItWent: "$57.47 on account",
  takenBackOn: null, takenBackWhy: null, siblingTakenBackOn: null, siblingTakenBackWhy: null,
  fee: null, method: "check", reference: "1042", receivedOn: "2027-01-03",
  ref: "The Haven receipt 12", alreadyConfirmedAt: null, ...over,
});

async function text(v: ConfirmView): Promise<string> {
  view.current = v;
  const res = await GET(new Request("https://lakelife.test/paid/x"), { params: Promise.resolve({ token: TOKEN }) });
  const html = await res.text();
  return html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

beforeEach(() => { view.current = null; });

describe("a split receipt — $600 for a $542.53 bill", () => {
  it("nothing applied yet: held for you, and it comes off the next bill", async () => {
    const t = await text(base());
    expect(t).toMatch(/\$57\.47 of that is on account with the office — held for you, not yet put against a bill\. It comes off the next bill the park raises for you\./);
  });

  it("partly applied: names the month and what is still held, from the loader's sentence", async () => {
    const t = await text(base({
      onAccountApplied: true, onAccountRemaining: 17.47,
      allocations: [{ periodMonth: "2027-02", amount: 40 }], whereItWent: "$40.00 to February 2027, $17.47 on account",
    }));
    expect(t).toMatch(/\$57\.47 of that went on account with the office and has since been put against a bill\. That's \$40\.00 to February 2027, \$17\.47 on account — what's still on account comes off the next bill the park raises for you\./);
  });

  it("wholly applied: names the month and promises nothing about money that is gone", async () => {
    const t = await text(base({
      onAccountApplied: true, onAccountRemaining: 0,
      allocations: [{ periodMonth: "2027-02", amount: 57.47 }], whereItWent: "$57.47 to February 2027",
    }));
    expect(t).toMatch(/has since been put against a bill\. That's \$57\.47 to February 2027\./);
    expect(t).not.toMatch(/comes off the next bill/);
  });
});

describe("the quarter-ahead cheque's own link", () => {
  const own = (over: Partial<ConfirmView> = {}) => base({
    lotNumber: "—", amount: 1627.59, onAccount: null, ...over,
  });

  it("before anything is applied: this is money on account, and it comes off the next bill", async () => {
    const t = await text(own({ onAccountApplied: false, onAccountRemaining: 1627.59, allocations: [], whereItWent: "$1,627.59 on account" }));
    expect(t).toMatch(/recorded \$1,627\.59 from you, paid by check 1042/);
    expect(t).not.toMatch(/from lot —/);
    expect(t).toMatch(/That money is on account with the office — held for you\. It comes off the next bill the park raises for you\./);
  });

  it("two months in: says which months it paid and what is still held", async () => {
    const t = await text(own({
      onAccountApplied: true, onAccountRemaining: 542.53,
      allocations: [{ periodMonth: "2027-01", amount: 542.53 }, { periodMonth: "2027-02", amount: 542.53 }],
      whereItWent: "$542.53 to January 2027, $542.53 to February 2027, $542.53 on account",
    }));
    expect(t).toMatch(/That money went on account with the office\. Where it went: \$542\.53 to January 2027, \$542\.53 to February 2027, \$542\.53 on account — what's still on account comes off the next bill the park raises for you\./);
  });

  it("all spent: no promise about a next bill", async () => {
    const t = await text(own({
      onAccountApplied: true, onAccountRemaining: 0,
      allocations: [{ periodMonth: "2027-01", amount: 542.53 }, { periodMonth: "2027-02", amount: 542.53 }, { periodMonth: "2027-03", amount: 542.53 }],
      whereItWent: "$542.53 to January 2027, $542.53 to February 2027, $542.53 to March 2027",
    }));
    expect(t).toMatch(/Where it went: \$542\.53 to January 2027, \$542\.53 to February 2027, \$542\.53 to March 2027\./);
    expect(t).not.toMatch(/comes off the next bill/);
  });
});

/**
 * THE LINK OUTLIVES THE CHEQUE. A quarter-ahead cheque bounces AFTER the run
 * has spent it on January and February; the office reverses it; the months
 * are outstanding again; nothing is on account. The page is a permanent URL
 * on paper — read in March it must say the payment was taken back, and
 * never "held for you — it comes off the next bill" about money the office
 * has recorded as never having arrived.
 */
describe("a payment the office took back, or the bank returned", () => {
  const bounced = (over: Partial<ConfirmView> = {}) => base({
    lotNumber: "—", amount: 1627.59, onAccount: null, onAccountApplied: true, onAccountRemaining: 0,
    allocations: [{ periodMonth: "2027-01", amount: 542.53 }, { periodMonth: "2027-02", amount: 542.53 }],
    whereItWent: "$542.53 to January 2027, $542.53 to February 2027",
    takenBackOn: "2027-02-03T15:00:00Z", takenBackWhy: "the cheque bounced", ...over,
  });

  it("the quarter-ahead cheque's own link: says it was taken back, with the day and the reason, and where it HAD gone", async () => {
    const t = await text(bounced());
    expect(t).toMatch(/This payment was taken back on Wednesday, February 3, 2027 — the cheque bounced\./);
    expect(t).toMatch(/It had been put against \$542\.53 to January 2027, \$542\.53 to February 2027; that no longer stands\./);
    expect(t).not.toMatch(/comes off/);
    expect(t).not.toMatch(/held for you/);
    expect(t).not.toMatch(/is on account/);
  });

  it("a bank return reads the bank's code as the reason", async () => {
    const t = await text(bounced({ method: "bank transfer", takenBackOn: "2027-01-08T09:00:00Z", takenBackWhy: "R01" }));
    expect(t).toMatch(/This payment was taken back on Friday, January 8, 2027 — R01\./);
  });

  it("a cheque taken back before anything was applied says so without naming months", async () => {
    const t = await text(bounced({ onAccountApplied: false, allocations: [], whereItWent: "" }));
    expect(t).toMatch(/This payment was taken back on Wednesday, February 3, 2027 — the cheque bounced\./);
    expect(t).not.toMatch(/had been put against/);
    expect(t).not.toMatch(/comes off/);
  });

  /**
   * A SPLIT IS TWO ROWS, AND EACH HALF STANDS OR FALLS ON ITS OWN. The bill
   * row carries the token; `takenBackOn` is ITS reversed_at. The loader
   * lists the on-account sibling only while it stands (its read filters
   * reversed_at), so `onAccount`, `whereItWent` and `onAccountRemaining`
   * here belong to a row that STANDS: its $40 is still on December, its
   * $17.47 is still held. "It had been put against …; that no longer stands"
   * was printed about them anyway — two facts, one branch.
   */
  describe("a split receipt whose bill row alone was taken back, the on-account half still standing", () => {
    const halfGone = (over: Partial<ConfirmView> = {}) =>
      base({ takenBackOn: "2027-02-03T15:00:00Z", takenBackWhy: "a typo — keyed twice", ...over });

    it("nothing of the rest applied yet: names which half went, and that the rest is held and comes off the next bill", async () => {
      const t = await text(halfGone());
      expect(t).toMatch(/The part of this against your bill was taken back on Wednesday, February 3, 2027 — a typo — keyed twice\./);
      expect(t).toMatch(/The \$57\.47 on account is a separate record — it still stands, held for you, not yet put against a bill\. It comes off the next bill the park raises for you\./);
      expect(t).not.toMatch(/no longer stands/);
      // Never "this payment was taken back": $57.47 of it was not.
      expect(t).not.toMatch(/This payment was taken back/);
    });

    it("the rest partly applied: what stands is said from the loader's sentence, never 'no longer stands'", async () => {
      const t = await text(halfGone({
        onAccountApplied: true, onAccountRemaining: 17.47,
        allocations: [{ periodMonth: "2026-12", amount: 40 }], whereItWent: "$40.00 to December 2026, $17.47 on account",
      }));
      expect(t).not.toMatch(/no longer stands/);
      expect(t).toMatch(/The part of this against your bill was taken back on Wednesday, February 3, 2027 — a typo — keyed twice\./);
      expect(t).toMatch(/The \$57\.47 on account is a separate record — it still stands, and has since been put against a bill\. That's \$40\.00 to December 2026, \$17\.47 on account — what's still on account comes off the next bill the park raises for you\./);
      expect(t).not.toMatch(/This payment was taken back/);
    });

    it("the rest wholly applied: names the month and promises nothing about a next bill", async () => {
      const t = await text(halfGone({
        onAccountApplied: true, onAccountRemaining: 0,
        allocations: [{ periodMonth: "2026-12", amount: 57.47 }], whereItWent: "$57.47 to December 2026",
      }));
      expect(t).toMatch(/The \$57\.47 on account is a separate record — it still stands, and has since been put against a bill\. That's \$57\.47 to December 2026\./);
      expect(t).not.toMatch(/no longer stands/);
      expect(t).not.toMatch(/comes off/);
    });

    it("the source: 'that no longer stands' is said only of the row's OWN allocations (no sibling), never of a standing sibling's", () => {
      const src = readFileSync(join(process.cwd(), "src", "app", "paid", "[token]", "route.ts"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const fn = src.slice(src.indexOf("function onAccountWords"), src.indexOf("export async function GET"));
      const gone = fn.indexOf("that no longer stands");
      expect(gone).toBeGreaterThan(0);
      // The sibling branch is decided first, on view.onAccount, and returns
      // before the "no longer stands" sentence can be reached.
      const split = fn.indexOf("view.onAccount != null");
      expect(split).toBeGreaterThan(0);
      expect(split).toBeLessThan(gone);
      expect(fn.slice(split, gone)).toMatch(/return /);
      expect(fn.slice(split, gone)).not.toMatch(/no longer stands/);
    });
  });

  /**
   * BOTH HALVES GONE. Should the loader ever list a sibling that no longer
   * stands, it says so with the sibling's own `siblingTakenBackOn`; the page
   * then says the whole went and never "still stands". Today the loader
   * filters such a sibling out (the row reads as a plain bill payment), so
   * this is the page's defence, read only when the field is handed to it.
   */
  it("a split receipt whose on-account half was taken back too says the whole went, and never 'still stands'", async () => {
    const both = {
      ...base({
        takenBackOn: "2027-02-03T15:00:00Z", takenBackWhy: "the cheque bounced",
        onAccountApplied: true, onAccountRemaining: 0,
        allocations: [{ periodMonth: "2026-12", amount: 40 }], whereItWent: "$40.00 to December 2026",
      }),
      siblingTakenBackOn: "2027-02-03T15:00:00Z",
    } as ConfirmView;
    const t = await text(both);
    expect(t).toMatch(/\$57\.47 of that had gone on account with the office\. It had been put against \$40\.00 to December 2026; that no longer stands\./);
    expect(t).toMatch(/This payment was taken back on Wednesday, February 3, 2027 — the cheque bounced\./);
    expect(t).not.toMatch(/still stands/);
    expect(t).not.toMatch(/comes off/);
    expect(t).not.toMatch(/held for you/);
  });

  it("a reason the record does not carry is left out, not printed as 'null'", async () => {
    const t = await text(bounced({ takenBackWhy: null }));
    expect(t).toMatch(/This payment was taken back on Wednesday, February 3, 2027\./);
    expect(t).not.toMatch(/null/);
    expect(t).not.toMatch(/— \./);
  });

  it("the source: the taken-back branch is checked BEFORE any comes-off sentence can be built", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "paid", "[token]", "route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const fn = src.slice(src.indexOf("function onAccountWords"), src.indexOf("export async function GET"));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn.indexOf("view.takenBackOn")).toBeGreaterThan(0);
    expect(fn.indexOf("view.takenBackOn")).toBeLessThan(fn.indexOf("COMES_OFF"));
    expect(fn).toMatch(/longDay\(view\.takenBackOn\)/);
  });
});

describe("a plain bill payment, and a deposit, say nothing about money on account", () => {
  it("a $542.53 cheque against January", async () => {
    const t = await text(base({ amount: 542.53, onAccount: null, onAccountApplied: false, onAccountRemaining: null, allocations: [], whereItWent: "" }));
    expect(t).toMatch(/recorded \$542\.53 from lot 9/);
    expect(t).not.toMatch(/on account/);
  });

  it("a deposit — the loader hands it no remaining and no allocations", async () => {
    const t = await text(base({ lotNumber: "—", amount: 500, onAccount: null, onAccountApplied: false, onAccountRemaining: null, allocations: [], whereItWent: "" }));
    expect(t).not.toMatch(/on account/);
  });
});

describe("the date is a permanent page's date — with its year, on the lakes' clock", () => {
  it("Sunday, January 3, 2027", async () => {
    const t = await text(base());
    expect(t).toMatch(/on Sunday, January 3, 2027\./);
  });
});
