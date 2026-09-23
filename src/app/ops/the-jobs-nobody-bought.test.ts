import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE OPS CONSOLE REPORTED THREE JOBS NOBODY BOUGHT.
 *
 * Production holds exactly three jobs. All three are GreenEdge Lawn Co. — a
 * fixture crew — working for a fixture household, and one of them is a pier
 * install at $95, below the menu's own base. The KPI strip summed them into
 * "3 jobs · $339 revenue · $115 margin · 33.9%", Revenue & margin printed them
 * as service lines, and Margin health printed 32.8% and 36.8% in healthy teal
 * beside a red 0 under "Ready crews" — a column that HAD been fenced. The two
 * halves of one row were asking different questions about who is real.
 *
 * Nine crew doorways already fence these accounts by joining the owner's
 * `users.is_fixture`. The money reads did not. Both panels' own empty state,
 * "No priced jobs yet", is the true sentence those three rows were suppressing.
 *
 * The job BOARD is deliberately not fenced — ops has to be able to work a
 * scratch job — so it carries the label instead, and the last describe block
 * pins that split so a later reader cannot "finish" the fence and blind ops.
 */

const LAKE_TODAY = "2026-08-19"; // a Wednesday — the week runs Mon 17th → Sun 23rd

vi.mock("server-only", () => ({}));
vi.mock("@/lib/booking", () => ({
  todayLakeDate: () => LAKE_TODAY,
  effectiveSeason: () => ({ iceOut: null, pullDeadline: null, rolled: false }),
  seasonIsProvisional: () => false,
}));
vi.mock("@/lib/settings", () => ({
  getPlatformSettings: vi.fn(async () => ({ marginFloor: 0.2 })),
}));
vi.mock("@/lib/dispatch", () => ({
  marginPct: (price: number, cost: number) => (price > 0 ? (price - cost) / price : 0),
}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { jobs: [], refunds: [] };

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  gte(c: string, v: string) { this.fs.push((r) => String(r[c] ?? "") >= v); return this; }
  lte(c: string, v: string) { this.fs.push((r) => String(r[c] ?? "") <= v); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, op: string, v: unknown) {
    if (op === "is" && v === null) this.fs.push((r) => r[c] != null);
    else this.fs.push((r) => r[c] !== v);
    return this;
  }
  or() { return this; }
  order() { return this; }
  limit() { return this; }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; count?: number | null; error: null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const rows = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    return Promise.resolve({ data: rows, count: null, error: null }).then(ok, bad);
  }
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => new Q(t) }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { getOpsSummary, getMarginByService, getJobBoard, jobIsFixture } = await import("./data");

/** A user embed, the shape supabase-js hands back off a nested relation. */
const user = (isFixture: boolean) => ({ is_fixture: isFixture });

/**
 * One priced job, $500 with $150 of LakeLife margin, both ends real people.
 * `crew` / `household` flip an end to one of our own accounts.
 */
const job = (
  id: string,
  over: { crew?: boolean; household?: boolean } & Row = {},
): Row => {
  const { crew = false, household = false, ...rest } = over;
  return {
    id,
    status: "complete",
    date: "2026-08-18",
    customer_price: 500,
    vendor_cost: 350,
    margin: 150,
    services: { name: "Weekly mow" },
    vendors: { company: "GreenEdge", users: user(crew) },
    properties: { address: "1 Lake Rd", lakes: { name: "Big Long" }, users: { name: "Mike", is_fixture: household } },
    ...rest,
  };
};

beforeEach(() => {
  db.jobs = [];
  db.refunds = [];
});

describe("the predicate itself", () => {
  it("is true when EITHER end is an account we invented", () => {
    expect(jobIsFixture({ vendors: { users: user(true) }, properties: { users: user(false) } })).toBe(true);
    expect(jobIsFixture({ vendors: { users: user(false) }, properties: { users: user(true) } })).toBe(true);
    expect(jobIsFixture({ vendors: { users: user(true) }, properties: { users: user(true) } })).toBe(true);
  });

  it("is false when both ends are real people — the branch collapses both ways", () => {
    expect(jobIsFixture({ vendors: { users: user(false) }, properties: { users: user(false) } })).toBe(false);
  });

  it("reads an ABSENT embed as absent, never as a fixture", () => {
    // A requested job with no crew yet is the normal state of the thing these
    // boards exist to show. `!== true` here would delete real waiting demand.
    expect(jobIsFixture({ vendors: null, properties: { users: user(false) } })).toBe(false);
    expect(jobIsFixture({})).toBe(false);
  });

  it("takes the embed as an array too — supabase-js returns either", () => {
    expect(jobIsFixture({ properties: [{ users: [user(true)] }] })).toBe(true);
    expect(jobIsFixture({ properties: [{ users: [user(false)] }] })).toBe(false);
  });
});

describe("the KPI strip counts only work real people bought", () => {
  it("leaves out a job whose CREW is one of our accounts", async () => {
    db.jobs = [job("real"), job("scratch", { crew: true })];
    const s = await getOpsSummary();
    expect(s.jobsThisWeek).toBe(1);
    expect(s.weekRevenue).toBe(500);
    expect(s.weekMargin).toBe(150);
  });

  it("leaves out a job whose HOUSEHOLD is one of our accounts", async () => {
    db.jobs = [job("real"), job("scratch", { household: true })];
    const s = await getOpsSummary();
    expect(s.jobsThisWeek).toBe(1);
    expect(s.weekRevenue).toBe(500);
  });

  it("COLLAPSED: the same three rows with both ends real count all three", async () => {
    // The branch pinned in the other direction. If the filter were deleted the
    // two cases above would read 2 and 2 — this one would still read 3, so it
    // is the pair that pins it, not either alone.
    db.jobs = [job("a"), job("b"), job("c")];
    const s = await getOpsSummary();
    expect(s.jobsThisWeek).toBe(3);
    expect(s.weekRevenue).toBe(1500);
  });

  it("says nothing is waiting when the only request is ours", async () => {
    db.jobs = [job("r1", { status: "requested", date: null, crew: true })];
    expect((await getOpsSummary()).requestsWaiting).toBe(0);
  });

  it("still counts a real request that has no crew on it yet", async () => {
    // The whole point of the board. An unassigned job has a null `vendors`
    // embed, and an `!inner` join would have silently deleted it.
    db.jobs = [job("r1", { status: "requested", date: null, vendors: null })];
    expect((await getOpsSummary()).requestsWaiting).toBe(1);
  });
});

describe("revenue & margin by service line counts the same rows", () => {
  it("drops the invented work and keeps the real line", async () => {
    db.jobs = [
      job("real"),
      job("scratch-crew", { crew: true }),
      job("scratch-home", { household: true, services: { name: "Pier install" }, customer_price: 95 }),
    ];
    const { rows, total } = await getMarginByService();
    expect(rows.map((r) => r.service_name)).toEqual(["Weekly mow"]);
    expect(total.jobs).toBe(1);
    expect(total.customer_total).toBe(500);
  });

  it("COLLAPSED: with both ends real, all three lines come back", async () => {
    db.jobs = [
      job("a"),
      job("b"),
      job("c", { services: { name: "Pier install" }, customer_price: 95 }),
    ];
    const { rows, total } = await getMarginByService();
    expect(rows.map((r) => r.service_name).sort()).toEqual(["Pier install", "Weekly mow"]);
    expect(total.jobs).toBe(3);
  });

  it("empties completely when every job is ours — which is production today", async () => {
    db.jobs = [job("a", { crew: true }), job("b", { crew: true }), job("c", { crew: true })];
    const { rows, total } = await getMarginByService();
    // rows.length === 0 is what makes MarginTable print its own true sentence,
    // "No priced jobs yet" — and what makes its footer omit a percentage.
    expect(rows).toHaveLength(0);
    expect(total.jobs).toBe(0);
  });
});

describe("the job BOARD keeps the scratch rows and labels them", () => {
  it("still lists a job both of whose ends are ours", async () => {
    db.jobs = [job("real"), job("scratch", { crew: true, household: true })];
    const board = await getJobBoard();
    expect(board.map((j) => j.id).sort()).toEqual(["real", "scratch"]);
  });

  it("carries the label — a fence here would blind the only person who can clear one", async () => {
    db.jobs = [job("real"), job("scratch", { household: true })];
    const board = await getJobBoard();
    expect(board.find((j) => j.id === "scratch")?.is_fixture).toBe(true);
    expect(board.find((j) => j.id === "real")?.is_fixture).toBe(false);
  });
});

describe("the fence is in every money doorway of this file", () => {
  const path = fileURLToPath(new URL("./data.ts", import.meta.url));
  const raw = readFileSync(path, "utf8");
  /** Comments stripped — a rule that only exists in prose enforces nothing,
   *  and the file above quotes `jobIsFixture` in its own comments. */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const bodies = (() => {
    const marks = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)]
      .map((m) => ({ name: m[1], at: m.index ?? 0 }));
    return marks.map((m, i) => ({ name: m.name, body: src.slice(m.at, marks[i + 1]?.at ?? src.length) }));
  })();

  /** Functions that read `jobs` and then sum or count them into a figure. */
  const reporters = bodies.filter(
    (b) =>
      /from\("jobs"\)/.test(b.body) &&
      b.body.split("\n").some((l) => /(\+=|\.reduce\(|\.length)/.test(l)),
  );

  it("finds the reports it is watching — the scan is not passing on an empty string", () => {
    expect(src.length).toBeGreaterThan(5000);
    const names = reporters.map((r) => r.name);
    expect(names).toContain("getOpsSummary");
    expect(names).toContain("getMarginByService");
    expect(names).toContain("computeMarginHealthRows");
    expect(names).toContain("getJobBoard");
  });

  it("every aggregate applies the ONE predicate, by name", () => {
    for (const r of reporters) {
      if (r.name === "getJobBoard") continue; // labelled instead — pinned below
      expect(
        /jobIsFixture\(/.test(r.body),
        `${r.name} aggregates job rows without applying the fixture fence`,
      ).toBe(true);
    }
  });

  it("and selects the columns the predicate reads — the comparison without the column is this repo's most repeated bug", () => {
    for (const r of reporters) {
      expect(r.body, `${r.name} asks about the crew's owner without selecting it`).toMatch(
        /users!vendors_user_id_fkey\([^)]*is_fixture|CREW_FIXTURE_EMBED|JOB_FIXTURE_EMBED/,
      );
      expect(r.body, `${r.name} never reaches the household's own account`).toMatch(
        // `users(` with no relation hint is the PROPERTY's owner; the crew's
        // owner is always reached through `users!vendors_user_id_fkey(`.
        /users\([^()]*is_fixture|OWNER_FIXTURE_EMBED|JOB_FIXTURE_EMBED/,
      );
    }
  });

  it("the margin board's two job reads are both in there", () => {
    // Named directly, so deleting the loop above cannot make this pass by
    // finding nothing to check. Its vendors read was fenced long ago; these
    // are the money half that was still open beside it.
    const health = reporters.find((r) => r.name === "computeMarginHealthRows");
    expect(health).toBeDefined();
    expect(health!.body.split('from("jobs")').length - 1).toBe(2);
    expect(health!.body.split("jobIsFixture(").length - 1).toBe(2);
  });

  it("the job board is the one read that does NOT filter, and says why", () => {
    const board = reporters.find((r) => r.name === "getJobBoard");
    expect(board!.body).not.toMatch(/filter\([^)]*jobIsFixture/);
    expect(board!.body).toContain("is_fixture: jobIsFixture(r)");
    // The reason has to survive in the file, or the next reader "finishes" the
    // fence and ops loses the only screen that can clear a scratch job.
    expect(raw).toMatch(/NOT APPLIED TO THE JOB BOARD/);
  });
});
