import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * A NEW TABLE ARRIVES WRITABLE. THE REVOKE IS WHAT CLOSES IT.
 *
 * Supabase grants the browser roles table DML in this schema by default, so
 * RLS is the first lock and the GRANT is the door. 0060 swept the door shut
 * for every table that existed that day. It was a sweep, not a rule, and the
 * gap reopened quietly eleven times. 0100 re-ran the sweep and then made it
 * standing with `alter default privileges`.
 *
 * ==================== HALF OF THE STANDING RULE IS REAL ====================
 *
 * MEASURED ON PRODUCTION, NOT ASSUMED. pg_default_acl, for role postgres, in
 * schema public, on tables:
 *
 *     anon          = rm      -> select + maintain. NO writes. COVERED.
 *     authenticated = arwdm   -> insert, select, update, delete. NOT COVERED.
 *
 * All 93 tables are owned by `postgres`, so that is the default ACL that
 * applies. 0182 says the same thing in its own header, having walked into it:
 *
 *     "The standing `alter default privileges` does NOT revoke writes from
 *      `authenticated`; that revoke has to be written per table or PostgREST
 *      leaves it writable by anyone who can log in."
 *
 * So a table created tomorrow is reachable by any signed-in browser at
 * /rest/v1/<table>, held shut by RLS alone — one permissive `with check`
 * branch away from the job_photos and flags holes of Phase 4.
 *
 * ======================= AND NOTHING CHECKED IT ============================
 *
 * Twenty-three tables have been created since the sweep. Every one carries its
 * revoke, written by hand, in its own migration — 23 for 23. That is twenty
 * three consecutive acts of memory and no guard at all. The nine per-feature
 * assertions that exist (park_refunds, park_documents, sms_receipts,
 * processor_events, acceptances, the two lakelife_park_* tables, job_addons)
 * each pin ONE table; none of them is a gate a NEW table has to pass.
 *
 * This file is that gate. Not a new rule — the existing rule given a doorway,
 * so table twenty-four cannot arrive open while every test stays green.
 *
 * WHY THE SAME MIGRATION. A revoke in a later file leaves a window in which
 * production is live and open. All twenty-three close it in the file that
 * opens it, so that is what is required here.
 */

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

/**
 * 0100 IS THE SWEEP ITSELF. Tables created at or before it are covered by
 * 0060/0100's schema-wide `revoke ... on all tables in schema public`, and
 * 0100b's post-condition already names the exceptions. The rule this file
 * enforces starts at the first migration AFTER the sweep.
 */
const SWEEP = "0100";
const SWEEP_FILE = "0100_the_revoke_becomes_a_standing_rule.sql";

/**
 * Tables created AFTER the sweep that legitimately take writes from the
 * session client, with the screen that would break if they lost them — the
 * same shape as 0100's post-condition (d).
 *
 * EMPTY, and that is a fact about production, not an oversight: the only six
 * client-writable tables (properties, property_profile, boats, toys,
 * notification_prefs, vendor_availability) all predate the sweep. If you are
 * adding an entry here, you are saying a browser may write this table
 * directly. Name the file that does it.
 */
const CLIENT_WRITABLE: Array<{ table: string; why: string }> = [];

const WRITES = ["INSERT", "UPDATE", "DELETE"] as const;
type Write = (typeof WRITES)[number];

/** Comments explain the rule; they must never be mistaken for the rule. */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

/** Every table a migration creates. `create temp table` is not one of these. */
function createdTables(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
    out.push(m[1].toLowerCase());
  }
  return out;
}

type Revoke = { privs: Write[]; tables: string[]; roles: string[] };

/**
 * Every table-level REVOKE in a migration, as (privileges, tables, roles).
 *
 * Statements are split on `;` and whitespace-collapsed, so the two-line form
 * (`revoke insert, update, delete, truncate, references, trigger\n  on
 * public.x from authenticated;`) and the comma-list form both parse. A revoke
 * on a FUNCTION is not a revoke on a table and must not be mistaken for one —
 * 0142 and 0167 both carry `revoke all on function public.<name>(uuid) ...`
 * beside the table they create.
 */
function revokedWrites(sql: string): Revoke[] {
  const out: Revoke[] = [];
  for (const raw of sql.split(";")) {
    const stmt = raw.replace(/\s+/g, " ").trim();
    if (!/^revoke\b/i.test(stmt)) continue;
    const m = stmt.match(/^revoke\s+(.*?)\s+on\s+(.*)\s+from\s+(.*)$/i);
    if (!m) continue;
    const objects = m[2].replace(/^table\s+/i, "");
    if (/\bfunction\b|\(/i.test(objects)) continue;              // not a table
    if (/\ball\s+tables\s+in\s+schema\b/i.test(objects)) continue; // the sweep, not a table
    out.push({
      privs: /^\s*all\b/i.test(m[1]) ? [...WRITES] : (m[1].split(",").map((p) => p.trim().toUpperCase()) as Write[]),
      tables: objects.split(",").map((o) => o.trim().replace(/^public\./i, "").toLowerCase()),
      // Revoking from PUBLIC does not remove a grant `anon` holds in its own
      // right, so the roles are read literally.
      roles: m[3].split(",").map((r) => r.trim().toLowerCase()),
    });
  }
  return out;
}

/** Which of INSERT/UPDATE/DELETE this role still holds on this table. */
function stillHeldBy(revokes: Revoke[], table: string, role: string): Write[] {
  const gone = new Set<Write>();
  for (const r of revokes) {
    if (!r.tables.includes(table) || !r.roles.includes(role)) continue;
    for (const p of r.privs) if ((WRITES as readonly string[]).includes(p)) gone.add(p);
  }
  return WRITES.filter((p) => !gone.has(p));
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const afterSweep = files.filter((f) => f.slice(0, 4) > SWEEP);
const created = afterSweep.flatMap((f) =>
  createdTables(code(readFileSync(join(MIGRATIONS, f), "utf8"))).map((table) => ({ file: f, table })),
);

describe("a new table is writable until it is revoked", () => {
  it("is reading the migrations, not an empty directory", () => {
    // A scanner over nothing passes forever. Pin that it found the ledger.
    expect(files.length).toBeGreaterThan(150);
    expect(files).toContain(SWEEP_FILE);
    // 23 as of 0182. This only ever goes up, and a drop means the scanner
    // stopped matching rather than that the tables went away.
    expect(created.length).toBeGreaterThanOrEqual(23);
  });

  for (const role of ["anon", "authenticated"] as const) {
    it(`every table created after the sweep revokes ${role} writes in its own migration`, () => {
      const offenders: string[] = [];
      for (const { file, table } of created) {
        if (CLIENT_WRITABLE.some((c) => c.table === table)) continue;
        const held = stillHeldBy(revokedWrites(code(readFileSync(join(MIGRATIONS, file), "utf8"))), table, role);
        if (held.length) offenders.push(`${file}: public.${table} leaves ${role} holding ${held.join(", ")}`);
      }
      expect(
        offenders,
        `Supabase's default privileges give \`authenticated\` insert/update/delete on every new table ` +
          `(pg_default_acl: authenticated = arwdm), so a table without a revoke is reachable at ` +
          `/rest/v1/<table> by anyone who can log in, held shut by RLS alone.\n` +
          `Add to the migration that CREATES the table:\n` +
          `  revoke all on public.<table> from anon, authenticated;\n` +
          `  grant select on public.<table> to authenticated;   -- only if a client reads it\n` +
          `If a browser genuinely must write it, add it to CLIENT_WRITABLE above with the screen ` +
          `that breaks without it.\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  it("the exception list names real tables, so a stale entry cannot hide one", () => {
    // An allowlist that outlives its table silences a check nobody notices.
    const unknown = CLIENT_WRITABLE.filter((c) => !created.some((t) => t.table === c.table));
    expect(unknown.map((c) => c.table), "CLIENT_WRITABLE names a table no migration after the sweep creates").toEqual([]);
    for (const c of CLIENT_WRITABLE) expect(c.why.length, `${c.table} needs a reason, not an entry`).toBeGreaterThan(20);
  });

  it("the scanner bites — it catches an open table and clears a closed one", () => {
    // Absence-only assertions pass against a scanner that stopped matching.
    // Feed it both, and collapse the condition one role at a time.
    const made = `create table if not exists public.widgets (id uuid primary key);`;
    expect(createdTables(made)).toEqual(["widgets"]);

    const none = revokedWrites(made);
    expect(stillHeldBy(none, "widgets", "anon")).toEqual([...WRITES]);
    expect(stillHeldBy(none, "widgets", "authenticated")).toEqual([...WRITES]);

    // Half a revoke is a failure for the half that is missing, and only that half.
    const anonOnly = revokedWrites(`${made}\nrevoke all on public.widgets from anon;`);
    expect(stillHeldBy(anonOnly, "widgets", "anon")).toEqual([]);
    expect(stillHeldBy(anonOnly, "widgets", "authenticated")).toEqual([...WRITES]);

    // The two-line form every recent migration uses.
    const both = revokedWrites(
      `${made}\nrevoke all on public.widgets from anon;\n` +
        `revoke insert, update, delete, truncate, references, trigger\n  on public.widgets from authenticated;`,
    );
    expect(stillHeldBy(both, "widgets", "anon")).toEqual([]);
    expect(stillHeldBy(both, "widgets", "authenticated")).toEqual([]);

    // A revoke on a FUNCTION of the same name clears nothing on the table.
    const fn = revokedWrites(`${made}\nrevoke all on function public.widgets(uuid) from anon, authenticated;`);
    expect(stillHeldBy(fn, "widgets", "authenticated")).toEqual([...WRITES]);

    // And a revoke that is only a COMMENT closes nothing. This is the one that
    // fails first when the comment stripper is removed.
    const commented = revokedWrites(code(`-- revoke all on public.widgets from anon, authenticated;\n${made}`));
    expect(stillHeldBy(commented, "widgets", "anon")).toEqual([...WRITES]);
  });

  it("the standing default is what covers anon, and it is still there", () => {
    // The half of the rule that IS automatic. If this line ever leaves 0100,
    // the anon column of the sweep above stops being belt-and-braces and
    // becomes the only lock.
    const sweep = code(readFileSync(join(MIGRATIONS, SWEEP_FILE), "utf8")).replace(/\s+/g, " ");
    expect(sweep).toContain(
      "alter default privileges for role postgres in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon;",
    );
  });
});
