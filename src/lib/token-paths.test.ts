import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TOKEN_PATHS, TOKEN_PATH_SOURCES, TOKEN_PATH_DISALLOW, TOKEN_PATH_HEADERS } from "./token-paths";

/**
 * A NINTH TOKEN PATH MUST NOT BE FORGETTABLE.
 *
 * Two files needed this list and both wrote it by hand — the X-Robots-Tag
 * matcher in next.config.ts and the disallow list in src/app/robots.ts — and
 * both called it closed, in a comment, at seven.
 *
 * Then /doc was added. It 302s to a lease naming a household, its rent and its
 * address, and because robots.ts allows by default it was affirmatively
 * CRAWLABLE with no noindex on the response. Worse than the leak: the route
 * stamps `opened_at` on the way through, so a crawler following a pasted link
 * would have written a false "Opened" into the park's delivery log — the one
 * record that exists to be relied on.
 *
 * Neither file spells the set out any more. This is what catches the next one.
 */

const APP = fileURLToPath(new URL("../app", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Every route under src/app whose only credential is the URL — a `[token]`
 * segment ANYWHERE in the tree — returned as the URL path in front of it.
 *
 * THIS USED TO READ ONE LEVEL: readdirSync(APP) and then existsSync of
 * `<child>/[token]`. src/app/api/ics/[token] is two levels down, `api` has no
 * `[token]` of its own, so the whole subtree was dropped — and the calendar
 * feed that hands an account's upcoming services and addresses to whoever
 * holds the URL sat outside the fence with this test green over it.
 *
 * Route groups `(x)`, parallel slots `@x` and private folders `_x` exist in
 * the tree but not in the URL, so they are walked into without contributing a
 * segment. Another dynamic segment is not this scanner's business.
 */
function tokenRouteDirs(root: string = APP): string[] {
  const found: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === "[token]") {
        found.push(segments.join("/"));
        continue;
      }
      if (e.name.startsWith("[")) continue;
      const inUrl = !/^\(.*\)$/.test(e.name) && !e.name.startsWith("@") && !e.name.startsWith("_");
      walk(`${dir}/${e.name}`, inUrl ? [...segments, e.name] : segments);
    }
  };
  walk(root, []);
  return found.sort();
}

describe("the list is the routes", () => {
  it("finds the token routes it is supposed to be policing", () => {
    // A scanner that matches nothing passes for ever.
    const dirs = tokenRouteDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(9);
    expect(dirs).toContain("doc");
    // The one the one-level scanner could not see. If this ever stops being
    // found, the walk has been flattened again.
    expect(dirs).toContain("api/ics");
  });

  it("walks below the first level, and does not invent a path that has no [token]", () => {
    // THE EXACT BREAK THIS EXISTS TO CATCH, on a tree of our own so it keeps
    // meaning something when src/app changes. Collapsed both ways: a nested
    // token route must be FOUND, and a nested directory with no [token] must
    // NOT be. A scanner that returned every directory would pass the first
    // assertion on its own.
    const root = mkdtempSync(`${tmpdir()}/lakelife-token-scan-`);
    mkdirSync(`${root}/api/ics/[token]`, { recursive: true });
    writeFileSync(`${root}/api/ics/[token]/route.ts`, "");
    mkdirSync(`${root}/api/health`, { recursive: true });
    mkdirSync(`${root}/top/[token]`, { recursive: true });
    mkdirSync(`${root}/(group)/inside/[token]`, { recursive: true });

    const dirs = tokenRouteDirs(root);
    expect(dirs).toContain("api/ics");          // nested — the one-level scan returned nothing here
    expect(dirs).toContain("top");              // still finds the shallow ones
    expect(dirs).toContain("inside");           // a route group is not part of the URL
    expect(dirs).not.toContain("api");          // no [token] of its own
    expect(dirs).not.toContain("api/health");   // no [token] at all
    expect(dirs).not.toContain("(group)/inside");
  });

  it("every src/app/<x>/[token] route is in TOKEN_PATHS", () => {
    // THE ONE THAT WOULD HAVE CAUGHT /doc. Adding a route under a bare token
    // and not telling the crawler about it is the whole defect.
    const missing = tokenRouteDirs().filter((d) => !(TOKEN_PATHS as readonly string[]).includes(d));
    expect(missing).toEqual([]);
  });

  it("does not claim a path that has no route", () => {
    // The reverse drift: a name left behind after a route was deleted makes
    // the list look maintained when it is not.
    const dirs = tokenRouteDirs();
    const stale = TOKEN_PATHS.filter((p) => !dirs.includes(p));
    expect(stale).toEqual([]);
  });
});

describe("both consumers derive from it", () => {
  const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, "utf8");

  it("next.config.ts uses the derived sources rather than spelling them out", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toContain("TOKEN_PATH_SOURCES");
    expect(cfg).toContain("TOKEN_PATH_HEADERS");
    // The hand-written alternation must be gone, or it will drift again — and
    // an alternation cannot carry a nested path in any case.
    expect(cfg).not.toMatch(/\(use\|d\|a\|c\|x\|fix\|paid/);
    expect(cfg).not.toMatch(/"X-Robots-Tag"|'X-Robots-Tag'/);
  });

  it("the .ics route stamps the headers itself, not only via the config", () => {
    // A route handler builds its own Response. The feed is the one token path
    // whose 200 body names an account's services and the addresses they happen
    // at, so it carries the noindex without depending on the config layer.
    const route = read("src/app/api/ics/[token]/route.ts");
    expect(route).toContain("TOKEN_PATH_HEADERS");
    expect(route).toContain("...TOKEN_PATH_HEADERS");
    expect(route).not.toMatch(/"X-Robots-Tag"|'X-Robots-Tag'/);
  });

  it("robots.ts uses the disallow list rather than spelling it out", () => {
    const robots = read("src/app/robots.ts");
    expect(robots).toContain("TOKEN_PATH_DISALLOW");
    expect(robots).not.toMatch(/"\/paid\/"/);
  });

  it("the sources and the disallow list agree with the array", () => {
    for (const p of TOKEN_PATHS) {
      expect(TOKEN_PATH_SOURCES).toContain(`/${p}/:rest*`);
      expect(TOKEN_PATH_DISALLOW).toContain(`/${p}/`);
    }
    expect(TOKEN_PATH_SOURCES).toHaveLength(TOKEN_PATHS.length);
    expect(TOKEN_PATH_DISALLOW).toHaveLength(TOKEN_PATHS.length);
  });

  it("every source is a literal Next matcher, with no alternation to swallow a slash", () => {
    // WHY THIS IS NOT ONE PATTERN ANY MORE. `/:path(use|d|…|api/ics)/:rest*`
    // is accepted as a string and applies to nothing: the `/` inside the
    // capture is not a matcher Next honours. A fix that went in that way would
    // have registered api/ics, gone green, and left the feed exposed.
    for (const s of TOKEN_PATH_SOURCES) {
      expect(s).toMatch(/^\/[a-z]+(\/[a-z]+)*\/:rest\*$/);
      expect(s).not.toContain("(");
      expect(s).not.toContain("|");
    }
    // Non-vacuous: at least one source is genuinely nested, or this regex is
    // only ever exercised on single-segment paths.
    expect(TOKEN_PATH_SOURCES.some((s) => s.split("/").length > 3)).toBe(true);
  });

  it("the headers say noindex and drop the referrer", () => {
    expect(TOKEN_PATH_HEADERS["X-Robots-Tag"]).toBe("noindex, nofollow, noarchive");
    expect(TOKEN_PATH_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });
});
