import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assignmentIsLive, LIVE_ASSIGNMENT_STATUSES } from "./job-view";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * RULE 3: A GATE CODE IS VISIBLE ONLY ON THE DAY OF THAT CREW'S OWN JOB.
 *
 * Cancelling a job does NOT clear jobs.vendor_id — it is read afterwards to pay
 * the crew their slot share — so a cancelled job keeps coming back for that
 * crew. getVendorDay read vendor_jobs with no status filter and gated the code
 * on `date === today` alone, so a pier removal the homeowner cancelled on
 * Thursday handed that crew the plaintext door code all day Friday, on a route
 * card captioned "Shown only today, for this job".
 *
 * The guard existed — in job-detail-data.ts, with the comment "Only a live
 * assignment opens the door" — and was never pushed into the shared source both
 * lanes read. Same shape as the "every Friday" copy bug. So it is now ONE
 * exported predicate and both lanes call it.
 */
describe("assignmentIsLive", () => {
  it("is true only while the job is really the crew's to work", () => {
    for (const s of ["scheduled", "in_progress", "complete", "paid"]) {
      expect(assignmentIsLive(s), s).toBe(true);
    }
  });

  it("is false for cancelled — the case that leaked the code", () => {
    expect(assignmentIsLive("cancelled")).toBe(false);
  });

  it("is false for a job not yet assigned, and for nothing at all", () => {
    expect(assignmentIsLive("requested")).toBe(false);
    expect(assignmentIsLive(null)).toBe(false);
    expect(assignmentIsLive(undefined)).toBe(false);
    expect(assignmentIsLive("")).toBe(false);
  });

  it("has exactly the four statuses — widening it reopens the leak", () => {
    expect([...LIVE_ASSIGNMENT_STATUSES]).toEqual(["scheduled", "in_progress", "complete", "paid"]);
  });
});

describe("both lanes that render a gate code use the shared predicate", () => {
  it("the route card gates the code on it", () => {
    const d = code(read("../app/vendor/data.ts"));
    expect(d).toMatch(/date === today && assignmentIsLive\(/);
  });

  it("and does not even decrypt for a job that is not live", () => {
    // Not decrypting beats decrypting and then declining to render.
    const d = code(read("../app/vendor/data.ts"));
    expect(d).toMatch(/rows\.filter\(\(r\) => assignmentIsLive\(/);
  });

  it("the job page uses the same predicate, not its own copy", () => {
    const j = code(read("../app/vendor/job-detail-data.ts"));
    expect(j).toMatch(/assignmentIsLive\(job\.status as string\)/);
    expect(j).not.toMatch(/\["scheduled", "in_progress", "complete", "paid"\]/);
  });
});

/**
 * A VISIT CANNOT BE CLOSED OUT BEFORE ITS DAY — either way round.
 *
 * completeJob refuses it. recordNoShow, the sibling that closes the same visit
 * the other way, did not — and it releases money, because the nightly funds a
 * $35 trip fee per attempt row.
 */
describe("recordNoShow cannot close out a future visit", () => {
  const src = code(read("../app/vendor/actions.ts"));
  const at = src.indexOf("export async function recordNoShow");
  const body = src.slice(at, src.indexOf("\nexport ", at + 10));

  it("refuses a job dated after today", () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toMatch(/job\.date && String\(job\.date\) > todayLakeDate\(\)/);
  });

  it("still allows recording yesterday's no-show this morning", () => {
    // One-directional on purpose. An equality test would refuse a crew writing
    // up last night's trip, which is legitimate and common.
    expect(body).not.toMatch(/String\(job\.date\) !== todayLakeDate\(\)/);
    expect(body).not.toMatch(/job\.date === todayLakeDate\(\)/);
  });

  it("matches the guard completeJob has, so the two cannot drift", () => {
    const done = src.slice(src.indexOf("export async function completeJob"));
    expect(done).toMatch(/String\(job\.date\) > todayLakeDate\(\)/);
  });
});

describe("closing out a visit is a claim, not a read", () => {
  const src = code(read("../app/vendor/actions.ts"));
  const at = src.indexOf("export async function recordNoShow");
  const body = src.slice(at, src.indexOf("\nexport ", at + 10));

  it("the jobs UPDATE carries the predicate that makes it the lock", () => {
    expect(body).toMatch(/\.is\("no_show_at", null\)/);
    expect(body).toMatch(/\.select\("id"\)/);
  });

  it("the loser takes its own attempt row back out", () => {
    // Otherwise the nightly funds a second $35 trip for one visit.
    expect(body).toMatch(/from\("job_visit_attempts"\)\.delete\(\)\.eq\("id", attemptRes\.data\.id\)/);
  });

  it("the attempt is still written FIRST", () => {
    // 0089's trigger refuses to clear no_show_at without an attempt row, so
    // claiming the job first and then failing to insert would strand a visit
    // nobody could reschedule.
    expect(body.indexOf('from("job_visit_attempts").insert')).toBeLessThan(body.indexOf('.is("no_show_at", null)'));
  });
});

describe("declining a flag is a claim, not a read", () => {
  const src = code(read("../app/approvals/actions.ts"));
  const at = src.indexOf("export async function declineFlag");
  const body = src.slice(at, src.length);

  it("the status flip carries a status predicate", () => {
    expect(body).toMatch(/\.update\(\{ status: "declined" \}\)[\s\S]{0,120}\.eq\("status", "pending"\)/);
  });

  it("and a losing caller stops before the work underneath", () => {
    const claim = body.indexOf('.eq("status", "pending")');
    const bail = body.indexOf('Already decided.', claim);
    const attempt = body.indexOf('job_visit_attempts');
    expect(bail).toBeGreaterThan(claim);
    expect(bail).toBeLessThan(attempt);
  });

  it("approveFlag's RPC still claims the same way, which is the model", () => {
    expect(src).toMatch(/apply_flag_change/);
  });
});
