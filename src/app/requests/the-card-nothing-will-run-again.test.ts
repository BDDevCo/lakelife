import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * "WE'LL RUN THIS ON YOUR CARD ON FILE" — AFTER THE CAP, NOTHING WILL.
 *
 * Both nightly doors that re-run a `due` invoice — reconcileUnsettledJobs and
 * reconcileCancelledFees in lib/automation.ts — count payments.status='failed'
 * for the invoice and skip it at >= 5. Nothing else re-runs an invoice: not
 * saving a new card (payment-actions never touches `payments`), not an ops
 * button (the only ops charge door is the no-show visit fee). So after five
 * declines the job page's "We'll run this on your card on file" is false on
 * every night that follows, forever, and the loader never even read the
 * count that decides it.
 *
 * Latent until LAKELIFE_PAYMENTS_LIVE=true — under the mock a non-attempt is
 * not filed as a decline — but the mechanics are real on the day the switch
 * flips, and a customer who reads that sentence waits for a charge that is
 * never coming.
 */

// ------------------------------------------------------------- the mock db

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Tables set here answer {data:null,count:null,error} — a FAILED read. */
const failing = new Set<string>();
/** Tables whose COUNT reads fail while their row reads still work — isolates
 *  the decline count from the `paidAt` read that shares the table. */
const failingCounts = new Set<string>();

const OWNER = "owner-1";
const JOB = "job-1";
const INVOICE = "inv-1";
const OTHER_INVOICE = "inv-other";

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private counting = false;
  private lim: number | null = null;
  constructor(private t: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.counting = true;
    return this;
  }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  private rows(): Row[] {
    const all = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    return this.lim == null ? all : all.slice(0, this.lim);
  }
  maybeSingle() {
    const t = this.t, rows = () => this.rows();
    return {
      then<A, B>(ok?: ((x: { data: Row | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
                 bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
        const res = failing.has(t)
          ? { data: null, error: { message: "connection reset" } }
          : { data: rows()[0] ?? null, error: null };
        return Promise.resolve(res).then(ok, bad);
      },
    };
  }
  then<A, B>(ok?: ((x: { data: Row[] | null; count: number | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    const res = failing.has(this.t) || (this.counting && failingCounts.has(this.t))
      ? { data: null, count: null, error: { message: "connection reset" } }
      : this.counting
        ? { data: null, count: this.rows().length, error: null }
        : { data: this.rows(), count: null, error: null };
    return Promise.resolve(res).then(ok, bad);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/photos", () => ({
  signedJobPhotos: async () => [],
  signedJobPhotosFor: async () => new Map(),
}));
vi.mock("@/app/requests/package-data", () => ({ getPackageBreakdowns: async () => ({}) }));
vi.mock("@/app/requests/offer-data", () => ({ computeScarcityOffer: async () => null }));

const mod = await import("./job-detail-data");
const { loadCustomerJobDetail, invoiceCopy, DECLINE_CAP } = mod;
type Money = import("./job-detail-data").JobDetailMoney;
const { ReadFailed } = await import("@/lib/must-read");

const failedPayment = (invoice: string, i: number): Row =>
  ({ id: `p-${invoice}-${i}`, invoice_id: invoice, status: "failed", created_at: `2026-09-0${(i % 9) + 1}T03:00:00Z` });

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  failing.clear();
  failingCounts.clear();
  db.jobs = [{
    id: JOB, status: "complete", date: "2026-09-01", slot: null, customer_price: 450, property_id: "prop-1",
    group_id: null, vendor_id: "v1", correction_of: null, scope_note: null, tip_amount: null, tipped_at: null,
    services: { name: "Pier removal", min_photos: 3 },
    properties: { owner_id: OWNER, nickname: "Blue Heron", address: "12 Shore Rd" },
    vendors: { company: "Dockside Crew" },
  }];
  db.invoices = [{ id: INVOICE, job_id: JOB, amount: 450, status: "due", created_at: "2026-09-01T20:00:00Z" }];
  db.refunds = [];
  db.job_confirmations = [];
  db.disputes = [];
  db.messages = [];
  db.payment_methods = [{ id: "pm-1", user_id: OWNER }];
  db.payments = [];
});

// ------------------------------------------------------------- the loader

describe("the loader reads how many times this invoice's card has declined", () => {
  it("counts the failed payments on THIS invoice, and only this one", async () => {
    db.payments = [
      ...[1, 2, 3, 4, 5].map((i) => failedPayment(INVOICE, i)),
      // Another invoice's declines must not be blamed on this one.
      failedPayment(OTHER_INVOICE, 1), failedPayment(OTHER_INVOICE, 2),
      // A captured payment is not a decline.
      { id: "p-cap", invoice_id: INVOICE, status: "captured", created_at: "2026-09-09T03:00:00Z" },
    ];
    const view = await loadCustomerJobDetail(JOB);
    expect(view?.money.declines).toBe(5);
  });

  it("reports zero when the card has never been tried", async () => {
    const view = await loadCustomerJobDetail(JOB);
    expect(view?.money.declines).toBe(0);
  });

  it("reads no declines at all when there is no invoice — nothing to count", async () => {
    db.invoices = [];
    const view = await loadCustomerJobDetail(JOB);
    expect(view?.money.invoiceStatus).toBeNull();
    expect(view?.money.declines).toBe(0);
  });

  it("refuses to render on a failed count rather than printing 'we'll run this' to a capped card", async () => {
    // A failed count is null. `null ?? 0` is under the cap, and the page would
    // print the one sentence this whole file exists to stop. Only the COUNT
    // fails: the `paidAt` row read on the same table still answers, so this
    // is the decline count's own guard being tested and not its neighbour's.
    failingCounts.add("payments");
    await expect(loadCustomerJobDetail(JOB)).rejects.toBeInstanceOf(ReadFailed);
  });
});

// --------------------------------------------------------------- the words

const money = (over: Partial<Money>): Money => ({
  customerPrice: 450, legs: [], spring: null, invoiceStatus: "due", invoiceAmount: 450, paidAt: null,
  hasCardOnFile: true, declines: 0, refunds: [], refundedTotal: 0, tipAmount: null, tippedAt: null,
  ...over,
});

describe("what the invoice card says about a due invoice", () => {
  it("the cap is the nightly's cap", () => {
    expect(DECLINE_CAP).toBe(5);
  });

  it("under the cap, with a card, still promises the charge — because the nightly will make it", () => {
    for (const declines of [0, 1, DECLINE_CAP - 1]) {
      const c = invoiceCopy(money({ declines }));
      expect(c.pill).toBe("Due");
      expect(c.note, `at ${declines} declines`).toMatch(/We'll run this on your card on file/);
    }
  });

  it("at the cap, stops promising a charge that nothing will make", () => {
    const c = invoiceCopy(money({ declines: DECLINE_CAP }));
    expect(c.note).not.toMatch(/We'll run this/);
    expect(c.note).not.toMatch(/we'll take care of it/i);
    expect(c.note).not.toMatch(/try again/i);
    expect(c.pill).not.toBe("Due");
  });

  it("at the cap, says how many times, that it stopped, that it is still owed, and where the card lives", () => {
    const c = invoiceCopy(money({ declines: DECLINE_CAP }));
    expect(c.note).toMatch(/tried 5 times/);
    expect(c.note).toMatch(/declined/);
    expect(c.note).toMatch(/stopped/);
    expect(c.note).toMatch(/still owed/);
    expect(c.note).toMatch(/Billing page/);
    expect(c.tone).toBe("warn");
  });

  it("over the cap reads the same way, with the real count", () => {
    const c = invoiceCopy(money({ declines: 7 }));
    expect(c.note).toMatch(/tried 7 times/);
    expect(c.note).not.toMatch(/We'll run this/);
  });

  it("at the cap, a new card does not restart it, and the note must say so", () => {
    // Nothing re-runs a capped invoice after a card change — not the nightly
    // (the failed count never resets), not an ops button (there is none for a
    // completion or cancellation-fee invoice). The customer is told to leave a
    // note, which is the one control on this screen that reaches a person.
    const c = invoiceCopy(money({ declines: DECLINE_CAP }));
    expect(c.note).toMatch(/doesn't restart this on its own/);
    expect(c.note).toMatch(/note below/);
  });

  it("at the cap with NO card, still refuses 'add one and we'll take care of it'", () => {
    // The twin. A customer who removed the card after the declines would have
    // been handed the needs-a-card copy, whose closing promise is just as
    // false once the nightly has stopped looking at this invoice.
    const c = invoiceCopy(money({ declines: DECLINE_CAP, hasCardOnFile: false }));
    expect(c.note).not.toMatch(/we'll take care of it/i);
    expect(c.note).toMatch(/tried 5 times/);
    expect(c.note).toMatch(/Add a card/);
    expect(c.note).not.toMatch(/Update your card/);
  });

  it("under the cap with no card keeps the needs-a-card copy", () => {
    const c = invoiceCopy(money({ declines: 2, hasCardOnFile: false }));
    expect(c.pill).toBe("Needs a card");
    expect(c.note).toMatch(/We don't have a card on file/);
  });

  it("the other invoice states are untouched by the decline count", () => {
    expect(invoiceCopy(money({ invoiceStatus: "paid", declines: 9 })).pill).toBe("Paid");
    expect(invoiceCopy(money({ invoiceStatus: "refunded", declines: 9 })).pill).toMatch(/Refunded/);
    expect(invoiceCopy(money({ invoiceStatus: "draft", declines: 9 })).pill).toBe("Not billed yet");
    expect(invoiceCopy(money({ invoiceStatus: null, declines: 9 })).pill).toBe("Nothing billed yet");
  });
});

// --------------------------------------------------------- the assembly

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the page renders these words and no private copy of them", () => {
  const page = strip(read("./[id]/page.tsx"));

  it("calls invoiceCopy from the loader module", () => {
    expect(page).toMatch(/invoiceCopy\s*\(\s*job\.money\s*\)/);
    expect(page).toMatch(/import\s*\{[^}]*\binvoiceCopy\b[^}]*\}\s*from\s*"@\/app\/requests\/job-detail-data"/);
  });

  it("no longer carries the sentence itself", () => {
    expect(page).not.toMatch(/We'll run this on your card on file/);
    expect(page).not.toMatch(/function\s+invoiceCopy/);
  });
});

describe("the loader's count is the nightly's count", () => {
  const loader = strip(read("./job-detail-data.ts"));
  const nightly = strip(read("../../lib/automation.ts"));

  it("goes through mustCount, in human words, so a failed read cannot read as zero", () => {
    expect(loader).toMatch(/mustCount\(\s*"how many times your card has declined"/);
  });

  it("filters on invoice_id and status='failed' — the same shape both nightly doors use", () => {
    // Match the CALL: the count, then the two filters, in either order.
    const count = loader.match(/from\("payments"\)[\s\S]{0,200}?\.eq\("status",\s*"failed"\)/);
    expect(count, "the loader no longer counts failed payments on this invoice").toBeTruthy();
    expect(count![0]).toMatch(/\{\s*count:\s*"exact",\s*head:\s*true\s*\}/);
    expect(count![0]).toMatch(/\.eq\("invoice_id",/);
  });

  it("the nightly still caps at the number this page names — both doors", () => {
    // Anchored on the comparison the nightly actually makes, not on a comment.
    // If somebody changes the cap in automation.ts, DECLINE_CAP here goes
    // stale and this is the test that says so.
    const caps = nightly.match(/\(failCount \?\? 0\) >= (\d+)/g) ?? [];
    expect(caps.length, "expected the reconcile door and the fee door").toBe(2);
    for (const c of caps) expect(Number(c.match(/(\d+)$/)![1])).toBe(DECLINE_CAP);
  });
});
