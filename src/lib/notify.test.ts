import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * A MESSAGE MUST NOT CLAIM WHAT THE CODE CANNOT BACK.
 *
 * SMS has delivered 0 of 81 since 19 July, and it was the only channel for
 * things that cost people money — a crew's pay held with a clock running, a
 * fall pier removal cancelled, a late fee charged. 41 call sites now go to
 * every open door via notify().
 *
 * THE MISTAKE THIS FILE EXISTS FOR IS MINE. Writing the brief for that
 * conversion I said: never state a fact the SMS did not carry. Then, in the
 * one site I converted by hand, I wrote two:
 *
 *   "answering is what releases it"   — it does not. releaseHeldPayout runs
 *                                       on a RESOLUTION, not on a reply.
 *   "if nobody answers, this decides   — it does not. decideDisputeOutcome
 *    itself against you"                returns `escalate`, to a human.
 *
 * Both were about a crew's money, in the fix for messages about a crew's
 * money. A reviewer caught them. These tests are what catches them next time.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Comments stripped, because a scan for a forbidden sentence otherwise finds
 * the comment explaining why it is forbidden — which is exactly what happened
 * the first time this ran, in the file that carries that explanation.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e) && !e.includes(".test.")) out.push(p);
  }
  return out;
}

describe("notify", () => {
  it("tries every door rather than falling back", () => {
    // A fallback would need to know SMS failed, and Twilio accepting a message
    // says nothing about a carrier delivering it — all 81 were accepted.
    const s = read("./notify.ts");
    expect(s).toMatch(/Promise\.allSettled/);
    expect(s).toMatch(/sendSms/);
    expect(s).toMatch(/sendEmail/);
  });

  it("distinguishes 'nobody to tell' from 'told nobody'", () => {
    // Different facts, different fixes: get an address, versus the send broke.
    const s = read("./notify.ts");
    expect(s).toMatch(/No way to reach them about/);
    expect(s).toMatch(/Couldn't tell them about/);
  });

  it("logs its own failure, because most callers discard the result", () => {
    // 44 of 47 call sites were `void sendSms(...)`. That is how a dead channel
    // stayed invisible for a month.
    const s = read("./notify.ts");
    expect(s).toMatch(/console\.error\(`\[notify\]/);
  });

  it("cannot throw at the action that triggered it", () => {
    const s = read("./notify.ts");
    expect(s).toMatch(/allSettled/);
    expect(s).toMatch(/status === "fulfilled"/);
  });
});

describe("the two claims that were invented", () => {
  it("no notification says answering releases held pay", () => {
    // It does not. Grep the whole tree — this must not come back anywhere.
    const bad: string[] = [];
    for (const f of sources(SRC)) {
      const s = stripComments(readFileSync(f, "utf8"));
      if (/answering is what releases/i.test(s)) bad.push(f.replace(SRC, "src/lib/"));
    }
    expect(bad, "releaseHeldPayout runs on a resolution, not on a reply").toEqual([]);
  });

  it("no notification promises silence decides against the crew", () => {
    const bad: string[] = [];
    for (const f of sources(SRC)) {
      const s = stripComments(readFileSync(f, "utf8"));
      if (/decides itself against you/i.test(s)) bad.push(f.replace(SRC, "src/lib/"));
    }
    expect(bad, "decideDisputeOutcome returns `escalate` — a human looks").toEqual([]);
  });

  it("the two copies of the pay-held notice still say the same thing", () => {
    // job-verdict.ts sends this notice; disputes.ts's sweep sends it again.
    // job-verdict's module header exists to stop the two drifting apart.
    const a = read("./disputes.ts");
    const b = read("./job-verdict.ts");
    for (const line of [
      "You have three ways to answer:",
      "Make it right — book a free return visit:",
      "It was done right — send them your photos:",
    ]) {
      expect(a, `disputes.ts lost: ${line}`).toContain(line);
      expect(b, `job-verdict.ts lost: ${line}`).toContain(line);
    }
  });
});

describe("an email must not promise a channel it isn't", () => {
  it("the crew-picked-up notice doesn't promise a text in its email body", () => {
    // The SMS says "we'll text you when it's done" — fine in a text, a promise
    // an email may not be able to keep for somebody with no mobile on file.
    const s = read("../app/vendor/open-actions.ts");
    const at = s.indexOf("the owner that a crew picked up their job");
    expect(at).toBeGreaterThan(-1);
    const block = s.slice(at, at + 1200);
    expect(block).toMatch(/body:/);
    expect(block).toMatch(/You'll hear from us when it's done/);
  });
});

describe("reachable means reachable, not phoned", () => {
  it("the rush blast no longer excludes a crew with only an email", () => {
    const s = read("../app/book/actions.ts");
    const at = s.indexOf("those crews' contact details");
    expect(at, "the guard was still .not(phone,is,null) after the send widened").toBeGreaterThan(-1);
    expect(s.slice(at, at + 400)).toMatch(/phone\.not\.is\.null,email\.not\.is\.null/);
  });
});
