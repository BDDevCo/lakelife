import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { batchBookedLine, rushOfferLine } from "./booking-copy";

/**
 * TWO SENTENCES THAT WERE TRUE OF SOME STATES AND PRINTED FOR ALL OF THEM.
 *
 * "3 visits of Mowing locked in" — with no crew on any of them. The batch loop
 * ran autoAssignJob per day and kept only the LAST answer, so it could not
 * have counted even if the sentence had tried.
 *
 * "We're offering it to crews already out on your lake right now" — when the
 * blast had fallen back to every crew on the lake, or found nobody at all.
 * blastRushToCrews returned void; the sentence could not know.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const actions = strip(readFileSync(fileURLToPath(new URL("../app/book/actions.ts", import.meta.url)), "utf8"));

describe("a batch is only 'locked in' when every visit has a crew", () => {
  const base = { visits: "3 visits", serviceName: "Mowing", dateList: "Mon, Wed, Fri", total: 3, missed: "" };

  it("says locked in when all three have one", () => {
    const s = batchBookedLine({ ...base, assigned: 3 });
    expect(s).toMatch(/locked in/);
    expect(s).not.toMatch(/lining up/);
  });

  it("does NOT say locked in when none has one — the defect", () => {
    const s = batchBookedLine({ ...base, assigned: 0 });
    expect(s, "three visits with no crew were called locked in").not.toMatch(/locked in —/);
    expect(s).toMatch(/lining up crews/i);
    expect(s).toMatch(/booked/);
  });

  it("counts honestly in between", () => {
    const s = batchBookedLine({ ...base, assigned: 1 });
    expect(s).toMatch(/1 has a crew/);
    expect(s).toMatch(/lining 2 up/);
    const t = batchBookedLine({ ...base, assigned: 2 });
    expect(t).toMatch(/2 have a crew/);
    expect(t).toMatch(/lining one up/);
  });

  it("keeps the promise that is true either way", () => {
    for (const assigned of [0, 1, 3]) {
      expect(batchBookedLine({ ...base, assigned })).toMatch(/never charged until the work is done/);
    }
  });

  it("carries the refused-days clause through every branch", () => {
    for (const assigned of [0, 1, 3]) {
      expect(batchBookedLine({ ...base, assigned, missed: " (Tue was full.)" })).toContain("(Tue was full.)");
    }
  });
});

describe("a rush says who it actually reached", () => {
  const base = { serviceName: "Mowing", price: 95, cutoffLabel: "noon", fallback: "roll" as const };

  it("says 'already out on your lake' only when that is who was reached", () => {
    expect(rushOfferLine({ ...base, reached: 2, outToday: true })).toMatch(/already out on your lake right now/);
  });

  it("says 'posted to the crews who work your lake' on the fallback", () => {
    const s = rushOfferLine({ ...base, reached: 3, outToday: false });
    expect(s).not.toMatch(/already out/);
    expect(s).toMatch(/the 3 crews who work your lake/);
  });

  it("says 'hunting' when nobody was reached at all — today's production state", () => {
    // Every crew in production is a fixture, so a rush blast reaches nobody.
    const s = rushOfferLine({ ...base, reached: 0, outToday: false });
    expect(s, "claimed crews were out when nobody was reached").not.toMatch(/already out|posted it/);
    expect(s).toMatch(/hunting for a crew/);
  });

  it("keeps the cutoff and the fallback in every branch", () => {
    for (const r of [{ reached: 0, outToday: false }, { reached: 1, outToday: true }, { reached: 4, outToday: false }]) {
      const s = rushOfferLine({ ...base, ...r });
      expect(s).toContain("by noon");
      expect(s).toMatch(/move it to tomorrow/);
    }
    expect(rushOfferLine({ ...base, reached: 0, outToday: false, fallback: "cancel" })).toMatch(/cancel it — no charge/);
  });

  it("gets the singular right", () => {
    expect(rushOfferLine({ ...base, reached: 1, outToday: true })).toMatch(/a crew that's already out/);
    expect(rushOfferLine({ ...base, reached: 1, outToday: false })).toMatch(/posted it to the crew who/);
  });
});

describe("the action supplies the facts these sentences need", () => {
  it("counts assignments across the batch, not just the last day", () => {
    // `soloAssigned` was overwritten every iteration. A count survives.
    expect(actions, "no per-batch assignment count").toMatch(/assignedCount\s*(\+=|\+\+)/);
    expect(actions).toMatch(/batchBookedLine\s*\(/);
  });

  it("learns from the blast whom it reached", () => {
    // blastRushToCrews returned void; the sentence could not know.
    expect(actions, "blastRushToCrews still returns nothing").toMatch(/Promise<\{\s*reached:\s*number;\s*outToday:\s*boolean\s*\}>/);
    expect(actions).toMatch(/rushOfferLine\s*\(/);
    // And it actually COUNTS — the signature alone survives a blast that
    // always reports zero, which would make every rush say "hunting".
    const blast = actions.slice(actions.indexOf("async function blastRushToCrews"), actions.indexOf("async function blastRushToCrews") + 4000);
    expect(blast, "the blast never increments reached").toMatch(/reached\s*(\+=\s*1|\+\+)/);
    expect(blast, "outToday is never set from the query").toMatch(/outToday\s*=\s*crewIds\.length\s*>\s*0/);
  });

  it("no longer hardcodes either sentence", () => {
    expect(actions).not.toMatch(/locked in — \$\{prettyDateList/);
    expect(actions).not.toMatch(/offering it to crews already out on your lake right now/);
  });
});
