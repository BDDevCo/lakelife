import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A REFUND NEVER RESTATED REVENUE OR MARGIN.
 *
 * Both ops money reports summed `jobs.customer_price` and `jobs.margin` and
 * never looked at the refunds ledger. Refund a job and the week's revenue did
 * not move — the console said we had earned money we had given back, and it
 * kept saying so forever, because a refund writes its own row and touched
 * nothing here.
 *
 * The clawback is the half that is easy to get wrong in the other direction:
 * money recovered from the crew STAYS ours, so a $200 refund with a $140
 * clawback costs LakeLife $60 of margin, not $200.
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
/** Tables named here resolve to {data:null,error} — a FAILED read, not an empty one. */
const failing = new Set<string>();

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private head = false;
  constructor(private t: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.head = true;
    return this;
  }
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
  private rows() { return (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))); }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; count?: number | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const res = failing.has(this.t)
      ? { data: null, count: null, error: { message: "connection reset" } }
      : this.head
        ? { data: null, count: this.rows().length, error: null }
        : { data: this.rows(), count: null, error: null };
    return Promise.resolve(res).then(ok, bad);
  }
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => new Q(t) }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { getOpsSummary, getMarginByService } = await import("./data");
const { ReadFailed } = await import("@/lib/must-read");

/** A job inside this week, priced $500 with $150 of LakeLife margin. */
const job = (id: string, over: Row = {}): Row => ({
  id, status: "complete", date: "2026-08-18",
  customer_price: 500, vendor_cost: 350, margin: 150,
  services: { name: "Weekly mow" },
  ...over,
});
/** A refund the processor actually honoured (processor_ref stamped). */
const refund = (jobId: string, amount: number, clawback: number, over: Row = {}): Row => ({
  job_id: jobId, amount, crew_clawback: clawback, processor_ref: "rf_mock_1", ...over,
});

beforeEach(() => {
  db.jobs = [];
  db.refunds = [];
  failing.clear();
});

describe("the week KPI strip is net of refunds", () => {
  it("moves the week's revenue when a job is refunded", async () => {
    db.jobs = [job("j1")];
    db.refunds = [refund("j1", 200, 0)];
    const s = await getOpsSummary();
    expect(s.weekRevenue).toBe(300);
    expect(s.weekRevenueBooked).toBe(500);
    expect(s.weekRefunded).toBe(200);
  });

  it("leaves the crew clawback on our side of the line", async () => {
    // $200 back to the customer, $140 recovered from the crew: it cost us $60.
    db.jobs = [job("j1")];
    db.refunds = [refund("j1", 200, 140)];
    const s = await getOpsSummary();
    expect(s.weekMargin).toBe(90);
    expect(s.weekMarginBooked).toBe(150);
    expect(s.weekClawback).toBe(140);
    // Blended % is the net one, or the strip contradicts itself.
    expect(s.weekMarginPct).toBe(30); // 90 / 300
  });

  it("counts cents, not floats", async () => {
    db.jobs = [job("j1", { customer_price: 199.99, margin: 59.99 }), job("j2", { customer_price: 0.1, margin: 0.02 })];
    db.refunds = [refund("j1", 19.99, 0.07)];
    const s = await getOpsSummary();
    expect(s.weekRevenue).toBe(180.1);
    expect(s.weekMargin).toBe(40.09);
  });

  it("ignores a refund on a job outside the week", async () => {
    db.jobs = [job("j1")];
    db.refunds = [refund("other", 500, 0)];
    expect((await getOpsSummary()).weekRevenue).toBe(500);
  });

  it("ignores a claim the processor never honoured", async () => {
    // refund-core inserts the row, calls the processor, and deletes it again on
    // a decline. An unstamped row is a claim, not money.
    db.jobs = [job("j1")];
    db.refunds = [refund("j1", 200, 0, { processor_ref: null })];
    expect((await getOpsSummary()).weekRevenue).toBe(500);
  });

  it("refuses to render a failed refunds read as 'nothing refunded'", async () => {
    db.jobs = [job("j1")];
    failing.add("refunds");
    await expect(getOpsSummary()).rejects.toBeInstanceOf(ReadFailed);
  });
});

describe("revenue and margin by service line are net of refunds", () => {
  it("takes the refund off the line that earned it", async () => {
    db.jobs = [job("j1"), job("j2", { services: { name: "Pier removal" } })];
    db.refunds = [refund("j1", 200, 140)];
    const { rows, total } = await getMarginByService();
    const mow = rows.find((r) => r.service_name === "Weekly mow")!;
    expect(mow.customer_total).toBe(300);
    expect(mow.margin_total).toBe(90);
    expect(mow.vendor_total).toBe(210); // $350 booked, $140 clawed back
    expect(mow.customer_booked).toBe(500);
    expect(mow.margin_booked).toBe(150);
    expect(mow.refunded_total).toBe(200);
    expect(mow.clawback_total).toBe(140);

    const pier = rows.find((r) => r.service_name === "Pier removal")!;
    expect(pier.customer_total).toBe(500);
    expect(pier.refunded_total).toBe(0);

    expect(total.customer_total).toBe(800);
    expect(total.margin_total).toBe(240);
  });

  it("keeps the three columns adding up", async () => {
    db.jobs = [job("j1")];
    db.refunds = [refund("j1", 200, 140)];
    const { total } = await getMarginByService();
    expect(total.customer_total - total.vendor_total).toBe(total.margin_total);
  });

  it("says on the total line that the money has been netted", async () => {
    db.jobs = [job("j1")];
    db.refunds = [refund("j1", 200, 140)];
    const withRefunds = await getMarginByService();
    expect(withRefunds.total.service_name).toMatch(/net of \$200\.00 refunded/);

    db.refunds = [];
    const without = await getMarginByService();
    expect(without.total.service_name).toBe("Total");
  });

  it("refuses to render a failed refunds read as 'nothing refunded'", async () => {
    db.jobs = [job("j1")];
    failing.add("refunds");
    await expect(getMarginByService()).rejects.toBeInstanceOf(ReadFailed);
  });
});

describe("every money report in this file goes through the same doorway", () => {
  const path = fileURLToPath(new URL("./data.ts", import.meta.url));
  const raw = readFileSync(path, "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  /** Functions that stay BOOKED on purpose, with the reason they do. */
  const BOOKED_ON_PURPOSE: Record<string, RegExp> = {
    // The menu-tuning instrument: netting a service failure into it would drag
    // menu prices up for a bad job rather than a thin rate.
    computeMarginHealthRows: /menu price, not a money report/i,
  };

  const bodies = (() => {
    const marks = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)]
      .map((m) => ({ name: m[1], at: m.index ?? 0 }));
    return marks.map((m, i) => ({ name: m.name, body: src.slice(m.at, marks[i + 1]?.at ?? src.length) }));
  })();

  const aggregates = bodies.filter(
    (b) =>
      /from\("jobs"\)/.test(b.body) &&
      b.body.split("\n").some((l) => /(\+=|\.reduce\()/.test(l) && /(customer_price|margin)/.test(l)),
  );

  it("finds the reports it is supposed to be watching", () => {
    // The scanner proving it still works: if a rewrite hides these from it, the
    // next money report gets no guard at all and nothing says so.
    const names = aggregates.map((a) => a.name);
    expect(names).toContain("getOpsSummary");
    expect(names).toContain("getMarginByService");
    expect(names).toContain("computeMarginHealthRows");
  });

  it("nets every one of them, or names why not", () => {
    for (const a of aggregates) {
      const exempt = BOOKED_ON_PURPOSE[a.name];
      if (exempt) {
        expect(raw, `${a.name} is exempt but says nothing about why`).toMatch(exempt);
        continue;
      }
      expect(/refundsByJob\(/.test(a.body), `${a.name} sums job money without joining refunds`).toBe(true);
    }
  });

  it("counts only refunds the processor honoured", () => {
    expect(src).toMatch(/from\("refunds"\)[\s\S]{0,200}?\.not\("processor_ref", "is", null\)/);
  });
});
