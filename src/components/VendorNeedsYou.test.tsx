import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>{children}</a>
  ),
}));

const { VendorNeedsYou } = await import("./VendorNeedsYou");

const TODAY = "2026-08-19";
const held = (over: Partial<Record<string, unknown>> = {}) => ({
  disputeId: "d1", jobId: "j1", service: "Weekly mow", where: "Blue Heron",
  respondBy: "2026-08-21T17:00:00Z", token: "tok1", ...over,
});
const render = (data: Partial<Parameters<typeof VendorNeedsYou>[0]["data"]>) =>
  renderToStaticMarkup(<VendorNeedsYou data={{ held: [], pausedLakes: [], unpriced: [], ...data }} today={TODAY} />);

describe("quiet when there is nothing", () => {
  it("renders nothing at all for a crew with nothing waiting", () => {
    expect(render({ held: [], pausedLakes: [] })).toBe("");
  });
});

describe("a held job", () => {
  it("names the job, the place, the deadline and all three answers", () => {
    const html = render({ held: [held()], pausedLakes: [] });
    expect(html).toContain("Weekly mow");
    expect(html).toContain("Blue Heron");
    expect(html).toContain("your pay for it is on hold");
    expect(html).toContain("Answer by");
    expect(html).toContain('href="/d/tok1/fix"');
    expect(html).toContain('href="/d/tok1/verify"');
    expect(html).toContain('href="/d/tok1/talk"');
  });

  it("says the window has closed rather than showing a deadline in the past", () => {
    const html = render({ held: [held({ respondBy: "2026-08-15T17:00:00Z" })], pausedLakes: [] });
    expect(html).toContain("window to answer has closed");
    expect(html).not.toContain("Answer by");
  });

  it("omits the clock entirely when no deadline was set", () => {
    const html = render({ held: [held({ respondBy: null })], pausedLakes: [] });
    expect(html).not.toContain("Answer by");
    expect(html).not.toContain("has closed");
  });

  it("offers a route instead of dead buttons when there is no token", () => {
    const html = render({ held: [held({ token: null })], pausedLakes: [] });
    expect(html).not.toContain("href=\"/d/");
    expect(html).toContain("Open the job to answer this one");
  });

  it("no sentence loses the space before it — the 'nota list' bug", () => {
    for (const h of [held(), held({ respondBy: "2026-08-15T17:00:00Z" })]) {
      const html = render({ held: [h], pausedLakes: [] });
      expect(html).not.toMatch(/on hold\.(?:<!-- -->)?[A-Z]/);
      expect(html).toMatch(/on hold\.(?:<!-- -->)? /);
    }
  });
});

describe("a paused lake", () => {
  it("names the lake, the date it lifts, and that nothing is required", () => {
    const html = render({ held: [], pausedLakes: [{ lake: "Big Long Lake", liftsOn: "2026-09-11" }] });
    expect(html).toContain("Big Long Lake is paused");
    expect(html).toContain("September 11");
    expect(html).toContain("nothing to do");
    // The reassurance is the point: one lake paused is not a shutdown.
    expect(html).toContain("your other lakes are unaffected");
  });

  it("keeps the spaces around the date", () => {
    const html = render({ held: [], pausedLakes: [{ lake: "Pretty Lake", liftsOn: "2026-09-11" }] });
    expect(html).toMatch(/comes back on(?:<!-- -->)? (?:<!-- -->)?September 11/);
  });
});

describe("a failed check never passes for 'nothing needs you'", () => {
  it("still renders, and says so, when both lists are empty", () => {
    const html = render({ held: [], pausedLakes: [], checkFailed: true });
    expect(html).not.toBe("");
    expect(html).toContain("couldn&#x27;t check this just now");
    expect(html).toContain("route below is unaffected");
  });
});
