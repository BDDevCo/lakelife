import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activationGaps, type ActivationInput } from "./onboarding-helpers";
import { WORK_DAYS_IN_READING_ORDER } from "@/lib/crew-setup";

/**
 * SIX DAYS A WEEK WAS NEVER THEIR ANSWER.
 *
 * `vendors.work_days` defaulted to Mon-Sat from 0010. `isEligible` and
 * `canClaim` both gate on exactly that column -- `c.workDays.includes(weekday)`,
 * blocker "off_day" -- and the onboarding wizard never asked the question at
 * all. So the first real crew would have gone live claiming six days a week
 * whatever they said on the phone, and a Saturday job would have routed to them
 * with nothing on either screen to explain it.
 *
 * Identical in shape to the seeded `daily_capacity` of 1: a value nobody chose
 * SATISFYING the gate that exists to ask for it. Same two rules, same fix -- the
 * default becomes what is true on day one (0183: the empty week), and the
 * question becomes a real step.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = (rel: string) => strip(readFileSync(join(process.cwd(), "src", rel), "utf8"));
const migration = (name: string) =>
  readFileSync(join(process.cwd(), "supabase", "migrations", name), "utf8");

const READY: ActivationInput = {
  coi_url: "coi.pdf",
  coi_expiry: "2027-01-01",
  coi_named_insured: "Northshore Docks",
  company: "Northshore Docks",
  w9_url: "w9.pdf",
  service_types: ["Lawn mowing & trim"],
  service_lakes: ["lake-1"],
  work_days: ["Mon", "Tue", "Wed"],
  daily_capacity: 4,
};

describe("the gate actually asks which days -- both ways round", () => {
  it("passes a stated week and refuses an empty one", () => {
    // Collapse the condition BOTH ways. A test that only proves the gap fires
    // still passes when the gap has started firing for everybody.
    expect(activationGaps(READY, "2026-09-30")).toEqual([]);
    expect(activationGaps({ ...READY, work_days: [] }, "2026-09-30"))
      .toEqual(["Tell us which days you work"]);
    expect(activationGaps({ ...READY, work_days: null }, "2026-09-30"))
      .toEqual(["Tell us which days you work"]);
  });

  it("and the old default would have walked straight through it", () => {
    // THE BUG, STATED AS A TEST. Mon-Sat is a perfectly good answer -- the
    // defect was never the value, it was that nobody was asked. This row is
    // here so that re-seeding the default is visibly a no-op on the gate, and
    // the only thing standing between a crew and a week they never chose is
    // 0183 taking the default away.
    expect(activationGaps(
      { ...READY, work_days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] },
      "2026-09-30",
    )).toEqual([]);
  });
});

describe("nobody answers the question for them", () => {
  it("the database no longer hands an invited crew a working week", () => {
    const sql = migration("0185_six_days_a_week_was_never_their_answer.sql");
    expect(sql).toMatch(/alter column work_days set default '\{\}'::text\[\]/i);
    expect(sql, "the vocabulary is not constrained at the database")
      .toMatch(/vendors_work_days_known/);
  });

  it("and neither does the invitation", () => {
    const invite = src("app/ops/crews-invite.ts");
    const insert = invite.slice(invite.indexOf('.from("vendors").insert({'));
    const row = insert.slice(0, insert.indexOf("});") + 3);
    expect(row.length, "the scan is not reading the real insert").toBeGreaterThan(60);
    expect(row).toContain('status: "invited"');
    expect(row, "an invited crew is being handed a week they never gave")
      .toContain("work_days: []");
    expect(row, "the invite seeds actual days again").not.toMatch(/work_days:\s*\[\s*"/);
  });
});

describe("the wizard asks it before the go-live button", () => {
  const wizard = src("components/VendorOnboarding.tsx");

  it("the scan is reading the wizard", () => {
    expect(wizard).toContain("function GoLiveCard");
    expect(wizard).toContain("<CapacityStep");
  });

  it("there is a step, and it writes the column through the crew's own action", () => {
    expect(wizard, "no work-days step in the wizard").toContain("<WorkDayStep");
    expect(wizard, "the step does not call setWorkDays").toMatch(/setWorkDays\(/);
    expect(
      src("app/vendor/onboarding-actions.ts"),
      "setWorkDays has no writer -- a step that saves nothing",
    ).toMatch(/update\(\{ work_days:/);
  });

  it("and the go-live card cannot render until it is answered", () => {
    // THIS, not source order, is what "before the button" means. GoLiveCard is
    // behind `readyToGoLive`, readyToGoLive is activationGaps coming back empty,
    // and the wizard has to actually hand it the column for either to matter.
    expect(wizard).toMatch(/const readyToGoLive = gaps\.length === 0/);
    expect(wizard).toMatch(/readyToGoLive \? \(\s*<GoLiveCard/);
    expect(wizard, "the wizard never hands work_days to the gate")
      .toMatch(/work_days: vendor\.work_days/);
  });

  it("the chips are dispatch's seven days, not a fourth hand-typed list", () => {
    expect(wizard).toContain("WORK_DAYS_IN_READING_ORDER");
    expect(src("app/vendor/availability/WorkDayChips.tsx")).toContain("WORK_DAYS_IN_READING_ORDER");
    expect(WORK_DAYS_IN_READING_ORDER).toHaveLength(7);
  });
});

describe("and every other door to 'active' asks too", () => {
  const actions = src("app/ops/crews-actions.ts");
  const gate = actions.slice(
    actions.indexOf("async function assertRoutable"),
    actions.indexOf("export async function approveCrew"),
  );

  it("the scan is reading assertRoutable", () => {
    expect(gate.length).toBeGreaterThan(400);
    expect(gate).toContain("No W-9 on file");
  });

  it("ops cannot force a crew live on a week nobody stated", () => {
    expect(gate, "assertRoutable never reads work_days").toContain("work_days");
    expect(gate).toMatch(/days\.length === 0/);
  });
});

describe("a live crew cannot clear their week into silence", () => {
  it("toggleWorkDay refuses the last day", () => {
    const toggle = src("app/vendor/availability/actions.ts");
    expect(toggle, "clearing every chip writes an empty week and reports success")
      .toMatch(/next\.length === 0/);
  });

  it("and the fill-in digest stops advertising days nobody works", () => {
    // The `myDays.size > 0 &&` fail-open was correct while the column could
    // never be empty. Since 0183 it can, and it means "not asked yet".
    const auto = src("lib/automation.ts");
    expect(auto, "an empty week still reads as 'no filter' in the digest")
      .not.toMatch(/myDays\.size > 0 && !myDays\.has/);
    expect(auto).toMatch(/!myDays\.has\(wd\)/);
  });
});
