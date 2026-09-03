import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseRentRoll, parseMoney, parseLot, parseName, detectDelimiter, contentHash,
  isPlaceholderName, redactSensitive,
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
    const res = parseRentRoll("Lot\tTenant\tRent\tBalance\n1\tDonna\t340\t25");
    expect(res.rows[0].notes.join(" | ")).toMatch(/Balance/);
  });

  it("reads a phone into its own field, tidied to one spelling", () => {
    // It used to go to notes as free text, so the office could read it but
    // nothing could show it as a field. It now has a home — one the software
    // still cannot dial (see below).
    const res = parseRentRoll("Lot\tTenant\tRent\tPhone\n1\tDonna\t340\t2605550142");
    expect(res.rows[0].phone.value).toBe("(260) 555-0142");
    const other = parseRentRoll("Lot\tTenant\tRent\tCell\n1\tDonna\t340\t1 (260) 555.0142");
    expect(other.rows[0].phone.value).toBe("(260) 555-0142");   // same number, one spelling
  });

  it("a phone NEVER lands anywhere the software could text", () => {
    // The rule has not changed, only where the number is kept. It goes to
    // `phone_on_file_with_park` — a column the reminder engine is built to be
    // unable to read — and never to `mobile_e164`, which means a number the
    // person gave US and verified.
    const res = parseRentRoll("Lot\tTenant\tRent\tPhone\n1\tDonna\t340\t2605550142");
    expect(JSON.stringify(res.rows[0].lot)).not.toContain("2605550142");
    expect(JSON.stringify(res.rows[0].name)).not.toContain("2605550142");
    // And the write path keeps it out of mobile_e164.
    const commit = readFileSync(
      new URL("../app/park/import-actions.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(commit).toMatch(/phone_on_file_with_park:\s*row\.phone/);
    expect(commit).not.toMatch(/mobile_e164:\s*row\.phone/);
    expect(commit).toMatch(/contact_pref:\s*"paper"/);
  });

  it("reads an email into its own field, lower-cased", () => {
    // `email` was already a recognised HEADER — it landed in the column map and
    // the value was then dropped, because the row had nowhere to put it.
    const res = parseRentRoll("Lot\tTenant\tRent\tEmail\n1\tDonna\t340\tDonna.R@Example.COM");
    expect(res.rows[0].email.value).toBe("donna.r@example.com");
  });

  it("refuses to pick between two addresses in one cell", () => {
    // Park software exports a couple's addresses comma-separated. Taking the
    // first silently picks a spouse at random.
    const res = parseRentRoll("Lot\tTenant\tRent\tEmail\n1\tDonna\t340\ta@x.com, b@y.com");
    expect(res.rows[0].email.value).toBeNull();
    expect(res.rows[0].email.candidates).toEqual(["a@x.com", "b@y.com"]);
  });

  it("finds an address or a number in a column nobody labelled", () => {
    // Rolls arrive with "Contact", "Info", or no header at all. An address in
    // an unnamed column is not ambiguous — read it, but mark it as a guess.
    const res = parseRentRoll("Lot\tTenant\tRent\tContact\n1\tDonna\t340\tdonna@x.com");
    expect(res.rows[0].email.value).toBe("donna@x.com");
    expect(res.rows[0].email.confidence).toBe("inferred");
  });

  it("REFUSES a social security column outright, and does not keep it as a note", () => {
    // We administer tenancies; we are never a screening bureau. The safest
    // place for an SSN is nowhere, and a refused column must not fall through
    // to the notes field where every other unrecognised column lands.
    const res = parseRentRoll("Lot\tTenant\tRent\tSSN\n1\tDonna\t340\t123-45-6789");
    expect(res.columns.refused).toContain("SSN");
    expect(JSON.stringify(res.rows[0])).not.toContain("123-45-6789");
  });

  it("catches an SSN pasted under an innocent header", () => {
    // The header list catches "SSN". This catches the one filed under "Ref" —
    // nine digits grouped 3-2-4 is not a rent, a lot, or a phone.
    const res = parseRentRoll("Lot\tTenant\tRent\tRef\n1\tDonna\t340\t123-45-6789");
    expect(res.rows[0].notes.join(" ")).toMatch(/not imported/);
    // INCLUDING THE VERBATIM SOURCE LINE. Refusing the field while keeping the
    // raw line — which is what gets stored — would be a cosmetic refusal.
    expect(JSON.stringify(res.rows[0])).not.toContain("123-45-6789");
  });

  it("keeps a zip+4 and a phone, which are the same shape at a glance", () => {
    // Over-redacting would empty the addresses out of the reconcile screen.
    // A ZIP is 5-4 and a phone is 10 digits; only 3-2-4 is a social.
    const res = parseRentRoll(
      "Lot\tTenant\tRent\tAddress\tPhone\n1\tDonna\t340\t12 Elm, Angola 46703-1234\t260-555-0142");
    const blob = JSON.stringify(res.rows[0]);
    expect(blob).toContain("46703-1234");
    expect(res.rows[0].phone.value).toBe("(260) 555-0142");
  });

  it("redacts the blob the batch stores, not just the parsed copy", () => {
    expect(redactSensitive("Donna\t123-45-6789\t340")).toBe("Donna\t[not imported]\t340");
    expect(redactSensitive("Angola 46703-1234")).toBe("Angola 46703-1234");
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

// ---------------------------------------------------------------------------
// Things that are NOT people but satisfy `display_name text not null`. Every
// one of these appears in real seller rolls, and every one of them would
// become a tenant forever — on a lease, in a rent-due text, on the office wall.
// ---------------------------------------------------------------------------
describe("placeholders are not people", () => {
  const NOT_PEOPLE = [
    "SEE NOTE", "See note", "see notes",
    "SEE NOTE - son living in home, mother in nursing home since Feb",
    "See above", "SEE LEASE", "see attached",
    "SAME", "same as above", "DITTO", "As above",
    "N/A", "n/a", "NA", "NONE", "UNKNOWN", "TBD", "TBA",
    "#REF!", "#N/A", "#VALUE!", "#DIV/0!", "#NAME?",
    "???", "-", "--", ".", "?",
    "TOTAL", "TOTALS", "SUBTOTAL", "GRAND TOTAL", "TOTAL LOT RENT",
    "TENANT", "Renter", "Resident", "Name", "OCCUPANT",
    "ESTATE", "DECEASED", "MGMT", "Management",
  ];

  it("refuses every one of them as a name", () => {
    for (const s of NOT_PEOPLE) {
      expect(isPlaceholderName(s), s).toBe(true);
      expect(parseName(s).value, s).toBeNull();
    }
  });

  // The failure that matters more: refusing a REAL person is worse than
  // accepting a placeholder, because he never finds out who went missing.
  const REAL_PEOPLE = [
    "Sameer Patel",            // contains "same"
    "Seenath, Robert",         // starts with "see"
    "Samantha Doe",
    "Nan Nash",                // contains "na"
    "Noel Nunn",
    "Donna None-Smith",
    "Reyes, Donna",
    "O'Brien, Pat",
    "José Álvarez",
    "Estate of the Realm LLC",  // "estate" only as a word, not the whole cell
    "Total Comfort Homes LLC",  // a real business tenant
    "Tenant Holdings LLC",
    "Bill Ames",
    "Ditto Ramirez",            // a surname that IS the placeholder word
  ];

  it("never refuses a real name", () => {
    for (const s of REAL_PEOPLE) {
      expect(isPlaceholderName(s), s).toBe(false);
      expect(parseName(s).value, s).toBe(s);
    }
  });

  it("blocks the whole row, so a placeholder never reaches the database", () => {
    const res = parseRentRoll("Lot\tTenant\tRent\n13\tSEE NOTE\t385", { knownLots: ["13"] });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].verdict).toBe("ask");
    expect(res.rows[0].name.value).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// A NAME WITH A COMMA IN IT.
//
// Rent rolls write names "Wexler, Donna". A spreadsheet saving that to CSV
// quotes the field, and a naive split on commas made one row into six cells
// instead of five: the name truncated to '"Wexler', the rent read as 'Donna"'
// and refused, and EVERY COLUMN AFTER THE NAME SHIFTED BY ONE — her $385 rent
// landing in the deposit note, her $300 deposit landing in the move-in date.
//
// Silent, too. The row still parsed, still had a lot number, and still had a
// name that looked nearly right. Twenty-one of those is a rent roll nobody
// would catch by glancing at it.
//
// It had never bitten because the screen only took a PASTE, and pasting from a
// spreadsheet gives TAB-separated cells, which are not quoted. Adding a file
// door for the roll Mike actually emails made real CSV reachable, and this
// with it. Found by feeding the parser a realistic Haven roll before he did.
// ---------------------------------------------------------------------------
describe("quoted CSV, which is how every real rent roll writes a name", () => {
  const HAVEN = ["1", "2", "6", "11", "26", "28"];
  const parse = (csv: string) => parseRentRoll(csv, { knownLots: HAVEN });

  it("keeps a Last, First name whole and the rent in the rent column", () => {
    const r = parse('Space,Tenant,Monthly Rent,Deposit\n1,"Wexler, Donna",385,300');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name?.value).toBe("Wexler, Donna");
    expect(r.rows[0].rent?.value).toBe(385);
  });

  it("does not shift the columns after the quoted one", () => {
    // The damage was never really the name — it was everything downstream of
    // it landing one column to the left.
    const naive = 'Space,Tenant,Monthly Rent,Deposit\n2,"Kastner, Ray",385,300';
    const r = parse(naive);
    expect(r.rows[0].rent?.value).toBe(385);
    expect(r.rows[0].rent?.value).not.toBe(300);
  });

  it("reads a quoted thousands separator as one number", () => {
    // "1,200" is two cells to a naive split and $1,200 to a person.
    const r = parse('Space,Tenant,Monthly Rent\n26,"Trombley, Ken & Sue","1,200"');
    expect(r.rows[0].rent?.value).toBe(1200);
    expect(r.rows[0].name?.value).toBe("Trombley, Ken & Sue");
  });

  it('treats "" inside a quoted field as one literal quote', () => {
    const r = parse('Space,Tenant,Monthly Rent\n6,"Ordonez, ""Mari"" Maria",400');
    expect(r.rows[0].name?.value).toBe('Ordonez, "Mari" Maria');
    expect(r.rows[0].rent?.value).toBe(400);
  });

  it("leaves an UNQUOTED comma file exactly as it was", () => {
    // The old behaviour is still the behaviour when there are no quotes —
    // this fix must not move any line that was already right.
    const r = parse("Space,Tenant,Monthly Rent\n1,Donna Wexler,385");
    expect(r.rows[0].name?.value).toBe("Donna Wexler");
    expect(r.rows[0].rent?.value).toBe(385);
  });

  it("falls back to the old split on an unbalanced quote", () => {
    // A stray quote must never make a line WORSE than it was before this fix.
    // The quote has to OPEN the field to reach the quoted branch at all — my
    // first version of this test put it mid-field, where the branch is never
    // entered, so it passed with the fallback deleted. Caught by mutation.
    const r = parse('Space,Tenant,Monthly Rent\n1,"hi there,385');
    expect(r.rows[0].rent?.value, "an unterminated quote swallowed the rent").toBe(385);
  });

  it("a quote in the MIDDLE of a field is a literal quote, not an opener", () => {
    // Only a quote at the field's first character opens a quoted field. Treat
    // any quote as an opener and everything before it is discarded — the name
    // below loses "He said " entirely.
    const r = parse('Space,Tenant,Monthly Rent\n1,He said "hi there" ok,385');
    expect(r.rows[0].name?.value, "text before a mid-field quote was dropped")
      .toMatch(/He said/);
    expect(r.rows[0].rent?.value).toBe(385);
  });

  it("still accounts for every line — nothing is quietly dropped", () => {
    const r = parse('Space,Tenant,Monthly Rent\n1,"Wexler, Donna",385\n2,"Kastner, Ray",385');
    expect(r.accounting.unaccounted).toEqual([]);
    expect(r.accounting.accounted).toBe(r.accounting.totalLines);
  });

  it("a lot that is not in the park is ASKED about, not silently imported", () => {
    // The Haven's lots are not 1-21. A roll row for a lot that does not exist
    // must stop and ask rather than invent one.
    const r = parse('Space,Tenant,Monthly Rent\n99,"Nobody, Here",400');
    expect(r.rows[0].verdict).toBe("ask");
    expect(JSON.stringify(r.rows[0])).toMatch(/no lot with that number/i);
  });

  it("the whole realistic Haven roll reads correctly end to end", () => {
    const r = parse([
      "Space,Tenant,Monthly Rent,Deposit,Move In",
      '1,"Wexler, Donna",385,300,4/1/15',
      '2,"Kastner, Ray",385,,6/15/09',
      '6,"Ordonez, Maria",400,300,3/1/21',
      '26,"Trombley, Ken & Sue","1,200",500,8/1/18',
      '28,"Bui, Anh",400,300,2/1/24',
    ].join("\n"));
    expect(r.rows.map((x) => x.name?.value)).toEqual([
      "Wexler, Donna", "Kastner, Ray", "Ordonez, Maria", "Trombley, Ken & Sue", "Bui, Anh",
    ]);
    expect(r.rows.map((x) => x.rent?.value)).toEqual([385, 385, 400, 1200, 400]);
    expect(r.accounting.unaccounted).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// A COLUMN THAT IS MAPPED AND THEN THROWN AWAY.
//
// `cellAt` is called for lot, name, rent, term, email and phone — and nothing
// else. `moveIn` and `dueDay` were matched by header, consumed their column,
// and were dropped; and because the column counted as a mapped FIELD, the
// notes loop skipped it too. A sheet with "Move-in" and "Past Due" columns
// lost the tenancy start dates and the arrears figure in silence, while the
// refused-columns card named only the ones we refuse on purpose.
//
// Worse, CARRY explicitly lists "past due" — meaning keep it — and the loose
// containment pass ran first, where dueDay's synonym "due" is a substring of
// it. A list that says "keep this" was losing to a substring.
// ---------------------------------------------------------------------------
describe("no column is consumed by a field nothing reads", () => {
  const parse = (csv: string) => parseRentRoll(csv, { knownLots: ["6"] });

  it("keeps the arrears figure Mike is most likely to send", () => {
    const r = parse('Lot,Tenant,Rent,Past Due\n6,"Ordonez, Maria",400,125.00');
    expect(r.rows[0].notes.join(" "), "the arrears vanished").toMatch(/125\.00/);
  });

  it("keeps a move-in date instead of swallowing the column", () => {
    const r = parse('Lot,Tenant,Rent,Move-in\n6,"Ordonez, Maria",400,3/1/21');
    expect(r.rows[0].notes.join(" ")).toMatch(/3\/1\/21/);
  });

  it("keeps them for the exact header too, not only a fuzzy one", () => {
    const r = parse('Lot,Tenant,Rent,Due Date\n6,"Ordonez, Maria",400,the 5th');
    expect(r.rows[0].notes.join(" ")).toMatch(/5th/);
  });

  it("still maps the columns that DO have readers", () => {
    const r = parse('Lot,Tenant,Monthly Rent,Email,Phone\n6,"Ordonez, Maria",400,m@example.com,260-555-0134');
    expect(r.rows[0].lot.value).toBe("6");
    expect(r.rows[0].name.value).toBe("Ordonez, Maria");
    expect(r.rows[0].rent.value).toBe(400);
    expect(r.rows[0].email.value).toBe("m@example.com");
    expect(r.rows[0].phone.value).toBeTruthy();
  });

  it("an explicit CARRY word still beats a fuzzy field hit", () => {
    // "Balance" was already safe; "Deposit" too. The ordering change must not
    // let a field claim either of them.
    const r = parse('Lot,Tenant,Rent,Balance,Deposit\n6,"Ordonez, Maria",400,125.00,300');
    const notes = r.rows[0].notes.join(" ");
    expect(notes).toMatch(/Balance/);
    expect(notes).toMatch(/Deposit/);
  });

  it('keeps "Paid Thru", which the term matcher would otherwise swallow', () => {
    // The case that makes the CARRY-before-containment ordering load-bearing:
    // `term`'s synonym "paid" is a substring of "paid thru", and term HAS a
    // reader — so containment would consume the column and the date would be
    // parsed as a billing cadence, fail, and leave nothing behind. How far
    // each household has paid is one of the more useful things on a roll.
    for (const header of ["Paid Thru", "Paid Through", "Last Paid"]) {
      const r = parse(`Lot,Tenant,Rent,${header}\n6,"Ordonez, Maria",400,11/1/26`);
      expect(r.rows[0].notes.join(" "), `${header} was swallowed`).toMatch(/11\/1\/26/);
    }
  });

  it("and a refused column is still refused, ahead of everything", () => {
    // REFUSE runs before CARRY and before any field. Moving CARRY up must not
    // have let a social security column become a note.
    const r = parse('Lot,Tenant,Rent,SSN\n6,"Ordonez, Maria",400,123-45-6789');
    expect(r.columns.refused.join(" ")).toMatch(/SSN/i);
    expect(JSON.stringify(r.rows[0])).not.toMatch(/123-45-6789/);
  });

  it("THE LIST CANNOT ROT: every readerless target is declared", () => {
    // The guard that keeps this true as readers get built. If somebody adds a
    // cellAt("moveIn"), this fails and tells them to delete it from NO_READER.
    const src = readFileSync(
      fileURLToPath(new URL("./roll-parse.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    const targets = [...(code.match(/const SYN: Record<Target, string\[\]> = \{([\s\S]*?)\n\};/)?.[1] ?? "")
      .matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(targets.length, "SYN not found — this scan is measuring nothing").toBeGreaterThan(5);

    const read = new Set([...code.matchAll(/cellAt\("(\w+)"\)/g)].map((m) => m[1]));
    expect(read.size, "no cellAt calls found").toBeGreaterThan(3);

    const declared = new Set(
      [...(code.match(/const NO_READER: Target\[\] = \[([^\]]*)\]/)?.[1] ?? "")
        .matchAll(/"(\w+)"/g)].map((m) => m[1]),
    );

    const unread = targets.filter((t) => !read.has(t) && !declared.has(t));
    expect(unread, "these targets consume a column and nothing reads them").toEqual([]);

    const nowRead = [...declared].filter((t) => read.has(t));
    expect(nowRead, "these have a reader now — delete them from NO_READER").toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// A NAME SPLIT ACROSS TWO COLUMNS.
//
// "First Name" and "Last Name" both hit the `name` synonym list. Only the
// first index was kept, and the second column's role was still `field` — so
// the notes loop, which carries only `carry` and `unrecognised`, skipped it
// too. The surname was not in the field, not in the notes, not in a flag, and
// nothing on the review screen mentioned the column.
//
// I ran it: three rows, verdict READY, zero blockers, names "Donna", "Ray",
// "Ana". commitImport writes display_name verbatim, so twenty-one households
// would be created under their first names — which is then what prints on the
// 1 January leases and on every letter after them.
// ---------------------------------------------------------------------------
describe("a name the seller split in two", () => {
  const parse = (csv: string) => parseRentRoll(csv, { knownLots: ["6", "7"] });

  it("puts First Name and Last Name back together", () => {
    const r = parse("Lot,First Name,Last Name,Rent\n6,Donna,Wexler,385");
    expect(r.rows[0].name.value).toBe("Donna Wexler");
  });

  it("reads Last Name, First Name in the order a person would", () => {
    // As common on a rent roll as the other way round, and "Wexler Donna" is
    // not anybody's name.
    const r = parse("Lot,Last Name,First Name,Rent\n6,Wexler,Donna,385");
    expect(r.rows[0].name.value).toBe("Wexler, Donna");
  });

  it("copes when one half is blank", () => {
    const r = parse("Lot,First Name,Last Name,Rent\n6,,Wexler,385");
    expect(r.rows[0].name.value).toBe("Wexler");
  });

  it("leaves a single name column exactly as it was", () => {
    const r = parse('Lot,Tenant,Rent\n6,"Wexler, Donna",385');
    expect(r.rows[0].name.value).toBe("Wexler, Donna");
  });

  it("still refuses a placeholder after composing", () => {
    // The composed string goes through parseName like any other, so a
    // placeholder spread over two columns is still not a person. "VACANT" is
    // caught even earlier — the line never becomes a row at all — so this uses
    // a placeholder that only parseName rejects.
    const r = parse("Lot,First Name,Last Name,Rent\n6,SEE,NOTE,385");
    expect(r.rows[0].name.value).toBeNull();
    expect(r.rows[0].verdict).toBe("ask");
  });

  it("a VACANT line stays a declared vacancy, not a household", () => {
    const r = parse("Lot,First Name,Last Name,Rent\n6,VACANT,,");
    expect(r.rows).toHaveLength(0);
    expect(r.vacantDeclared).toHaveLength(1);
  });

  it("a SECOND column claiming any other taken target is carried, not lost", () => {
    // The general form of the same defect: a duplicate `field` role is read by
    // nothing and skipped by the notes loop, so the cell disappears.
    const r = parse("Lot,Tenant,Rent,Rent\n6,Maria,400,425");
    expect(r.rows[0].rent.value, "the first rent column still wins").toBe(400);
    expect(r.rows[0].notes.join(" "), "the second rent column vanished").toMatch(/425/);
  });

  it("the composed name is what the row reports, not just a note", () => {
    // display_name is written from this field verbatim.
    const r = parse("Lot,First Name,Last Name,Rent\n7,Ray,Kastner,385");
    expect(r.rows[0].name.confidence).toBe("stated");
    expect(r.rows[0].verdict).toBe("import");
    expect(r.rows[0].name.value).toBe("Ray Kastner");
  });
});


// ---------------------------------------------------------------------------
// A ROLL WITH NO HEADER ROW THREW AWAY EVERY EMAIL AND PHONE.
//
// `roles` is built from header cells, so a headerless roll left it empty. The
// per-cell loop — the one that carries unmapped columns to notes AND infers an
// email or a phone from an unnamed column — iterates `roles`, so it did
// nothing at all. Columns past the inferred three vanished in silence, and the
// only thing said about it was a sentence naming the three columns that WERE
// read.
//
// The loop's own comment says it exists for rolls that "arrive with 'Contact',
// 'Info', or no header at all". It was written for this case and could not
// reach it. Email plus phone is the stated prerequisite for the 1 January
// leases, and a printout or a phone list is exactly this shape.
// ---------------------------------------------------------------------------
describe("a roll with no header row", () => {
  const HAVEN = ["6", "7", "9"];
  const parse = (csv: string) => parseRentRoll(csv, { knownLots: HAVEN });

  it("still reads the lot, the name and the rent", () => {
    // Three rows minimum: inferColumns refuses to guess a shape from fewer,
    // which is right — two rows is not evidence.
    const r = parse("6,Donna Wexler,385\n7,Ray Kastner,385\n9,Ana Ruiz,400");
    expect(r.rows.map((x) => x.lot.value)).toEqual(["6", "7", "9"]);
    expect(r.rows[0].name.value).toBe("Donna Wexler");
  });

  it("declines to guess a rent column of bare whole numbers, and says so", () => {
    // KNOWN AND DELIBERATE. "385" and "6" are the same shape, so calling one
    // of them money would be a coin flip between the rent and the lot number.
    // The inference declines, and the screen raises a question rather than
    // filing a rent nobody stated. A roll that writes "$385" or "385.00" is
    // read normally.
    const bare = parse("6,Donna Wexler,385\n7,Ray Kastner,385\n9,Ana Ruiz,400");
    expect(bare.rows[0].rent.value).toBeNull();
    expect(bare.blockQuestions.map((q) => q.code)).toContain("NO_RENT_COLUMN");

    const withCents = parse("6,Donna Wexler,385.00\n7,Ray Kastner,385.00\n9,Ana Ruiz,400.00");
    expect(withCents.rows[0].rent.value).toBe(385);
  });

  it("finds the email and the phone in the unnamed columns", () => {
    const r = parse([
      "6,Donna Wexler,385,donna@example.com,260-555-0100",
      "7,Ray Kastner,385,ray@example.com,260-555-0101",
    ].join("\n"));
    expect(r.rows[0].email.value, "the email was discarded").toBe("donna@example.com");
    expect(r.rows[0].phone.value, "the phone was discarded").toBeTruthy();
    expect(r.rows[1].email.value).toBe("ray@example.com");
  });

  it("marks them INFERRED, because nothing said which column was which", () => {
    const r = parse("6,Donna Wexler,385,donna@example.com,260-555-0100");
    expect(r.rows[0].email.confidence).toBe("inferred");
    expect(r.rows[0].email.why ?? "").toMatch(/Read as an email/);
  });

  it("keeps an unnamed column that is neither, as a note", () => {
    // Works even when inferColumns declines (too few rows to guess a shape):
    // the roles are synthesised regardless, so nothing is discarded silently.
    const r = parse("6,Donna Wexler,385,paid thru 11/1");
    expect(r.rows[0].notes.join(" "), "the column vanished").toMatch(/paid thru/);
  });

  it("says out loud that it guessed", () => {
    const r = parse("6,Donna Wexler,385\n7,Ray Kastner,385\n9,Ana Ruiz,400");
    expect(r.blockQuestions.map((q) => q.code)).toContain("COLUMNS_INFERRED");
  });

  it("still refuses a social security number in an unnamed column", () => {
    // The SSN catch lives in the same loop that was dead here, so a headerless
    // roll had no protection at all.
    const r = parse("6,Donna Wexler,385,123-45-6789");
    expect(JSON.stringify(r.rows[0])).not.toMatch(/123-45-6789/);
    expect(r.rows[0].notes.join(" ")).toMatch(/not imported/);
  });

  it("leaves a HEADED roll exactly as it was", () => {
    const r = parse("Lot,Tenant,Rent,Email\n6,Donna Wexler,385,d@example.com");
    expect(r.blockQuestions.map((q) => q.code)).not.toContain("COLUMNS_INFERRED");
    expect(r.rows[0].email.confidence).toBe("stated");
  });
});
