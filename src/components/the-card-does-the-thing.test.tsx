import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE MORNING SCREEN WAS A ROUTER, NOT A CONSOLE.
 *
 * Every task card ended in the same control: a Link labelled "Sort it".
 * Nineteen kinds of task, one generic verb, four destinations. The card had
 * already computed the lot, the month, the count and the due day — then threw
 * all of it away and handed him a URL where he had to find the thing again.
 *
 * That is why cutting the navigation from thirteen tabs to six in September
 * changed nothing: the taps were never in the navigation. Raising January's
 * bills — the one act January requires — was five taps across three screens,
 * for a plan the nightly had already computed at 8pm and emailed him as a
 * sentence.
 *
 * A card with an action draws its own verb and does the thing. A card without
 * one keeps the link, because work that needs a form should go to the form.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { err: () => {} }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));
vi.mock("@/app/park/today-actions", () => ({
  snoozeTask: async () => ({ ok: true }), dismissTask: async () => ({ ok: true }),
  addNote: async () => ({ ok: true }), doneNote: async () => ({ ok: true }),
  runTaskAction: async () => ({ ok: true }),
}));

const { ParkToday } = await import("@/components/ParkToday");

const BASE = {
  parkName: "The Haven", today: "2027-01-02", parkId: "park-1",
  liveness: { alarm: null }, firstRun: null, findings: [], readiness: null,
  beforeGoLive: false, crewsOnSite: 0, notes: [], runs: [], requests: [],
  occupancy: { main: "", sub: "" }, quiet: null, checkedLine: null,
  money: {
    headline: "Nothing has come in yet this month.", todayLine: null,
    ledgerLine: "", arrearsLine: null, disputedLine: null, clearingLine: null,
    offBookLine: null,
  },
} as unknown as Parameters<typeof ParkToday>[0]["view"];

const task = (over: Record<string, unknown> = {}) => ({
  key: "k", title: "January 2027 isn't billed yet",
  detail: "19 households have no January 2027 bill. Rent is due on the 1st.",
  urgency: "overdue", dueOn: "2027-01-01", href: "/park/rent", canDismiss: false,
  ...over,
});

const render = (tasks: unknown[]) =>
  renderToStaticMarkup(<ParkToday parkId="park-1" view={{ ...BASE, tasks } as never} />)
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("a task card that can act", () => {
  it("draws its own verb instead of 'Sort it'", () => {
    const w = render([task({
      action: { kind: "raise_bills", month: "2027-01", verb: "Raise January 2027's bills" },
    })]);
    // The apostrophe arrives HTML-escaped, so the assertion sits on the half
    // of the verb that carries the meaning — this file's convention elsewhere.
    expect(w).toMatch(/Raise January 2027/);
    expect(w).toMatch(/bills/);
    expect(w, "the generic verb is still the primary control").not.toMatch(/Sort it/);
  });

  it("still offers the ledger, for when he wants the whole list", () => {
    const w = render([task({
      action: { kind: "raise_bills", month: "2027-01", verb: "Raise January 2027's bills" },
    })]);
    expect(w).toMatch(/Open the ledger/);
  });

  it("names the size of the act, so the tap is a decision", () => {
    const w = render([task({
      action: { kind: "raise_bills", month: "2027-01", verb: "Raise January 2027's bills" },
    })]);
    expect(w).toContain("19 households have no January 2027 bill");
  });

  it("falls back to the link when the card cannot act", () => {
    // Work that needs a form must still go to the form — a verb on a card that
    // cannot carry the decision would be worse than a signpost.
    const w = render([task()]);
    expect(w).toMatch(/Sort it/);
    expect(w).not.toMatch(/Open the ledger/);
  });
});

describe("what is allowed to be a card action", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../app/park/today-actions.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("asserts membership before doing anything", () => {
    const fn = src.slice(src.indexOf("export async function runTaskAction"));
    expect(fn.length, "the dispatcher is gone — this scan measures nothing").toBeGreaterThan(200);
    const gate = fn.indexOf("assertMyPark");
    const work = fn.indexOf("switch (action.kind)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate, "the dispatcher acts before it checks who is asking").toBeLessThan(work);
  });

  it("dispatches on a word, so a card cannot smuggle in a function", () => {
    expect(src).toMatch(/switch \(action\.kind\)/);
  });

  it("refuses a kind it does not know, out loud", () => {
    // A button that does nothing and says nothing is worse than no button.
    expect(src).toMatch(/const unknown: never = action\.kind/);
    expect(src).toMatch(/isn't wired up yet/);
  });

  it("does NOT put money, notices or tenancy endings on a card", () => {
    // The standing rule: a card may act only where a mis-tap is survivable.
    // Raising a bill can be cancelled; these cannot be undone with one tap.
    for (const forbidden of ["sendReminders", "sendBillNotices", "refundParkPayment", "recordPayment", "moveOut"]) {
      expect(src, `${forbidden} is reachable from a task card`).not.toContain(forbidden);
    }
  });
});
