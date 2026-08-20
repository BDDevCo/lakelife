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
