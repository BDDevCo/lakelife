import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOKEN_PATHS, TOKEN_PATH_PATTERN, TOKEN_PATH_DISALLOW } from "./token-paths";

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

/** Every route in src/app whose only credential is the URL: src/app/<x>/[token]. */
function tokenRouteDirs(): string[] {
  return readdirSync(APP, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("[") && !e.name.startsWith("("))
    .filter((e) => existsSync(`${APP}/${e.name}/[token]`))
    .map((e) => e.name);
}

describe("the list is the routes", () => {
  it("finds the token routes it is supposed to be policing", () => {
    // A scanner that matches nothing passes for ever.
    const dirs = tokenRouteDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(7);
    expect(dirs).toContain("doc");
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

  it("next.config.ts uses the pattern rather than spelling it out", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toContain("TOKEN_PATH_PATTERN");
    // The hand-written alternation must be gone, or it will drift again.
    expect(cfg).not.toMatch(/\(use\|d\|a\|c\|x\|fix\|paid\)/);
  });

  it("robots.ts uses the disallow list rather than spelling it out", () => {
    const robots = read("src/app/robots.ts");
    expect(robots).toContain("TOKEN_PATH_DISALLOW");
    expect(robots).not.toMatch(/"\/paid\/"/);
  });

  it("the pattern and the disallow list agree with the array", () => {
    for (const p of TOKEN_PATHS) {
      expect(TOKEN_PATH_PATTERN).toContain(p);
      expect(TOKEN_PATH_DISALLOW).toContain(`/${p}/`);
    }
    expect(TOKEN_PATH_DISALLOW).toHaveLength(TOKEN_PATHS.length);
  });

  it("the pattern is a valid Next matcher, not just a string", () => {
    expect(TOKEN_PATH_PATTERN).toMatch(/^\/:path\([a-z|]+\)\/:rest\*$/);
  });
});
