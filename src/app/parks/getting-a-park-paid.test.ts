import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * GETTING A PARK SET UP TO RECEIVE ITS OWN RENT.
 *
 * 0196 built the registry that records who money settles to, and the
 * capability that refuses to charge without one. **It shipped with no
 * writer.** Every park read as "nobody has been set up to receive it",
 * permanently, and no screen anywhere could change that.
 *
 * A gate that can never open is worse than no gate at all: the state before
 * was wrong and fixable, that one was correct and stuck. This is the door,
 * and these are the lines it must not cross.
 *
 * THE CHAIN IS PROVEN AGAINST PRODUCTION, inside a block that rolled back —
 * draft, submitted with the id, active with the rails and the last four, the
 * capability's own read seeing `active/true`, disabled, and a fresh ask
 * afterwards. Recording twice matched ZERO rows, so the action's own sentence
 * fires rather than a constraint name reaching a human.
 */

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = strip(readFileSync(
  fileURLToPath(new URL("./processor-actions.ts", import.meta.url)), "utf8"));

describe("who may do what", () => {
  it("THE OWNER MAY ASK, and only the owner", () => {
    // Asking commits the park to collecting money a particular way. A manager
    // runs the park day to day; this is the same line setParkLive draws.
    const at = src.indexOf("export async function startProcessorSetup");
    expect(at, "the ask is gone — repoint this").toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toMatch(/assertParkOwner\(parkId\)/);

    const guard = src.slice(src.indexOf("async function assertParkOwner"));
    expect(guard).toMatch(/assertMyPark\(parkId\)/);
    expect(guard).toMatch(/membership\.role !== "owner"/);
  });

  it("ONLY OPS MAY SAY IT IS LIVE", () => {
    // Marking a merchant active is what opens the money gate, and the facts
    // behind it come from the processor. A park owner who could write them
    // would be granting himself the ability to take residents' money with
    // nothing verified behind it — which is what 0196's REVOKE stops at the
    // database. The action layer has to draw the same line.
    for (const fn of [
      "recordProcessorSubmission", "activateProcessorAccount",
      "disableProcessorAccount", "getProcessorQueue",
    ]) {
      const at = src.indexOf(`export async function ${fn}`);
      expect(at, `${fn} is gone — repoint this`).toBeGreaterThan(-1);
      expect(src.slice(at, at + 260), `${fn} does not assert ops`)
        .toMatch(/await assertOps\(\)/);
    }
  });

  it("and the owner's own door never touches a capability or a status", () => {
    const ask = src.slice(
      src.indexOf("export async function startProcessorSetup"),
      src.indexOf("export async function recordProcessorSubmission"),
    );
    // It inserts a bare draft. Anything else here would be the park owner
    // writing the processor's answers.
    expect(ask).toMatch(/\.insert\(\{ park_id: parkId, provider \}\)/);
    for (const forbidden of [
      /status: "active"/, /can_accept_ach/, /can_accept_card/,
      /can_receive_payout/, /settlement_last4/, /activated_at/,
    ]) {
      expect(ask, `the owner's door writes ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

describe("the refusals are sentences, not constraint names", () => {
  it("asking twice says which case it is", () => {
    // A bare insert's 23505 reads as `data: null`, and "try again" for a path
    // that cannot succeed is a loop this codebase has already paid for.
    expect(src).toMatch(/error\.code === "23505"/);
    expect(src).toMatch(/You've already asked/);
    expect(src).toMatch(/already set up to receive rent/);
  });

  it("recording or activating out of order says so", () => {
    // Both filter on the status they expect, so a no-match is the ordinary
    // case rather than an error — and it gets its own words.
    expect(src).toMatch(/\.eq\("status", "draft"\)/);
    expect(src).toMatch(/\.eq\("status", "submitted"\)/);
    expect(src).toMatch(/isn't waiting to be sent/);
    expect(src).toMatch(/isn't waiting to go live/);
  });

  it("a live merchant approved for nothing is refused in words", () => {
    // 0196 refuses it too. Saying it here makes it a sentence and names why.
    expect(src).toMatch(/!input\.canAcceptAch && !input\.canAcceptCard && !input\.canReceivePayout/);
    expect(src).toMatch(/approved for nothing can't be paid/);
  });

  it("the settlement account is four digits or it is refused", () => {
    expect(src).toMatch(/\/\^\\d\{4\}\$\//);
  });

  it("a closure has to say why", () => {
    // Otherwise the record cannot explain itself later, which is the whole
    // reason the row survives.
    expect(src).toMatch(/Say why, so the record explains itself later/);
  });
});

describe("the queue is the reader that makes the ask real", () => {
  it("A FAILED READ IS NOT AN EMPTY QUEUE", () => {
    // "No park is waiting" is the reassuring way to be wrong about whether
    // anybody can collect rent.
    // THE ERROR BRANCH SPECIFICALLY. A bare `return null;` scan passed over
    // this: the ops guard at the top of the same function returns null too, so
    // replacing the error branch with `return []` left the assertion green.
    const at = src.indexOf("export async function getProcessorQueue");
    const body = src.slice(at);
    const branch = body.slice(body.indexOf("if (error) {"), body.indexOf("return (data"));
    expect(branch.length, "the error branch is gone — this scan is measuring nothing")
      .toBeGreaterThan(20);
    expect(branch, "a failed queue read does not return null").toMatch(/return null;/);
    expect(branch, "a failed queue read reads as an empty queue").not.toMatch(/return \[\]/);
    expect(branch, "and it leaves no trace").toMatch(/console\.error/);
  });

  it("and the panel says so rather than rendering empty", () => {
    const panel = strip(readFileSync(
      fileURLToPath(new URL("../../components/ops/OpsPaymentSetup.tsx", import.meta.url)), "utf8"));
    expect(panel).toMatch(/queue === null/);
    expect(panel).toMatch(/couldn&apos;t read the payment setup queue/);
    // And the genuinely empty case is a different sentence.
    expect(panel).toMatch(/queue\.length === 0/);
    expect(panel).toMatch(/No park has asked/);
  });

  it("the ops console counts them, so a draft is never unread", () => {
    const page = strip(readFileSync(
      fileURLToPath(new URL("../ops/page.tsx", import.meta.url)), "utf8"));
    expect(page).toMatch(/getProcessorQueue\(\)/);
    expect(page).toMatch(/parksAwaitingPayments:/);
    // Null counts as none rather than being invented as some.
    expect(page).toMatch(/\(processorQueue \?\? \[\]\)/);
  });
});

describe("nothing here invents the integration", () => {
  it("no action calls a processor", () => {
    // Creating the merchant is one HTTP call whose shape is Step 1 of the
    // processor roadmap and nobody has answered it. A plausible guess here
    // would be an integration written against a contract that does not exist.
    for (const forbidden of [/fetch\(/, /axios/, /https:\/\//]) {
      expect(src, `processor-actions reaches out: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("and the panel says that is what it is doing", () => {
    const panel = readFileSync(
      fileURLToPath(new URL("../../components/ops/OpsPaymentSetup.tsx", import.meta.url)), "utf8");
    expect(panel).toMatch(/NOTHING HERE TALKS TO A PROCESSOR/);
  });
});
