import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * WHAT 0173'S FILE SAYS — A SCAN, AND NOT A PROOF OF ANY REFUSAL.
 *
 * Read this before trusting anything below it. VITEST HAS NO DATABASE. Not one
 * assertion in this file executes a trigger, so nothing here can show that a
 * payment cannot be edited or that a bill cannot be deleted — every test below
 * asks whether some TEXT is present in a .sql file. The proof that the guards
 * actually refuse is the migration's own post-condition block: it builds a
 * park, a household, bills and payments on real tables, tries all fifteen
 * moves, raises on any that is allowed, and rolls the whole fixture back with
 * `ROLLBACK_POSTCONDITION`. That block is the behavioural test. These are not.
 *
 * The distinction is not academic. An earlier version of this file claimed to
 * pin behaviour — "what arrived cannot be edited", "a stamp cannot be unsaid"
 * — and a verifier disabled BOTH guards in the source (`return new;` as the
 * first statement of the payment guard, `return old;` ahead of the raise in
 * the never-delete guard) and every one of its twenty-six assertions still
 * passed, because each condition it named was still sitting in the file above
 * a guard that now did nothing. A test whose name is a claim it cannot make
 * is worse than no test: it is the file somebody points at.
 *
 * SO WHAT IS LOAD-BEARING HERE, honestly:
 *
 *   THE COLUMN ACCOUNTING, which is the one that earns its keep. The dominant
 *   bug class in this codebase is a column nothing writes; its mirror is a
 *   column nothing GUARDS — added to park_payments a year from now, silently
 *   outside the freeze, editable in place while every comment on the table
 *   says it is not. The column list is derived from the migrations themselves,
 *   and each name has to turn up in 0173's guard for its table or on the one
 *   line that says where else it is decided. Nothing below weakens it.
 *
 *   THE SHAPE OF EACH GUARD BODY — the one structural property a scanner can
 *   hold against a neutered guard: a guard reaches its refusal before it can
 *   return. That section neuters the real bodies and requires the check to go
 *   red on them, so it cannot rot into another absence-only scan.
 *
 *   THE WIRING, because a guard function no trigger calls is the third shape
 *   of a symbol with no caller — correct, tested, migrated and never run.
 *
 *   AND THE TEXT THAT REACHES A PERSON: the sentences these guards raise are
 *   read in an office, and `dbSaid` puts them on screen verbatim.
 */

const migrations = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));
const sqlOf = (file: string) => readFileSync(join(migrations, file), "utf8");

const FILE = "0173_money_received_stays_the_row_it_was.sql";
const raw = sqlOf(FILE);

/** Comments are prose and can name anything; only the code counts. */
const code = raw.replace(/--.*$/gm, "");

/** The body of one `create or replace function`, comments stripped. */
function fn(name: string): string {
  const m = code.match(
    new RegExp(`create or replace function public\\.${name}\\(\\)[\\s\\S]*?\\nend \\$\\$`),
  );
  expect(m?.[0].length ?? 0, `${name} not found in ${FILE} — this scan is measuring nothing`)
    .toBeGreaterThan(200);
  return m![0];
}

/**
 * Every column either table has ever been given, read off the migrations that
 * gave it: the CREATE TABLE in 0070 plus every later `add column`. Checked
 * against production the day this was written — 28 on park_payments, 15 on
 * park_charges — so the parser is not quietly finding half of them.
 */
function columnsOf(table: string): string[] {
  const out: string[] = [];
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    const s = sqlOf(file).replace(/^\s*--.*$/gm, "");
    const made = s.match(new RegExp(`create table if not exists public\\.${table}\\s*\\(`));
    if (made) {
      let depth = 1;
      let i = made.index! + made[0].length;
      while (depth > 0 && i < s.length) {
        if (s[i] === "(") depth += 1;
        else if (s[i] === ")") depth -= 1;
        i += 1;
      }
      for (const line of s.slice(made.index! + made[0].length, i - 1).split("\n")) {
        const col = /^ {2}([a-z_]+)\s+\S/.exec(line)?.[1];
        if (col && !["unique", "constraint", "primary", "check", "foreign"].includes(col)) {
          out.push(col);
        }
      }
    }
    const altered = s.matchAll(new RegExp(`alter table (?:if exists )?public\\.${table}\\b([\\s\\S]*?);`, "g"));
    for (const a of altered) {
      for (const c of a[1].matchAll(/add column (?:if not exists )?([a-z_]+)/g)) out.push(c[1]);
    }
  }
  return [...new Set(out)];
}

describe("every column of the ledger has been decided about", () => {
  // The line 0173 carries for the one column decided somewhere else.
  const elsewhere = raw.match(/ACCOUNTED FOR ELSEWHERE: ([a-z_]+\.[a-z_]+)/g) ?? [];

  it("reads the real column lists off the migrations", () => {
    // If the parser breaks, every assertion below passes over an empty list.
    expect(columnsOf("park_payments").length).toBeGreaterThanOrEqual(28);
    expect(columnsOf("park_charges").length).toBeGreaterThanOrEqual(15);
    expect(columnsOf("park_payments")).toContain("idempotency_key"); // added by a later migration
    expect(columnsOf("park_charges")).toContain("void_reason");
  });

  it("names every park_payments column in the guard, or says where else it is decided", () => {
    const guard = fn("park_payment_is_the_row_it_was");
    const missing = columnsOf("park_payments").filter(
      (c) => !new RegExp(`new\\.${c}\\b`).test(guard)
        && !elsewhere.some((e) => e.endsWith(`park_payments.${c}`)),
    );
    expect(missing, `no decision about ${missing.join(", ")} — a column outside the freeze is editable in place while the table comment says it is not`)
      .toEqual([]);
  });

  it("names every park_charges column in the guard", () => {
    const guard = fn("park_charge_is_the_row_it_was");
    const missing = columnsOf("park_charges").filter(
      (c) => !new RegExp(`new\\.${c}\\b`).test(guard)
        && !elsewhere.some((e) => e.endsWith(`park_charges.${c}`)),
    );
    expect(missing, `no decision about ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the payment guard names every column that records what arrived", () => {
  const guard = () => fn("park_payment_is_the_row_it_was");

  it("compares amount, received_on, method, kind and reference against their old values", () => {
    const g = guard();
    for (const c of ["amount", "received_on", "method", "kind", "reference"]) {
      expect(g, `${c} is not frozen`).toMatch(new RegExp(`new\\.${c}\\s+is distinct from old\\.${c}`));
    }
  });

  it("compares created_at too, which a CHECK constraint measures received_on against", () => {
    expect(guard()).toMatch(/new\.created_at\s+is distinct from old\.created_at/);
  });

  it("pairs each FK column with `and new.<col> is not null`, so only that direction passes", () => {
    // renter_id, recorded_by and amenity_booking_id are ON DELETE SET NULL.
    // Without the `is not null`, deleting a household file would be refused;
    // without the clause at all, money could be moved to another household.
    for (const c of ["renter_id", "recorded_by", "amenity_booking_id"]) {
      expect(guard(), `${c} is not one-directional`)
        .toMatch(new RegExp(`new\\.${c} is distinct from old\\.${c} and new\\.${c} is not null`));
    }
  });
});

describe("the payment guard carries an old-is-set branch for each of the four stamps", () => {
  const guard = () => fn("park_payment_is_the_row_it_was");

  // The reversal is the one that mattered: an allocation survives a reversal
  // as record, so clearing reversed_at made every bill that cheque had
  // settled read paid again, and nobody would ever be chased for it.
  for (const anchor of ["reversed_at", "returned_on", "returned_at", "renter_confirmed_at"]) {
    it(`carries an old-is-set branch for ${anchor}`, () => {
      expect(guard(), `${anchor} can still be rubbed out`)
        .toMatch(new RegExp(`if old\\.${anchor} is not null then`));
    });
  }

  it("carries the elsif branch for a reason with no reversal behind it", () => {
    expect(guard()).toMatch(/elsif new\.reversed_at is null/);
  });
});

describe("the bill guard names the columns a snapshot is made of", () => {
  const guard = () => fn("park_charge_is_the_row_it_was");

  it("compares lines, amount, due_on and park_lot_id against their old values", () => {
    const g = guard();
    for (const c of ["lines", "amount", "due_on", "park_lot_id"]) {
      expect(g, `${c} is not frozen`).toMatch(new RegExp(`new\\.${c}\\s+is distinct from old\\.${c}`));
    }
  });

  it("closes the second doorway onto the go-live rule, and says so", () => {
    // park_charges_not_before_go_live is BEFORE INSERT only. Freezing
    // period_month is what stops a bill being walked back into a month the
    // seller was collecting; the sentence has to name that, because the office
    // has seen the INSERT refusal and needs to recognise this one.
    const g = guard();
    expect(g).toMatch(/new\.period_month is distinct from old\.period_month/);
    expect(g).toMatch(/before the park went live/);
  });

  it("carries the three branches a final, complete cancellation needs", () => {
    const g = guard();
    expect(g, "a cancelled bill could be brought back, claiming its released money twice")
      .toMatch(/old\.status = 'void' and new\.status is distinct from 'void'/);
    expect(g, "a bill could still be cancelled with no date and no reason")
      .toMatch(/new\.voided_at is null or coalesce\(btrim\(new\.void_reason\), ''\) = ''/);
    expect(g, "a cancellation's reason could still be rewritten")
      .toMatch(/if old\.voided_at is not null then/);
  });

  it("does NOT compare paid_total, because it is the one derived column", () => {
    // Freezing it would freeze the ledger: recompute_charge_paid rebuilds it
    // from the payments and allocations on every write that could move it.
    expect(guard()).not.toMatch(/new\.paid_total\s+is distinct from old\.paid_total\s+then '/);
    expect(raw).toMatch(/THE ONLY DERIVED COLUMN HERE/);
  });

  it("carries the two branches that tie status to the money on the bill", () => {
    const g = guard();
    expect(g).toMatch(/new\.status = 'paid' and new\.paid_total < new\.amount/);
    expect(g).toMatch(/new\.status = 'open' and new\.amount > 0 and new\.paid_total >= new\.amount/);
  });
});

describe("a BEFORE DELETE trigger on each table, wired to a guard that only raises", () => {
  it("wires a BEFORE DELETE trigger on each table", () => {
    expect(code, "park_payments could still be deleted outright")
      .toMatch(/create trigger trg_park_payment_is_never_deleted\s+before delete on public\.park_payments/);
    expect(code, "park_charges could still be deleted outright")
      .toMatch(/create trigger trg_park_charge_is_never_deleted\s+before delete on public\.park_charges/);
  });

  it("names the door out instead of just refusing", () => {
    // Copy never instructs a control the screen lacks: reversing, handing back
    // and refunding all exist; cancelling a bill exists on every ledger line.
    expect(fn("park_payment_is_never_deleted")).toMatch(/hand it back, or refund it/);
    expect(fn("park_charge_is_never_deleted")).toMatch(/cancel it with a reason/);
  });
});

describe("the allocation guard asks for a reason AND a name", () => {
  const guard = () => fn("guard_park_payment_allocation");

  it("branches on removed_by being null", () => {
    expect(guard(), "money could still come off a bill by nobody")
      .toMatch(/if new\.removed_by is null then/);
  });

  it("still lets the FK null a deleted person's id", () => {
    // Without this, deleting the account of anybody who had ever applied or
    // removed an allocation was refused outright — the guard read the FK's own
    // NULL as an edit of the record.
    const g = guard();
    expect(g).toMatch(/fk_set_null/);
    expect(g).toMatch(/new\.applied_by is not distinct from old\.applied_by or new\.applied_by is null/);
    expect(g).toMatch(/new\.removed_by is not distinct from old\.removed_by or new\.removed_by is null/);
  });

  it("keeps every rule 0167 and 0169 put there", () => {
    const g = guard();
    expect(g).toMatch(/an allocation is never deleted/);
    expect(g).toMatch(/a deposit is held money/);
    expect(g).toMatch(/park_payment_remaining/);
    expect(g).toMatch(/park_charge_paid_total/);
    expect(g).toMatch(/different household/);
  });
});

/**
 * THE ONE CHECK THAT SURVIVES A NEUTERED GUARD.
 *
 * Every scan above is satisfied by text sitting above a `return new;`. This
 * one is not, because it reads the ORDER of the body rather than its contents:
 * a guard whose job is to refuse must reach a `raise` before it can reach a
 * `return`, and the two ways these guards were disabled — `return new;` as the
 * first statement of a freeze guard, `return old;` ahead of the raise in a
 * never-delete guard — both break exactly that. Each case below is asserted
 * true on the real body AND false on the same body neutered here, so the check
 * cannot quietly become one that passes on anything (the shape that put this
 * whole file in question).
 *
 * It still proves nothing about Postgres. It proves that the body in the file
 * refuses before it returns; the post-condition block proves the refusal.
 */
function refusesBeforeItReturns(body: string): boolean {
  const raise = body.search(/\braise exception\b/);
  const ret = body.search(/\breturn\b/);
  // No raise at all is a guard that refuses nothing; a return in front of the
  // first raise is a guard that never reaches it.
  return raise >= 0 && (ret < 0 || raise < ret);
}

/** The disabling the verifier actually did: a return as the body's first act. */
const neutered = (body: string) => body.replace(/\bbegin\b/, "begin return new;");

describe("each guard refuses before it can return", () => {
  // The allocation guard is not in this list on purpose: it legitimately
  // returns early, for the FK's own SET NULL, before any raise. Its own shape
  // is pinned below.
  for (const name of [
    "park_payment_is_the_row_it_was",
    "park_charge_is_the_row_it_was",
    "park_payment_is_never_deleted",
    "park_charge_is_never_deleted",
  ]) {
    it(`${name} raises before it returns, and would fail this if it were disabled`, () => {
      const body = fn(name);
      expect(refusesBeforeItReturns(body), `${name} can return before it refuses anything`).toBe(true);
      // AND THE CHECK GOES RED ON A DISABLED GUARD. Without this half, a
      // predicate that always answered true would pass the line above and
      // this file would be back where it started.
      expect(refusesBeforeItReturns(neutered(body)), `${name} passes even with its guard disabled`).toBe(false);
    });
  }

  it("the two never-delete guards have no return in them at all", () => {
    // They raise and nothing else, so `return old;` anywhere in one of them is
    // somebody switching the delete back on. (The bodies are searched whole,
    // prose included — their own sentences say "take it back if it never
    // arrived", so a keyword scan for branches would be answered by English.)
    for (const name of ["park_payment_is_never_deleted", "park_charge_is_never_deleted"]) {
      const body = fn(name);
      expect(/\breturn\b/.test(body), `${name} has a return in it`).toBe(false);
      expect(/\breturn\b/.test(body.replace(/\bbegin\b/, "begin return old;")), `${name} would pass with the delete switched back on`).toBe(true);
    }
  });

  it("the allocation guard's only early return is the FK's own SET NULL", () => {
    const body = fn("guard_park_payment_allocation");
    const upToFirstRaise = body.slice(0, body.search(/\braise exception\b/));
    expect((upToFirstRaise.match(/\breturn\b/g) ?? []).length, "a second way out before any refusal").toBe(1);
    expect(upToFirstRaise).toMatch(/if fk_set_null then\s*return new;/);
  });
});

/**
 * A GUARD NO TRIGGER CALLS IS THE THIRD SHAPE OF A SYMBOL WITH NO CALLER —
 * correct, tested, migrated, and never once run. `create or replace function`
 * on its own changes nothing: the UPDATE triggers are what put these bodies in
 * the path of a write.
 */
describe("every guard body this migration writes is wired to a trigger", () => {
  it("wires both UPDATE guards to their tables", () => {
    expect(code, "the payment guard would never run")
      .toMatch(/create trigger trg_park_payment_is_the_row_it_was\s+before update on public\.park_payments\s+for each row execute function public\.park_payment_is_the_row_it_was\(\)/);
    expect(code, "the bill guard would never run")
      .toMatch(/create trigger trg_park_charge_is_the_row_it_was\s+before update on public\.park_charges\s+for each row execute function public\.park_charge_is_the_row_it_was\(\)/);
  });

  it("re-bodies the allocation guard 0167 already wired, and 0167's trigger is still there", () => {
    // This one has no trigger in 0173 — it does not need one — so the caller
    // is in another file, and that is exactly the case worth checking.
    expect(code).toMatch(/create or replace function public\.guard_park_payment_allocation\(\)/);
    const wiring = sqlOf("0167_money_on_account_comes_off_the_next_bills.sql");
    expect(wiring, "0173 re-bodies a guard nothing calls")
      .toMatch(/create trigger trg_guard_park_payment_allocation\s+before insert or update or delete on public\.park_payment_allocations\s+for each row execute function public\.guard_park_payment_allocation\(\)/);
  });
});

describe("the two table comments that had gone false", () => {
  it("no longer says money on account keeps charge_id null as the rule", () => {
    const c = raw.match(/comment on table public\.park_payment_allocations is([\s\S]*?);\n/)?.[1] ?? "";
    expect(c.length, "the allocation comment was not rewritten").toBeGreaterThan(200);
    expect(c, "still claims what 0169 deliberately changed")
      .not.toMatch(/never moves \(charge_id stays null\)/);
    expect(c).toMatch(/even after the bill is/);
  });

  it("earns the word FROZEN on park_charges by naming what enforces it", () => {
    const c = raw.match(/comment on table public\.park_charges is([\s\S]*?);\n/)?.[1] ?? "";
    expect(c.length, "the charges comment was not rewritten").toBeGreaterThan(200);
    expect(c).toMatch(/park_charge_is_the_row_it_was/);
    expect(c).toMatch(/enforced and/);
  });
});

describe("the proof block — the only thing here that runs against a database", () => {
  it("rolls its own fixture back", () => {
    expect(raw).toMatch(/raise exception 'ROLLBACK_POSTCONDITION'/);
    expect(raw).toMatch(/if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;/);
  });

  it("proves the refusals AND that the legitimate writes still land", () => {
    // A guard that breaks the run is worse than the hole it closes, so the
    // block bills, settles, reverses, allocates, hands back and cancels.
    for (const claim of [
      "a payment no longer settles its bill",
      "reversing a payment no longer reopens its bill",
      "an allocation no longer settles its bill",
      "taking an allocation off a bill no longer reopens it",
      "a bank return no longer reopens its bill",
    ]) {
      expect(raw, `the proof block does not check that ${claim}`).toContain(claim);
    }
  });

  it("is numbered after the last migration that shipped", () => {
    const numbers = readdirSync(migrations)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => Number(f.slice(0, 4)))
      .sort((a, b) => a - b);
    expect(numbers).toContain(173);
    expect(numbers.filter((n) => n === 173)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(173);
  });
});
