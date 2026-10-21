import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A CREW IS PAID. IT IS NEVER A MERCHANT.
 *
 * Brendon, 20 October 2026: "I dont want a crew to have to register for an
 * additional merchant account, it needs to be seemless and have to not credit
 * check or whatever that a typical merchant account needs"
 *
 * This reverses half of Architecture A. The park-owner half stands — a park
 * owner ACCEPTS rent, so a park owner must be a merchant, which is why 0196
 * exists. The crew half was wrong: a LakeLife crew never accepts a payment.
 * The homeowner buys from LakeLife at one all-in price and the crew is
 * LakeLife's subcontractor, paid about 70% and never shown what the customer
 * paid. That is accounts payable, not a merchant relationship.
 *
 * PROVEN AGAINST PRODUCTION BEFORE THE FIX, rolled back: a DRAFT crew row with
 * can_accept_card = true was ACCEPTED, and so was a fully ACTIVE crew merchant
 * carrying card and ACH with payouts switched off. Zero rows existed in the
 * table, so nothing needed backfilling.
 *
 * PROVEN AFTER: crew+card refused, crew+ach refused, crew live-merchant
 * refused, crew payout recipient accepted, park card+ach accepted, park live
 * merchant accepted. That last pair is the assertion that matters most — a
 * constraint that protected crews by breaking rent would be the worse bug.
 *
 * WHAT THIS FILE IS FOR. The database holds the guarantee; the migration's own
 * post-conditions hold the behavioural proof. These tests exist because the
 * MIGRATION ITSELF is now a load-bearing document, and two specific ways of
 * damaging it are invisible to every other test in this suite:
 *
 *   1. Rewriting `guard_processor_account()` and dropping a clause. This
 *      already happened once in this repo — a draft of 0198 rebuilt
 *      `guard_park_refund` from memory and silently lost `for update`, a
 *      documented race guard. 0200 replaces the same kind of function.
 *   2. Weakening a post-condition so it passes for the wrong reason.
 */

const here = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const sql0200 = here("../../supabase/migrations/0200_a_crew_is_paid_it_is_never_a_merchant.sql");
const sql0196 = here("../../supabase/migrations/0196_who_the_money_settles_to.sql");

describe("the guarantee the database holds", () => {
  it("A CREW ROW CAN NEVER CLAIM TO ACCEPT MONEY", () => {
    expect(sql0200).toMatch(/add constraint processor_accounts_a_crew_only_receives/);
    // The whole predicate, not a token from it. `vendor_id is null or (...)`
    // is the shape that leaves a PARK row alone, and a mutation dropping the
    // `vendor_id is null` disjunct would break rent instead of crews.
    expect(sql0200).toMatch(
      /check \(\s*\n?\s*vendor_id is null\s*\n?\s*or \(can_accept_ach is false and can_accept_card is false\)\s*\n?\s*\)/,
    );
  });

  it("and it says `is false`, NOT `= false` — a CHECK passes on NULL", () => {
    // The columns are NOT NULL today. If a later migration drops that,
    // `is false` REFUSES a null where `= false` evaluates to null and lets the
    // row through. This repo has already paid for that lesson once: only a
    // NULL probe detects the hole, never a wrong value.
    const clause = sql0200.slice(
      sql0200.indexOf("add constraint processor_accounts_a_crew_only_receives"),
    ).slice(0, 300);
    expect(clause).toMatch(/can_accept_ach is false/);
    expect(clause).toMatch(/can_accept_card is false/);
    expect(clause, "`= false` lets a NULL through").not.toMatch(/can_accept_(ach|card) = false/);
  });

  it("the trigger says it in words, because a constraint name teaches nobody", () => {
    expect(sql0200).toMatch(/a crew receives money, it never accepts it/);
    expect(sql0200).toMatch(/never credit-checked or underwritten/);
    // And it names what to do instead, rather than only forbidding — the
    // "copy that instructs an action the screen lacks" lesson applied to an
    // error message a developer will hit months from now.
    expect(sql0200).toMatch(/a product decision and a new migration, not a capability flag/);
  });

  it("AND IT ASKS FIRST, before the clauses about stamps and shapes", () => {
    // Structural, not vacuous. There is no reachable row that trips both this
    // clause and the active-shape checks in a way that changes the output, so
    // an ordering assertion phrased behaviourally would pass under a reorder.
    // Position in the source is the thing that is actually claimed.
    const body = sql0200.slice(sql0200.indexOf("create or replace function public.guard_processor_account"));
    const crew = body.indexOf("a crew receives money, it never accepts it");
    const update = body.indexOf("if tg_op = 'UPDATE' then");
    const active = body.indexOf("an active merchant needs the id the processor gave it");
    expect(crew).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(-1);
    expect(active).toBeGreaterThan(-1);
    expect(crew, "the crew clause must come before the UPDATE block").toBeLessThan(update);
    expect(crew, "the crew clause must come before the active-shape block").toBeLessThan(active);
  });
});

describe("0200 REPLACED a live function and must not have eaten a clause", () => {
  /**
   * THE EXPENSIVE MISTAKE THIS EXISTS TO CATCH.
   *
   * 0200 does `create or replace function public.guard_processor_account()`.
   * Every guard 0196 put in that function has to survive, and a rewrite that
   * drops one is silent: the trigger still exists, still fires, still passes
   * every other test, and no longer refuses the thing it was written for.
   *
   * So: take 0196's clauses from 0196 itself rather than listing them here.
   * A hand-written list is a copy, and testing a copy is how you pass while
   * the real thing is gone.
   */
  const clausesIn = (src: string) => {
    const start = src.indexOf("create or replace function public.guard_processor_account");
    expect(start, "guard_processor_account is gone from this migration").toBeGreaterThan(-1);
    const body = src.slice(start);
    return [...body.matchAll(/raise exception '(processor_accounts: [^']*(?:''[^']*)*)'/g)].map((m) => m[1]);
  };

  const original = clausesIn(sql0196);
  const replacement = clausesIn(sql0200);

  it("0196 had clauses to preserve in the first place — or this proves nothing", () => {
    // If the scanner stops matching, every assertion below passes vacuously.
    expect(original.length, "the scanner found no clauses in 0196 — repoint it").toBeGreaterThanOrEqual(7);
  });

  it("EVERY ONE OF 0196's CLAUSES IS STILL THERE", () => {
    for (const clause of original) {
      expect(replacement, `0200 dropped this guard: "${clause.slice(0, 60)}…"`).toContain(clause);
    }
  });

  it("and 0200 added exactly one of its own", () => {
    const added = replacement.filter((c) => !original.includes(c));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/a crew receives money, it never accepts it/);
  });
});

describe("the post-conditions prove all six things, and for the right reasons", () => {
  const post = sql0200.slice(sql0200.indexOf("POST-CONDITIONS"));

  it("the three REFUSALS are each proven separately", () => {
    // One clause covers both capability columns, which is exactly the shape
    // where a mutation to the second half goes unnoticed. So card and ACH are
    // probed apart, and the live-merchant case apart again because that is the
    // row that would actually have taken somebody's money.
    expect(post).toMatch(/a crew row claiming it accepts cards was still accepted/);
    expect(post).toMatch(/a crew row claiming it accepts ACH was still accepted/);
    expect(post).toMatch(/a crew could still be switched on as a live card-accepting merchant/);
  });

  it("EACH REFUSAL CHECKS IT WAS REFUSED FOR THE RIGHT REASON", () => {
    // `exception when others` catches a foreign-key violation and a typo too.
    // An assertion that passes because the INSERT failed for an unrelated
    // reason proves nothing about the clause it was written for — and all
    // three probes read as green while the guard is absent.
    //
    // EVERY OCCURRENCE, counted. Three probes, three message checks, plus the
    // one in the trigger itself.
    const checks = [...post.matchAll(/msg not like '%receives money, it never accepts it%'/g)];
    expect(checks.length, "a refusal probe has no reason-check").toBe(3);
  });

  it("the two ACCEPTANCES are proven too — the guard must not close the right door", () => {
    expect(post).toMatch(/a crew can no longer be recorded as a payout recipient/);
    expect(post).toMatch(/can_receive_payout/);
  });

  it("AND A PARK OWNER IS PROVEN UNTOUCHED, draft and live", () => {
    // The assertion that matters most. Flow B — rent online — is a park owner
    // accepting card and ACH. A constraint that protected crews by breaking
    // rent would be a worse bug than the one it fixed, and nothing else in
    // this suite would have noticed.
    expect(post).toMatch(/a PARK can no longer be recorded as accepting card and ACH/);
    expect(post).toMatch(/this has broken Flow B/);
    expect(post).toMatch(/a park owner can no longer go live as a merchant/);
  });

  it("every post-condition RAISES rather than reporting", () => {
    // `raise notice` is not returned by the MCP, so a post-condition that
    // merely noticed a failure would apply the migration and say nothing.
    const reports = [...post.matchAll(/0200 FAILED/g)];
    expect(reports.length).toBeGreaterThanOrEqual(8);
    for (const m of reports) {
      const line = post.slice(post.lastIndexOf("\n", m.index ?? 0), m.index ?? 0);
      expect(line, "a 0200 FAILED that only notices").toMatch(/raise exception/);
    }
  });

  it("and the probe rows roll back rather than being deleted by hand", () => {
    // Caught inside the block's own exception handler, so the subtransaction
    // unwinds and nothing is left behind. A trailing DELETE would be one typo
    // away from leaving probe rows in a production money table.
    expect(post).toMatch(/0200 PROVEN/);
    expect(post).toMatch(/exception when others then\s*\n\s*if sqlerrm like '%0200 PROVEN%'/);
  });
});

describe("what 0200 deliberately did NOT do, stated so nobody 'fixes' it", () => {
  it("it does not gate a payout on can_receive_payout, and says why", () => {
    // That read belongs in runMonthlyPayoutBatches — but it would be a gate
    // that can never open, because no application code writes a vendor row
    // here at all. Every door in processor-actions.ts is park-scoped. Adding
    // the branch now would be unreachable code; adding the door now would
    // invent a processor contract that does not exist.
    // ANCHORED ON SINGLE-LINE PHRASES. The commentary wraps at 79 columns, so
    // "a gate that can never open" and "a column with no writer" are each
    // split across two `--` lines. A regex spanning the break fails for a
    // reason that is not the point — which is how the first draft of this test
    // failed, and the same trap 0199's tests already carry a note about.
    expect(sql0200).toMatch(/that can never open/);
    expect(sql0200).toMatch(/NO APPLICATION CODE WRITES A VENDOR ROW HERE AT/);
  });

  it("and it names the column-with-no-writer honestly instead of implying coverage", () => {
    expect(sql0200).toMatch(/with no writer/);
    expect(sql0200).toMatch(/has no reader that decides/);
  });
});
