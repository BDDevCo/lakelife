import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE HOUSEHOLD THE EDIT PANEL IS ABOUT.
 *
 * The readiness list's one required-shaped instruction before the January
 * leases — "Add their email and phone from their row on the rent roll" —
 * pointed at a screen that drew no Edit button for a single imported
 * household. From the day the seller's roll lands until go-live every one of
 * those rows is "reserved": no current link, no lapsed link, a 'grandfathered'
 * next link starting on the cutover, and the Edit target was `current ?? lapsed
 * ?? an office filing`. Meanwhile every account needs an email and a mobile
 * before anything bills, and the only other control on the row that takes both
 * records a signing that has not happened.
 *
 * Four places decided this — the button, its label, the panel's guard and the
 * panel's NAME seed — and they did not decide it alike: a widening that
 * reached three of them would have opened a panel with a blank Name box, which
 * `buildTenantEdit` refuses outright ("A tenant needs a name."). So the server
 * resolves one id and one name, and the roll reads those.
 */

const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const page = strip(readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8"));
const roll = strip(readFileSync(fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)), "utf8"));

/** The page's REAL expression, run rather than restated. */
function editTargetRule(): (r: unknown) => unknown {
  const onLot = page.match(/const onLot = ([^;]+);/)?.[1] ?? "";
  const filedByHand = page.match(/const filedByHand = ([^;]+);/)?.[1] ?? "";
  const editable = page.match(/const editable = ([^;]+);/)?.[1] ?? "";
  expect(onLot, "const onLot is gone — this scan measures nothing").not.toBe("");
  expect(filedByHand, "const filedByHand is gone — this scan measures nothing").not.toBe("");
  expect(editable, "const editable is gone — this scan measures nothing").not.toBe("");
  return new Function(
    "r",
    `const onLot = ${onLot}; const filedByHand = ${filedByHand}; return ${editable};`,
  ) as (r: unknown) => unknown;
}

const IMPORTED = { current: null, lapsed: null, next: { id: "hold", renterId: "f", origin: "grandfathered", decidedAt: null } };
const APPLICANT = { current: null, lapsed: null, next: { id: "app", renterId: "f", origin: "application", decidedAt: "2026-12-01T00:00:00Z" } };
const OFFICE_FILED = { current: null, lapsed: null, next: { id: "hand", renterId: "f", origin: "application", decidedAt: null } };
const SUCCESSOR_ALONE = { current: null, lapsed: null, next: { id: "feb", renterId: "f", origin: "office", decidedAt: null } };
const LIVING = { current: { id: "jan", renterId: "f" }, lapsed: null, next: { id: "feb", renterId: "f", origin: "office", decidedAt: null } };
const RAN_OUT = { current: null, lapsed: { id: "dec", renterId: "f" }, next: null };

describe("the roll's Edit target, run on every shape a row wears", () => {
  const evaluate = editTargetRule();

  it("AN IMPORTED HOUSEHOLD WAITING ON THE CUTOVER is editable — the state the whole roll is in before go-live", () => {
    expect(evaluate(IMPORTED)).toEqual(IMPORTED.next);
  });

  it("an approved applicant is NOT — un-approving somebody is not this screen's to do", () => {
    // The one shape this screen is deliberately fenced off from: only
    // decideApplication stamps decided_at, and 0059 forces it null on a
    // grandfathered row, so the stamp is the boundary and origin is not.
    expect(evaluate(APPLICANT)).toBeNull();
  });

  it("the office's own filing ahead of its day, and a successor standing alone, are editable", () => {
    expect(evaluate(OFFICE_FILED)).toEqual(OFFICE_FILED.next);
    expect(evaluate(SUCCESSOR_ALONE)).toEqual(SUCCESSOR_ALONE.next);
  });

  it("the link ON THE LOT still wins — current, else the one that ran out", () => {
    expect(evaluate(LIVING)).toEqual(LIVING.current);
    expect(evaluate(RAN_OUT)).toEqual(RAN_OUT.lapsed);
  });

  it("an empty lot offers nothing to edit", () => {
    expect(evaluate({ current: null, lapsed: null, next: null })).toBeNull();
  });

  it("collapsed back to the old rule, the imported household loses its door", () => {
    // Non-vacuous: the pre-fix expression, run on the same shapes, so these
    // tests cannot pass against the defect they were written for.
    const old = new Function(
      "r",
      "const onLot = r.current ?? r.lapsed; const filedByHand = r.current == null && r.next?.origin === \"application\" && r.next.decidedAt == null ? r.next : null; return onLot ?? filedByHand;",
    ) as (r: unknown) => unknown;
    expect(old(IMPORTED)).toBeNull();
    expect(old(OFFICE_FILED)).toEqual(OFFICE_FILED.next);
  });
});

describe("one id and one name, resolved once and read by all four sites", () => {
  it("the page carries both off the stay it chose — never a second chain", () => {
    expect(page).toMatch(/editReservationId: editable\?\.id \?\? null,/);
    expect(page).toMatch(/editRenterName: editable \? roll\.renterNames\.get\(editable\.renterId\) \?\? "Renter" : null,/);
  });

  it("the button, its label and the panel's guard all read that one id", () => {
    expect(roll).toMatch(/\{r\.editReservationId && \(/);
    expect(roll).toMatch(/const id = r\.editReservationId!;/);
    expect(roll).toMatch(/\{editingId === r\.editReservationId \? "Cancel" : "Edit"\}/);
    expect(roll).toMatch(/\{editingId && editingId === r\.editReservationId && \(/);
    // The old chains, which reached the button and the panel differently.
    expect(roll).not.toMatch(/\(onLot \?\? r\.filedByHandId\)/);
  });

  it("the panel opens with a household in the Name box, or buildTenantEdit refuses the save", () => {
    expect(roll).toMatch(/name=\{r\.editRenterName \?\? ""\}/);
    expect(roll).not.toMatch(/name=\{r\.currentRenter \?\? r\.lapsedRenter \?\? r\.filedByHandRenter \?\? ""\}/);
  });

  it("'Filed by mistake' is untouched — it withdraws a first agreement, not whatever Edit can reach", () => {
    expect(roll).toMatch(/\{r\.filedByHandId && !r\.currentReservationId && \(/);
    // Move out stays on the lot: nobody has lived in a row still to start.
    expect(roll).toMatch(/const onLot = r\.currentReservationId \?\? r\.lapsedReservationId;/);
    const moveOut = roll.slice(roll.indexOf('"Move out"') - 500, roll.indexOf('"Move out"'));
    expect(moveOut, "the Move out control is gone — this scan measures nothing").not.toBe("");
    expect(moveOut).toMatch(/\{onLot && \(/);
    expect(moveOut).not.toMatch(/editReservationId/);
  });
});
