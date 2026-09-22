import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE DOOR THAT OPENS THE GATE.
 *
 * Public surfaces now advertise a lake only once somebody at LakeLife has said
 * we serve it (lib/lake-visibility.ts). That rule is only safe because there
 * is a control that says it: a gate ops cannot open is worse than no gate at
 * all — the lake would sit unadvertised forever and the only way to promote it
 * would be an UPDATE typed by hand against production.
 *
 * So this pins the door both ways. It opens for ops, on the exact column the
 * predicate reads. It does not open for anybody else, it does not open onto a
 * fixture, and it never claims a lake is gone on the strength of a read that
 * failed.
 */

const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from }),
  createClient: async () => ({ from }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// The heavy neighbours in ops/actions.ts. None of them is on this path; they
// are mocked so a failure here can only be about the promotion.
vi.mock("@/lib/automation", () => ({ runRouteBuild: async () => ({ ok: true }) }));
vi.mock("@/lib/notify", () => ({ notify: async () => {} }));
vi.mock("@/lib/settings", () => ({ getPlatformSettings: async () => ({}) }));

type Ops = { id: string; name: string | null } | null;
let signedIn: Ops = { id: "u-ops", name: "Ops" };
vi.mock("@/app/ops/data", () => ({ assertOps: async () => signedIn }));

const { promoteLakeToServed } = await import("@/app/ops/actions");

interface Row { id: string; name: string; is_fixture: boolean; source: string }

let row: Row | null = null;
let readError: { message: string } | null = null;
let writeError: { message: string } | null = null;
let updates: Array<{ patch: Record<string, unknown>; id: unknown }> = [];
let tablesTouched: string[] = [];

beforeEach(() => {
  signedIn = { id: "u-ops", name: "Ops" };
  row = { id: "lake-1", name: "Adams Lake", is_fixture: false, source: "customer" };
  readError = null;
  writeError = null;
  updates = [];
  tablesTouched = [];
  from.mockImplementation((table: string) => {
    tablesTouched.push(table);
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row, error: readError }) }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: unknown) => {
          updates.push({ patch, id });
          return { error: writeError };
        },
      }),
    };
  });
});

describe("ops can say 'yes, we serve this lake'", () => {
  it("flips the column the predicate reads, on the lake asked for", async () => {
    const res = await promoteLakeToServed("lake-1");
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(updates).toEqual([{ patch: { source: "ops" }, id: "lake-1" }]);
    expect(tablesTouched.every((t) => t === "lakes")).toBe(true);
  });

  it("promotes a crew-born lake the same way", async () => {
    row = { id: "lake-2", name: "Witmer Lake", is_fixture: false, source: "crew" };
    const res = await promoteLakeToServed("lake-2");
    expect(res.ok).toBe(true);
    expect(updates).toEqual([{ patch: { source: "ops" }, id: "lake-2" }]);
  });

  it("says so, and writes nothing, when the lake was already public", async () => {
    // Clicking twice is not an error, but it is not a fresh success either —
    // a second "it's live now" would tell ops a decision was made tonight
    // that was actually made weeks ago.
    row = { id: "lake-1", name: "Adams Lake", is_fixture: false, source: "ops" };
    const res = await promoteLakeToServed("lake-1");
    expect(res.ok).toBe(true);
    expect(res.warning).toContain("already on the public site");
    expect(updates).toEqual([]);
  });
});

describe("and nobody else can", () => {
  it("refuses a caller who is not ops, before any read", async () => {
    signedIn = null;
    const res = await promoteLakeToServed("lake-1");
    expect(res).toEqual({ ok: false, error: "Ops only." });
    expect(updates).toEqual([]);
    expect(tablesTouched).toEqual([]);
  });

  it("refuses a fixture — the two halves of the predicate cannot be split", async () => {
    // A scratch lake promoted to source 'ops' would pass half the predicate
    // and be held out only by `is_fixture`, which is exactly the one-legged
    // fence this whole pass exists to delete.
    row = { id: "lake-3", name: "zz-scratch lake", is_fixture: true, source: "customer" };
    const res = await promoteLakeToServed("lake-3");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("test lake");
    expect(updates).toEqual([]);
  });
});

describe("it never asserts something it could not read", () => {
  it("a failed read is not a missing lake", async () => {
    // "That lake no longer exists" is a claim about a row ops is looking at on
    // their own screen. A dropped connection has no standing to make it, and
    // the natural next move — hunting for a lake that is still there — costs
    // more than being told the read failed.
    row = null;
    readError = { message: "connection reset" };
    const res = await promoteLakeToServed("lake-1");
    expect(res.ok).toBe(false);
    // The shared sentence (readFailedMessage) — it names the failure and says
    // nothing moved. What matters is the sentence it does NOT use.
    expect(res.error).toContain("nothing has been changed");
    expect(res.error).not.toContain("no longer exists");
    expect(updates).toEqual([]);
  });

  it("a genuinely absent row still says so", async () => {
    // The other half: with no error, `null` means the row really is gone, and
    // the honest sentence is the one the failed read must not borrow.
    row = null;
    readError = null;
    const res = await promoteLakeToServed("lake-1");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no longer exists");
    expect(updates).toEqual([]);
  });

  it("a failed write is not a promotion", async () => {
    writeError = { message: "permission denied for table lakes" };
    const res = await promoteLakeToServed("lake-1");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("permission denied");
  });
});
