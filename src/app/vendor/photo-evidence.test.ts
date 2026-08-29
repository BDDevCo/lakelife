import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * A CUSTODY PHOTO HAS TO SURVIVE AN ARGUMENT SIX MONTHS LATER.
 *
 * Before 0146 `job_photos` was four columns — id, job_id, url, taken_at — and
 * `taken_at` was the moment our server INSERTed the row, not the moment the
 * shutter fired. No author, no hash, no subject. Three unattributed images was
 * the whole record standing between the platform and a gelcoat claim.
 *
 * These are source scans because `uploadJobPhoto` is a server action that
 * needs a session, a storage bucket and a live job. What can break is the
 * SHAPE — a field quietly dropped from the insert, or an author lookup
 * promoted into something that can refuse a photo.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const uploadFn = () => {
  const src = code("src/app/vendor/actions.ts");
  const fn = src.match(/export async function uploadJobPhoto[\s\S]*?\n}/)?.[0] ?? "";
  expect(fn.length, "uploadJobPhoto not found — this scan is measuring nothing")
    .toBeGreaterThan(800);
  return fn;
};

describe("every photo is written as evidence", () => {
  it("carries all four evidence fields onto the row", () => {
    const fn = uploadFn();
    const insert = fn.match(/\.from\("job_photos"\)\.insert\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(insert, "the job_photos insert was not found").not.toBe("");
    for (const field of ["slot", "sha256", "taken_by", "device_time"]) {
      expect(insert, `${field} is not written — a column with no writer`)
        .toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it("hashes the bytes that were actually stored", () => {
    const fn = uploadFn();
    // Hashing the File a second time, or hashing after a transform, would
    // produce a digest that does not match the object in the bucket.
    expect(fn).toMatch(/createHash\("sha256"\)\.update\(bytes\)\.digest\("hex"\)/);
    const hash = fn.indexOf("createHash");
    const upload = fn.indexOf('storage.from("job-photos").upload');
    expect(upload, "no upload found — scan is stale").toBeGreaterThan(-1);
    expect(hash, "hash the same buffer that gets uploaded").toBeLessThan(upload);
  });

  it("takes the device time from the file, never from the clock", () => {
    const fn = uploadFn();
    // `device_time` exists precisely so it CAN disagree with taken_at. Setting
    // it from the server clock would make it a duplicate of taken_at wearing
    // a name that claims more.
    expect(fn).toMatch(/file\.lastModified/);
    const dt = fn.match(/const deviceTime =[\s\S]*?;/)?.[0] ?? "";
    expect(dt, "deviceTime derivation not found").not.toBe("");
    expect(dt, "device time must not come from Date.now()").not.toMatch(/Date\.now\(\)/);
    expect(dt, "a zero or NaN lastModified must become null, not 1970")
      .toMatch(/Number\.isFinite/);
  });

  it("refuses a junk slot rather than storing it", () => {
    const fn = uploadFn();
    // A typo'd slot is worse than none: the screen would show a gap where a
    // photo actually exists.
    const slot = fn.match(/const slot =[\s\S]*?;/)?.[0] ?? "";
    expect(slot, "slot derivation not found").not.toBe("");
    expect(slot, "blank must become null").toMatch(/\.trim\(\)/);
    expect(slot, "an unbounded string must not reach the column").toMatch(/\.slice\(0,\s*\d+\)/);
  });
});

describe("attribution never costs a crew their photo", () => {
  it("wraps the author lookup so a failed session cannot refuse the upload", () => {
    const fn = uploadFn();
    // Must reach THROUGH the catch. `\n  }` alone stops at the `} catch {`
    // line, capturing only the try — which is how this test first passed
    // against a mutation that made a failed session refuse the upload.
    const block = fn.match(/let takenBy[\s\S]*?catch \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(block, "the takenBy block was not found").not.toBe("");
    expect(block, "the scan must reach past `} catch {`").toMatch(/catch \{/);
    expect(block, "the session read must be caught").toMatch(/try \{/);
    expect(block, "and the catch must not refuse the upload")
      .not.toMatch(/return \{\s*ok:\s*false/);
  });

  it("still uploads when there is no author", () => {
    const fn = uploadFn();
    // takenBy starts null and stays null on failure — the insert proceeds.
    expect(fn).toMatch(/let takenBy: string \| null = null/);
    const takenBy = fn.indexOf("let takenBy");
    const insert = fn.indexOf('.from("job_photos").insert');
    expect(insert, "no insert found — scan is stale").toBeGreaterThan(-1);
    expect(takenBy, "attribution is resolved before the row is written")
      .toBeLessThan(insert);
  });
});

describe("the shot list is data, not code", () => {
  const sql = () => read("supabase/migrations/0146_a_photo_that_can_win_an_argument.sql");

  it("lives on services, so a new custody service needs no deploy", () => {
    expect(sql()).toMatch(/alter table public\.services[\s\S]*?required_photo_slots text\[\]/);
  });

  it("defaults to empty, so no existing service silently gains a checklist", () => {
    expect(sql()).toMatch(/required_photo_slots text\[\] not null default '\{\}'/);
  });

  it("leaves the evidence columns nullable — six rows predate them", () => {
    const sqlText = sql();
    const alter = sqlText.match(/alter table public\.job_photos[\s\S]*?;/)?.[0] ?? "";
    expect(alter, "the job_photos alter was not found").not.toBe("");
    expect(alter, "a NOT NULL here would refuse the rows already in the table")
      .not.toMatch(/not null/i);
  });

  it("asserts every custody service got a list and a matching count", () => {
    const sqlText = sql();
    expect(sqlText, "the post-condition that gives this migration its teeth")
      .toMatch(/custody services with no shot list/);
    expect(sqlText).toMatch(/min_photos does not match the shot list/);
  });

  it("does not add a slot-completeness gate", () => {
    // Deliberate: there is no offline support in the vendor app, so a slot
    // gate would strand a crew with no signal at a barn door. The header says
    // so; this test stops it arriving by accident before that changes.
    const sqlText = sql();
    expect(sqlText, "0146 must not create a trigger")
      .not.toMatch(/create (or replace )?trigger/i);
    expect(sqlText, "and must say why enforcement was left out")
      .toMatch(/offline/i);
  });
});

describe("the hash is a real one", () => {
  it("is a plain sha256 of the bytes, reproducible outside the app", () => {
    // If a dispute ever turns on this, somebody has to be able to recompute it
    // from the file with a standard tool. No salt, no encoding tricks.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
  });
});
