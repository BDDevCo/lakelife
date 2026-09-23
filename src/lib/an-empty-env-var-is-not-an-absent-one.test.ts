import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { siteUrl } from "./env";

/**
 * AN EMPTY ENV VAR IS NOT AN ABSENT ONE, AND `??` CANNOT TELL THEM APART.
 *
 * `process.env.FOO ?? fallback` only reaches the fallback when FOO is null or
 * undefined. A variable SET TO THE EMPTY STRING — the shape a half-finished
 * Vercel entry takes, and the shape a bare `FOO=` in a .env file takes — is a
 * string, so `??` hands it straight through and the fallback never runs.
 *
 * Two places that mattered:
 *
 *   lib/email.ts resolved the sender as `opts.from ?? EMAIL_FROM ?? SANDBOX_FROM`
 *   and then warned only `if (from === SANDBOX_FROM)`. With EMAIL_FROM="" the
 *   send posts `from: ""` to Resend, fails with a 4xx nobody is watching for,
 *   and the ONE log line that says which side of the sandbox switch this
 *   deployment is on never prints — because "" is not SANDBOX_FROM. Found while
 *   walking a crew from invitation to first paid job: the invitation IS the
 *   invite. A crew who never receives it has no other door into the product,
 *   and the Crews board reads "invited" either way, which is indistinguishable
 *   from a crew who got it and is ignoring it.
 *
 *   lib/env.ts siteUrl() had the same shape. Every generated link is built on
 *   it — password reset, the auth callback, a one-login amenity link, a
 *   delivery-receipt URL. With NEXT_PUBLIC_SITE_URL="" each one comes out as a
 *   bare path. Nothing throws. They just go nowhere.
 *
 * WHY A SCANNER FOR THE EMAIL HALF. The sender resolution is one inline
 * expression inside a function that posts to Resend, so it cannot be called in
 * a test without a network. The expression itself is the thing that has to stay
 * right, so the expression is what this reads.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

/** Comments explain the bug; they must never be mistaken for the fix. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("an empty env var is not an absent one", () => {
  it("resolves the email sender with || so an empty EMAIL_FROM reaches the sandbox guard", () => {
    const src = stripComments(read("email.ts"));
    // The real line, not a comment about it.
    expect(src).toContain("opts.from || process.env.EMAIL_FROM || SANDBOX_FROM");
    // And the hole is gone, in code, anywhere in the file.
    expect(src).not.toMatch(/process\.env\.EMAIL_FROM\s*\?\?/);
  });

  it("still warns on the sandbox sender — the guard the || exists to reach", () => {
    const src = stripComments(read("email.ts"));
    expect(src).toContain("if (from === SANDBOX_FROM) warnSandboxSender();");
  });

  it("the scanner bites: the pre-fix expression would fail it", () => {
    // Pin the scanner itself. If someone reverts the operator, THIS is the
    // string the file would hold — and the assertions above must reject it.
    const reverted = 'const from = opts.from ?? process.env.EMAIL_FROM ?? SANDBOX_FROM;';
    expect(reverted).not.toContain("opts.from || process.env.EMAIL_FROM || SANDBOX_FROM");
    expect(reverted).toMatch(/process\.env\.EMAIL_FROM\s*\?\?/);
  });

  it("siteUrl falls back when NEXT_PUBLIC_SITE_URL is set but empty", () => {
    const before = process.env.NEXT_PUBLIC_SITE_URL;
    try {
      process.env.NEXT_PUBLIC_SITE_URL = "";
      expect(siteUrl()).toBe("http://localhost:3000");
      process.env.NEXT_PUBLIC_SITE_URL = "   ";
      // Whitespace is a real value and is NOT rescued — pinned honestly so the
      // next reader knows exactly how far this guard reaches.
      expect(siteUrl()).toBe("   ");
      process.env.NEXT_PUBLIC_SITE_URL = "https://www.lakelife.ai";
      expect(siteUrl()).toBe("https://www.lakelife.ai");
      delete process.env.NEXT_PUBLIC_SITE_URL;
      expect(siteUrl()).toBe("http://localhost:3000");
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = before;
    }
  });
});
