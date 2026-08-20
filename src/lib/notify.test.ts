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

describe("no copy sends anybody to a phone line that does not exist", () => {
  // LakeLife publishes no number — not in the top bar, not in a footer, not in
  // any message. Thirteen user-facing strings said "call us" anyway, including
  // the security alert on a changed payout account, whose ONE instruction was
  // an action the reader could not take. Customers have /messages, which is in
  // OwnerNav and reaches ops; that is what the copy names now.
  //
  // "Ring the office" is DIFFERENT and stays: in the park module that is the
  // park owner's own office, in his voice, to his own residents, with his
  // address printed beside it. His number is his to give.
  const appFiles = [
    "../app/requests/actions.ts",
    "../app/book/storage/actions.ts",
    "../app/park/actions.ts",
    "../app/vendor/bank-actions.ts",
    "./tips.ts",
    "./packages.ts",
  ];

  it("no user-facing string tells them to call us", () => {
    const bad: string[] = [];
    for (const f of appFiles) {
      const s = stripComments(read(f));
      for (const m of s.matchAll(/"[^"\n]*\b(call us|give us a call|give us a shout|phone us)\b[^"\n]*"/gi)) {
        bad.push(`${f}: ${m[0].slice(0, 80)}`);
      }
      // No newlines in the character classes: a greedy template-literal match
      // otherwise swallows whole functions and reports them as copy.
      for (const m of s.matchAll(/`[^`\n]*\b(call us|give us a call|give us a shout|phone us)\b[^`\n]*`/gi)) {
        bad.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(bad, `copy instructing an action the reader cannot take:\n${bad.join("\n")}`).toEqual([]);
  });

  it("the payout-change alert names what they CAN do", () => {
    // A hijacked session rerouting somebody's money is the worst thing this
    // alert exists for, and "call us immediately" was the whole instruction.
    const s = read("../app/vendor/bank-actions.ts");
    expect(s).toMatch(/change your password now and reply to the email/);
    expect(s).toMatch(/reset-password/);
  });

  it("and does not reassure them about money it has not checked", () => {
    // A first draft ended "Nothing has been paid out to the new account yet."
    // True when sent, unchecked, and able to stop being true before it is read.
    const s = stripComments(read("../app/vendor/bank-actions.ts"));
    expect(s).not.toMatch(/Nothing has been paid out/);
    expect(s).toMatch(/The sooner you tell us, the more we can stop\./);
  });

  it("the park's own reminder still points at the park's office", () => {
    // Not ours to rewrite: the park owner is "us" there, and the address is
    // printed next to it.
    const s = read("../app/park/reminder-actions.ts");
    expect(s).toMatch(/Drop it at the office/);
  });
});
