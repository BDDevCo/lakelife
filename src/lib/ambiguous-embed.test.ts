import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * PGRST201 — "more than one relationship was found".
 *
 * When two tables have MORE THAN ONE foreign key between them (in either
 * direction), a bare `users(...)` embed is ambiguous and PostgREST refuses the
 * whole query with a 300. supabase-js hands that back as {error, data:null} —
 * which, unguarded, is indistinguishable from "no rows".
 *
 * THIS HAS NOW BITTEN THREE TIMES:
 *
 *   flags -> jobs      caught in approvals/data.ts, whose comment says a bare
 *                      jobs(...) "became ambiguous and PostgREST answers 300
 *                      PGRST201 — i.e. an EMPTY approvals screen".
 *   vendors -> users   the nightly COI check. Reported {ok:true, due:0} every
 *                      night, so no crew was ever warned their insurance was
 *                      about to lapse. Found 18 Aug 2026 only because the read
 *                      had just been guarded and the digest emailed a failure.
 *   vendors -> users   the ops Crews board, same embed, showing an empty roster.
 *
 * Each was fixed where it was found. Nothing stopped the next one. This does.
 *
 * TO REGENERATE THE PAIR LIST after a migration adds a foreign key:
 *
 *   with fks as (
 *     select conrelid::regclass::text a, confrelid::regclass::text b, conname
 *     from pg_constraint
 *     where contype='f' and connamespace='public'::regnamespace)
 *   select least(a,b), greatest(a,b), count(*), string_agg(conname,' | ')
 *   from fks group by 1,2 having count(*) > 1;
 */

// Unordered pairs with >1 FK between them. Verified against production
// 18 Aug 2026. A new FK between two already-linked tables belongs here.
const AMBIGUOUS: [string, string][] = [
  ["park_renters", "users"],          // 3 FKs: user_id, invite_sent_by, claim_code_issued_by
  ["disputes", "jobs"],               // job_id, correction_job_id
  ["flags", "jobs"],                  // flags.job_id, jobs.held_flag_id
  ["job_groups", "jobs"],             // job_groups.fall_job_id, jobs.group_id
  ["messages", "users"],              // from_user, handled_by
  ["park_import_batches", "users"],   // created_by, undone_by
  ["park_import_rows", "park_renters"],
  ["park_import_rows", "park_lots"],
  ["park_payment_claims", "users"],   // logged_by, resolved_by
  ["park_payments", "users"],         // recorded_by, reversed_by
  ["parks", "properties"],            // parks.service_property_id, properties.park_id
  ["users", "vendors"],               // vendors.user_id, vendors.invited_by
];

const isAmbiguous = (a: string, b: string) =>
  AMBIGUOUS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/**
 * Walk a PostgREST select expression and return every parent→child embed.
 *
 * Depth matters and a flat regex gets it wrong: in
 * `properties(address, users(name))` the users embed hangs off PROPERTIES, not
 * off the base table — and properties→users has only one FK, so it is fine.
 * An earlier version of this scan reported that as a bug; this parser exists
 * because of that false positive.
 */
export function embedPairs(base: string, select: string) {
  const out: { parent: string; child: string; named: boolean }[] = [];
  const stack = [base];
  let token = "";
  for (const ch of select) {
    if (ch === "(") {
      const raw = token.split(",").pop()!.trim();
      const named = raw.includes("!");
      const child = raw.replace(/^\w+:/, "").split("!")[0].trim();
      out.push({ parent: stack[stack.length - 1], child, named });
      stack.push(child);
      token = "";
    } else if (ch === ")") {
      if (stack.length > 1) stack.pop();
      token = "";
    } else if (ch === ",") {
      token = "";
    } else {
      token += ch;
    }
  }
  return out;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e) && !e.includes(".test.")) out.push(p);
  }
  return out;
}

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every `.from("x") … .select(<literal>)` in the tree, with concatenations joined. */
function selects(): { file: string; line: number; base: string; select: string }[] {
  const found: { file: string; line: number; base: string; select: string }[] = [];
  for (const file of sources(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /\.from\(\s*"(\w+)"/.exec(lines[i]);
      if (!m) continue;
      const block = lines.slice(i, i + 14).join("\n");
      const sel = /\.select\(([\s\S]*?)\)\s*(?:\.\w|,|\);|;)/.exec(block);
      if (!sel) continue;
      // Join "a" + "b" concatenations into one string; drop everything else.
      const literal = (sel[1].match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1)).join("");
      if (!literal) continue;
      found.push({ file: file.replace(SRC, "src/"), line: i + 1, base: m[1], select: literal });
    }
  }
  return found;
}

describe("the embed parser", () => {
  it("attributes a nested embed to its PARENT, not the base table", () => {
    const pairs = embedPairs("messages", "id, properties(address, users(name))");
    expect(pairs).toEqual([
      { parent: "messages", child: "properties", named: false },
      { parent: "properties", child: "users", named: false },
    ]);
  });

  it("sees a named relationship", () => {
    const pairs = embedPairs("vendors", "id, users!vendors_user_id_fkey(email)");
    expect(pairs[0]).toEqual({ parent: "vendors", child: "users", named: true });
  });

  it("handles an alias and an !inner hint", () => {
    expect(embedPairs("flags", "id, jobs!flags_job_id_fkey!inner(services(name))")[0].named).toBe(true);
    expect(embedPairs("x", "id, crew:vendors(company)")[0].child).toBe("vendors");
  });
});

describe("no query embeds an ambiguous relationship without naming it", () => {
  it("finds selects to check at all — the scan must not silently pass on zero", () => {
    expect(selects().length).toBeGreaterThan(50);
  });

  it("every ambiguous embed names its foreign key", () => {
    const bad: string[] = [];
    for (const s of selects()) {
      for (const p of embedPairs(s.base, s.select)) {
        if (!isAmbiguous(p.parent, p.child)) continue;
        if (p.named) continue;
        bad.push(`${s.file}:${s.line} — .from("${s.base}") embeds bare ${p.child}(...) [${p.parent} ↔ ${p.child} has >1 FK]`);
      }
    }
    expect(bad, `PGRST201 waiting to happen:\n${bad.join("\n")}`).toEqual([]);
  });
});
