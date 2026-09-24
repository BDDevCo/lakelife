import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ownerStateSentence, crewStateSentence } from "@/lib/addons";

/**
 * AN EXTRA CANNOT OUTLIVE THE CREW THAT PRICED IT.
 *
 * THE HOLE: an accepted add-on's money is folded into `jobs.customer_price`
 * and `jobs.vendor_cost`. Six application doorways null `vendor_cost`, hand
 * the job back to the board and re-assign it at a different crew's base rate —
 * and every one of them deliberately leaves `customer_price` alone, because
 * that is what keeps dispatch's agreed-price guard armed. So after a release:
 *
 *   MENU-PRICED — the owner keeps being billed base + $44.80, the replacement
 *   crew is paid base and is never told an extra exists, and LakeLife silently
 *   keeps the whole of the extra. The invoice is raised straight off
 *   `jobs.customer_price` by `settleJob`, with no human in the loop.
 *
 *   CREW-PRICED — `customer_price` now carries a figure no crew's rate card
 *   can reproduce, so `autoAssignJob`'s guard and the claim board's guard
 *   refuse EVERY crew on the lake, for ever, with nothing on any screen naming
 *   the add-on as the cause.
 *
 * A RULE IN ONE DOORWAY OF SIX IS NOT A RULE, so it is not written in any of
 * them: `vendor_id` is the one column all six move, and 0180 puts a BEFORE
 * UPDATE trigger on it. This file pins the trigger's shape, the state it
 * files, the constraint that lets it write, and the sentence each side reads.
 */

const readAt = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const migration = readAt("../../../supabase/migrations/0180_the_extra_they_asked_for.sql");

/** The six doorways the migration's comment names, relative to this file. */
const DOORWAYS = [
  "../vendor/actions.ts",
  "../requests/actions.ts",
  "../../lib/automation.ts",
  "../book/dispatch.ts",
  "../vendor/open-actions.ts",
];

describe("the doorways the fix exists for are really there", () => {
  it("the migration quotes a count, and the count is still right", () => {
    // TRACE THE NUMBER BEFORE QUOTING IT. The comment claims seven writes
    // across five files; if somebody adds an eighth, the explanation above is
    // stale and the trigger's rationale should be read again.
    let writes = 0;
    for (const rel of DOORWAYS) writes += (readAt(rel).match(/vendor_cost: null/g) ?? []).length;
    expect(writes, "the migration says SEVEN writes null vendor_cost").toBe(7);
    expect(migration).toMatch(/SEVEN writes across FIVE\n-- files null `vendor_cost`/);
  });

  it("every file named in the migration still nulls vendor_cost and leaves customer_price", () => {
    // TRACE THE IMPORT BEFORE QUOTING A NUMBER: a comment naming five files is
    // a claim, and a claim has to be earned by the code. If one of these stops
    // nulling `vendor_cost`, the explanation above is stale and somebody
    // should read it again.
    for (const rel of DOORWAYS) {
      const src = readAt(rel);
      expect(src, `${rel} no longer nulls vendor_cost — the trigger's rationale names it`)
        .toMatch(/vendor_cost: null/);
    }
  });

  it("and none of them re-implements the unwind, because there is one author", () => {
    for (const rel of DOORWAYS) {
      expect(readAt(rel), `${rel} has grown its own add-on unwind — the rule lives in the database`)
        .not.toMatch(/crew_left/);
    }
  });
});

describe("the trigger that takes the extra back off", () => {
  it("fires BEFORE the update, on vendor_id, on jobs", () => {
    expect(migration).toMatch(
      /create trigger jobs_addon_follows_the_crew\s*\n\s*before update of vendor_id on public\.jobs\s*\n\s*for each row execute function public\.guard_addons_follow_the_crew\(\);/,
    );
    // BEFORE, not AFTER: it rewrites `new`, and an AFTER trigger cannot.
    expect(migration).not.toMatch(/after update of vendor_id on public\.jobs/);
  });

  it("runs before jobs_money_shape, which is by NAME and therefore fragile", () => {
    // Postgres fires same-timing row triggers in name order, so the margin
    // this one writes has to be written before 0050's guard reconciles it.
    expect("jobs_addon_follows_the_crew" < "jobs_money_shape").toBe(true);
    // And the migration asserts it at ship time rather than trusting a comment.
    expect(migration).toMatch(/sorts after jobs_money_shape/);
  });

  it("only bites when the crew actually changes, and only on that crew's extras", () => {
    const fn = migration.slice(
      migration.indexOf("create or replace function public.guard_addons_follow_the_crew"),
      migration.indexOf("drop trigger if exists jobs_addon_follows_the_crew"),
    );
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).toMatch(/if old\.vendor_id is null or old\.vendor_id is not distinct from new\.vendor_id then\s*\n\s*return new;/);
    expect(fn).toMatch(/and vendor_id = old\.vendor_id\s*\n\s*and status = 'accepted'/);
  });

  it("takes the money off BOTH ends and re-derives the margin", () => {
    const fn = migration.slice(
      migration.indexOf("create or replace function public.guard_addons_follow_the_crew"),
      migration.indexOf("drop trigger if exists jobs_addon_follows_the_crew"),
    );
    expect(fn).toMatch(/new\.customer_price := round\(new\.customer_price - c_sum, 2\);/);
    expect(fn).toMatch(/new\.vendor_cost := round\(new\.vendor_cost - p_sum, 2\);/);
    expect(fn).toMatch(/new\.margin := round\(new\.customer_price - new\.vendor_cost, 2\);/);
    // A NULL IS NOT A ZERO. dispatch's own release path nulls customer_price
    // on a job it had just frozen; subtracting from nothing would invent a
    // negative price out of an absent one.
    expect(fn).toMatch(/if new\.customer_price is not null then/);
  });

  it("files the row as crew_left WITH its frozen money, and stamps when", () => {
    const fn = migration.slice(
      migration.indexOf("create or replace function public.guard_addons_follow_the_crew"),
      migration.indexOf("drop trigger if exists jobs_addon_follows_the_crew"),
    );
    expect(fn).toMatch(/set status = 'crew_left', unwound_at = now\(\)/);
    // The all-or-nothing CHECK has to put crew_left on the MONEY side, or that
    // very update bounces and the trigger can never run.
    expect(migration).toMatch(/\(status in \('accepted', 'crew_left'\)\s*\n\s*and fee_customer_pct is not null/);
    expect(migration).toMatch(/status not in \('accepted', 'crew_left'\)\s*\n\s*or \(/);
    // And `unwound_at` has a writer AND a rule: it is exactly the crew_left rows.
    expect(migration).toMatch(/check \(\(status = 'crew_left'\) = \(unwound_at is not null\)\)/);
  });

  it("the post-conditions prove BOTH directions, and roll back", () => {
    expect(migration).toMatch(/the crew left and the owner is STILL billed the extra/);
    expect(migration).toMatch(/the add-on was not filed as crew_left with its frozen money intact/);
    expect(migration).toMatch(/an unwound add-on is still readable as accepted/);
    expect(migration).toMatch(/raise exception 'ROLLBACK_POSTCONDITION';/);
  });
});

describe("what each side is told", () => {
  it("the owner is told it came OFF the bill, and it is not an alarm", () => {
    const v = ownerStateSentence({ status: "crew_left", serviceName: "weekly mow", price: "$44.80" });
    expect(v.line).toMatch(/no longer on this visit/);
    expect(v.line).toMatch(/won't be charged for it/);
    expect(v.line).toMatch(/goes ahead as booked/);
    expect(v.tone).not.toBe("red");
    expect(v.line).not.toMatch(/error|failed|went wrong/i);
  });

  it("the crew is told they are not doing it and not paid for it", () => {
    const v = crewStateSentence({ status: "crew_left" });
    expect(v.line).toMatch(/aren't expected to do it/);
    expect(v.line).toMatch(/aren't paid for it/);
  });

  it("an unwound extra is never offered back as a remembered price", () => {
    // The memory reads `status = 'accepted'` only, and `repeatAddon` re-checks
    // the source row — so a price that came off a visit cannot be tapped onto
    // the next one as if it had stood.
    const data = readAt("./data.ts");
    expect(data).toMatch(/\.eq\("status", "accepted"\)/);
    const actions = readAt("./actions.ts");
    expect(actions).toMatch(/src\.status !== "accepted"/);
  });
});
