import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * FIFTY-FOUR TAPS FOR EIGHTEEN AMOUNTS THE LEDGER ALREADY KNEW.
 *
 * The first week of January is eighteen cheques through the door. Keying them
 * was: find the row, "Record payment", a five-field form whose amount was
 * already correct, "Record it" — then a receipt panel opening at the TOP of the
 * page, pushing the ledger down, so the next act was scrolling back to hunt for
 * the next row. Three taps and a lost scroll position, eighteen times.
 *
 * The batch door loops the ONE money door. These pin the properties that make
 * that safe, because a second insert path into park_payments is the one thing
 * this module must never grow.
 */
const src = readFileSync(
  fileURLToPath(new URL("./ledger-actions.ts", import.meta.url)), "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const fn = () => {
  const at = src.indexOf("export async function recordPaymentBatch");
  expect(at, "recordPaymentBatch is gone — this scan measures nothing").toBeGreaterThan(-1);
  return src.slice(at);
};

describe("keying a stack of cheques", () => {
  it("records through the one money door and inserts nothing itself", () => {
    const body = fn();
    expect(body).toMatch(/await recordPayment\(/);
    // THE WHOLE POINT. Every guard recordPayment has — the method whitelist,
    // the date window, the idempotency index, the refusal on a void bill, the
    // claim the insert answers, the receipt number — is a guard this has only
    // because it does not do its own insert.
    expect(body, "the batch grew its own insert into park_payments")
      .not.toMatch(/from\("park_payments"\)[\s\S]{0,80}\.insert/);
  });

  it("asserts membership before it touches anything", () => {
    const body = fn();
    const gate = body.indexOf("assertMyPark");
    const work = body.indexOf("await recordPayment(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(work);
  });

  it("carries an idempotency key per row, not one for the batch", () => {
    // A double-tapped Record must collide on 0081's unique index rather than
    // record eighteen payments twice and burn thirty-six receipt numbers.
    // The field is declared on BatchPaymentRow, above the function; the use is
    // inside it. Each is asserted where it actually lives.
    expect(src, "the row type lost its key").toMatch(/idempotencyKey: string/);
    expect(fn(), "the batch stopped passing the row's key through")
      .toMatch(/idempotencyKey: r\.idempotencyKey|r\.idempotencyKey/);
  });

  it("does not stop at the first refusal", () => {
    // One bad row must not strand seventeen good cheques, and a batch that
    // stopped early would leave him guessing which had landed.
    const body = fn();
    const loop = body.slice(body.indexOf("for (const r of rows)"));
    expect(loop).toMatch(/outcomes\.push/);
    expect(loop, "the loop breaks or throws on a refusal").not.toMatch(/\bbreak\b|\bthrow\b/);
  });

  it("answers for every row, named by lot", () => {
    const body = fn();
    expect(body).toMatch(/lotNumber/);
    expect(body).toMatch(/outcomes\.filter\(\(o\) => !o\.ok\)/);
    // "17 of 18 recorded" is a number he cannot act on.
    expect(body).toMatch(/didn't go/);
  });

  it("refuses an empty tick-list rather than reporting success over nothing", () => {
    expect(fn()).toMatch(/Nothing ticked/);
  });

  it("says nothing was recorded when nothing was", () => {
    const body = fn();
    expect(body).toMatch(/recorded === 0/);
    expect(body).toMatch(/Nothing was recorded/);
  });
});

describe("the sheet itself", () => {
  const ui = readFileSync(
    fileURLToPath(new URL("../../components/ParkRent.tsx", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const comp = () => {
    const at = ui.indexOf("function CheckRun({");
    expect(at, "CheckRun is gone — this scan measures nothing").toBeGreaterThan(-1);
    return ui.slice(at, ui.indexOf("\nfunction ", at + 10));
  };

  it("opens with NOTHING ticked", () => {
    // The sheet asks which cheques he is holding. It must never assert that
    // everybody paid and invite him to untick the ones who did not — the same
    // shape as the pre-ticked "they signed" that wrote nineteen leases nobody
    // had signed.
    const c = comp();
    expect(c).toMatch(/setOn\(\{\}\)/);
    expect(c, "a row is ticked by default").not.toMatch(/checked=\{true\}/);
    expect(c).toMatch(/checked=\{!!on\[r\.id\]\}/);
  });

  it("prefills the amount from the bill and lets him change it", () => {
    const c = comp();
    expect(c).toMatch(/r\.balance\.toFixed\(2\)/);
    expect(c).toMatch(/setAmounts\(\{ \.\.\.amounts/);
  });

  it("will not submit with nothing ticked", () => {
    expect(comp()).toMatch(/disabled=\{busy \|\| ticked\.length === 0\}/);
  });

  it("names the count and the total on the button, so the tap is a decision", () => {
    expect(comp()).toMatch(/Record \$\{ticked\.length\} — \$\{money\(total\)\}/);
  });

  it("keeps the failures on screen rather than only in a toast", () => {
    // A toast scrolls away; "which cheque did not land" has to stay answerable.
    const c = comp();
    expect(c).toMatch(/setFailures\(/);
    expect(c).toMatch(/Lot \{f\.lotNumber\}/);
  });

  it("only offers itself when more than one bill is owing", () => {
    // For a single bill the row's own button is already the shortest path.
    expect(ui).toMatch(/\.length > 1 && \(\s*<CheckRun/);
  });
});
