import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verdictPage } from "./verdict-page";

/**
 * THE CUSTOMER'S ONLY CHANNEL FOR SAYING THE WORK WAS WRONG.
 *
 * `recordJobVerdict` answers with three states and both SMS doors read one
 * flag. A failed write and a second tap rendered the same sentence — "Your
 * feedback is already in" — so a homeowner who typed what went wrong, and
 * whose write failed, was told it had landed. Their complaint is gone, their
 * crew's pay hold never happened, their free return visit was never booked,
 * and they have no reason to try again.
 *
 * This is the project's "a failed read is not an empty one" class, pointed at
 * a WRITE, on the one tap a customer has.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("a failed write is never reported as a recorded one", () => {
  const failed = { ok: false, recorded: false, error: "We couldn't reach your job just now." };

  it("says it did not save, for both doors", () => {
    for (const v of ["issue", "good"] as const) {
      const p = verdictPage(failed, v);
      expect(p.ok, `${v}: a failed write rendered as success`).toBe(false);
      expect(p.retry, `${v}: nothing told them to try again`).toBe(true);
      expect(p.title + p.body).not.toMatch(/already in/i);
    }
  });

  it("tells them it is worth tapping again — the whole point", () => {
    const p = verdictPage(failed, "issue");
    expect(p.body).toMatch(/again/i);
    expect(p.body).toMatch(/nothing has been recorded|not.{0,12}recorded/i);
  });

  it("does not swallow what actually went wrong", () => {
    expect(verdictPage(failed, "issue").body).toContain("We couldn't reach your job just now.");
  });

  it("still copes when the failure carried no sentence", () => {
    const p = verdictPage({ ok: false, recorded: false }, "issue");
    expect(p.ok).toBe(false);
    expect(p.body.trim()).not.toBe("");
    expect(p.body).not.toMatch(/undefined|null/);
  });
});

describe("a second tap is the only thing called 'already in'", () => {
  it("says so, and reads as success", () => {
    const p = verdictPage({ ok: true, recorded: false }, "issue");
    expect(p.ok).toBe(true);
    expect(p.retry).toBe(false);
    expect(p.body).toMatch(/already in/i);
  });

  it("points a 👎 at the portal and does not point a 👍 there", () => {
    // Four copies of this sentence existed in three wordings. Only one carried
    // the where-to-go clause — and it only belongs on the complaint side.
    expect(verdictPage({ ok: true, recorded: false }, "issue").body).toMatch(/portal/i);
    expect(verdictPage({ ok: true, recorded: false }, "good").body).not.toMatch(/portal/i);
  });
});

describe("nobody is told a crew was told unless one was", () => {
  it("puts it on the crew when a dispute actually opened", () => {
    const p = verdictPage({ ok: true, recorded: true, disputeOpened: true }, "issue");
    expect(p.body).toMatch(/they've been told|it's on them/i);
    expect(p.body).toMatch(/never costs you/i);
  });

  it("does NOT, when no dispute was opened", () => {
    // A 👎 on a make-it-right visit resolves the original dispute instead of
    // opening a new one: no crew was texted and nothing is on them. The page
    // said "they've been told" anyway.
    const p = verdictPage({ ok: true, recorded: true, disputeOpened: false }, "issue");
    expect(p.body, "still claims the crew was told").not.toMatch(/they've been told|it's on them/i);
    expect(p.body, "does not say who is actually handling it").toMatch(/comes to us|we'll look/i);
    // The promise that holds in both branches must survive.
    expect(p.body).toMatch(/never costs you/i);
  });

  it("thanks a 👍 that landed", () => {
    const p = verdictPage({ ok: true, recorded: true }, "good");
    expect(p.ok).toBe(true);
    expect(p.body).toMatch(/credit/i);
  });
});

describe("both doors render this and neither keeps its own copy", () => {
  const issue = strip(read("../app/c/[token]/issue/route.ts"));
  const good = strip(read("../app/c/[token]/good/route.ts"));

  it("the 👎 door calls it", () => {
    expect(issue).toMatch(/verdictPage\s*\(/);
  });

  it("the 👍 door captures the result instead of discarding it", () => {
    // It was a bare `await recordJobVerdict(...)` — the outcome dropped on the
    // floor and the thank-you printed regardless.
    expect(good).toMatch(/(const|let)\s+\w+\s*=\s*await\s+recordJobVerdict/);
    expect(good).toMatch(/verdictPage\s*\(/);
  });

  it("neither door still hardcodes the sentence that lied", () => {
    for (const [name, src] of [["issue", issue], ["good", good]] as const) {
      expect(src, `${name} still carries its own copy`).not.toMatch(/Your feedback is already in/);
      expect(src, `${name} still hardcodes the crew claim`).not.toMatch(/They've been told and it's on them/);
    }
  });
});
