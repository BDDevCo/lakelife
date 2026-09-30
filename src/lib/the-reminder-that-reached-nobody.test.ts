import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ONE NOTICE THAT REACHED NOBODY.
 *
 * `day` — "Crew on the way / service-day reminder" — was the only notification
 * type in NOTIF_DEFS declared TEXT-ONLY. Text has delivered 0 of 81 since 19
 * July. So the single message standing between a homeowner and a crew arriving
 * unannounced at 8am went out on the one channel that carries nothing, and
 * THREE separate things kept it there:
 *
 *   1. the def denied the email channel, so `dayByEmail` could never be true;
 *   2. `if (!phone) continue` dropped email-only owners BEFORE either channel
 *      was asked;
 *   3. the de-dupe was keyed on the phone number, which they do not have.
 *
 * And `sent++` ran unconditionally, so the nightly reported the same number for
 * a night nobody heard as for a night everybody did.
 *
 * Every test below collapses its condition both ways: the fix has to be the
 * thing that makes it pass.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ queued: false, error: "unregistered sender" })) }));
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
const told: { what: string; to: { phone?: string | null; email?: string | null }; msg: { sms: string; subject: string; body?: string } }[] = [];
let reachEveryone = true;
vi.mock("@/lib/notify", () => ({
  notify: vi.fn(async (
    what: string,
    to: { phone?: string | null; email?: string | null },
    msg: { sms: string; subject: string; body?: string },
  ) => {
    told.push({ what, to, msg });
    if (!reachEveryone) {
      return { reached: false, bySms: false, byEmail: false, note: `Couldn't tell them about ${what} — the text didn't queue and no email on file.` };
    }
    const reached = Boolean(to.phone || to.email);
    return { reached, bySms: Boolean(to.phone), byEmail: Boolean(to.email), note: reached ? undefined : `No way to reach them about ${what} — no mobile and no email on file.` };
  }),
}));

// ---------------------------------------------------------------------------
// The same fake Supabase the other automation tests use: rows in a map by
// table name, embeds on the row under the embedded table's name.
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
      const rows = this.inserting.map((r, i) => ({ id: `${this.name}-${table(this.name).length + i + 1}`, ...r }));
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

const { sendNightBeforeReminders } = await import("@/lib/automation");
const { NOTIF_DEFS } = await import("@/lib/notifications");
const { channelsFor, staticGate } = await import("@/lib/notif-prefs");

const TOMORROW = "2026-10-01";

function scheduledJob(opts: { id: string; owner: { id: string; phone?: string | null; email?: string | null }; address: string; service?: string }) {
  table("jobs").push({
    id: opts.id,
    date: TOMORROW,
    status: "scheduled",
    slot: "am",
    services: { name: opts.service ?? "Pier install" },
    properties: { address: opts.address, users: { id: opts.owner.id, phone: opts.owner.phone ?? null, email: opts.owner.email ?? null } },
  });
}

beforeEach(() => {
  db.clear();
  told.length = 0;
  reachEveryone = true;
});

// ===========================================================================
// the definition
// ===========================================================================
describe("the service-day reminder is no longer a text-only notice", () => {
  it("offers both channels, because one of them delivers nothing", () => {
    const day = NOTIF_DEFS.find((d) => d.type === "day")!;
    expect(channelsFor(day)).toEqual(["sms", "email"]);
  });
  it("and the gate can now say yes to email", () => {
    expect(staticGate("day", "email")).toBe("consult");
    expect(staticGate("day", "sms")).toBe("consult");
  });
});

// ===========================================================================
// the audience
// ===========================================================================
describe("an owner with an email and no mobile is somebody we remind", () => {
  it("is in the audience, and the email door is the one that opens", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: null, email: "owner@lakelife.test" }, address: "1 Shore Rd" });

    const res = await sendNightBeforeReminders(TOMORROW);

    expect(told, "the skip used to drop them before either channel was asked").toHaveLength(1);
    expect(told[0].to).toMatchObject({ phone: null, email: "owner@lakelife.test" });
    expect(res.sent).toBe(1);
    expect(res.skipped).toEqual([]);
  });

  it("CONTRAST — an owner with a mobile and no email is still in the audience", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: "+12605551213", email: null }, address: "1 Shore Rd" });

    await sendNightBeforeReminders(TOMORROW);
    expect(told).toHaveLength(1);
    expect(told[0].to).toMatchObject({ phone: "+12605551213", email: null });
  });

  it("CONTRAST — an owner with both gets both doors in one call, not two messages", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: "+12605551213", email: "owner@lakelife.test" }, address: "1 Shore Rd" });

    await sendNightBeforeReminders(TOMORROW);
    expect(told).toHaveLength(1);
    expect(told[0].to).toMatchObject({ phone: "+12605551213", email: "owner@lakelife.test" });
  });

  it("an owner with NEITHER door is not a quiet night", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: null, email: null }, address: "1 Shore Rd" });

    const res = await sendNightBeforeReminders(TOMORROW);
    expect(res.sent).toBe(0);
    expect(res.skipped, "'nobody to remind' must not read as 'nothing scheduled'").toHaveLength(1);
    expect(res.skipped[0]).toMatch(/no mobile and no email/i);
  });

  it("a job whose property has no owner row says so rather than vanishing", async () => {
    table("jobs").push({
      id: "j-orphan", date: TOMORROW, status: "scheduled", slot: "am",
      services: { name: "Pier install" },
      properties: { address: "9 Lost Lane", users: null },
    });

    const res = await sendNightBeforeReminders(TOMORROW);
    expect(told).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toContain("9 Lost Lane");
    expect(res.skipped[0]).toMatch(/no owner on file/i);
  });
});

// ===========================================================================
// the de-dupe
// ===========================================================================
describe("one reminder per OWNER, keyed on the owner and not on a phone number", () => {
  it("two jobs, one owner, no mobile: exactly one reminder", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: null, email: "owner@lakelife.test" }, address: "1 Shore Rd" });
    scheduledJob({ id: "j2", owner: { id: "u1", phone: null, email: "owner@lakelife.test" }, address: "2 Shore Rd", service: "Boat lift pull" });

    const res = await sendNightBeforeReminders(TOMORROW);
    expect(told, "keyed on the phone there was no key at all").toHaveLength(1);
    expect(res.sent).toBe(1);
  });

  it("CONTRAST — two DIFFERENT owners, neither with a mobile: two reminders", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: null, email: "a@lakelife.test" }, address: "1 Shore Rd" });
    scheduledJob({ id: "j2", owner: { id: "u2", phone: null, email: "b@lakelife.test" }, address: "2 Shore Rd" });

    const res = await sendNightBeforeReminders(TOMORROW);
    expect(told).toHaveLength(2);
    expect(told.map((t) => t.to.email).sort()).toEqual(["a@lakelife.test", "b@lakelife.test"]);
    expect(res.sent).toBe(2);
  });

  it("CONTRAST — two jobs for one owner WITH a mobile is still one reminder", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: "+12605551213", email: "a@lakelife.test" }, address: "1 Shore Rd" });
    scheduledJob({ id: "j2", owner: { id: "u1", phone: "+12605551213", email: "a@lakelife.test" }, address: "2 Shore Rd" });

    await sendNightBeforeReminders(TOMORROW);
    expect(told).toHaveLength(1);
  });
});

// ===========================================================================
// the count
// ===========================================================================
describe("the number it reports is people reached, not messages attempted", () => {
  it("a night nobody could be reached does not report a healthy count", async () => {
    reachEveryone = false;
    scheduledJob({ id: "j1", owner: { id: "u1", phone: "+12605551213", email: "owner@lakelife.test" }, address: "1 Shore Rd" });
    scheduledJob({ id: "j2", owner: { id: "u2", phone: "+12605551214", email: "other@lakelife.test" }, address: "2 Shore Rd" });

    const res = await sendNightBeforeReminders(TOMORROW);
    expect(told, "both were tried").toHaveLength(2);
    expect(res.sent, "and neither landed").toBe(0);
    expect(res.skipped).toHaveLength(2);
    for (const s of res.skipped) expect(s).toMatch(/crew comes tomorrow/);
  });

  it("CONTRAST — a night everybody heard reports two and says nothing else", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: null, email: "owner@lakelife.test" }, address: "1 Shore Rd" });
    scheduledJob({ id: "j2", owner: { id: "u2", phone: null, email: "other@lakelife.test" }, address: "2 Shore Rd" });

    const res = await sendNightBeforeReminders(TOMORROW);
    expect(res).toMatchObject({ ok: true, sent: 2, skipped: [] });
  });

  it("nothing scheduled is a quiet night, and quiet says nothing", async () => {
    const res = await sendNightBeforeReminders(TOMORROW);
    expect(res).toMatchObject({ ok: true, sent: 0, skipped: [] });
    expect(told).toEqual([]);
  });
});

// ===========================================================================
// the words
// ===========================================================================
describe("the mail says what the text says, and promises no text", () => {
  it("carries its own body, the date in words, and the address", async () => {
    scheduledJob({ id: "j1", owner: { id: "u1", phone: null, email: "owner@lakelife.test" }, address: "1 Shore Rd", service: "Pier install" });

    await sendNightBeforeReminders(TOMORROW);
    const { msg } = told[0];
    expect(msg.body, "the email must not be the SMS sentence verbatim").toBeTruthy();
    expect(msg.body).not.toBe(msg.sms);
    expect(msg.body).toContain("1 Shore Rd");
    expect(msg.body).toContain("Pier install");
    // A date a person reads is words, never 2026-10-01.
    expect(msg.body).not.toContain(TOMORROW);
    expect(msg.subject).toContain("1 Shore Rd");
    // NOTHING MAY PROMISE A TEXT until one has actually been delivered.
    expect(msg.body?.toLowerCase()).not.toMatch(/\btext\b|\bsms\b|message you/);
    expect(msg.subject.toLowerCase()).not.toMatch(/\btext\b|\bsms\b/);
  });
});