import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A RETURNED REFERRAL PAYOUT COULD NEVER BE PAID AGAIN.
 *
 * From the money-rails audit. Two paths strand the same money, and the reason
 * both did is that the money had no way to name the batch carrying it.
 *
 * A JOB payout is a `payouts` row a batch claims by id, so freeing it is one
 * update — `batch_id = null` — and `markBatchesReturned` does exactly that,
 * calling it "the half that lets the crew be paid again".
 *
 * A REFERRAL batch is not shaped like that. It creates a `payout_batches` row
 * with `kind = 'referral'` and **no payouts rows at all**: the
 * `referral_earnings` ARE the money, flipped 'matured' -> 'paid' as they are
 * gathered. So the update matched nothing, the earnings stayed 'paid', and the
 * next run reads only 'matured'. The nightly stranded-batch sweep did the same
 * thing by cron.
 *
 * AND IT COULD NOT BE FIXED WITHOUT A COLUMN. Nothing recorded which earnings
 * rode which batch, and "reopen this payee's paid rows" would have reopened
 * months of successful payouts with them. 0199 adds the link; this pins the
 * three places that now read or write it.
 *
 * PROVEN AGAINST PRODUCTION, rolled back: a link on a matured row refused, the
 * flip recording its batch, a scoped reopen that left a credit-settled row
 * alone, and an earning surviving its batch's deletion.
 */

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const here = (p: string) => strip(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));

const payouts = here("./payout-actions.ts");
const automation = here("../../lib/automation.ts");
const sql = readFileSync(fileURLToPath(
  new URL("../../../supabase/migrations/0199_a_returned_referral_payout_can_be_paid_again.sql", import.meta.url)),
  "utf8");

describe("the writer records which batch carried the money", () => {
  it("THE FLIP TO PAID CARRIES ITS BATCH ID", () => {
    // In the same write, so there is no window in which an earning is paid and
    // unattributable — which is the state the whole defect was made of.
    expect(automation).toMatch(
      /\.update\(\{ status: "paid", payout_batch_id: batch\.id \}\)/);
  });

  it("but NO CREDIT-SETTLED flip does, because none of them has a batch", () => {
    // A customer's matured earning is settled as account credits and reaches
    // 'paid' with no batch anywhere, which is why 0199's column is nullable.
    //
    // EVERY OCCURRENCE, not the first one. There are three
    // `CREDIT_SETTLED_STATUS` writes in this file, and the first version of
    // this test used `indexOf` — so a mutation that added a batch id to the
    // THIRD one left the assertion reading a clean copy of the first and
    // passing. A scan that stops at the first match cannot pin the others.
    const hits = [...automation.matchAll(/CREDIT_SETTLED_STATUS/g)].map((m) => m.index ?? 0);
    expect(hits.length, "the credit-settled writes are gone — repoint this")
      .toBeGreaterThanOrEqual(3);
    for (const at of hits) {
      const write = automation.slice(Math.max(0, at - 80), at + 160);
      expect(write, `a credit-settled flip at ${at} records a batch id`)
        .not.toMatch(/payout_batch_id/);
    }
  });

  it("and the in-run unwind clears BOTH columns", () => {
    // 0199's CHECK refuses a batch link on a row that is not paid, so a
    // status-only rollback would be rejected by the database.
    expect(automation).toMatch(
      /\.update\(\{ status: "matured", payout_batch_id: null \}\)\s*\n\s*\.eq\("id", id\)\.eq\("status", "paid"\)/);
  });
});

describe("the return path can now find its own money", () => {
  it("REOPENS THE EARNINGS, scoped to the returned batches", () => {
    const at = payouts.indexOf('.from("referral_earnings")');
    expect(at, "the referral reopen is gone — repoint this").toBeGreaterThan(-1);
    const block = payouts.slice(at, at + 420);
    expect(block).toMatch(/\.update\(\{ status: "matured", payout_batch_id: null \}\)/);
    expect(block).toMatch(/\.in\("payout_batch_id", returned\)/);
    // ONLY THE ONES THAT WERE PAID. Scoping by batch alone would be enough
    // today, but a row that is matured already has no link to match.
    expect(block).toMatch(/\.eq\("status", "paid"\)/);
  });

  it("and a failed reopen is reported, never reported as success", () => {
    // The return is already recorded at that point, so "it will go out again
    // next month" is the part that has stopped being true — the same shape as
    // the payouts failure beside it.
    const at = payouts.indexOf("if (reopenErr)");
    expect(at, "the reopen error branch is gone — repoint this").toBeGreaterThan(-1);
    const branch = payouts.slice(at, at + 520);
    expect(branch).toMatch(/ok: false/);
    expect(branch).toMatch(/still marked paid/);
    expect(branch).toMatch(/fix this by hand/);
  });

  it("the success sentence says how many came back", () => {
    // So a month where the figure is zero and should not have been is visible
    // to somebody rather than silent.
    expect(payouts).toMatch(/reopened > 0/);
    expect(payouts).toMatch(/back to maturing/);
  });
});

describe("the nightly sweep hands back the referral half too", () => {
  it("REOPENS BEFORE IT DELETES, and the order is load-bearing", () => {
    // The foreign key is ON DELETE SET NULL, so deleting first nulls the link
    // and leaves the row at 'paid' with nothing left to identify it by.
    const at = automation.indexOf('.eq("payout_batch_id", id)');
    expect(at, "the sweep reopen is gone — repoint this").toBeGreaterThan(-1);
    const del = automation.indexOf('.delete().eq("id", id).eq("status", "building")');
    expect(del).toBeGreaterThan(at);
  });

  it("a failed reopen skips that batch rather than deleting it anyway", () => {
    const at = automation.indexOf("if (reopenErr) {");
    expect(at).toBeGreaterThan(-1);
    const branch = automation.slice(at, at + 400);
    expect(branch).toMatch(/could not be handed back/);
    expect(branch).toMatch(/continue;/);
  });

  it("and what it released counts both kinds", () => {
    expect(automation).toMatch(
      /released \+= \(freed \?\? \[\]\)\.length \+ \(reopened \?\? \[\]\)\.length;/);
  });
});

describe("the column, and what the database refuses", () => {
  it("a batch link only exists on a paid row", () => {
    expect(sql).toMatch(/check \(payout_batch_id is null or status = 'paid'\)/);
  });

  it("the earning survives its batch being deleted", () => {
    // The sweep DELETES a batch that never finished assembling, and the money
    // must not go with it.
    expect(sql).toMatch(/on delete set null/);
  });

  it("and the probe proves the reopen is SCOPED — not every paid row", () => {
    // The assertion that matters: a payee with earlier successful payouts has
    // older 'paid' rows, and a wider update would have reopened those too.
    expect(sql).toMatch(/\[d credit-settled row untouched=%s\]/);
    expect(sql).toMatch(/an unrelated paid earning was reopened/);
  });

  it("nothing needed backfilling, which is why it was free to close now", () => {
    // Anchored on single-line phrases: the commentary wraps, and a regex
    // spanning a line break would fail for a reason that is not the point.
    expect(sql).toMatch(/NOTHING TO BACKFILL/);
    expect(sql).toMatch(/closes the hole before the first referral is/);
  });
});
