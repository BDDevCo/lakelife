import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { REVENUE_STREAMS, type StreamStatus } from "@/app/park/revenue-streams";

/**
 * EVERY STREAM'S "NEXT" LINE HAS A DOOR, AND THE DOOR'S WORD IS THE PAGE'S.
 *
 * `fees` had no WHERE_TO_GO entry, so "Add a fee" was a Next with nowhere to
 * go; `cost_recovery` said "Costs" for a page whose title is "Costs & fees".
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { err: () => {} }) }));
vi.mock("@/app/park/stream-actions", () => ({ saveRevenueStreams: async () => ({ ok: true }) }));

const { ParkStreams } = await import("./ParkStreams");

const status = (stream: StreamStatus["stream"], missing: string[]): StreamStatus =>
  ({ stream, on: true, ready: false, missing, count: 0, coming: 0 });

const render = (statuses: StreamStatus[]) => renderToStaticMarkup(<ParkStreams parkId="p1" statuses={statuses} />);

describe("ParkStreams doors", () => {
  it("fees: 'Add a fee' links to Costs & fees", () => {
    const html = render([status("fees", ["Add a fee"])]);
    expect(html).toContain("Add a fee");
    expect(html).toContain('<a href="/park/costs">Costs &amp; fees</a>');
  });
  it("cost recovery: the page's own title, not 'Costs'", () => {
    const html = render([status("cost_recovery", ["Enter a bill"])]);
    expect(html).toContain('<a href="/park/costs">Costs &amp; fees</a>');
    expect(html).not.toMatch(/>Costs<\/a>/);
  });
  it("every stream, switched on with a missing line, renders exactly one door", () => {
    for (const s of REVENUE_STREAMS) {
      const html = render([status(s, ["Something to do"])]);
      const doors = html.match(/<a href="\/park\/[a-z]+">/g) ?? [];
      expect(doors.length, `${s}: expected one door, got ${doors.length}`).toBe(1);
    }
  });
});
