import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE SETUP CHECKLIST RENDERED TWICE, ON THE ONE PARK THIS PRODUCT HAS.
 *
 * Today draws the readiness list in two places, for two different halves of
 * a park's life. The ternary near the top draws it BEFORE go-live, where it
 * "stands where the money card would" — there is no money and no occupancy
 * yet, so the checklist takes that slot. The block lower down draws it AFTER
 * go-live, under the money card, whenever the park is unpublished or a
 * required row is undone.
 *
 * The lower block used to be gated `!view.beforeGoLive &&`. That gate was
 * removed, with a long comment explaining that the checklist had been
 * "invisible on the one screen built to guide, for the whole of the setup
 * window it exists for" — which was not so: the ternary above was already
 * drawing it. Removing the gate did not make it visible, it made it double.
 *
 * `getToday` sets `readiness` non-null whenever `beforeGoLive` is true, so
 * this was not an edge case: every park before its takeover day saw the whole
 * list twice, one copy above the other. The Haven's cutover is 1 January
 * 2027, so it is that park, now.
 *
 * Counted by rendering rather than by reading, because reading is what missed
 * it: both blocks are forty lines of comment apart.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/Toast", () => ({
  toast: Object.assign(() => {}, { ok: () => {}, err: () => {} }),
}));
vi.mock("@/app/park/today-actions", () => ({
  snoozeTask: async () => ({ ok: true }),
  dismissTask: async () => ({ ok: true }),
  addNote: async () => ({ ok: true }),
  doneNote: async () => ({ ok: true }),
  runTaskAction: async () => ({ ok: true }),
}));

const { ParkToday } = await import("@/components/ParkToday");

type View = Parameters<typeof ParkToday>[0]["view"];

/** Distinctive strings, so a count cannot be confused with ordinary copy. */
const READY_HEAD = "ZZ-READINESS-HEADLINE";
const MONEY_HEAD = "ZZ-MONEY-HEADLINE";

function view(over: Partial<Record<string, unknown>>): View {
  return {
    parkName: "The Haven",
    today: "2026-10-29",
    month: "2026-10",
    money: {
      headline: MONEY_HEAD, todayLine: null, offBookLine: null,
      ledgerLine: "the ledger line", arrearsLine: null, disputedLine: null,
      clearingLine: null,
    },
    occupancy: { main: "19 of 21 lots are lived on.", sub: null },
    tasks: [], notes: [], quiet: null, firstRun: null,
    beforeGoLive: false,
    readiness: { headline: READY_HEAD, sub: "sub", rows: [] },
    crewsOnSite: 0,
    liveness: { alarm: null, line: "checked last night" },
    findings: [],
    ...over,
  } as unknown as View;
}

const render = (v: View) => renderToStaticMarkup(<ParkToday parkId="p1" view={v} />);
const count = (html: string, needle: string) => (html.match(new RegExp(needle, "g")) ?? []).length;

describe("the readiness list is drawn once, on whichever side of go-live the park is", () => {
  it("BEFORE go-live: once, standing where the money card would", () => {
    const html = render(view({ beforeGoLive: true }));
    expect(count(html, READY_HEAD), "the setup checklist is on the screen twice").toBe(1);
    // And the other half of that slot: the money card is NOT also drawn,
    // because before go-live there is no money to report.
    expect(count(html, MONEY_HEAD), "a park before go-live is reporting money").toBe(0);
  });

  it("AFTER go-live: once, under the money card", () => {
    const html = render(view({ beforeGoLive: false }));
    expect(count(html, READY_HEAD)).toBe(1);
    expect(count(html, MONEY_HEAD), "the money card is missing after go-live").toBe(1);
  });

  it("and not at all once there is nothing left to set up", () => {
    const html = render(view({ beforeGoLive: false, readiness: null }));
    expect(count(html, READY_HEAD)).toBe(0);
    expect(count(html, MONEY_HEAD)).toBe(1);
  });
});
