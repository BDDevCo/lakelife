import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * A SERVER ACTION NOBODY CALLS IS A FEATURE THAT DOES NOT EXIST.
 *
 * ============================================================================
 * WHERE THIS CAME FROM
 * ============================================================================
 * 0158 gave a returned ACH payout somewhere to land, and
 * `markBatchesReturned` was written to record one: it flips the batch to
 * 'failed', writes the bank's reason, and — the half that is actually money —
 * clears `batch_id` on the crew's payouts so the next run can pay them again.
 * It had its own test file. Every assertion passed.
 *
 * No screen called it. `PayoutQueue.tsx` imported `markBatchesPaid` and
 * nothing else, so there was no button, and a crew whose bank details were
 * wrong by one digit stayed unpayable through any path in the product. The
 * migration was applied, the action was correct, the suite was green, and the
 * behaviour did not exist.
 *
 * This is the project's dominant defect class in its third shape: not a column
 * with no writer, not a column with no reader, but a SYMBOL WITH NO CALLER.
 * A unit test cannot see it, because a unit test is itself a caller.
 *
 * ============================================================================
 * WHY A PINNED LIST RATHER THAN A BARE ASSERTION
 * ============================================================================
 * Thirteen actions are dormant today. Demanding zero would mean either
 * deleting features somebody may still want or wiring up ten screens nobody
 * asked for, so this ratchets instead: the set is pinned, a NEW orphan fails,
 * and an entry that gets wired must be REMOVED from the list — so it can only
 * ever shrink, and it cannot quietly become a suppression file.
 *
 * The list is documentation, not an excuse. Three entries are understood.
 * The other ten are simply dormant and named here so the next person can see
 * them at all, which is more than was true before.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..");

/**
 * KNOWN DORMANT. Removing one from this list is how you record that it now
 * has a caller; adding one is a decision, not a formality.
 */
const KNOWN_DORMANT: Record<string, string> = {
  // VERIFIED HARMLESS — a thin wrapper whose real work is wired elsewhere.
  createBooking:
    "single-date wrapper over createBookingBatch, which the booking screens do call",
  applyDueRentChanges:
    "wrapper over applyDueRentChangesFor, which the nightly cron and ledger-actions both call",
  previewRenewal: "called by another function inside renew-actions.ts",

  // DORMANT, NOT INVESTIGATED. Nothing anywhere references these. Each one is
  // a screen that was never built or a screen that stopped calling it; which,
  // per action, is unknown. Named here so they are visible.
  getJobWorkers: "no reference anywhere",
  lastWorkersAtProperty: "no reference anywhere",
  listLakes: "no reference anywhere",
  loadNotifStates: "no reference anywhere",
  logRequestForLot: "no reference anywhere",
  ownerReminderDigest: "no reference anywhere",
  printableNotices: "no reference anywhere",
  removeOrphan: "no reference anywhere",
  resolvePeriod: "no reference anywhere",
  todayForPark: "no reference anywhere",
};

/** Comments do not call anything. A name in prose is exactly how a dead
 *  action looks alive — several of these are discussed at length in comments
 *  in files that never invoke them. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const source = new Map(files.map((p) => [p, readFileSync(p, "utf8")]));
const stripped = new Map(files.map((p) => [p, stripComments(source.get(p)!)]));

/** Every exported async function in a "use server" file. */
const actions: Array<{ file: string; name: string }> = [];
for (const [p, s] of source) {
  if (/\.test\.tsx?$/.test(p)) continue;
  const head = s.slice(0, 400);
  if (!head.includes('"use server"') && !head.includes("'use server'")) continue;
  for (const m of s.matchAll(/^export async function (\w+)/gm)) {
    actions.push({ file: p, name: m[1] });
  }
}

function hasCallerOutsideItsOwnFile(name: string, own: string): boolean {
  const re = new RegExp(`\\b${name}\\b`);
  for (const [p, s] of stripped) {
    if (p === own) continue;
    if (/\.test\.tsx?$/.test(p)) continue; // a test is not a user
    if (re.test(s)) return true;
  }
  return false;
}

const orphans = actions
  .filter((a) => !hasCallerOutsideItsOwnFile(a.name, a.file))
  .map((a) => a.name)
  .sort();

describe("the scanner works before it judges anything", () => {
  it("found the app's server actions", () => {
    // If this collapses to a handful, the "use server" detection has broken
    // and every assertion below is green against nearly nothing.
    expect(actions.length, "almost no server actions found — this scan is measuring nothing")
      .toBeGreaterThan(150);
  });

  it("does not mistake a wired action for a dead one", () => {
    // markBatchesPaid is called from PayoutQueue.tsx. If the caller search is
    // broken, it lands in `orphans` and the whole test becomes noise.
    expect(orphans).not.toContain("markBatchesPaid");
    expect(orphans).not.toContain("markBatchesReturned");
  });

  it("counts a call and not a mention", () => {
    // A LIVE PROOF THAT STRIPPING IS LOAD-BEARING, not an assertion that it
    // was written. `applyDueRentChanges` appears in park/ledger-actions.ts
    // exactly once — inside a comment on line 316 — and nowhere else outside
    // its own file. (The nearby `applyDueRentChangesFor` calls do not match:
    // there is no word boundary before "For".)
    //
    // So: visible in the raw file, absent from the stripped one, and therefore
    // still an orphan. Delete stripComments and this action reads as called,
    // the ratchet silently loosens, and this goes red.
    const ledger = [...source.keys()].find((p) => p.endsWith("park/ledger-actions.ts"));
    expect(ledger, "park/ledger-actions.ts moved — repoint this proof").toBeTruthy();

    const word = /\bapplyDueRentChanges\b/;
    expect(word.test(source.get(ledger!)!), "the comment this proof relies on is gone").toBe(true);
    expect(word.test(stripped.get(ledger!)!), "stripComments is not removing comments").toBe(false);
    expect(orphans, "a name mentioned only in prose was counted as a caller")
      .toContain("applyDueRentChanges");
  });
});

describe("no server action is stranded without a caller", () => {
  it("has not grown a new one", () => {
    const unexpected = orphans.filter((n) => !(n in KNOWN_DORMANT));
    expect(
      unexpected,
      `These server actions have no caller anywhere, so the behaviour they implement ` +
        `cannot happen. Either wire one up to a screen or a route, or add it to ` +
        `KNOWN_DORMANT with a note saying why it is asleep.`,
    ).toEqual([]);
  });

  it("has no stale entry claiming to be dormant", () => {
    // The list can only shrink. An action that gets a caller must come off it,
    // or the list slowly turns into a place where dead code is parked.
    const stale = Object.keys(KNOWN_DORMANT).filter((n) => !orphans.includes(n));
    expect(
      stale,
      `These are listed as dormant but now have callers. Delete them from ` +
        `KNOWN_DORMANT — the list is a record of what is asleep, not a permanent exemption.`,
    ).toEqual([]);
  });
});
