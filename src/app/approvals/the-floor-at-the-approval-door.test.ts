import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { marginPct } from "@/lib/dispatch";
import { rushPrice } from "@/lib/rush";

/**
 * APPROVAL WAS THE ONE DOORWAY THAT NEVER LOOKED AT THE MARGIN FLOOR.
 *
 * Every other door that puts a crew's number on a job tests it: dispatch
 * refuses to route below the floor, canClaim refuses a crew's own claim with
 * `rate_too_high`, ops' manual assign refuses it by name, and the gap engine
 * exists solely to price a below-floor crew down to something that clears.
 *
 * `approveFlag` re-derives BOTH sides — the customer's price from the menu
 * rule and the crew's cost from their own rate card — and tested neither. The
 * floor was loaded three lines away as `rushSettings` and never read, which
 * enforces exactly nothing. So a crew flags a bigger pier, the owner taps
 * Approve, and the job is written at the very rate dispatch had refused to
 * route at. The database does not catch it either: guard_job_money_shape
 * refuses a loss only when vendor_id CHANGES, and this update never touches
 * vendor_id.
 *
 * Two doorways, one rule. The card-derived branch must clear the floor
 * outright. The kept-cost branch must never be made WORSE than what both
 * sides agreed — but it may stay below the floor, because a gap claim is
 * below the floor by design and freezing every gap-claimed job would be a
 * second bug.
 *
 * Nothing on production is mispriced today: all three vendors are fixtures and
 * no real flag has ever been approved. This is a blocker for the first real
 * crew, not a live leak.
 */

// ------------------------------------------------------------- the mock db

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let seq = 0;

const OWNER = "owner-1";
const PROP = "prop-1";
const VENDOR = "vendor-1";
const SVC = "svc-pier";
const FLAG = "flag-1";

/** How many pier sections the approved correction leaves on the profile. */
let sections = 15;

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private lim: number | null = null;
  private op: "update" | "insert" | "delete" | null = null;
  private payload: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not() { return this; }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  insert(p: Row) { this.op = "insert"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }

  private matched(): Row[] {
    const all = (db[this.t] ??= []).filter((r) => this.fs.every((f) => f(r)));
    return this.lim == null ? all : all.slice(0, this.lim);
  }
  private run(): Row[] {
    const table = (db[this.t] ??= []);
    if (this.op === "update") {
      const hit = this.matched();
      for (const r of hit) Object.assign(r, this.payload);
      return hit;
    }
    if (this.op === "insert") {
      const row = { id: `${this.t}-${++seq}`, ...(this.payload as Row) };
      table.push(row);
      return [row];
    }
    if (this.op === "delete") {
      const hit = this.matched();
      db[this.t] = table.filter((r) => !hit.includes(r));
      return hit;
    }
    return this.matched();
  }
  maybeSingle() {
    const rows = () => this.run();
    return { then<A>(ok: (x: { data: Row | null; error: null }) => A) { return Promise.resolve({ data: rows()[0] ?? null, error: null }).then(ok); } };
  }
  then<A>(ok: (x: { data: Row[] | null; count: number | null; error: null }) => A) {
    const rows = this.run();
    return Promise.resolve({ data: rows, count: rows.length, error: null }).then(ok);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t), rpc: async () => ({ error: null }) }),
}));
vi.mock("@/app/profile/data", () => ({
  getFullProfile: async () => ({ hasProfile: true, groundsForParkId: null, pier_sections: sections }),
  toPricingProfile: (p: Record<string, unknown>) => ({ pier_sections: p.pier_sections }),
}));
vi.mock("@/app/park/rate-data", () => ({
  loadParkRatesChecked: async () => ({ failed: false, rates: null }),
}));

const notify = vi.fn(async () => ({ reached: true, bySms: false, byEmail: true }));
vi.mock("@/lib/notify", () => ({ notify: (...a: unknown[]) => notify(...(a as [])) }));

const { approveFlag } = await import("./actions");

// The real seeded pier rule (0047) and the real crew card read off production.
const PIER: ServiceRule = {
  name: "Pier install / removal", pricing_model: "per_section", base: 220, unit_rate: 48, band_pricing: null,
};
const CARD: ServiceRule = { ...PIER, base: 0, unit_rate: 52 };
const at = (n: number) => priceService(PIER, { pier_sections: n } as never);
const cardAt = (n: number) => priceService(CARD, { pier_sections: n } as never);

const job = (over: Row): Row => ({
  id: "job-1", status: "scheduled", property_id: PROP, group_id: null, service_id: SVC,
  vendor_id: VENDOR, vendor_cost: null, customer_price: 0, est_minutes: 180,
  is_rush: false, gap_claim: false, ...over,
});

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  seq = 0;
  sections = 15;
  notify.mockClear();
  db.flags = [{
    id: FLAG, status: "pending", job_id: null, vendor_id: VENDOR,
    proposed_change: { pier_sections: 15 }, at_arrival: false,
    crew_can_proceed: null, crew_cannot_reason: null,
    jobs: { property_id: PROP, service_id: SVC, properties: { owner_id: OWNER } },
  }];
  db.services = [{
    id: SVC, name: PIER.name, pricing_model: "per_section", base: 220, unit_rate: 48,
    band_pricing: null, est_minutes: 180, duration_bands: null,
  }];
  db.vendor_rates = [{ vendor_id: VENDOR, service_id: SVC, base: 0, unit_rate: 52, band_pricing: null }];
  db.users = [{ id: "ops-1", role: "ops", phone: null, email: "ops@example.test" }];
  db.platform_settings = [{ key: "margin_floor", value: 0.2 }];
  db.jobs = [];
});

// ------------------------------------------------------- the arithmetic

describe("the numbers the floor has to catch", () => {
  it("a 15-section pier on the live cards is a 17% job", () => {
    expect(at(15)).toBe(940);
    expect(cardAt(15)).toBe(780);
    expect(marginPct(940, 780)).toBeCloseTo(0.17, 3);
    // Not an exotic size: the $52 card first breaks a 0.20 floor at thirteen.
    expect(marginPct(at(13), cardAt(13))).toBeLessThan(0.2);
    expect(marginPct(at(12), cardAt(12))).toBeGreaterThanOrEqual(0.2);
  });

  it("and a same-day job that SHRINKS takes its margin down with the price", () => {
    // 14 sections, rushed: $1,115 to the customer, a $690 gap-claimed
    // take-home. The crew flags 8 and the price falls to $755.
    expect(rushPrice(at(14), 0.25)).toBe(1115);
    expect(rushPrice(at(8), 0.25)).toBe(755);
    expect(marginPct(755, 690)).toBeCloseTo(0.086, 3);
    expect(755 - 800).toBe(-45); // the same shape at an $800 take-home
  });
});

// ------------------------------------------------- doorway one: the card

describe("the card-derived branch", () => {
  it("holds a visit whose crew card prices it under the floor", async () => {
    db.jobs = [job({ customer_price: 892, vendor_cost: 624 })];
    const res = await approveFlag(FLAG);
    expect(res.ok).toBe(true);
    expect(res.heldForMargin).toBe(1);
    expect(res.repriced).toBe(0);
    // Held WHOLE. A job carrying new minutes and an old price is worse than
    // one left alone.
    expect(db.jobs[0]).toMatchObject({ customer_price: 892, vendor_cost: 624, est_minutes: 180 });
    expect(db.jobs[0].margin).toBeUndefined();
  });

  it("reprices normally when the same correction still clears the floor", async () => {
    sections = 9;
    db.jobs = [job({ customer_price: 604, vendor_cost: 416 })];
    const res = await approveFlag(FLAG);
    expect(res.heldForMargin).toBe(0);
    expect(res.repriced).toBe(1);
    expect(db.jobs[0]).toMatchObject({ customer_price: 652, vendor_cost: 468, margin: 184 });
    expect(Number(db.jobs[0].est_minutes)).toBeGreaterThan(0);
  });
});

// -------------------------------------------- doorway two: the kept cost

describe("the kept-cost branch", () => {
  it("holds a same-day gap claim whose price falls under it", async () => {
    sections = 8;
    db.jobs = [job({ customer_price: 1115, vendor_cost: 690, is_rush: true, gap_claim: true })];
    const res = await approveFlag(FLAG);
    expect(res.heldForMargin).toBe(1);
    expect(res.repriced).toBe(0);
    expect(db.jobs[0]).toMatchObject({ customer_price: 1115, vendor_cost: 690 });
    expect(db.jobs[0].margin).toBeUndefined();
  });

  it("refuses the loss outright when the crew's take-home exceeds the new price", async () => {
    sections = 8;
    db.jobs = [job({ customer_price: 1115, vendor_cost: 800, is_rush: true, gap_claim: true })];
    await approveFlag(FLAG);
    // margin would have been 755 − 800 = −$45, and the database permits it:
    // the loss guard fires only when vendor_id changes.
    expect(db.jobs[0].margin).toBeUndefined();
    expect(db.jobs[0].customer_price).toBe(1115);
  });

  it("still reprices a gap claim that is below the floor BY DESIGN", async () => {
    // A gap claim is below the floor because the gap engine negotiated it
    // there and the crew accepted. Growing the job improves it; holding every
    // below-floor gap claim would freeze them all the moment an owner approved
    // anything.
    sections = 9;
    db.jobs = [job({ customer_price: 755, vendor_cost: 700, is_rush: true, gap_claim: true })];
    const res = await approveFlag(FLAG);
    expect(marginPct(815, 700)).toBeLessThan(0.2);
    expect(res.heldForMargin).toBe(0);
    expect(res.repriced).toBe(1);
    expect(db.jobs[0]).toMatchObject({ customer_price: 815, vendor_cost: 700, margin: 115 });
  });
});

// ------------------------------------------------- who is told, and what

describe("the hold reaches the person who can act on it", () => {
  it("is not counted as a price the homeowner agreed to", async () => {
    db.jobs = [job({ customer_price: 892, vendor_cost: 624 })];
    const res = await approveFlag(FLAG);
    // `heldAgreements` has one reader and it tells the HOMEOWNER we kept a
    // price THEY agreed. Neither half is true of a margin hold: the price is
    // the ordinary menu price and the reason is our own margin. Folding the
    // two together would put a false sentence on their screen.
    expect(res.heldAgreements).toBe(0);
    expect(res.heldForMargin).toBe(1);
  });

  it("emails ops the pair, and carries only a count back to the owner", async () => {
    db.jobs = [job({ customer_price: 892, vendor_cost: 624 })];
    const res = await approveFlag(FLAG);
    const alerts = notify.mock.calls.filter((c) => String((c as unknown as unknown[])[0]).includes("margin floor"));
    expect(alerts).toHaveLength(1);
    const msg = (alerts[0] as unknown as [string, unknown, { subject: string; body: string }])[2];
    expect(msg.subject).toMatch(/held under the margin floor/);
    // The crew's cost beside the customer's price is exactly the pair a vendor
    // may never see and a homeowner has no use for — so it goes to an ops
    // address or nowhere.
    expect(msg.body).toMatch(/\$940\.00/);
    expect(msg.body).toMatch(/\$780\.00/);
    // And the owner's result carries a number, never a figure.
    expect(JSON.stringify(res)).not.toMatch(/780/);
  });

  it("says nothing to anybody when nothing was held", async () => {
    sections = 9;
    db.jobs = [job({ customer_price: 604, vendor_cost: 416 })];
    await approveFlag(FLAG);
    expect(notify.mock.calls.filter((c) => String((c as unknown as unknown[])[0]).includes("margin floor"))).toHaveLength(0);
  });
});

// --------------------------------------------------------- the shape of it

describe("the source keeps one copy of the rule in both doorways", () => {
  const src = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("strips its own comments, so none of this passes on a paragraph", () => {
    expect(src).toMatch(/THIS WAS THE ONE DOORWAY WITHOUT IT/);
    expect(code).not.toMatch(/THIS WAS THE ONE DOORWAY WITHOUT IT/);
  });

  it("imports marginPct rather than re-deriving the fraction", () => {
    expect(code).toMatch(/import \{ marginPct \} from "@\/lib\/dispatch";/);
    // A second copy of the arithmetic is a second place for it to drift.
    expect(code).not.toMatch(/\(price - cost\) \/ price/);
  });

  it("tests the floor in both doorways, against the dial that was already loaded", () => {
    const guards = (code.match(/marginPct\(price, cost\) < rushSettings\.marginFloor/g) ?? []).length;
    expect(guards).toBe(2);
    expect((code.match(/heldForMargin \+= 1;/g) ?? []).length).toBe(2);
  });
});
