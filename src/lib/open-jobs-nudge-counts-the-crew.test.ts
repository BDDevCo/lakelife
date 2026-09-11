import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE OPEN-JOBS NUDGE COUNTS THE CREW, NOT THE MARKETPLACE.
 *
 * revalidateAssignments texts every active, insured crew that does one of the
 * open services: "N open jobs up for grabs near you — first crew to claim gets
 * it". N was `unfilledIds.length` — every unfilled job across every trade — so
 * a mow-only crew with one mow and two pier jobs open was told "3 open jobs"
 * and then shown ONE on /vendor/open, which filters by the crew's own service
 * list (open-data.ts). The number a crew reads must be the number of jobs on
 * THEIR board.
 *
 * WHO is texted is unchanged and asserted here too: service overlap and a
 * current COI decide it; lakes are deliberately not a factor.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ queued: true })) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/payments-server", () => ({ LakeLifePaymentsServer: { charge: vi.fn(async () => ({ ok: true, ref: "ref_test" })) } }));
vi.mock("@/app/book/dispatch", () => ({
  // Every job the sweep touches stays unfilled — that is the state the nudge exists for.
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
  })),
}));

/** Every message the runner tried to send, by recipient. */
type Sent = { what: string; to: { phone?: string | null; email?: string | null }; msg: { sms: string; subject: string; body?: string } };
const sent: Sent[] = [];
vi.mock("@/lib/notify", () => ({
  notify: vi.fn(async (what: string, to: Sent["to"], msg: Sent["msg"]) => {
    sent.push({ what, to, msg });
    return { reached: true, bySms: true, byEmail: true };
  }),
}));

// ---------------------------------------------------------------------------
// A fake Supabase just wide enough for revalidateAssignments' reads. Embeds
// (`services(name)`, `users!...(is_fixture)`) are stored on the row under the
// table name, and a dotted filter column (`users.is_fixture`) walks into them.
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

class Query implements PromiseLike<{ data: Row[] | Row | null; error: null }> {
  private filters: Filter[] = [];
  private wantSingle = false;
  constructor(private name: string) {}
  select() { return this; }
  // The dead-end alarm now claims a nudge_log row before it sends, so a fake
  // with no insert() throws inside the first case (2 pier jobs, no pier crew
  // — a genuine dead end). Rows land in the fake table so the claim "wins".
  insert(rows: Row | Row[]) {
    table(this.name).push(...(Array.isArray(rows) ? rows : [rows]).map((r) => ({ sent_at: new Date().toISOString(), ...r })));
    return this;
  }
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
  then<A, B>(res?: ((v: { data: Row[] | Row | null; error: null }) => A | PromiseLike<A>) | null, rej?: ((r: unknown) => B | PromiseLike<B>) | null) {
    const hit = table(this.name).filter((r) => this.filters.every((f) => matches(r, f)));
    return Promise.resolve({ data: this.wantSingle ? hit[0] ?? null : hit, error: null }).then(res, rej);
  }
}
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (name: string) => new Query(name) }) }));

const { revalidateAssignments } = await import("@/lib/automation");

const DATE = "2026-09-20";
const MOW = "Lawn mowing & trim";
const PIER = "Pier install";

const seedJob = (id: string, service: string, opts: { groupId?: string | null } = {}) =>
  table("jobs").push({ id, date: DATE, status: "requested", vendor_id: null, group_id: opts.groupId ?? null, services: { name: service } });
const seedCrew = (id: string, serviceTypes: string[], opts: { coi?: string | null; fixture?: boolean; phone?: string | null } = {}) => {
  table("vendors").push({
    id: `v-${id}`, user_id: `u-${id}`, status: "active", service_types: serviceTypes,
    coi_expiry: opts.coi === undefined ? "2099-01-01" : opts.coi,
    users: { is_fixture: opts.fixture ?? false },
  });
  table("users").push({ id: `u-${id}`, phone: opts.phone === undefined ? `+1555000${id.padStart(4, "0")}` : opts.phone, email: `${id}@crew.test`, role: "vendor" });
};
const textTo = (crewId: string) => sent.find((s) => s.to.phone === `+1555000${crewId.padStart(4, "0")}`);

beforeEach(() => {
  db.clear();
  sent.length = 0;
  table("users").push({ id: "u-ops", phone: "+15550009999", email: "ops@lakelife.test", role: "ops" });
});

describe("the open-jobs nudge prints the number on THAT crew's board", () => {
  it("a mow-only crew with 1 mow and 2 pier jobs open is told 1, not 3", async () => {
    seedJob("j-mow", MOW);
    seedJob("j-pier-1", PIER);
    seedJob("j-pier-2", PIER);
    seedCrew("mow", [MOW]);

    const res = await revalidateAssignments(DATE);

    expect(res.unfilled, "the RETURN still reports the whole marketplace").toBe(3);
    const text = textTo("mow");
    expect(text, "the mow crew is texted").toBeTruthy();
    expect(text!.msg.sms).toContain("1 open job up for grabs");
    expect(text!.msg.sms).not.toMatch(/3 open jobs/);
    // The same fact told three ways must be the same number.
    expect(text!.msg.subject).toContain("1 open job up for grabs");
    expect(text!.msg.body).toContain("1 open job up for grabs");
    expect(text!.msg.body).not.toMatch(/3 open jobs/);
  });

  it("does not count a package leg the board will never show them", async () => {
    // /vendor/open hides package legs (group_id set — "routed, never
    // cold-claimed"). A crew told "2 open jobs" who taps through and sees one
    // has been lied to by one. The review caught this residual after the
    // per-crew count landed.
    seedJob("j-mow", MOW);
    seedJob("j-mow-leg", MOW, { groupId: "pkg-1" });
    seedCrew("mow", [MOW]);

    await revalidateAssignments(DATE);

    const text = textTo("mow");
    expect(text, "the mow crew is texted").toBeTruthy();
    expect(text!.msg.sms).toContain("1 open job up for grabs");
    expect(text!.msg.sms).not.toMatch(/2 open jobs/);
  });

  it("each crew gets its own count in the same night", async () => {
    seedJob("j-mow", MOW);
    seedJob("j-pier-1", PIER);
    seedJob("j-pier-2", PIER);
    seedCrew("mow", [MOW]);
    seedCrew("pier", [PIER]);
    seedCrew("both", [MOW, PIER]);

    const res = await revalidateAssignments(DATE);

    expect(res.crewsTexted).toBe(3);
    expect(textTo("mow")!.msg.sms).toContain("1 open job up for grabs");
    expect(textTo("pier")!.msg.sms).toContain("2 open jobs up for grabs");
    expect(textTo("both")!.msg.sms).toContain("3 open jobs up for grabs");
  });

  it("a duplicated trade on the crew's list does not double-count a job", async () => {
    seedJob("j-mow", MOW);
    seedCrew("mow", [MOW, MOW]);

    await revalidateAssignments(DATE);

    expect(textTo("mow")!.msg.sms).toContain("1 open job up for grabs");
  });

  it("WHO is texted is unchanged: service overlap and a current COI, never the lake", async () => {
    seedJob("j-mow", MOW);
    seedCrew("mow", [MOW]);
    seedCrew("pier-only", [PIER]); // no overlap → not asked
    seedCrew("lapsed", [MOW], { coi: "2020-01-01" }); // COI expired → not asked
    seedCrew("uninsured", [MOW], { coi: null }); // no COI on file → not asked
    seedCrew("scratch", [MOW], { fixture: true }); // fixture → not asked

    const res = await revalidateAssignments(DATE);

    expect(res.crewsTexted).toBe(1);
    expect(textTo("mow")).toBeTruthy();
    expect(textTo("pier-only")).toBeUndefined();
    expect(textTo("lapsed")).toBeUndefined();
    expect(textTo("uninsured")).toBeUndefined();
    expect(textTo("scratch")).toBeUndefined();
  });

  it("nothing open ⇒ nobody is texted", async () => {
    seedCrew("mow", [MOW]);

    const res = await revalidateAssignments(DATE);

    expect(res.unfilled).toBe(0);
    expect(res.crewsTexted).toBe(0);
    expect(sent.filter((s) => s.what.includes("up for grabs"))).toEqual([]);
  });
});
