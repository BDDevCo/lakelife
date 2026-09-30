import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeNightlyDigest , type DigestSections } from "@/lib/digest-render";

/**
 * A COMPLETE, SILENT DIGEST TO BUILD ON. composeNightlyDigest reads every
 * section it knows about, so a partial literal type-checks and then throws on
 * the first one it is missing. digest-render.test.ts keeps the same base for
 * the same reason; this is that object, not a new convention.
 */
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


/**
 * THE ONE LINE THAT WOULD HAVE CAUGHT JULY IN JULY, ON THE OTHER CHANNEL.
 *
 * Email is now the only door that reaches anybody, and it has exactly the
 * shape the text channel had: `sendEmail` returns when Resend accepts, and
 * whether a mailbox took it is decided later by somebody else. Two things are
 * pinned here — that the renderer says the right thing in each world, and that
 * the nightly actually fills the section.
 */

const counts = (over: Partial<{ attempted: number; delivered: number; failed: number; waiting: number }> = {}) => ({
  attempted: 10,
  delivered: 9,
  failed: 1,
  waiting: 0,
  ...over,
});

describe("the email delivery line", () => {
  it("a failed read says so, and says there is no second copy to check instead", () => {
    const html = composeNightlyDigest({ ...quiet, emailDelivery: { day: null, week: null, verdicts: null } });
    // OUR PROSE IS NOT ESCAPED — only values somebody typed are. The sibling
    // assertions in digest-render.test.ts pin the same rule from the other
    // side (not.toContain("&#39;") on a line of our own words), so expecting
    // an entity here would have made the two files disagree about the rule.
    expect(html).toContain("Email — we couldn't check");
    expect(html).toContain("no equivalent");
    expect(html).not.toContain("0 of 0");
  });

  it("NO RECEIPT AT ALL IS NOT A QUIET NIGHT — this email is itself a send", () => {
    const html = composeNightlyDigest({ ...quiet, emailDelivery: { day: counts({ attempted: 0, delivered: 0, failed: 0, waiting: 0 }), week: counts({ attempted: 0, delivered: 0, failed: 0, waiting: 0 }), verdicts: 0 },
    });
    expect(html).toContain("No email receipt has been filed this week");
    expect(html).toContain("itself a send");
  });

  it("rows with no verdict shouts about the RECORD, and never claims nothing arrived", () => {
    const html = composeNightlyDigest({ ...quiet, emailDelivery: { day: counts({ attempted: 3, delivered: 0, failed: 0, waiting: 3 }), week: counts({ attempted: 12, delivered: 0, failed: 0, waiting: 12 }), verdicts: 0 },
    });
    expect(html).toContain("NO EMAIL DELIVERY IS BEING RECORDED");
    // The reader is holding an email. Claiming none arrive would be a sentence
    // the data flatly contradicts.
    expect(html).toContain("at least one email does arrive");
    expect(html).not.toContain("NO EMAIL IS ARRIVING");
  });

  it("verdicts arriving with none delivered is the other shout", () => {
    const html = composeNightlyDigest({ ...quiet, emailDelivery: {
        day: counts({ attempted: 2, delivered: 0, failed: 2, waiting: 0 }),
        week: counts({ attempted: 9, delivered: 0, failed: 9, waiting: 0 }),
        verdicts: 9,
        reasons: [{ text: "mailbox does not exist", count: 9 }],
      },
    });
    expect(html).toContain("NO EMAIL IS ARRIVING");
    expect(html).toContain("mailbox does not exist");
  });

  it("a healthy week is one dull line with both numbers, and no percentage", () => {
    const html = composeNightlyDigest({ ...quiet, emailDelivery: { day: counts({ attempted: 4, delivered: 4, failed: 0, waiting: 0 }), week: counts({ attempted: 20, delivered: 19, failed: 1, waiting: 0 }), verdicts: 20 },
    });
    expect(html).toContain("Email delivered");
    expect(html).toContain("4 of 4 confirmed delivered today");
    expect(html).toContain("19 of 20 over the week");
    expect(html).not.toContain("%");
    expect(html).not.toContain("🚨");
  });

  it("an unrecognised status is named in the email too", () => {
    const html = composeNightlyDigest({ ...quiet, emailDelivery: { day: counts(), week: counts(), verdicts: 10, unknown: ["email.opened"] },
    });
    expect(html).toContain("email.opened");
    expect(html).toContain("counted as still waiting");
  });

  it("no section at all when the digest was not given one", () => {
    expect(composeNightlyDigest({ ...quiet, })).toContain("Quiet night");
  });
});

describe("the nightly actually asks the question", () => {
  // A section nothing fills is a column with no writer. The renderer above
  // could be perfect and the digest would still never mention email.
  const code = readFileSync(join(process.cwd(), "src/lib/automation.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("reads the email receipts and hands them to the digest", () => {
    expect(code).toMatch(/emailDeliveryReport\(\)/);
    expect(code).toMatch(/emailDelivery:\s*\{/);
    expect(code).toMatch(/verdicts:\s*mailDelivery\.verdicts/);
  });

  it("names a read it could not make as something that needs a look", () => {
    expect(code).toMatch(/noteRead\(\s*"whether today's email reached anybody"/);
  });

  it("proves this scan can fail", () => {
    const stripped = code.replace(/emailDeliveryReport\(\)/g, "nothingAtAll()");
    expect(stripped).not.toMatch(/emailDeliveryReport\(\)/);
  });
});

describe("the console reads it too, because the digest cannot report its own door", () => {
  const ops = readFileSync(join(process.cwd(), "src/app/ops/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("loads the email health and renders the panel", () => {
    expect(ops).toMatch(/getEmailHealth\(\)/);
    expect(ops).toMatch(/<OpsEmailHealth verdict=\{emailVerdict\(emailHealth\)\} \/>/);
  });

  it("proves this scan can fail", () => {
    expect(ops.replace(/getEmailHealth\(\)/g, "nothingAtAll()")).not.toMatch(/getEmailHealth\(\)/);
  });
});
