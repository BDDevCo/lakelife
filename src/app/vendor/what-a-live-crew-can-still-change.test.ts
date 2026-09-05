import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { activationGaps, type ActivationInput } from "./onboarding-helpers";

/**
 * GOING LIVE TOOK AWAY THE SCREEN WHERE YOU SAY WHAT YOU DO.
 *
 * `activationGaps` names seven things a crew must settle before they can work.
 * Six of them have a control an ACTIVE crew (or ops) can still reach. One does
 * not: the work they do. `setServiceTypes` has exactly one caller —
 * VendorOnboarding — and all six vendor pages that render it do so only while
 * `status !== "active"`. Ops has no writer either; the Crews board draws
 * service types as read-only pills. So the list is frozen at the moment of
 * go-live and takes a database edit to change.
 *
 * WHY IT BITES THE HAVEN FIRST, which is why this is being fixed now.
 *
 * Production's active service list carries BOTH "Lawn mowing & trim" (a lake
 * house's lawn) and "Park grounds mowing & trim" (park_only, priced per lot
 * from the park's own rate). They arrive as adjacent chips in one flat list
 * with nothing to tell them apart. `isEligible` and `canClaim` both match on
 * exact membership — `c.serviceTypes.includes(input.serviceName)` — so a crew
 * Brendon recruits to mow The Haven who taps the lake-house one is invisible
 * to every park mow, forever, and neither of them has a screen that fixes it.
 *
 * It compounds with ops' force-activate: `docsComplete` on the Crews board
 * tests the two documents only, so a crew can be pushed live with NO service
 * types at all — and activation is what removes the screen where they'd be set.
 * Permanently active, permanently unroutable.
 *
 * SO THE TEST IS THE RULE, NOT THE INSTANCE: anything activation can refuse
 * you for must stay changeable afterwards. Otherwise the gate is a trapdoor.
 */

const src = (rel: string) =>
  stripComments(readFileSync(join(process.cwd(), "src", rel), "utf8"));

/** Comments state intent; only code counts. This file's own prose names every
 *  symbol it is checking for, and so do the fixes it guards. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}

const ALL = sources(join(process.cwd(), "src"))
  .map((f) => stripComments(readFileSync(f, "utf8")))
  .join("\n");

/** A crew who has settled nothing — every gap fires. */
const NOTHING: ActivationInput = {
  coi_url: null, coi_expiry: null, coi_named_insured: null, company: null,
  w9_url: null, service_types: null, service_lakes: null, daily_capacity: null,
};

/**
 * Each requirement activation can refuse, and the writer that must remain
 * reachable to a crew who is ALREADY live. `screen` is where that writer is
 * called from — a server action with no caller is not a control.
 */
const AFTER_GO_LIVE = [
  {
    gap: /insurance certificate|COI/i,
    writer: "uploadVendorDoc",
    screen: "components/VendorDocs.tsx",
    rendered: "app/vendor/page.tsx",
    why: "a COI expires every year — this is the most-used control on the crew side",
  },
  {
    gap: /W-9/,
    writer: "uploadVendorDoc",
    screen: "components/VendorDocs.tsx",
    rendered: "app/vendor/page.tsx",
    why: "a new EIN or a new entity means a new W-9",
  },
  {
    gap: /kind of work you do/i,
    writer: "setServiceTypes",
    screen: "components/MyServicesEditor.tsx",
    rendered: "app/vendor/availability/page.tsx",
    why:
      "prod offers both 'Lawn mowing & trim' and 'Park grounds mowing & trim' " +
      "as adjacent chips; picking the wrong one hides every Haven mow job",
  },
  {
    gap: /lakes you service/i,
    writer: "setServiceLakes",
    screen: "components/MyLakesEditor.tsx",
    rendered: "app/vendor/availability/page.tsx",
    why: "a crew's coverage grows — this one was already right, and is the model",
  },
] as const;

describe("the gate still refuses all of these", () => {
  // If a gap stops firing, the row below it silently guards nothing.
  const gaps = activationGaps(NOTHING, "2026-09-05");
  it("names every requirement we are about to check for a way back", () => {
    for (const { gap } of AFTER_GO_LIVE) {
      expect(
        gaps.some((g) => gap.test(g)),
        `activationGaps no longer refuses ${gap} — this row is measuring nothing`,
      ).toBe(true);
    }
  });
});

describe("anything activation can refuse you for stays changeable afterwards", () => {
  for (const { gap, writer, screen, rendered, why } of AFTER_GO_LIVE) {
    it(`${writer} — ${why}`, () => {
      const control = src(screen);
      expect(
        control,
        `${screen} does not call ${writer}, so "${gap}" has no control after ` +
          `go-live. A gate you cannot walk back through is a trapdoor.`,
      ).toMatch(new RegExp(`${writer}\\(`));

      // AND THE PAGE HAS TO RENDER IT. A component nothing mounts is the same
      // silence as no component — the shape of half the bugs in this repo.
      const page = src(rendered);
      const tag = screen.split("/").pop()!.replace(/\.tsx$/, "");
      expect(
        page,
        `${rendered} never renders <${tag}>, so the control exists but nobody ` +
          `can reach it.`,
      ).toMatch(new RegExp(`<${tag}[\\s/>]`));
    });
  }

  it("and that page is one a LIVE crew can actually open", () => {
    // The six pages that render VendorOnboarding all return early on
    // `status !== "active"`. /vendor/availability deliberately does not — it is
    // the crew's settings page — which is the whole reason the editors live
    // there. If that early return ever appears here, every control above
    // becomes unreachable at exactly the moment it is needed.
    expect(
      src("app/vendor/availability/page.tsx"),
      "the settings page now hides itself from active crews",
    ).not.toMatch(/status !== "active"/);
  });
});

describe("a crew forced live by ops is not stranded", () => {
  /**
   * `docsComplete` gates the Force-activate button on the two documents only,
   * while `finishOnboarding` additionally requires service types, lakes and a
   * capacity. That mismatch is deliberate — an override is meant to override
   * — but it only stays safe while the overridden fields can still be set.
   */
  it("the override really does skip the declarations", () => {
    const board = src("components/ops/CrewBoard.tsx");
    const gate = board.match(/const docsComplete =[\s\S]*?;/)?.[0] ?? "";
    expect(gate, "docsComplete is gone — this test measures nothing").not.toBe("");
    expect(gate).toMatch(/hasCoiDoc/);
    expect(gate, "if the override started checking work types, say so here")
      .not.toMatch(/serviceTypes|service_types/);
  });

  it("so the crew can put them right themselves", () => {
    // This is the sentence that makes the override safe, and it is the fix.
    expect(ALL).toMatch(/setServiceTypes\(/);
    expect(
      src("components/MyServicesEditor.tsx"),
      "no post-activation editor for work types — an override strands the crew",
    ).toMatch(/setServiceTypes\(/);
  });
});

describe("the crew is told which chips are park work", () => {
  /**
   * The two mowing services differ by ONE word and by which customer they
   * belong to. Nothing on the chip says so. A crew recruited for The Haven has
   * to guess, and guessing wrong is silent.
   */
  it("the editor separates park work from lake-home work", () => {
    const editor = src("components/MyServicesEditor.tsx");
    expect(
      editor,
      "the editor draws one flat list, so 'Lawn mowing & trim' and 'Park " +
        "grounds mowing & trim' sit side by side with nothing to tell them apart",
    ).toMatch(/parkOnly/);
  });

  it("and the page hands it the park flag, or the split is decoration", () => {
    const page = src("app/vendor/availability/page.tsx");
    expect(page, "the service query never reads park_only").toMatch(/park_only/);
    expect(page, "the flag is read but never passed to the editor").toMatch(/parkOnly/);
  });
});
