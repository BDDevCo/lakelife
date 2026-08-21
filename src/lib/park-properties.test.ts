import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ownedHomeAddress, buildGroundsPropertyRow } from "@/app/park/service-helpers";

/**
 * A PARK'S ADDRESS IS COPIED INTO ITS PROPERTIES, AND WAS NEVER COPIED AGAIN.
 *
 * The grounds property and every park-owned home are built FROM the park —
 * address and nickname are pure functions of `parks.name` and `parks.address`.
 * `saveParkProfile` updated `parks` and stopped there, so correcting the
 * address left every derived property holding the old one. The PROPERTY
 * address is what a crew is dispatched to.
 *
 * The Haven's park row still reads "1 Haven Rd, Angola IN" — a placeholder in
 * the wrong town — and it has already been copied into two properties.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the derived addresses are pure functions of the park", () => {
  it("a home's address is built from the park's name and address", () => {
    expect(ownedHomeAddress("11", "The Haven", "1 Haven Rd, Angola IN"))
      .toBe("Lot 11, The Haven, 1 Haven Rd, Angola IN");
    // Change the park, and the derived string changes with it — which is
    // exactly why it must be recomputed rather than stored once.
    expect(ownedHomeAddress("11", "The Haven", "7 Pretty Lake Rd, Wolcottville IN"))
      .toBe("Lot 11, The Haven, 7 Pretty Lake Rd, Wolcottville IN");
  });

  it("the grounds nickname follows the park's name", () => {
    const row = buildGroundsPropertyRow({
      ownerId: "o", parkId: "p", parkName: "The Haven",
      lakeId: "l", address: "1 Haven Rd, Angola IN",
    });
    expect(row.nickname).toBe("The Haven — grounds");
    expect(row.address).toBe("1 Haven Rd, Angola IN");
    expect(row.lat).toBeNull();
  });
});

describe("saving the park profile resyncs them", () => {
  const actions = src("../app/park/actions.ts");
  const resync = src("./park-properties.ts");

  it("reads the files it thinks it reads", () => {
    expect(actions).toContain("saveParkProfile");
    expect(resync).toContain("resyncParkProperties");
  });

  it("saveParkProfile calls the resync", () => {
    const fn = actions.slice(actions.indexOf("saveParkProfile"));
    const body = fn.slice(0, fn.indexOf("export async function", 10));
    expect(body).toContain("resyncParkProperties(parkId)");
  });

  it("it rewrites the grounds and every park-owned home", () => {
    expect(resync).toContain("service_property_id");
    expect(resync).toContain("ownedHomeAddress(");
    expect(resync).toMatch(/from\("park_lots"\)/);
  });

  it("the map pin is only filled in, never overwritten", () => {
    // A property that already has a pin has a better one than a park-level
    // guess, and a park with no pin must not blank one that exists.
    const fill = resync.slice(resync.indexOf("async function fillPin"));
    expect(fill).toContain('.is("lat", null)');
    expect(fill).toMatch(/if \(lat == null \|\| lng == null\) return;/);
  });

  it("the engine is not itself a server action", () => {
    // Same lesson as rent-changes.ts: every export of a "use server" file is
    // callable from any browser that knows its id, and this one takes a bare
    // parkId with no membership check of its own.
    expect(resync.split("\n")[0]).toContain('import "server-only"');
    expect(resync).not.toContain('"use server"');
  });

  it("its caller is the one that checks membership", () => {
    const fn = actions.slice(actions.indexOf("saveParkProfile"));
    const body = fn.slice(0, fn.indexOf("resyncParkProperties"));
    expect(body).toContain("assertMyPark(parkId)");
  });
});
