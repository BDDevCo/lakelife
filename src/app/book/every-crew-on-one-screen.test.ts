import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY CREW ON ONE SCREEN (0178) — the offers the buyer actually sees, and
 * what the router does with the name they pick.
 *
 * Driven through the REAL builder with only the database and the dials faked,
 * for the same reason the 0174 suite is: every defect available here is a
 * disagreement between what the server computes and what leaves it, and a
 * source scan would have to guess at that.
 *
 * THE TWO PROPERTIES THAT MATTER MOST, and both are tested from both sides:
 *   1. With the standing dial OFF, the payload carries NO standing at all.
 *      Proved to bite by flipping the dial on in the same fixture and
 *      requiring the opposite.
 *   2. `preferred_vendor` is a BADGE AND A SORT on the crew-priced path and
 *      never a first refusal. Proved to bite by collapsing it the other way:
 *      on the MENU path the same preferred crew still wins outright.
 */

type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = {};

vi.mock("@/lib/supabase/server", () => {
  const MUTATIONS = ["insert", "update", "delete", "upsert"];
  const resolve = (table: string, calls: Array<[string, unknown[]]>) => {
    const names = calls.map((c) => c[0]);
    if (calls.some((c) => MUTATIONS.includes(c[0]))) return { data: [{ id: "x" }], error: null };
    const data = rows[table] ?? [];
    if (names.includes("maybeSingle") || names.includes("single")) {
      return { data: data[0] ?? null, error: null };
    }
    return { data, error: null };
  };
  const table = (name: string) => {
    const calls: Array<[string, unknown[]]> = [];
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve(resolve(name, calls)).then(ok, bad);
        }
        return (...args: unknown[]) => { calls.push([String(prop), args]); return proxy; };
      },
    });
    return proxy;
  };
  return { createServiceClient: () => ({ from: (name: string) => table(name) }) };
});

/** THE DIAL UNDER TEST. 0 is what 0178 ships; the tests flip it deliberately. */
const settings = {
  marginFloor: 0.2,
  platformFeeCustomerPct: 0.12,
  platformFeeCrewPct: 0.12,
  crewStandingPublic: 0,
};
vi.mock("@/lib/settings", () => ({ getPlatformSettings: async () => settings }));

/**
 * THE CREW-ACCOUNT GUARD, faked at its own seam so both of its answers can be
 * driven — the shared db mock below ignores filters, so a real `vendors` read
 * here could not tell "this viewer is a crew" from "crews exist". The helper
 * itself is exercised against the db mock further down.
 */
const crewAccount = { isCrew: false, failed: false };
vi.mock("@/lib/crew-account", () => ({ anyIsACrew: async () => crewAccount }));
vi.mock("@/lib/scoring-data", () => ({ getVendorScores: async () => new Map() }));
vi.mock("@/app/park/rate-data", () => ({
  groundsFor: async () => null,
  loadParkRatesChecked: async () => ({ rates: new Map(), failed: false }),
}));

import { buildCrewOffers } from "./crew-offers";
import { decideDispatch, type CrewCandidate, type DispatchInput } from "@/lib/dispatch";
import { deriveStanding, summarisePreview, previewSentence } from "@/lib/crew-standing";

const crew = (id: string, company: string, over: Row = {}) => ({
  id,
  status: "active",
  coi_expiry: "2027-06-01",
  coi_named_insured: null,
  company,
  service_types: ["Window Washing"],
  service_lakes: ["lake-1"],
  work_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  daily_capacity: 4,
  base_lat: null,
  base_lng: null,
  storage_capacity_feet: 0,
  storage_types: [],
  garagekeepers_expiry: null,
  ...over,
});

const card = (vendorId: string, base: number) => ({
  vendor_id: vendorId, service_id: "svc-1", base, unit_rate: 0, band_pricing: null,
});

const TUESDAY = "2026-10-06";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
  settings.crewStandingPublic = 0;
  crewAccount.isCrew = false;
  crewAccount.failed = false;
  for (const k of Object.keys(rows)) delete rows[k];
  rows.properties = [{ id: "prop-1", sqft: 0, beds: 0, baths: 0, preferred_vendor: null, lake_id: "lake-1", lat: null, lng: null }];
  rows.property_profile = [{ pier_sections: 0, boat_lifts: 0, panes: 12 }];
  rows.boats = [];
  rows.toys = [];
  rows.services = [{ id: "svc-1", name: "Window Washing", pricing_model: "flat", active: true, crew_priced: true }];
  rows.vendors = [];
  rows.vendor_rates = [];
  rows.vendor_availability = [];
  rows.crew_units = [];
  rows.storage_stays = [];
  rows.lakes = [{ id: "lake-1", name: "Big Long" }];
  rows.jobs = [];
});
afterEach(() => vi.useRealTimers());

const offersFor = () => buildCrewOffers({ propertyId: "prop-1", serviceId: "svc-1", dateISO: TUESDAY });

describe("the buyer sees every crew, with the customer's price and nothing of the crew's card", () => {
  it("returns one row per quoting crew, cheapest first, at the crew's quote plus the customer fee", async () => {
    rows.vendors = [crew("v-dear", "Dear Docks LLC"), crew("v-cheap", "Cheap Panes LLC")];
    rows.vendor_rates = [card("v-dear", 70), card("v-cheap", 50)];

    const res = await offersFor();
    expect(res.ok).toBe(true);
    expect(res.crewPriced).toBe(true);
    expect(res.offers!.map((o) => o.company)).toEqual(["Cheap Panes LLC", "Dear Docks LLC"]);
    // $50 + 12% and $70 + 12%. TRACED TO THE SEEDED CARDS above, not
    // recomputed from the expression under test.
    expect(res.offers!.map((o) => o.customerPrice)).toEqual([56, 78.4]);
    expect(res.offers![0].workDays).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  });

  it("puts no crew rate, no payout and no fee split on the wire", async () => {
    rows.vendors = [crew("v-1", "A Crew LLC")];
    rows.vendor_rates = [card("v-1", 50)];

    const res = await offersFor();
    const wire = JSON.stringify(res);
    // The crew quoted 50 and would be paid 44. Neither number may appear
    // anywhere in the payload; 56 — the customer's own price — may.
    expect(Object.keys(res.offers![0]).sort()).toEqual(["company", "customerPrice", "vendorId", "workDays", "yours"]);
    expect(wire).toContain("56");
    expect(wire).not.toContain("44");
    expect(wire).not.toMatch(/crewRate|crewPayout|platformTake|crewQuote|fee/i);
  });

  it("the crew this property brought is shown first and badged — and every other crew is still on the screen", async () => {
    // The brought crew is the DEARER one on purpose: if preferred were still a
    // filter or a first refusal, the cheaper crew would be missing entirely.
    rows.properties[0].preferred_vendor = "v-dear";
    rows.vendors = [crew("v-cheap", "Cheap Panes LLC"), crew("v-dear", "Dear Docks LLC")];
    rows.vendor_rates = [card("v-cheap", 50), card("v-dear", 70)];

    const res = await offersFor();
    expect(res.offers!.map((o) => o.company)).toEqual(["Dear Docks LLC", "Cheap Panes LLC"]);
    expect(res.offers![0].yours).toBe(true);
    expect(res.offers![1].yours).toBe(false);
  });

  it("a crew with no rate for the work is not an option, and a $0 card is not a price", async () => {
    rows.vendors = [crew("v-1", "Priced LLC"), crew("v-2", "Unpriced LLC"), crew("v-3", "Zero LLC")];
    rows.vendor_rates = [card("v-1", 50), card("v-3", 0)];

    const res = await offersFor();
    expect(res.offers!.map((o) => o.company)).toEqual(["Priced LLC"]);
  });

  it("with no crews it says so honestly — never 'that day just filled up', never a price", async () => {
    const res = await offersFor();
    expect(res.ok).toBe(true);
    expect(res.offers).toEqual([]);
    expect(res.emptyReason).toBeTruthy();
    expect(res.emptyReason!).not.toMatch(/filled up/i);
    expect(res.emptyReason!).not.toMatch(/\$/);
  });

  it("a menu-priced service is not a choice, and says so rather than showing an empty list", async () => {
    rows.services = [{ id: "svc-1", name: "Mowing", pricing_model: "flat", active: true, crew_priced: false }];
    rows.vendors = [crew("v-1", "A Crew LLC")];
    rows.vendor_rates = [card("v-1", 50)];

    const res = await offersFor();
    expect(res.ok).toBe(true);
    expect(res.crewPriced).toBe(false);
    expect(res.emptyReason).toBeNull();
  });
});

describe("standing ships OFF, and off means not computed", () => {
  it("carries no standing at all while the dial is 0", async () => {
    rows.vendors = [crew("v-1", "A Crew LLC")];
    rows.vendor_rates = [card("v-1", 50)];

    const res = await offersFor();
    expect(settings.crewStandingPublic).toBe(0);
    expect(res.standingShown).toBe(false);
    expect(res.offers![0].standing).toBeUndefined();
    expect("standing" in res.offers![0]).toBe(false);
  });

  it("PROVES THE OFF-STATE BITES: flip the dial on in the same fixture and the standing appears", async () => {
    // The assertion above is only worth anything if the absence is caused by
    // the dial. Collapse the condition the other way and the payload must
    // change — with prod's real data (ZERO completed jobs anywhere) every crew
    // reads "New to LakeLife".
    rows.vendors = [crew("v-1", "A Crew LLC"), crew("v-2", "B Crew LLC")];
    rows.vendor_rates = [card("v-1", 50), card("v-2", 70)];
    settings.crewStandingPublic = 1;

    const res = await offersFor();
    expect(res.standingShown).toBe(true);
    expect(res.offers!.map((o) => o.standing?.label)).toEqual(["New to LakeLife", "New to LakeLife"]);
    expect(res.offers!.every((o) => o.standing?.isNew === true)).toBe(true);
    // And still no star, no score, no number pretending to be a rating.
    expect(JSON.stringify(res.offers!.map((o) => o.standing))).not.toMatch(/star|score|rating|3\.0/i);
  });

  it("with the dial on and real finished work, it is a COUNT and the lake is named", async () => {
    rows.vendors = [crew("v-1", "A Crew LLC")];
    rows.vendor_rates = [card("v-1", 50)];
    settings.crewStandingPublic = 1;
    // Two completed jobs on Big Long. The `jobs` table is also what dispatch
    // reads for "already booked that day", so these carry no vendor capacity
    // meaning beyond the two slots of four this crew has.
    rows.jobs = [
      { vendor_id: "v-1", properties: { lake_id: "lake-1" }, group_id: null, est_minutes: 30, services: null, job_items: [] },
      { vendor_id: "v-1", properties: { lake_id: "lake-1" }, group_id: null, est_minutes: 30, services: null, job_items: [] },
    ];

    const res = await offersFor();
    expect(res.offers![0].standing).toEqual({ label: "2 jobs completed", detail: "on Big Long", isNew: false });
  });
});

describe("the derivation itself", () => {
  it("is a status, never a number, and never overstates an unknown record", () => {
    expect(deriveStanding({ completedJobs: 0, lakeNames: [] }).label).toBe("New to LakeLife");
    expect(deriveStanding({ completedJobs: 1, lakeNames: ["Pretty"] })).toEqual({
      label: "1 job completed", detail: "on Pretty", isNew: false,
    });
    expect(deriveStanding({ completedJobs: 12, lakeNames: ["Big Long", "Pretty", "Big Turkey"] }).detail)
      .toBe("on Big Long, Pretty and Big Turkey");
    // A count arriving as NaN is a failed read that got past its guard. "New"
    // is the only answer that cannot overstate somebody's record.
    expect(deriveStanding({ completedJobs: Number.NaN, lakeNames: [] }).isNew).toBe(true);
    expect(deriveStanding({ completedJobs: -3, lakeNames: [] }).isNew).toBe(true);
  });

  it("the ops preview counts rows and invents nothing", () => {
    const p = summarisePreview([
      { completedJobs: 0, lakeNames: [] },
      { completedJobs: 4, lakeNames: ["Pretty"] },
      { completedJobs: 0, lakeNames: [] },
    ]);
    expect(p).toEqual({ crews: 3, withWork: 1, newToLakeLife: 2, lakes: ["Pretty"] });
    expect(previewSentence(p)).toContain("1 of 3 active crews");
    // Prod today: crews exist, none has finished anything. The sentence has to
    // say that flipping it would label everybody new.
    const none = summarisePreview([{ completedJobs: 0, lakeNames: [] }, { completedJobs: 0, lakeNames: [] }]);
    expect(previewSentence(none)).toContain("New to LakeLife");
    expect(previewSentence(summarisePreview([]))).toContain("No active crews yet");
  });
});

// ---------------------------------------------------------------------------

/** A ranked, eligible, quoting crew for the pure engine. */
const cand = (vendorId: string, crewRate: number): CrewCandidate => ({
  vendorId,
  status: "active",
  coiExpiry: "2027-06-01",
  coiNamedInsured: null,
  company: vendorId,
  serviceTypes: ["Window Washing"],
  serviceLakes: ["lake-1"],
  workDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  dailyCapacity: 4,
  assignedThatDay: 0,
  blockedThatDay: false,
  crewRate,
  score: 0,
  baseLat: null,
  baseLng: null,
});

const input = (over: Partial<DispatchInput>): DispatchInput => ({
  date: TUESDAY,
  weekday: "Tue",
  serviceName: "Window Washing",
  menuPrice: 0,
  todayISO: "2026-09-22",
  marginFloor: 0.2,
  preferredVendorId: null,
  lakeId: "lake-1",
  jobLat: null,
  jobLng: null,
  crews: [cand("v-cheap", 50), cand("v-dear", 70)],
  ...over,
});

describe("preferred is a badge, not a first refusal — on the crew-priced path", () => {
  const fee = { customerPct: 0.12, crewPct: 0.12 };

  it("does NOT hand the job to the brought crew just because they were brought", () => {
    const d = decideDispatch(input({ platformFee: fee, preferredVendorId: "v-dear" }));
    expect(d.ok).toBe(true);
    // The pool is ranked. The dearer crew does not win for being preferred.
    expect(d.result!.vendorId).not.toBe("v-dear");
  });

  it("COLLAPSED THE OTHER WAY: on the MENU path the same preferred crew still wins outright", () => {
    // The assertion above pins nothing unless the branch it removed still
    // exists somewhere. It does: the menu path is unchanged, byte for byte.
    const d = decideDispatch(input({ menuPrice: 200, preferredVendorId: "v-dear" }));
    expect(d.ok).toBe(true);
    expect(d.result!.vendorId).toBe("v-dear");
    expect(d.result!.preferred).toBe(true);
    expect(d.result!.reason).toBe("preferred crew");
  });

  it("the crew the CUSTOMER picked wins, even when they are the dearer one", () => {
    const d = decideDispatch(input({ platformFee: fee, chosenVendorId: "v-dear" }));
    expect(d.ok).toBe(true);
    expect(d.result!.vendorId).toBe("v-dear");
    expect(d.result!.reason).toBe("the crew the customer chose");
    // $70 + 12% to the customer, $70 − 12% to the crew. Seeded, not derived.
    expect(d.result!.customerPrice).toBe(78.4);
    expect(d.result!.crewPayout).toBe(61.6);
  });

  it("a picked crew who can no longer take it is REFUSED, never swapped for somebody else", () => {
    const d = decideDispatch(input({
      platformFee: fee,
      chosenVendorId: "v-gone",
      preferredVendorId: "v-dear",
    }));
    expect(d.ok).toBe(false);
    expect(d.reasonNoFit).toBe("chosen_crew_unavailable");
    expect(d.result).toBeUndefined();
  });

  it("a pick is ignored on the menu path, where there is nothing to choose between", () => {
    const d = decideDispatch(input({ menuPrice: 200, chosenVendorId: "v-gone" }));
    expect(d.ok).toBe(true);
    expect(d.result!.vendorId).toBe("v-cheap");
  });
});

// ---------------------------------------------------------------------------

describe("a crew must never read this screen", () => {
  /**
   * WHY THE WHOLE SCREEN, and not just a tidier payload.
   *
   * `customerPrice` is the crew's quote times a published multiplier, so one
   * division recovers the quote. That alone is one number per (property,
   * service, day) and is the unavoidable price of showing a buyer prices. The
   * card is worse: `vendor_rates` is GLOBAL per (vendor, service) and every
   * pricing model is linear in a field the viewer owns and can edit, with the
   * profile re-read on every call. Two loads with different pier sections
   * recover base and unit_rate exactly, for every property on the platform.
   */
  it("refuses to build offers at all when the account is also a crew", async () => {
    rows.vendors = [crew("v-1", "A Crew LLC")];
    rows.vendor_rates = [card("v-1", 50)];
    crewAccount.isCrew = true;

    const res = await offersFor();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/crew account/i);
    // Not one price, not one name, not one crew id on the wire.
    expect(res.offers).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("56");
    expect(JSON.stringify(res)).not.toContain("A Crew LLC");
  });

  it("COLLAPSED THE OTHER WAY: the same fixture with a plain homeowner gets the offers", async () => {
    // The refusal above pins nothing unless the fixture would otherwise have
    // produced a list. It does.
    rows.vendors = [crew("v-1", "A Crew LLC")];
    rows.vendor_rates = [card("v-1", 50)];

    const res = await offersFor();
    expect(res.ok).toBe(true);
    expect(res.offers!.map((o) => o.customerPrice)).toEqual([56]);
  });

  it("FAILS CLOSED: a read that could not answer is not an answer of 'not a crew'", async () => {
    rows.vendors = [crew("v-1", "A Crew LLC")];
    rows.vendor_rates = [card("v-1", 50)];
    crewAccount.failed = true;

    const res = await offersFor();
    expect(res.ok).toBe(false);
    expect(res.offers).toBeUndefined();
  });
});

describe("the crew-account helper itself", () => {
  it("asks nothing when there is nobody to ask about, and reports a hit", async () => {
    const { anyIsACrew } = await vi.importActual<typeof import("@/lib/crew-account")>("@/lib/crew-account");
    const { createServiceClient } = await import("@/lib/supabase/server");
    const admin = createServiceClient();

    rows.vendors = [];
    expect(await anyIsACrew(admin, [null, undefined])).toEqual({ isCrew: false, failed: false });
    expect(await anyIsACrew(admin, ["user-1"])).toEqual({ isCrew: false, failed: false });

    rows.vendors = [crew("v-1", "A Crew LLC")];
    expect(await anyIsACrew(admin, ["user-1"])).toEqual({ isCrew: true, failed: false });
  });
});

describe("the empty state says which empty it is", () => {
  it("names the real cause and does NOT tell them to pick another day when no day can help", async () => {
    // Prod today: zero crews signed up for anything.
    const res = await offersFor();
    expect(res.emptyHeading).toBe("No crew does this work yet");
    expect(res.emptyDateHelps).toBe(false);
    expect(res.emptyReason!).not.toMatch(/filled up/i);
    expect(res.emptyReason!).not.toMatch(/\$/);
  });

  it("does not claim a full day when nobody works that weekday", async () => {
    // One crew, Mon–Fri, nothing booked anywhere. The verdict the engine
    // returns for a Saturday is the `all_full_or_blocked` catch-all.
    rows.vendors = [crew("v-1", "A Crew LLC")];
    rows.vendor_rates = [card("v-1", 50)];
    const SATURDAY = "2026-10-10";

    const res = await buildCrewOffers({ propertyId: "prop-1", serviceId: "svc-1", dateISO: SATURDAY });
    expect(res.emptyHeading).toBe("No crew works Saturdays yet");
    expect(res.emptyDateHelps).toBe(true);
    expect(res.emptyReason!).not.toMatch(/full/i);
    expect(res.emptyReason!).not.toMatch(/filled up/i);
  });

  it("COLLAPSED THE OTHER WAY: a day they DO work, with the day genuinely full, still says taken", async () => {
    rows.vendors = [crew("v-1", "A Crew LLC", { daily_capacity: 1 })];
    rows.vendor_rates = [card("v-1", 50)];
    // One job already on the books for that crew that day fills their one slot.
    rows.jobs = [{ vendor_id: "v-1", group_id: null, est_minutes: 30, services: null, job_items: [] }];

    const res = await offersFor();
    expect(res.emptyHeading).toBe("That day is taken");
    expect(res.emptyDateHelps).toBe(true);
  });

  it("a profile with nothing to price is its own heading, and no day changes it", async () => {
    rows.vendors = [crew("v-1", "Zero LLC")];
    rows.vendor_rates = [card("v-1", 0)];

    const res = await offersFor();
    expect(res.emptyHeading).toBe("Nothing here to price yet");
    expect(res.emptyDateHelps).toBe(false);
    expect(res.emptyReason!).toMatch(/profile/i);
  });
});

describe("the crew they brought does not vanish without a word", () => {
  it("names their own crew when that crew cannot take the day", async () => {
    rows.properties[0].preferred_vendor = "v-mine";
    rows.vendors = [
      crew("v-mine", "My Own Crew LLC", { work_days: ["Mon"] }),
      crew("v-other", "Somebody Else LLC"),
    ];
    rows.vendor_rates = [card("v-mine", 50), card("v-other", 70)];

    const res = await offersFor(); // a Tuesday
    expect(res.offers!.map((o) => o.company)).toEqual(["Somebody Else LLC"]);
    expect(res.yourCrewUnavailable).toBe("My Own Crew LLC");
  });

  it("COLLAPSED THE OTHER WAY: when their crew IS on the list, nothing is said", async () => {
    rows.properties[0].preferred_vendor = "v-mine";
    rows.vendors = [crew("v-mine", "My Own Crew LLC"), crew("v-other", "Somebody Else LLC")];
    rows.vendor_rates = [card("v-mine", 50), card("v-other", 70)];

    const res = await offersFor();
    expect(res.offers![0].yours).toBe(true);
    expect(res.yourCrewUnavailable).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

/**
 * THE LINKS IN THE CHAIN THAT CANNOT BE DRIVEN FROM HERE.
 *
 * `autoAssignJob`, `claimJob` and the picker all need a session, a verified
 * mobile, a live season and a real database round trip. What can break in them
 * is a link being dropped, and that is visible in the source — so these are
 * source scans, with the comments stripped first so a scan can never pass on
 * the strength of a comment that mentions the thing.
 */
const readSrc = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const codeOf = (p: string) =>
  readSrc(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("shipping this before 0178 must not break the menu path", () => {
  const dispatchSrc = () => codeOf("src/app/book/dispatch.ts");

  it("the job select does NOT name a column that does not exist yet", () => {
    const fn = dispatchSrc().match(/export async function autoAssignJob[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn.length, "autoAssignJob not found — this scan is measuring nothing").toBeGreaterThan(2000);
    const select = fn.match(/\.select\("id, property_id, service_id[^"]*"\)/)?.[0] ?? "";
    expect(select, "the job select was not found").not.toBe("");
    // PostgREST answers an unknown column with 42703, and this function turns
    // a failed read into a no-reason skip that the booking flow keeps as a
    // "Finding a crew" row. Naming the 0178 column here would do that to EVERY
    // job on the platform, menu path included, with nothing on screen saying
    // why.
    expect(select).not.toContain("chosen_vendor_id");
  });

  it("the pick is read on its own, only for crew-priced work, and fails closed", () => {
    const fn = dispatchSrc().match(/export async function autoAssignJob[\s\S]*?\n}/)?.[0] ?? "";
    const block = fn.match(/if \(crewPriced\) \{[\s\S]*?chosen_vendor_id[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(block, "the separate pick read is gone — the column is back in the hot path").not.toBe("");
    expect(block, "a pick we cannot read must not become 'no pick', which ranks the pool")
      .toMatch(/pickRes\.error[\s\S]*?return \{ assigned: false/);
  });
});

describe("a chosen crew's job cannot be taken by another crew", () => {
  it("the claim board's action refuses it by name, and fails closed on a bad read", () => {
    const src = codeOf("src/app/vendor/open-actions.ts");
    const block = src.match(/if \(svc\.crew_priced\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(block, "the claim door has no chosen-crew guard — a rule in one doorway of three").not.toBe("");
    expect(block).toContain("chosen_vendor_id");
    expect(block, "a pick that cannot be read must refuse the claim").toMatch(/pickRes\.error[\s\S]*?return \{ ok: false/);
    expect(block, "the refusal must compare against the claiming crew").toMatch(/pick !== vendor\.id/);
  });
});

describe("the confirmation says what the SERVER did, not what the customer tapped", () => {
  const picker = () => codeOf("src/components/CrewPicker.tsx");

  it("the booked card reads the assignment off the booking result", () => {
    const card = picker().match(/if \(outcome\?\.ok\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(card, "the booked card was not found").not.toBe("");
    expect(card).toContain("outcome.assignedCrew");
    // The old card looked the crew up in the offers list it was showing. A tap
    // is not an assignment, and that list is exactly what must not be quoted
    // back as a fact about the job.
    expect(card, "the booked card is reading the offers list again").not.toMatch(/res\?\.offers/);
    expect(card, "no crew locked in has its own sentence").toMatch(/lining one up/i);
  });

  it("createBooking carries the assignment fact back to it", () => {
    const src = codeOf("src/app/book/actions.ts");
    expect(src, "createBooking drops assignedCrew, so the picker can never know")
      .toMatch(/if \(res\.ok\) return \{ ok: true, assignedCrew: res\.assignedCrew \?\? null \}/);
    expect(src, "assignedCrew must be set from the decision that wrote the row")
      .toMatch(/soloVendorId = outcome\.assigned \? outcome\.decision\.result\?\.vendorId \?\? null : null/);
  });

  it("the day picker cannot offer a day the booking door refuses", () => {
    expect(picker(), "no floor on the date input").toMatch(/min=\{earliestDate\}/);
    const page = codeOf("src/app/book/crew/page.tsx");
    expect(page, "the screen still defaults to today, where every Choose fails")
      .toMatch(/nextDayISO\(todayLakeDate\(\)\)/);
    expect(page, "a linked-in date is not clamped").toMatch(/sp\.date >= earliest/);
  });

  it("the empty state's only control is a real door, not a link to the visits list", () => {
    const empty = picker().match(/\{!loading && res\?\.ok && res\.crewPriced && \(res\.offers\?\.length \?\? 0\) === 0 && \([\s\S]*?\n      \)\}/)?.[0] ?? "";
    expect(empty, "the empty card was not found").not.toBe("");
    expect(empty, "the ask-anyway tap must book the day").toMatch(/confirm\(null\)/);
    expect(empty, "the heading must come from the verdict").toContain("res.emptyHeading");
    expect(empty, "pick-another-day must be gated on a date being able to help").toContain("res.emptyDateHelps");
  });
});

describe("standing counts only work that happened, and all of it", () => {
  const OFFERS = "src/app/book/crew-offers.ts";
  const OPS = "src/app/ops/standing-actions.ts";

  it("both readers fence fixture work and both count paid as finished", () => {
    for (const p of [OFFERS, OPS]) {
      const src = codeOf(p);
      const read = src.match(/\.from\("jobs"\)[\s\S]{0,400}?\.in\("vendor_id", ids\)/)?.[0] ?? "";
      expect(read, `${p}: the standing work-history read was not found`).not.toBe("");
      // Prod's only three completed jobs are fixture work, on a real named
      // lake. Unfenced, a real crew used in the scratch-fixture walk would be
      // published as "3 jobs completed on Big Long Lake".
      expect(read, `${p}: fixture work is being counted as a crew's record`).toContain("OWNER_FIXTURE_EMBED");
      expect(read, `${p}: the fixture filter is missing`).toContain("OWNER_FIXTURE_FILTER");
      // `paid` is terminal AFTER `complete`. Counting only `complete` makes a
      // crew's public record shrink as their work is paid out.
      expect(read, `${p}: paid work has stopped counting`).toContain('["complete", "paid"]');
      expect(read, `${p}: still filtering on complete alone`).not.toMatch(/\.eq\("status", "complete"\)/);
    }
  });
});

describe("0178 asserts the read guarantee its own heading claims", () => {
  const sql = () => readSrc("supabase/migrations/0178_every_crew_on_one_screen.sql");

  it("checks row security and refuses an unconditional read policy", () => {
    const s = sql();
    expect(s, "RLS itself is never asserted").toContain("relrowsecurity");
    expect(s, "an unconditional read policy would pass unnoticed").toContain("p.polcmd in ('r', '*')");
    expect(s).toMatch(/unconditional read policy exists/);
  });

  it("still widens nothing itself", () => {
    const s = sql();
    expect(s.toUpperCase()).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/);
    // A statement, not the word — `information_schema.role_table_grants` and
    // `grantee` are how this migration ASKS about grants without making one.
    expect(s, "0178 hands a client a read").not.toMatch(/^\s*grant\s/im);
  });
});

describe("the other doorway can reach the choice", () => {
  it("the booking grid's crew-quoted modal links to the offers screen", () => {
    // `preferred_vendor` stopped being a first right of refusal on the
    // crew-priced path, which is the intended change — but this modal books
    // the day and lets the router rank, so without this link a customer
    // (including the one who BROUGHT a crew) commits to whoever ranks first at
    // that crew's number, never having seen that a choice existed.
    const grid = codeOf("src/components/BookingGrid.tsx");
    const block = grid.match(/\{service\.crewPriced && \([\s\S]*?\)\}/)?.[0] ?? "";
    expect(block, "the crew-quoted modal has no way to the offers screen").not.toBe("");
    expect(block).toContain("/book/crew?service=");
  });
});
