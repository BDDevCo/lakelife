import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  firstBillablePeriod, periodIsBillable, preCutoverRefusal, preCutoverCostRefusal,
  preCutoverEvidenceSignal, preCutoverJobNote,
} from "./billing-start";

// The real formatter, so a copy change that breaks the sentence breaks a test.
import { prettyMonth } from "@/app/park/ledger-helpers";

describe("where our ledger begins", () => {
  it("starts the month AFTER a mid-month handover", () => {
    // The Haven closes 15 Dec 2026. The seller collected December on the 1st
    // and settles the back half at the closing table. The resident paid their
    // month; our first bill is January.
    expect(firstBillablePeriod("2026-12-15")).toBe("2027-01");
  });

  it("keeps the month when go-live IS the first", () => {
    // Otherwise a park starting cleanly on the 1st could never bill at all —
    // the gate would eat its own first month.
    expect(firstBillablePeriod("2026-12-01")).toBe("2026-12");
  });

  it("rolls the year over in December", () => {
    expect(firstBillablePeriod("2026-12-31")).toBe("2027-01");
    expect(firstBillablePeriod("2026-01-31")).toBe("2026-02");
  });

  it("pads a single-digit month, so string comparison stays date order", () => {
    // "2026-9" would sort AFTER "2026-10", which would silently unblock a
    // month that ought to be refused.
    expect(firstBillablePeriod("2026-08-15")).toBe("2026-09");
    expect(firstBillablePeriod("2026-08-15")).toMatch(/^\d{4}-\d{2}$/);
  });

  it("treats a missing or malformed go-live date as NO restriction", () => {
    // Most parks join with no handover at all. Blocking them would be a worse
    // failure than the one this prevents.
    for (const bad of [null, undefined, "", "   ", "December 15", "2026-12"]) {
      expect(firstBillablePeriod(bad)).toBeNull();
      expect(periodIsBillable("2020-01", bad)).toBe(true);
    }
  });
});

describe("which months we may bill", () => {
  const CUT = "2026-12-15";

  it("refuses the handover month and everything before it", () => {
    expect(periodIsBillable("2026-12", CUT)).toBe(false);
    expect(periodIsBillable("2026-11", CUT)).toBe(false);
    expect(periodIsBillable("2019-07", CUT)).toBe(false);
  });

  it("allows every month from the first whole one onward", () => {
    expect(periodIsBillable("2027-01", CUT)).toBe(true);
    expect(periodIsBillable("2027-02", CUT)).toBe(true);
    expect(periodIsBillable("2030-06", CUT)).toBe(true);
  });

  it("compares across a year boundary correctly", () => {
    // "2027-01" > "2026-12" lexically as well as in time; this guards the day
    // somebody swaps the format.
    expect(periodIsBillable("2027-01", "2026-12-15")).toBe(true);
    expect(periodIsBillable("2026-12", "2027-01-01")).toBe(false);
  });
});

describe("what the owner is told", () => {
  it("says nothing at all when the month is ours", () => {
    expect(preCutoverRefusal("2027-01", "2026-12-15", prettyMonth)).toBeNull();
    expect(preCutoverRefusal("2020-05", null, prettyMonth)).toBeNull();
  });

  it("names the month, the go-live date, and where we start", () => {
    // All three, because the fix is either "that's right, wait" or "my go-live
    // date is wrong", and the sentence has to be enough to tell which.
    const said = preCutoverRefusal("2026-12", "2026-12-15", prettyMonth)!;
    expect(said).toContain("December 2026");
    expect(said).toContain("December 15, 2026");
    expect(said).not.toContain("2026-12-15");   // never a raw date on screen
    expect(said).toContain("January 2027");
  });

  it("blames nobody and mentions no seller", () => {
    // Most parks were never bought. Whoever was collecting rent before may be
    // the same person reading this sentence.
    const said = preCutoverRefusal("2026-12", "2026-12-15", prettyMonth)!;
    expect(said).not.toMatch(/seller|closing|purchase|owe/i);
  });

  it("writes the month in words, never as 2026-12", () => {
    const said = preCutoverRefusal("2026-12", "2026-12-15", prettyMonth)!;
    expect(said).not.toMatch(/\b2026-12\b(?!-)/);
  });
});

describe("what the owner is told at the cost door", () => {
  // The Haven: closes 15 Dec 2026, goes live 1 Jan 2027. Its 2026 property
  // tax is a credit at the closing table and must never be a park_costs row;
  // its December sewer arrived at the seller's address.
  it("says nothing when the bill's month is ours", () => {
    expect(preCutoverCostRefusal("2027-01", "2027-01-01", prettyMonth, null)).toBeNull();
    expect(preCutoverCostRefusal("2027-06", "2027-01-01", prettyMonth, null)).toBeNull();
    expect(preCutoverCostRefusal("2020-05", null, prettyMonth, null)).toBeNull();
    // A covered category is no exception when the month is ours.
    expect(preCutoverCostRefusal("2027-01", "2027-01-01", prettyMonth, "Grounds fee")).toBeNull();
  });

  it("refuses the seller's tax year and the December sewer alike", () => {
    expect(preCutoverCostRefusal("2026-01", "2027-01-01", prettyMonth, null)).not.toBeNull();
    expect(preCutoverCostRefusal("2026-12", "2027-01-01", prettyMonth, "Grounds fee")).not.toBeNull();
  });

  it("uses the one comparison the ledger already uses", () => {
    // Collapsed both ways: every month periodIsBillable allows is allowed
    // here, and every month it refuses is refused here.
    for (const m of ["2026-11", "2026-12", "2027-01", "2027-02"]) {
      for (const coveredBy of [null, "Grounds fee"]) {
        expect(preCutoverCostRefusal(m, "2026-12-15", prettyMonth, coveredBy) === null)
          .toBe(periodIsBillable(m, "2026-12-15"));
      }
    }
  });

  it("names the month, the go-live date, where the books start, and the closing statement", () => {
    const said = preCutoverCostRefusal("2026-12", "2027-01-01", prettyMonth, null)!;
    expect(said).toContain("December 2026");
    expect(said).toContain("January 1, 2027");
    expect(said).toContain("January 2027");
    expect(said).toMatch(/closing statement/);
    expect(said).toMatch(/not on the residents' bills/);
  });

  it("says where the period STARTS — never that a yearly bill is 'for January'", () => {
    // The 2026 property tax runs January to January. "That bill is for
    // January 2026" was false of it; what the rule compares is the month the
    // period begins, so that is what the sentence names.
    const tax = preCutoverCostRefusal("2026-01", "2027-01-01", prettyMonth, null)!;
    expect(tax).toMatch(/period starts in January 2026/);
    expect(tax).not.toMatch(/bill is for/);
    const sewer = preCutoverCostRefusal("2026-12", "2027-01-01", prettyMonth, "Grounds fee")!;
    expect(sewer).toMatch(/period starts in December 2026/);
  });

  it("names the closing statement only conditionally — most parks were never bought", () => {
    const said = preCutoverCostRefusal("2026-12", "2027-01-01", prettyMonth, null)!;
    expect(said).toMatch(/If the park changed hands/);
    expect(said).not.toMatch(/seller/i);
    // And "anything from before closing", not "this bill": a plough paid for
    // between closing and go-live is on nobody's closing statement.
    expect(said).toMatch(/anything from before closing/);
    expect(said).not.toMatch(/it belongs on the closing statement/);
  });

  // WHAT AN EARLIER BILL CAN BE depends on whether a fee covers it, so the
  // sentence has to know. For snow at The Haven, or tax anywhere, a bill from
  // before go-live counts as NOTHING: the fee-covered branch will not take it
  // and the other two refuse. The old sentence promised "evidence for the fee
  // comparison" on exactly those refusals.
  it("for a category no fee covers, claims no evidence and names no control", () => {
    const said = preCutoverCostRefusal("2026-12", "2027-01-01", prettyMonth, null)!;
    expect(said).not.toMatch(/evidence/i);
    expect(said).not.toMatch(/fee/i);
    expect(said).not.toMatch(/untick|tick|enter it as|record it as|choose/i);
    expect(said).toMatch(/Your books here start with January 2027\.$/);
  });

  // THE THREE PRESSES, IN ORDER. Choosing "Split it across the lots" is a
  // toggle that resets the preview (ParkCosts.tsx), so the next control he
  // sees is "Show me the split", and only after it "Record it". A sentence
  // that named the toggle alone skipped one press — and the press it skipped
  // is labelled as the opposite of what it does for this bill, in a toast he
  // cannot re-read. So every press is named, in the order they appear.
  const PRESSES = ["Split it across the lots", "Show me the split", "Record it"] as const;

  it("for a category a fee covers, names the fee, says it can go in as evidence, and names every press that gets it there — in order", () => {
    const said = preCutoverCostRefusal("2026-12", "2027-01-01", prettyMonth, "Grounds fee")!;
    expect(said).toMatch(/evidence for the fee comparison/);
    expect(said).toContain('"Grounds fee" fee');
    let at = -1;
    for (const press of PRESSES) {
      const here = said.indexOf(`"${press}"`);
      expect(here, `"${press}" is not named`).toBeGreaterThan(at);
      at = here;
    }
    // And still everything the uncovered sentence says — same facts, one more.
    expect(said).toMatch(/period starts in December 2026/);
    expect(said).toMatch(/closing statement/);
    expect(said).toMatch(/Your books here start with January 2027/);
  });

  /**
   * WHAT EACH <button> ON THE COSTS SCREEN SAYS WHEN IT IS NOT BUSY.
   *
   * Comments stripped, so a control that survives only in a comment does not
   * count. A button's child is either bare text or the screen's one busy
   * ternary, `{busy ? "Working…" : "Show me the split"}` — the idle label is
   * what the sentence names, so that is what is collected. Any other shape of
   * child is kept verbatim, so a rename that moves a label into a variable
   * fails here rather than passing on a substring.
   */
  const idleButtonLabels = () => {
    const tsx = readFileSync(join(process.cwd(), "src/components/ParkCosts.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
    // The opening tag is walked, not regexed: `onClick={() => …}` puts a `>`
    // inside the attributes, so `[^>]*` would end the tag at the arrow and
    // every button with a handler would vanish from the scan.
    const children: string[] = [];
    for (let at = tsx.indexOf("<button"); at !== -1; at = tsx.indexOf("<button", at + 1)) {
      let i = at + "<button".length, depth = 0;
      for (; i < tsx.length; i += 1) {
        const c = tsx[i];
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        else if (c === ">" && depth === 0) break;
      }
      const close = tsx.indexOf("</button>", i);
      expect(close, "a <button> with no </button>").toBeGreaterThan(i);
      children.push(tsx.slice(i + 1, close).trim());
    }
    expect(children.length, "no <button> found — the scan measures nothing").toBeGreaterThan(5);
    return children.map((child) => {
      const busy = child.match(/^\{\s*busy\s*\?\s*"[^"]*"\s*:\s*"([^"]*)"\s*\}$/);
      return busy ? busy[1] : child;
    });
  };

  it("every control the covered sentence names is on the costs screen, once, as a real button's own label", () => {
    // Copy that instructs an action the screen lacks is the house class.
    // Exact labels, not substrings: "Record it — I carry this one" is also
    // on this screen and is not the button the sentence means.
    const labels = idleButtonLabels();
    for (const press of PRESSES) {
      expect(labels.filter((l) => l === press), `"${press}" as a button's whole label`).toHaveLength(1);
    }
    // And the literal appears nowhere else in the file — one control, one name.
    const tsx = readFileSync(join(process.cwd(), "src/components/ParkCosts.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(tsx.match(/Split it across the lots/g) ?? []).toHaveLength(1);
    expect(tsx.match(/Show me the split/g) ?? []).toHaveLength(1);
    expect(tsx.match(/"Record it"/g) ?? []).toHaveLength(1);
  });

  it("the scan reads the busy ternary the way the screen writes it", () => {
    // Prove the collector on the two shapes it claims to handle, so a green
    // run above means the labels were found and not that nothing was parsed.
    const labels = idleButtonLabels();
    expect(labels).toContain("Cancel");                          // bare text
    expect(labels).toContain("Record it — I carry this one");    // idle side of a ternary
    expect(labels.some((l) => /^\{/.test(l) && /busy/.test(l)), "a busy ternary was left unparsed").toBe(false);
  });

  it("writes no raw date on screen", () => {
    for (const coveredBy of [null, "Grounds fee"]) {
      const said = preCutoverCostRefusal("2026-12", "2027-01-01", prettyMonth, coveredBy)!;
      expect(said).not.toMatch(/\b2026-12\b/);
      expect(said).not.toMatch(/\b2027-01\b/);
    }
  });
});

describe("the one branch that takes a bill from before go-live", () => {
  // The Haven's four June 2026 rows — the whole fee-coverage check — are
  // fee_covered baselines from before go-live. That branch reaches nobody's
  // bill, so it records the row and says what it is.
  it("says nothing when the period is ours — the ordinary signal applies", () => {
    expect(preCutoverEvidenceSignal("2027-01", "2027-01-01", prettyMonth, "Grounds fee")).toBeNull();
    expect(preCutoverEvidenceSignal("2026-06", null, prettyMonth, "Grounds fee")).toBeNull();
  });

  it("flips on the one comparison the refusal uses", () => {
    for (const m of ["2026-11", "2026-12", "2027-01", "2027-02"]) {
      expect(preCutoverEvidenceSignal(m, "2026-12-15", prettyMonth, "Grounds fee") === null)
        .toBe(preCutoverCostRefusal(m, "2026-12-15", prettyMonth, "Grounds fee") === null);
    }
  });

  it("names the month, the go-live day, the fee, and that it is never a bill", () => {
    const said = preCutoverEvidenceSignal("2026-06", "2027-01-01", prettyMonth, "Grounds fee")!;
    expect(said).toMatch(/^Recorded as evidence only/);
    expect(said).toContain("June 2026");
    expect(said).toContain("January 1, 2027");
    expect(said).toContain('"Grounds fee"');
    expect(said).toMatch(/never a bill/);
    expect(said).not.toMatch(/closing statement/);
    expect(said).not.toMatch(/\b2026-06\b/);
  });
});

describe("a job the one-tap list may not offer", () => {
  it("is null for a job done in a month that is ours, or at a park with no go-live date", () => {
    expect(preCutoverJobNote("2027-01", "2027-01-01", prettyMonth)).toBeNull();
    expect(preCutoverJobNote("2026-12", null, prettyMonth)).toBeNull();
  });

  it("is one line, in words, naming the month and the day — on the same comparison", () => {
    const said = preCutoverJobNote("2026-12", "2027-01-01", prettyMonth)!;
    expect(said).toContain("December 2026");
    expect(said).toContain("January 1, 2027");
    expect(said).toMatch(/not ours to split/);
    expect(said).not.toMatch(/closing statement/);
    expect(said).not.toMatch(/\b2026-12\b/);
    expect(said.length).toBeLessThan(120);
    for (const m of ["2026-11", "2026-12", "2027-01"]) {
      expect(preCutoverJobNote(m, "2026-12-15", prettyMonth) === null).toBe(periodIsBillable(m, "2026-12-15"));
    }
  });
});

describe("every path that raises a charge is gated", () => {
  // BOTH ENTRY POINTS, NOT JUST THE ONE THE BUTTON CALLS. `previewChargeRun`
  // and `runCharges` are separately exported server actions; a gate in only one
  // of them is not a gate. The database refuses this too (0131), but a caller
  // that skips the check gets a raw Postgres error instead of a sentence.
  const source = () => {
    const raw = readFileSync(
      new URL("../app/park/ledger-actions.ts", import.meta.url), "utf8");
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  };

  it("finds both functions it is scanning for", () => {
    const s = source();
    expect(s).toMatch(/export async function previewChargeRun/);
    expect(s).toMatch(/export async function runCharges/);
  });

  it("checks the go-live gate twice — once per entry point", () => {
    const hits = source().match(/preCutoverRefusal\(/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("reads cutover_date wherever it reads the due day", () => {
    // The gate is only as good as the column reaching it. Both entry points
    // select the park row already; this catches a future edit that trims the
    // select back and leaves the gate reading undefined — which would pass
    // silently, because undefined means "no restriction".
    const s = source();
    const selects = s.match(/select\("rent_due_day[^"]*"\)/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const sel of selects) expect(sel).toContain("cutover_date");
  });
});

describe("what the screens say about leaving the date blank", () => {
  /**
   * NULL MEANS NO RESTRICTION — that is this module's documented, deliberate
   * choice, because plenty of parks join with no handover at all and refusing
   * to bill them would be the worse failure.
   *
   * The park dials told him the opposite: "Leave blank until the contract
   * says. Nothing is collectable before it." Blank is precisely when
   * EVERYTHING is collectable. The Haven's cutover_date is null right now, so
   * this is the sentence he would have read.
   *
   * Any screen that offers this field has to agree with the code, so the guard
   * is on the claim rather than on the one component that made it.
   */
  const SCREENS = [
    "src/components/ParkDials.tsx",
    "src/components/ParkImportPaste.tsx",
  ];

  const bodyOf = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8");

  it("finds the screens it is scanning", () => {
    for (const f of SCREENS) expect(bodyOf(f).length).toBeGreaterThan(200);
  });

  it("no screen claims that a blank date blocks billing", () => {
    // The exact false promise, and the shapes it would most likely come back in.
    const lies = [
      /Nothing is collectable before it/i,
      /nothing can be billed until/i,
      /leave (it )?blank[^.]*nothing[^.]*bill/i,
    ];
    for (const f of SCREENS) {
      const body = bodyOf(f);
      for (const lie of lies) expect(body).not.toMatch(lie);
    }
  });

  it("the dial says what blank actually does", () => {
    expect(bodyOf("src/components/ParkDials.tsx")).toMatch(/blank[^"]*any month you ask for/i);
  });

  it("and the code it describes really does treat blank as unrestricted", () => {
    // Ties the copy to the behaviour, so changing one without the other fails.
    expect(firstBillablePeriod(null)).toBeNull();
    expect(periodIsBillable("2020-01", null)).toBe(true);
  });
});
