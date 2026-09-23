import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activationGaps, type ActivationInput } from "./onboarding-helpers";
import { fleetJobCap } from "@/lib/fleet";

/**
 * A NUMBER NOBODY CHOSE WAS BEING READ AS THE CREW'S ANSWER.
 *
 * inviteCrew seeded vendors.daily_capacity = 1 and called it a "routable
 * default". But activationGaps only refuses `cap < 1`, so the seed SATISFIED
 * the very question step 5 of the wizard exists to ask: the step rendered with
 * a ticked badge and a literal "Saved ✓" pill from the instant of invitation.
 * The crew had no reason to open it, went live, and dispatch then routed them
 * exactly one job a day forever — isEligible refuses at `assignedThatDay >=
 * cap`, canClaim answers "Your day is full" — with the only cure being an ops
 * phone call nobody knew to make.
 *
 * Two rules, one column. A default is what is TRUE on day one, so the seed
 * becomes null. And anything activation can refuse you for must stay changeable
 * afterwards, so the number gets a control that survives go-live.
 *
 * The second half has a trap the first half created: fleetJobCap DISCARDS
 * daily_capacity outright as soon as one active truck exists. A capacity field
 * offered to a crew with trucks would show a number dispatch never reads.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = (rel: string) => strip(readFileSync(join(process.cwd(), "src", rel), "utf8"));

const READY: ActivationInput = {
  coi_url: "coi.pdf",
  coi_expiry: "2027-01-01",
  coi_named_insured: "Northshore Docks",
  company: "Northshore Docks",
  w9_url: "w9.pdf",
  service_types: ["Lawn mowing & trim"],
  service_lakes: ["lake-1"],
  daily_capacity: 1,
};

describe("the invitation no longer answers for them", () => {
  const invite = src("app/ops/crews-invite.ts");
  const insert = invite.slice(invite.indexOf('.from("vendors").insert({'));
  const row = insert.slice(0, insert.indexOf("});") + 3);

  it("the scan is reading the real insert", () => {
    expect(row.length).toBeGreaterThan(60);
    expect(row).toContain("invite_email: email");
    expect(row).toContain('status: "invited"');
  });

  it("seeds no capacity at all", () => {
    expect(row, "an invited crew is being handed an answer they never gave")
      .toContain("daily_capacity: null");
    expect(row).not.toMatch(/daily_capacity:\s*\d/);
  });

  it("and the gate then actually asks — both ways round", () => {
    // Collapse the fix and the gap disappears; that is the whole defect.
    expect(activationGaps({ ...READY, daily_capacity: 1 }, "2026-09-22")).toEqual([]);
    expect(activationGaps({ ...READY, daily_capacity: null }, "2026-09-22"))
      .toEqual(["Set how many jobs a day you can take"]);
  });
});

describe("every door to 'active' asserts a capacity", () => {
  const actions = src("app/ops/crews-actions.ts");
  const gate = actions.slice(actions.indexOf("async function assertRoutable"), actions.indexOf("export async function approveCrew"));

  it("the scan is reading assertRoutable", () => {
    expect(gate.length).toBeGreaterThan(400);
    expect(gate).toContain("No W-9 on file");
  });

  it("it reads the column it is about to judge", () => {
    // A rule enforced by a gate that never selects the column is enforced by
    // nothing. With the seed gone, reactivateCrew could otherwise put a crew on
    // the board at zero, where isEligible drops them silently.
    expect(gate).toContain("daily_capacity");
    expect(gate).toMatch(/cap < 1/);
  });

  it("reactivateCrew runs it with no exemption", () => {
    const re = actions.slice(actions.indexOf("export async function reactivateCrew"));
    expect(re.slice(0, re.indexOf("\n}\n"))).toContain("assertRoutable(admin, vendorId)");
  });

  it("approveCrew is exempt, because it is writing the number in the same statement", () => {
    const ap = actions.slice(actions.indexOf("export async function approveCrew"), actions.indexOf("export async function confirmCoiExpiry"));
    expect(ap).toContain("capacityComingInThisWrite: true");
    expect(ap, "the validated 1-20 must still be what lands").toMatch(/daily_capacity: cap/);
  });
});

describe("the number stays changeable after go-live", () => {
  const card = src("components/MyCapacity.tsx");
  const today = src("app/vendor/page.tsx");

  it("there is a control, and a live crew's page mounts it", () => {
    expect(card, "no writer — the card is decoration").toContain("setDailyCapacity(");
    expect(today, "the control exists but nobody can reach it").toMatch(/<MyCapacity[\s/>]/);
  });

  it("and it does not contradict the trucks standing beside it", () => {
    // fleetJobCap replaces the legacy number rather than adding to it, so for a
    // crew with trucks the stepper would offer a figure dispatch never reads.
    expect(fleetJobCap([], 1)).toBe(1);
    expect(fleetJobCap([{ capacity: 3 }], 1)).toBe(3);
    expect(card).toContain("truckCount > 0");
    expect(card).toMatch(/Your trucks set this/);
    expect(today, "the page must hand it the ACTIVE trucks dispatch sums").toContain("activeTrucks");
  });
});
