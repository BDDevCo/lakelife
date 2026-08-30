import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SPRING DOOR, AND THE FIVE PLACES THAT DECIDE WHAT IS BOOKABLE (0147).
 *
 * `services.kind` is single-valued and read in two opposite directions: the
 * customer menu takes `standalone`, the package wizard takes
 * `component`/`addon`. So a service cannot be both by flipping `kind` — moving
 * the two spring legs to `standalone` would empty `you_tow`'s spring phase,
 * which is exactly those two legs and nothing else, and leave a package that
 * books a fall visit and promises a spring it cannot staff.
 *
 * 0147 adds `solo_bookable` as a SECOND door instead, the same way 0143 added
 * `park_bookable` beside `park_only`. That only works if EVERY menu reader
 * learns it. Four do today. The failure mode if a fifth is added later is the
 * quietest kind there is: a service that is bookable on one screen and absent
 * from another, with no error anywhere.
 *
 * So this scans rather than trusts. The catch-all at the bottom is the part
 * that earns its keep — it fails on a menu door nobody told about the flag.
 */
const ROOT = process.cwd();

/** Every .ts/.tsx under src, comments stripped. */
function sourceFiles(): Array<{ file: string; code: string }> {
  const out: Array<{ file: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push({
        file: abs.slice(ROOT.length + 1),
        code: readFileSync(abs, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, ""),
      });
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

/**
 * Each `from("services")` chain, cut at the NEXT `from("` so a window can
 * never bleed into a different query and report a pass it did not earn.
 */
function serviceQueries(): Array<{ file: string; chain: string }> {
  const hits: Array<{ file: string; chain: string }> = [];
  for (const { file, code } of sourceFiles()) {
    const re = /from\("services"\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const rest = code.slice(m.index + m[0].length);
      const nextFrom = rest.indexOf('from("');
      const end = nextFrom === -1 ? 500 : Math.min(nextFrom, 500);
      hits.push({ file, chain: rest.slice(0, end) });
    }
  }
  return hits;
}

/** The customer-facing menus. Each must accept BOTH kinds of bookable. */
const MENU_DOORS: Record<string, string> = {
  "src/app/book/actions.ts": "the booking loader — the service being booked",
  "src/app/profile/data.ts": "the owner's priced menu tiles",
  "src/app/profile/setup/page.tsx": "the service picker during profile setup",
  "src/app/lakes/[slug]/page.tsx": "the public lake page menu",
};

/** The package wizard — must keep reading `kind`, or the packages lose legs. */
const WIZARD = "src/app/book/storage/data.ts";

describe("the spring door — solo_bookable reaches every menu", () => {
  const queries = serviceQueries();

  it("still finds the service queries, so this scan is not measuring nothing", () => {
    expect(queries.length).toBeGreaterThan(5);
    for (const door of Object.keys(MENU_DOORS)) {
      expect(queries.some((q) => q.file === door), `no services query found in ${door} — the scan is stale`)
        .toBe(true);
    }
  });

  it("EVERY MENU DOOR accepts a package leg opened for solo booking", () => {
    const deaf = Object.keys(MENU_DOORS)
      .filter((door) => {
        const chains = queries.filter((q) => q.file === door).map((q) => q.chain);
        return !chains.some((c) => c.includes("solo_bookable"));
      })
      .map((door) => `${door} — ${MENU_DOORS[door]}`);
    expect(deaf, `these menus cannot see a solo-bookable service:\n${deaf.join("\n")}`)
      .toEqual([]);
  });

  it("no menu still uses the bare kind=standalone filter it replaced", () => {
    // The old filter is the bug: it is not wrong, it is INCOMPLETE, and an
    // incomplete filter reads exactly like a correct one.
    const stale = queries
      .filter((q) => q.file in MENU_DOORS)
      .filter((q) => /\.eq\(\s*"kind",\s*"standalone"\s*\)/.test(q.chain))
      .map((q) => q.file);
    expect(stale, `still filtering kind=standalone only:\n${stale.join("\n")}`).toEqual([]);
  });

  it("the package wizard STILL loads legs by kind — packages keep their spring", () => {
    // If this ever goes green-by-absence the packages have been emptied, which
    // is the failure 0147 exists to avoid causing.
    const chain = queries.find((q) => q.file === WIZARD)?.chain ?? "";
    expect(chain, `no services query in ${WIZARD} — the wizard scan is stale`).not.toBe("");
    expect(chain, "the wizard must keep selecting components/addons by kind")
      .toMatch(/"component",\s*"addon"/);
    expect(chain, "the wizard must NOT have been switched onto solo_bookable")
      .not.toContain("solo_bookable");
  });

  it("A NEW MENU DOOR MUST BE CLASSIFIED, not silently left half-open", () => {
    // Any query anywhere that gates on kind=standalone is a menu by definition.
    // If it is not one of the four, somebody added a fifth and this is the only
    // thing that will say so.
    const unknown = queries
      .filter((q) => /\.eq\(\s*"kind",\s*"standalone"\s*\)/.test(q.chain) || q.chain.includes("kind.eq.standalone"))
      .filter((q) => !(q.file in MENU_DOORS))
      .map((q) => q.file);
    expect(unknown, `new menu reader(s) that must learn solo_bookable:\n${unknown.join("\n")}`)
      .toEqual([]);
  });
});

describe("0147 the migration says what it does", () => {
  const sql = readFileSync(
    join(ROOT, "supabase/migrations/0147_the_spring_you_can_enter_without_a_fall.sql"),
    "utf8",
  );

  it("adds the column without touching kind", () => {
    expect(sql).toMatch(/add column if not exists solo_bookable boolean not null default false/);
    // Flipping kind is the thing this migration exists NOT to do.
    expect(sql).not.toMatch(/set\s+kind\s*=/i);
  });

  it("turns nothing on — active is the owner's switch", () => {
    expect(sql).not.toMatch(/set\s+active\s*=\s*true/i);
  });

  it("refuses to flag a service that is already standalone", () => {
    expect(sql).toMatch(/solo_bookable and kind = 'standalone'/);
  });
});
