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

const { fromOnAccountSentence } = await import("./ParkRent");

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
