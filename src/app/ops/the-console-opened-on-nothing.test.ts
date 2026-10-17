import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  opsOpeningTab, opsQuietSentence, opsTasks, threadsAwaitingReply, tileFootnote,
  type OpsFacts,
} from "./ops-today-helpers";

/**
 * THE CONSOLE OPENED ON FOUR ZEROS AND AN EMPTY BOARD.
 *
 * /ops began with four tiles reading 0, 0, $0 and $0, then nine tabs
 * defaulting to Jobs — which in production is also empty. So the first screen
 * of the operations console said nothing true except that nothing had
 * happened, and said it four times.
 *
 * And the fact that mattered most was two taps away: in production every
 * vendor is a test account, so NO CREW CAN TAKE ANY JOB — on the Crews tab,
 * under the roster, on a console that opened on Jobs.
 */

/** Production, on the day this was written. */
const QUIET: OpsFacts = {
  escalations: 0, payoutsReturned: 0, crewsInTheRed: 0, payoutsQueued: 0,
  jobsNeedingCrew: 0, stuckHouseholds: 0, parkEnquiries: 0, proposedFees: 0,
  liveCrews: 0, orphanServices: 0, coverageHoles: 0, coveragePairs: 0,
  unpricedCrews: 0, unreadThreads: 0, requestsWaiting: 0,
  parksAwaitingPayments: 0, parksNotBillable: 0, monthsUnbilled: 0, unbilledCents: 0,
};
const facts = (over: Partial<OpsFacts> = {}): OpsFacts => ({ ...QUIET, ...over });
const said = (f: OpsFacts) => opsTasks(f).map((t) => t.said).join(" | ");

describe("the buried fact comes to the top", () => {
  it("says no crew can take any job, which is production today", () => {
    const tasks = opsTasks(QUIET);
    const no = tasks.find((t) => t.key === "no-crews");
    expect(no, "a platform with no live crew says nothing about it").toBeDefined();
    expect(no!.said).toMatch(/No crew can take any job/i);
    expect(no!.urgency).toBe("now");
    // And it opens the tab that holds it, rather than naming it.
    expect(no!.tab).toBe("crews");
  });

  it("and it is the FIRST thing on an otherwise quiet platform", () => {
    expect(opsTasks(QUIET)[0].key).toBe("no-crews");
  });

  it("the console opens on that tab instead of an empty jobs board", () => {
    expect(opsOpeningTab(QUIET, opsTasks(QUIET))).toBe("crews");
  });

  it("with crews live, it talks about holes instead — not about having none", () => {
    const f = facts({ liveCrews: 3, coverageHoles: 2, coveragePairs: 14 });
    expect(said(f)).not.toMatch(/No crew can take any job/i);
    expect(said(f)).toContain("2 of 14");
  });

  it("a service nobody anywhere can do outranks a per-lake hole", () => {
    // Both are true at once constantly; saying both is two rows for one act.
    const f = facts({ liveCrews: 3, orphanServices: 1, coverageHoles: 9, coveragePairs: 14 });
    const keys = opsTasks(f).map((t) => t.key);
    expect(keys).toContain("orphan-services");
    expect(keys).not.toContain("coverage-holes");
  });
});

describe("money and people outrank structure", () => {
  it("a frozen dispute leads a coverage hole", () => {
    const f = facts({ escalations: 1, liveCrews: 2, coverageHoles: 5, coveragePairs: 14 });
    expect(opsTasks(f)[0].key).toBe("escalations");
  });

  it("a returned payout says the crew is still unpaid", () => {
    const t = opsTasks(facts({ payoutsReturned: 2, liveCrews: 1 }))
      .find((x) => x.key === "payouts-returned")!;
    expect(t.said).toMatch(/still unpaid/i);
    expect(t.urgency).toBe("now");
  });

  it("a crew in the red says the run skips them silently", () => {
    const t = opsTasks(facts({ crewsInTheRed: 1, liveCrews: 1 }))
      .find((x) => x.key === "crews-in-the-red")!;
    expect(t.said).toMatch(/without saying so/i);
  });

  it("a queued payout is only worth watching", () => {
    const t = opsTasks(facts({ payoutsQueued: 4, liveCrews: 1 }))
      .find((x) => x.key === "payouts-queued")!;
    expect(t.urgency).toBe("watch");
  });

  it("A PARK WAITING TO BE SET UP IS ON THE LIST", () => {
    // The reader that makes the owner's ask real. 0196 shipped a registry
    // with no writer and no queue; a draft nobody looks at is a request that
    // silently never happens.
    const t = opsTasks(facts({ parksAwaitingPayments: 2, liveCrews: 1 }))
      .find((x) => x.key === "parks-awaiting-payments")!;
    expect(t, "a park asked to be set up and the console says nothing").toBeDefined();
    expect(t.said).toMatch(/2 parks are waiting to be set up/);
    // Said as the consequence, not as an admin chore.
    expect(t.said).toMatch(/residents cannot pay in the app/);
    expect(t.urgency).toBe("now");
    expect(t.tab).toBe("parks");
  });

  it("and one park reads as one", () => {
    const t = opsTasks(facts({ parksAwaitingPayments: 1, liveCrews: 1 }))
      .find((x) => x.key === "parks-awaiting-payments")!;
    expect(t.said).toMatch(/1 park is waiting/);
    expect(t.said).toMatch(/its residents cannot/);
  });

  it("A PARK WE CANNOT INVOICE AT ALL is on the list", () => {
    // LakeLife's only revenue from a park is this fee, and a park with no
    // fee start month refuses every raise. On 17 Oct 2026 that was The Haven:
    // the $8 dial set, 21 lots, and no screen anywhere saying we could not
    // bill it a penny.
    const t = opsTasks(facts({ parksNotBillable: 1, liveCrews: 1 }))
      .find((x) => x.key === "parks-not-billable")!;
    expect(t, "a park earns us nothing and the console says nothing").toBeDefined();
    expect(t.said).toMatch(/cannot be invoiced at all/);
    expect(t.said).toMatch(/no month their fee starts from|it has no month/);
    expect(t.urgency).toBe("now");
    expect(t.tab).toBe("margin");
  });

  it("and months nobody raised, with what they are worth", () => {
    const t = opsTasks(facts({ monthsUnbilled: 3, unbilledCents: 48000, liveCrews: 1 }))
      .find((x) => x.key === "months-unbilled")!;
    expect(t.said).toMatch(/3 months of platform fee have gone unraised/);
    expect(t.said).toMatch(/\$480 we have not asked for/);
  });

  it("and says nothing about the worth when it could not be worked out", () => {
    // One park's lots failing leaves the month count standing and its worth
    // unknown. A $0 in that sentence would read as "worth nothing".
    const t = opsTasks(facts({ monthsUnbilled: 2, unbilledCents: 0, liveCrews: 1 }))
      .find((x) => x.key === "months-unbilled")!;
    expect(t.said).toMatch(/2 months/);
    expect(t.said).not.toMatch(/\$0/);
  });

  it("everything on this card is a move, never a write", () => {
    // Every one of these decisions spends money or speaks to somebody, so the
    // card moves him to the screen where the decision lives. The park's
    // morning screen may raise bills from its own card because a bill can be
    // cancelled; none of these can.
    const loud = facts({
      escalations: 2, payoutsReturned: 1, crewsInTheRed: 1, payoutsQueued: 3,
      jobsNeedingCrew: 4, stuckHouseholds: 2, parkEnquiries: 1, proposedFees: 2,
      liveCrews: 0, unpricedCrews: 1, unreadThreads: 3, requestsWaiting: 5,
    });
    for (const t of opsTasks(loud)) {
      expect(t.verb, `${t.key} has no verb`).not.toBe("");
      // Not one of them is the generic signpost the park screen was built out
      // of — the word says which screen opens.
      expect(t.verb).not.toMatch(/^sort it$/i);
    }
  });

  it("a task already on this page gets no button, and says so", () => {
    for (const key of ["escalations", "stuck-households", "proposed-fees"]) {
      const t = opsTasks(facts({
        escalations: 1, stuckHouseholds: 1, proposedFees: 1, liveCrews: 1,
      })).find((x) => x.key === key)!;
      expect(t.tab, `${key} points at a tab it does not live on`).toBeNull();
      expect(t.said).toBeTruthy();
    }
  });
});

describe("the sentences read like sentences", () => {
  it("one of a thing is singular", () => {
    const one = said(facts({
      escalations: 1, jobsNeedingCrew: 1, stuckHouseholds: 1, parkEnquiries: 1,
      proposedFees: 1, unreadThreads: 1, requestsWaiting: 1, liveCrews: 1,
      payoutsReturned: 1, crewsInTheRed: 1, payoutsQueued: 1,
    }));
    expect(one).not.toMatch(/\b1 \w+s\b/);
    expect(one).toContain("1 dispute needs a human call");
    expect(one).toContain("1 park enquiry is");
  });

  it("more than one is plural", () => {
    const many = said(facts({
      escalations: 3, jobsNeedingCrew: 2, parkEnquiries: 4, liveCrews: 1,
    }));
    expect(many).toContain("3 disputes need a human call");
    expect(many).toContain("2 jobs have no crew");
    expect(many).toContain("4 park enquiries are");
  });

  it("no sentence leaks a placeholder", () => {
    const all = said(facts({
      escalations: 2, payoutsReturned: 2, crewsInTheRed: 2, payoutsQueued: 2,
      jobsNeedingCrew: 2, stuckHouseholds: 2, parkEnquiries: 2, proposedFees: 2,
      liveCrews: 2, orphanServices: 2, coverageHoles: 2, coveragePairs: 9,
      unpricedCrews: 2, unreadThreads: 2, requestsWaiting: 2,
    }));
    expect(all).not.toMatch(/undefined|NaN|\[object|null/);
  });
});

describe("the quiet state says what it checked", () => {
  it("names the questions rather than just going silent", () => {
    // "Nothing needs you" reads the same whether the morning is clear or every
    // loader broke — the mistake the claim card made for months.
    const q = opsQuietSentence(facts({ liveCrews: 2 }));
    expect(q).toMatch(/Nothing needs you right now/);
    expect(q).toMatch(/2 crews are live/);
    expect(q).toMatch(/\d+ things were checked/);
  });

  it("one crew is singular there too", () => {
    expect(opsQuietSentence(facts({ liveCrews: 1 }))).toContain("1 crew is live");
  });

  it("but production is NOT quiet, because no crew is live", () => {
    // The whole point. The quiet sentence must be unreachable on a platform
    // with nobody to send.
    expect(opsTasks(QUIET).length).toBeGreaterThan(0);
  });
});

describe("a zero is only readable next to the reason it is a zero", () => {
  it("with no live crew, that is the reason", () => {
    expect(tileFootnote({ value: 0, liveCrews: 0 })).toBe("no live crew yet");
  });

  it("a money tile's zero follows from the jobs tile", () => {
    expect(tileFootnote({ value: 0, liveCrews: 2, followsFromJobs: true, jobsThisWeek: 0 }))
      .toBe("no jobs this week yet");
  });

  it("a real number gets no footnote at all", () => {
    expect(tileFootnote({ value: 7, liveCrews: 0 })).toBeNull();
    expect(tileFootnote({ value: 1250, liveCrews: 2, followsFromJobs: true, jobsThisWeek: 3 }))
      .toBeNull();
  });

  it("a zero with jobs running is a plain none, not an excuse", () => {
    expect(tileFootnote({ value: 0, liveCrews: 2, followsFromJobs: true, jobsThisWeek: 4 }))
      .toBe("none");
  });
});

describe("threads waiting on a reply", () => {
  const thread = (...from: string[]) => ({ messages: from.map((f) => ({ from: f })) });

  it("counts a thread whose last word was the owner's", () => {
    expect(threadsAwaitingReply([thread("ops", "owner")])).toBe(1);
  });

  it("does not count one we answered", () => {
    expect(threadsAwaitingReply([thread("owner", "ops")])).toBe(0);
  });

  it("an AI auto-reply counts as answered, deliberately", () => {
    // A message DID go back. Counting it as unanswered would pin every
    // auto-replied thread to the console for good.
    expect(threadsAwaitingReply([thread("owner", "ops")])).toBe(0);
  });

  it("an empty thread is not somebody waiting", () => {
    expect(threadsAwaitingReply([{ messages: [] }])).toBe(0);
  });
});

/**
 * The wiring. Each line a refactor could drop while every sentence above
 * still passed.
 */
describe("the console is actually wired to it", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (f: string) =>
    strip(readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8"));
  const page = read("./page.tsx");
  const shell = read("../../components/ops/OpsShell.tsx");

  it("the shell no longer hard-codes the tab it opens on", () => {
    expect(shell.length).toBeGreaterThan(1000);
    expect(shell, "the console still opens on Jobs whatever is waiting")
      .not.toMatch(/useState<TabKey>\("jobs"\)/);
    // The opening tab now arrives through the lifted state, so assert it is
    // honoured rather than asserting one particular hook call.
    expect(shell).toMatch(/useOpsTab\(openingTab\)/);
    const tabs = strip(readFileSync(
      fileURLToPath(new URL("../../components/ops/OpsTabs.tsx", import.meta.url)), "utf8"));
    expect(tabs).toMatch(/useState<OpsTab>\(openingTab\)/);
  });

  it("THE CARD IS ON THE FIRST SCREEN, not merely above the tab strip", () => {
    // THE FALSE PASS THIS REPLACES. The card first went in at the top of
    // OpsShell — above the nine tabs, which is where the taps were — and the
    // test asserted exactly that: `<OpsToday` before `TABS.map`. Both true.
    //
    // And useless, because OpsShell renders at the BOTTOM of this page, after
    // four health panels and three cards. The thing that answers "what needs
    // me" sat about fifteen hundred pixels down a console whose first screen
    // was still four zeros. A test that pins a card's position relative to the
    // strip says nothing about its position on the PAGE.
    //
    // So it is measured on the page now, against everything it has to beat.
    const card = page.indexOf("<OpsToday");
    expect(card, "/ops does not render the card at all").toBeGreaterThan(-1);
    for (const below of [
      "<JobSearch", "<OpsSmsHealth", "<OpsEmailHealth", "<OpsAutomationHealth",
      "<OpsStuckClaims", "<EscalationDecision", "<ProposedFees", "<OpsShell",
    ]) {
      const at = page.indexOf(below);
      expect(at, `${below} is gone — repoint this test`).toBeGreaterThan(-1);
      expect(card, `the card renders below ${below}`).toBeLessThan(at);
    }
    // And directly under the tiles, which are the only thing above it.
    expect(page.indexOf("kpis.map")).toBeLessThan(card);
  });

  it("the tab state is lifted, or the card could not be up there", () => {
    expect(page).toMatch(/<OpsTabProvider openingTab=\{openingTab\}>/);
    expect(page).toMatch(/<\/OpsTabProvider>/);
    // The strip no longer owns the state.
    expect(shell, "OpsShell still holds the tab in its own useState")
      .not.toMatch(/useState<TabKey>/);
    expect(shell).toMatch(/useOpsTab\(openingTab\)/);
  });

  it("a button that says Open takes him to what it opened", () => {
    // Otherwise the control silently highlights a tab a thousand pixels below
    // — the same defect this card was built to fix, one level smaller.
    const today = strip(readFileSync(
      fileURLToPath(new URL("../../components/ops/OpsToday.tsx", import.meta.url)), "utf8"));
    expect(today).toMatch(/open\(t\.tab as OpsTab\)/);
    const tabs = strip(readFileSync(
      fileURLToPath(new URL("../../components/ops/OpsTabs.tsx", import.meta.url)), "utf8"));
    // INSIDE `open`, AND UNGUARDED. Asserting the token `scrollIntoView`
    // appears anywhere let `0 && document.getElementById(...)` through — a
    // dead call that still reads as a passing scan. The body is sliced out and
    // the statement has to start the line it is on.
    const at = tabs.indexOf("const open = useCallback(");
    expect(at, "`open` is gone — repoint this test").toBeGreaterThan(-1);
    const body = tabs.slice(at, tabs.indexOf("}, []);", at));
    expect(body, "`open` does not set the tab").toMatch(/setTab\(t\);/);
    expect(body, "the scroll is guarded or dead")
      .toMatch(/^\s*document\.getElementById\(OPS_TAB_STRIP_ID\)\?\.scrollIntoView\(\{$/m);
    // And the strip carries the anchor it scrolls to.
    expect(shell).toMatch(/id=\{OPS_TAB_STRIP_ID\}/);
  });

  it("the page computes the facts and passes them where each is needed", () => {
    expect(page).toMatch(/opsTasks\(facts\)/);
    expect(page).toMatch(/opsQuietSentence\(facts\)/);
    expect(page).toMatch(/opsOpeningTab\(facts, tasks\)/);
    expect(page).toMatch(/tasks=\{tasks\} quiet=\{quiet\} openingTab=\{openingTab\}/);
  });

  it("it counts only the fees that can still be decided", () => {
    // getProposedFees also returns waived and charging rows, and `fee_waived`
    // is terminal. Counting those puts a number on the card that never goes
    // down — the exact bug the heading below it already had to fix.
    expect(page).toMatch(/f\.fee > 0 && f\.state === "fee_proposed"/);
    expect(page).toMatch(/proposedFees: decidableFees\.length/);
  });

  it("every tile's zero carries its reason", () => {
    expect((page.match(/tileFootnote\(/g) ?? []).length,
      "a tile still shows a bare zero").toBeGreaterThanOrEqual(4);
  });
});
