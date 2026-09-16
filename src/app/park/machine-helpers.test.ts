import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveness, livenessLine, lastNightsFindings, JOB_CEILING, mayAct, type RunRow } from "./machine-helpers";
import {
  reconcile, reconcileSummary, cutoverMonthNote, CLAIM_STALE_DAYS,
  type ReconcileInput,
} from "./reconcile-helpers";
import { periodIsBillable } from "@/lib/billing-start";

const TODAY = "2026-08-11";
const run = (o: Partial<RunRow> = {}): RunRow => ({
  runner: "reconcile", runOn: TODAY, ok: true, error: null, found: 0,
  finishedAt: `${TODAY}T20:04:00Z`, findings: [], ...o,
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
  lapsed: false, unbilledMonths: [] as string[], statementZero: false, ...o,
});

const input = (o: Partial<ReconcileInput> = {}): ReconcileInput => ({
  today: TODAY, month: "2026-08", lots: [lot()], openClaims: [], cutoverDate: null, ...o,
});

describe("what the nightly read notices", () => {
  it("finds nothing wrong with a park where nothing is wrong", () => {
    expect(reconcile(input())).toEqual([]);
    expect(reconcileSummary([])).toBe("Nothing out of place.");
  });

  it("catches the failure with no error anywhere — lived in, never billed", () => {
    // A lapsed range makes buildStatement return zero days, the charge run
    // drops the row, and the money stops with nothing on any screen.
    const f = reconcile(input({ lots: [lot({ unbilledMonths: ["2026-08"] })] }));
    expect(f[0].kind).toBe("live_lot_unbilled");
    expect(f[0].urgent).toBe(true);
    expect(f[0].line).toMatch(/Somebody lives there and nothing is being charged/);
  });

  it("names a household living on an agreement that ran out", () => {
    const f = reconcile(input({ lots: [lot({ occupiedToday: false, lapsed: true })] }));
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

  it("NEVER calls anyone unbilled in the takeover PART-month", () => {
    // The Haven closes 15 December. The seller collected the 1st and the roll
    // is half-entered. "Late" is a claim this data cannot support.
    const f = reconcile(input({
      month: "2026-12", cutoverDate: "2026-12-15",
      lots: [lot({ unbilledMonths: ["2026-12"] })],
    }));
    expect(f.some((x) => x.kind === "live_lot_unbilled")).toBe(false);
    expect(cutoverMonthNote("2026-12", "2026-12-15")).toMatch(/nobody is being called late/);
  });

  it("goes back to normal the month after the takeover", () => {
    const f = reconcile(input({
      month: "2027-01", cutoverDate: "2026-12-15",
      lots: [lot({ unbilledMonths: ["2027-01"] })],
    }));
    expect(f.some((x) => x.kind === "live_lot_unbilled")).toBe(true);
    expect(cutoverMonthNote("2027-01", "2026-12-15")).toBeNull();
  });

  /**
   * A GO-LIVE ON THE FIRST IS NOT A PART-MONTH.
   *
   * The suppression keyed on the takeover MONTH, so setting go-live to the 1st
   * — the supported way to say "this whole month is mine to bill" — bought
   * silence over a month that was wholly ours and fully billable.
   *
   * At The Haven with go-live 1 Jan 2027 that is January: the first month he
   * bills, nineteen occupied lots, and the one night the first-ever charge run
   * is most likely to have been forgotten or half-finished. The nightly read
   * is the ONLY error-detection surface this park has.
   */
  it("DOES call unbilled lots in a takeover month that starts on the 1st", () => {
    const f = reconcile(input({
      month: "2027-01", cutoverDate: "2027-01-01",
      lots: [lot({ unbilledMonths: ["2027-01"] })],
    }));
    expect(f.some((x) => x.kind === "live_lot_unbilled")).toBe(true);
  });

  it("does not call that month a part-month, because it is not one", () => {
    // The note's own words are "your first PART-month". A month beginning on
    // the go-live day has no part the seller collected.
    expect(cutoverMonthNote("2027-01", "2027-01-01")).toBeNull();
  });

  it("agrees with the ledger about which months it may judge", () => {
    // The reconciler now goes quiet about exactly the months the ledger will
    // refuse to charge for, and about no others — one rule, one function.
    for (const [month, cutover, billable] of [
      ["2026-12", "2026-12-15", false],
      ["2027-01", "2026-12-15", true],
      ["2027-01", "2027-01-01", true],
      ["2026-12", "2026-12-01", true],
    ] as const) {
      expect(periodIsBillable(month, cutover)).toBe(billable);
      const f = reconcile(input({
        month, cutoverDate: cutover, lots: [lot({ unbilledMonths: [month] })],
      }));
      expect({ month, cutover, alarms: f.some((x) => x.kind === "live_lot_unbilled") })
        .toEqual({ month, cutover, alarms: billable });
    }
  });

  it("puts the urgent findings first", () => {
    const f = reconcile(input({
      lots: [lot({ lotNumber: "1", quotedAmount: null }), lot({ lotNumber: "2", occupiedToday: false, lapsed: true })],
    }));
    expect(f[0].urgent).toBe(true);
  });

  it("names up to four lots then counts the rest", () => {
    const many = ["1","2","3","4","5","6"].map((n) => lot({ lotNumber: n, unbilledMonths: ["2026-08"] }));
    const f = reconcile(input({ lots: many }));
    expect(f[0].line).toMatch(/lot 1, lot 2, lot 3, lot 4 and 2 more/);
  });

  it("summarises for a subject line without inventing urgency", () => {
    const f = reconcile(input({ lots: [lot({ statementZero: true })] }));
    expect(reconcileSummary(f)).toBe("1 worth a look.");
  });
});

/**
 * ONE MONTH WAS THE WRONG QUESTION.
 *
 * A successor written from a lapsed agreement's own end (decision 3) starts
 * in February and is written in March. The run visits a month once, keyed
 * per reservation, so nothing ever raises that February — and a check that
 * asked "is March billed?" said yes about that lot every night, forever.
 */
describe("every unbilled month per lot, not just this one", () => {
  const MARCH = { today: "2027-03-16", month: "2027-03", cutoverDate: "2027-01-01" };

  it("names an earlier month on the lot that was backfilled", () => {
    const f = reconcile(input({
      ...MARCH,
      lots: [lot({ lotNumber: "9", unbilledMonths: ["2027-02", "2027-03"] })],
    }));
    const u = f.find((x) => x.kind === "live_lot_unbilled")!;
    expect(u.urgent).toBe(true);
    expect(u.line).toMatch(/lot 9 \(February 2027 and March 2027\)/);
    // An instruction the screen has: ParkRent.tsx's month nav reaches back.
    expect(u.line).toMatch(/month links reach back/);
    expect(u.line).not.toMatch(/\d{4}-\d{2}/);
  });

  it("the current-month-only shape keeps its old sentence", () => {
    // The night before the run is the common case; the sentence he has read
    // every month since the check began still says it best.
    const f = reconcile(input({
      ...MARCH,
      lots: [lot({ lotNumber: "3", unbilledMonths: ["2027-03"] }),
             lot({ lotNumber: "9", unbilledMonths: ["2027-03"] })],
    }));
    expect(f[0].line).toBe(
      "2 occupied lots have no bill for March 2027 — lot 3 and lot 9. " +
      "Somebody lives there and nothing is being charged.",
    );
    expect(f[0].line).not.toMatch(/month links/);
  });

  it("an older hole on ONE lot switches every lot to the sentence that names months", () => {
    // "No bill for March" about a lot with no bill for February is the lie
    // this exists to stop telling.
    const f = reconcile(input({
      ...MARCH,
      lots: [lot({ lotNumber: "3", unbilledMonths: ["2027-03"] }),
             lot({ lotNumber: "9", unbilledMonths: ["2027-02", "2027-03"] })],
    }));
    expect(f[0].line).toMatch(/months with no bill/);
    expect(f[0].line).toMatch(/lot 3 \(March 2027\)/);
    expect(f[0].line).toMatch(/those months/);
  });

  it("puts the EARLIEST hole first, so the 1st of the month can't bury it", () => {
    // On the night of the 1st every lot is missing the current month; the
    // one lot missing February as well must not sit inside "and N more".
    const many = ["1", "2", "3", "4", "5"].map((n) => lot({ lotNumber: n, unbilledMonths: ["2027-03"] }));
    const f = reconcile(input({
      ...MARCH,
      lots: [...many, lot({ lotNumber: "9", unbilledMonths: ["2027-02", "2027-03"] })],
    }));
    expect(f[0].line).toMatch(
      /lot 9 \(February 2027 and March 2027\), lot 1 \(March 2027\), lot 2 \(March 2027\), lot 3 \(March 2027\) and 2 more/,
    );
    // Ties keep read order — lot 1 before lot 2 — so the sort is stable.
    expect(f[0].lotNumbers).toEqual(["9", "1", "2", "3", "4", "5"]);
  });

  it("a lot with one older month and nothing this month is still named", () => {
    const f = reconcile(input({
      ...MARCH,
      lots: [lot({ lotNumber: "9", unbilledMonths: ["2027-02"] })],
    }));
    expect(f[0].line).toBe(
      "1 occupied lot has months with no bill — lot 9 (February 2027). " +
      "Somebody lives there and nothing is being charged for them; " +
      "the rent screen's month links reach back to bill them.",
    );
  });

  it("a month before go-live is never called unbilled", () => {
    // The Haven closes 15 December: December was the seller's to collect.
    // A row reaching back over the takeover has December struck out, and
    // with only January left the sentence is the plain one-month line.
    const f = reconcile(input({
      today: "2027-01-20", month: "2027-01", cutoverDate: "2026-12-15",
      lots: [lot({ lotNumber: "9", unbilledMonths: ["2026-12", "2027-01"] })],
    }));
    expect(f[0].line).toMatch(/no bill for January 2027 — lot 9/);
    expect(f[0].line).not.toMatch(/December/);
    // And when EVERY month is before go-live, there is nothing to say.
    expect(reconcile(input({
      today: "2026-12-20", month: "2026-12", cutoverDate: "2026-12-15",
      lots: [lot({ lotNumber: "9", unbilledMonths: ["2026-11", "2026-12"] })],
    })).some((x) => x.kind === "live_lot_unbilled")).toBe(false);
  });

  it("a LAPSED lot is lived on — its unbilled months are named, the way the roll counts it as taken", () => {
    // The roll says "Ran out … nothing billed since" and counts the lot as
    // occupied; the rent screen's Bill button would raise its February
    // (classifyForRun: the row covers the month). The nightly read
    // `occupiedToday` — the CURRENT link alone — so the one lot with an
    // interior hole was the one lot the sentence "names every unbilled
    // month" skipped, and the only line it got was tenancy_expired.
    const f = reconcile(input({
      ...MARCH,
      lots: [lot({ lotNumber: "9", occupiedToday: false, lapsed: true, unbilledMonths: ["2027-02"] })],
    }));
    const u = f.find((x) => x.kind === "live_lot_unbilled")!;
    expect(u).toBeDefined();
    expect(u.line).toContain("lot 9 (February 2027)");
    expect(f.some((x) => x.kind === "tenancy_expired")).toBe(true);
    // Collapsed the other way: neither lived on nor lapsed — a lot that is
    // empty today (the caller hands one over only when a held row that no
    // longer covers today left months behind) is nobody's "somebody lives
    // there". This line must not say it about an empty lot.
    const empty = reconcile(input({
      ...MARCH,
      lots: [lot({ lotNumber: "9", occupiedToday: false, lapsed: false, unbilledMonths: ["2027-02"] })],
    }));
    expect(empty.some((x) => x.kind === "live_lot_unbilled")).toBe(false);
    expect(empty.some((x) => x.kind === "tenancy_expired")).toBe(false);
  });

  it("a lapsed lot with no rent on its current link is not an unknown rent — nothing is current", () => {
    // `rent_unknown` is about a household being billed against a rent
    // nobody set; a lapsed lot has no current link to read a rent from,
    // and calling it "I don't know what lot 9 should pay" every night was
    // the wrong alarm for the right lot.
    const f = reconcile(input({
      ...MARCH,
      lots: [lot({ lotNumber: "9", occupiedToday: false, lapsed: true, quotedAmount: null })],
    }));
    expect(f.some((x) => x.kind === "rent_unknown")).toBe(false);
  });

  it("a hole reported out of order is still the earliest hole", () => {
    const f = reconcile(input({
      ...MARCH,
      lots: [lot({ lotNumber: "9", unbilledMonths: ["2027-03", "2027-02"] })],
    }));
    expect(f[0].line).toMatch(/lot 9 \(February 2027 and March 2027\)/);
  });
});

describe("the nightly's charge read is wide enough to see a hole", () => {
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const machine = strip(readFileSync(
    fileURLToPath(new URL("../../lib/park-machine.ts", import.meta.url)), "utf8"));

  it("still finds the read at all", () => {
    // A scanner that matches nothing passes every "not" below for free.
    expect(machine).toMatch(/from\("park_charges"\)/);
    expect(machine).toMatch(/unbilledMonthsFor\(heldRows, billed, \{ today, cutoverDate \}\)/);
  });

  it("excludes a voided bill, as the run's own 'already billed' set does", () => {
    expect(machine).toMatch(/\.neq\("status", "void"\)/);
  });

  it("reads from a floor month, never one month", () => {
    // `.eq("period_month", month)` was the one-month question; a February
    // hole on a row backfilled in March was invisible every night after
    // 1 March.
    expect(machine).toMatch(/\.gte\("period_month", floor\)/);
    expect(machine).not.toMatch(/\.eq\("period_month", month\)/);
  });

  it("carries the row's term, so a yearly row is never named as unbilled months", () => {
    expect(machine).toMatch(/term: \(s\.term as string \| null\) \?\? null/);
  });

  it("reads the ended rows for the lapsed test, and keeps them OUT of the rows the run would bill", () => {
    // A household closed out of its successor leaves the expired link
    // before it held and run out; without the ended row the nightly called
    // that family "living here with no agreement". The ended rows reach
    // `lapsedRowOf` only — `heldRows` (and so unbilledMonthsFor) is still
    // built from the held ones, on purpose (the file says why).
    expect(machine).toMatch(/\.in\("status", \["approved", "active", "ended"\]\)/);
    expect(machine).toContain('const stays = everyRow.filter((s) => s.status === "approved" || s.status === "active");');
    expect(machine).toMatch(/const heldRows = stays\.map/);
    expect(machine).toMatch(/lapsed: lapsedRowOf\(slot\.rows, today\) != null/);
    // The old inline rule — any held row behind today — is gone.
    expect(machine).not.toMatch(/slot\.expired/);
    expect(machine).not.toMatch(/r\.end <= today/);
  });
});

describe("a run that claimed the night and never finished", () => {
  // The claim row is written BEFORE the work, so a job killed partway leaves
  // ok=true — the column's own default — and no finished_at. That read as a
  // clean night, and because the claim makes the night unrepeatable, nothing
  // ever went back and did the work.
  it("does not count as a check, even though ok is true", () => {
    expect(liveness([run({ finishedAt: null })], TODAY)).toBe("never_ran");
  });

  it("falls back to the last night that DID finish", () => {
    expect(liveness([
      run({ runOn: "2026-08-04", finishedAt: "2026-08-04T20:04:00Z" }),
      run({ runOn: TODAY, finishedAt: null }),
    ], TODAY)).toBe("stale");
  });

  it("a finished run is still fresh", () => {
    expect(liveness([run()], TODAY)).toBe("fresh");
  });
});

describe("what last night found reaches the screen", () => {
  const f = (line: string, urgent = false) => ({ kind: "k", urgent, line });

  it("returns the most recent FINISHED night's lines", () => {
    expect(lastNightsFindings([
      run({ runOn: "2026-08-04", findings: [f("old")] }),
      run({ runOn: TODAY, findings: [f("today")] }),
    ]).map((x) => x.line)).toEqual(["today"]);
  });

  it("puts money not being collected above a rent nobody set", () => {
    expect(lastNightsFindings([
      run({ findings: [f("a rent nobody set"), f("nobody is billing lot 4", true)] }),
    ]).map((x) => x.line)[0]).toBe("nobody is billing lot 4");
  });

  it("ignores a run that claimed the night and died — it found nothing because it never looked", () => {
    expect(lastNightsFindings([run({ finishedAt: null, findings: [f("x")] })])).toEqual([]);
  });

  it("is empty when the check has never run", () => {
    expect(lastNightsFindings([])).toEqual([]);
  });
});
