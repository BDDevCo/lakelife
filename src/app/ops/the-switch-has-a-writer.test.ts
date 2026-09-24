/**
 * THE SWITCH HAS A WRITER, AND IT IS THE ONLY ONE.
 *
 * `services.crew_priced` shipped in 0174 and, until this build, nothing in the
 * product wrote it: a column read by nine doorways and written by nothing
 * enforces nothing and can be MOVED by nobody. This file pins the three facts
 * that make the writer real, plus the one that must stay true on the day it
 * ships — that no service is switched on by code, a migration or a fixture.
 *
 * COMMENTS ARE STRIPPED before anything is scanned, so a sentence describing
 * the rule can never stand in for the rule. The scanner asserts it can still
 * find things first, so a renamed file reads as a failure rather than a pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
// The SIX models the SQL arm has to list. Imported rather than retyped, so a
// model added to the TypeScript and forgotten in the migration fails here
// instead of on the day a seventh pricing model ships.
import { MODELS_A_CARD_CAN_PRICE } from "@/lib/crew-priced-eligibility";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const WRITER = "./crew-priced-actions.ts";
const CONTROL = "../../components/ops/CrewPricedServices.tsx";
const CARD = "../../components/ops/PlatformSettingsCard.tsx";
const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

describe("the scanner reads what it thinks it reads", () => {
  it("finds the writer, the control and the card", () => {
    expect(code(WRITER)).toContain("setServiceCrewPriced");
    expect(code(CONTROL)).toContain("CrewPricedServices");
    expect(code(CARD)).toContain("PlatformSettingsCard");
  });

  it("strips comments — a rule stated in prose does not count as a rule", () => {
    expect(src(WRITER)).toContain("ONE SERVICE, ONE DIRECTION");
    expect(code(WRITER)).not.toContain("ONE SERVICE, ONE DIRECTION");
  });
});

describe("the writer", () => {
  const writer = code(WRITER);

  it("is ops-gated before it touches anything", () => {
    expect(writer).toContain("assertOps");
    // The gate is the FIRST thing in the flip, ahead of every read and write.
    const fn = writer.slice(writer.indexOf("export async function setServiceCrewPriced"));
    expect(fn.indexOf("assertOps")).toBeLessThan(fn.indexOf("createServiceClient"));
    expect(fn.indexOf("assertOps")).toBeLessThan(fn.indexOf("crew_priced: on"));
  });

  it("writes crew_priced through the service client, one service at a time", () => {
    const fn = writer.slice(writer.indexOf("export async function setServiceCrewPriced"));
    expect(fn).toContain('.update({ crew_priced: on })');
    // `.eq("id", serviceId)` is what makes it one service. A write without it
    // would be the bulk switch he deliberately did not ask for.
    expect(fn).toContain('.eq("id", serviceId)');
  });

  it("re-checks the shape against the LIVE row, not against what the screen showed", () => {
    const fn = writer.slice(writer.indexOf("export async function setServiceCrewPriced"));
    expect(fn).toContain("crewCardCanPrice");
    // Read first, judge the row that came back, then write.
    expect(fn.indexOf("crewCardCanPrice")).toBeGreaterThan(fn.indexOf('.from("services").select'));
    expect(fn.indexOf("crewCardCanPrice")).toBeLessThan(fn.indexOf(".update({ crew_priced"));
  });

  it("records the change in the log the migration creates", () => {
    expect(writer).toContain("service_pricing_changes");
    expect(writer).toContain("changed_by");
  });

  it("offers no bulk door", () => {
    // Every exported flip takes a single service id. A signature taking an
    // array is the shape of "turn everything on".
    expect(writer).toMatch(/export async function setServiceCrewPriced\(serviceId: string, on: boolean\)/);
    expect(writer).not.toMatch(/serviceIds\s*:\s*string\[\]/);
  });

  it("a failed read never renders as a confident empty answer", () => {
    const reader = writer.slice(writer.indexOf("export async function getCrewPricedServices"));
    for (const probe of ["svcRes.error", "crewsRes.error", "jobsRes.error", "ratesFailed"]) {
      expect(reader, probe).toContain(probe);
    }
  });

  it("reads EVERY park, because parks.active is not a kill switch", () => {
    const reader = writer.slice(writer.indexOf("export async function getCrewPricedServices"));
    const parks = reader.slice(reader.indexOf('.from("parks")'));
    // The Haven is inactive and still holds the mow rate 21 leases sign
    // against. Filtering here would print nothing about park work at all,
    // which reads as "no park is affected".
    expect(parks.slice(0, 80)).toContain('.select("id, name")');
    expect(parks.slice(0, 80)).not.toContain('.eq("active", true)');
  });

  it("counts only ACTIVE, NON-FIXTURE crews, joined through the owner", () => {
    const reader = writer.slice(writer.indexOf("export async function getCrewPricedServices"));
    expect(reader).toContain("users!vendors_user_id_fkey!inner(is_fixture)");
    expect(reader).toContain('.eq("users.is_fixture", false)');
    expect(reader).toContain('.eq("status", "active")');
    // Row existence is not a rate — a card of zeroes can price nothing.
    expect(reader).toContain("hasRealRate");
  });

  it("refuses a service the preview never showed him", () => {
    // THE TWO DOORWAYS MUST AGREE ABOUT WHICH SERVICES EXIST. The reader
    // lists `.eq("active", true)` — 16 of 28 rows. Without this guard an id
    // for one of the 12 INACTIVE services flips cleanly: `Winter storage —
    // indoor` passes crewCardCanPrice and would go crew-priced with no
    // preview rendered and no consequence line read, surfacing only when
    // somebody activated it.
    const fn = writer.slice(writer.indexOf("export async function setServiceCrewPriced"));
    expect(fn).toMatch(/svc\.active\s*!==\s*true/);
    // And it refuses BEFORE the update, not after it.
    expect(fn.indexOf("svc.active")).toBeLessThan(fn.indexOf(".update({ crew_priced"));
  });

  it("refuses to flip anything while the change log is unreadable", () => {
    // The screen prints "Nothing can be switched until it reads" and draws no
    // button — a promise only the SCREEN kept. Called directly, with 0179
    // unapplied and its CHECK therefore also absent, the flip succeeded and
    // returned ok:true with a warning. Copy asserting a guarantee its writer
    // does not enforce is the bug class.
    const fn = writer.slice(writer.indexOf("export async function setServiceCrewPriced"));
    const probe = fn.indexOf('.from("service_pricing_changes").select');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(fn.indexOf(".update({ crew_priced"));
  });
});

describe("the control is mounted where the other pricing dials are", () => {
  it("the platform settings card renders it", () => {
    const card = code(CARD);
    expect(card).toContain("CrewPricedServices");
    expect(card).toContain("<CrewPricedServices />");
  });

  it("it does not draw a switch while the change log is missing", () => {
    const control = code(CONTROL);
    expect(control).toContain("logReady");
    expect(control).toContain("state.logReady === true");
  });

  it("a refused service prints its reason instead of quietly having no button", () => {
    const control = code(CONTROL);
    expect(control).toContain("row.verdict.reason");
    expect(control).toContain("!row.verdict.ok");
  });

  it("the park sentence is drawn for a REFUSED service too", () => {
    // It sat inside the `verdict.ok` branch, so a refused service a park buys
    // said nothing at all about park work — and on this card silence about a
    // park reads as "no park is affected". Neither refused service is park
    // work today, so this costs nothing now and is right when one is.
    const control = code(CONTROL);
    const start = control.indexOf("{row.verdict.ok && (");
    // The consequence list is the whole of that branch; it ends at its </ul>.
    const okBranch = control.slice(start, control.indexOf("</ul>", start));
    expect(okBranch, "parkLine is back inside the verdict.ok branch").not.toContain("row.parkLine");
    expect(control).toContain("row.parkLine");
  });
});

describe("0179's CHECK is the third doorway, and it carries the WHOLE rule", () => {
  // Comments stripped: the claim "mirrors crewCardCanPrice" is prose, and
  // prose is exactly what was true while an arm was missing.
  const sql = readFileSync(`${MIGRATIONS}/0179_the_switch_gets_a_writer.sql`, "utf8").replace(/--.*$/gm, "");
  const check = sql.slice(
    sql.indexOf("add constraint services_crew_priced_needs_a_card_that_can_price"),
    sql.indexOf("comment on constraint services_crew_priced_needs_a_card_that_can_price"),
  );

  it("reads the constraint it thinks it reads", () => {
    expect(check).toContain("crew_priced");
    expect(check.length).toBeGreaterThan(100);
  });

  it("carries all THREE arms of crewCardCanPrice, including the one that cannot fire yet", () => {
    // 1. the model must be one computeRateRow has a branch for. This arm was
    //    missing while the file's comment claimed a line-for-line mirror —
    //    code and comment agreeing and both wrong about what is enforced. It
    //    exists for the SEVENTH pricing model, which would otherwise land in
    //    a database that accepts it and a TypeScript layer that refuses it.
    for (const model of MODELS_A_CARD_CAN_PRICE) expect(check, model).toContain(`'${model}'`);
    // 2. the size word, and 3. the terms a card drops.
    expect(check).toContain("pricing_model <> 'band'");
    expect(check).toContain("'add'");
    expect(check).toContain("'per_engine_hp_tiers'");
  });

  it("guards jsonb_array_length with a CASE, never coalesce and never a bare and", () => {
    // `jsonb_array_length` RAISES 22023 on a non-array, so coalesce does not
    // make it total; and Postgres does not promise to short-circuit `and`, so
    // a typeof test to its left is not a guard either. `case` is the only
    // construct that will not evaluate the branch it did not take.
    expect(sql).not.toMatch(/coalesce\s*\(\s*jsonb_array_length/i);
    expect(check).toMatch(/case when jsonb_typeof\(band_pricing -> 'add'\) = 'array'/);
    expect(check).toMatch(/case when jsonb_typeof\(band_pricing -> 'per_engine_hp_tiers'\) = 'array'/);
    expect(check).not.toMatch(/jsonb_typeof\([^)]*\) = 'array'\s*\n?\s*and jsonb_array_length/);
  });

  it("proves both new arms, and that the predicate is two-valued", () => {
    // A constraint that refuses everything passes every refusal probe, and a
    // predicate that answers NULL passes as a CHECK by accident while
    // matching nothing as a filter — which would have aborted the migration
    // claiming the CHECK refused the entire menu.
    expect(sql).toContain("per_engine_hp_tiers");
    expect(sql).toMatch(/is null;\s*\n\s*if n <> 0 then/);
    expect(sql).toContain("the shape predicate answers NULL");
    expect(sql).toContain("a malformed add term refused a flip the TypeScript allows");
  });
});

describe("nothing flips a service on", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));

  it("reads the migration folder it thinks it reads", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("0179_the_switch_gets_a_writer.sql");
  });

  it("no migration sets crew_priced true outside a post-condition block that rolls back", () => {
    for (const f of files) {
      // Comments go; string literals STAY, because the post-condition marker
      // this test looks for is itself a string literal.
      const sql = readFileSync(`${MIGRATIONS}/${f}`, "utf8").replace(/--.*$/gm, "");
      const sets = sql.match(/set\s+crew_priced\s*=\s*true/gi) ?? [];
      if (sets.length === 0) continue;
      // The only permitted occurrences are inside a `do $$ ... $$` block that
      // ends in ROLLBACK_POSTCONDITION, which is how 0174, 0176 and 0179 prove
      // their constraints bite without leaving a pricing change behind.
      expect(sql, f).toContain("ROLLBACK_POSTCONDITION");
    }
  });

  it("no code path writes crew_priced true as a literal", () => {
    // The ONE writer takes a boolean argument. A `crew_priced: true` anywhere
    // is a service switched on by a deploy rather than by him.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      );
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const offenders = walk(root)
      .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))
      .filter((p) => {
        const body = readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        return /crew_priced\s*:\s*true/.test(body);
      });
    expect(offenders).toEqual([]);
  });
});
