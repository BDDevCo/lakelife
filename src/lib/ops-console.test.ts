import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE CONSOLE HE CHECKS TWENTY TIMES A DAY, FROM A TRUCK.
 *
 * Two findings from walking the season as ops.
 *
 *  1. THE COMPLETE BUCKET GREW FOREVER. getJobBoard selected every job in the
 *     board statuses with no date bound and no limit, so by September the Jobs
 *     tab is a phone-length scroll of finished work to get past before reaching
 *     today's — under a query that grows without limit.
 *
 *  2. THE ESCALATION BUTTONS HAD NO PENDING STATE AND NO RESULT. They were a
 *     bare <form action={serverAction}> and the action returned Promise<void>.
 *     On LTE a tap that does nothing visible gets tapped again — and this is
 *     the button that refunds a customer and releases a crew's frozen pay. A
 *     failure logged to a server console and returned; the page revalidated
 *     and the same card came back, so "done" and "didn't" looked identical.
 *
 * Verified against the live REST endpoint, not just the syntax: with the real
 * data (3 complete jobs dated 18-19 July, 5 cancelled), a 30-day window
 * returns 0, a 60-day window returns 3, and cancelled never appears in either.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the jobs board", () => {
  const data = () => src("../app/ops/data.ts");

  it("bounds finished work, and leaves live work unbounded", () => {
    const s = data();
    expect(s).toMatch(/DONE_WINDOW_DAYS = 30/);
    // The live three carry no date condition — an old requested job with no
    // crew is still a thing to do, and hiding it would hide the problem.
    expect(s).toMatch(/status\.in\.\(requested,scheduled,in_progress\)/);
    expect(s).toMatch(/and\(status\.in\.\(complete,paid\),date\.gte/);
  });

  it("does not fetch the whole history any more", () => {
    const s = data();
    const at = s.indexOf("export async function getJobBoard");
    const body = s.slice(at, at + 1400);
    // The unbounded `.in("status", BOARD_STATUSES)` is what grew forever.
    expect(body).not.toMatch(/\.in\("status", BOARD_STATUSES/);
  });

  it("the label says the window, rather than implying everything", () => {
    const s = src("../components/ops/JobBoard.tsx");
    expect(s).toMatch(/Complete — last 30 days/);
    // And the empty state must not read as "nothing was ever finished".
    expect(s).toMatch(/Nothing finished in the last 30 days\./);
  });
});

describe("the escalation decision", () => {
  const action = () => src("../app/ops/dispute-actions.ts");
  const ui = () => src("../components/ops/EscalationDecision.tsx");

  it("the action tells the caller what happened", () => {
    const s = action();
    expect(s, "Promise<void> is how a failed refund looked like a done one").toMatch(
      /Promise<EscalationResult>/,
    );
    expect(s).toMatch(/nothing has changed/);
  });

  it("and says which decision landed, not just that one did", () => {
    const s = action();
    expect(s).toMatch(/The crew's remainder has been released/);
    expect(s).toMatch(/Their pay has been released/);
  });

  it("the buttons disable while it is working", () => {
    // A tap that does nothing visible gets tapped again, and the second submit
    // posts the same decision about the same money.
    const s = ui();
    expect(s).toMatch(/useFormStatus/);
    expect(s).toMatch(/disabled=\{pending\}/);
    expect(s).toMatch(/Working…/);
  });

  it("and the result is rendered where the decision was made", () => {
    const s = ui();
    expect(s).toMatch(/useActionState/);
    expect(s).toMatch(/state\.ok \? "var\(--ink-good\)" : "var\(--ink-warn\)"/);
  });

  it("both screens that offer the decision use it", () => {
    for (const p of ["../app/ops/page.tsx", "../app/ops/jobs/[id]/page.tsx"]) {
      const s = src(p);
      expect(s, `${p} still posts a bare form`).toMatch(/<EscalationDecision disputeId=/);
      expect(s).not.toMatch(/<form action=\{resolveEscalationAction\}/);
    }
  });
});

/**
 * A SCRATCH LAKE LOOKING EXACTLY LIKE A REAL ONE, on the screen where six
 * hand-typed date fields gate the entire spring water calendar.
 *
 * 0124 fenced fixtures off every public surface and deliberately left them in
 * the ops editor — somebody has to be able to set a scratch lake's dates. It
 * left them unmarked, and it carried `is_fixture` all the way onto the view
 * model where nothing read it. The real ice-out goes into the wrong card; the
 * lake that needed it stays provisional, its pull reminder never fires, and a
 * pier spends the winter in the ice.
 */
describe("a test lake cannot be mistaken for a real one", () => {
  it("the badge is rendered, not just loaded", () => {
    const ui = src("../components/ops/LakeConditions.tsx");
    expect(ui).toMatch(/lake\.is_fixture/);
    expect(ui).toMatch(/Test lake/);
    expect(ui).toMatch(/Not a real lake/);
  });

  it("real lakes sort ahead of fixtures", () => {
    const data = src("../app/ops/data.ts");
    const at = data.indexOf("export async function getLakeConditions");
    expect(at).toBeGreaterThan(-1);
    const body = data.slice(at, data.indexOf("\n// ----", at));
    expect(body).toMatch(/Number\(a\.is_fixture\) - Number\(b\.is_fixture\)/);
  });

  it("ops still SEES fixtures — the editor is the one place they belong", () => {
    // The fence is about public surfaces. Filtering them out here would leave
    // a scratch lake with no way to set its dates at all.
    const data = src("../app/ops/data.ts");
    const at = data.indexOf("export async function getLakeConditions");
    const body = data.slice(at, data.indexOf("\n// ----", at));
    expect(body).not.toMatch(/\.eq\("is_fixture", false\)/);
  });
});

/**
 * A GUESSED SEASON WINDOW, SOLD SILENTLY.
 *
 * `effectiveSeason` computes `wasRolled` and its doc says "Surface it; never
 * sell against it silently." Outside tests it had ONE consumer — the ops
 * assign-refusal. So the person refusing a job was told the dates were a
 * guess and the customer committing money to the same window was not.
 *
 * These scan the three surfaces that were silent, plus the screen that exists
 * to fix it, which did not even load the column.
 */
describe("nobody is sold against a guessed season window", () => {
  it("the booking page loads the flag and passes it to the grid", () => {
    const page = src("../app/book/page.tsx");
    expect(page).toMatch(/season_confirmed/);
    expect(page).toMatch(/seasonIsProvisional/);
    expect(page).toMatch(/provisional: seasonProvisional/);
  });

  it("the grid can receive it and says something when it is true", () => {
    const grid = src("../components/BookingGrid.tsx");
    expect(grid).toMatch(/provisional\?: boolean/);
    expect(grid).toMatch(/season\.provisional/);
    expect(grid).toMatch(/aren't confirmed yet/);
  });

  it("the warning is water-work only — on a mow these dates decide nothing", () => {
    const grid = src("../components/BookingGrid.tsx");
    expect(grid).toMatch(/service\.is_water_work && season\.provisional/);
  });

  it("it warns rather than blocks — a guessed window still beats no window", () => {
    // If this ever became a refusal, a customer who wants to book their pull
    // in August could not, on the strength of a date nobody has measured.
    const grid = src("../components/BookingGrid.tsx");
    const at = grid.indexOf("season.provisional");
    const block = grid.slice(at, at + 900);
    expect(block).toMatch(/You can book now/);
    expect(block).not.toMatch(/disabled|return null/);
  });

  it("the public lake page stops stating a guess as this year's deadline", () => {
    const pub = src("../app/lakes/[slug]/page.tsx");
    expect(pub).toMatch(/season_confirmed/);
    expect(pub).toMatch(/seasonIsProvisional/);
    expect(pub).toMatch(/an estimate until this year's ice-out is measured/);
  });

  it("ops can finally see WHICH lake is still provisional", () => {
    const data = src("../app/ops/data.ts");
    const ui = src("../components/ops/LakeConditions.tsx");
    expect(data).toMatch(/season_confirmed/);
    expect(data).toMatch(/provisional: seasonIsProvisional/);
    expect(ui).toMatch(/Still provisional/);
  });

  it("and it tells ops WHY, because the two causes have different fixes", () => {
    // Rolled from last season vs never confirmed at all — one is a stale date
    // on a real lake, the other is a lake wearing a neighbour's dates.
    const ui = src("../components/ops/LakeConditions.tsx");
    expect(ui).toMatch(/rolled from a past season/);
    expect(ui).toMatch(/copied from a neighbouring lake/);
  });
});

/**
 * FIVE MORE SENTENCES THAT ASSERTED SOMETHING THE CODE DOES NOT DO.
 * Found by a per-role audit of every user-facing surface, each one then put to
 * an independent reviewer told to refute it.
 */
describe("nothing claims money moved when none did", () => {
  it("the escalation result reports the refund it actually made", () => {
    // opsResolveEscalated returns { ok: true, refunded: 0 } when nothing was
    // ever captured — and decideDisputeOutcome escalates PRECISELY BECAUSE
    // nothing was captured, so that is the common path, not the edge.
    const a = src("../app/ops/dispute-actions.ts");
    const code = a.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // ASKED IS NOT OBEYED. Checking only that `res.refunded` appears passes
    // even when the branch is hard-coded to true — the same gap that let the
    // notification gate be computed and ignored. Pin the derivation itself.
    expect(code).toMatch(/const moved = \(res\.refunded \?\? 0\) > 0;/);
    expect(code).toMatch(/moved\s*\n?\s*\?/);
    expect(code).toMatch(/nothing to refund/);
    expect(code).not.toMatch(/"Refunded\. The crew's remainder has been released\."/);
  });

  it("the branch it is about still exists", () => {
    expect(src("./disputes.ts")).toMatch(/return \{ ok: true, refunded: 0 \}/);
  });
});

describe("the seasonal freeze warning hedges a guessed deadline", () => {
  it("reads the signals rather than printing the raw column", () => {
    // The one email of the year that tells a homeowner when their pier must
    // come out. prettyDate prints no year, so a rolled date is
    // indistinguishable from a measured one.
    const a = src("./automation.ts");
    const at = a.indexOf("export async function sendSeasonalPullReminders");
    expect(at).toBeGreaterThan(-1);
    const body = a.slice(at, a.indexOf("\nexport ", at + 10));
    expect(body).toMatch(/season_confirmed/);
    expect(body).toMatch(/seasonIsProvisional/);
    expect(body).toMatch(/an estimate until this year's ice-out is measured/);
  });

  it("and still states it plainly when the lake is confirmed", () => {
    const a = src("./automation.ts");
    const at = a.indexOf("export async function sendSeasonalPullReminders");
    const body = a.slice(at, a.indexOf("\nexport ", at + 10));
    expect(body).toMatch(/pull deadline is <b>\$\{deadline\}<\/b>/);
  });
});

describe("no screen promises a message it does not send", () => {
  it("ops is told their reply is not emailed", () => {
    const f = src("../components/ops/JobFile.tsx");
    expect(f).not.toMatch(/and their inbox/);
    expect(f).toMatch(/we don&apos;t email it to them/);
  });

  it("because sendOpsMessage genuinely only writes a row", () => {
    // If a send is ever added here, this fails and the copy above is stale.
    const a = src("../app/ops/messages-actions.ts");
    const at = a.indexOf("export async function sendOpsMessage");
    const body = a.slice(at, a.indexOf("\nexport ", at + 10));
    expect(body).not.toMatch(/sendEmail|notify\(|sendSms/);
  });

  it("storage does not promise a text nothing can send", () => {
    const p = src("../app/book/storage/page.tsx");
    expect(p).not.toMatch(/you&apos;ll get a text|you'll get a text/);
  });
});

describe("no hint quotes a dial nobody set", () => {
  it("the agreement-length hint describes the field, not a value", () => {
    // parks.max_agreement_months is nullable with no default; the hint said
    // "Your rule is three months" whatever was in the box, including empty.
    const d = src("../components/ParkDials.tsx");
    expect(d).not.toMatch(/Your rule is three months/);
    expect(d).toMatch(/How long one agreement may run/);
  });

  it("the park cost label claims only what the query knows", () => {
    // getBillableParkJobs filters on job status alone and reads nothing about
    // payment — and nothing in the tree ever writes jobs.status = 'paid'.
    const c = src("../components/ParkCosts.tsx");
    expect(c).not.toMatch(/Paid to LakeLife, not yet passed on/);
    expect(c).toMatch(/Work LakeLife has done here/);
  });
});

describe("the console counts only what a person can act on", () => {
  it("the fee heading counts decidable rows, not every row ever", () => {
    // fee_waived is terminal — nothing in the tree moves a row out of it — and
    // the card renders buttons only for fee > 0 && state === 'fee_proposed'.
    // The old heading counted all three states, so it could say "5 to decide"
    // with nothing decidable, forever.
    const p = src("../app/ops/page.tsx");
    expect(p).toMatch(/f\.fee > 0 && f\.state === "fee_proposed"/);
    expect(p).toMatch(/Nothing to decide right now/);
    expect(p).toMatch(/already settled below/);
    const code = p.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\$\{proposedFees\.length\} visit fees to decide/);
  });

  it("and stops claiming nobody-was-home about auto-waived stand-downs", () => {
    const code = src("../app/ops/page.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/Nobody was home, the customer had a week to rebook, and didn&apos;t\./);
  });

  it("waived really is terminal, which is why the count had to change", () => {
    // If some path ever un-waives a row, the framing above is stale.
    const r = src("../app/ops/recovery-actions.ts");
    expect(r).toMatch(/fee_waived/);
    expect(r).not.toMatch(/recovery_state: "fee_proposed"[\s\S]{0,120}fee_waived/);
  });

  it("a pending payout is explained by its actual cause", () => {
    // 'pending' means no vendor_cost — the photo gate cannot still be open,
    // because a payout row only exists on a job that already reached complete.
    const j = src("../app/ops/jobs/[id]/page.tsx");
    expect(j).toMatch(/no crew cost recorded on this job yet/);
    const code = j.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/pending — waiting on the photo gate/);
  });

  it("and that IS what pending means, per its only writer", () => {
    const a = src("./automation.ts");
    expect(a).toMatch(/openDispute \? "held" : job\.vendor_cost != null \? "released" : "pending"/);
  });
});
