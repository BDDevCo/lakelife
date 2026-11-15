import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/**
 * SIX TABS, A PILL ROW, AND A BUTTON THAT IS NOT A TAB.
 *
 * The park owner's strip went from thirteen tabs to the six his blueprint
 * drew. Nothing moved: every screen keeps its file and URL, and the ones
 * that were folded under a tab are reached by a pill row beneath the strip.
 * What this pins is the part that only shows on screen — that EVERY park
 * route lights exactly one tab, that a route in NO list lights nothing (the
 * bare "/park" is exact, or it would claim every unlisted route for Renters
 * › Rent roll and the per-route test could never fail), that a grouped tab
 * lights exactly one pill, and that the word on a pill is the word on the
 * screen it opens.
 *
 * The routes are read from the filesystem, never typed here: a new
 * `page.tsx` under /park is judged the moment it exists, which is the point.
 */

let pathname = "/park";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
// The POS package's client component. ParkNav only places it; what it does
// on tap is that package's test.
vi.mock("@/components/TakePayment", () => ({
  TakePayment: ({ parkId }: { parkId: string }) => (
    <button className="ll-btn gold" data-park={parkId}>⊕ Take a payment</button>
  ),
}));

const { ParkNav, TABS, matchLength, activeIndex } = await import("./ParkNav");

const here = fileURLToPath(new URL("./", import.meta.url));
const appPark = join(here, "..", "app", "park");

/** Every page.tsx under src/app/park, mapped to the route it serves. A
    dynamic segment gets a sample value; a route group would be dropped. */
function routes(): { file: string; route: string }[] {
  const out: { file: string; route: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "page.tsx") {
        const rel = relative(appPark, dir).split("/").filter(Boolean)
          .filter((seg) => !/^\(.*\)$/.test(seg))
          .map((seg) => (/^\[.*\]$/.test(seg) ? "b4f1c2" : seg));
        out.push({ file: relative(here, p), route: ["/park", ...rel].join("/") });
      }
    }
  };
  walk(appPark);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

const park = { id: "park-1", name: "Any Park", active: false };

function render(at: string) {
  pathname = at;
  return renderToStaticMarkup(<ParkNav park={park} />);
}

/** The anchors marked current, split into column entries and pills.
 *
 * REPOINTED 29 Oct, when the strip became the workspace column: the anchor
 * body used to be `[^<]*`, which is text and nothing else, and a column entry
 * now carries a `<span>` glyph beside its word. The scanner was reading zero
 * current anchors on every route and the fifteen per-route assertions were
 * passing over an empty list. What is checked is unchanged — one entry lit
 * per route, one pill lit under a grouped one. */
function current(html: string) {
  const anchors = html.match(/<a\b[^>]*aria-current="page"[^>]*>.*?<\/a>/g) ?? [];
  // The decorative glyph goes first: it is `aria-hidden`, so it is not part
  // of the entry's name, and leaving it in made every label read "◷Today".
  const label = (a: string) =>
    a.replace(/<span[^>]*aria-hidden[^>]*>.*?<\/span>/g, "")
      .replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
  const tabs = anchors.filter((a) => !/class="ll-subtab/.test(a)).map(label);
  const pills = anchors.filter((a) => /class="ll-subtab on"/.test(a)).map(label);
  return { tabs, pills };
}

describe("the scanner is reading real routes", () => {
  it("found the park pages, including the dynamic one", () => {
    const rs = routes();
    expect(rs.length).toBeGreaterThanOrEqual(14);
    expect(rs.map((r) => r.route)).toContain("/park");
    expect(rs.map((r) => r.route)).toContain("/park/import/b4f1c2");
  });
});

describe("the strip is the six his blueprint drew", () => {
  it("in that order, with those words", () => {
    expect(TABS.map((t) => t.label)).toEqual([
      "Today", "Renters", "Money", "On site", "Lots & rates", "Park setup",
    ]);
  });

  it("every tab's own href is in its matches, and every pill's is too", () => {
    for (const t of TABS) {
      expect(t.matches, t.label).toContain(t.href);
      for (const p of t.pills ?? []) expect(t.matches, `${t.label} › ${p.label}`).toContain(p.href);
    }
  });

  it("no two tabs claim the same route", () => {
    const all = TABS.flatMap((t) => t.matches);
    expect(new Set(all).size).toBe(all.length);
  });

  it("a grouped tab's first pill is the tab's own landing screen", () => {
    // Tapping the tab and tapping its first pill land in the same place, so
    // the strip never opens a screen the row underneath does not name.
    for (const t of TABS) if (t.pills) expect(t.pills[0].href).toBe(t.href);
  });
});

describe("matching is by path segment, most specific wins", () => {
  it("a route is under its own prefix and under its parents", () => {
    expect(matchLength("/park/statements", "/park/statements")).toBe(16);
    expect(matchLength("/park/statements/export", "/park/statements")).toBe(16);
    expect(matchLength("/park/onboard", "/park/onboard")).toBe(13);
  });

  it("except the bare /park, which is exact: its own route and nothing under it", () => {
    // "/park" is a prefix of every park route. As a prefix it would light
    // Renters › Rent roll on any route nobody listed.
    expect(matchLength("/park", "/park")).toBe(5);
    expect(matchLength("/park/onboard", "/park")).toBe(-1);
    expect(matchLength("/park/zz-not-a-route", "/park")).toBe(-1);
  });

  it("but not under a prefix that merely shares letters", () => {
    // The defect the old special case existed to dodge, done properly.
    expect(matchLength("/park/rent", "/park/re")).toBe(-1);
    expect(matchLength("/parks/my", "/park")).toBe(-1);
  });

  it("the longest prefix takes it, and nothing lights on a stranger", () => {
    const deep = "/park/statements/export";
    expect(activeIndex(deep, [["/park/statements"], ["/park/statements/export"]])).toBe(1);
    expect(activeIndex(deep, [["/park/statements/export"], ["/park/statements"]])).toBe(0);
    expect(activeIndex("/vendor", [["/park"], ["/park/onboard"]])).toBe(-1);
    expect(activeIndex("/park/zz-not-a-route", [["/park"], ["/park/onboard"]])).toBe(-1);
  });
});

describe("every park route lights exactly one tab", () => {
  for (const r of routes()) {
    it(r.route, () => {
      const { tabs, pills } = current(render(r.route));
      expect(tabs, `${r.file} lit ${tabs.length} tabs`).toHaveLength(1);
      const tab = TABS.find((t) => t.label === tabs[0])!;
      expect(tab, `${tabs[0]} is not a tab`).toBeTruthy();
      if (tab.pills) {
        expect(pills, `${r.file} under ${tab.label} lit ${pills.length} pills`).toHaveLength(1);
      } else {
        expect(pills).toHaveLength(0);
      }
    });
  }

  it("a stranger to the park lights nothing, rather than the first tab", () => {
    const { tabs, pills } = current(render("/vendor"));
    expect(tabs).toHaveLength(0);
    expect(pills).toHaveLength(0);
  });

  it("a park route in no list lights nothing — not Renters › Rent roll", () => {
    // The test above never touched the "/park" prefix, so a new page.tsx that
    // nobody added to a list lit Renters › Rent roll and passed the per-route
    // test with one tab and one pill. This is the negative that per-route
    // test needs to mean anything.
    for (const stranger of ["/park/zz-not-a-route", "/park/zz-not-a-route/deeper"]) {
      const { tabs, pills } = current(render(stranger));
      expect(tabs, stranger).toHaveLength(0);
      expect(pills, stranger).toHaveLength(0);
    }
  });
});

describe("the pill row", () => {
  it("is drawn under a grouped tab and not under a single one", () => {
    expect(render("/park/rent")).toMatch(/class="ll-subtab on"/);
    expect(render("/park/today")).not.toMatch(/ll-subtab/);
  });

  it("is links and nothing else", () => {
    const html = render("/park/costs");
    const row = html.slice(html.indexOf('class="ll-subtab'));
    expect(row).not.toMatch(/<(button|select|details|summary)\b/);
    expect((row.match(/class="ll-subtab/g) ?? []).length).toBe(3);
  });

  it("the lit pill is the screen he is on, not the tab's landing screen", () => {
    expect(current(render("/park/onboard")).pills).toEqual(["Who lives here"]);
    expect(current(render("/park")).pills).toEqual(["Rent roll"]);
    expect(current(render("/park/statements/export")).pills).toEqual(["Statements"]);
    expect(current(render("/park/import/b4f1c2")).pills).toEqual(["Load the roll"]);
  });
});

describe("a pill's label is the h1 of the screen it opens", () => {
  // The screens whose title is a fixed string. Rent's h1 carries the month
  // and Load the roll's screen opens on "Your rent roll starts here" — those
  // two are pinned as words.
  const h1Of: Record<string, string> = {
    "/park": "ParkRentRoll.tsx",
    "/park/onboard": "ParkOnboard.tsx",
    "/park/documents": "ParkDocuments.tsx",
    "/park/costs": "ParkCosts.tsx",
    "/park/statements": "ParkStatements.tsx",
    "/park/visits": "../app/park/visits/page.tsx",
    "/park/services": "ParkServices.tsx",
    "/park/lots": "ParkLots.tsx",
    "/park/amenities": "ParkAmenities.tsx",
    "/park/setup": "../app/park/setup/page.tsx",
  };
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const titles = (rel: string) =>
    [...strip(readFileSync(join(here, rel), "utf8")).matchAll(/<h1[^>]*>([^<{]*)<\/h1>/g)]
      .map((m) => m[1].replace(/&amp;/g, "&").replace(/&apos;/g, "'").trim());

  it("the scanner finds an h1 in every screen it judges", () => {
    for (const rel of Object.values(h1Of)) expect(titles(rel), rel).not.toHaveLength(0);
  });

  const pills = TABS.flatMap((t) => t.pills ?? []);
  for (const [href, rel] of Object.entries(h1Of)) {
    it(`${href} → ${rel}`, () => {
      const pill = pills.find((p) => p.href === href)!;
      expect(pill, `${href} has no pill`).toBeTruthy();
      expect(titles(rel)).toContain(pill.label);
    });
  }

  it("the two whose titles are not a fixed string carry the agreed words", () => {
    const byHref = Object.fromEntries(pills.map((p) => [p.href, p.label]));
    expect(byHref["/park/rent"]).toBe("Rent");
    expect(byHref["/park/import"]).toBe("Load the roll");
  });
});

describe("the header", () => {
  it("carries Take a payment on every screen, handed the park", () => {
    for (const r of routes()) {
      const html = render(r.route);
      expect(html, r.file).toContain("Take a payment");
      expect(html, r.file).toContain('data-park="park-1"');
      expect(html, r.file).not.toContain("Book services for the park");
    }
  });

  it("the button is placed by the POS component, not drawn here", () => {
    const src = readFileSync(join(here, "ParkNav.tsx"), "utf8");
    expect(src).toMatch(/^import \{ TakePayment \} from "@\/components\/TakePayment";$/m);
    expect(src).toMatch(/<TakePayment parkId=\{park\.id\} \/>/);
  });

  it("still says Live or Not published", () => {
    expect(render("/park")).toContain("Not published");
    pathname = "/park";
    expect(renderToStaticMarkup(<ParkNav park={{ ...park, active: true }} />)).toContain(">Live<");
  });

  it("the hold banner still sends him to Park setup by that name", () => {
    pathname = "/park";
    const html = renderToStaticMarkup(<ParkNav park={{ ...park, noticesHeldAt: "2026-09-01T00:00:00Z" }} />);
    expect(html).toMatch(/nothing is reaching your households/);
    expect(html).toMatch(/<a href="\/park\/setup">Park setup<\/a>/);
    expect(render("/park")).not.toMatch(/nothing is reaching your households/);
  });
});

describe("the strip keeps its built look", () => {
  /**
   * WHAT THIS USED TO PIN, AND WHY IT CHANGED.
   *
   * It asserted the six tabs WRAP rather than scroll — "an overflow-x strip
   * hides the last tab" — which was the right answer for a row across the top
   * of a 375px screen, where wrapping cost two more rows of page.
   *
   * On 29 Oct the strip became the workspace column the October design review
   * draws: a column beside the page on a desktop, a bar along the bottom on a
   * phone. A bottom bar cannot wrap — a second fixed row is a tenth of the
   * screen — so the six scroll sideways there instead. The thing the old test
   * was protecting is that NO ENTRY CAN BE HIDDEN, and that is what is
   * asserted now: six anchors, always rendered, never behind a menu, and each
   * one a 44px target.
   */
  it("all six are always rendered, never behind a menu", () => {
    const src = readFileSync(join(here, "ParkNav.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // No disclosure widget: every group is a link on screen, at every width.
    expect(src).not.toMatch(/<details|<select|aria-expanded|useState/);
    const html = render("/park/today");
    const nav = html.slice(html.indexOf('<nav class="ll-sidenav"'));
    const entries = nav.slice(0, nav.indexOf("</nav>")).match(/<a\b/g) ?? [];
    expect(entries.length, "the column is not showing all six groups").toBe(6);
    for (const t of TABS) expect(nav).toContain(`>${t.label.replace(/&/g, "&amp;")}<`);
  });

  it("and the bar scrolls rather than clipping, with the 44px floor on each", () => {
    const css = readFileSync(join(here, "..", "app", "globals.css"), "utf8");
    const entry = css.match(/\.ll-sidenav a \{([^}]*)\}/);
    expect(entry, "the column entry rule is gone").toBeTruthy();
    expect(entry![1], "a column entry lost the 44px floor").toMatch(/min-height: 44px/);
    // The phone bar: a row that scrolls sideways, so the sixth is reachable.
    const phone = css.slice(css.indexOf("The column becomes a bar across the bottom"));
    expect(phone).toMatch(/overflow-x: auto/);
  });

  it("the second-level class exists once, mirroring the prototype's .vt", () => {
    const css = readFileSync(join(here, "..", "app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const pill = css.match(/\.ll-subtab \{([^}]*)\}/);
    expect(pill).toBeTruthy();
    expect(pill![1]).toMatch(/padding: 8px 15px/);
    expect(pill![1]).toMatch(/border-radius: 99px/);
    expect(pill![1]).toMatch(/border: 1\.5px solid var\(--line\)/);
    expect(pill![1]).toMatch(/font-size: 13px/);
    const on = css.match(/\.ll-subtab\.on \{([^}]*)\}/);
    expect(on![1]).toMatch(/background: var\(--ink\)/);
    expect(on![1]).toMatch(/color: #fff/);
    expect((css.match(/\.ll-subtab \{/g) ?? []).length).toBe(1);
  });
});
