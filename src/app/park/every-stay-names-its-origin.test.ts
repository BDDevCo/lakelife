import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY DOOR THAT WRITES A TENANCY SAYS WHERE IT CAME FROM.
 *
 * `lot_reservations.origin` defaults to 'application' — the value the fee
 * rule reads as "agreed to the fee with us" and the 0065 cap trigger reads as
 * "bound by the cap". The rent roll's "Someone lives here" door wrote no
 * origin at all, so the household the filing screen turned away (no email)
 * was filed there by omission as having signed a lease, and billed $142.53 a
 * month she never agreed to on a one-month window that then expired.
 *
 * A column default is a door that files by omission. This scan guards the
 * third door without a DDL change: every `.from("lot_reservations").insert(`
 * in src must name `origin` in the row it writes — either as a key in the
 * object literal, or by inserting a `successorRow(...)` plan, whose type
 * makes `origin` a required key (see the companion assertion below).
 *
 * SQL booking functions rely on the column default and are out of scope.
 */

const ROOT = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Comments stripped, so a `// origin: ...` remark can never satisfy the scan. */
function code(p: string): string {
  return readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The text between the `(` at `open` and its matching `)`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

interface Insert { file: string; arg: string }

function findInserts(): Insert[] {
  const out: Insert[] = [];
  for (const file of walk(ROOT)) {
    const src = code(file);
    const re = /\.from\("lot_reservations"\)\s*\.insert\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1;
      out.push({ file: file.slice(ROOT.length + 1), arg: balanced(src, open) });
    }
  }
  return out;
}

function namesOrigin(ins: Insert, src: string): boolean {
  const arg = ins.arg.trim();
  // An object literal that names the column.
  if (arg.startsWith("{")) return /(^|[\s,{])origin\s*:/.test(arg);
  // A successor plan: `successorRow(...)` itself, or a value that carries one.
  // Its row type makes `origin` a required key, checked below.
  const importsSuccessor = /from\s+"@\/lib\/successor-row"/.test(src);
  return importsSuccessor && /successor/i.test(arg);
}

describe("every lot_reservations insert names its origin", () => {
  const inserts = findInserts();

  it("still finds the doors — a scan that finds nothing proves nothing", () => {
    // The importer, the filing screen, the rent-roll door, the public
    // application, the owner's renewal, the resident's extension, and the
    // signing door. Fewer than five means the scanner stopped seeing them.
    expect(inserts.length).toBeGreaterThanOrEqual(5);
    const files = inserts.map((i) => i.file);
    expect(files).toContain("app/park/actions.ts");
    expect(files).toContain("app/park/onboard-actions.ts");
    expect(files).toContain("app/park/sign-actions.ts");
  });

  it("names `origin` in every one of them", () => {
    const silent = inserts
      .filter((ins) => !namesOrigin(ins, code(join(ROOT, ins.file))))
      .map((ins) => `${ins.file}: .insert(${ins.arg.trim().slice(0, 60)}…)`);
    expect(silent, "these inserts file by the column default").toEqual([]);
  });

  it("a successor plan cannot omit it either — the row type requires the key", () => {
    const row = code(join(ROOT, "lib", "successor-row.ts"));
    const iface = row.match(/export interface SuccessorRow \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(iface, "SuccessorRow is gone — the successor branch above is unguarded").not.toBe("");
    expect(iface).toMatch(/\n\s*origin:\s*"office"\s*\|\s*"application";/);
    expect(iface).not.toMatch(/origin\?:/);
  });

  it("would catch the door that was silent — the scanner sees a literal with no origin", () => {
    // The shape actions.ts wrote until now, verbatim: no origin key.
    const silent: Insert = {
      file: "x.ts",
      arg: `{
        park_lot_id: lotId,
        renter_id: renter.id,
        during: toDaterange({ start, end }),
        term: built.tenancy.term,
        quoted_amount: built.tenancy.quoted_amount,
        tenancy_began_on: built.tenancy.beganOn,
        status: "active",
      }`,
    };
    expect(namesOrigin(silent, "")).toBe(false);
    // And a comment naming it does not count.
    expect(namesOrigin({ file: "x.ts", arg: `{ status: "active" }` }, "")).toBe(false);
    // A value called `row` with no successor import does not count.
    expect(namesOrigin({ file: "x.ts", arg: "row" }, "")).toBe(false);
  });
});
