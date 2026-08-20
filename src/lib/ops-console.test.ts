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
