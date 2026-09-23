import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE CHECKLIST STATED A FACT THE PANEL ABOVE IT HAD JUST SAID IT COULD NOT READ.
 *
 * "Has a text reached a handset?" has five answers and only one of them is no.
 * The delivery panel on /ops/texting branched on all of them, in words. The
 * go-live checklist at the foot of the SAME PAGE collapsed them into one
 * boolean — `Boolean(log.window && log.window.delivered > 0)` — and its false
 * arm then asserted "Twilio's log shows nothing delivered in the window
 * above", which is a statement about a log we may never have read.
 *
 * It bites on precisely the occasion the page exists for: the reload right
 * after the Messaging Service SID is set. If Twilio is unreachable at that
 * moment the panel warns him correctly, the checklist tells him the log showed
 * nothing, and he goes back to Vercel to fix a setting that was never wrong.
 *
 * The branch now lives in ONE place and both halves of the page read it.
 */

vi.mock("server-only", () => ({}));

const { deliveryVerdict } = await import("@/app/ops/sms-health");
type Health = Parameters<typeof deliveryVerdict>[0];

/** A health read with nothing on it but the fields the verdict looks at. */
const health = (over: Partial<Health>): Health => ({
  configured: true,
  window: null,
  reasons: [],
  oldest: null,
  newest: null,
  lastAttempt: null,
  ...over,
});

describe("five worlds, and only one of them is a no", () => {
  it("no credentials is UNASKED — nobody looked", () => {
    expect(deliveryVerdict(health({ configured: false }))).toEqual({ state: "unasked" });
  });

  it("a lookup that failed is UNREADABLE — not a no", () => {
    // getSmsHealth returns a null window on a thrown lookup, and says in its
    // own contract that it is never zero, because zero reads as "all fine".
    expect(deliveryVerdict(health({ configured: true, window: null, error: "ETIMEDOUT" })))
      .toEqual({ state: "unreadable" });
  });

  it("an empty log is NOTHING-SENT — which is not 'nothing arrived'", () => {
    expect(deliveryVerdict(health({ window: { sent: 0, delivered: 0, failed: 0 } })))
      .toEqual({ state: "nothing-sent" });
  });

  it("messages out and none back is NONE-DELIVERED — the only real no", () => {
    expect(deliveryVerdict(health({ window: { sent: 81, delivered: 0, failed: 66 } })))
      .toEqual({ state: "none-delivered", sent: 81, delivered: 0 });
  });

  it("one that landed is DELIVERED, and carries the count the screen prints", () => {
    expect(deliveryVerdict(health({ window: { sent: 12, delivered: 3, failed: 1 } })))
      .toEqual({ state: "delivered", sent: 12, delivered: 3 });
  });

  it("the four non-yes states are distinct — the whole defect was calling them one", () => {
    const states = [
      health({ configured: false }),
      health({ window: null }),
      health({ window: { sent: 0, delivered: 0, failed: 0 } }),
      health({ window: { sent: 5, delivered: 0, failed: 5 } }),
    ].map((h) => deliveryVerdict(h).state);
    expect(new Set(states).size).toBe(4);
  });
});

/**
 * AND THE PAGE READS IT — BOTH HALVES OF IT.
 *
 * A helper nothing calls enforces nothing. Comments are stripped first, so the
 * prose explaining the rule cannot satisfy the assertions below.
 */
const PAGE = readFileSync(fileURLToPath(new URL("./texting/page.tsx", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the panel and the checklist cannot disagree again", () => {
  it("scans the real page, with its comments gone", () => {
    expect(PAGE.length).toBeGreaterThan(2000);
    expect(PAGE).toMatch(/function WhatIsStillTrue/);
    expect(PAGE, "the comment strip works rather than emptying the file").not.toMatch(/THE HONEST FOOTER/);
  });

  it("both the panel and the checklist take the same branch", () => {
    const calls = [...PAGE.matchAll(/deliveryVerdict\(/g)];
    expect(calls.length, "one call in DeliveryLog, one in WhatIsStillTrue").toBeGreaterThanOrEqual(2);
    const footer = PAGE.slice(PAGE.indexOf("function WhatIsStillTrue"));
    expect(footer).toMatch(/deliveryVerdict\(setup\.log\)/);
  });

  it("the old collapsed boolean is gone", () => {
    expect(PAGE).not.toMatch(/window\.delivered > 0/);
    expect(PAGE).not.toMatch(/const proven/);
  });

  it("'nothing delivered' is said only on the arm that actually read the log", () => {
    const sentence = /shows nothing delivered in the window above/g;
    expect([...PAGE.matchAll(sentence)], "said once, not once per world").toHaveLength(1);
    const at = PAGE.search(sentence);
    // The 240 characters before it are the condition that guards it.
    expect(PAGE.slice(Math.max(0, at - 240), at)).toMatch(/"none-delivered"/);
    // And the three non-answers say they are unanswered, not no.
    expect([...PAGE.matchAll(/Unanswered —/g)]).toHaveLength(3);
  });
});
