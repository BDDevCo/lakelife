import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mustRead, mustCount, softRead, ReadFailed } from "./must-read";

/**
 * A FAILED READ IS NOT AN EMPTY ONE.
 *
 * The behaviour half of these tests exercises the helper directly. The source
 * half asserts that the resident's loader actually USES it — a helper nobody
 * calls prevents nothing, and this bug class is invisible precisely because
 * the broken version looks like ordinary, tidy code.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function after(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`marker vanished, so this test proves nothing: ${marker}`);
  return source.slice(at);
}

const err = { message: "502 Bad Gateway", code: "502" };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("mustRead", () => {
  it("passes real data through untouched", () => {
    const rows = [{ id: "a" }];
    expect(mustRead("your bill", { data: rows, error: null })).toBe(rows);
  });

  it("LEAVES THE EMPTY CASE ALONE — null and [] still mean 'nothing here'", () => {
    // The fix must not turn "you genuinely have no tenancy" into an error. That
    // screen is correct and has to keep working; what changes is that it can no
    // longer be reached BY FAILURE.
    expect(mustRead("your file", { data: null, error: null })).toBeNull();
    expect(mustRead("your file", { data: [], error: null })).toEqual([]);
  });

  it("throws on error rather than handing back null", () => {
    // The whole bug in one assertion. supabase-js returns data:null alongside
    // the error, so the old code took its empty branch and printed a sentence.
    expect(() => mustRead("your park", { data: null, error: err })).toThrow(ReadFailed);
  });

  it("names what failed, in words a log reader can act on", () => {
    expect(() => mustRead("your deposit", { data: null, error: err }))
      .toThrow(/Couldn't read your deposit/);
  });
});

describe("mustCount", () => {
  it("returns the count, and treats a null count as 0", () => {
    expect(mustCount("your cards", { count: 3, error: null })).toBe(3);
    expect(mustCount("your cards", { count: null, error: null })).toBe(0);
  });

  it("does NOT report an errored count as zero", () => {
    // "0 saved cards" is the sentence that sends somebody to re-enter a card
    // they already have.
    expect(() => mustCount("your cards", { count: null, error: err })).toThrow(ReadFailed);
  });
});

describe("softRead", () => {
  it("returns [data, false] when the read worked", () => {
    const rows = [{ note: "porch light" }];
    expect(softRead("reports", { data: rows, error: null }, null)).toEqual([rows, false]);
  });

  it("returns [fallback, TRUE] on error — the flag is the whole point", () => {
    // A bare fallback would be indistinguishable from success again. The pair
    // forces the caller to carry the failure to the screen.
    expect(softRead("reports", { data: null, error: err }, null)).toEqual([null, true]);
  });

  it("never throws, so one soft read cannot take a page down", () => {
    expect(() => softRead("reports", { data: null, error: err }, null)).not.toThrow();
  });
});

describe("the resident's loader actually uses it", () => {
  const src = () => read("../app/parks/my-data.ts");

  it("has no bare `const { data: x } = await admin` reads left", () => {
    // The exact shape of the bug: destructuring data and never error. If this
    // ever matches again, a read has been added the old way.
    const bare = src().match(/const\s*\{\s*data:[^}]*\}\s*=\s*await\s+admin/g) ?? [];
    expect(bare, `bare reads that swallow error: ${bare.join(" | ")}`).toEqual([]);
    const bareCount = src().match(/const\s*\{\s*count:[^}]*\}\s*=\s*await\s+admin/g) ?? [];
    expect(bareCount).toEqual([]);
  });

  it("guards the two IDENTITY reads, so nobody is told their tenancy is gone", () => {
    // Observed live 17 Aug 2026: a real Cloudflare 502 on each of these. Before
    // the guard, both rendered "No lot on your account — we looked for a
    // tenancy attached to this sign-in and didn't find one."
    expect(src()).toMatch(/mustRead\(\s*"your file"/);
    expect(src()).toMatch(/mustRead\(\s*"your tenancy"/);
  });

  it("guards every MONEY read", () => {
    for (const what of ["your park", "your bill", "your payments", "what you've told the office"]) {
      expect(src(), `unguarded: ${what}`).toMatch(
        new RegExp(`mustRead\\(\\s*"${what.replace(/'/g, "'")}"`),
      );
    }
  });

  it("keeps `return null` meaning exactly one thing", () => {
    // Both early returns must sit AFTER their read has been proven to have
    // succeeded, or "you have no tenancy" is reachable by failure again.
    const s = src();
    const fileGuard = s.indexOf('mustRead(\n    "your file"');
    const fileReturn = s.indexOf("if (!files?.length) return null;");
    const stayGuard = s.indexOf('mustRead(\n    "your tenancy"');
    const stayReturn = s.indexOf("if (!stay) return null;");
    expect(fileGuard).toBeGreaterThan(-1);
    expect(stayGuard).toBeGreaterThan(-1);
    expect(fileReturn).toBeGreaterThan(fileGuard);
    expect(stayReturn).toBeGreaterThan(stayGuard);
  });

  it("degrades ONLY the maintenance list, and carries the flag to the screen", () => {
    expect(src()).toMatch(/softRead\(/);
    // Exactly one soft read. If a money read ever becomes soft, this fails.
    expect((src().match(/softRead\(/g) ?? []).length).toBe(1);
    expect(src()).toMatch(/reportedFailed/);
  });
});

describe("the screen tells the difference", () => {
  const home = () => read("../components/RenterHome.tsx");

  it("says 'we couldn't look', not 'nothing yet', when the read failed", () => {
    const block = after(home(), "view.reportedFailed");
    expect(block).toMatch(/couldn&apos;t load this just now/);
    // And the honest empty state still exists for the case where it IS empty.
    expect(home()).toMatch(/Nothing yet\. The sticker on your pedestal/);
  });

  it("has an error boundary at all — the app had none anywhere", () => {
    const boundary = read("../app/parks/my/error.tsx");
    expect(boundary).toMatch(/"use client"/);
    expect(boundary).toMatch(/export default function/);
    expect(boundary).toMatch(/reset/);
  });

  it("promises nothing about money it could not read", () => {
    // The failure page must not quote a balance, a total, or "you owe nothing".
    const boundary = read("../app/parks/my/error.tsx");
    expect(boundary).not.toMatch(/\$\{/);
    expect(boundary).toMatch(/nothing about your rent/);
  });
});

describe("a guard that could not run is not a guard that passed", () => {
  const pay = () => read("../app/parks/pay-actions.ts");

  it("payRent's disputed-bill guard checks the error before trusting the count", () => {
    // THE BUG: `const { count } = await ...` then `(count ?? 0) > 0`. A failed
    // head-count is `{ count: null, error }`, so the expression is false and the
    // guard PASSES — charging a card on a bill the resident formally disputed.
    // Worse, 0074's trg_settle_claims_on_payment then marks that claim
    // 'matched', closing the dispute as conceded and erasing the evidence.
    const s = pay();
    const guard = s.indexOf("park_payment_claims");
    expect(guard).toBeGreaterThan(-1);
    const region = s.slice(guard - 400, guard + 700);
    expect(region, "the claims read must check .error").toMatch(/claimsRes\.error/);
    // And the bare fails-open form must be gone entirely.
    expect(s).not.toMatch(/const\s*\{\s*count:\s*openClaims\s*\}/);
  });

  it("no read in the money path silently discards its error", () => {
    const s = pay();
    // auth.getUser() is a different shape and fails closed to "sign in again";
    // everything reading `admin` must go through an explicit error check.
    const bare = s.match(/const\s*\{\s*(data|count):[^}]*\}\s*=\s*await\s+admin/g) ?? [];
    expect(bare, `swallowing reads: ${bare.join(" | ")}`).toEqual([]);
  });

  it("refuses without asserting anything about their account", () => {
    // The refusal must not invent a fact — the whole problem is we haven't got
    // one. And it must say no money moved, which is the reader's first question.
    const s = pay();
    expect(s).toMatch(/function couldNotCheck/);
    expect(s).toMatch(/nothing has been charged/);
  });

  it("sayIPaid's duplicate-claim guard fails closed too", () => {
    const s = pay();
    expect(s).toMatch(/openRes\.error/);
    expect(s).not.toMatch(/const\s*\{\s*count:\s*open\s*\}/);
  });
});

describe("the seams stay closed", () => {
  // A loader that throws is only safe if every caller that CANNOT throw catches
  // it. Route handlers have no error boundary; server actions owe their caller
  // an { ok, error }; client components have a toast that a rejection skips.
  // These scanners exist because the first remediation pass opened all three.

  const routes = [
    "../app/d/[token]/verify/route.ts",
    "../app/d/[token]/still/route.ts",
    "../app/d/[token]/talk/route.ts",
    "../app/d/[token]/fix/route.ts",
    "../app/d/[token]/resolved/route.ts",
  ];

  it("every dispute route handler catches ReadFailed", () => {
    // These are tapped from an SMS by a crew whose pay is on hold. Next has no
    // boundary for a route handler, so an uncaught throw is a bare 500.
    for (const r of routes) {
      const src = read(r);
      expect(src, `${r} must import ReadFailed`).toMatch(/ReadFailed/);
      expect(src, `${r} must catch it`).toMatch(/instanceof ReadFailed/);
      // And must not swallow: anything else still propagates.
      expect(src, `${r} must re-throw non-ReadFailed`).toMatch(/throw e/);
    }
  });

  it("'Already settled' is never printed for a read it could not do", () => {
    // The exact regression the first pass introduced: customerStill gained an
    // ok:false path, and the route headlined every !ok as "Already settled" —
    // telling somebody saying "still not right" that it was closed.
    for (const r of ["../app/d/[token]/still/route.ts", "../app/d/[token]/resolved/route.ts"]) {
      const src = read(r);
      // Match the GUARD, not the word. An earlier version of this test looked
      // for the substring "readFailed" and passed happily against a file where
      // every occurrence had been renamed — it was asserting nothing.
      const settled = src.search(/if\s*\(!r\.ok\)\s*return htmlPage\("Already settled/);
      expect(settled, `${r} lost its settled branch`).toBeGreaterThan(-1);
      const guard = src.search(/if\s*\(!r\.ok\s*&&\s*r\.readFailed\)/);
      expect(guard, `${r} must branch on r.readFailed before printing a verdict`).toBeGreaterThan(-1);
      expect(guard, `${r}: the readFailed branch must come FIRST`).toBeLessThan(settled);
      // The loader wrapper must flag it too, or the field is always false.
      expect(src, `${r} loader must set readFailed`).toMatch(/readFailed:\s*true/);
    }
  });

  it("a failed WRITE is not 'already settled' either", () => {
    // The same lie one layer down: a compare-and-set UPDATE returns an empty
    // array both when somebody else won the race AND when the write failed.
    const src = read("../lib/disputes.ts");
    const at = src.indexOf('resolution: "customer accepted"');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 700)).toMatch(/flipErr/);
  });

  it("the photo gate cannot be failed by a dropped connection", () => {
    // "No photos on this job yet — the crew can't be paid" off an unread list
    // is the non-negotiable rule in CLAUDE.md accusing a crew of a fault of ours.
    expect(read("../lib/photos.ts")).toMatch(/mustRead\(/);
  });

  it("the booking calendar refuses rather than drawing every day open", () => {
    const src = read("../app/book/actions.ts");
    expect(src).toMatch(/unavailable: true/);
    // The early "no such service" return must not be reachable by a failed read.
    expect(src).toMatch(/mustRead\(\s*"this service"/);
  });
});

describe("the surfaces the first sweep missed", () => {
  // The season simulation found these independently, in directories the 574-site
  // pass never opened. Each one is a sentence that accuses the reader or their
  // account of something, on a dropped connection.

  it("/requests cannot say 'No requests yet' to a full season", () => {
    const src = read("../app/requests/page.tsx");
    expect(src).toMatch(/mustRead\(\s*"your requests"/);
    // The honest empty state must survive — it is correct when it is true.
    expect(read("../app/requests/page.tsx")).toMatch(/No requests yet/);
    const bare = src.match(/const\s*\{\s*data:[^}]*\}\s*=\s*await\s+(query|groupQuery|admin)/g) ?? [];
    expect(bare, `still swallowing: ${bare.join(" | ")}`).toEqual([]);
  });

  it("/approvals cannot say 'No approvals waiting' with a crew in the driveway", () => {
    const src = read("../app/approvals/data.ts");
    expect(src).toMatch(/mustRead\(\s*"your approvals"/);
    expect((src.match(/const\s*\{\s*data\s*\}\s*=\s*await\s+admin/g) ?? [])).toEqual([]);
  });

  it("a job page cannot tell a customer their job was cancelled", () => {
    // loadCustomerJobDetail returning null renders "It may have been cancelled,
    // or it belongs to another account" — two accusations from one dropped read.
    const src = read("../app/requests/job-detail-data.ts");
    expect(src).toMatch(/mustRead\(\s*"this job"/);
    const bare = src.match(/const\s*\{\s*(data|count):[^}]*\}\s*=\s*await\s+admin/g) ?? [];
    expect(bare, `still swallowing: ${bare.join(" | ")}`).toEqual([]);
  });

  it("the card-on-file check cannot fail open", () => {
    // (cardCount ?? 0) > 0 on a failed count is false, and the page then tells
    // somebody with a card that their $450 is unpaid because they have none.
    const src = read("../app/requests/job-detail-data.ts");
    expect(src).toMatch(/mustCount\(\s*"whether you have a card on file"/);
    expect(src).not.toMatch(/\(cardCount \?\? 0\) > 0/);
  });
});
