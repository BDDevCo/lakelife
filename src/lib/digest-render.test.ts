import { describe, it, expect } from "vitest";
import { composeNightlyDigest, type DigestSections } from "@/lib/digest-render";

const quiet: DigestSections = {
  learning: { changes: [] },
  autoPricing: { changes: [] },
  disputeSweep: { fired: 0, escalated: 0 },
  escalatedDisputes: [],
  lakesBorn: [],
  routes: {},
  aiAutoReplies: 0,
  aiReplyTexts: [],
  gapSla: { alerted: 0 },
};

describe("composeNightlyDigest — quiet night", () => {
  it("says exactly that and nothing else", () => {
    expect(composeNightlyDigest(quiet)).toBe("<p>Quiet night — nothing needed a human. 🌊</p>");
  });
});

describe("composeNightlyDigest — money movement is never invisible", () => {
  it("quiet-closes (held money released in crew's favor) get their own sweep line", () => {
    const html = composeNightlyDigest({ ...quiet, disputeSweep: { fired: 0, escalated: 0, quietCloses: 2 } });
    expect(html).toContain("2 closed in the crew's favor (customer went quiet)");
  });
  it("reconciled lost-👎 recoveries are reported", () => {
    const html = composeNightlyDigest({ ...quiet, disputeSweep: { fired: 0, escalated: 0, reconciled: 1 } });
    expect(html).toContain("1 lost 👎 recovered into fresh disputes");
  });
  it("fired and escalated still render together with the new counters", () => {
    const html = composeNightlyDigest({ ...quiet, disputeSweep: { fired: 3, escalated: 1, quietCloses: 1, reconciled: 2 } });
    expect(html).toContain("3 auto-refunded");
    expect(html).toContain("1 escalated");
    expect(html).toContain("1 closed in the crew's favor");
    expect(html).toContain("2 lost 👎s recovered");
  });
});

describe("composeNightlyDigest — AI auto-replies show their TEXT, not just a count", () => {
  it("renders each sampled reply body, HTML-escaped", () => {
    const html = composeNightlyDigest({
      ...quiet,
      aiAutoReplies: 2,
      aiReplyTexts: ["Your mow is set for Friday.", "Thanks — receipt's in your <b>portal</b>."],
    });
    expect(html).toContain("2 customer messages got an AI auto-reply");
    expect(html).toContain("Your mow is set for Friday.");
    expect(html).toContain("&lt;b&gt;portal&lt;/b&gt;"); // escaped, never raw HTML from a model
  });
  it("a count with no sampled texts still renders the count alone", () => {
    const html = composeNightlyDigest({ ...quiet, aiAutoReplies: 1, aiReplyTexts: [] });
    expect(html).toContain("1 customer message got an AI auto-reply");
    expect(html).not.toContain("<ul>");
  });
});
