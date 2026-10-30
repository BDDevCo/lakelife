import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TodayView } from "@/app/park/today-actions";
import type { ReadinessRow } from "@/app/park/readiness";

/**
 * THE MORNING SCREEN'S ORDER, with the three new things on it: the first-run
 * card (under the dead-man line, above the findings), the readiness list (in
 * the money card's place before go-live, under it otherwise), and the one
 * "crews on site" line (only above zero).
 *
 * ---------------------------------------------------------------------------
 * REPOINTED 29 OCTOBER 2026, ON THE OWNER'S DECISION
 * ---------------------------------------------------------------------------
 * This file pinned one column with the money card above the tasks. The
 * component's own header comment had claimed the opposite — tasks first on a
 * phone, side by side on a desktop with tasks on the left — for months, and
 * the October design review drew the comment's version.
 *
 * A tested order is a decision, so it was not reversed to match a drawing: it
 * was put to the owner, who chose tasks first. The screen is now two columns
 * (`.ll-grid`, which collapses in source order below 900px), what needs him
 * on the left and what happened on the right.
 *
 * TWO ASSERTIONS BELOW USED "Your own list" AS THEIR TAIL ANCHOR, and it has
 * moved from the bottom of the screen to the left column. Both are repointed
 * to what they were each actually about — the readiness list follows the
 * money card, the crews line follows them both — and those relationships are
 * unchanged, because the status column's internal order did not move. The
 * thing that DID change gets its own assertion, which neither of them had.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/park/today-actions", () => ({
  snoozeTask: async () => ({ ok: true }),
  dismissTask: async () => ({ ok: true }),
  addNote: async () => ({ ok: true }),
  doneNote: async () => ({ ok: true }),
}));

const { ParkToday } = await import("./ParkToday");

const rows: ReadinessRow[] = [
  { key: "lots", done: true, optional: false, label: "21 lots on file", next: null, href: "/park/lots" },
  { key: "published", done: false, optional: false, label: "Not published — only you can see it", next: "'Publish my park' on the Rent roll, once the lots and rates look right", href: "/park" },
];

const view = (over: Partial<TodayView> = {}): TodayView => ({
  parkName: "Cedar Hollow",
  today: "2026-09-16",
  month: "2026-09",
  money: {
    headline: "$4,325.00 in so far this month.",
    todayLine: null, ledgerLine: "18 of 21 bills paid.", arrearsLine: null, disputedLine: null, clearingLine: null, offBookLine: null,
  },
  occupancy: { main: "18 of 21 lots taken.", sub: null },
  tasks: [],
  notes: [],
  quiet: null,
  liveness: { state: "fresh", line: "Checked last night.", alarm: null, brokenRunners: [] },
  findings: [{ kind: "unbilled", urgent: false, line: "3 occupied lots have no bill this month." }],
  firstRun: null,
  beforeGoLive: false,
  readiness: null,
  crewsOnSite: 0,
  ...over,
});

const FIRST_RUN: NonNullable<TodayView["firstRun"]> = {
  heading: "Welcome to LakeLife 🌊",
  parkLine: "Cedar Hollow",
  stateLine: "21 lots on file · nobody filed on them yet.",
  contactLine: "Nothing is published and nobody has been contacted. It's sitting here waiting for you to say it's right.",
  listLine: "2 things left on the list. You can stop anywhere and pick it back up.",
  cta: { label: "Let's look at it", href: "/park/onboard" },
  alt: null,
};

const render = (v: TodayView) => renderToStaticMarkup(<ParkToday parkId="p1" view={v} />);
const order = (html: string, ...needles: string[]) => {
  const at = needles.map((n) => {
    const i = html.indexOf(n);
    if (i < 0) throw new Error(`not in markup: ${n}`);
    return i;
  });
  for (let i = 1; i < at.length; i++) expect(at[i], `${needles[i]} should follow ${needles[i - 1]}`).toBeGreaterThan(at[i - 1]);
};

describe("the first-run card", () => {
  it("sits under the dead-man alarm and above the findings, with the fixture's door and a dismissal", () => {
    const html = render(view({ firstRun: FIRST_RUN, liveness: { state: "never_ran", line: "", alarm: "The evening check hasn't run.", brokenRunners: [] } }));
    order(html, "<h1", "The evening check hasn&#x27;t run.", "Welcome to LakeLife", "Last night&#x27;s check turned", "$4,325.00 in so far");
    expect(html).toContain('<a class="ll-btn" href="/park/onboard">Let&#x27;s look at it</a>');
    expect(html).toContain("Nothing is published and nobody has been contacted.");
    expect(html).toContain("Don&#x27;t show this again");
    expect(html).not.toContain("or load a rent roll");
  });
  it("offers the roll door when the card carries one", () => {
    const html = render(view({ firstRun: { ...FIRST_RUN, alt: { label: "or load a rent roll", href: "/park/import" } } }));
    expect(html).toContain('<a class="ll-btn ghost" href="/park/import">or load a rent roll</a>');
  });
  it("is absent when null", () => {
    expect(render(view())).not.toContain("Welcome to LakeLife");
  });
});

describe("the readiness list", () => {
  const readiness = { headline: "Cedar Hollow — 107 days to go-live.", sub: "You go live on January 1, 2027. The first month you bill is January 2027; money handed in before that goes on account.", rows };
  it("before go-live it stands where the money card would, and there is no money headline", () => {
    const html = render(view({ beforeGoLive: true, readiness }));
    expect(html).toContain("107 days to go-live.");
    expect(html).toContain("21 lots on file");
    expect(html).not.toContain("$4,325.00 in so far");
  });
  it("otherwise it follows the money card", () => {
    const html = render(view({ readiness: { ...readiness, headline: "Getting Cedar Hollow ready", sub: "1 of 2 done." } }));
    // Both live in the status column, in that order. The old third anchor
    // here was "Your own list", which is in the other column now and was
    // never what this test was about.
    order(html, "$4,325.00 in so far", "Getting Cedar Hollow ready");
    expect(html).toContain('<a href="/park">');
  });
  it("null: neither", () => {
    const html = render(view());
    expect(html).not.toContain("go-live");
    expect(html).not.toContain("Getting Cedar Hollow ready");
  });
});

describe("crews on site", () => {
  it("zero: no line", () => {
    expect(render(view())).not.toContain("on site today");
  });
  it("two: the whole sentence is the link, and it is last in the status column", () => {
    const html = render(view({
      crewsOnSite: 2, tasks: [],
      readiness: { headline: "Getting Cedar Hollow ready", sub: "1 of 2 done.", rows },
    }));
    expect(html).toContain('<a href="/park/visits">2 crews on site today — see who</a>');
    // Money, then the readiness list, then this line — the column's own
    // order, which the two-column change did not touch.
    order(html, "$4,325.00 in so far", "Getting Cedar Hollow ready", "2 crews on site today");
  });
});

describe("the tasks come before the money", () => {
  /**
   * THE ORDER THE OWNER CHOSE, 29 October 2026. `.ll-grid` collapses in
   * source order below 900px, so this single assertion covers both widths:
   * on a desktop it is the left column, on a phone it is what he reads first.
   */
  it("a task is earlier in the markup than the money card", () => {
    const html = render(view({
      tasks: [{
        key: "k1", kind: "bill", urgency: "soon", title: "ZZ-TASK-TITLE",
        body: "", href: "/park/rent", cta: null, due: null,
      }] as unknown as TodayView["tasks"],
    }));
    order(html, "ZZ-TASK-TITLE", "$4,325.00 in so far");
  });

  it("and so does his own list, which is in the same column", () => {
    order(render(view()), "Your own list", "$4,325.00 in so far");
  });

  /**
   * THE TWO ASSERTIONS ABOVE PIN SOURCE ORDER, AND SOURCE ORDER ALONE.
   * Found by mutation: replacing `.ll-grid` with a bare <div> leaves the
   * markup in exactly the same order and both of them still pass — the
   * screen just quietly stops being two columns and becomes one tall one.
   * A scan proves presence, never reachability, so the class and the rule
   * behind it are checked too.
   */
  it("in a grid that is two columns on a desktop and one on a phone", () => {
    const html = render(view());
    expect((html.match(/class="ll-grid"/g) ?? []).length,
      "the two columns are not in a grid any more").toBe(1);

    const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
    const blocks = [...css.matchAll(/\.ll-grid \{([^}]*)\}/g)].map((m) => m[1]);
    expect(blocks.length, "expected a base .ll-grid and its collapse").toBe(2);
    expect(blocks[0], "the base grid is no longer two columns")
      .toMatch(/grid-template-columns:\s*minmax\([^)]*\)\s*minmax/);
    expect(blocks[1], "the phone no longer collapses to one column — which is what puts the tasks above the money")
      .toMatch(/grid-template-columns:\s*1fr/);
  });
});

describe("by source", () => {
  it("no preCutover identifier remains; the list and the line come from their helpers", () => {
    const src = readFileSync(fileURLToPath(new URL("./ParkToday.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(src).not.toContain("preCutover");
    expect(src).toMatch(/import \{ ParkReadiness \} from "@\/components\/ParkReadiness"/);
    expect(src).toMatch(/import \{ crewsOnSiteLine \} from "@\/app\/park\/visits-helpers"/);
    expect(src).toMatch(/dismissTask\(parkId, firstRunTaskKey\(parkId\), ""\)/);
  });
});
