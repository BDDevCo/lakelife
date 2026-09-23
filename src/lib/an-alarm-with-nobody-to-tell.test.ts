import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AN ALARM WITH NOBODY TO TELL MUST NOT LOOK LIKE A QUIET NIGHT.
 *
 * Two doors in the automation rail picked an audience, found it empty, and
 * returned the shape of a clean run.
 *
 * (A) THE NIGHTLY DIGEST. Everything the machine did or noticed — the money
 *     that moved, the steps that died, the crews nobody warned — rides out in
 *     one email to `users where role = 'ops'`. Every way that send can FAIL
 *     already reports itself. An EMPTY audience did not: the loop never ran,
 *     and { ok: true, sent: 0, skipped: [] } is byte-identical to "sent to
 *     everybody". Production holds exactly one account with role 'ops'.
 *
 * (B) THE GAP-SLA VALVE. It read ops `.not("phone","is",null)` and then handed
 *     each row to notify(), which sends on both doors and counts either as
 *     reaching somebody — so an ops account with a working email and no mobile
 *     was outside the audience entirely, and an empty audience returned
 *     { alerted: 0 }, which is also what a night with nothing stranded
 *     returns. The 555 number on the only real ops account is unroutable; the
 *     obvious hygiene of clearing it would have switched the valve off for
 *     good with every screen looking healthy.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ queued: true })) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/payments-server", () => ({ LakeLifePaymentsServer: { charge: vi.fn(async () => ({ ok: true, ref: "ref_test" })) } }));
vi.mock("@/app/book/dispatch", () => ({
  revalidateJob: vi.fn(async () => ({ rehomed: false, nowAssigned: false })),
  autoAssignJob: vi.fn(async () => null),
  loadPricingProfileById: vi.fn(async () => null),
}));
vi.mock("@/app/vendor/onboarding-helpers", () => ({ coiRevalidationDue: () => false }));
vi.mock("@/app/requests/offer-data", () => ({ computeScarcityOffer: vi.fn(async () => null) }));
vi.mock("@/app/ops/data", () => ({ computeMenuSuggestions: vi.fn(async () => []) }));
vi.mock("@/lib/menu-core", () => ({ executeMenuUpdate: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/settings", () => ({
  getPlatformSettings: vi.fn(async () => ({
    referralMaturationDays: 30,
    waitlistWarningDays: 2,
    sameDayCutoffHour: 12,
    nudgeCreditThreshold: 50,
    nudgeCooldownDays: 30,
    lakeDemotionCooldownDays: 30,
    gapSlaHours: 24,
  })),
}));

/** Every notify() call, with the doors it was given — the audience, in full. */
const told: { what: string; to: { phone?: string | null; email?: string | null } }[] = [];
vi.mock("@/lib/notify", () => ({
  notify: vi.fn(async (what: string, to: { phone?: string | null; email?: string | null }) => {
    told.push({ what, to });
    return { reached: true, bySms: true, byEmail: true };
  }),
}));

// ---------------------------------------------------------------------------
// A fake Supabase, same shape as the one in the-nightly-says-what-it-found:
// rows live in a map by table name, embeds sit on the row under the embedded
// table's name, and a dotted filter walks into them.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const table = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};
const get = (row: Row, col: string): unknown =>
  col.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Row)[k] : undefined), row);

interface Filter { kind: "eq" | "in" | "is" | "not_is" | "gte" | "lte"; col: string; val: unknown }
const matches = (row: Row, f: Filter): boolean => {
  const v = get(row, f.col);
  switch (f.kind) {
    case "eq": return v === f.val;
    case "in": return (f.val as unknown[]).includes(v);
    case "is": return v == null;
    case "not_is": return v != null;
    case "gte": return String(v) >= String(f.val);
    case "lte": return String(v) <= String(f.val);
  }
};

type Result = { data: Row[] | Row | null; error: { message: string } | null; count?: number };
class Query implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private wantSingle = false;
  private headCount = false;
  private inserting: Row[] | null = null;
  constructor(private name: string) {}
  select(_cols?: string, opts?: { head?: boolean }) { if (opts?.head) this.headCount = true; return this; }
  insert(rows: Row | Row[]) { this.inserting = Array.isArray(rows) ? rows : [rows]; return this; }
  update() { return this; }
  eq(col: string, val: unknown) { this.filters.push({ kind: "eq", col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ kind: "in", col, val }); return this; }
  is(col: string) { this.filters.push({ kind: "is", col, val: null }); return this; }
  not(col: string) { this.filters.push({ kind: "not_is", col, val: null }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ kind: "gte", col, val }); return this; }
  lte(col: string, val: unknown) { this.filters.push({ kind: "lte", col, val }); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }
  private run(): Result {
    if (this.inserting) {
      const rows = this.inserting.map((r, i) => ({ id: `${this.name}-${table(this.name).length + i + 1}`, sent_at: new Date().toISOString(), ...r }));
      table(this.name).push(...rows);
      return { data: rows, error: null };
    }
    const hit = table(this.name).filter((r) => this.filters.every((f) => matches(r, f)));
    if (this.headCount) return { data: null, error: null, count: hit.length };
    return { data: this.wantSingle ? hit[0] ?? null : hit, error: null };
  }
  then<A, B>(res?: ((v: Result) => A | PromiseLike<A>) | null, rej?: ((r: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(res, rej);
  }
}
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (name: string) => new Query(name) }) }));

const { sendNightlyDigest, gapSlaAlerts } = await import("@/lib/automation");
const { sendEmail } = await import("@/lib/email");

/** The slice of the digest's input that every one of these calls passes. */
const nothingHappened = {
  learning: { changes: [] },
  autoPricing: { changes: [] },
  disputeSweep: { fired: 0, escalated: 0 },
  routes: {},
  gapSla: { alerted: 0 },
};

beforeEach(() => {
  db.clear();
  told.length = 0;
  vi.mocked(sendEmail).mockClear();
});

// ===========================================================================
// (A) the digest
// ===========================================================================
describe("the nightly digest says when it reached nobody", () => {
  it("with no ops account at all, it does not report a clean send", async () => {
    const res = await sendNightlyDigest(nothingHappened);

    expect(sendEmail, "there was nobody to send to").not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
    expect(res.skipped, "and the night must not vanish").toHaveLength(1);
    expect(res.skipped[0]).toMatch(/reached nobody/i);
    expect(res.skipped[0]).toMatch(/role 'ops'/);
  });

  it("with the one ops account flipped to owner, the same", async () => {
    table("users").push({ id: "u1", role: "owner", email: "him@lakelife.test" });

    const res = await sendNightlyDigest(nothingHappened);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(res.skipped[0]).toMatch(/reached nobody/i);
  });

  it("with an ops account whose email is a blank string, the same", async () => {
    // `.not("email","is",null)` passes '' happily and the loop's own
    // `if (!email) continue` then drops the recipient in total silence. That
    // is the identical defect one branch over, which is why the guard counts
    // what was SENT rather than how many rows came back.
    table("users").push({ id: "u1", role: "ops", email: "" });

    const res = await sendNightlyDigest(nothingHappened);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
    expect(res.skipped[0]).toMatch(/reached nobody/i);
  });

  it("CONTRAST — one real ops account, and the list stays empty", async () => {
    table("users").push({ id: "u1", role: "ops", email: "ops@lakelife.test" });

    const res = await sendNightlyDigest(nothingHappened);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(1);
    expect(res.skipped, "a night that landed says nothing").toEqual([]);
  });

  it("CONTRAST — a refused send says which address, and says it once", async () => {
    table("users").push({ id: "u1", role: "ops", email: "ops@lakelife.test" });
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: false, error: "Resend 422: domain not verified" });

    const res = await sendNightlyDigest(nothingHappened);
    expect(res.sent).toBe(0);
    expect(res.skipped, "the bounce is one sentence, not two").toHaveLength(1);
    expect(res.skipped[0]).toContain("ops@lakelife.test");
    expect(res.skipped[0]).not.toMatch(/reached nobody/i);
  });
});

// ===========================================================================
// (B) the gap-SLA valve
// ===========================================================================
const strandedJob = () => {
  table("jobs").push({
    id: "j-stranded",
    date: "2099-01-01",
    created_at: "2020-01-01T00:00:00.000Z", // long past any SLA window
    status: "requested",
    vendor_id: null,
    group_id: null,
    services: { name: "Pier install", is_water_work: true },
    properties: { address: "1 Shore Rd", lakes: { name: "Big Long", pull_deadline: "2099-11-14" } },
  });
};

describe("the stranded-job valve alerts everyone it can reach, and says when that is nobody", () => {
  it("an ops account with an email and no mobile IS the audience", async () => {
    strandedJob();
    table("users").push({ id: "u1", role: "ops", phone: null, email: "ops@lakelife.test" });

    const res = await gapSlaAlerts();
    expect(res.alerted, "notify() treats email as a door; the audience must too").toBe(1);
    expect(told).toHaveLength(1);
    expect(told[0].to).toMatchObject({ phone: null, email: "ops@lakelife.test" });
    expect(res.skipped).toEqual([]);
  });

  it("CONTRAST — an ops account with a mobile and no email is still the audience", async () => {
    strandedJob();
    table("users").push({ id: "u1", role: "ops", phone: "+12605551213", email: null });

    const res = await gapSlaAlerts();
    expect(res.alerted).toBe(1);
    expect(told[0].to).toMatchObject({ phone: "+12605551213", email: null });
  });

  it("an ops account with NEITHER door is nobody, and that is not a quiet night", async () => {
    strandedJob();
    table("users").push({ id: "u1", role: "ops", phone: null, email: null });

    const res = await gapSlaAlerts();
    expect(told, "there was no door to try").toEqual([]);
    expect(res.alerted).toBe(0);
    expect(res.skipped, "'nobody to alert' must not read as 'nothing was stranded'").toHaveLength(1);
    expect(res.skipped[0]).toMatch(/no ops account we can reach/i);
    // It must never invent a count of jobs it never looked at.
    expect(res.skipped[0]).not.toMatch(/\d+ job/);
  });

  it("CONTRAST — no ops row at all says the same thing, and a healthy night says nothing", async () => {
    strandedJob();
    const empty = await gapSlaAlerts();
    expect(empty.skipped[0]).toMatch(/no ops account we can reach/i);

    db.clear();
    told.length = 0;
    table("users").push({ id: "u1", role: "ops", phone: null, email: "ops@lakelife.test" });
    const quiet = await gapSlaAlerts();
    expect(quiet, "nothing stranded, somebody to tell: silence").toMatchObject({ alerted: 0, skipped: [] });
  });
});
