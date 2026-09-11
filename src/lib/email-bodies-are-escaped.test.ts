import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EVERY EMAIL BODY IN THE PRODUCT, NOT THE ONE THAT BIT US.
 *
 * A crew typed "gate is <4ft wide" into a box and the owner's mail client ate
 * the rest of the sentence — including the line saying nothing is charged
 * while they decide. That was ONE body. There are thirty-odd, all assembled by
 * hand, and SIX had already grown their own inline escaper: the same
 * `.replace()` chain, copied six times, complete in none of them — five did
 * `&` `<` `>`, one also did `"`, and not one did `'`.
 *
 * A rule copied into six doorways and finished in none is this codebase's own
 * signature defect, and the answer is never a seventh hand-rolled copy. `html` from
 * lib/html-safe escapes every interpolation by default and `raw()` is the
 * explicit, greppable opt-out.
 *
 * THIS FILE IS THE GUARD ON THAT. It reads the source of every module that
 * sends email and fails on any body that interpolates a value outside the tag.
 * It is a source scan, so it follows the rules this project learned the hard
 * way: strip comments first, match the CALL rather than the mention, and
 * assert the scanner still finds things — a scan that silently stops matching
 * passes forever.
 */

// fileURLToPath, not .pathname — this repo lives under a directory with a
// space in its name, and .pathname hands back "LakeLife%20App%20Docs".
const SRC = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const rel = (p: string) => "src/" + p.slice(SRC.length);

/**
 * COMPOSERS THAT NEVER SAY `html:`.
 *
 * The first version of this scan keyed on `html:` alone and missed two live
 * bodies, because a sender can hand the body over by OBJECT SHORTHAND —
 * `const html = ...; sendEmail({ to, subject, html })` — in which case the
 * string `html:` appears nowhere. One of the two was the homeowner welcome
 * email at signup, with no escaping of any kind on a typed address. Shorthand
 * is a doorway, and this is the project's own "rule in one doorway of three".
 *
 * So the scan covers every module that CALLS sendEmail, plus the modules those
 * callers delegate body-building to. The list below is checked for existence,
 * so a rename cannot silently empty it.
 */
const DELEGATED_COMPOSERS = ["lib/digest-render.ts", "lib/park-invite.ts"];

const senders = walk(SRC)
  .map((p) => ({ path: p, src: strip(readFileSync(p, "utf8")) }))
  .filter(
    (f) =>
      /\bhtml:/.test(f.src) ||
      /\bsendEmail\s*\(/.test(f.src) ||
      DELEGATED_COMPOSERS.some((c) => f.path.endsWith(c)),
  );

/**
 * Each `html:` body — the VALUE EXPRESSION, bounded properly.
 *
 * A fixed-width window past the colon was wrong twice, in both directions this
 * project keeps relearning. It matched `html: string` inside an
 * `interface InviteCopy` type declaration, and for `html: asHtml(body)` it ran
 * on past the end of the call into an unrelated template further down the
 * file. A scan must match the THING, not the mention.
 *
 * So this walks characters: skip whole string and template literals, track
 * bracket depth, and stop at the comma or closing brace that ends the
 * property. Type positions are dropped by the caller.
 */
function bodyAt(src: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "`" || c === '"' || c === "'") {
      i = skipString(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;   // the enclosing object closed
      depth--;
    } else if (c === "," && depth === 0) break;
    i++;
  }
  return src.slice(start, i);
}

/** From an opening quote/backtick, return the index just past the close. */
function skipString(src: string, i: number): number {
  const q = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === q) return i + 1;
    if (q === "`" && c === "$" && src[i + 1] === "{") {
      // A template's ${...} can itself hold strings and braces.
      let d = 0;
      i += 2;
      while (i < src.length) {
        const e = src[i];
        if (e === "`" || e === '"' || e === "'") { i = skipString(src, i); continue; }
        if (e === "{" || e === "(" || e === "[") d++;
        else if (e === "}" ) { if (d === 0) { i++; break; } d--; }
        else if (e === ")" || e === "]") d--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

function bodies(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bhtml:\s*/g)) {
    const body = bodyAt(src, m.index! + m[0].length);
    // A TYPE POSITION, not a value: `interface InviteCopy { html: string }`
    // and sendEmail's own `html: string | RawHtml` parameter.
    if (/^(?:string|RawHtml|\s|\|)+$/.test(body)) continue;
    out.push(body);
  }
  return out;
}

describe("the scanner is reading the real email bodies", () => {
  it("found the modules that send email", () => {
    // Without this every assertion below passes against an empty list.
    expect(senders.length, "no email senders found — the scan is broken").toBeGreaterThanOrEqual(14);
    expect(senders.map((f) => rel(f.path))).toContain("src/lib/automation.ts");
    expect(senders.map((f) => rel(f.path))).toContain("src/lib/email.ts");
  });

  it("found the bodies inside them", () => {
    const n = senders.reduce((s, f) => s + bodies(f.src).length, 0);
    expect(n, "the body scan stopped matching").toBeGreaterThanOrEqual(25);
  });
});

describe("no email body interpolates a value outside the tag", () => {
  it("names every one that still does", () => {
    const violations: string[] = [];
    for (const f of senders) {
      // lib/email.ts is the SENDER, not a composer — it takes an assembled
      // body as a parameter and has no template of its own.
      if (rel(f.path) === "src/lib/email.ts") continue;
      for (const body of bodies(f.src)) {
        if (/^html`/.test(body.trim())) continue;
        // Only a TEMPLATE LITERAL can interpolate. `html: copy.html` and
        // `html: asHtml(body)` hand over a value composed somewhere else —
        // that somewhere else is where the rule applies, and it has its own
        // entry in this scan.
        const literal = body.match(/`[\s\S]*/)?.[0] ?? "";
        if (!/\$\{/.test(literal)) continue;
        violations.push(`${rel(f.path)} — ${literal.trim().slice(0, 88).replace(/\s+/g, " ")}`);
      }
    }
    expect(violations, `email bodies still interpolating outside html\`\`:\n${violations.join("\n")}`)
      .toEqual([]);
  });
});

describe("nobody hand-rolls the escaping any more", () => {
  it("has no inline replace-chain escaper left", () => {
    // Two files carried this, both missing " and '. The tag is the one place
    // the rule lives now.
    const guilty = senders
      .filter((f) => rel(f.path) !== "src/lib/html-safe.ts")
      .filter((f) => /replace\(\/&\/g,\s*["']&amp;["']\)/.test(f.src))
      .map((f) => rel(f.path));
    expect(guilty, "an inline escaper survives").toEqual([]);
  });

  it("does not escape twice by calling emailSafe inside a tagged body", () => {
    // `html` already escapes. A leftover emailSafe inside one renders
    // `&amp;lt;` to the reader.
    const guilty: string[] = [];
    for (const f of senders) {
      for (const body of bodies(f.src)) {
        if (/^html`/.test(body.trim()) && /emailSafe\s*\(/.test(body.split("`,")[0] ?? "")) {
          guilty.push(rel(f.path));
        }
      }
    }
    expect(guilty).toEqual([]);
  });
});


describe("a body handed over by shorthand is still a body", () => {
  it("knows about the composers that never write `html:`", () => {
    // A rename that emptied this list would make the scan below pass by
    // checking nothing.
    for (const c of DELEGATED_COMPOSERS) {
      expect(senders.map((f) => rel(f.path)), `${c} is gone or renamed`)
        .toContain("src/" + c);
    }
  });

  it("finds no unescaped HTML template in any email module", () => {
    // The widened rule: inside a module that sends or composes email, a
    // template literal that contains a real tag AND an interpolation must be
    // tagged. `const html = \`<div>${address}</div>\`` passed to sendEmail by
    // shorthand is exactly what the first version of this scan could not see.
    const violations: string[] = [];
    for (const f of senders) {
      for (let i = 0; i < f.src.length; i++) {
        if (f.src[i] !== "`") continue;
        const end = skipString(f.src, i);
        const body = f.src.slice(i + 1, end - 1);
        const tagged = /(?:\bhtml|\braw\()\s*$/.test(f.src.slice(Math.max(0, i - 6), i));
        if (!tagged && /<[a-zA-Z]+[\s/>]/.test(body) && /\$\{/.test(body)) {
          violations.push(`${rel(f.path)} — ${body.trim().slice(0, 80).replace(/\s+/g, " ")}`);
        }
        i = end - 1;
      }
    }
    expect(violations, `untagged HTML templates in email modules:\n${violations.join("\n")}`)
      .toEqual([]);
  });
});


describe("nowhere in the product hand-rolls HTML escaping any more", () => {
  it("has exactly one copy of the rule, and it is lib/html-safe", () => {
    // TEN copies existed: six in the email path, four more serving web pages —
    // print windows, a crew's printable statement, the token landing pages —
    // covering three, four or five characters depending on which was written
    // first. The two that were COMPLETE were the token pages, whose author
    // knew exactly why ("a 40-char nickname can hold a working XSS payload").
    // Everything now imports the one function.
    const guilty = walk(SRC)
      .filter((p) => !/\.test\.tsx?$/.test(p) && !p.endsWith("lib/html-safe.ts"))
      .filter((p) => /replace\(\/&\/g,\s*["']&amp;["']\)/.test(strip(readFileSync(p, "utf8"))))
      .map(rel);
    expect(guilty, "a hand-rolled HTML escaper came back").toEqual([]);
  });

  it("and the scanner would notice if one did", () => {
    // Proving the scan can still fail: the one real copy must be findable.
    const theOne = strip(readFileSync(join(SRC, "lib/html-safe.ts"), "utf8"));
    expect(theOne, "html-safe no longer contains the escaper itself")
      .toMatch(/replace\(\/&\/g,\s*"&amp;"\)/);
  });
});
