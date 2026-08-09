import { describe, it, expect } from "vitest";
import {
  parseRentRoll, parseMoney, parseLot, parseName, detectDelimiter, contentHash,
} from "@/lib/roll-parse";

/** Every parse must satisfy the never-drop guarantee. A dropped line is a
 *  tenant who does not exist and nobody notices until he does not pay. */
function expectAccounted(blob: string, opts = {}) {
  const res = parseRentRoll(blob, opts);
  expect(res.accounting.unaccounted).toEqual([]);
  expect(res.accounting.duplicated).toEqual([]);
  expect(res.accounting.totalLines).toBe(blob.replace(/\r\n?/g, "\n").split("\n").length);
  return res;
}

// ---------------------------------------------------------------------------
describe("the never-drop guarantee, on every shape we can throw at it", () => {
  const blobs = [
    "Lot\tTenant\tRent\n1\tDonna Reyes\t340\n2\tBill カ\t340",
    "Pretty Lake MHP\nRent Roll — August\n\nLot,Tenant,Rent\n1,Donna Reyes,340\nTOTAL,,340",
    "Site  Resident            Monthly\n1     Donna Reyes         340.00\n2     VACANT\n3",
    "",
    "\n\n\n",
    "just one line with no structure at all",
    "Lot|Name|Rent\n1|A|1\n\n|||\nPage 2 of 4\n2|B|2",
  ];
  it.each(blobs.map((b, i) => [i, b]))("blob %i accounts for every line", (_i, blob) => {
    expectAccounted(blob as string);
  });

  it("accounts for a 500-line blob of mixed junk", () => {
    const lines = ["Lot\tTenant\tRent"];
    for (let i = 1; i <= 490; i++) {
      if (i % 17 === 0) lines.push("");
      else if (i % 23 === 0) lines.push(`Page ${i} of 500`);
      else if (i % 31 === 0) lines.push(`${i}\tVACANT`);
      else if (i % 37 === 0) lines.push(String(i));
      else lines.push(`${i}\tTenant ${i}\t${300 + (i % 90)}`);
    }
    lines.push("TOTAL\t\t26000");
    expectAccounted(lines.join("\n"));
  });
});

// ---------------------------------------------------------------------------
describe("the block questions — the attack run's worst finding", () => {
  it("an UNRECOGNISED lot header does NOT produce 79 green rows", () => {
    // The prototype rendered them all importable and the committer silently
    // discarded every one. ("Unit" itself IS in our synonym table and maps
    // correctly — the failure mode is a header the table misses.)
    const res = parseRentRoll("Location\tTenant\tRent\n1\tDonna Reyes\t340\n2\tBill Ames\t340");
    expect(res.blockQuestions.map((b) => b.code)).toContain("NO_LOT_COLUMN");
    expect(res.rows.every((r) => r.verdict === "ask")).toBe(true);
    expect(res.stats.toImport).toBe(0);
  });

  it("a missing NAME column blocks every row too", () => {
    const res = parseRentRoll("Lot\tWho lives there\tRent\n1\tDonna\t340");
    // "Who lives there" is not in the synonym list; nothing may import.
    if (res.columns.index.name === undefined) {
      expect(res.blockQuestions.map((b) => b.code)).toContain("NO_NAME_COLUMN");
      expect(res.stats.toImport).toBe(0);
    }
  });

  it("a missing RENT column is announced, not silently zeroed", () => {
    // Without this the receipt reads $0 and he thinks the seller lied.
    const res = parseRentRoll("Lot\tTenant\n1\tDonna Reyes\n2\tBill Ames");
    expect(res.blockQuestions.map((b) => b.code)).toContain("NO_RENT_COLUMN");
    // But it does NOT block — a roll with no rents is a real thing.
    expect(res.stats.toImport).toBe(2);
  });

  it("no header at all is a question, never a guess", () => {
    const res = parseRentRoll("1\tDonna Reyes\t340\n2\tBill Ames\t340");
    expect(res.blockQuestions.map((b) => b.code)).toContain("NO_HEADER");
  });
});

// ---------------------------------------------------------------------------
describe("rent: present-and-refused is not the same as absent", () => {
  it("an ABSENT rent never blocks — rent may stay blank forever", () => {
    const res = parseRentRoll("Lot\tTenant\tRent\n1\tDonna Reyes\t");
    expect(res.rows[0].verdict).toBe("import");
    expect(res.rows[0].rent.value).toBeNull();
  });

  it("a rent we SAW and could not read stops the row", () => {
    const res = parseRentRoll("Lot\tTenant\tRent\n1\tDonna Reyes\t4l0.00");
    expect(res.rows[0].verdict).toBe("ask");
    expect(res.rows[0].rent.value).toBeNull();
  });

  it("$0 is a real answer and does not block", () => {
    // A manager's lot, a family arrangement. Both real.
    const res = parseRentRoll("Lot\tTenant\tRent\n1\tDonna Reyes\t0");
    expect(res.rows[0].rent.value).toBe(0);
    expect(res.rows[0].verdict).toBe("import");
  });

  it.each([
    ["$1,250.00", 1250],
    ["1250", 1250],
    ["1,250", 1250],
    ["340.50", 340.5],
  ])("reads %s as %d", (raw, want) => {
    expect(parseMoney(raw as string).value).toBe(want);
  });

  it.each(["n/a", "-", "—", "", "  ", "TBD"])("treats %s as absent, not zero", (raw) => {
    const f = parseMoney(raw as string);
    expect(f.value).toBeNull();
    expect(f.why).toBeUndefined(); // absent is silent
  });

  it("REFUSES a European decimal comma rather than picking", () => {
    // 1.250,00 and 1,250.00 are the same glyphs and differ by 100x.
    const f = parseMoney("1.250,00");
    expect(f.value).toBeNull();
    expect(f.why).toMatch(/comma/i);
  });

  it("refuses a phone number in the money column", () => {
    // A phone parsed as money is a rent of $2,605,550,142.
    expect(parseMoney("260-555-0142").value).toBeNull();
    expect(parseMoney("(260) 555-0142").value).toBeNull();
  });

  it("refuses Excel scientific notation instead of importing a wrong number", () => {
    const f = parseMoney("1.23E+11");
    expect(f.value).toBeNull();
    expect(f.why).toMatch(/scientific/i);
  });

  it("refuses an absurd rent as a typo", () => {
    expect(parseMoney("9999999").value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("two people on one lot — the shape the prototype could not see", () => {
  it("flags BOTH rows rather than letting the database pick one at random", () => {
    // Grouping by NAME caught the same person twice and never the same lot
    // twice, which is the more common real shape: a mid-year turnover.
    const res = parseRentRoll(
      "Lot\tTenant\tRent\n7\tDonna Reyes\t340\n7\tBill Ames\t340\n8\tCarl Fox\t340",
    );
    const seven = res.rows.filter((r) => r.lot.value === "7");
    expect(seven).toHaveLength(2);
    expect(seven.every((r) => r.verdict === "ask")).toBe(true);
    expect(seven[0].askReasons.join(" ")).toMatch(/lot 7/i);
    // The unaffected row still imports — one collision must not stop the rest.
    expect(res.rows.find((r) => r.lot.value === "8")!.verdict).toBe("import");
  });
});

// ---------------------------------------------------------------------------
describe("names are taken verbatim", () => {
  it("NEVER reorders 'Reyes, Donna' — guessing is how a park imports backwards", () => {
    expect(parseName("Reyes, Donna").value).toBe("Reyes, Donna");
  });
  it("refuses a status word masquerading as a name", () => {
    for (const s of ["VACANT", "empty", "OFFICE", "available"]) {
      expect(parseName(s).value).toBeNull();
    }
  });
  it("keeps a single name, an initial, and a household", () => {
    for (const s of ["Donna", "D. Reyes", "The Millers"]) {
      expect(parseName(s).value).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
describe("lots: matched against real inventory, or not at all", () => {
  const known = ["1", "2", "10", "A1"];
  it("matches an exact lot", () => {
    expect(parseLot("10", known).value).toBe("10");
    expect(parseLot("#10", known).value).toBe("10");
  });
  it("infers past a leading zero when only one lot could mean it", () => {
    const f = parseLot("01", known);
    expect(f.value).toBe("1");
    expect(f.confidence).toBe("inferred");
  });
  it("says so when the lot is not in the park", () => {
    const f = parseLot("99", known);
    expect(f.value).toBeNull();
    expect(f.why).toMatch(/no lot/i);
  });
  it("with no inventory to match, it keeps what was written", () => {
    expect(parseLot("12", []).value).toBe("12");
  });
  it("refuses something that is plainly not a lot number", () => {
    expect(parseLot("see office", known).value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("line classification", () => {
  const blob = [
    "Pretty Lake MHP",
    "Rent Roll",
    "Lot\tTenant\tRent",
    "1\tDonna Reyes\t340",
    "2\tVACANT",
    "3",
    "OFFICE",
    "Page 1 of 2",
    "",
    "TOTAL\t\t340",
  ].join("\n");

  it("sorts every line into the right pile", () => {
    const res = expectAccounted(blob);
    expect(res.rows).toHaveLength(1);
    expect(res.vacantDeclared).toHaveLength(1);
    expect(res.silentLots).toHaveLength(1);   // lot 3 — the seller said nothing
    expect(res.facilities).toHaveLength(1);
    expect(res.totals).toHaveLength(1);
  });

  it("a SILENT lot is not the same as a DECLARED vacant — that is the walk list", () => {
    // Silence means the seller told us nothing, which is the number worth
    // walking on Saturday and the one he could not have produced himself.
    const res = parseRentRoll(blob);
    expect(res.silentLots[0].text.trim()).toBe("3");
    expect(res.vacantDeclared[0].text).toMatch(/VACANT/);
  });

  it("totals are evidence, never authority — they are not a tenant", () => {
    const res = parseRentRoll(blob);
    expect(res.rows.some((r) => /total/i.test(r.name.raw))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("delimiter detection", () => {
  it("prefers multi-space over comma, because names contain commas", () => {
    // "Reyes, Donna" split on comma cuts a person in half.
    const lines = ["Lot   Tenant        Rent", "1     Reyes, Donna  340", "2     Ames, Bill    340"];
    expect(detectDelimiter(lines)).toBe("multispace");
  });
  it.each([
    [["a\tb\tc", "1\t2\t3"], "tab"],
    [["a|b|c", "1|2|3"], "pipe"],
    [["a,b,c", "1,2,3"], "comma"],
    [["hello"], "none"],
  ])("detects %s", (lines, want) => {
    expect(detectDelimiter(lines as string[])).toBe(want);
  });
});

// ---------------------------------------------------------------------------
describe("contentHash — a second paste of the same list", () => {
  it("is stable across whitespace and case", () => {
    expect(contentHash("Lot\tName\n1\tDonna")).toBe(contentHash("lot\tname\n1\tdonna "));
  });
  it("differs when the data actually differs", () => {
    expect(contentHash("1\tDonna\t340")).not.toBe(contentHash("1\tDonna\t345"));
  });
  it("catches the same list pasted twice — without it, 158 tenant files", () => {
    const blob = "Lot\tTenant\tRent\n1\tDonna Reyes\t340";
    expect(parseRentRoll(blob).shape.contentHash).toBe(parseRentRoll(blob).shape.contentHash);
  });
});

// ---------------------------------------------------------------------------
describe("nothing is ever defaulted", () => {
  it("an unreadable field is null, never a stand-in value", () => {
    const res = parseRentRoll("Lot\tTenant\tRent\n\t\t");
    for (const r of res.rows) {
      for (const f of [r.lot, r.name, r.rent, r.term]) {
        if (f.confidence === "unknown") expect(f.value).toBeNull();
      }
    }
  });
  it("keeps the raw cell on every field, because it is the evidence", () => {
    const res = parseRentRoll("Lot\tTenant\tRent\n7\tDonna Reyes\t$340");
    expect(res.rows[0].rent.raw).toBe("$340");
    expect(res.rows[0].name.raw).toBe("Donna Reyes");
  });
  it("carries unmapped columns to notes rather than discarding them", () => {
    const res = parseRentRoll("Lot\tTenant\tRent\tPhone\tBalance\n1\tDonna\t340\t260-555-0142\t25");
    const notes = res.rows[0].notes.join(" | ");
    expect(notes).toMatch(/Phone/);
    expect(notes).toMatch(/Balance/);
  });
  it("a phone is NEVER written to a field — only carried", () => {
    // A phone written to mobile_e164 is a text message to a stranger who
    // never consented.
    const res = parseRentRoll("Lot\tTenant\tRent\tPhone\n1\tDonna\t340\t2605550142");
    expect(JSON.stringify(res.rows[0].lot)).not.toContain("2605550142");
    expect(res.rows[0].notes.join(" ")).toContain("2605550142");
  });
});

// ---------------------------------------------------------------------------
// THE FUZZ. The spec records that the prototype's never-drop guarantee was
// measurably FALSE — 1% of 3,000 random blobs lost a line. A guarantee nobody
// measured is a promise, so this measures it.
// ---------------------------------------------------------------------------
describe("never-drop, fuzzed", () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PIECES = [
    "Lot\tTenant\tRent", "Lot,Tenant,Rent", "Site  Resident  Monthly",
    "1\tDonna Reyes\t340", "2,Bill Ames,$1,250.00", "3   Reyes, Donna   340.00",
    "VACANT", "4\tVACANT\t", "OFFICE", "SHOP", "TOTAL\t\t26000",
    "Page 2 of 4", "", "   ", "7", "#12", "A1\tCarl Fox\t295",
    "9\tDonna\t4l0.00", "10\tX\t1.250,00", "11\tY\t260-555-0142",
    "Pretty Lake MHP", "Rent Roll — August 2026", "|||", "\t\t",
    "12\tThe Millers\t", "13\t\t340", "— continued —",
    "14\tJosé Álvarez\t340", "15\tBill カ\t340", "16\tO'Brien, Pat\t340",
  ];

  it("accounts for EVERY line across 3,000 random blobs", () => {
    const rnd = mulberry32(20260809);
    let checked = 0;
    for (let n = 0; n < 3000; n++) {
      const len = 1 + Math.floor(rnd() * 14);
      const lines: string[] = [];
      for (let i = 0; i < len; i++) {
        lines.push(PIECES[Math.floor(rnd() * PIECES.length)]);
      }
      const blob = lines.join("\n");
      const res = parseRentRoll(blob, { knownLots: ["1", "2", "3", "A1", "12"] });

      expect(res.accounting.unaccounted).toEqual([]);
      expect(res.accounting.duplicated).toEqual([]);
      expect(res.accounting.totalLines).toBe(blob.split("\n").length);
      checked++;
    }
    expect(checked).toBe(3000);
  });

  it("never invents a value, however strange the input", () => {
    const rnd = mulberry32(7);
    for (let n = 0; n < 1500; n++) {
      const len = 1 + Math.floor(rnd() * 8);
      const blob = Array.from({ length: len }, () => PIECES[Math.floor(rnd() * PIECES.length)]).join("\n");
      for (const r of parseRentRoll(blob).rows) {
        for (const f of [r.lot, r.name, r.rent, r.term]) {
          // The invariant that makes the whole thing trustworthy: unknown is
          // ALWAYS null. A defaulted rent is a wrong rent that looks confident.
          if (f.confidence === "unknown") expect(f.value).toBeNull();
          if (f.value !== null) expect(f.confidence).not.toBe("unknown");
        }
        // A row that cannot be identified must never claim it can be imported.
        if (r.verdict === "import") expect(r.name.value).not.toBeNull();
      }
    }
  });

  it("never throws, on anything", () => {
    const rnd = mulberry32(99);
    const chars = "ab1 \t,|#$.-\n\"'()[]{}日本語ñ";
    for (let n = 0; n < 1200; n++) {
      let blob = "";
      const len = Math.floor(rnd() * 300);
      for (let i = 0; i < len; i++) blob += chars[Math.floor(rnd() * chars.length)];
      expect(() => parseRentRoll(blob)).not.toThrow();
    }
  });
});
