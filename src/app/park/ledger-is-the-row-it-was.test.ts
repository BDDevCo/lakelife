import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * THE LEDGER IS THE ROW IT WAS — SCANNED, BECAUSE THE RULE LIVES IN SQL.
 *
 * 0173 is the migration that finally makes the database enforce his standing
 * rule: money received stays the row it was, corrections are new rows, and
 * nothing is ever deleted. Every behavioural path through it needs a live
 * Postgres, a park, a household, a bill and a payment — so the migration
 * carries its own proof block, which raises on any failed assertion and rolls
 * itself back, and these scans hold the properties of the FILE that the proof
 * block cannot: that the rule still covers every column tomorrow.
 *
 * THE ONE THAT EARNS ITS KEEP is the accounting scan. The dominant bug class
 * in this codebase is a column nothing writes; its mirror image is a column
 * nothing GUARDS — added to park_payments a year from now, silently outside
 * the freeze, editable in place while every comment on the table says it is
 * not. So the column list is derived from the migrations themselves and each
 * name has to turn up in 0173's guard for its table, or on the one line that
 * says where else it is decided.
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

describe("what arrived cannot be edited", () => {
  const guard = () => fn("park_payment_is_the_row_it_was");

  it("freezes the amount, the day, the method, the kind and the reference", () => {
    const g = guard();
    for (const c of ["amount", "received_on", "method", "kind", "reference"]) {
      expect(g, `${c} is not frozen`).toMatch(new RegExp(`new\\.${c}\\s+is distinct from old\\.${c}`));
    }
  });

  it("freezes created_at, which a CHECK constraint measures received_on against", () => {
    expect(guard()).toMatch(/new\.created_at\s+is distinct from old\.created_at/);
  });

  it("lets the FK's own NULL through, and only that direction", () => {
    // renter_id, recorded_by and amenity_booking_id are ON DELETE SET NULL.
    // Without the `is not null`, deleting a household file would be refused;
    // without the clause at all, money could be moved to another household.
    for (const c of ["renter_id", "recorded_by", "amenity_booking_id"]) {
      expect(guard(), `${c} is not one-directional`)
        .toMatch(new RegExp(`new\\.${c} is distinct from old\\.${c} and new\\.${c} is not null`));
    }
  });
});

describe("a stamp is written once and cannot be unsaid", () => {
  const guard = () => fn("park_payment_is_the_row_it_was");

  // The reversal is the one that mattered: an allocation survives a reversal
  // as record, so clearing reversed_at made every bill that cheque had
  // settled read paid again, and nobody would ever be chased for it.
  for (const anchor of ["reversed_at", "returned_on", "returned_at", "renter_confirmed_at"]) {
    it(`guards ${anchor} in the old-is-set direction`, () => {
      expect(guard(), `${anchor} can still be rubbed out`)
        .toMatch(new RegExp(`if old\\.${anchor} is not null then`));
    });
  }

  it("refuses a reason for a reversal that has not happened", () => {
    expect(guard()).toMatch(/elsif new\.reversed_at is null/);
  });
});

describe("a raised bill is the snapshot it claims to be", () => {
  const guard = () => fn("park_charge_is_the_row_it_was");

  it("freezes the lines, the amount and the due day", () => {
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

  it("makes a cancellation final, and complete on the write that makes it", () => {
    const g = guard();
    expect(g, "a cancelled bill could be brought back, claiming its released money twice")
      .toMatch(/old\.status = 'void' and new\.status is distinct from 'void'/);
    expect(g, "a bill could still be cancelled with no date and no reason")
      .toMatch(/new\.voided_at is null or coalesce\(btrim\(new\.void_reason\), ''\) = ''/);
    expect(g, "a cancellation's reason could still be rewritten")
      .toMatch(/if old\.voided_at is not null then/);
  });

  it("keeps paid_total changeable, because it is the one derived column", () => {
    // Freezing it would freeze the ledger: recompute_charge_paid rebuilds it
    // from the payments and allocations on every write that could move it.
    expect(guard()).not.toMatch(/new\.paid_total\s+is distinct from old\.paid_total\s+then '/);
    expect(raw).toMatch(/THE ONLY DERIVED COLUMN HERE/);
  });

  it("makes 'paid' a fact about money rather than a word somebody types", () => {
    const g = guard();
    expect(g).toMatch(/new\.status = 'paid' and new\.paid_total < new\.amount/);
    expect(g).toMatch(/new\.status = 'open' and new\.amount > 0 and new\.paid_total >= new\.amount/);
  });
});

describe("neither a payment nor a bill can be deleted", () => {
  it("has a BEFORE DELETE trigger on each table", () => {
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

describe("an allocation comes off a bill with a reason AND a name", () => {
  const guard = () => fn("guard_park_payment_allocation");

  it("refuses a removal nobody signed", () => {
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

describe("the migration proves itself and leaves nothing behind", () => {
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
