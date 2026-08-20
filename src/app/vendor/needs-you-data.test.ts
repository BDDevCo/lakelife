import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The two questions this card exists to answer correctly:
 *   1. Is a dispute on ANOTHER crew's job invisible here? (scoping)
 *   2. When a read fails, does it refuse to say "nothing needs you"?
 *
 * Both are load-bearing. (1) leaks one crew's trouble to another. (2) is the
 * bug class this whole sweep was about: a failed read rendering as the calmest
 * sentence on the page.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/settings", () => ({
  getPlatformSettings: vi.fn(async () => ({ lakeDemotionCooldownDays: 30 })),
}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { disputes: [], jobs: [], vendor_lake_demotions: [] };
/** Tables set here resolve to {data:null,error} — a FAILED read, not an empty one. */
const failing = new Set<string>();

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    const res = failing.has(this.t)
      ? { data: null, error: { message: "connection reset" } }
      : { data: (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))), error: null };
    return Promise.resolve(res).then(ok, bad);
  }
}
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { getNeedsYou } = await import("./needs-you-data");
const { ReadFailed } = await import("@/lib/must-read");

const MINE = "vendor-mine";
const THEIRS = "vendor-theirs";

beforeEach(() => {
  db.disputes = [];
  db.jobs = [];
  db.vendor_lake_demotions = [];
  failing.clear();
});

describe("getNeedsYou — held jobs", () => {
  it("shows this crew's held job with its deadline and its links", async () => {
    db.disputes = [{ id: "d1", job_id: "j1", status: "crew_review", respond_by: "2026-08-20T17:00:00Z", crew_token: "tok1", resolved_at: null }];
    db.jobs = [{ id: "j1", vendor_id: MINE, services: { name: "Weekly mow" }, properties: { nickname: "Blue Heron", address: "12 Shore Rd" } }];
    const out = await getNeedsYou(MINE);
    expect(out.held).toHaveLength(1);
    expect(out.held[0]).toMatchObject({ service: "Weekly mow", where: "Blue Heron", respondBy: "2026-08-20T17:00:00Z", token: "tok1" });
  });

  it("does NOT show a dispute on another crew's job", async () => {
    db.disputes = [{ id: "d2", job_id: "j2", status: "crew_review", respond_by: null, crew_token: "tok2", resolved_at: null }];
    db.jobs = [{ id: "j2", vendor_id: THEIRS, services: { name: "Pier removal" }, properties: { address: "9 Cove Ln" } }];
    const out = await getNeedsYou(MINE);
    expect(out.held).toEqual([]);
  });

  it("sorts the soonest deadline first, and a dispute with no clock last", async () => {
    db.disputes = [
      { id: "a", job_id: "j1", status: "talk", respond_by: null, crew_token: "t", resolved_at: null },
      { id: "b", job_id: "j2", status: "fixing", respond_by: "2026-08-25T00:00:00Z", crew_token: "t", resolved_at: null },
      { id: "c", job_id: "j3", status: "crew_review", respond_by: "2026-08-21T00:00:00Z", crew_token: "t", resolved_at: null },
    ];
    db.jobs = ["j1", "j2", "j3"].map((id) => ({ id, vendor_id: MINE, services: null, properties: null }));
    const out = await getNeedsYou(MINE);
    expect(out.held.map((h) => h.disputeId)).toEqual(["c", "b", "a"]);
  });

  it("leaves out a resolved dispute and a status the crew can't act on", async () => {
    db.disputes = [
      { id: "done", job_id: "j1", status: "crew_review", respond_by: null, crew_token: "t", resolved_at: "2026-08-01T00:00:00Z" },
      { id: "ops", job_id: "j1", status: "escalated", respond_by: null, crew_token: "t", resolved_at: null },
    ];
    db.jobs = [{ id: "j1", vendor_id: MINE, services: null, properties: null }];
    expect((await getNeedsYou(MINE)).held).toEqual([]);
  });

  it("falls back to the address when a property has no nickname", async () => {
    db.disputes = [{ id: "d", job_id: "j1", status: "verifying", respond_by: null, crew_token: "t", resolved_at: null }];
    db.jobs = [{ id: "j1", vendor_id: MINE, services: null, properties: { nickname: "", address: "9 Cove Ln" } }];
    expect((await getNeedsYou(MINE)).held[0].where).toBe("9 Cove Ln");
  });
});

describe("getNeedsYou — paused lakes", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");
  beforeEach(() => vi.setSystemTime(new Date(now)));

  it("shows a lake still inside its cooldown, with the date it lifts", async () => {
    db.vendor_lake_demotions = [{ lake_id: "L1", vendor_id: MINE, demoted_at: "2026-08-05T00:00:00Z", lakes: { name: "Big Long" } }];
    const out = await getNeedsYou(MINE);
    expect(out.pausedLakes).toEqual([{ lake: "Big Long", liftsOn: "2026-09-04" }]);
  });

  it("drops a demotion whose 30 days are already up", async () => {
    db.vendor_lake_demotions = [{ lake_id: "L1", vendor_id: MINE, demoted_at: "2026-06-01T00:00:00Z", lakes: { name: "Pretty" } }];
    expect((await getNeedsYou(MINE)).pausedLakes).toEqual([]);
  });
});

describe("a failed read never renders as 'nothing needs you'", () => {
  it("throws when the dispute read fails", async () => {
    failing.add("disputes");
    await expect(getNeedsYou(MINE)).rejects.toBeInstanceOf(ReadFailed);
  });

  it("throws when the lake-standing read fails", async () => {
    failing.add("vendor_lake_demotions");
    await expect(getNeedsYou(MINE)).rejects.toBeInstanceOf(ReadFailed);
  });

  it("throws when the job read behind a real dispute fails", async () => {
    db.disputes = [{ id: "d", job_id: "j1", status: "crew_review", respond_by: null, crew_token: "t", resolved_at: null }];
    failing.add("jobs");
    await expect(getNeedsYou(MINE)).rejects.toBeInstanceOf(ReadFailed);
  });

  it("is quiet — and cheap — for a crew with nothing waiting", async () => {
    const out = await getNeedsYou(MINE);
    expect(out).toEqual({ held: [], pausedLakes: [] });
  });

  it("returns empty without touching the database for a non-vendor", async () => {
    failing.add("disputes");
    failing.add("vendor_lake_demotions");
    expect(await getNeedsYou(null)).toEqual({ held: [], pausedLakes: [] });
  });
});
