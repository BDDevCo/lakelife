import { describe, it, expect } from "vitest";
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

  it("the screen says who it will not reach", () => {
    // A rule enforced silently looks like a fault: the only other symptom is a
    // payer count lower than his household count.
    expect(FORM).toContain("page.inheritedTenancies > 0");
    expect(FORM).toMatch(/households you inherited/);
  });
});
