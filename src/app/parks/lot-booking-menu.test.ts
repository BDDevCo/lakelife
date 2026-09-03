import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE MOW THE CARD PROMISED AND THE MENU DID NOT HAVE.
 *
 * "Book a mow or a clean for your lot. Nothing to fill in — we already know
 * where you live." She taps it, `enableBookingForMyLot` mints her property
 * and writes a fixed `wanted_services` list, and /book renders
 * `applicable.filter(s => profile.wanted_services.includes(s.name))`. Lawn
 * mowing was not on the list, so her menu was three tiles and the one the
 * sentence leads with was not among them.
 *
 * It was never a decision. The same action sets `lawn_band: 'small'` — a
 * column whose only purpose is to price "Lawn mowing & trim" — with a comment
 * explaining why small is the honest band for a pad. Every other exclusion in
 * that list is argued for by name. This one was simply missing.
 *
 * Two rules, because the list can fail in two directions:
 *
 *   1. What the card OFFERS must be on the list. A sentence promising a mow
 *      is the requirement; the list is the implementation.
 *   2. Every name on the list must be a REAL service name. `/book` matches on
 *      `s.name` exactly, so a typo is not an error — it is a service that
 *      quietly never appears, which is how this defect reads from the
 *      outside anyway.
 */

const HERE = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const ACTIONS = readFileSync(HERE("./booking-actions.ts"), "utf8");
const CARD = readFileSync(HERE("../../components/EnableLotBooking.tsx"), "utf8");

/** The names `enableBookingForMyLot` actually writes. */
function wantedServices(): string[] {
  const block = ACTIONS.match(/wanted_services:\s*\[([\s\S]*?)\]/)?.[1];
  if (!block) throw new Error("wanted_services not found — this scan is measuring nothing");
  // The list carries prose explaining each inclusion; comments are not entries.
  return [...block.replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("the scan reads a real list", () => {
  it("finds the services a new lot profile is given", () => {
    const names = wantedServices();
    expect(names.length).toBeGreaterThan(4);
    expect(names).toContain("Housekeeping");
  });

  it("does not count a name that is only mentioned in a comment", () => {
    // The block's prose names "Lawn mowing & trim" while explaining why it
    // belongs. If comments were counted, removing the entry would still pass.
    const withoutEntries = ACTIONS
      .match(/wanted_services:\s*\[([\s\S]*?)\]/)![1]
      .replace(/^(?!\s*\/\/).*$/gm, "");
    expect(withoutEntries).toMatch(/Lawn mowing/);       // the prose is there
    expect(wantedServices().filter((n) => n.startsWith("Lawn")).length).toBe(1); // counted once
  });
});

describe("what the card offers, the menu carries", () => {
  it("the card still leads with a mow and a clean", () => {
    // If this copy is ever rewritten, the assertions below are about the wrong
    // promise and should be rewritten with it.
    expect(CARD, "the first-run sentence changed — re-read what it promises")
      .toMatch(/Book a mow or a clean for your lot/);
  });

  it("a mow is on the list", () => {
    expect(wantedServices().some((n) => /mowing/i.test(n)),
      "the card promises a mow and /book filters it out of her menu").toBe(true);
  });

  it("a clean is on the list", () => {
    expect(wantedServices()).toContain("Housekeeping");
  });

  it("the mow it names is the resident's, not the park's", () => {
    // "Park grounds mowing & trim" is park_only and prices per lot across the
    // whole park — putting it on a resident's menu would sell her the park's
    // own contract.
    expect(wantedServices()).not.toContain("Park grounds mowing & trim");
    expect(wantedServices()).toContain("Lawn mowing & trim");
  });
});

describe("every name on the list is a real service name", () => {
  // /book matches on `s.name` exactly. A typo here is not an error — it is a
  // tile that silently never renders.
  const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const allSql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(MIGRATIONS + f, "utf8"))
    .join("\n");

  it("reads the migrations", () => {
    expect(allSql.length).toBeGreaterThan(100_000);
    expect(allSql).toContain("'Lawn mowing & trim'");
  });

  it("each one appears as a service name in a migration", () => {
    const unknown = wantedServices().filter((n) => !allSql.includes(`'${n}'`));
    expect(unknown, "these names match no service and would never render").toEqual([]);
  });
});

describe("the lawn band is written for the service that uses it", () => {
  it("sets lawn_band, which only lawn mowing prices from", () => {
    // The tell that the omission was an omission: a column written for a
    // service the same action then left off the menu.
    expect(ACTIONS).toMatch(/lawn_band:\s*"small"/);
  });
});
