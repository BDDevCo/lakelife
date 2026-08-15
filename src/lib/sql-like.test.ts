import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { likeLiteral } from "@/lib/sql-like";

/**
 * THE BUG THIS FILE EXISTS FOR: an email address was used as a LIKE pattern,
 * so `crew_mow@outlook.com` matched the invite for `crew.mow@outlook.com` and
 * handed a stranger the crew's account.
 */
describe("likeLiteral", () => {
  it("escapes the character that caused the takeover", () => {
    expect(likeLiteral("crew_mow@outlook.com")).toBe("crew\\_mow@outlook.com");
  });

  it("escapes every LIKE metacharacter", () => {
    expect(likeLiteral("a%b")).toBe("a\\%b");
    expect(likeLiteral("a_b")).toBe("a\\_b");
    expect(likeLiteral("a\\b")).toBe("a\\\\b");
  });

  it("escapes `*`, which PostgREST turns into `%` before SQL sees it", () => {
    // Unescaped this becomes a wildcard at the PostgREST layer, which is a
    // fail-OPEN. Escaped it degrades to a literal `%` and matches nobody.
    expect(likeLiteral("a*b")).toBe("a\\*b");
  });

  it("leaves an ordinary address completely alone", () => {
    for (const ok of [
      "crew.mow@outlook.com",
      "john+lakelife@gmail.com",
      "o'brien@example.co.uk",
      "UPPER.Case@Example.COM",
    ]) {
      expect(likeLiteral(ok)).toBe(ok);
    }
  });

  it("never throws, and a non-string matches nothing", () => {
    expect(likeLiteral(null)).toBe("");
    expect(likeLiteral(undefined)).toBe("");
    expect(likeLiteral(12345 as unknown as string)).toBe("");
  });

  /**
   * The escaped pattern must still match the address it came from — a fix that
   * closed the hole by refusing everybody would be worse than the hole.
   */
  it("still matches its own address, which is the whole point", () => {
    const like = (pattern: string, value: string) => {
      // A faithful-enough LIKE: `\x` is a literal x, `_` is any char, `%` is
      // any run. Enough to prove escaping does not break a legitimate match.
      let rx = "";
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "\\") { rx += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
        if (c === "_") { rx += "."; continue; }
        if (c === "%") { rx += ".*"; continue; }
        rx += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      return new RegExp(`^${rx}$`, "i").test(value);
    };

    // The attack, before and after.
    expect(like("crew_mow@outlook.com", "crew.mow@outlook.com")).toBe(true);
    expect(like(likeLiteral("crew_mow@outlook.com"), "crew.mow@outlook.com")).toBe(false);
    // And the legitimate holder still gets in.
    expect(like(likeLiteral("crew_mow@outlook.com"), "crew_mow@outlook.com")).toBe(true);
    expect(like(likeLiteral("crew.mow@outlook.com"), "crew.mow@outlook.com")).toBe(true);
  });
});

/**
 * A SOURCE CHECK, because the failure mode is a call site that forgot. Nine
 * places looked somebody up by an address they control; the two that could be
 * turned into an account takeover are asserted individually below.
 */
describe("no lookup treats a user-supplied address as a pattern", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
  const code = (p: string) =>
    read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const files = [
    "app/ops/crews-invite.ts",
    "app/vendor/import-actions.ts",
    "app/book/contractor-actions.ts",
    "app/ops/parks-actions.ts",
    "app/vendor/workers-actions.ts",
  ];

  it.each(files)("%s: every .ilike() argument is escaped", (f) => {
    const src = code(f);
    // Every ilike call in these files must pass likeLiteral(...) as the value.
    const calls = src.match(/\.ilike\([^)]*\)/g) ?? [];
    for (const call of calls) {
      expect(call, `unescaped ilike in ${f}`).toMatch(/likeLiteral\(/);
    }
  });

  /**
   * The two claim paths do not merely escape — they do not pattern-match at
   * all. Both columns are ours and written lower-cased, so exact match is both
   * correct and the strongest available fix. If either of these ever goes back
   * to `.ilike`, that is the takeover returning.
   */
  it("claimCrewInvite matches the invite EXACTLY", () => {
    const src = code("app/ops/crews-invite.ts");
    const fn = src.match(/export async function claimCrewInvite[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn.length, "claimCrewInvite not found").toBeGreaterThan(50);
    expect(fn).toMatch(/\.eq\("invite_email"/);
    expect(fn, "an invite lookup must never be a pattern").not.toMatch(/\.ilike\("invite_email"/);
  });

  it("claimCustomerImports matches the staged row EXACTLY", () => {
    const src = code("app/vendor/import-actions.ts");
    const fn = src.match(/export async function claimCustomerImports[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn.length, "claimCustomerImports not found").toBeGreaterThan(50);
    expect(fn).toMatch(/\.eq\("invite_email"/);
    expect(fn, "a staged-import lookup must never be a pattern").not.toMatch(/\.ilike\("invite_email"/);
  });

  it("no invite_email column anywhere is looked up with a pattern", () => {
    for (const f of files) {
      expect(code(f), `${f} pattern-matches invite_email`).not.toMatch(/\.ilike\("invite_email"/);
    }
  });
});
