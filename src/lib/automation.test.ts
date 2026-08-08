import { describe, it, expect, vi, beforeEach } from "vitest";

// automation.ts is the I/O layer, so the test owns a FAKE Supabase: a tiny
// in-memory store behind the same chainable builder shape the runners use
// (from().select().eq()… awaited). No network, no next/server, no processor.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/payments", () => ({ LakeLifePayments: { charge: vi.fn(async () => ({ ok: true, ref: "ref_test" })) } }));
vi.mock("@/app/book/dispatch", () => ({
  revalidateJob: vi.fn(async () => {}),
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

// ---------------------------------------------------------------------------
// The fake Supabase.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const table = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};
/** Rows written by the runner under test, in order — the assertions read this. */
const writes: Array<{ table: string; op: string; patch?: Row; row?: Row }> = [];

interface Filter {
  kind: "eq" | "neq" | "in" | "is" | "not_is" | "lt" | "gte";
  col: string;
  val: unknown;
}
const matches = (row: Row, f: Filter): boolean => {
  const v = row[f.col];
  switch (f.kind) {
    case "eq": return v === f.val;
    case "neq": return v !== f.val;
    case "in": return (f.val as unknown[]).includes(v);
    case "is": return v == null;
    case "not_is": return v != null;
    case "lt": return String(v) < String(f.val);
    case "gte": return String(v) >= String(f.val);
  }
};

class Query implements PromiseLike<{ data: Row[] | Row | null; error: { message: string } | null; count?: number }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | null = null;
  private inserted: Row[] = [];
  private rangeFrom = 0;
  private rangeTo = Infinity;
  private limitN = Infinity;
  private wantSingle = false;
  private headCount = false;
  private orderCol: string | null = null;
  private orderAsc = true;

  constructor(private name: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.headCount = true;
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown) { this.filters.push({ kind: "eq", col, val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ kind: "neq", col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ kind: "in", col, val }); return this; }
  is(col: string, _val: null) { this.filters.push({ kind: "is", col, val: null }); return this; }
  not(col: string, _op: string, _val: null) { this.filters.push({ kind: "not_is", col, val: null }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ kind: "lt", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ kind: "gte", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending !== false; return this; }
  limit(n: number) { this.limitN = n; return this; }
  range(from: number, to: number) { this.rangeFrom = from; this.rangeTo = to; return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }

  private run(): { data: Row[] | Row | null; error: { message: string } | null; count?: number } {
    const rows = table(this.name);
    if (this.op === "insert") {
      const row: Row = { id: `${this.name}-${rows.length + 1}`, ...(this.payload ?? {}) };
      // Honour the ONE unique index the tests care about: waitlist_notice_log
      // (job_id, kind) — that index IS the exactly-once guarantee for 10d.
      if (this.name === "waitlist_notice_log" && rows.some((r) => r.job_id === row.job_id && r.kind === row.kind)) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint "waitlist_notice_log_once"' } };
      }
      rows.push(row);
      writes.push({ table: this.name, op: "insert", row });
      return { data: this.wantSingle ? row : [row], error: null };
    }
    let hit = rows.filter((r) => this.filters.every((f) => matches(r, f)));
    if (this.orderCol) {
      const col = this.orderCol;
      hit = [...hit].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1));
      if (!this.orderAsc) hit.reverse();
    }
    if (this.op === "update") {
      for (const r of hit) {
        Object.assign(r, this.payload);
        writes.push({ table: this.name, op: "update", patch: { ...this.payload }, row: r });
      }
      return { data: this.wantSingle ? hit[0] ?? null : hit, error: null };
    }
    if (this.op === "delete") {
      for (const r of hit) {
        const i = rows.indexOf(r);
        if (i >= 0) rows.splice(i, 1);
        writes.push({ table: this.name, op: "delete", row: r });
      }
      return { data: hit, error: null };
    }
    if (this.headCount) return { data: null, error: null, count: hit.length };
    const start = this.rangeFrom;
    const end = Math.min(this.rangeTo + 1, start + this.limitN);
    const page = hit.slice(start, Number.isFinite(end) ? end : undefined);
    return this.wantSingle ? { data: page[0] ?? null, error: null } : { data: page, error: null };
  }

  then<A, B>(res?: ((v: { data: Row[] | Row | null; error: { message: string } | null; count?: number }) => A | PromiseLike<A>) | null, rej?: ((r: unknown) => B | PromiseLike<B>) | null) {
    void this.inserted;
    return Promise.resolve(this.run()).then(res, rej);
  }
}

const fakeClient = { from: (name: string) => new Query(name) };
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => fakeClient }));

const { runReferralPayoutBatch, matureReferralEarnings, expireUnfilledJobs, learnServiceDurations, sendNightlyDigest } =
  await import("@/lib/automation");
const { sendSms } = await import("@/lib/sms");
const { sendEmail } = await import("@/lib/email");

const reset = () => {
  db.clear();
  writes.length = 0;
  vi.mocked(sendSms).mockClear();
  vi.mocked(sendEmail).mockClear();
};

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

beforeEach(reset);

// ---------------------------------------------------------------------------
// AUDIT BUG 4: "The referral payout batch silts up." Customer earnings already
// granted as CREDITS park at status='matured' forever, so they crowd crews and
// HOAs out of the batch's 500-row window and the people owed actual CASH stop
// getting paid as the credit ledger grows.
// ---------------------------------------------------------------------------
describe("referral payout batch — credit-settled earnings never silt up the window (audit bug 4)", () => {
  /** A crew with a bank account, waiting on real money. */
  const seedCrew = (userId: string) => {
    table("users").push({ id: userId, email: `${userId}@example.com`, name: userId });
    table("vendors").push({ id: `v-${userId}`, user_id: userId, company: `${userId} LLC` });
    table("payout_accounts").push({ user_id: userId, account_last4: "4242" });
  };
  /** A customer earning that was ALREADY settled as credits at maturation. */
  const seedCreditSettled = (n: number, from = 0) => {
    for (let i = from; i < from + n; i++) {
      const id = `earn-credit-${i}`;
      table("referral_earnings").push({ id, beneficiary: `cust-${i}`, amount: 25, kind: "customer_referral", status: "matured", matured_at: iso(400 - i) });
      table("user_credits").push({ id: `cr-${i}`, user_id: `cust-${i}`, amount: 25, earning_id: id });
      table("users").push({ id: `cust-${i}`, email: `cust-${i}@example.com`, name: `cust ${i}` });
    }
  };

  it("pays a crew buried behind 500+ credit-settled rows", async () => {
    seedCreditSettled(520);
    seedCrew("crew-1");
    // The crew's earning matured LAST — dead last in every ordering.
    table("referral_earnings").push({ id: "earn-cash", beneficiary: "crew-1", amount: 60, kind: "crew_referral", status: "matured", matured_at: iso(1) });

    const res = await runReferralPayoutBatch(true);

    expect(res.beneficiaries).toBe(1);
    expect(res.total).toBe(60);
    expect(table("referral_earnings").find((r) => r.id === "earn-cash")?.status).toBe("paid");
    // …and a batch artifact the banking layer can execute actually exists.
    const batches = table("payout_batches");
    expect(batches).toHaveLength(1);
    expect(batches[0].net).toBe(60);
  });

  it("closes credit-settled earnings out of 'matured' so the window drains for good", async () => {
    seedCreditSettled(12);
    seedCrew("crew-1");
    table("referral_earnings").push({ id: "earn-cash", beneficiary: "crew-1", amount: 10, kind: "crew_referral", status: "matured", matured_at: iso(1) });

    await runReferralPayoutBatch(true);

    const stillMatured = table("referral_earnings").filter((r) => r.status === "matured");
    expect(stillMatured).toEqual([]);
    // Closed out, not paid twice: no cash batch was built for a credit row.
    expect(table("payout_batches")).toHaveLength(1);
    expect(table("user_credits")).toHaveLength(12); // no second grant, ever
  });

  it("never double-pays: a credit-settled earning belonging to a CREW is closed, not banked", async () => {
    seedCrew("crew-1");
    table("referral_earnings").push({ id: "earn-both", beneficiary: "crew-1", amount: 40, kind: "crew_referral", status: "matured", matured_at: iso(2) });
    table("user_credits").push({ id: "cr-x", user_id: "crew-1", amount: 40, earning_id: "earn-both" });

    const res = await runReferralPayoutBatch(true);

    expect(res.total).toBe(0);
    expect(table("referral_earnings")[0].status).toBe("paid");
    expect(table("payout_batches")).toHaveLength(0); // empty batch unwound
  });

  it("leaves an un-credited customer earning alone (it is still real money owed)", async () => {
    table("users").push({ id: "cust-9", email: "c9@example.com" });
    table("referral_earnings").push({ id: "earn-uncredited", beneficiary: "cust-9", amount: 15, kind: "customer_referral", status: "matured", matured_at: iso(2) });

    await runReferralPayoutBatch(true);

    expect(table("referral_earnings")[0].status).toBe("matured");
  });
});

describe("matureReferralEarnings — a credit grant CLOSES the earning (audit bug 4, at the source)", () => {
  it("a customer earning granted as credits lands on 'paid', not parked at 'matured'", async () => {
    table("users").push({ id: "cust-1", email: "c1@example.com" });
    table("referral_earnings").push({ id: "e1", beneficiary: "cust-1", amount: 25, kind: "customer_referral", status: "accrued", accrued_at: iso(90) });

    const res = await matureReferralEarnings();

    expect(res.matured).toBe(1);
    expect(res.credited).toBe(1);
    expect(res.creditedAmount).toBe(25);
    expect(table("user_credits")).toHaveLength(1);
    expect(table("referral_earnings")[0].status).toBe("paid");
  });

  it("a CREW earning still parks at 'matured' — that one is real money awaiting a batch", async () => {
    table("users").push({ id: "crew-1", email: "v1@example.com" });
    table("vendors").push({ id: "v1", user_id: "crew-1" });
    table("referral_earnings").push({ id: "e2", beneficiary: "crew-1", amount: 60, kind: "crew_referral", status: "accrued", accrued_at: iso(90) });

    await matureReferralEarnings();

    expect(table("user_credits")).toHaveLength(0);
    expect(table("referral_earnings")[0].status).toBe("matured");
  });
});

// ---------------------------------------------------------------------------
// AUDIT BUG 10d: the waitlist warning had no ledger — a missed nightly lost it
// forever, a manual re-run re-texted everyone in the window.
// ---------------------------------------------------------------------------
describe("expireUnfilledJobs — the warning is exactly-once, and survives a missed night", () => {
  const seedJob = (dateISO: string) => {
    table("users").push({ id: "owner-1", phone: "+15551234567" });
    table("properties").push({ id: "p1", owner_id: "owner-1", address: "1 Lake Rd", nickname: "The cottage" });
    table("services").push({ id: "svc1", name: "Fall winterization" });
    table("jobs").push({ id: "job-1", date: dateISO, status: "requested", vendor_id: null, is_rush: false, group_id: null, services: { name: "Fall winterization" }, properties: { owner_id: "owner-1", address: "1 Lake Rd", nickname: "The cottage" } });
  };
  // Count from the LAKE's today, not the machine's. The engine reasons in
  // America/Indiana/Indianapolis (todayLakeDate); a fixture built on the local
  // clock silently drifts a day whenever the two disagree — which for any
  // machine west of Indiana is every evening. That made this suite pass all
  // afternoon and fail after 9pm Phoenix time, which is the worst kind of red.
  const inDays = (n: number) => {
    const lakeToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Indiana/Indianapolis",
    }).format(new Date());
    const [y, m, d] = lakeToday.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };

  it("texts once and records it", async () => {
    seedJob(inDays(2));
    const res = await expireUnfilledJobs();
    expect(res.warned).toBe(1);
    expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1);
    expect(table("waitlist_notice_log")).toHaveLength(1);
  });

  it("a manual re-run the same night does NOT re-text", async () => {
    seedJob(inDays(2));
    await expireUnfilledJobs();
    vi.mocked(sendSms).mockClear();
    const res = await expireUnfilledJobs();
    expect(res.warned).toBe(0);
    expect(vi.mocked(sendSms)).not.toHaveBeenCalled();
    expect(table("waitlist_notice_log")).toHaveLength(1);
  });

  it("a MISSED night is caught the next night — the warning is not lost forever", async () => {
    // The 2-days-out run never happened; tonight the job is 1 day out.
    seedJob(inDays(1));
    const res = await expireUnfilledJobs();
    expect(res.warned).toBe(1);
    expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AUDIT BUG 10c: learnServiceDurations coerced the stored dial with `|| 60`
// BEFORE learning, so a 0 dial could never be seen as invalid — let alone healed.
// ---------------------------------------------------------------------------
describe("learnServiceDurations — a 0 est_minutes dial heals from real samples", () => {
  it("writes the learned value over a stored 0 (the seeded per-diem row)", async () => {
    table("services").push({ id: "s-overstay", name: "Storage overstay (per-diem)", est_minutes: 0 });
    for (let i = 0; i < 6; i++) {
      table("jobs").push({
        id: `j${i}`, service_id: "s-overstay", status: "complete",
        started_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        completed_at: new Date(Date.now() - 3 * 86_400_000 + 60 * 60_000).toISOString(),
      });
    }

    const res = await learnServiceDurations();

    expect(res.updated).toBe(1);
    expect(res.changes[0]).toMatchObject({ service: "Storage overstay (per-diem)", from: 0, to: 60 });
    expect(table("services")[0].est_minutes).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// AUDIT BUG 10a/10b: the digest must carry the money, and must not lose the AI
// texts to a null head-count.
// ---------------------------------------------------------------------------
describe("sendNightlyDigest — money sections and the AI count fallback", () => {
  const base = {
    learning: { changes: [] },
    autoPricing: { changes: [] },
    disputeSweep: { fired: 0, escalated: 0 },
    routes: {},
    gapSla: { alerted: 0 },
  };
  const seedOps = () => table("users").push({ id: "ops-1", email: "ops@lakelife.test", role: "ops" });
  const lastHtml = () => (vi.mocked(sendEmail).mock.calls[0][0] as { html: string }).html;

  it("with nothing passed, the old callers still compile and still get a quiet night", async () => {
    seedOps();
    const res = await sendNightlyDigest(base);
    expect(res.sent).toBe(1);
    expect(lastHtml()).toContain("Quiet night");
  });

  it("carries a month-end payout batch into the email", async () => {
    seedOps();
    await sendNightlyDigest({ ...base, payoutBatch: { beneficiaries: 3, total: 412.5 }, monthlyPayouts: { batches: 7, total: 18_240.75 } });
    const html = lastHtml();
    expect(html).not.toContain("Quiet night");
    expect(html).toContain("$412.50");
    expect(html).toContain("$18240.75");
  });

  it("carries matured credits, collected cancellation fees and reconciled refunds", async () => {
    seedOps();
    await sendNightlyDigest({
      ...base,
      referrals: { credited: 4, creditedAmount: 100 },
      feeReconcile: { collected: 2, collectedAmount: 47.5 },
      refundReconcile: { orphansCleared: 1, flipsCompleted: 2 },
    });
    const html = lastHtml();
    expect(html).toContain("$100.00");
    expect(html).toContain("$47.50");
    expect(html).toContain("Refunds reconciled");
  });

  it("AI reply texts survive a head-count that comes back null", async () => {
    seedOps();
    // A message row exists, but the head-count path yields null in production
    // (PostgREST can return count: null) — the texts must still render.
    table("messages").push({ id: "m1", ai: true, body: "No charge for the visit.", created_at: new Date().toISOString() });
    await sendNightlyDigest(base);
    expect(lastHtml()).toContain("No charge for the visit.");
  });
});
