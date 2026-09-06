import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PayoutQueue as PayoutQueueData } from "@/app/ops/payout-data";

/**
 * THE SCREEN, ACTUALLY RENDERED.
 *
 * The rest of this repo pins UI with source scans, which is the right tool for
 * "does this file still call that" but cannot answer "does this draw". These
 * two questions have different answers: `markBatchesReturned` was imported by
 * nothing and a scan would have caught that, but a scan would NOT have caught
 * `returned.length` throwing on a queue that arrived without the field.
 *
 * `react-dom` is already a dependency, so this needs no jsdom and no testing
 * library — `renderToStaticMarkup` runs in the plain node environment the rest
 * of the suite uses. The three mocks below are the component's outside world
 * (a router, a toast, two server actions); nothing about the markup is faked.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/ops/payout-actions", () => ({
  markBatchesPaid: async () => ({ ok: true }),
  markBatchesReturned: async () => ({ ok: true }),
}));

const { PayoutQueue } = await import("./PayoutQueue");

const EMPTY: PayoutQueueData = {
  queuedCount: 0,
  queuedTotal: 0,
  exportedCount: 0,
  exportedTotal: 0,
  rows: [],
  owing: [],
  returned: [],
};

/** A batch that has been in a bank file and not yet closed out. */
const exportedRow = {
  id: "b-9",
  payee: "Harbor Dock Co.",
  kind: "monthly",
  net: 1200,
  status: "exported",
  created_at: "2027-01-31T00:00:00Z",
};

const cameBack = {
  id: "b-1",
  payee: "Twin Lakes Crew",
  net: 640,
  returnedAt: "2027-02-04T00:00:00Z",
  reason: "R02 account closed",
};

const draw = (q: Partial<PayoutQueueData>) =>
  renderToStaticMarkup(<PayoutQueue queue={{ ...EMPTY, ...q }} />);

describe("the render harness is drawing the real screen", () => {
  it("draws something recognisable", () => {
    // Without this, every assertion below is green against an empty string.
    const html = draw({});
    expect(html.length, "PayoutQueue rendered nothing — this file measures nothing")
      .toBeGreaterThan(400);
    expect(html).toContain("Payout queue");
  });
});

describe("a payout the bank sent back", () => {
  it("names the crew, the money, the day and what the bank said", () => {
    const html = draw({ returned: [cameBack] });
    expect(html).toContain("Twin Lakes Crew");
    expect(html).toContain("$640");
    // THIS ASSERTION FOUND A BUG, and is the reason prettyDate now pins a zone.
    // 2027-02-04T00:00:00Z is 7pm on Feb 3 in Indiana, and it rendered as
    // whatever day the machine running the test happened to be in — "Feb 3"
    // here, "Feb 4" on a UTC build box. Both the batch dates and the return
    // dates on this screen were viewer-dependent, on the screen somebody
    // reconciles against a bank statement.
    expect(html, "the date is being rendered in the viewer's zone again")
      .toContain("Feb 3, 2027");
    // The reason is the only thing that says what to fix. `source_note` was
    // written by three paths and rendered nowhere for months; not again.
    expect(html).toContain("R02 account closed");
  });

  it("shows the same day no matter what zone the reader is in", () => {
    // The assertion above is only meaningful if it is machine-independent.
    // TZ is read by Intl at format time, so this proves the pin holds rather
    // than that the box running the suite happens to agree with it.
    const original = process.env.TZ;
    try {
      for (const zone of ["UTC", "America/Phoenix", "Australia/Sydney"]) {
        process.env.TZ = zone;
        expect(draw({ returned: [cameBack] }), `wrong day when the reader is in ${zone}`)
          .toContain("Feb 3, 2027");
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it("keeps the instruction on the screen instead of in a toast", () => {
    // The action's success message says "fix the crew's bank details first",
    // and Toast.tsx clears it after 3800ms. The money re-batches to the SAME
    // account, so that sentence has to outlive the toast or it bounces again.
    const html = draw({ returned: [cameBack] });
    expect(html).toMatch(/bounce again|rings them first/);
  });

  it("says nothing at all when nothing has come back", () => {
    // A standing "payouts came back" card on a clean month is an alarm that
    // means nothing, which is how people learn to stop reading alarms.
    const html = draw({});
    expect(html).not.toContain("came back from the bank");
  });

  it("survives a queue that arrives with no returned list", () => {
    // The failure a source scan cannot see: `returned.length` on undefined.
    // TypeScript forbids it; a stale cached payload does not.
    const stale = { ...EMPTY } as Partial<PayoutQueueData>;
    delete (stale as Record<string, unknown>).returned;
    expect(() => draw(stale)).not.toThrow();
  });
});

describe("recording the return", () => {
  it("offers the control on a batch that has actually been in a file", () => {
    const html = draw({ rows: [exportedRow], exportedCount: 1, exportedTotal: 1200 });
    expect(html).toMatch(/Record .*returned/);
    expect(html).toContain("What the bank gave back");
  });

  it("refuses to submit before the reason is typed", () => {
    // The action refuses a blank reason. If the button submits anyway, that
    // refusal becomes an error message instead of a control that is plainly off.
    const html = draw({ rows: [exportedRow], exportedCount: 1, exportedTotal: 1200 });
    // `[\s\S]` rather than `.` with the /s flag: vitest transpiles /s happily
    // and tsc refuses it at this target, so the suite went green while the
    // build was broken.
    const button =
      html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Record(?:(?!<\/button>)[\s\S])*<\/button>/)?.[0] ?? "";
    expect(button, "the Record returned button was not found — this assertion is empty")
      .toContain("Record");
    expect(button).toContain("disabled");
  });

  it("does not offer it when nothing has been exported", () => {
    // Nothing has been anywhere, so nothing can have come back. The action
    // refuses a queued batch too; this stops the question being asked.
    const html = draw({ rows: [{ ...exportedRow, status: "queued" }], queuedCount: 1, queuedTotal: 1200 });
    expect(html).not.toMatch(/Record .*returned/);
  });
});
