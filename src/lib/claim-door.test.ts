import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { opsReasonText } from "./claim-reasons";
import { claimSays } from "./park-claim-copy";
import { inviteClaimSays } from "./park-invite";

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

// ---------------------------------------------------------------------------
// NOT YET ARRIVED IS NOT THE SAME AS GONE (0166).
//
// Every household on the roll is dated from the takeover, 1 January, and the
// roll deliberately prints slips for them in December. Both claim doors then
// required `t.during @> current_date` — in residence TODAY — so every one of
// those slips was refused until 1 January, logged against nobody, and expired
// two weeks later. The comment beside the rule said what it was for: a
// tenancy that ENDED is not a door. The test is now `upper(t.during) >
// current_date`, in both doors. This pins the door test itself — the WHERE of
// the tenancy lookup — so the next migration cannot put the old rule back in
// either doorway, and it collapses the rule both ways on fixture SQL so the
// pin is known to bite.
// ---------------------------------------------------------------------------
describe("a household who has not arrived yet is still a door", () => {
  /**
   * The WHERE of the tenancy lookup — the door test itself, and nothing
   * after it. The slip door may still RANK its candidates by residence in an
   * ORDER BY (a lot in turnover holds a leaving household and an arriving
   * one); that line opens nothing and is deliberately outside this slice.
   */
  function tenancyDoor(body: string): string {
    const start = body.search(/lot_reservations\s+t\b/i);
    if (start === -1) throw new Error("no tenancy lookup found — this scan is measuring nothing");
    const rest = body.slice(start);
    const end = rest.search(/\border\s+by\b|\blimit\b|\bthen\b|;/i);
    return end === -1 ? rest : rest.slice(0, end);
  }

  /** "Not ended" is the test, and "in residence today" is not. */
  function opensToArrivals(door: string): boolean {
    return (
      /upper\(\s*t\.during\s*\)\s*>\s*current_date/i.test(door) &&
      !/@>\s*current_date/i.test(door)
    );
  }

  /** And a range with no upper bound — never ended — is not shut out by a NULL. */
  function neverEndedIsOpen(door: string): boolean {
    return /upper_inf\(\s*t\.during\s*\)\s*or\s*upper\(\s*t\.during\s*\)\s*>\s*current_date/i.test(door);
  }

  const OLD_SLIP = `
    select r.* into v_file from public.park_renters r
    join public.lot_reservations t on t.renter_id = r.id
   where t.park_lot_id = v_lot and t.status in ('approved','active')
     and t.during @> current_date
   limit 1;
  if v_file.id is null then return 'claim_no_open_lot'; end if;`;
  const OLD_INVITE = `
  elsif not exists (select 1 from public.lot_reservations t
                     where t.renter_id = v_file.id and t.status in ('approved','active')
                       and t.during @> current_date)
                                            then v_reason := 'claim_no_open_lot';`;
  const NEW_SLIP = OLD_SLIP.replace("and t.during @> current_date", "and upper(t.during) > current_date");
  const NEW_INVITE = OLD_INVITE.replace("and t.during @> current_date", "and upper(t.during) > current_date");
  const RANKED_SLIP = NEW_SLIP.replace(
    "\n   limit 1;",
    "\n   order by (t.during @> current_date) desc, lower(t.during)\n   limit 1;",
  );
  const REBUILT = NEW_SLIP.replace(
    "and upper(t.during) > current_date",
    "and upper(t.during) > current_date\n     and t.during @> current_date",
  );
  // A tenancy with no end at all is not ended either. `upper()` of an
  // unbounded range is NULL, and NULL > today excludes the row — the old
  // `@>` handled that case and the new test must too.
  const OPEN_ENDED_SLIP = NEW_SLIP.replace(
    "and upper(t.during) > current_date",
    "and (upper_inf(t.during) or upper(t.during) > current_date)",
  );
  const OPEN_ENDED_INVITE = NEW_INVITE.replace(
    "and upper(t.during) > current_date",
    "and (upper_inf(t.during) or upper(t.during) > current_date)",
  );

  it("the pin bites: the old predicate fails it, in both shapes", () => {
    expect(opensToArrivals(tenancyDoor(OLD_SLIP))).toBe(false);
    expect(opensToArrivals(tenancyDoor(OLD_INVITE))).toBe(false);
  });

  it("and the new predicate passes it, in both shapes", () => {
    expect(opensToArrivals(tenancyDoor(NEW_SLIP))).toBe(true);
    expect(opensToArrivals(tenancyDoor(NEW_INVITE))).toBe(true);
  });

  it("ranking by residence AFTER the door is allowed; a second door test is not", () => {
    expect(opensToArrivals(tenancyDoor(RANKED_SLIP))).toBe(true);
    expect(opensToArrivals(tenancyDoor(REBUILT))).toBe(false);
  });

  it("a tenancy with no end date is a door too, in both shapes", () => {
    expect(opensToArrivals(tenancyDoor(OPEN_ENDED_SLIP))).toBe(true);
    expect(opensToArrivals(tenancyDoor(OPEN_ENDED_INVITE))).toBe(true);
    expect(neverEndedIsOpen(tenancyDoor(OPEN_ENDED_SLIP))).toBe(true);
    expect(neverEndedIsOpen(tenancyDoor(NEW_SLIP))).toBe(false);
  });

  it("reads 0166 or later, not a definition that is not live", () => {
    expect(effectiveBody("claim_park_file").from >= "0166").toBe(true);
    expect(effectiveBody("claim_park_file_by_invite").from >= "0166").toBe(true);
  });

  for (const fn of ["claim_park_file", "claim_park_file_by_invite"]) {
    it(`${fn}: a tenancy that has not started is a door, one that ended is not`, () => {
      const { body, from } = effectiveBody(fn);
      const door = tenancyDoor(body);
      expect(door, `${fn} (${from}) has no tenancy door`).toMatch(/status\s+in\s*\(\s*'approved'\s*,\s*'active'\s*\)/i);
      expect(opensToArrivals(door), `${fn} (${from}) refuses a household who has not arrived`).toBe(true);
      expect(neverEndedIsOpen(door), `${fn} (${from}) shuts out a tenancy with no end date`).toBe(true);
    });
  }

  it("the slip door orders its candidates once a lot in turnover can hold two", () => {
    // A bare `limit 1` would check her code against whichever household the
    // planner returned, and count the miss on the wrong file. The file whose
    // open code matches comes first, then the household in residence, then
    // the next to arrive.
    const { body } = effectiveBody("claim_park_file");
    const start = body.search(/lot_reservations\s+t\b/i);
    const lookup = body.slice(start, body.indexOf(";", start));
    expect(lookup).toMatch(/order\s+by/i);
    const ranking = lookup.slice(lookup.search(/order\s+by/i));
    expect(ranking).toMatch(/claim_code_hash/);
    expect(ranking).toMatch(/crypt\(/);
    expect(ranking).toMatch(/t\.during\s*@>\s*current_date/);
    expect(ranking).toMatch(/lower\(\s*t\.during\s*\)/);
    expect(ranking.indexOf("crypt(")).toBeLessThan(ranking.indexOf("@> current_date"));
    expect(lookup).toMatch(/limit\s+1/i);
  });

  it("the refusal logging survived the copy, line for line", () => {
    const { body } = effectiveBody("claim_park_file");
    expect(body.match(/return\s+'claim_no_open_lot'/g)).toHaveLength(2);
    expect(body.match(/insert\s+into\s+public\.park_renter_claim_events/gi)?.length).toBe(4);
    const invite = effectiveBody("claim_park_file_by_invite").body;
    expect(invite.match(/insert\s+into\s+public\.park_renter_claim_events/gi)?.length).toBe(2);
  });

  it("the refusal no longer tells her she is not 'current' — in any of the three vocabularies", () => {
    // Once an arriving household can claim, the only households this fires
    // for have ended or never existed. A December resident who mistyped her
    // lot number must not read "current household" and conclude her slip
    // does not work until January — and the invite door and /ops describe
    // the same refusal, so they must not say it either.
    expect(claimSays("claim_no_open_lot")).not.toMatch(/current/i);
    expect(claimSays("claim_no_open_lot")).toMatch(/office/i);
    expect(inviteClaimSays("claim_no_open_lot")).not.toMatch(/current/i);
    expect(inviteClaimSays("claim_no_open_lot")).toMatch(/office/i);
    expect(opsReasonText("claim_no_open_lot")).not.toMatch(/current/i);
    expect(opsReasonText("claim_no_open_lot")).not.toMatch(/^refused \(/);
  });
});
