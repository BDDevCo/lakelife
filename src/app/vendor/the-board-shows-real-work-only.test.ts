import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OWNER_FIXTURE_EMBED, OWNER_FIXTURE_FILTER } from "@/lib/lake-pages";

/**
 * THE FENCE THAT ONLY EVER RAN ONE WAY.
 *
 * "A fixture crew must never be routed real work" is enforced in five pools —
 * the routing candidates, the calendar, the rush broadcast, the payout batch,
 * the coverage card. The mirror image had nobody guarding it: the claim board
 * listed every open job whoever booked it, and the claim action re-gated on
 * capacity, insurance, lake standing and custody but never on whether the
 * customer was real. So the first real crew on the platform could be shown —
 * and could claim, and could drive to — a booking that exists only to rehearse
 * the software.
 *
 * A SOURCE SCAN, because the defect is a filter that is absent: there is no
 * behaviour to observe in a missing WHERE clause without a live Postgres
 * carrying a fixture owner, a real crew, and an open job.
 */
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
/** Comments stripped — a fence that exists only in prose fences nothing. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/ [^"'`\n]*$/gm, "");

const openData = code("./open-data.ts");
const openActions = code("./open-actions.ts");

describe("the files this scan reads", () => {
  it("found both, with their comments gone", () => {
    expect(openData.length).toBeGreaterThan(2000);
    expect(openActions.length).toBeGreaterThan(2000);
    expect(openData).toContain("getOpenJobs");
    expect(openActions).toContain("claimJob");
    // The prose that describes the fence must not be what the scan matches.
    expect(openData).not.toContain("THE FENCE THAT ONLY EVER RAN ONE WAY");
  });
});

describe("the board hides a test booking from a real crew", () => {
  const board = () => {
    const at = openData.indexOf("const board = admin");
    const until = openData.indexOf("BOARD_CAP),");
    expect(at, "the open-jobs query moved — this scan is measuring nothing").toBeGreaterThan(-1);
    expect(until).toBeGreaterThan(at);
    return openData.slice(at, until);
  };

  it("embeds the owner and filters on it", () => {
    const q = board();
    // The constants are interpolated, so the scan looks for the NAMES — and
    // checks the pair they resolve to is still the owner-derived one.
    expect(q).toContain("${OWNER_FIXTURE_EMBED}");
    expect(q).toContain("OWNER_FIXTURE_FILTER");
    expect(OWNER_FIXTURE_EMBED).toContain("properties_owner_id_fkey");
    expect(OWNER_FIXTURE_EMBED).toContain("is_fixture");
    expect(OWNER_FIXTURE_FILTER).toBe("properties.users.is_fixture");
  });

  it("uses the shared pair rather than a second hand-written string", () => {
    // The FK is already named in lake-pages; a retyped embed is free to drift,
    // and `properties` reaches `users` only through owner_id.
    expect(openData).toMatch(/import \{ OWNER_FIXTURE_EMBED, OWNER_FIXTURE_FILTER \} from "@\/lib\/lake-pages";/);
    expect(openData).not.toMatch(/"users!properties_owner_id_fkey/);
  });

  it("runs the filter only for a crew who is not a test account", () => {
    // Directional on purpose: this board is the last path by which the owner's
    // three test crews can take a job at all, and closing it would leave no way
    // to walk claim → complete → payout before the first real crew arrives.
    expect(board()).toMatch(/iAmFixture \? board : board\.eq\(OWNER_FIXTURE_FILTER, false\)/);
    expect(openData).toContain("users!vendors_user_id_fkey!inner(is_fixture)");
  });

  it("and a dropped read of that fact is not read as 'real'", () => {
    // mustRead throws; swallowing it would switch the fence ON for a test crew
    // and empty the board they rehearse on.
    const at = openData.indexOf("const me = mustRead(");
    expect(at, "the viewer's own fixture flag is not read through mustRead").toBeGreaterThan(-1);
    expect(at).toBeLessThan(openData.indexOf("const board = admin"));
  });
});

describe("and the claim refuses it — the action is the boundary, not the board", () => {
  const claim = () => {
    const fn = openActions.slice(
      openActions.indexOf("export async function claimJob"),
      openActions.indexOf("export async function", openActions.indexOf("export async function claimJob") + 10),
    );
    expect(fn.length, "claimJob not found — the scan is measuring nothing").toBeGreaterThan(2000);
    return fn;
  };

  it("reads the job owner's fixture flag and the viewer's own", () => {
    const fn = claim();
    expect(fn).toContain("jobOwner");
    expect(fn).toContain("iAmFixture");
    expect(openActions).toContain("users(phone, email, is_fixture)");
  });

  it("refuses before anything is written", () => {
    const fn = claim();
    const guard = fn.indexOf("if (!iAmFixture && jobOwner?.is_fixture)");
    const write = fn.indexOf(".update({ vendor_id: vendor.id");
    expect(guard, "no owner guard on the claim at all").toBeGreaterThan(-1);
    expect(write, "the guarded claim UPDATE moved — this scan is stale").toBeGreaterThan(-1);
    expect(guard, "the guard must sit in front of the claim").toBeLessThan(write);
  });

  it("names the reason instead of borrowing 'already taken'", () => {
    // "That job was already taken" walks a crew away from work, and it would
    // be false here — nobody took it, it was never real.
    const fn = claim();
    const at = fn.indexOf("if (!iAmFixture && jobOwner?.is_fixture)");
    const line = fn.slice(at, at + 400);
    expect(line).toContain("test booking");
    expect(line).not.toContain("already taken");
  });
});
