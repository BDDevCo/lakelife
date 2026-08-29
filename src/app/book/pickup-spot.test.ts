import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHERE IS THE BOAT? (0148)
 *
 * Spring collection is the first work LakeLife sells that does not happen at
 * the customer's property. The failure this guards is not subtle: a crew
 * arrives at a lake house to collect a boat that spent the winter twenty miles
 * away, and there is nothing in the driveway.
 *
 * `pickup_address` is a column, so the standing question is the one this
 * codebase keeps answering wrong — WHO WRITES IT AND WHO READS IT. Four
 * answers have to exist at once or the feature is decorative:
 *
 *   asks    the booking form renders the field for services that need it
 *   refuses the booking ACTION rejects a booking without it, server-side
 *   writes  the job insert carries it
 *   reads   the crew page shows it, and routing drives to it
 *
 * Source scans, because `createBookingBatch` needs a session, a verified
 * mobile, a property, a live season window and a crew bench. What can actually
 * break here is a link in that chain being dropped, and that is visible in the
 * source.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const batchFn = () => {
  const src = code("src/app/book/actions.ts");
  const fn = src.match(/export async function createBookingBatch[\s\S]*?\n}/)?.[0] ?? "";
  expect(fn.length, "createBookingBatch not found — this scan is measuring nothing")
    .toBeGreaterThan(2000);
  return fn;
};

describe("the booking action REFUSES a collection with nowhere to collect from", () => {
  /** The refusal branch itself — not merely a mention of the flag. */
  const refusal = () => {
    const fn = batchFn();
    const m = fn.match(/if \(service\.needs_pickup_spot && pickupAddress === ""\) \{[\s\S]*?\n  \}/);
    return { fn, block: m?.[0] ?? "" };
  };

  it("reads the flag from the service, never from a hardcoded name", () => {
    // Rule 8: this kind of rule lives in the database. Two service names
    // spelled into the booking flow would be a rename away from silence.
    const { fn, block } = refusal();
    expect(block, "no refusal branch found — the action does not refuse").not.toBe("");
    expect(block, "the refusal must return an error").toMatch(/ok: false/);
    expect(fn, "no service name may be hardcoded into the gate")
      .not.toMatch(/Boat return & splash|Spring de-winterize/);
  });

  it("refuses before anything is written", () => {
    const { fn, block } = refusal();
    expect(block, "no refusal branch found").not.toBe("");
    const gate = fn.indexOf(block);
    const insert = fn.indexOf('.from("jobs")');
    expect(insert, "no job insert found — scan is stale").toBeGreaterThan(-1);
    expect(gate, "the refusal must come before the insert, or a job exists with nowhere to go")
      .toBeLessThan(insert);
  });

  it("a blank or whitespace address does not count as an answer", () => {
    const fn = batchFn();
    expect(fn, "the address must be trimmed before it is judged").toMatch(/pickup\?\.address\?\.trim\(\)/);
  });

  it("writes the spot onto the job it just validated", () => {
    const fn = batchFn();
    expect(fn, "pickup columns are never written").toMatch(/pickup_address:/);
    expect(fn, "coordinates ride along when Places returned them").toMatch(/pickup_lat:/);
  });

  it("never carries a spot on a service that did not ask for one", () => {
    // A stray pickup on a mow is a location the crew has no reason to drive to.
    const fn = batchFn();
    const cols = fn.match(/const pickupCols =[\s\S]*?;/)?.[0] ?? "";
    expect(cols, "pickupCols not found — scan is stale").not.toBe("");
    expect(cols, "the columns must be gated on the flag").toMatch(/service\.needs_pickup_spot/);
  });
});

describe("the customer is actually asked", () => {
  const grid = () => code("src/components/BookingGrid.tsx");

  it("renders the field for a service that needs it", () => {
    // Anchored on the JSX guard AND the field inside it. Matching the flag
    // alone passed while the field was deleted — `const needsSpot = ...` also
    // contains it, so the loose version proved nothing.
    const block = grid().match(/\{service\.needs_pickup_spot && \([\s\S]*?<AddressAutocomplete[\s\S]*?\)\}/);
    expect(block?.[0], "the booking form never asks — a column with no writer")
      .toBeTruthy();
    expect(block?.[0], "reuses the Places field, which degrades to a typed address")
      .toContain("<AddressAutocomplete");
  });

  it("passes what it collected to the action", () => {
    expect(grid(), "the answer must reach the server or the field is theatre")
      .toMatch(/service\.needs_pickup_spot \? pickup : undefined/);
  });

  it("says WHY the button is dead, rather than just disabling it", () => {
    // A greyed-out button with no reason is the copy bug class in this repo.
    expect(grid()).toMatch(/needsSpot/);
    expect(grid(), "the button must name what it is waiting for")
      .toMatch(/Tell us where the boat is/);
  });
});

describe("THE RELEASE — somebody has to open the gate (0150/0151)", () => {
  const grid = () => code("src/components/BookingGrid.tsx");

  const releaseGate = () => {
    const fn = batchFn();
    const m = fn.match(/if \(service\.needs_release && !pickup\?\.releaseConfirmed\) \{[\s\S]*?\n  \}/);
    return m?.[0] ?? "";
  };

  it("the booking is refused until the customer says they've told the holder", () => {
    const block = releaseGate();
    expect(block, "no release gate — the crew drives to a gate nobody expects them at")
      .not.toBe("");
    expect(block, "the refusal must return an error").toMatch(/ok: false/);
  });

  it("THE TICK STARTS EMPTY", () => {
    // A pre-ticked box asserting a fact about the world is how 19 leases got
    // written that nobody had signed. This is the same shape of claim.
    expect(grid(), "releaseConfirmed must initialise false")
      .toMatch(/releaseConfirmed:\s*false/);
    expect(grid(), "and the checkbox must be bound to it, not defaulted on")
      .toMatch(/checked=\{pickup\.releaseConfirmed\}/);
  });

  it("the confirmation is stamped from the SERVER clock", () => {
    // A timestamp the browser supplied is a timestamp the browser chose.
    const fn = batchFn();
    expect(fn).toMatch(/release_confirmed_at: service\.needs_release \? new Date\(\)\.toISOString\(\)/);
  });

  it("says what the dead button is waiting for", () => {
    expect(grid()).toMatch(/Confirm you've told them we're coming/);
  });

  it("a refused release is a NO-SHOW, not proceed-and-bill", () => {
    // The live defect 0150 fixed: both collection services had
    // needs_interior_access = false, so the driveway rule told the crew to do
    // the work as booked — for a boat behind a locked gate.
    const arrival = code("src/lib/arrival.ts");
    expect(arrival, "the rule must consider a release, not just a door")
      .toMatch(/rule\.needs_interior_access \|\| rule\.needs_release/);
    expect(arrival, "needs_release must be REQUIRED, so no caller can forget it")
      .toMatch(/needs_release: boolean \| null;/);
  });

  it("the crew gets the name, the number, and the truth about the number", () => {
    const page = code("src/app/vendor/jobs/[id]/page.tsx");
    expect(page, "who to ask for").toMatch(/job\.pickupContact/);
    expect(page, "a tappable number").toMatch(/tel:\$\{job\.pickupPhone/);
    // "No number on file" changes what the crew does before setting off, so
    // its absence is a fact rather than a blank.
    expect(page, "the absence of a number must be stated").toMatch(/No number on file/);
  });

  it("a make-it-right visit still knows where the boat is", () => {
    // The clone carried property_id and service_id and nothing about where
    // the thing actually is, so a correction on a collection sent the crew to
    // the customer's house — where there is no boat, and never was.
    const d = code("src/lib/disputes.ts");
    const insert = d.match(/\.insert\(\{[\s\S]*?correction_of: job\.id,[\s\S]*?\}\)/)?.[0] ?? "";
    expect(insert, "the correction insert was not found — scan is stale").not.toBe("");
    for (const f of ["pickup_address", "pickup_contact", "pickup_phone", "release_confirmed_at"]) {
      expect(insert, `${f} is not carried onto the correction visit`)
        .toMatch(new RegExp(`${f}: job\\.${f}`));
    }
    expect(d, "and it must be SELECTED, or it copies undefined").toMatch(/pickup_contact/);
  });
});

describe("somebody reads it", () => {
  it("the crew job page shows the pickup, and does NOT lose the property", () => {
    const page = code("src/app/vendor/jobs/[id]/page.tsx");
    // Anchored on the RENDER GUARD, not on the identifier: a block switched off
    // with `{false ? (` still mentions job.pickupAddress on every line inside
    // it, and the loose version of this test passed while the crew saw nothing.
    const block = page.match(/\{job\.pickupAddress \? \([\s\S]*?\) : null\}/)?.[0] ?? "";
    expect(block, "the crew never sees where the boat is").not.toBe("");
    expect(block, "the crew needs directions to the pickup too")
      .toMatch(/CrewNavigateButton[\s\S]{0,160}job\.pickupLat/);
    // The boat is being brought BACK to the property — replacing the address
    // would strand the second half of the visit, so it renders OUTSIDE the block.
    // The property's OWN line, not merely the identifier appearing somewhere:
    // job.address is also handed to other components further down the page, so
    // a looser check stayed green with the address line itself deleted.
    expect(page.replace(block, ""), "the property address line must still render")
      .toMatch(/\{job\.address \?\? "Address on file"\}/);
  });

  it("the crew loader selects and returns it", () => {
    const data = code("src/app/vendor/job-detail-data.ts");
    expect(data, "pickup_address is not selected — it would always read null")
      .toMatch(/pickup_address/);
    expect(data, "and must reach the returned shape").toMatch(/pickupAddress:/);
  });

  it("routing drives to the FIRST stop, falling back to the property", () => {
    const disp = code("src/app/book/dispatch.ts");
    expect(disp, "dispatch must select the pickup coords").toMatch(/pickup_lat/);
    expect(disp, "and rank on them when present, property otherwise")
      .toMatch(/jobLat:\s*job\.pickup_lat != null/);

    const board = code("src/app/vendor/open-data.ts");
    expect(board, "the claim board's miles must measure to the boat")
      .toMatch(/pickup_lat/);
    expect(board, "with the property as the fallback for every ordinary job")
      .toMatch(/pickup_lat\s*\?\?\s*prop\?\.lat/);
  });
});

describe("0148 on disk", () => {
  const sql = () => read("supabase/migrations/0148_the_boat_is_not_where_the_customer_lives.sql");

  it("adds the columns nullable — every other service is silent about location", () => {
    expect(sql()).toMatch(/add column if not exists pickup_address text/);
    expect(sql(), "a NOT NULL here would break every ordinary booking")
      .not.toMatch(/pickup_address text not null/i);
  });

  it("flags exactly the two spring legs, and asserts it", () => {
    expect(sql()).toMatch(/needs_pickup_spot = true/);
    expect(sql()).toMatch(/expected 2/);
  });

  it("refuses a service that asks but cannot be booked alone", () => {
    // Otherwise the question is asked on a path the booking flow never reaches.
    expect(sql()).toMatch(/needs_pickup_spot and not solo_bookable/);
  });
});
