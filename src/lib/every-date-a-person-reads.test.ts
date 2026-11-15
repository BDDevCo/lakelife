import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * EVERY DATE A PERSON READS IS ON THE LAKES' CLOCK.
 *
 * `src/lib/lake-time.ts` is the one home and has been since the September UI
 * sweep. The rule it exists for: never call `toLocaleDateString` without it,
 * because a SERVER page runs in UTC and an evening timestamp then shows
 * tomorrow's date to the person who made it.
 *
 * On 29 Oct a sweep found five timestamps still formatting with no `timeZone`
 * at all — the ops message board, the ops job file, the resident Messages
 * tab, the ops crew board, and `prettyTime` on the PHOTO GALLERY, which
 * stamps the evidence behind the photo gate and so ran on a different clock
 * from the heading directly above it. All five now use `lakeStamp`.
 *
 * ===========================================================================
 * WHAT THIS DOES NOT FLAG, AND WHY
 * ===========================================================================
 *
 * Most date formatting in this repo is correct and deliberately looks like it
 * is not:
 *
 *   `new Date(iso + "T12:00:00")` — the NOON TRICK. A date-only value parsed
 *   at midday cannot shift a day in any US zone, so these are safe without a
 *   timeZone and there are dozens of them.
 *
 *   `Date.UTC(y, m - 1, d)` with `timeZone: "UTC"` — built and read in the
 *   same zone.
 *
 *   Money. `toLocaleString("en-US", { minimumFractionDigits: 2 })` is not a
 *   date, and a scan that does not separate them reports a hundred false
 *   positives — which is what the first version of this scanner did.
 *
 * So the rule enforced here is the narrow, certain one: A TIMESTAMP — a
 * format asking for `hour` or `minute` — must name its zone.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { files(p, out); continue; }
    if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

const stripped = (src: string) =>
  src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (m) => m.replace(/[^\n]/g, " "))
     .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (m) => m.replace(/[^\n]/g, " "))
     .replace(/^\s*\/\/.*$/gm, "");

interface Hit { file: string; line: number }

const timestamps: Hit[] = [];
let scanned = 0;
for (const f of files(SRC)) {
  const rel = f.replace(SRC, "");
  // lake-time IS the home, and email templates render in a fixed zone of
  // their own with literal styles — both are correct as they are.
  if (rel.includes("lake-time") || rel.includes("email")) continue;
  const src = stripped(readFileSync(f, "utf8"));
  for (const m of src.matchAll(/\.toLocale(?:Date|Time)?String\s*\(/g)) {
    scanned += 1;
    // THE OPTIONS OBJECT, bounded by its own closing brace — not a fixed
    // window. A 220-character window after the call spills into the NEXT
    // statement, and flagged `trucks-actions.ts` and `arrival.ts`, both of
    // which are correct: one uses the noon trick and the other is money.
    const after = src.slice(m.index! + m[0].length);
    const close = after.indexOf("}");
    const opts = close === -1 ? "" : after.slice(0, close);
    if (!/hour|minute/.test(opts)) continue;       // not a timestamp
    const near = src.slice(Math.max(0, m.index! - 160), m.index! + 260);
    if (/timeZone/.test(near)) continue;            // names its zone
    if (/Date\.UTC\(/.test(near)) continue;         // built in UTC
    timestamps.push({ file: rel, line: src.slice(0, m.index!).split("\n").length });
  }
}

describe("the scanner is looking at something", () => {
  it("finds plenty of toLocale calls, or everything below is vacuous", () => {
    expect(scanned, "the date scanner matched almost nothing — repoint it").toBeGreaterThan(60);
  });
});

describe("a timestamp names its zone", () => {
  it("NO TIMESTAMP IS FORMATTED IN THE MACHINE'S ZONE", () => {
    expect(
      timestamps.map((h) => `${h.file}:${h.line}`).join("\n"),
      "this renders in whatever zone the machine is set to, and a server page is UTC — " +
      "use lakeStamp() from @/lib/lake-time",
    ).toBe("");
  });

  it("and the five that were wrong on 29 Oct now use the one home", () => {
    for (const f of [
      "app/messages/page.tsx",
      "components/JobPhotoGallery.tsx",
      "components/ops/JobFile.tsx",
      "components/ops/MessageBoard.tsx",
      "components/ops/CrewBoard.tsx",
    ]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src, `${f} no longer imports lakeStamp`).toMatch(/from "@\/lib\/lake-time"/);
      expect(src, `${f} still formats a timestamp itself`).toMatch(/lakeStamp\(/);
    }
  });
});

describe("a raw ISO date never reaches a screen", () => {
  it("the two that did are formatted now", () => {
    // "2026-10-20" on the park owner's Costs tab, and hyphenated rows sitting
    // under week headings written in words on the crew's Earnings screen.
    const costs = readFileSync(join(SRC, "components/ParkCosts.tsx"), "utf8");
    expect(costs, "the Costs tab prints a raw ISO date again").not.toMatch(/>\{j\.date\}</);
    expect(costs).toMatch(/shortDate\(j\.date\)/);

    const earnings = readFileSync(join(SRC, "components/VendorEarnings.tsx"), "utf8");
    expect(earnings, "the earnings rows print a raw ISO date again").not.toMatch(/\{r\.jobDate\}\{/);
    expect(earnings).toMatch(/shortDate\(r\.jobDate\)/);
  });

  it("and jobDate stays an ISO string in the DATA, because it is sorted on", () => {
    // The fix belongs at the render. `earnings-data.ts` sorts and
    // range-filters on this value, so formatting it upstream would break both.
    const data = readFileSync(join(SRC, "app/vendor/earnings-data.ts"), "utf8");
    expect(data).toMatch(/a\.jobDate < b\.jobDate/);
    expect(data, "the data layer started formatting dates").not.toMatch(/shortDate|lakeStamp/);
  });
});
