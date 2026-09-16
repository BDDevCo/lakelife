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
    todayLine: null, ledgerLine: "18 of 21 bills paid.", arrearsLine: null, disputedLine: null, offBookLine: null,
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
    order(html, "$4,325.00 in so far", "Getting Cedar Hollow ready", "Your own list");
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
  it("two: the whole sentence is the link, between the money card and Needs you", () => {
    const html = render(view({ crewsOnSite: 2, tasks: [] }));
    expect(html).toContain('<a href="/park/visits">2 crews on site today — see who</a>');
    order(html, "$4,325.00 in so far", "2 crews on site today", "Your own list");
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
