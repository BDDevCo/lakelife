import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NoCrewToAssign } from "./JobBoard";
import { crewListsService } from "@/lib/crew-services";

/**
 * THE MANUAL OVERRIDE, IN THE STATE PRODUCTION IS ACTUALLY IN.
 *
 * `getActiveVendors` fences test accounts out of the override dropdown —
 * correctly, and under a comment saying this is the fallback ops reaches for
 * precisely when auto-dispatch finds nobody. All three production vendors are
 * test accounts, so the list is empty today and stays empty until a real crew
 * activates. Both override modals drew an inert "Choose a vendor…", a disabled
 * Confirm, a cost field, a margin preview and a footer still explaining how
 * payout releases — and not one word about why nothing could be chosen. The
 * one screen that answers "why is there nobody" is the coverage card, on a
 * different tab.
 *
 * Two doorways, one sentence: the board's modal and the job file's.
 */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
/** Comments stripped — a rule that only exists in prose enforces nothing. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const jobBoard = code("./JobBoard.tsx");
const jobFile = code("./JobFile.tsx");

describe("the files this scan reads", () => {
  it("found both components with their comments removed", () => {
    // A scan of an empty string passes everything.
    expect(jobBoard.length).toBeGreaterThan(2000);
    expect(jobFile.length).toBeGreaterThan(2000);
    expect(jobBoard).not.toContain("A FOURTH COPY of the rule");
    expect(jobBoard).toContain("AssignModal");
    expect(jobFile).toContain("AssignModal");
  });
});

describe("with nobody to assign, the modal says so", () => {
  const html = renderToStaticMarkup(
    <NoCrewToAssign title="Lawn Mowing" subtitle="1 Lake Rd · Mike" onClose={() => {}} />,
  );

  it("names the state and the one action that changes it", () => {
    expect(html).toContain("No crew can be assigned by hand.");
    expect(html).toContain("no active crew with insurance on file");
    expect(html).toContain("Crews tab");
  });

  it("does not describe a transaction that cannot start", () => {
    // The cost field, the margin preview and the payout footer all belong to a
    // job that is about to be scheduled. Nothing is about to be scheduled.
    expect(html).not.toContain("Margin");
    expect(html).not.toContain("Payout releases");
    expect(html).not.toContain("Confirm &amp; notify crew");
  });

  it("is true whatever the cause, so it cannot go stale on the first real crew", () => {
    // The coverage card's sentence — "every vendor on the platform is a test
    // account" — is computed from numbers these modals never receive, and it
    // would be false the day a real crew is invited but not yet activated.
    expect(html).not.toContain("test account");
  });

  it("promises no control it does not have — the ops tabs are not links", () => {
    expect(html).not.toContain("<a ");
  });
});

describe("both override doorways take the branch", () => {
  it("the jobs board's modal bails out before the form", () => {
    const at = jobBoard.indexOf("if (vendors.length === 0)");
    const form = jobBoard.indexOf("Vendor cost (customer pays");
    expect(at, "the board's override has no empty-list branch").toBeGreaterThan(-1);
    expect(form, "the cost field moved — this scan is stale").toBeGreaterThan(-1);
    expect(at, "the branch must come before the form it replaces").toBeLessThan(form);
    expect(jobBoard.slice(at, form)).toContain("NoCrewToAssign");
  });

  it("the job file's modal does too, using the SAME sentence", () => {
    const at = jobFile.indexOf("if (vendors.length === 0)");
    const form = jobFile.indexOf("Crew cost (customer pays");
    expect(at, "the job file's override has no empty-list branch").toBeGreaterThan(-1);
    expect(form, "the cost field moved — this scan is stale").toBeGreaterThan(-1);
    expect(at).toBeLessThan(form);
    expect(jobFile.slice(at, form)).toContain("NoCrewToAssign");
    // Imported, not re-typed: a second copy is free to be half-corrected.
    expect(jobFile).toMatch(/import \{ NoCrewToAssign \} from "@\/components\/ops\/JobBoard";/);
  });
});

/**
 * A CREW WHO LISTS NOTHING IS OFFERED NOTHING — the fourth copy.
 *
 * CrewBoard, ops/data.ts and JobFile were corrected together; this board was
 * missed, so the same crew sorted FIRST here with no annotation and LAST one
 * click away on the job file. The router settles it: dispatch pools only crews
 * whose service_types INCLUDES the job's name, so an empty list is offered
 * nothing, ever.
 *
 * THERE IS NO FOURTH COPY NOW. Both boards call one helper,
 * lib/crew-services.ts, and the ops/data.ts copy went out with the dead
 * function it lived in. So this asks for the CALL rather than for the rule
 * written out again — a re-typed local `serviceOk` is the way this comes back,
 * and it would slip past a scan looking for the right words.
 */
describe("the two crew pickers answer the same way", () => {
  it("an empty service list matches nothing on either screen", () => {
    // The rule, run for real rather than read.
    expect(crewListsService([], "Weekly mow & blow")).toBe(false);
    expect(crewListsService(["mow"], "Weekly mow & blow")).toBe(true);
    // And both screens asking it, neither keeping an answer of its own.
    for (const src of [jobBoard, jobFile]) {
      expect(src).toMatch(/import \{ crewListsService \} from "@\/lib\/crew-services";/);
      expect(src, "a screen has grown its own copy of the rule back").not.toMatch(/function serviceOk/);
      expect(src).toMatch(/crewListsService\(v\.service_types,/);
    }
  });

  it("and says which kind of nothing it is, in the same words", () => {
    for (const src of [jobBoard, jobFile]) {
      expect(src).toContain("lists no services at all");
      expect(src).toContain("doesn't list this service");
    }
  });

  it("the COI hint is still a hint, not a second gate", () => {
    // crew-services.ts states this is an annotation: ops may assign a crew
    // whose service list is empty. The only hard block on the option is the COI.
    expect(jobBoard).toContain("disabled={!v.coi_ok}");
    expect(jobFile).toContain("disabled={!v.coi_ok}");
  });
});
