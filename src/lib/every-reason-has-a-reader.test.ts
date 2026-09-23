import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noCrewOnLake, NO_FIT_LABEL, decideDispatch, capabilityNoFit, type CrewCandidate } from "@/lib/dispatch";

/**
 * A REASON CODE NOBODY READS IS A COLUMN WITH NO WRITER, INVERTED.
 *
 * `decideDispatch` can return eight `reasonNoFit` values. Exactly ONE of them
 * — `all_full_or_blocked` — was read anywhere: book/actions.ts and
 * book/storage/actions.ts. The other seven fell off the end of the world, so a
 * Haven job that found no lake-ticked crew left no trace on any screen; it
 * simply sat in the requested pile with nothing saying why.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = (rel: string) => strip(readFileSync(join(process.cwd(), "src", rel), "utf8"));

describe("every reason a doorway can produce has words", () => {
  const dispatch = src("lib/dispatch.ts");

  it("the union and the label map name the same codes", () => {
    // Scanned from the TYPE, not from a list retyped here — a ninth code added
    // to the union with no label fails this, which is the whole point.
    const union = dispatch.match(/reasonNoFit\?:\s*([^;]+);/);
    expect(union, "the reasonNoFit union moved — this scanner is measuring nothing").toBeTruthy();
    const codes = [...(union as RegExpMatchArray)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(5);
    for (const c of codes) {
      expect(NO_FIT_LABEL[c as keyof typeof NO_FIT_LABEL], `no words for ${c}`).toBeTruthy();
    }
    expect(Object.keys(NO_FIT_LABEL).sort()).toEqual([...codes].sort());
  });

  it("the lake dead end names the lake tick, because that is the cure", () => {
    expect(NO_FIT_LABEL.no_crew_on_lake).toMatch(/ticked this lake/i);
  });

  it("a person actually reads it — the ops job file and the page render it", () => {
    const opsData = src("app/ops/job-detail-data.ts");
    const opsPage = src("app/ops/jobs/[id]/page.tsx");
    expect(opsData).toContain("NO_FIT_LABEL");
    expect(opsPage).toContain("file.noCrewReason");
  });

  it("and the ops board asks the ENGINE's question, not a copy of it", () => {
    const board = src("app/ops/dispatch-data.ts");
    expect(board).toContain("noCrewOnLake(");
    expect(board).toContain("NO_FIT_LABEL.no_crew_on_lake");
  });

  /**
   * A LABEL IS NOT A READER, AND THIS FILE'S NAME PROMISED ONE.
   *
   * The first version of this suite asserted only that every code had an
   * ENTRY IN THE MAP. Six of the eight sentences were written for nobody: a
   * ninth code could be added with a label and no call site and pass. The
   * reader that closed the gap is `retryAssign` — the one doorway where a
   * person presses a button and the engine answers live — which used to drop
   * `reasonNoFit` on the floor and toast "recruit one for this lake" for all
   * eight, including a full calendar and an unpriced crew already on the lake.
   */
  it("EVERY code can reach a screen, through retryAssign's whyNot", () => {
    const action = src("app/ops/dispatch-actions.ts");
    // It must index the shared map by the engine's own code — not retype a
    // list, which is what drifts.
    expect(action).toMatch(/NO_FIT_LABEL\[\s*code\s*\]/);
    expect(action).toMatch(/reasonNoFit/);
    // And the button must render the answer rather than its own sentence.
    const card = src("components/ops/NeedsAttention.tsx");
    expect(card).toMatch(/res\.whyNot/);
    expect(
      card,
      "the toast hardcoded 'recruit one for this lake' for all eight reasons",
    ).not.toMatch(/Still no crew fits/);
  });

  it("the two verdicts that are NOT a reason code still get words", () => {
    // autoAssignJob can refuse with no `reasonNoFit` at all: a price hold
    // (a crew IS available, at a number the customer didn't agree to) and
    // pricedToZero. Both used to fall through to the recruiting sentence.
    const action = src("app/ops/dispatch-actions.ts");
    expect(action).toMatch(/priceHeld/);
    expect(action).toMatch(/pricedToZero/);
  });
});

describe("the capability verdict is one function, not three copies of it", () => {
  it("decideDispatch asks capabilityNoFit rather than inlining the branch", () => {
    const dispatch = src("lib/dispatch.ts");
    expect(dispatch).toMatch(/capabilityNoFit\(input\.crews, input\)/);
  });

  it("and the ops job file asks the same function, plus the engine's paperwork gate", () => {
    const opsData = src("app/ops/job-detail-data.ts");
    expect(opsData).toMatch(/capabilityNoFit\(/);
    // canEverDo carries the named-insured test (0152) the hand-rolled copy
    // here dropped, so a crew routed on somebody else's certificate could be
    // counted as covering the lake.
    expect(opsData).toMatch(/canEverDo\(/);
  });

  it("a PACKAGE leg gap is named as coverage, not as an empty lake", () => {
    // The hand-rolled reader judged `header.serviceName` alone, so a grouped
    // visit with a pier crew here and an opening crew elsewhere printed
    // "recruiting is the unblock" — the wrong cure for a coverage gap.
    const crew = (types: string[], lakes: string[]) => ({ serviceTypes: types, serviceLakes: lakes });
    expect(
      capabilityNoFit(
        [crew(["Pier install / removal"], ["lake-pretty"])],
        { serviceName: "Spring opening", componentNames: ["Spring opening", "Pier install / removal"], lakeId: "lake-pretty" },
      ),
    ).toBe("no_full_coverage_crew");
    // Collapsed the other way: nobody on the lake at all is still the lake.
    expect(
      capabilityNoFit(
        [crew(["Spring opening", "Pier install / removal"], ["lake-turkey"])],
        { serviceName: "Spring opening", componentNames: ["Spring opening", "Pier install / removal"], lakeId: "lake-pretty" },
      ),
    ).toBe("no_crew_on_lake");
    // And a crew who covers every leg on the lake is no capability problem.
    expect(
      capabilityNoFit(
        [crew(["Spring opening", "Pier install / removal"], ["lake-pretty"])],
        { serviceName: "Spring opening", componentNames: ["Spring opening", "Pier install / removal"], lakeId: "lake-pretty" },
      ),
    ).toBeNull();
  });
});

describe("a dead job is not a recruiting alarm", () => {
  it("the ops job file asks whether the job is still looking", () => {
    // Production held five CANCELLED, unassigned jobs the day this was
    // written; each opened with "recruiting is the unblock" under Crew.
    const opsData = src("app/ops/job-detail-data.ts");
    expect(opsData).toMatch(/stillLooking/);
    expect(opsData).toMatch(/!job\.vendor_id && stillLooking/);
  });
});

describe("noCrewOnLake is the test decideDispatch itself runs", () => {
  const crew = (lakes: string[]): Pick<CrewCandidate, "serviceLakes"> => ({ serviceLakes: lakes });

  it("true when nobody has ticked the lake", () => {
    expect(noCrewOnLake([crew(["lake-turkey"])], "lake-pretty")).toBe(true);
  });

  it("false the moment one crew has", () => {
    expect(noCrewOnLake([crew(["lake-turkey"]), crew(["lake-pretty"])], "lake-pretty")).toBe(false);
  });

  it("false when there is no lake to fail on", () => {
    expect(noCrewOnLake([crew([])], null)).toBe(false);
  });

  it("the engine returns no_crew_on_lake through it", () => {
    const base: CrewCandidate = {
      vendorId: "v1", status: "active", coiExpiry: "2099-01-01", coiNamedInsured: "Josh's Lawn Care",
      company: "Josh's Lawn Care", serviceTypes: ["Lawn mowing & trim"], serviceLakes: ["lake-turkey"],
      workDays: ["Mon", "Tue", "Wed", "Thu", "Fri"], dailyCapacity: 5, assignedThatDay: 0,
      blockedThatDay: false, crewRate: 100,
    } as unknown as CrewCandidate;
    const decision = decideDispatch({
      crews: [base], serviceName: "Lawn mowing & trim", lakeId: "lake-pretty",
      todayISO: "2026-09-23", dateISO: "2026-10-01", menuPrice: 200, marginFloor: 0.2,
      marginPct: 0.2,
    } as never);
    expect(decision.ok).toBe(false);
    expect(decision.reasonNoFit).toBe("no_crew_on_lake");
  });
});
