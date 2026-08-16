import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE AUDIT QUESTION, KEPT ANSWERED.
 *
 * "Who calls this?" is the cheapest of the four questions and the one that
 * found the worst bug of the session: `releaseClaim` was a working server
 * action wrapping a working database function, exported, tested by nothing,
 * and called from nowhere. Meanwhile the resident's own claim screen said
 * "if that wasn't you, tell the office and they'll sort it" — a promise about
 * a control that did not exist.
 *
 * This walks the claim and invite actions and insists every exported action
 * is reachable from somewhere that is not itself. It is deliberately crude:
 * a name appearing anywhere else in src/ counts. Crude is enough — the failure
 * it catches is a count of zero, not a count of one.
 */

// fileURLToPath, not .pathname: this repo lives under "LakeLife App Docs" and
// a raw pathname keeps the %20, which readdirSync cannot open.
const SRC = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const ACTION_FILES = [
  "app/parks/claim-actions.ts",
  "app/parks/invite-actions.ts",
  "app/parks/consent-actions.ts",
];

describe("every claim-path action has a caller", () => {
  const all = walk(SRC).filter((f) => !/\.test\.tsx?$/.test(f));

  for (const rel of ACTION_FILES) {
    const path = `${SRC}${rel}`;
    const source = readFileSync(path, "utf8");
    const exported = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]);

    it(`finds exported actions in ${rel}`, () => {
      // Guards the scanner: a rename that empties this list would make every
      // assertion below pass by having nothing to assert.
      expect(exported.length).toBeGreaterThan(0);
    });

    for (const fn of exported) {
      it(`${fn} is called from somewhere`, () => {
        const callers = all.filter((f) => {
          if (f === path) return false;
          const body = readFileSync(f, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
          return new RegExp(`\\b${fn}\\b`).test(body);
        });
        expect(callers.length, `${fn} is exported but nothing calls it`).toBeGreaterThan(0);
      });
    }
  }
});

describe("the office can undo a wrong claim", () => {
  // The specific promise: the resident's screen says the office will sort it.
  // These two assertions are what make that sentence true.
  const roll = readFileSync(new URL("../components/ClaimSlip.tsx", import.meta.url), "utf8");

  it("offers a way out on a household that is already set up", () => {
    expect(roll).toMatch(/releaseClaim\(/);
    expect(roll).toMatch(/Wrong person\?/);
  });

  it("warns that detaching kills any link they hold", () => {
    // True because of 0134 — and saying so is what stops the office assuming
    // the old email still works and re-inviting into a race.
    expect(roll).toMatch(/any link they hold stops working/);
  });
});
