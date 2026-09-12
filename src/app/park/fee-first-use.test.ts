import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE FEE PATH HAS NEVER RUN.
 *
 * `park_fees` and `lot_fee_assignments` hold zero rows in production and no
 * fee has ever been created, assigned or billed. Everything below is a defect
 * found by reading the path the owner is about to use for the first time, on
 * a park where the next thing that happens is nineteen real bills.
 *
 * These are source scans because the writes are server actions behind auth.
 * Comments are stripped first — the explanations under each fix name the very
 * strings being searched for, so an unstripped scan is satisfied by the
 * description of the bug rather than its absence.
 */

const code = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const ACTIONS = code("./fee-actions.ts");
const FORM = code("../../components/ParkFees.tsx");

describe("the scanner", () => {
  it("reads the files it thinks it reads", () => {
    expect(ACTIONS).toContain("export async function saveFee");
    expect(FORM).toContain("ParkFees");
  });

  it("stripped the prose, so an explanation cannot satisfy a test", () => {
    expect(ACTIONS).not.toContain("A ZERO FEE IS A LINE ON NINETEEN BILLS");
    expect(FORM).not.toContain("NOTHING IS TICKED UNTIL HE TICKS IT");
  });
});

describe("who added the fee", () => {
  /**
   * `park_fees.created_by` has existed since 0067 and NOTHING has ever written
   * it — the codebase's dominant defect shape, a column read by nobody because
   * it was written by nobody. The one question a disputed line provokes is
   * "who put this on my bill", and the row could not answer it.
   */
  it("is recorded on insert", () => {
    expect(ACTIONS).toMatch(/created_by:\s*await currentUserId\(\)/);
  });

  it("is not overwritten on an edit", () => {
    // An edit is a different act from an addition. Stamping the editor would
    // erase whoever made the original decision.
    const update = ACTIONS.slice(
      ACTIONS.indexOf('.from("park_fees").update'),
      ACTIONS.indexOf('.from("park_fees").insert'),
    );
    expect(update.length).toBeGreaterThan(10);
    expect(update).not.toContain("created_by");
  });
});

describe("a fee with no amount", () => {
  it("is refused before it reaches the database", () => {
    // The DB allows `amount >= 0`; this is the only thing between "0" and a
    // $0.00 line frozen onto nineteen bills.
    expect(ACTIONS).toMatch(/input\.amount <= 0/);
  });

  it("cannot be submitted from the form either", () => {
    // `!amount` blocked an empty box and passed the string "0" straight
    // through, because "0" is truthy.
    expect(FORM).not.toMatch(/disabled=\{busy \|\| !amount\}/);
    expect(FORM).toMatch(/Number\(amount\.replace\([^)]*\)\)\s*>\s*0/);
  });
});

describe("two fees with the same name", () => {
  /**
   * There is no unique index on (park_id, label) and, until now, no way to
   * EDIT a fee — so the obvious way to fix a wrong amount was to add it again
   * with the right one. Both were active, both billed, and the resident got
   * two identically labelled lines.
   */
  it("is refused while both would be active", () => {
    expect(ACTIONS).toMatch(/\.eq\("active", true\)[\s\S]{0,80}\.ilike\("label", label\)/);
  });

  it("does not refuse a fee for clashing with ITSELF on an edit", () => {
    // Without excluding the row being edited, saving a fee without renaming it
    // would report a clash with itself and no edit could ever be saved.
    expect(ACTIONS).toMatch(/!==\s*input\.id/);
  });

  it("reads the clash through mustRead, so a dropped read cannot allow one", () => {
    // `?? []` would read as "no clash" and let the duplicate through.
    const clash = ACTIONS.slice(ACTIONS.indexOf("const clash"), ACTIONS.indexOf("const row ="));
    expect(clash).toContain("mustRead");
  });
});

describe("what the fee claims to cover", () => {
  /**
   * The five boxes shipped PRE-TICKED. A tick here is not a label — `recordCost`
   * reads the ticked categories and absorbs every future bill in one of them
   * entirely into `park_absorbed`, marked 'fee_covered', never splitting it
   * across the lots again. A box he never looked at silently converts his water
   * and sewer bills into a permanent park expense he stops recovering.
   */
  it("starts with nothing ticked", () => {
    expect(FORM).toMatch(/useState<Set<string>>\(new Set\(\)\)/);
    expect(FORM).not.toMatch(/new Set\(\["water", "sewer"/);
  });

  it("still offers every category", () => {
    // Guards the guard: emptying the default must not have emptied the list.
    expect(FORM).toContain("ALL_COVERS");
  });
});

describe("correcting a fee", () => {
  /**
   * `saveFee` has always taken an optional `id` and branched to an UPDATE on
   * it. Nothing ever passed one, so the branch was dead code and a wrong
   * amount could only be switched off and re-added.
   */
  it("passes the id, so the update branch is reachable", () => {
    expect(FORM).toMatch(/id:\s*editing\s*\?\?\s*undefined/);
  });

  it("offers an Edit control on each row", () => {
    expect(FORM).toContain("setEditing(f.id)");
    expect(FORM).toMatch(/>\s*Edit\s*</);
  });

  it("clears the edit when adding a fresh one, so it cannot inherit the last", () => {
    expect(FORM).toMatch(/setEditing\(null\); setLabel\("Grounds fee"\)/);
  });
});

describe("a fee nobody is on a lot to pay", () => {
  it("does not flip the costs headline to 'covered by your fee'", () => {
    // This keyed on the fee merely EXISTING, so saving one before a single
    // household is on a lot claimed costs were being recovered that were not.
    const costs = code("./costs/page.tsx");
    expect(costs).toMatch(/coveragePayers > 0/);
  });

  it("does not read as '0 paying'", () => {
    expect(FORM).toContain("nobody on a lot yet");
  });
});

describe("what the resident sees of a part month", () => {
  /**
   * `buildStatement` writes a basis onto every line — "for the month", or
   * "12 of 31 days" — and it is stored in park_charges.lines. The resident's
   * screen dropped it, under a comment promising the bill "shows its working".
   */
  it("carries the basis through the resident's read", () => {
    const my = code("../parks/my-data.ts");
    expect(my).toMatch(/basis: string \| null/);
    expect(my).toMatch(/basis: l\.basis == null \? null : String\(l\.basis\)/);
  });

  it("renders it, but not the noise of 'for the month' on every line", () => {
    const home = code("../../components/RenterHome.tsx");
    expect(home).toContain("l.basis");
    expect(home).toMatch(/l\.basis !== "for the month"/);
  });
});

// ---------------------------------------------------------------------------

describe("the biller applies the inherited-tenancy rule", () => {
  const LEDGER = code("./ledger-actions.ts");

  it("reads origin on BOTH tenancy queries", () => {
    // Without the column the rule cannot be applied, and its absence would
    // read as "not grandfathered" — billing exactly the people it protects.
    const selects = LEDGER.split("\n").filter(
      (l) => l.includes(".select(") && l.includes("park_lot_id") && l.includes("during"),
    );
    expect(selects.length).toBe(2);
    for (const sel of selects) expect(sel).toContain("origin");
  });

  it("uses the same function in the preview and in the run", () => {
    // "A PREVIEW MUST SHOW WHAT THE RUN WILL ACTUALLY DO" — this file's own
    // rule. Two copies of the rule are two chances to disagree about a number
    // he has already approved.
    const calls = LEDGER.match(/fees: feesForTenancy\(fees, lot, s\)/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it("no longer decides it inline", () => {
    expect(LEDGER).not.toMatch(/fees:\s*\(lot\.rental_mode as string\) === "short_term"/);
  });

  it("the payer count agrees with the biller", () => {
    // If the screen counted inherited households as payers it would credit
    // income from bills that are never raised.
    expect(ACTIONS).toMatch(/\(s\.origin as string\) !== "grandfathered"/);
    expect(ACTIONS).toContain("inheritedTenancies");
  });

  it("and counts a household by whether it is on the lot TODAY, not by status alone", () => {
    // A signing trims the inherited tenancy to end that day and starts the
    // successor; both rows stay `active`. Counted by status, the trimmed
    // holdover was an inherited household forever.
    const stays = ACTIONS.split("\n").filter(
      (l) => l.includes(".select(") && l.includes("park_lot_id") && l.includes("origin"),
    );
    expect(stays.length).toBe(1);
    expect(stays[0]).toContain("during");
    expect(ACTIONS).toMatch(/r\.start <= today && today < r\.end/);
  });

  it("the screen says who it will not reach", () => {
    // A rule enforced silently looks like a fault: the only other symptom is a
    // payer count lower than his household count.
    expect(FORM).toContain("page.inheritedTenancies > 0");
    expect(FORM).toMatch(/households you inherited/);
  });
});

// ---------------------------------------------------------------------------

describe("the first afternoon, and what it shows before he taps", () => {
  const LEDGER = code("./ledger-actions.ts");
  // THE SORTING MOVED. It used to be four inline buckets in the run; it is
  // now `classifyForRun` in ledger-helpers, called by the preview AND the run
  // so the two cannot disagree. The pins follow the rule to where it lives.
  const HELPERS = code("./ledger-helpers.ts");
  const ONBOARD = code("./onboard-actions.ts");
  const SCREEN = code("../../components/ParkOnboard.tsx");

  it("the scanner finds the helper it now reads", () => {
    expect(HELPERS).toContain("export function classifyForRun(");
    expect(HELPERS).not.toContain("Pure, and the ONLY place the");
  });

  it("the run counts WHY it skipped, rather than assuming", () => {
    // "It may already be done" was asserted for four different causes, one of
    // which is the whole park's rent stopping.
    expect(LEDGER).toContain("nothingToBillReason");
    expect(LEDGER).not.toMatch(/it may already be done/i);
    // The run hands every bucket to the sentence — not a subset of them.
    for (const key of ["already:", "expired:", "notYet:", "noRent:"]) {
      expect(LEDGER).toContain(key);
    }
    for (const bucket of ['"expired"', '"notYet"', '"noRent"', '"already"']) {
      expect(HELPERS).toContain(bucket);
    }
  });

  it("an expired window is told apart from one that has not started", () => {
    // Both produce a zero statement. Only one of them is money stopping.
    // Half-open, like the database: a window ending on the 1st was not here
    // this month at all, so the comparisons are <= and >=, not < and >.
    expect(HELPERS).toMatch(/c\.range\.end <= monthStart/);
    expect(HELPERS).toMatch(/c\.range\.start >= nextMonthStart/);
  });

  it("the onboarding screen reads the fees the biller will actually charge", () => {
    // Same filter as feesFor, or the screen quotes a fee that will not bill.
    expect(ONBOARD).toContain('from("park_fees")');
    expect(ONBOARD).toMatch(/\["all_lots", "long_term"\]\.includes/);
    expect(ONBOARD).toMatch(/=== "monthly"/);
  });

  it("that read cannot fail quietly into 'no fees'", () => {
    // A dropped read would understate the total he is committing to.
    expect(ONBOARD).toMatch(/mustRead\("the fees these households will also pay"/);
  });

  it("the summary is given the fee, not just the rent", () => {
    expect(SCREEN).toMatch(/onboardSummary\(plan, capMonths, feePerSignedLot\)/);
  });

  it("a partial failure names the lots instead of counting them", () => {
    // The action already returns {lotNumber, why} per household and the toast
    // discarded every one of them.
    expect(SCREEN).toContain("setFailed(res.failed ?? [])");
    expect(SCREEN).toMatch(/Lot \{f\.lotNumber\}/);
  });
});

// ---------------------------------------------------------------------------

describe("the term, and the number that must never be a send target", () => {
  const ONBOARD2 = code("./onboard-actions.ts");
  const ACT = code("./actions.ts");
  const HELPERS = code("./park-helpers.ts");
  const SCREEN2 = code("../../components/ParkOnboard.tsx");

  it("BOTH filing paths write the term, not the ceiling", () => {
    // Passing the cap straight through wrote every signed agreement at the
    // maximum, so a whole afternoon's tenancies expire on one morning.
    for (const src of [ONBOARD2, ACT]) {
      expect(src).toContain("agreementMonthsFor");
    }
    expect(ONBOARD2).toContain("default_agreement_months");
    expect(ACT).toContain("default_agreement_months");
  });

  it("neither path passes a bare cap into buildTenant any more", () => {
    expect(ONBOARD2).not.toMatch(/signedNewLease \? parkCap : null/);
  });

  it("an office-typed number goes where nothing can text it", () => {
    // 0059 made phone_on_file_with_park a separate column precisely so an
    // office-typed number could not enrol a household into automated texting.
    expect(HELPERS).toMatch(/phone_on_file_with_park:\s*mobile \|\| null/);
    expect(HELPERS).not.toMatch(/mobile_e164:\s*mobile/);
  });

  it("and the screen no longer promises a text nobody will get", () => {
    // contact_pref is 'paper' unconditionally and no text has been delivered
    // since 19 July, so "They'll get receipts and reminders by text" was false
    // of every household it was ever shown for.
    expect(ACT).not.toMatch(/receipts and reminders by text/);
  });

  it("the onboarding row takes an email and a phone", () => {
    expect(SCREEN2).toMatch(/set\(i, "email", e\.target\.value\)/);
    expect(SCREEN2).toMatch(/set\(i, "phone", e\.target\.value\)/);
    expect(ONBOARD2).toMatch(/mobile: r\.phone/);
    expect(ONBOARD2).toMatch(/email: r\.email/);
  });
});

// ---------------------------------------------------------------------------
// THE MORNING AFTER A SIGNING, ON THE FEE PAGE.
//
// The Haven's twenty-one households arrive as inherited (grandfathered)
// tenancies. When one signs the new lease the roll trims that tenancy to end
// today and files the successor from today — both `active`, because status is
// about the booking and the range is about time. The fee page counted by
// status alone, so the signed household was still "1 household you inherited"
// and one payer short, on the screen that decides whether $142.53 is right.
//
// Run against the real loader with the database mocked and the lakes' clock
// pinned to the morning after.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  order() { return this; }
  private result() { return { data: (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))), error: null }; }
  maybeSingle() { const r = this.result(); return Promise.resolve({ data: r.data[0] ?? null, error: null }); }
  then<A, B>(ok?: ((x: { data: Row[]; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.result()).then(ok, bad);
  }
}

const OWNER = "user-owner";
const PARK = "park-haven";
const TODAY = "2027-01-15";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => TODAY,
}));

const { listFees } = await import("./fee-actions");

describe("who the fee page counts, the morning after a signing", () => {
  beforeEach(() => {
    db.park_members = [{ park_id: PARK, user_id: OWNER, role: "owner" }];
    db.park_fees = [{
      id: "fee-grounds", park_id: PARK, label: "Grounds fee", amount: 142.53,
      cadence: "monthly", applies_to: "long_term", covers: ["sewer", "grounds"], active: true,
    }];
    db.park_lots = [
      { id: "l1", park_id: PARK, rental_mode: "long_term", lifecycle: "live", site_type: "mh_single" },
      { id: "l2", park_id: PARK, rental_mode: "long_term", lifecycle: "live", site_type: "mh_single" },
    ];
    db.park_costs = [];
    db.lot_fee_assignments = [];
  });

  it("a trimmed holdover plus the office successor is ONE billable household and NO inherited one", async () => {
    db.lot_reservations = [
      // Lot 1 signed yesterday: the inherited tenancy was trimmed to end
      // then, and the successor runs from then. Both still `active`.
      { id: "r-old", park_lot_id: "l1", origin: "grandfathered", status: "active", during: `[2026-01-01,${TODAY})` },
      { id: "r-new", park_lot_id: "l1", origin: "office", status: "active", during: `[${TODAY},2028-01-01)` },
      // Lot 2 has not signed.
      { id: "r-2", park_lot_id: "l2", origin: "grandfathered", status: "active", during: "[2026-01-01,2028-01-01)" },
    ];
    const page = await listFees(PARK);
    expect(page.inheritedTenancies).toBe(1);
    expect(page.fees[0].payers).toBe(1);
    expect(page.fees[0].monthly).toBeCloseTo(142.53, 2);
  });

  it("the trimmed holdover ALONE counts as nobody — its range has ended, whatever its status says", async () => {
    db.lot_reservations = [
      { id: "r-old", park_lot_id: "l1", origin: "grandfathered", status: "active", during: "[2026-01-01,2027-01-10)" },
    ];
    const page = await listFees(PARK);
    expect(page.inheritedTenancies).toBe(0);
    expect(page.fees[0].payers).toBe(0);
  });

  it("a household still on the seller's terms is still counted as inherited", async () => {
    db.lot_reservations = [
      { id: "r-2", park_lot_id: "l2", origin: "grandfathered", status: "active", during: "[2026-01-01,2028-01-01)" },
    ];
    const page = await listFees(PARK);
    expect(page.inheritedTenancies).toBe(1);
    expect(page.fees[0].payers).toBe(0);
  });

  it("a tenancy that starts tomorrow is not here yet — half-open, like the Today screen", async () => {
    db.lot_reservations = [
      { id: "r-soon", park_lot_id: "l1", origin: "office", status: "approved", during: "[2027-01-16,2028-01-01)" },
    ];
    const page = await listFees(PARK);
    expect(page.inheritedTenancies).toBe(0);
    expect(page.fees[0].payers).toBe(0);
  });
});
