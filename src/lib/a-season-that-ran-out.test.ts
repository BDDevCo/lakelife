import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A SEASON THAT HAS RUN OUT IS NOT A SEASON WE ARE STILL SELLING.
 *
 * `lakes.ice_out_actual` and `lakes.pull_deadline` hold ONE season's absolute
 * dates, and nothing advances them — the only writers are the ops season form
 * and lake-birth. Every reader therefore has to decide what a spent window
 * means, and four readers of the same two columns gave three different
 * answers. The fourth walk of The Haven's first months found the other three:
 *
 *   1. `effectiveSeason` rolled only when the stored YEAR was past, so between
 *      the pull deadline (mid-November) and New Year's Day the calendar told a
 *      customer paging to April 2027 that every square was "Outside the
 *      water-work season" — six weeks of a confident dark grid over exactly
 *      the spring we intend to sell first, with no caveat on the page.
 *
 *   2. `generateAutopilotProposals` handed the RAW columns to the proposer, so
 *      from 1 January every water enrollment produced null on every night,
 *      with a bare `continue` and no line in the digest — indistinguishable
 *      from a quiet night, while the Autopilot card still promised "We line up
 *      each season's visit and tell you first."
 *
 *   3. `birthSpringJobs` compared the raw ice-out to the fall visit it must
 *      follow, which is false forever against a fall visit completed in
 *      November — the stored boat never comes back out, silently.
 *
 *   4. `gapSlaAlerts` measured deadline pressure off the raw column, so the
 *      96-hour "this pier is about to be frozen in" escalation stopped firing
 *      the day the stored deadline passed.
 *
 * And the one-tap Autopilot confirm page, which said "You're booked 🌊 … we'll
 * remind you the night before" for a job dispatch had found no crew for — a
 * job that stays `requested`, which the night-before sweep never reads.
 *
 * The runners are exercised for real, against a fake of the tables they read.
 */

// ---------------------------------------------------------------------------
// The fake Supabase: a chainable builder that records the call and hands it to
// whichever handler the test installed. No network, no processor, no clock.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: Row;
  cols: Set<string>;
  single: boolean;
}
interface Res {
  data: unknown;
  error: unknown;
}

let handle: (c: Call) => Res = () => ({ data: [], error: null });
const calls: Call[] = [];

class Q implements PromiseLike<Res> {
  private call: Call;
  constructor(table: string) {
    this.call = { table, op: "select", cols: new Set(), single: false };
  }
  private f(col: string) {
    this.call.cols.add(col);
    return this;
  }
  select() {
    return this;
  }
  insert(p: Row) {
    this.call.op = "insert";
    this.call.payload = p;
    return this;
  }
  update(p: Row) {
    this.call.op = "update";
    this.call.payload = p;
    return this;
  }
  delete() {
    this.call.op = "delete";
    return this;
  }
  eq(c: string) { return this.f(c); }
  neq(c: string) { return this.f(c); }
  in(c: string) { return this.f(c); }
  is(c: string) { return this.f(c); }
  not(c: string) { return this.f(c); }
  lt(c: string) { return this.f(c); }
  lte(c: string) { return this.f(c); }
  gt(c: string) { return this.f(c); }
  gte(c: string) { return this.f(c); }
  ilike(c: string) { return this.f(c); }
  or() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  maybeSingle() { this.call.single = true; return this; }
  single() { this.call.single = true; return this; }
  then<A, B>(ok?: ((v: Res) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    calls.push(this.call);
    return Promise.resolve(handle(this.call)).then(ok, bad);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ queued: true })) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/payments-server", () => ({
  LakeLifePaymentsServer: { charge: vi.fn(async () => ({ ok: true, ref: "ref_test" })) },
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
    gapSlaHours: 48,
  })),
}));

vi.mock("@/app/book/dispatch", () => ({
  revalidateJob: vi.fn(async () => {}),
  autoAssignJob: vi.fn(async () => ({ assigned: false })),
  loadPricingProfileById: vi.fn(async () => null),
}));

/** The lakes' clock, so "today" is an argument and not the machine's date.
 *  effectiveSeason and seasonIsProvisional stay REAL — they are the subject. */
let TODAY = "2027-01-15";
vi.mock("@/lib/booking", async (orig) => {
  const actual = await orig<typeof import("@/lib/booking")>();
  return { ...actual, todayLakeDate: () => TODAY };
});

/** Every message a runner tried to send, in the words it tried to send. */
const sent: Array<{ what: string; sms: string; subject: string; body?: string }> = [];
vi.mock("@/lib/notify", () => ({
  notify: vi.fn(async (what: string, _to: unknown, msg: { sms: string; subject: string; body?: string }) => {
    sent.push({ what, ...msg });
    return { reached: true, bySms: true, byEmail: true };
  }),
}));

import { effectiveSeason, seasonIsProvisional, dayStatus, type DayContext } from "./booking";
import { generateAutopilotProposals, birthSpringJobs, gapSlaAlerts } from "./automation";

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
  handle = () => ({ data: [], error: null });
  TODAY = "2027-01-15";
});

// ===========================================================================
// 1. effectiveSeason — a window that has ended is spent, whatever year it is
// ===========================================================================

/** Big Long Lake as prod holds it today: a 2026 season, confirmed by hand. */
const BIG_LONG = { iceOut: "2026-03-21", pullDeadline: "2026-11-14" };

describe("effectiveSeason rolls a window that has run out, not one whose year has", () => {
  it("the six weeks between the pull deadline and New Year now sell next spring", () => {
    const eff = effectiveSeason(BIG_LONG, "2026-12-20");
    expect(eff.seasonStart).toBe("2027-03-21");
    expect(eff.seasonEnd).toBe("2027-11-14");
    expect(eff.wasRolled).toBe(true);
    expect(eff.yearsRolled).toBe(1);
  });

  it("the calendar square for April 2027, read on 20 December 2026", () => {
    const ctx = (over: Partial<DayContext> = {}): DayContext => ({
      today: "2026-12-20",
      isWaterWork: true,
      seasonStart: BIG_LONG.iceOut,
      seasonEnd: BIG_LONG.pullDeadline,
      fullDates: new Set<string>(),
      ...over,
    });
    // The defect, in one line: this used to be "off-season".
    expect(dayStatus("2027-04-15", ctx())).toBe("available");
    // And it is not that water work simply stopped being gated — December is
    // still before the rolled ice-out, and so is March 1st.
    expect(dayStatus("2026-12-24", ctx())).toBe("off-season");
    expect(dayStatus("2027-03-01", ctx())).toBe("off-season");
    // Land work never asked the season anything.
    expect(dayStatus("2026-12-24", ctx({ isWaterWork: false }))).toBe("available");
  });

  it("the roll makes the window provisional, so the grid's hedge finally fires", () => {
    // Before: wasRolled false and season_confirmed true on every prod lake, so
    // seasonIsProvisional was false and the "these dates aren't confirmed yet"
    // notice never rendered over the dark December calendar.
    expect(seasonIsProvisional(effectiveSeason(BIG_LONG, "2026-11-01"), true)).toBe(false);
    expect(seasonIsProvisional(effectiveSeason(BIG_LONG, "2026-12-20"), true)).toBe(true);
  });

  it("a window still ahead of us is never overwritten by a guess", () => {
    // Today, 22 September 2026: the deadline has not passed, nothing rolls.
    const eff = effectiveSeason(BIG_LONG, "2026-09-22");
    expect(eff).toEqual({ seasonStart: "2026-03-21", seasonEnd: "2026-11-14", wasRolled: false, yearsRolled: 0 });
    // The deadline itself is the last day inside the window, not the first out.
    expect(effectiveSeason(BIG_LONG, "2026-11-14").wasRolled).toBe(false);
    expect(effectiveSeason(BIG_LONG, "2026-11-15").seasonEnd).toBe("2027-11-14");
  });

  it("rolling a rolled window is a no-op — the answer does not drift by a year a night", () => {
    const once = effectiveSeason(BIG_LONG, "2026-12-20");
    const twice = effectiveSeason({ iceOut: once.seasonStart, pullDeadline: once.seasonEnd }, "2026-12-20");
    expect(twice.seasonStart).toBe(once.seasonStart);
    expect(twice.seasonEnd).toBe(once.seasonEnd);
  });

  it("half a window has no end to be past, and is left exactly as stored", () => {
    // `today > null` would coerce to false and give the right answer for the
    // wrong reason; the null is checked, so a pull deadline added later rolls.
    const eff = effectiveSeason({ iceOut: "2026-03-21", pullDeadline: null }, "2026-12-20");
    expect(eff.seasonEnd).toBe(null);
    expect(eff.wasRolled).toBe(false);
    expect(eff.seasonStart).toBe("2026-03-21");
  });

  it("a year-past window still rolls exactly as far as it always did", () => {
    const eff = effectiveSeason(BIG_LONG, "2029-06-01");
    expect(eff.seasonStart).toBe("2029-03-21");
    expect(eff.yearsRolled).toBe(3);
  });
});

// ===========================================================================
// 2. generateAutopilotProposals — the proposer reads the rolled season, and
//    an enrollment that produces nothing says so out loud
// ===========================================================================

const lakeRow = (over: Row = {}): Row => ({
  name: "Big Long Lake",
  ice_out_actual: "2026-03-21",
  pull_deadline: "2026-11-14",
  season_confirmed: true,
  ...over,
});

const enrollment = (over: { service?: Row; lake?: Row | null } = {}): Row => ({
  id: "enr-1",
  property_id: "prop-1",
  service_id: "svc-1",
  locked_price: 604,
  services: { name: "Pier removal & lift pull", is_water_work: true, ...(over.service ?? {}) },
  properties: {
    owner_id: "own-1",
    address: "12 Shoreline Dr",
    nickname: null,
    lake_id: "lake-1",
    lakes: over.lake === null ? null : lakeRow(over.lake ?? {}),
  },
});

function autopilotTables(enrollments: Row[]) {
  handle = (c) => {
    if (c.table === "autopilot_enrollments") return { data: enrollments, error: null };
    if (c.table === "autopilot_events" && c.op === "insert") return { data: { confirm_token: "tok-1" }, error: null };
    if (c.table === "autopilot_events") return { data: c.single ? null : [], error: null };
    if (c.table === "users") return { data: { phone: "+15555550123", email: "owner@example.com" }, error: null };
    return { data: [], error: null };
  };
}

describe("autopilot keeps proposing after the stored season has run out", () => {
  it("pencils next spring's pier work on a January night, off last season's dates", async () => {
    autopilotTables([enrollment()]);
    const res = await generateAutopilotProposals();
    expect(res.proposed).toBe(1);
    // ice-out 21 March + 14 days, on the ROLLED year. Reading the raw column
    // this was null on every night of 2027, and nothing was sent or said.
    const insert = calls.find((c) => c.table === "autopilot_events" && c.op === "insert");
    expect(insert?.payload?.proposed_date).toBe("2027-04-04");
    expect(sent).toHaveLength(1);
    expect(sent[0].sms).toContain("Apr 4");
  });

  it("and says the date is an estimate, because a rolled date is a guess", async () => {
    // One tap from a billable job at a locked price, and prettyDate prints no
    // year — a penciled guess and a measured date read identically. Same
    // sentence the seasonal pull reminder carries, so the two cannot drift.
    autopilotTables([enrollment()]);
    await generateAutopilotProposals();
    expect(sent[0].sms).toContain("an estimate until this year's ice-out is measured");
    expect(sent[0].body).toContain("an estimate until this year's ice-out is measured");
  });

  it("but a season somebody measured THIS year is stated flat", async () => {
    // Non-vacuity for the hedge: collapse `provisional` to always-true and
    // this fails. A confirmed, current window is a fact, not an estimate.
    autopilotTables([
      enrollment({ lake: { ice_out_actual: "2027-03-20", pull_deadline: "2027-11-12" } }),
    ]);
    const res = await generateAutopilotProposals();
    expect(res.proposed).toBe(1);
    expect(sent[0].sms).not.toContain("estimate until this year's ice-out");
  });

  it("does not hedge land work, which has no season to be unsure about", async () => {
    autopilotTables([
      enrollment({ service: { name: "Mow & blow", is_water_work: false } }),
    ]);
    const res = await generateAutopilotProposals();
    expect(res.proposed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].sms).not.toContain("estimate until this year's ice-out");
  });

  it("an enrollment that produces no date lands in the digest, by name and with the reason", async () => {
    // A spring-only service in July: the rolled spring edge is behind us and
    // there is no other edge for this service to use. Legitimately nothing to
    // propose — but a bare `continue` here is the promise quietly not kept.
    TODAY = "2027-07-01";
    autopilotTables([
      enrollment({ service: { name: "Spring pier install", is_water_work: true } }),
    ]);
    const res = await generateAutopilotProposals();
    expect(res.proposed).toBe(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toContain("Spring pier install");
    expect(res.skipped[0]).toContain("12 Shoreline Dr");
    // The window it worked from, in words, with the year that is the point.
    expect(res.skipped[0]).toContain("March 21, 2027 to November 14, 2027");
    expect(sent).toHaveLength(0);
  });

  it("a lake with no season on file says THAT, rather than quoting a window it does not have", async () => {
    autopilotTables([
      enrollment({ lake: { ice_out_actual: null, pull_deadline: null } }),
    ]);
    const res = await generateAutopilotProposals();
    expect(res.proposed).toBe(0);
    expect(res.skipped[0]).toContain("Big Long Lake has no ice-out and pull deadline on file");
  });
});

// ===========================================================================
// 3. birthSpringJobs — a stale ice-out strands every boat on the lake, and
//    now it says so once, by lake, without inventing a date
// ===========================================================================

const envelope = (id: string): Row => ({
  id,
  property_id: `prop-${id}`,
  spring_service_ids: ["svc-spring"],
  spring_quote: 540,
  storing_vendor: "vendor-1",
  fall_job_id: `fall-${id}`,
  properties: {
    lake_id: "lake-1",
    owner_id: "own-1",
    lakes: { name: "Big Long Lake", ice_out_actual: "2026-03-21" },
  },
});

describe("a spring visit is never born off a guessed ice-out — but the silence ends", () => {
  it("names the lake's stale date once, however many boats are stranded by it", async () => {
    handle = (c) => {
      if (c.table === "job_groups") return { data: [envelope("a"), envelope("b")], error: null };
      // The fall visit each envelope hangs off: done, last November.
      if (c.table === "jobs" && c.single) return { data: { status: "complete", date: "2026-11-05" }, error: null };
      return { data: [], error: null };
    };
    const res = await birthSpringJobs();
    expect(res.born).toBe(0);
    // Two envelopes, ONE line — a marina would otherwise print this twenty
    // times a night and teach ops to skim the digest.
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toContain("Big Long Lake");
    expect(res.skipped[0]).toContain("March 21, 2026");
    expect(res.skipped[0]).toContain("this year's ice-out is filed");
  });

  it("still refuses to birth the visit — the skip line is the fix, not a roll", async () => {
    // A billable visit with nobody's tap on it must never be measured off last
    // season's date; it waits for ops. Nothing was written.
    handle = (c) => {
      if (c.table === "job_groups") return { data: [envelope("a")], error: null };
      if (c.table === "jobs" && c.single) return { data: { status: "complete", date: "2026-11-05" }, error: null };
      return { data: [], error: null };
    };
    await birthSpringJobs();
    expect(calls.filter((c) => c.table === "jobs" && c.op === "insert")).toHaveLength(0);
  });

  it("a fresh ice-out gets past the gate, so the skip is not simply always taken", async () => {
    // Non-vacuity: same envelope, this year's ice-out on the lake.
    handle = (c) => {
      if (c.table === "job_groups") {
        const g = envelope("a");
        (g.properties as Row).lakes = { name: "Big Long Lake", ice_out_actual: "2027-03-20" };
        return { data: [g], error: null };
      }
      if (c.table === "jobs" && c.single) return { data: { status: "complete", date: "2026-11-05" }, error: null };
      return { data: [], error: null };
    };
    const res = await birthSpringJobs();
    expect(res.skipped.some((s) => s.includes("older than the fall visits"))).toBe(false);
  });
});

// ===========================================================================
// 4. gapSlaAlerts — the pier-about-to-be-frozen-in escalation, in a later year
// ===========================================================================

describe("deadline pressure survives the stored season", () => {
  const stuckJob = (createdAt: string): Row => ({
    id: "job-1",
    date: "2027-11-13",
    created_at: createdAt,
    services: { name: "Pier removal", is_water_work: true },
    properties: { address: "12 Shoreline Dr", lakes: { name: "Big Long Lake", pull_deadline: "2026-11-14" } },
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("alerts ops inside 96 hours of the ROLLED deadline, on a job well inside the SLA", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-11-11T12:00:00Z"));
    TODAY = "2027-11-11";
    handle = (c) => {
      // An hour old: nowhere near the 48h SLA, so `nearDeadline` is the only
      // thing that can fire this. Measured off the raw 2026 column the delta
      // is a year negative and ops hear nothing, ever again.
      if (c.table === "jobs") return { data: [stuckJob("2027-11-11T11:00:00Z")], error: null };
      if (c.table === "users") return { data: [{ id: "ops-1", phone: "+15555550111", email: "ops@example.com" }], error: null };
      return { data: [], error: null };
    };
    const res = await gapSlaAlerts();
    expect(res.alerted).toBe(1);
    expect(sent[0].sms).toContain("into the pull-deadline window");
  });

  it("stays quiet outside the window, so the roll did not simply alert on everything", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-06-01T12:00:00Z"));
    TODAY = "2027-06-01";
    handle = (c) => {
      if (c.table === "jobs") return { data: [stuckJob("2027-06-01T11:00:00Z")], error: null };
      if (c.table === "users") return { data: [{ id: "ops-1", phone: "+15555550111", email: "ops@example.com" }], error: null };
      return { data: [], error: null };
    };
    const res = await gapSlaAlerts();
    expect(res.alerted).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

// ===========================================================================
// 5. The settings screen describes the switches it actually has
// ===========================================================================

describe("the notification settings sentence", () => {
  const src = readFileSync(
    join(process.cwd(), "src/app/settings/notifications/NotifPrefs.tsx"),
    "utf8",
  );

  it("reads the file at all", () => {
    expect(src.length).toBeGreaterThan(400);
    expect(src).toContain("NOTIF_DEFS");
  });

  it("does not claim to govern EVERY kind of update", () => {
    // Six switches; the Autopilot proposal, the waitlist warning, the expiry
    // and late-cancellation notices, "a crew picked up your job" and the
    // ops-scheduled booking all send with no preference consulted. Whether
    // those deserve switches is his call. The sentence was not.
    const shown = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(shown).not.toContain("each kind of update");
    expect(shown).toContain("Choose how LakeLife reaches you for these updates.");
  });
});
