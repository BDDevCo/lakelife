import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { opsReasonText } from "./claim-reasons";

/**
 * THE DOOR THE SLIP COULD NOT OPEN.
 *
 * `claim_park_file` resolved the park with `and active = true`, so every one
 * of The Haven's twenty printed slips would have been refused on 1 January —
 * while the door that MINTS the code and the door that accepts an emailed
 * invite both had no such rule. A rule enforced in one doorway out of three.
 *
 * 0153 removed it and proved it in a `do $$` block. But a ship-time assertion
 * runs once and cannot police the next migration — the lesson this codebase
 * has already paid for. So this test reads the LAST definition of each
 * function across every migration and holds the invariants there instead.
 *
 * It also cross-checks the two vocabularies. Every refusal string the SQL can
 * return has to be a string `opsReasonText` knows, or /ops renders the raw
 * code. That is exactly how `claim_park_not_open` was missing: nothing
 * compared the list in the database with the list in TypeScript.
 */

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

/** SQL with `--` comments removed. This file's own header says "active = true". */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function allMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: stripComments(readFileSync(MIGRATIONS + name, "utf8")) }));
}

/**
 * The body of the LAST `create ... function <name>` in migration order — the
 * definition that is actually live. Reading the first one, or any one, is how
 * a later migration quietly puts a rule back.
 */
function effectiveBody(fn: string): { body: string; from: string } {
  let found: { body: string; from: string } | null = null;
  for (const { name, sql } of allMigrations()) {
    const re = new RegExp(
      `create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${fn}\\s*\\(`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      // From the header to the end of the dollar-quoted body.
      const rest = sql.slice(m.index);
      const tag = rest.match(/\$([a-z_]*)\$/i);
      if (!tag) continue;
      const open = rest.indexOf(tag[0]);
      const close = rest.indexOf(tag[0], open + tag[0].length);
      if (close === -1) continue;
      found = { body: rest.slice(open, close), from: name };
    }
  }
  if (!found) throw new Error(`no definition of ${fn} found — this scan is measuring nothing`);
  return found;
}

describe("the scan finds what it claims to scan", () => {
  it("reads real migrations", () => {
    expect(allMigrations().length).toBeGreaterThan(140);
  });

  it("finds all three claim doors", () => {
    for (const fn of ["claim_park_file", "claim_park_file_by_invite", "issue_park_claim_code"]) {
      expect(effectiveBody(fn).body.length, `${fn} body looks empty`).toBeGreaterThan(200);
    }
  });

  it("takes the LAST definition, not the first", () => {
    // 0129 defined claim_park_file; 0153 redefined it. If this ever reports
    // 0129 the scanner is reading a definition that is not live, and every
    // assertion below is worthless.
    expect(effectiveBody("claim_park_file").from >= "0153").toBe(true);
  });

  it("strips comments — this file's own prose would fool it otherwise", () => {
    expect(stripComments("select 1; -- active = true\n")).not.toMatch(/active = true/);
  });
});

describe("no claim door filters on parks.active", () => {
  // parks.active is the PUBLIC-LISTING switch. It gates the park's own page
  // (public-data.ts) and a stranger's application (apply-actions.ts). A
  // resident redeeming a code her landlord printed is neither.
  for (const fn of ["claim_park_file", "claim_park_file_by_invite", "issue_park_claim_code"]) {
    it(`${fn} resolves a park without requiring it to be published`, () => {
      const { body, from } = effectiveBody(fn);
      const parkLookups = body.match(/from\s+(?:public\.)?parks\b[^;]*/gi) ?? [];
      for (const lookup of parkLookups) {
        expect(lookup, `${fn} (${from}) shuts the door on an unpublished park`)
          .not.toMatch(/active\s*=\s*true/i);
      }
    });
  }
});

describe("a refusal that reaches nobody still gets recorded", () => {
  const { body } = effectiveBody("claim_park_file");

  it("the shape check sits BELOW the file lookup, so a mistype is attributable", () => {
    // The likeliest real failure on 1 January is a mistyped code. Above the
    // file lookup it returned before any row could name her.
    expect(body.indexOf("claim_code_malformed")).toBeGreaterThan(body.indexOf("claim_no_open_lot"));
  });

  it("every claim_no_open_lot return writes a row first", () => {
    // Both branches — no such lot, and no current tenancy on it.
    const returns = body.match(/return\s+'claim_no_open_lot'/g) ?? [];
    expect(returns.length, "both no-open-lot branches must still exist").toBe(2);

    // Each one must be preceded by an insert into the log, with nothing but
    // that insert between the branch opening and the return.
    const branches = body.split(/return\s+'claim_no_open_lot'/).slice(0, -1);
    for (const b of branches) {
      const tail = b.slice(-400);
      expect(tail, "a no-open-lot refusal returned without logging")
        .toMatch(/insert\s+into\s+public\.park_renter_claim_events/i);
    }
  });

  it("the file-state checks come before the shape check", () => {
    // Telling someone whose file is LOCKED that their code looks wrong invites
    // a retype that cannot help.
    expect(body.indexOf("claim_locked")).toBeLessThan(body.indexOf("claim_code_malformed"));
  });
});

describe("the two vocabularies agree", () => {
  it("every refusal the database can return has words for ops", () => {
    // The defect this catches: claim_park_not_open existed in SQL, was absent
    // from OPS_REASON, and would have rendered as `refused (claim_park_not_open)`.
    const sql = [
      effectiveBody("claim_park_file").body,
      effectiveBody("claim_park_file_by_invite").body,
    ].join("\n");

    const codes = new Set(
      [...sql.matchAll(/'((?:claim|invite)_[a-z_]+)'/g)].map((m) => m[1]),
    );
    // Sanity: the scan found a real vocabulary, not an empty set.
    expect(codes.size).toBeGreaterThan(8);
    expect(codes.has("claim_park_not_open")).toBe(true);

    const untranslated = [...codes].filter((c) => opsReasonText(c).startsWith("refused ("));
    expect(untranslated, "these render as a raw code on /ops").toEqual([]);
  });

  it("opsReasonText still falls back rather than throwing on an unknown code", () => {
    expect(opsReasonText("claim_something_new_in_2027")).toBe("refused (claim_something_new_in_2027)");
  });
});
