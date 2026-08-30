import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkNamedInsured } from "./named-insured";

/**
 * A CONDITION WIDENED WITHOUT ITS SELECT DOES NOTHING.
 *
 * This is the third time in two days. `canClaim`'s custody refusal was dead
 * because neither caller passed the field. 0146's `slot` was written by
 * nobody because no form appended it. Both compiled, both passed every test,
 * and both were silently off.
 *
 * The named-insured check has FOUR gates and SIX reads feeding them. These
 * scans hold both ends of every one: the gate must test the field, and the
 * query behind it must fetch the field. Either alone is a rule nobody has.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** Every form a crew can send a certificate through. */
const UPLOAD_FORMS = [
  "src/components/VendorDocs.tsx",
  "src/components/VendorStorage.tsx",
  "src/components/VendorOnboarding.tsx",
];

describe("every upload form sends the name", () => {
  for (const file of UPLOAD_FORMS) {
    it(`${file.split("/").pop()} appends named_insured`, () => {
      // The server REQUIRES it. A form that does not send it cannot upload a
      // certificate at all — this is not a silent gap, it is a broken screen.
      expect(code(file), "this form cannot upload a certificate any more")
        .toMatch(/form\.set\("named_insured"/);
    });
  }
});

describe("the upload action", () => {
  const src = () => code("src/app/vendor/onboarding-actions.ts");

  it("refuses a certificate with no insured name", () => {
    expect(src()).toMatch(/form\.get\("named_insured"\)/);
    expect(src(), "a blank name must be refused, not stored")
      .toMatch(/if \(!namedInsured\)/);
  });

  it("stores the name on the row it belongs to", () => {
    const s = src();
    expect(s).toMatch(/coi_named_insured: namedInsured/);
    expect(s).toMatch(/garagekeepers_named_insured: namedInsured/);
  });

  it("clears any confirmation when the document is replaced", () => {
    // A confirmation attests to ONE file. 0152's trigger enforces this for
    // every writer; the action does it too, where a person will read it.
    const s = src();
    expect(s).toMatch(/coi_expiry_confirmed_at: null/);
    expect(s).toMatch(/garagekeepers_expiry_confirmed_at: null/);
  });

  it("does NOT refuse the upload on a mismatch — the document is still filed", () => {
    // A genuine DBA is a conversation, and throwing the paperwork away makes
    // that conversation harder. The mismatch blocks ACTIVATION, not the file.
    const fn = src().match(/export async function uploadVendorDoc[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "uploadVendorDoc not found — this scan is measuring nothing").not.toBe("");
    expect(fn, "the upload must not run the match itself").not.toMatch(/checkNamedInsured/);
  });
});

describe("every gate tests the field AND its query fetches it", () => {
  // gate file, the symbol the gate tests, and the read that feeds it
  const GATES: Array<{ gate: string; needle: RegExp; reads: string[] }> = [
    {
      gate: "src/app/vendor/onboarding-helpers.ts",
      needle: /checkNamedInsured\(v\.coi_named_insured, v\.company\)/,
      reads: ["src/app/vendor/onboarding-actions.ts"],
    },
    {
      gate: "src/app/ops/crews-actions.ts",
      needle: /checkNamedInsured\(/,
      // SCOPED TO THE GATE'S OWN FUNCTION. This file has other vendor queries
      // — confirmCoiExpiry reads coi_url/coi_expiry and has no business
      // fetching a name it does not test. Scanning the whole file flagged it,
      // which would have taught the next person to add columns to silence a
      // test rather than to feed a gate.
      reads: ["src/app/ops/crews-actions.ts#assertRoutable"],
    },
    {
      gate: "src/lib/dispatch.ts",
      needle: /c\.coiNamedInsured != null && !checkNamedInsured\(/,
      // open-data.ts takes the crew as a PARAMETER (MyVendor), so its read is
      // getMyVendor's select in data.ts — a scan pointed at the wrong file
      // would have passed vacuously and guarded nothing.
      reads: ["src/app/book/dispatch.ts", "src/app/vendor/data.ts", "src/app/vendor/open-actions.ts"],
    },
  ];

  for (const { gate, needle, reads } of GATES) {
    it(`${gate.split("/").pop()} tests the named insured`, () => {
      expect(code(gate)).toMatch(needle);
    });

    for (const r of reads) {
      it(`${r.split("/").pop()} fetches coi_named_insured for it`, () => {
        // THE WHOLE POINT. A gate reading a column its query never selected
        // gets `undefined` every time and refuses nobody.
        const [file, fn] = r.split("#");
        let src = code(file);
        if (fn) {
          const body = src.match(new RegExp(`function ${fn}\\b[\\s\\S]*?\\n\\}`))?.[0] ?? "";
          expect(body, `${r}: ${fn} not found — this scan is measuring nothing`).not.toBe("");
          src = body;
        }
        const selects = [...src.matchAll(/\.select\("([^"]*vendors?[^"]*|[^"]*coi_expiry[^"]*)"\)/g)].map((m) => m[1]);
        const vendorSelects = selects.filter((sel) => sel.includes("coi_expiry"));
        expect(vendorSelects.length, `${r}: no vendor select found — scan is stale`).toBeGreaterThan(0);
        for (const sel of vendorSelects) {
          expect(sel, `${r}: a gate reads coi_named_insured but this select omits it`)
            .toContain("coi_named_insured");
        }
      });
    }
  }

  it("both claim-board callers hand the field to canClaim", () => {
    for (const f of ["src/app/vendor/open-data.ts", "src/app/vendor/open-actions.ts"]) {
      expect(code(f), `${f}: canClaim cannot test what it is not given`)
        .toMatch(/coiNamedInsured:/);
    }
  });
});

describe("the grandfather rule, which is what stops this emptying the board", () => {
  it("a crew who predates the field is NOT blocked", () => {
    // Every vendor row on the platform had a null named insured the moment
    // 0152 shipped. A gate that refused them would have stopped routing for
    // everybody, silently — an empty board is indistinguishable from a quiet
    // day. Only a name that is PRESENT and WRONG blocks.
    const d = code("src/lib/dispatch.ts");
    const guarded = [...d.matchAll(/c\.coiNamedInsured != null && !checkNamedInsured\(/g)].length;
    const total = [...d.matchAll(/checkNamedInsured\(c\./g)].length;
    expect(total, "isEligible and canClaim both check it").toBe(2);
    // EVERY call is guarded. Counting both and requiring them equal is the
    // whole assertion: an unguarded call would raise `total` without raising
    // `guarded`, and would block every crew on the platform.
    expect(guarded, "an unguarded check would empty the board for every legacy crew").toBe(total);
  });

  it("and the ops gate grandfathers them the same way", () => {
    expect(code("src/app/ops/crews-actions.ts")).toMatch(/v\.coi_named_insured != null/);
  });

  it("but activation does NOT grandfather — a new crew must give the name", () => {
    // Activation is the moment we ask. A null there is a crew who has not
    // answered, and letting them through would mean the field never binds.
    expect(checkNamedInsured(null, "Northshore Docks").ok).toBe(false);
  });
});

describe("what we deliberately do not do", () => {
  it("nothing anywhere reads the certificate, or judges the cover", () => {
    // The owner's rule, in his words: check it is unexpired and belongs to the
    // business, "and that is it. we do not validate coverage, we do not
    // determine if the policy is enough $$."
    const files = [
      "src/lib/named-insured.ts",
      "src/app/vendor/onboarding-actions.ts",
      "src/app/vendor/onboarding-helpers.ts",
    ];
    for (const f of files) {
      const s = code(f);
      expect(s, `${f}: no coverage limit may be stored or compared`)
        .not.toMatch(/coverage_limit|policy_limit|minimum_coverage|aggregate_limit/i);
    }
  });
});
