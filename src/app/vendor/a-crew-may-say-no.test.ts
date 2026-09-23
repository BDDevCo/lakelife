import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * §11.1 PROMISES CREWS "MAY ACCEPT OR REJECT JOBS" AND NO DOOR DID IT.
 *
 * `src/app/vendor/actions.ts` exported five actions — photo, complete, flag,
 * no-show, photo URLs — and not one of them was a decline or a release. Under
 * choose-your-crew a BUYER picks this crew off their own rate card, so the
 * missing "no" is sharper: the only exits were ringing somebody, or ghosting
 * the job into a permanent `vendor_no_shows` strike that never clears.
 *
 * AND THE NIGHTLY'S SILENT `continue`. A crew who photographed the job and
 * forgot to tap complete was skipped by `recordNoShows` in silence — no
 * payout, no invoice, no digest line, no ops alert, the job in `scheduled` for
 * ever. Both live here because both are "the job that quietly went nowhere".
 */

// ---------------------------------------------------------------------------
// A fake Supabase that APPLIES UPDATES — the point of half these tests is what
// the job row looks like afterwards, so a no-op `update()` would pass every
// one of them against code that wrote nothing.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const table = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};
const get = (row: Row, col: string): unknown =>
  col.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Row)[k] : undefined), row);

interface Filter { kind: "eq" | "in" | "is" | "not_is" | "lt"; col: string; val: unknown }
const matches = (row: Row, f: Filter): boolean => {
  const v = get(row, f.col);
  switch (f.kind) {
    case "eq": return v === f.val;
    case "in": return (f.val as unknown[]).includes(v);
    case "is": return v == null;
    case "not_is": return v != null;
    case "lt": return String(v) < String(f.val);
  }
};

/** Tables the fake should answer with an error, to exercise a failed read. */
const failing = new Set<string>();

type Result = { data: Row[] | Row | null; error: { message: string } | null; count?: number };
class Query implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private wantSingle = false;
  private headCount = false;
  private inserting: Row[] | null = null;
  private updating: Row | null = null;
  private deleting = false;
  constructor(private name: string) {}
  select(_cols?: string, opts?: { head?: boolean }) { if (opts?.head) this.headCount = true; return this; }
  insert(rows: Row | Row[]) { this.inserting = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch: Row) { this.updating = patch; return this; }
  delete() { this.deleting = true; return this; }
  eq(col: string, val: unknown) { this.filters.push({ kind: "eq", col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ kind: "in", col, val }); return this; }
  is(col: string) { this.filters.push({ kind: "is", col, val: null }); return this; }
  not(col: string) { this.filters.push({ kind: "not_is", col, val: null }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ kind: "lt", col, val }); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }
  private run(): Result {
    if (failing.has(this.name)) return { data: null, error: { message: `boom: ${this.name}` }, count: undefined };
    if (this.inserting) {
      const rows = this.inserting.map((r, i) => ({ id: `${this.name}-${table(this.name).length + i + 1}`, ...r }));
      table(this.name).push(...rows);
      return { data: this.wantSingle ? rows[0] : rows, error: null };
    }
    const hit = table(this.name).filter((r) => this.filters.every((f) => matches(r, f)));
    if (this.updating) {
      for (const r of hit) Object.assign(r, this.updating);
      return { data: hit, error: null };
    }
    if (this.deleting) {
      db.set(this.name, table(this.name).filter((r) => !hit.includes(r)));
      return { data: hit, error: null };
    }
    if (this.headCount) return { data: null, error: null, count: hit.length };
    return { data: this.wantSingle ? hit[0] ?? null : hit, error: null };
  }
  then<A, B>(res?: ((v: Result) => A | PromiseLike<A>) | null, rej?: ((r: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(res, rej);
  }
}

const client = { from: (name: string) => new Query(name) };
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => client,
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u-josh" } } }) } }),
}));
vi.mock("@/app/vendor/data", () => ({ getMyVendorId: async () => "v-josh" }));

const told: Array<{ what: string }> = [];
vi.mock("@/lib/notify", () => ({
  notify: vi.fn(async (what: string) => { told.push({ what }); return { reached: true }; }),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  todayLakeDate: () => "2026-09-23",
}));

const { releaseJob } = await import("./actions");
const { recordNoShows } = await import("@/lib/automation");

const FUTURE = "2026-10-01";

function seedJob(over: Row = {}): string {
  const id = `job-${table("jobs").length + 1}`;
  table("jobs").push({
    id,
    status: "scheduled",
    vendor_id: "v-josh",
    service_id: "svc-mow",
    date: FUTURE,
    property_id: "prop-1",
    group_id: null,
    held_at: null,
    no_show_at: null,
    stood_down_at: null,
    customer_price: 120,
    crew_quote: null,
    fee_customer_pct: null,
    fee_crew_pct: null,
    vendor_cost: 90,
    margin: 30,
    route_id: "route-1",
    sequence: 3,
    services: { name: "Lawn mowing & trim", min_photos: 2, needs_interior_access: false },
    ...over,
  });
  return id;
}

beforeEach(() => {
  db.clear();
  failing.clear();
  told.length = 0;
  table("properties").push({
    id: "prop-1",
    address: "9085 E 500 S",
    nickname: null,
    users: { name: "Mike", email: "mike@example.com", phone: "+15550001111" },
  });
});

describe("a crew can hand a future job back", () => {
  it("releases it to the board, clears what was OURS to pay, and tells the owner", async () => {
    const id = seedJob();
    const res = await releaseJob(id, "Truck's in the shop until Friday");
    expect(res.ok, res.error).toBe(true);

    const job = table("jobs")[0];
    expect(job.vendor_id).toBeNull();
    expect(job.vendor_cost).toBeNull();
    expect(job.margin).toBeNull();
    expect(job.status).toBe("requested");
    // The owner is TOLD. A crew coming off the calendar in silence is the
    // failure this replaces, not an acceptable version of it.
    expect(told.map((t) => t.what).join(" ")).toMatch(/handed back/i);
  });

  it("writes the reason down, so a release is not a silent no-show", async () => {
    const id = seedJob();
    await releaseJob(id, "Truck's in the shop until Friday");
    const rows = table("job_releases");
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("Truck's in the shop until Friday");
    expect(rows[0].vendor_id).toBe("v-josh");
    expect(rows[0].job_id).toBe(id);
    // NOT a no-show: no strike, and nothing that feeds standing.
    expect(table("vendor_no_shows")).toHaveLength(0);
    expect(table("job_visit_attempts")).toHaveLength(0);
    expect(table("payouts")).toHaveLength(0);
  });

  it("refuses with no reason — the owner is owed a sentence", async () => {
    const id = seedJob();
    const res = await releaseJob(id, "   ");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/why/i);
    expect(table("job_releases")).toHaveLength(0);
    expect(table("jobs")[0].vendor_id).toBe("v-josh");
  });
});

describe("what a release must refuse", () => {
  it("TODAY'S job — that is a no-show, not notice", async () => {
    const id = seedJob({ date: "2026-09-23" });
    const res = await releaseJob(id, "can't make it");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no-show/i);
    expect(table("jobs")[0].vendor_id).toBe("v-josh");
  });

  it("a PAST job", async () => {
    const id = seedJob({ date: "2026-09-01" });
    const res = await releaseJob(id, "can't make it");
    expect(res.ok).toBe(false);
    expect(table("job_releases")).toHaveLength(0);
  });

  it("a COMPLETED job, photos and all", async () => {
    const id = seedJob({ status: "complete" });
    table("job_photos").push({ id: "p1", job_id: id });
    const res = await releaseJob(id, "changed my mind");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/closed out/i);
  });

  it("a job already started", async () => {
    const id = seedJob({ status: "in_progress" });
    const res = await releaseJob(id, "half done");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already started/i);
  });

  it("a job that was never theirs", async () => {
    const id = seedJob({ vendor_id: "v-somebody-else" });
    const res = await releaseJob(id, "not mine");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/isn't on your route/i);
    expect(table("job_releases")).toHaveLength(0);
  });

  it("a visit already recorded as unworked", async () => {
    const id = seedJob({ no_show_at: "2026-09-20T12:00:00Z" });
    const res = await releaseJob(id, "gave up");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unworked/i);
  });
});

describe("a release must not move a price the customer agreed to", () => {
  /**
   * THIS TEST USED TO PIN THE OPPOSITE, and the opposite was a money bug.
   *
   * The first cut wiped `customer_price`, `crew_quote` and both frozen
   * percentages on a crew-priced release, copying `claimJob`'s `unfreeze`. The
   * precedent does not transfer: claimJob undoes a price IT wrote seconds
   * earlier before anybody was told; a release undoes a price a customer
   * agreed to at booking. Worse, `autoAssignJob` refuses a silent reprice only
   * `if (agreedPrice > 0 …)` — so wiping the price DISARMED the guard, and the
   * nightly would have put a new crew on the job at a new number with nobody
   * told.
   */
  it("a CREW-PRICED job keeps its quote and both frozen percentages", async () => {
    const id = seedJob({ customer_price: 940.8, crew_quote: 840, fee_customer_pct: 0.12, fee_crew_pct: 0.12 });
    const res = await releaseJob(id, "double booked");
    expect(res.ok, res.error).toBe(true);
    const job = table("jobs")[0];
    expect(job.customer_price).toBe(940.8);
    expect(job.crew_quote).toBe(840);
    expect(job.fee_customer_pct).toBe(0.12);
    expect(job.fee_crew_pct).toBe(0.12);
    // What IS cleared: what we would have paid THIS crew, and their place in
    // a drive order they are no longer part of.
    expect(job.vendor_id).toBeNull();
    expect(job.vendor_cost).toBeNull();
    expect(job.margin).toBeNull();
    expect(job.route_id).toBeNull();
    expect(job.sequence).toBeNull();
  });

  it("a MENU-PRICED job keeps the price the customer already agreed to", async () => {
    // Collapsed the other way: both branches must leave the customer's number
    // alone, so neither can be satisfied by code that wipes on one path.
    const id = seedJob({ customer_price: 120, crew_quote: null });
    const res = await releaseJob(id, "double booked");
    expect(res.ok, res.error).toBe(true);
    expect(table("jobs")[0].customer_price).toBe(120);
  });

  it("the guard the frozen price keeps armed is the one in autoAssignJob", () => {
    // NOT a copy of the expression: read the real source and require that the
    // refusal is conditioned on a POSITIVE agreed price. If that condition
    // ever goes, wiping the price on release becomes safe again and the test
    // above becomes arbitrary — so the two are pinned together.
    const src = readFileSync(join(process.cwd(), "src/app/book/dispatch.ts"), "utf8");
    expect(src).toMatch(/if \(agreedPrice > 0 &&/);
  });

  it("and the SECOND doorway onto the board carries the same guard", () => {
    // A rule in one doorway of two is not a rule. The claim board wrote
    // `billed` unconditionally; that was harmless only while a released
    // crew-priced job always arrived with its price nulled. It does not any
    // more, so the manual claim is now the place a different crew could
    // rewrite the customer's number.
    const src = readFileSync(join(process.cwd(), "src/app/vendor/open-actions.ts"), "utf8");
    expect(src).toMatch(/if \(fee && !unpriced && Math\.abs\(billed - priceAtRead\)/);
    expect(src).toMatch(/can't change what they were quoted without asking them/);
  });

  it("the owner is told what is actually true — not that nobody will be put on it", () => {
    // `sweepWaitlist` picks up exactly this row (status 'requested',
    // vendor_id null, date > today) in the nightly, in the intraday, and the
    // moment any crew claims into the lake. "we have NOT put somebody else on
    // it — that's your call" was false within hours of being sent.
    // COMMENTS STRIPPED FIRST. The note explaining why the sentence went
    // quotes the sentence, and a scanner that reads comments would find the
    // dead copy for ever and never notice it coming back.
    const strip = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const src = strip(readFileSync(join(process.cwd(), "src/app/vendor/actions.ts"), "utf8"));
    expect(src).not.toMatch(/we have NOT put somebody else on it/);
    expect(src).toMatch(/AT THE PRICE YOU AGREED TO/);
    const panel = strip(readFileSync(join(process.cwd(), "src/components/VendorJobPanel.tsx"), "utf8"));
    expect(panel).not.toMatch(/don&apos;t put anybody else on it without asking them/);
    // Non-vacuity: the scanner must still be able to SEE the file's strings.
    expect(src).toMatch(/handed it back/);
  });
});

describe("a release cannot leave evidence or a boat behind", () => {
  it("a job with photos on it is refused", async () => {
    // Rule 2 counts photos BY JOB, not by crew (0050's trigger does the same),
    // so photos left on a released job would count toward whoever picks it up
    // — a payout released against another business's pictures.
    const id = seedJob({});
    table("job_photos").push({ id: "p1", job_id: id, url: "x.jpg" });
    const res = await releaseJob(id, "truck's in the shop");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already got photos/i);
    expect(table("job_releases")).toHaveLength(0);
    // And nothing moved.
    expect(table("jobs")[0].vendor_id).toBe("v-josh");
  });

  it("a visit whose boat is still in the crew's building is refused", async () => {
    const id = seedJob({ group_id: "g-1" });
    table("storage_stays").push({ id: "s1", group_id: "g-1", status: "in_storage" });
    const res = await releaseJob(id, "busy that week");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/still in your building/i);
    expect(table("job_releases")).toHaveLength(0);
  });

  it("a visit whose boat has already gone home is NOT refused", async () => {
    // Collapsed the other way — a guard that refuses every grouped job would
    // pass the test above while breaking every package visit.
    const id = seedJob({ group_id: "g-1" });
    table("storage_stays").push({ id: "s1", group_id: "g-1", status: "returned" });
    const res = await releaseJob(id, "busy that week");
    expect(res.ok, res.error).toBe(true);
  });
});

describe("the job nobody was ever paid for", () => {
  beforeEach(() => {
    table("vendors").push({ id: "v-josh", user_id: "u-josh", company: "Josh's Lawn Care" });
  });

  it("a past job WITH photos is reported, not skipped in silence", async () => {
    const id = seedJob({ date: "2026-09-20", status: "scheduled" });
    Object.assign(table("jobs")[0], {
      properties: { address: "9085 E 500 S", owner_id: "u-mike", lake_id: "lake-pretty" },
      vendors: { user_id: "u-josh", company: "Josh's Lawn Care" },
      phase: null,
    });
    table("job_photos").push({ id: "ph1", job_id: id }, { id: "ph2", job_id: id });

    const out = await recordNoShows();
    // Still NOT a ghost: no strike, no release, the job untouched.
    expect(out.flagged).toBe(0);
    expect(table("vendor_no_shows")).toHaveLength(0);
    expect(table("jobs")[0].vendor_id).toBe("v-josh");

    // But it is now SAID — this is what reaches ops through
    // noteSkips("noShows", noShows) in the nightly route.
    const line = out.skipped.join("\n");
    expect(line).toContain(id);
    expect(line).toMatch(/never marked complete/i);
    // Names the person who can actually clear it, and how. "Leave for ops"
    // told ops nothing and gave them no button.
    expect(line).toContain("Josh's Lawn Care");
    expect(line).toContain("/vendor/schedule");
    expect(line).toMatch(/Mark complete/i);
  });

  it("a past job with NO photos is still a no-show, and says nothing extra", async () => {
    // Non-vacuity: if the branch above swallowed everything, this would also
    // stop working — and the sweep's real job is this one.
    const id = seedJob({ date: "2026-09-20", status: "scheduled" });
    Object.assign(table("jobs")[0], {
      properties: { address: "9085 E 500 S", owner_id: "u-mike", lake_id: "lake-pretty" },
      vendors: { user_id: "u-josh", company: "Josh's Lawn Care" },
      phase: null,
    });
    const out = await recordNoShows();
    expect(out.flagged).toBe(1);
    expect(table("vendor_no_shows")).toHaveLength(1);
    expect(table("jobs")[0].vendor_id).toBeNull();
    expect(out.skipped.join("\n")).not.toMatch(/never marked complete/i);
    expect(id).toBeTruthy();
  });
});
