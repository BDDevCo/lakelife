import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ---------------------------------------------------------------------------
// AUDIT BUG 10a: "The digest says 'Quiet night' on nights money moved."
// DigestSections had nine keys and not one could carry a payout batch, a
// matured referral credit, a collected cancellation fee, or a reconciled
// refund — the nightly ran all of those, returned them in an HTTP response
// nobody reads, and dropped them. Month-end, the night the largest sum of the
// month leaves the account, is the night most likely to read as quiet.
// ---------------------------------------------------------------------------
describe("composeNightlyDigest — the night money moved is never a quiet night (audit bug 10a)", () => {
  it("a month-end referral payout batch is reported, with the dollars", () => {
    const html = composeNightlyDigest({ ...quiet, referralPayouts: { beneficiaries: 3, total: 412.5 } });
    expect(html).not.toContain("Quiet night");
    expect(html).toContain("$412.50");
    expect(html).toContain("3 ");
  });
  it("crew month-end payout batches are reported, with the dollars", () => {
    const html = composeNightlyDigest({ ...quiet, crewPayouts: { batches: 7, total: 18_240.75 } });
    expect(html).not.toContain("Quiet night");
    expect(html).toContain("$18240.75");
    expect(html).toContain("7 ");
  });
  it("matured referral earnings granted as credits are reported", () => {
    const html = composeNightlyDigest({ ...quiet, referralCredits: { granted: 4, total: 100 } });
    expect(html).not.toContain("Quiet night");
    expect(html).toContain("$100.00");
  });
  it("collected cancellation fees are reported", () => {
    const html = composeNightlyDigest({ ...quiet, cancellationFees: { collected: 2, total: 47.5 } });
    expect(html).not.toContain("Quiet night");
    expect(html).toContain("$47.50");
  });
  it("reconciled refunds are reported (cash the machine healed on its own)", () => {
    const html = composeNightlyDigest({ ...quiet, refundsReconciled: { orphansCleared: 1, flipsCompleted: 2 } });
    expect(html).not.toContain("Quiet night");
    expect(html).toContain("2");
  });
  it("all the money lines land in ONE section, in one email", () => {
    const html = composeNightlyDigest({
      ...quiet,
      referralPayouts: { beneficiaries: 3, total: 412.5 },
      crewPayouts: { batches: 7, total: 18_240.75 },
      referralCredits: { granted: 4, total: 100 },
      cancellationFees: { collected: 2, total: 47.5 },
      refundsReconciled: { orphansCleared: 1, flipsCompleted: 2 },
    });
    expect(html.match(/<h3>Money moved/g) ?? []).toHaveLength(1);
  });
  it("a genuinely quiet money night stays quiet — zeros never manufacture a section", () => {
    const html = composeNightlyDigest({
      ...quiet,
      referralPayouts: { beneficiaries: 0, total: 0 },
      crewPayouts: { batches: 0, total: 0 },
      referralCredits: { granted: 0, total: 0 },
      cancellationFees: { collected: 0, total: 0 },
      refundsReconciled: { orphansCleared: 0, flipsCompleted: 0 },
    });
    expect(html).toBe("<p>Quiet night — nothing needed a human. 🌊</p>");
  });
});

// AUDIT BUG 10b: the AI section was gated solely on aiAutoReplies > 0, but
// that number comes from a head-count query via `aiCount ?? 0` while the texts
// come from a different query. A null count zeroed the gate while the texts
// survived — and the safety net (seeing what the machine promised a customer
// overnight) silently disappeared.
describe("composeNightlyDigest — AI replies survive a null count (audit bug 10b)", () => {
  it("renders the texts when the count came back 0 but texts exist", () => {
    const html = composeNightlyDigest({
      ...quiet,
      aiAutoReplies: 0,
      aiReplyTexts: ["We'll have someone out Tuesday and there's no charge for the visit."],
    });
    expect(html).toContain("AI auto-replies");
    expect(html).toContain("no charge for the visit");
  });
  it("falls back to the number of texts it can actually show", () => {
    const html = composeNightlyDigest({ ...quiet, aiAutoReplies: 0, aiReplyTexts: ["a", "b"] });
    expect(html).toContain("2 customer messages got an AI auto-reply");
  });
  it("no count and no texts is still silence", () => {
    expect(composeNightlyDigest({ ...quiet, aiAutoReplies: 0, aiReplyTexts: [] })).toBe(
      "<p>Quiet night — nothing needed a human. 🌊</p>",
    );
  });
});

describe("a night where something broke never reads as a quiet one", () => {
  // The nightly guarded all 27 steps and then dropped the failures, so a night
  // where the charge run died produced the same email as a clean night —
  // often literally "Quiet night — nothing needed a human."
  it("names the step and the error", () => {
    const html = composeNightlyDigest({
      ...quiet,
      failures: [{ step: "runCharges", error: "connection terminated" }],
    });
    expect(html).toContain("1 step failed tonight");
    expect(html).toContain("runCharges");
    expect(html).toContain("connection terminated");
    expect(html).not.toContain("Quiet night");
  });

  it("puts the failures ABOVE everything that went right", () => {
    const html = composeNightlyDigest({
      ...quiet,
      failures: [{ step: "routes", error: "boom" }],
      crewPayouts: { batches: 3, total: 4100 },
    });
    expect(html.indexOf("failed tonight")).toBeLessThan(html.indexOf("Crew month-end payouts"));
  });

  it("pluralises honestly", () => {
    const html = composeNightlyDigest({
      ...quiet,
      failures: [{ step: "a", error: "x" }, { step: "b", error: "y" }],
    });
    expect(html).toContain("2 steps failed tonight");
  });

  it("escapes an error message rather than pasting it into the HTML", () => {
    const html = composeNightlyDigest({
      ...quiet,
      failures: [{ step: "x", error: "<script>alert(1)</script>" }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("homes with no lake are never invisible", () => {
  // Crew imports minted these silently. A null lake skips the crew geo gate,
  // unscopes the calendar, makes ice-out and the pull deadline enforce
  // nothing, and hides the household from the freeze warning entirely.
  it("says how many and what it costs them", () => {
    const html = composeNightlyDigest({ ...quiet, homesWithNoLake: 3 });
    expect(html).toContain("3 homes have no lake set");
    expect(html).toMatch(/freeze warning/);
    expect(html).not.toContain("Quiet night");
  });

  it("stays quiet when there are none", () => {
    expect(composeNightlyDigest({ ...quiet, homesWithNoLake: 0 }))
      .toBe("<p>Quiet night — nothing needed a human. 🌊</p>");
  });

  it("reads properly for a single home", () => {
    expect(composeNightlyDigest({ ...quiet, homesWithNoLake: 1 }))
      .toContain("1 home has no lake set");
  });
});

describe("the composer's own prose, versus a value it was handed", () => {
  /**
   * THE DISTINCTION THAT GOT MUDDLED, pinned so it cannot drift again.
   *
   * These sections are written in the tag, which escapes every INTERPOLATED
   * value. The function's own literal words are not values and stay literal —
   * "the crew's favor" keeps its apostrophe. A previous pass briefly joined
   * those sentences into a single interpolated string, which escaped our own
   * prose into `crew&#39;s`: harmless to a reader, but it made this file the
   * only one that treated its own words as untrusted, and it produced a
   * comment elsewhere asserting the opposite of what the code did.
   */
  it("keeps our own apostrophes as apostrophes", () => {
    const out = composeNightlyDigest({
      ...quiet, disputeSweep: { fired: 0, escalated: 0, quietCloses: 2 },
    });
    expect(out).toContain("the crew's favor");
    expect(out).not.toContain("crew&#39;s");
  });

  it("does the same for the refund sentences beside them", () => {
    // The construct twelve lines down was left as a plain join and so was the
    // one literal in the file that DID escape. Same shape, same treatment.
    const out = composeNightlyDigest({
      ...quiet, refundsReconciled: { orphansCleared: 2, flipsCompleted: 1 },
    } as DigestSections);
    expect(out).toContain("(invoice flipped, referrals voided); 2 stranded claims cleared");
    expect(out).not.toContain("&#39;");
    expect(out).not.toContain("&amp;");
  });

  it("still escapes a value somebody typed", () => {
    // The whole point of the tag. A service name is data, not our prose.
    const out = composeNightlyDigest({
      ...quiet,
      autoPricing: { changes: [{ service: `Mowing <b>"big"</b> & trim`, label: "up" }] },
    } as DigestSections);
    expect(out).toContain("&lt;b&gt;");
    expect(out).not.toContain('<b>"big"');
    // And readable once a mail client has drawn it.
    const shown = out.replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    expect(shown).toContain(`Mowing <b>"big"</b> & trim`);
  });

  it("builds both prose arrays the same way — the only guard that can catch it", () => {
    // MUTATION-HONEST NOTE. Reverting the refund array to a plain joined
    // string does NOT fail any behavioural test above, because those two
    // sentences happen to contain no apostrophe, ampersand or quote. That is
    // exactly the defect: it renders correctly today by luck, and the first
    // person to write "the crew's refund" there gets the only literal in the
    // file that silently escapes. So the CONSTRUCT is pinned instead.
    const src = readFileSync(
      fileURLToPath(new URL("./digest-render.ts", import.meta.url)), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src, "a prose array went back to string[] and will escape our own words")
      .not.toMatch(/const bits:\s*string\[\]/);
    // And the scanner still finds the arrays it is judging.
    expect(src.match(/const bits:\s*RawHtml\[\]/g) ?? []).toHaveLength(2);
  });
});
