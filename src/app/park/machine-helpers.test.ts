import { describe, it, expect } from "vitest";
import { liveness, livenessLine, JOB_CEILING, mayAct, type RunRow } from "./machine-helpers";
import {
  reconcile, reconcileSummary, cutoverMonthNote, CLAIM_STALE_DAYS,
  type ReconcileInput,
} from "./reconcile-helpers";

const TODAY = "2026-08-11";
const run = (o: Partial<RunRow> = {}): RunRow => ({
  runner: "reconcile", runOn: TODAY, ok: true, error: null, found: 0, ...o,
});

describe("is the machine alive", () => {
  it("says NEVER RAN rather than fresh when there are no rows at all", () => {
    // The dangerous default. A brand-new park with no runs must not read as
    // "checked and fine".
    expect(liveness([], TODAY)).toBe("never_ran");
  });

  it("counts last night as fresh and the night before as stale", () => {
    expect(liveness([run({ runOn: "2026-08-10" })], TODAY)).toBe("fresh");
    expect(liveness([run({ runOn: "2026-08-09" })], TODAY)).toBe("stale");
  });

  it("does NOT count a run that errored as a run", () => {
    // A job that threw on its first query is the absence of a check wearing
    // the costume of one.
    expect(liveness([run({ ok: false, error: "boom" })], TODAY)).toBe("never_ran");
  });

  it("raises an alarm when the check has stopped running", () => {
    const l = livenessLine([run({ runOn: "2026-08-07" })], TODAY, ["rent"]);
    expect(l.state).toBe("stale");
    expect(l.alarm).toMatch(/hasn't run/);
    expect(l.alarm).toMatch(/Friday 7 August/);
    // And it tells him the screen he is looking at is still current.
    expect(l.alarm).toMatch(/worked out just now/);
  });

  it("says what it checked on a healthy night, not just that it ran", () => {
    const l = livenessLine([run({ runOn: "2026-08-10" })], TODAY, ["rent", "agreements"]);
    expect(l.line).toBe("Checked last night — rent, agreements.");
    expect(l.alarm).toBeNull();
  });

  it("alarms on a FRESH night when one runner threw", () => {
    // Empty and errored are different. A runner that died found nothing in
    // exactly the way a healthy one does.
    const l = livenessLine(
      [run({ runOn: TODAY }), run({ runOn: TODAY, runner: "notices", ok: false, error: "x" })],
      TODAY, ["rent"],
    );
    expect(l.state).toBe("fresh");
    expect(l.alarm).toMatch(/notices/);
    expect(l.brokenRunners).toEqual(["notices"]);
  });

  it("ignores an old failure that has since gone away", () => {
    const l = livenessLine(
      [run({ runOn: "2026-08-01", ok: false, error: "old" }), run({ runOn: TODAY })],
      TODAY, ["rent"],
    );
    expect(l.alarm).toBeNull();
    expect(l.brokenRunners).toEqual([]);
  });
});

describe("what the machine is allowed to do", () => {
  it("keeps chasing a household at DRAFT, with no path to raise it", () => {
    // An automatic chase reaches the email households and leaves the paper
    // third accruing arrears unwarned. The failure mode selects against the
    // people least able to absorb it, so this is not a tuning decision.
    expect(JOB_CEILING.chase_household).toBe("draft");
    expect(mayAct("chase_household")).toBe(false);
  });

  it("only lets a job ACT when the database refuses the wrong case", () => {
    // applyDueRentChanges is safe because 0061 makes an unserved increase
    // impossible — not because the code is careful.
    expect(mayAct("apply_rent_change")).toBe(true);
    expect(mayAct("renew_agreement")).toBe(false);
    expect(mayAct("serve_notice")).toBe(false);
    expect(mayAct("record_payment")).toBe(false);
    expect(mayAct("resolve_claim")).toBe(false);
  });

  it("treats an unknown job as not permitted", () => {
    expect(mayAct("something_new")).toBe(false);
  });
});

// ------------------------------------------------------------ reconciler ---

const lot = (o: Partial<ReconcileInput["lots"][number]> = {}) => ({
  lotNumber: "3", occupiedToday: true, quotedAmount: 455,
  tenancyExpired: false, billedThisMonth: true, statementZero: false, ...o,
});

const input = (o: Partial<ReconcileInput> = {}): ReconcileInput => ({
  today: TODAY, month: "2026-08", lots: [lot()], openClaims: [], cutoverMonth: null, ...o,
});

describe("what the nightly read notices", () => {
  it("finds nothing wrong with a park where nothing is wrong", () => {
    expect(reconcile(input())).toEqual([]);
    expect(reconcileSummary([])).toBe("Nothing out of place.");
  });

  it("catches the failure with no error anywhere — lived in, never billed", () => {
    // A lapsed range makes buildStatement return zero days, the charge run
    // drops the row, and the money stops with nothing on any screen.
    const f = reconcile(input({ lots: [lot({ billedThisMonth: false })] }));
    expect(f[0].kind).toBe("live_lot_unbilled");
    expect(f[0].urgent).toBe(true);
    expect(f[0].line).toMatch(/Somebody lives there and nothing is being charged/);
  });

  it("names a household living on an agreement that ran out", () => {
    const f = reconcile(input({ lots: [lot({ tenancyExpired: true })] }));
    expect(f.some((x) => x.kind === "tenancy_expired")).toBe(true);
  });

  it("ABSTAINS on an unknown rent instead of calling it zero — and says so", () => {
    const f = reconcile(input({
      lots: [lot({ lotNumber: "3" }), lot({ lotNumber: "9", quotedAmount: null })],
    }));
    const a = f.find((x) => x.kind === "rent_unknown")!;
    expect(a.line).toMatch(/1 of 2 lots have a rent I can use/);
    expect(a.line).toMatch(/I don't know what lot 9 should pay/);
    expect(a.line).toMatch(/isn't in any total above/);
  });

  it("every headline carries its own denominator", () => {
    const f = reconcile(input({
      lots: [lot({ lotNumber: "1", quotedAmount: null }), lot({ lotNumber: "2" }),
             lot({ lotNumber: "3" })],
    }));
    expect(f.find((x) => x.kind === "rent_unknown")!.line).toContain("2 of 3 lots");
  });

  it("reports a statement that silently totalled to nothing", () => {
    const f = reconcile(input({ lots: [lot({ statementZero: true })] }));
    expect(f.find((x) => x.kind === "zero_total_statement")!.line)
      .toMatch(/left off the bills rather than charged \$0/);
  });

  it("ages an unanswered disagreement, because nothing else gives it a clock", () => {
    const f = reconcile(input({
      openClaims: [{ lotNumber: "7", ageDays: 21 }, { lotNumber: "2", ageDays: 3 }],
    }));
    const c = f.find((x) => x.kind === "claim_ageing")!;
    // Only the stale one counts; three days is not a problem yet.
    expect(c.line).toMatch(/1 household has said they paid/);
    expect(c.line).toMatch(/oldest is 21 days \(lot 7\)/);
    expect(c.line).toMatch(/out of your arrears/);
  });

  it("leaves a fresh claim alone", () => {
    expect(reconcile(input({
      openClaims: [{ lotNumber: "7", ageDays: CLAIM_STALE_DAYS - 1 }],
    }))).toEqual([]);
  });

  it("NEVER calls anyone unbilled in the takeover month", () => {
    // The seller collected half of it and the roll is half-entered. "Late" is
    // a claim this data cannot support.
    const f = reconcile(input({
      month: "2026-12", cutoverMonth: "2026-12",
      lots: [lot({ billedThisMonth: false })],
    }));
    expect(f.some((x) => x.kind === "live_lot_unbilled")).toBe(false);
    expect(cutoverMonthNote("2026-12", "2026-12")).toMatch(/nobody is being called late/);
  });

  it("goes back to normal the month after the takeover", () => {
    const f = reconcile(input({
      month: "2027-01", cutoverMonth: "2026-12",
      lots: [lot({ billedThisMonth: false })],
    }));
    expect(f.some((x) => x.kind === "live_lot_unbilled")).toBe(true);
    expect(cutoverMonthNote("2027-01", "2026-12")).toBeNull();
  });

  it("puts the urgent findings first", () => {
    const f = reconcile(input({
      lots: [lot({ lotNumber: "1", quotedAmount: null }), lot({ lotNumber: "2", tenancyExpired: true })],
    }));
    expect(f[0].urgent).toBe(true);
  });

  it("names up to four lots then counts the rest", () => {
    const many = ["1","2","3","4","5","6"].map((n) => lot({ lotNumber: n, billedThisMonth: false }));
    const f = reconcile(input({ lots: many }));
    expect(f[0].line).toMatch(/lot 1, lot 2, lot 3, lot 4 and 2 more/);
  });

  it("summarises for a subject line without inventing urgency", () => {
    const f = reconcile(input({ lots: [lot({ statementZero: true })] }));
    expect(reconcileSummary(f)).toBe("1 worth a look.");
  });
});
