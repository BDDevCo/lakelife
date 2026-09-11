import { describe, it, expect, vi, beforeEach } from "vitest";
import { composeNightlyDigest, type DigestSections } from "@/lib/digest-render";

/**
 * TWO THINGS THE NIGHTLY GOT WRONG ABOUT WHAT IT FOUND.
 *
 * (A) THE DEAD-END ALARM HAD NO MEMORY. revalidateAssignments sweeps the whole
 *     forward book (tomorrow .. +60 days) every night, and when a service is
 *     open that no crew on the platform offers it texts and emails every ops
 *     user. It kept no record of having done so, so one unfillable booking six
 *     weeks out raised the same alarm 42 nights running — and the digest,
 *     which is where a standing fact belongs, carried nothing from dispatch at
 *     all. Silencing the alarm alone would have removed ops' ONLY signal about
 *     unfilled work, so both halves land together: the alarm claims a
 *     nudge_log row per service and holds for a week (the discipline
 *     gapSlaAlerts, overstayNotices and the fill-in digest already use), and
 *     the digest carries the count every morning.
 *
 * (B) THE HEADING SAID "N STEPS FAILED — THESE DID NOT RUN" over a list that
 *     also held per-item skips, settle refusals and the park machine's
 *     standing findings. The merge is deliberate and stays (nightly-rules
 *     "rule 2"); the heading and the subject line were false of most of what
 *     they sat above.
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
  })),
}));

type Sent = { what: string; to: { phone?: string | null; email?: string | null }; msg: { sms: string; subject: string } };
const sent: Sent[] = [];
/** What notify() reports back, switchable per test — reached:false is a night both doors were shut. */
let reach = true;
vi.mock("@/lib/notify", () => ({
  notify: vi.fn(async (what: string, to: Sent["to"], msg: Sent["msg"]) => {
    sent.push({ what, to, msg });
    return reach ? { reached: true, bySms: true, byEmail: true } : { reached: false, bySms: false, byEmail: false, note: `${what}: reached nobody` };
  }),
}));

// ---------------------------------------------------------------------------
// A fake Supabase wide enough for revalidateAssignments and sendNightlyDigest.
// Embeds live on the row under the table name; a dotted filter walks into
// them. Inserts land in the store with a sent_at, because the claim IS a row.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const table = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};
/** Tables whose next READ comes back as a refused query. */
const refuse = new Set<string>();
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
    if (refuse.has(this.name)) return { data: null, error: { message: `permission denied for table ${this.name}` } };
    const hit = table(this.name).filter((r) => this.filters.every((f) => matches(r, f)));
    if (this.headCount) return { data: null, error: null, count: hit.length };
    return { data: this.wantSingle ? hit[0] ?? null : hit, error: null };
  }
  then<A, B>(res?: ((v: Result) => A | PromiseLike<A>) | null, rej?: ((r: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(res, rej);
  }
}
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (name: string) => new Query(name) }) }));

const { revalidateAssignments, sendNightlyDigest } = await import("@/lib/automation");
const { sendEmail } = await import("@/lib/email");

const DATE = "2026-09-20";
const SNOW = "Snow plowing";
const PIER = "Pier install";
const MOW = "Lawn mowing & trim";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const seedJob = (id: string, service: string) =>
  table("jobs").push({ id, date: DATE, status: "requested", vendor_id: null, services: { name: service } });
const seedCrew = (id: string, serviceTypes: string[], opts: { phone?: string | null } = {}) => {
  table("vendors").push({
    id: `v-${id}`, user_id: `u-${id}`, status: "active", service_types: serviceTypes, coi_expiry: "2099-01-01",
    users: { is_fixture: false },
  });
  table("users").push({ id: `u-${id}`, phone: opts.phone === undefined ? `+1555000${id.padStart(4, "0")}` : opts.phone, email: `${id}@crew.test`, role: "vendor" });
};
const opsAlarms = () => sent.filter((s) => s.what.includes("nobody on the platform can claim"));
const claims = () => table("nudge_log").map((r) => r.kind as string).sort();

beforeEach(() => {
  db.clear();
  refuse.clear();
  sent.length = 0;
  reach = true;
  vi.mocked(sendEmail).mockClear();
  table("users").push({ id: "u-ops", phone: "+15550009999", email: "ops@lakelife.test", role: "ops" });
});

// ===========================================================================
// (A) the alarm remembers
// ===========================================================================
describe("the dead-end alarm has a memory", () => {
  it("alerts ops once about a service nobody offers, then holds for a week", async () => {
    seedJob("j-snow", SNOW); // and no crew on the platform plows snow

    await revalidateAssignments(DATE);
    expect(opsAlarms(), "the first night IS the recruiting signal").toHaveLength(1);
    expect(opsAlarms()[0].msg.sms).toContain(SNOW);
    expect(claims(), "the alarm claims a row per service, on the ops user").toEqual([`dead_end:${SNOW}`]);
    expect(table("nudge_log")[0].user_id).toBe("u-ops");

    // The next night, the same booking is still six weeks out and still open.
    await revalidateAssignments(DATE);
    expect(opsAlarms(), "the same dead end must not re-alarm inside the week").toHaveLength(1);
    expect(claims()).toEqual([`dead_end:${SNOW}`]);
  });

  it("alarms again once the week is up, not before", async () => {
    seedJob("j-snow", SNOW);
    table("nudge_log").push({ id: "n1", user_id: "u-ops", kind: `dead_end:${SNOW}`, sent_at: daysAgo(6) });
    await revalidateAssignments(DATE);
    expect(opsAlarms(), "six days is inside the week").toHaveLength(0);

    table("nudge_log")[0].sent_at = daysAgo(8);
    await revalidateAssignments(DATE);
    expect(opsAlarms(), "eight days is past it").toHaveLength(1);
  });

  it("a NEW dead-end service breaks through a cooling one, and only the new one is claimed", async () => {
    seedJob("j-snow", SNOW);
    seedJob("j-pier", PIER);
    table("nudge_log").push({ id: "n1", user_id: "u-ops", kind: `dead_end:${SNOW}`, sent_at: daysAgo(1) });

    await revalidateAssignments(DATE);
    expect(opsAlarms()).toHaveLength(1);
    expect(opsAlarms()[0].msg.sms, "the alarm names the new one").toContain(PIER);
    // Snow's week keeps running from yesterday; only the pier claim is new.
    expect(claims()).toEqual([`dead_end:${PIER}`, `dead_end:${SNOW}`]);
    expect(table("nudge_log").find((r) => r.kind === `dead_end:${SNOW}`)!.sent_at).toBe(table("nudge_log")[0].sent_at);
  });

  it("a night where every crew is on paper only (no number) claims per open service too", async () => {
    // A snow crew exists but has no phone on file, so nobody can be asked:
    // the crewsTexted === 0 branch. Same alarm, same memory.
    seedJob("j-snow", SNOW);
    seedCrew("plow", [SNOW], { phone: null });

    await revalidateAssignments(DATE);
    expect(opsAlarms()).toHaveLength(1);
    expect(claims()).toEqual([`dead_end:${SNOW}`]);
    await revalidateAssignments(DATE);
    expect(opsAlarms()).toHaveLength(1);
  });

  it("the claim is written only after the alarm reached somebody", async () => {
    seedJob("j-snow", SNOW);
    reach = false; // both of ops' doors shut tonight

    const first = await revalidateAssignments(DATE);
    expect(opsAlarms()).toHaveLength(1);
    expect(claims(), "a night that reached nobody must not buy a week of silence").toEqual([]);
    expect(first.skipped.join("\n")).toMatch(/reached nobody/);

    reach = true;
    await revalidateAssignments(DATE);
    expect(opsAlarms(), "so the next night tries again").toHaveLength(2);
    expect(claims()).toEqual([`dead_end:${SNOW}`]);
  });

  it("when it cannot read its own memory it stays quiet and says so", async () => {
    // FAILS OPEN IF IGNORED: null reads as "never alarmed" and the week-long
    // hold becomes a nightly text to every ops phone — the exact defect.
    seedJob("j-snow", SNOW);
    refuse.add("nudge_log");

    const res = await revalidateAssignments(DATE);
    expect(opsAlarms()).toHaveLength(0);
    expect(claims()).toEqual([]);
    expect(res.skipped.join("\n")).toMatch(/Snow plowing/);
    expect(res.skipped.join("\n")).toMatch(/already been raised|already alarmed|couldn't read/i);
  });

  it("returns the dead-end services and the crews it reached, for the digest", async () => {
    seedJob("j-snow", SNOW);
    seedJob("j-mow", MOW);
    seedCrew("mow", [MOW]);

    const res = await revalidateAssignments(DATE);
    expect(res.unfilled).toBe(2);
    expect(res.deadEnd).toEqual([SNOW]);
    expect(res.crewsNotified, "the mow crew took the up-for-grabs notice").toBe(1);
  });

  it("does not count a crew as notified when neither door took the message", async () => {
    seedJob("j-mow", MOW);
    seedCrew("mow", [MOW]);
    reach = false;

    const res = await revalidateAssignments(DATE);
    expect(res.crewsTexted, "the attempt is still counted — it is what decides the dead-end branch").toBe(1);
    expect(res.crewsNotified).toBe(0);
    expect(res.deadEnd).toEqual([]);
  });
});

// ===========================================================================
// (A) the digest carries the standing count
// ===========================================================================
const quiet: DigestSections = {
  learning: { changes: [] },
  autoPricing: { changes: [] },
  disputeSweep: { fired: 0, escalated: 0 },
  escalatedDisputes: [],
  lakesBorn: [],
  routes: {},
  aiAutoReplies: 0,
  aiReplyTexts: [],
  gapSla: { alerted: 0 },
};
const QUIET = "<p>Quiet night — nothing needed a human. 🌊</p>";

describe("the digest carries unfilled work as a standing count, not a fresh alarm", () => {
  it("names how many jobs have no crew and which services nobody offers", () => {
    const html = composeNightlyDigest({ ...quiet, unfilled: { jobs: 2, crewsNotified: 1, deadEnd: [SNOW] } });
    expect(html).not.toBe(QUIET);
    expect(html).toContain("2 jobs");
    expect(html).toContain(SNOW);
    expect(html).toMatch(/1 crew\b/);
    expect(html).toMatch(/recruit/i);
  });

  it("says when nobody could be told, without inventing a dead end", () => {
    const html = composeNightlyDigest({ ...quiet, unfilled: { jobs: 1, crewsNotified: 0, deadEnd: [] } });
    expect(html).toContain("1 job");
    expect(html).not.toMatch(/recruit/i);
    expect(html).toMatch(/no crew was (sent|told|reached)/i);
  });

  it("zero unfilled is silence, and so is the field being absent", () => {
    expect(composeNightlyDigest({ ...quiet, unfilled: { jobs: 0, crewsNotified: 0, deadEnd: [] } })).toBe(QUIET);
    expect(composeNightlyDigest(quiet)).toBe(QUIET);
  });

  it("escapes a service name rather than pasting it into the HTML", () => {
    const html = composeNightlyDigest({ ...quiet, unfilled: { jobs: 1, crewsNotified: 0, deadEnd: ["<b>Snow</b>"] } });
    expect(html).not.toContain("<b>Snow</b>");
    expect(html).toContain("&lt;b&gt;Snow&lt;/b&gt;");
  });

  it("sendNightlyDigest passes what dispatch found straight through to the email", async () => {
    await sendNightlyDigest({
      learning: { changes: [] }, autoPricing: { changes: [] }, disputeSweep: { fired: 0, escalated: 0 }, routes: {}, gapSla: { alerted: 0 },
      dispatch: { unfilled: 3, deadEnd: [SNOW], crewsNotified: 2 },
    });
    const html = (vi.mocked(sendEmail).mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("3 jobs");
    expect(html).toContain(SNOW);
  });
});

// ===========================================================================
// (B) the heading is true of everything under it
// ===========================================================================
describe("the heading over the needs-a-look list is true of a skip", () => {
  it("a skipped item is not called a failed step", () => {
    const html = composeNightlyDigest({
      ...quiet,
      failures: [{ step: "noShows", kind: "skipped", error: "Job j1: the crew was never told their standing moved." }],
    });
    expect(html).toContain("1 thing needs a look");
    expect(html).not.toMatch(/step.? failed/);
    expect(html).not.toContain("did not run");
    expect(html).toMatch(/<li><strong>skipped<\/strong>/);
  });

  it("a park finding is labelled as found, not as a failure", () => {
    const html = composeNightlyDigest({
      ...quiet,
      failures: [{ step: "park", kind: "found", error: "The Haven: 3 occupied lots have no bill for September 2026" }],
    });
    expect(html).toContain("1 thing needs a look");
    expect(html).not.toMatch(/step.? failed/);
    expect(html).not.toMatch(/skipped/);
    expect(html).toMatch(/<li><strong>found<\/strong>/);
    expect(html).toContain("The Haven: 3 occupied lots have no bill for September 2026");
  });

  it("a mixed night counts each kind by name and labels every line", () => {
    const html = composeNightlyDigest({
      ...quiet,
      failures: [
        { step: "routes", kind: "failed", error: "connection terminated" },
        { step: "dispatch", kind: "skipped", error: "Couldn't re-check the crew on one job (j9)." },
        { step: "reconcile", kind: "skipped", error: "Job j2: not settled — no card on file." },
        { step: "park", kind: "found", error: "The Haven: 3 occupied lots have no bill for September 2026" },
      ],
    });
    expect(html).toContain("4 things need a look");
    expect(html).toContain("1 step failed tonight");
    expect(html).toMatch(/2 items?\b/);
    expect(html).toMatch(/1 standing finding/);
    expect(html).not.toContain("4 steps failed");
    const labels = [...html.matchAll(/<li><strong>(failed|skipped|found)<\/strong>/g)].map((m) => m[1]);
    expect(labels).toEqual(["failed", "skipped", "skipped", "found"]);
    // What broke still leads the email.
    expect(html.indexOf("need a look")).toBeLessThan(html.indexOf("connection terminated"));
  });

  it("an unlabelled entry still reads as a thrown step — the list's original meaning", () => {
    // The route stamps every entry it pushes; this is the contract for a
    // caller that predates kinds, and it is what digest-render.test.ts pins.
    const html = composeNightlyDigest({ ...quiet, failures: [{ step: "runCharges", error: "connection terminated" }] });
    expect(html).toContain("1 step failed tonight");
    expect(html).toMatch(/<li><strong>failed<\/strong>/);
  });

  it("the subject line says what the list holds, and FAILED only when a step did", async () => {
    const base = { learning: { changes: [] }, autoPricing: { changes: [] }, disputeSweep: { fired: 0, escalated: 0 }, routes: {}, gapSla: { alerted: 0 } };
    const subject = () => (vi.mocked(sendEmail).mock.calls.at(-1)![0] as { subject: string }).subject;

    await sendNightlyDigest({ ...base, failures: [{ step: "noShows", kind: "skipped", error: "one crew never told" }] });
    expect(subject()).toContain("1 thing needs a look");
    expect(subject()).not.toMatch(/FAILED/);

    await sendNightlyDigest({ ...base, failures: [
      { step: "routes", kind: "failed", error: "boom" },
      { step: "park", kind: "found", error: "The Haven: 2 occupied lots have no bill" },
    ] });
    expect(subject()).toContain("2 things need a look");
    expect(subject()).toMatch(/1 step FAILED/);
    expect(subject()).not.toMatch(/2 steps/);
  });
});
