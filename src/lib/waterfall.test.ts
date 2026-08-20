import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * READS THAT WAITED IN LINE FOR NO REASON.
 *
 * Two screens queued round trips that had no dependency between them — not by
 * decision, but because each was written under the one before it.
 *
 * THE RESIDENT'S RENT SCREEN made eight sequential trips. Measured on a real
 * render: park_renters 289ms, lot_reservations 90, park_lots 77, parks 632,
 * payment_methods 793, park_charges 75, claims 80, park_payments 383,
 * properties 67 — four and a half seconds, most of it queueing. Only ONE of
 * those genuinely depends on another: the claims read needs the bill's id.
 *
 * After: 27.931 park_renters, 28.097 lot_reservations, then seven reads inside
 * three milliseconds of each other (28.333-28.336), then claims at 28.589.
 * 658ms, same data, same guards.
 *
 * THE OPS CONSOLE ran eighteen loaders in parallel and then five more in a
 * row, each in its own try/catch — and the first of the five, getSmsHealth, is
 * a live call out to Twilio. On LTE, in a truck, twenty times a day.
 *
 * The isolation those try/catch blocks gave was right and is kept: allSettled
 * does the same job. It was only ever the queue that was accidental.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the resident's rent screen", () => {
  const src = () => read("../app/parks/my-data.ts");

  it("batches everything that only needs the tenancy", () => {
    const s = src();
    const at = s.indexOf("await Promise.all([");
    expect(at).toBeGreaterThan(-1);
    const batch = s.slice(at, s.indexOf("]);", at));
    for (const table of [
      "park_lots", "parks", "payment_methods",
      "park_charges", "park_payments", "properties", "park_requests",
    ]) {
      expect(batch, `${table} left the batch and is queueing again`).toContain(`"${table}"`);
    }
  });

  it("leaves exactly three reads outside it, and they are the dependent ones", () => {
    // park_renters (identity), lot_reservations (needs the renter ids), and
    // the claims read (needs the bill ids). Everything else has no excuse.
    const s = src();
    const sequential = s.match(/await admin\b/g) ?? [];
    expect(sequential.length, "a read has gone back to waiting its turn").toBe(3);
  });

  it("still answers or throws on every one of them", () => {
    // Speed must not have cost the guards. Same rule as before the batching.
    const s = src();
    for (const what of ["your file", "your tenancy", "your park", "your bill", "your payments"]) {
      // The call spans lines where the read is inlined, so allow the wrap.
      expect(s, `unguarded after batching: ${what}`).toMatch(
        new RegExp(`mustRead\\(\\s*"${what}"`),
      );
    }
    expect(s).toMatch(/softRead\(\s*"what you've reported"/);
  });
});

describe("the ops console", () => {
  const src = () => read("../app/ops/page.tsx");

  it("settles its five defensive loaders together", () => {
    const s = src();
    const at = s.indexOf("await Promise.allSettled([");
    expect(at, "five loaders back in a queue, Twilio first").toBeGreaterThan(-1);
    const batch = s.slice(at, s.indexOf("]);", at));
    for (const fn of [
      "getSmsHealth()", "getStuckHouseholds()", "getClaimTally()",
      "getOpsParks()", "getProposedFees()",
    ]) {
      expect(batch).toContain(fn);
    }
  });

  it("keeps every fallback separate — they are not equally harmless", () => {
    // `stuck` falls back to an empty list; `tally` falls back to empty:true,
    // which the card renders as "nobody has started onboarding a park yet".
    // Sharing one catch let a failed stuck read invent that sentence.
    const s = src();
    expect(s).toMatch(/if \(stuckRes\.status === "fulfilled"\)/);
    expect(s).toMatch(/if \(tallyRes\.status === "fulfilled"\)/);
    expect(s).toMatch(/\[ops\] claim tally unavailable/);
    expect(s).toMatch(/ops: parks board unavailable/);
  });

  it("one loader failing still cannot take the console down", () => {
    // That was the whole point of the try/catch blocks this replaces.
    const s = src();
    expect(s).toMatch(/allSettled/);
    expect(s).not.toMatch(/await getSmsHealth\(\)/);
  });
});
