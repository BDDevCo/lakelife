import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE MOW HAPPENS.
 *
 * An extra the owner asked for can be unanswered, refused by the crew or
 * turned down on price, and none of those may touch the visit it was asked
 * about. That is not a copy promise — every sentence in `addons.ts` makes it,
 * and a sentence is only as true as the code under it — so it is pinned
 * STRUCTURALLY: the whole feature writes exactly three money columns on
 * `jobs`, from exactly one function, and only for an extra the owner accepted.
 *
 * Scanned rather than executed: these are server actions needing a session, a
 * job, a crew and a property. What can break is the SHAPE — a future
 * convenience that holds the job while the crew thinks about a price, or
 * stands a crew down because an owner said no to $40 of cedar trimming.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
/** Comments stripped, so a sentence ABOUT a column can never satisfy a scan FOR it. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const actions = strip(read("./actions.ts"));

/**
 * ONE FUNCTION, NOT "FROM HERE TO THE END OF THE FILE".
 *
 * `src.slice(indexOf(name))` makes an assertion about file ORDERING: a guard
 * deleted from the first function is still found in the second, and the test
 * stays green. Verified by deleting one and watching it fail.
 */
function fnBody(src: string, name: string): string {
  const i = src.indexOf(name);
  if (i < 0) return "";
  const rest = src.slice(i + name.length);
  const next = rest.search(/\n(?:export )?(?:async )?function |\n(?:export )?(?:const|interface|type) /);
  return name + (next < 0 ? rest : rest.slice(0, next));
}
const data = strip(read("./data.ts"));
const migration = readFileSync(
  fileURLToPath(new URL("../../../supabase/migrations/0180_the_extra_they_asked_for.sql", import.meta.url)),
  "utf8",
);

describe("the scanner is reading the right files", () => {
  it("found all five steps and the migration", () => {
    for (const fn of ["askForAnExtra", "quoteAddon", "declineToQuote", "acceptAddon", "declineAddonPrice", "repeatAddon"]) {
      expect(actions, `${fn} is gone or renamed`).toContain(`export async function ${fn}`);
    }
    expect(migration).toContain("create table if not exists public.job_addons");
    expect(migration).toContain("create or replace function public.accept_job_addon");
  });
});

describe("nothing in this feature can stop a visit happening", () => {
  /** The columns that hold, stand down, reschedule or cancel a job. */
  const BLOCKERS = [
    "held_at",
    "held_flag_id",
    "stood_down_at",
    "stood_down_reason",
    "recovery_state",
    "reschedule_deadline",
    "no_show_at",
    "cancelled_at",
  ];

  it("the server actions never write one of them", () => {
    for (const col of BLOCKERS) {
      expect(actions, `the add-on actions touch jobs.${col} — an extra must never hold a visit`)
        .not.toContain(col);
    }
  });

  it("the server actions never write the jobs table at all", () => {
    // They READ a job (an extra cannot join a finished visit) and they must
    // never write one — not its status, not its money, not its day. Every
    // write in this file is on `job_addons`; the only thing that touches
    // `jobs` is the acceptance function in the migration, asserted below.
    //
    // Counted rather than pattern-matched, so a future `.from("jobs")` with a
    // chained `.update()` further down cannot slip past a fixed lookahead.
    const writes = [...actions.matchAll(/\.from\("([a-z_]+)"\)([\s\S]*?);/g)]
      .filter((m) => /\.update\(|\.insert\(|\.delete\(|\.upsert\(/.test(m[2]))
      .map((m) => m[1]);
    expect(writes.length, "no writes found — the scanner is not reading this file").toBeGreaterThan(3);
    expect([...new Set(writes)], "an add-on action writes a table other than job_addons")
      .toEqual(["job_addons"]);
  });

  it("the ONE write to jobs is inside accept_job_addon, and it is three money columns", () => {
    const fn = migration.slice(
      migration.indexOf("create or replace function public.accept_job_addon"),
      migration.indexOf("revoke execute on function public.accept_job_addon"),
    );
    expect(fn.length).toBeGreaterThan(500);
    const jobUpdate = fn.slice(fn.indexOf("update public.jobs"));
    expect(jobUpdate).toContain("set customer_price");
    expect(jobUpdate).toContain("vendor_cost");
    expect(jobUpdate).toContain("margin");
    for (const col of [...BLOCKERS, "status", "date", "vendor_id", "slot"]) {
      expect(jobUpdate, `accept_job_addon writes jobs.${col}`).not.toContain(`${col} =`);
    }
  });

  it("and it only runs for an extra the owner accepted", () => {
    const fn = migration.slice(migration.indexOf("create or replace function public.accept_job_addon"));
    expect(fn).toMatch(/if a\.status <> 'quoted' then/);
    expect(fn).toMatch(/for update/);
    expect(fn).toMatch(/owner is distinct from p_user/);
  });
});

describe("the crew's price is theirs, and the platform fee rides it", () => {
  it("the acceptance passes numbers from platform-fee and computes none of its own", () => {
    expect(actions).toContain('import {');
    expect(actions).toMatch(/addonMoney\(/);
    // No hand multiplication anywhere on this path.
    expect(actions, "an add-on action multiplies a quote by a fee by hand")
      .not.toMatch(/\*\s*\(1\s*[+-]/);
    expect(data, "the add-on loader multiplies a quote by a fee by hand")
      .not.toMatch(/\*\s*\(1\s*[+-]/);
  });

  it("freezes both percentages onto the row, the way 0174 freezes a job", () => {
    expect(actions).toMatch(/p_fee_customer_pct:\s*fee\.customerPct/);
    expect(actions).toMatch(/p_fee_crew_pct:\s*fee\.crewPct/);
    expect(migration).toMatch(/job_addons_money_all_or_nothing/);
    // And the database refuses a pair of numbers that does not tie back to the
    // crew's own quote at those frozen percentages.
    expect(migration).toMatch(/abs\(customer_price - round\(crew_quote \* \(1 \+ fee_customer_pct\), 2\)\)/);
    expect(migration).toMatch(/abs\(crew_payout\s+- round\(crew_quote \* \(1 - fee_crew_pct\),\s+2\)\)/);
  });

  it("never invents a price, a default or a suggested amount", () => {
    for (const src of [actions, data]) {
      expect(src).not.toMatch(/suggested|recommended|typicalPrice|defaultQuote/i);
    }
  });
});

describe("a remembered price cannot bill itself", () => {
  it("the staleness rule is applied in BOTH doorways, and its ANSWER is read", () => {
    // The loader draws the offer; the action writes the money. A page left
    // open overnight is exactly how a stale price would get through a rule
    // that lived only in the loader.
    //
    // AND `toMatch(/offerBack\(/)` ALONE PINS NOTHING: it is satisfied by a
    // call whose result is dropped on the floor — the "imported a guard and
    // called none of it" shape this codebase has shipped before. Each doorway
    // must be shown to BRANCH on what came back.
    expect(data, "the loader does not check staleness").toMatch(/offerBack\(/);
    expect(actions, "repeatAddon does not re-check staleness").toMatch(/offerBack\(/);
    expect(data, "the loader calls offerBack and ignores the answer").toMatch(/if \(!fresh\.offerable\)/);
    expect(actions, "an action calls offerBack and ignores the answer").toMatch(/if \(!fresh\.offerable\)/);
    // Three doorways now, not two: acceptAddon checks a LIVE quote's age too.
    expect((actions.match(/offerBack\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the clock runs from when the crew NAMED the number, never from a tap", () => {
    // `repeatAddon` files a fresh row and accepts it, and acceptance stamps
    // `decided_at`. Measuring freshness from `decided_at` therefore reset the
    // ninety days on every repeat, and a January price stayed offerable for
    // ever. `quoted_at` is carried FORWARD instead, unchanged.
    const fn = actions.slice(actions.indexOf("export async function repeatAddon"));
    expect(fn.length).toBeGreaterThan(500);
    expect(fn, "repeatAddon restamps quoted_at, which resets the staleness clock")
      .not.toMatch(/quoted_at: nowIso/);
    expect(fn).toMatch(/quoted_at: namedAt/);
    expect(fn).toMatch(/offerBack\(namedAt\)/);
    // And the memory reads the same column, or the two doorways age different
    // things.
    expect(data).toMatch(/offerBack\(r\.quoted_at as string \| null, now\)/);
    expect(data, "the memory still ages from decided_at").not.toMatch(/offerBack\(r\.decided_at/);
  });

  it("what the screen said and what gets billed are compared, not assumed equal", () => {
    // `getPlatformSettings` is cached per REQUEST; the render and the action
    // are two requests, so nothing makes the figure on the button the figure
    // in the write. Both money doorways take the shown price and refuse a
    // mismatch — and the type makes every caller pass one.
    // ONE FUNCTION EACH. `slice(indexOf(fn))` runs to the end of the file, so
    // `acceptAddon`'s assertion was satisfied by `repeatAddon`'s copy of the
    // guard further down — deleting acceptAddon's left this green. Verified by
    // deleting it and watching this go red.
    for (const fn of ["acceptAddon", "repeatAddon"]) {
      const body = fnBody(actions, `export async function ${fn}`);
      expect(body.length, `the scanner did not find ${fn}`).toBeGreaterThan(400);
      expect(body, `${fn} does not take the price the screen showed`).toMatch(/shownPrice/);
      expect(body, `${fn} does not compare it with what it is about to bill`)
        .toMatch(/Math\.abs\(shownPrice - m\.customerPrice\) > 0\.005/);
    }
    // THE CALLER, not just the symbol: a guard nobody passes an input to is a
    // guard that enforces nothing.
    const card = strip(read("../../components/AddonCard.tsx"));
    expect(card).toMatch(/acceptAddon\(addon\.id, addon\.offeredPrice\)/);
    const ask = strip(read("../../components/AskForAnExtra.tsx"));
    expect(ask).toMatch(/repeatAddon\(jobId, r\.sourceId, r\.priceNow\)/);
  });

  it("one visit cannot be used as an unlimited channel at a crew's own phone", () => {
    // Every request is an SMS AND an email at a named contractor's personal
    // number. Nothing moderates it in either direction, so the count is the
    // only control there is — and a FAILED count must not make the guard pass.
    const fn = fnBody(actions, "export async function askForAnExtra");
    expect(fn).toMatch(/ADDON_OPEN_REQUESTS_MAX/);
    expect(fn).toMatch(/\.eq\("status", "requested"\)/);
    expect(fn, "a failed count is read as zero, which passes the guard")
      .toMatch(/openRes\.error \|\| openRes\.count == null/);
    // The cap counts UNANSWERED only, or a busy household is locked out for good.
    expect(fn).not.toMatch(/\.in\("status", \["requested", "quoted"/);
  });

  it("the same extra cannot be tapped onto one visit twice", () => {
    const fn = actions.slice(actions.indexOf("export async function repeatAddon"));
    expect(fn).toMatch(/already on this visit/);
    expect(fn).toMatch(/\.in\("status", \["requested", "quoted", "accepted"\]\)/);
  });

  it("a package visit refuses an extra in every doorway, including the database", () => {
    // A package's bill is the sum of its legs (requests/package-data.ts) and
    // an extra is not a leg. A rule in one doorway of four is not a rule.
    expect(actions.slice(actions.indexOf("export async function askForAnExtra"))).toMatch(/job\.group_id/);
    expect(actions.slice(actions.indexOf("export async function repeatAddon"))).toMatch(/job\.group_id/);
    expect(actions.slice(actions.indexOf("export async function acceptAddon"))).toMatch(/a\.jobGroupId/);
    expect(data).toMatch(/job\.group_id as string \| null/);
    expect(migration).toMatch(/if j_group is not null then/);
  });

  it("no raw Postgres sentence can reach a homeowner", () => {
    // `new row for relation "job_addons" violates check constraint ...` is for
    // the log, not for somebody holding a phone.
    expect(actions, "an action returns error.message straight to the screen")
      .not.toMatch(/error: (?:ins|upd|rpcErr|error|srcRes)\.(?:error\.)?message/);
    expect(actions).toMatch(/function writeFailed\(/);
    expect(actions).toMatch(/console\.error\(`\[addons\] \$\{what\} failed:`/);
  });

  it("repeatAddon re-checks the crew, the property and the service against the source row", () => {
    const fn = actions.slice(actions.indexOf("export async function repeatAddon"));
    expect(fn).toMatch(/src\.property_id !== job\.property_id/);
    expect(fn).toMatch(/src\.vendor_id !== job\.vendor_id/);
    expect(fn).toMatch(/src\.service_id \?\? null\) !== \(job\.service_id \?\? null\)/);
    expect(fn).toMatch(/src\.status !== "accepted"/);
  });

  it("nothing auto-accepts, auto-renews or arrives pre-ticked", () => {
    for (const src of [actions, data]) {
      expect(src).not.toMatch(/auto[_A-Za-z]*accept|autoRenew|auto_renew|defaultChecked|checked=\{true\}/i);
    }
  });
});

describe("a failed read is never an empty one", () => {
  it("the loaders throw rather than returning [] on a failed read", () => {
    // "You have no extras waiting" printed over a read that did not happen is
    // how somebody's crew waits all day for an answer that was on screen.
    expect(data).toMatch(/mustRead\("your extras"/);
    expect(data).toMatch(/mustRead\("the extras on this visit"/);
    expect(data).toMatch(/mustRead\("what this crew has charged you before"/);
  });

  it("the actions say which failure happened rather than accusing the owner", () => {
    expect(actions).toMatch(/readFailedMessage\(/);
    expect(actions).toMatch(/readFailed: true/);
    // And the money paths say no money moved.
    expect(actions).toMatch(/\{ money: true \}/);
  });
});
