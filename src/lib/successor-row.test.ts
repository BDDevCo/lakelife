import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { successorRow, type PriorLink } from "./successor-row";

const prior: PriorLink = {
  id: "res-jan",
  park_lot_id: "lot-14",
  renter_id: "renter-doris",
  renter_unit_id: null,
  term: "monthly",
  quoted_amount: 400,
  agreement_chain_id: "chain-a",
  agreement_seq: 1,
  due_day: 15,
  tenancy_began_on: "2019-04-01",
  amount_source: "tenant_confirmed",
  amount_source_at: "2027-01-01T15:00:00Z",
};

const base = {
  start: "2027-02-01",
  end: "2027-03-01",
  status: "approved" as const,
  quotedAmount: 400,
  origin: "office" as const,
  continuesChain: true,
  nextSeq: 2,
  depositAmount: 300,
  nowISO: "2027-01-20T12:00:00Z",
};

describe("the household's own facts travel to the successor", () => {
  it("copies due day, move-in day and unit", () => {
    const row = successorRow(prior, base);
    expect(row.due_day).toBe(15);
    expect(row.tenancy_began_on).toBe("2019-04-01");
    expect(row.renter_unit_id).toBeNull();
    expect(row.during).toBe("[2027-02-01,2027-03-01)");
    expect(row.term).toBe("monthly");
  });

  it("a NULL due day travels as NULL — 'follow the park', not the park's number", () => {
    expect(successorRow({ ...prior, due_day: null }, base).due_day).toBeNull();
  });

  it("keeps 'confirmed with tenant' only while the rent is the same", () => {
    const same = successorRow(prior, base);
    expect(same.amount_source).toBe("tenant_confirmed");
    expect(same.amount_source_at).toBe("2027-01-01T15:00:00Z");

    const raised = successorRow(prior, { ...base, quotedAmount: 425 });
    expect(raised.amount_source).toBe("owner_knowledge");
    expect(raised.amount_source_at).toBe("2027-01-20T12:00:00Z");
    expect(raised.quoted_amount).toBe(425);
  });
});

describe("the chain", () => {
  it("a consecutive successor shares the chain, takes the next seq, carries no deposit", () => {
    const row = successorRow(prior, base);
    expect(row.agreement_chain_id).toBe("chain-a");
    expect(row.agreement_seq).toBe(2);
    expect(row.deposit_amount).toBeNull();
  });

  it("a prior with no chain id is its own chain", () => {
    expect(successorRow({ ...prior, agreement_chain_id: null }, base).agreement_chain_id).toBe("res-jan");
  });

  it("a gap starts a new chain by OMITTING the column, and the deposit is due", () => {
    const row = successorRow(prior, { ...base, continuesChain: false, nextSeq: 1 });
    // Sending null to a NOT NULL column with a default is a constraint
    // error, not a fresh chain — the key must be absent.
    expect("agreement_chain_id" in row).toBe(false);
    expect(row.agreement_seq).toBe(1);
    expect(row.deposit_amount).toBe(300);
  });
});

describe("origin is the door's fact", () => {
  it("is never copied from the prior row", () => {
    const row = successorRow({ ...prior, ...({ origin: "grandfathered" } as object) }, base);
    expect(row.origin).toBe("office");
  });
});

// ---------------------------------------------------------------------------
// THE DOORS THEMSELVES. A builder that is correct and uncalled is the project's
// third defect shape, so the two successor writers are exercised through their
// real entry points with a mock admin client, and it is the INSERT ARGUMENT
// they hand supabase that is asserted — never a rebuilt copy of it.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const inserted: Array<Row & { __table: string }> = [];
let TODAY = "2027-01-20";

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, op: string, v: unknown) {
    if (op === "is" && v === null) this.fs.push((r) => r[c] != null);
    return this;
  }
  gt(c: string, v: unknown) { this.fs.push((r) => (r[c] as number) > (v as number)); return this; }
  // A null column compares false both ways, as it does in Postgres.
  gte(c: string, v: unknown) { this.fs.push((r) => r[c] != null && (r[c] as string) >= (v as string)); return this; }
  lte(c: string, v: unknown) { this.fs.push((r) => (r[c] as string) <= (v as string)); return this; }
  order() { return this; }
  limit() { return this; }
  private rows(): Row[] { return (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))); }
  /** A failed read, once, on ONE table — `{ data: null, error }`, the shape
   *  supabase-js hands back, so the test can prove the caller does not treat
   *  it as an empty one. Armed by `failNext`. */
  private failed(): { data: null; error: { message: string } } | null {
    if (failNextWriteTable === this.t && this.patch) {
      failNextWriteTable = null;
      return { data: null, error: { message: `connection terminated (${this.t} update)` } };
    }
    if (failNextTable !== this.t) return null;
    failNextTable = null;
    return { data: null, error: { message: `connection terminated (${this.t})` } };
  }
  private ins: Row[] | null = null;
  maybeSingle() {
    const f = this.failed();
    if (f) return Promise.resolve(f);
    const rows = this.rows(); return Promise.resolve({ data: rows[0] ?? null, error: null });
  }
  /** `.insert(row)` awaited bare, or `.insert(row).select("id").single()` —
   *  the shape the owner's door reads the new row's id back with. */
  insert(row: Row | Row[]) { this.ins = Array.isArray(row) ? row : [row]; return this; }
  private written(): Row[] {
    return this.ins!.map((row) => {
      inserted.push({ ...row, __table: this.t });
      const w = { id: `new-${inserted.length}`, ...row };
      (db[this.t] ??= []).push(w);
      return w;
    });
  }
  single() {
    if (!this.ins) return this.maybeSingle();
    const [w] = this.written();
    return Promise.resolve({ data: w, error: null });
  }
  update(patch: Row) { this.patch = patch; return this; }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const f = this.failed();
    if (f) return Promise.resolve(f).then(ok, bad);
    if (this.ins) return Promise.resolve({ data: this.written(), error: null }).then(ok, bad);
    const rows = this.rows();
    if (this.patch) {
      for (const r of rows) Object.assign(r, this.patch);
      // Something else touching the database between two of the caller's
      // writes — the nightly, a second tap. Tests that model a race set it.
      afterWrite?.(this.t);
    }
    return Promise.resolve({ data: rows, error: null }).then(ok, bad);
  }
}
let afterWrite: ((table: string) => void) | null = null;
let failNextTable: string | null = null;
let failNextWriteTable: string | null = null;
/** The next read of `table` fails. One-shot, cleared by `seed`. */
const failNext = (table: string) => { failNextTable = table; };
/** The next UPDATE of `table` fails; reads on it in between still answer.
 *  One-shot, cleared by `seed`. */
const failNextWrite = (table: string) => { failNextWriteTable = table; };

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => ({ role: "owner" }) }));
// THE DOOR BILLS THE MONTHS IT MADE BILLABLE (gap-bills). The re-raise itself
// is charge-edits', tested there and in sign-actions.test.ts; here the two
// reads are spies, so what is asserted is what the owner's door ASKS: which
// months, on which row, and what it says back. The words are the real ones.
const gap = vi.hoisted(() => ({
  ran: false as boolean | { error: unknown; what: string },
  parkRanMonth: vi.fn(),
  billLostMonths: vi.fn(),
}));
vi.mock("@/app/park/gap-bills", async (orig) => ({
  ...(await orig<typeof import("@/app/park/gap-bills")>()),
  parkRanMonth: gap.parkRanMonth,
  billLostMonths: gap.billLostMonths,
}));
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => TODAY,
}));
// The nightly reminder lives in automation.ts, whose import graph reaches the
// processors and the dispatcher. Those are stubbed the way automation.test.ts
// stubs them; the one that matters here is `notify`, which captures the text.
const sent: Array<{ sms: string; subject: string; body?: string }> = [];
vi.mock("@/lib/notify", () => ({
  notify: vi.fn(async (_what: string, _to: unknown, msg: { sms: string; subject: string; body?: string }) => {
    sent.push(msg);
    return { reached: true, note: null };
  }),
}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/payments-server", () => ({ LakeLifePaymentsServer: { charge: vi.fn(async () => ({ ok: true })) } }));
vi.mock("@/app/book/dispatch", () => ({
  revalidateJob: vi.fn(async () => {}),
  autoAssignJob: vi.fn(async () => null),
  loadPricingProfileById: vi.fn(async () => null),
}));
vi.mock("@/app/vendor/onboarding-helpers", () => ({ coiRevalidationDue: () => false }));
vi.mock("@/app/requests/offer-data", () => ({ computeScarcityOffer: vi.fn(async () => null) }));
vi.mock("@/app/ops/data", () => ({ computeMenuSuggestions: vi.fn(async () => []) }));
vi.mock("@/lib/menu-core", () => ({ executeMenuUpdate: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/settings", () => ({ getPlatformSettings: vi.fn(async () => ({})) }));
// The card is rendered once below, as static markup — the words a person
// reads on /park/today, from the rows the real renewalsDue hands it.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { ok: () => {}, err: () => {} }) }));

const { renewAgreement, previewRenewal, renewalsDue } = await import("@/app/park/renew-actions");
const { ParkRenewals } = await import("@/components/ParkRenewals");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { extendByToken, loadExtendByToken } = await import("@/lib/extend-server");
const { cancelReRate } = await import("@/app/park/rerate-actions");
const { remindExpiringStays } = await import("@/lib/automation");
// The mocked transport, so a test can make a night on which no door is open.
const { notify } = await import("@/lib/notify");
// The page the text links to and the page after the tap — the REAL route
// handlers, so what is asserted is the HTML a resident reads.
const { GET: extendPage, POST: extendTap } = await import("@/app/x/[token]/route");
const { htmlPage } = await import("@/app/a/[token]/respond");

const TOKEN = "x" + "a".repeat(32);

/** Source with comments stripped — a comment describing the rule must never be
 *  what satisfies a scan for it. */
const root = join(__dirname, "..", "..");
const code = (p: string) =>
  readFileSync(join(root, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The Haven's Lot 14 in January: a one-month signed lease, a mid-month payer. */
function seed(over: Partial<Row> = {}) {
  for (const k of Object.keys(db)) delete db[k];
  inserted.length = 0;
  sent.length = 0;
  afterWrite = null;
  failNextTable = null;
  failNextWriteTable = null;
  db.park_payments = [];
  db.park_fees = [];
  gap.ran = false;
  gap.parkRanMonth.mockReset().mockImplementation(async () => gap.ran);
  gap.billLostMonths.mockReset().mockImplementation(async (_a: unknown, _p: string, _r: string, months: readonly string[]) => ({
    raised: months.map((month) => ({ month, amount: 400, fromOnAccount: 0, toOlderBills: [], settleProblem: null })),
    problems: [],
  }));
  // The Haven: a one-month house style under a three-month cap, so the
  // household picks one or three months (six once the cap is raised).
  db.parks = [{
    id: "park-1", name: "The Haven", max_agreement_months: 3, default_agreement_months: 1, deposit_amount: null,
    season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null,
  }];
  db.park_lots = [{
    id: "lot-14", lot_number: "14", park_id: "park-1", lifecycle: "live",
    season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null,
  }];
  db.park_renters = [{ id: "renter-doris", display_name: "Doris" }];
  db.lot_rates = [];
  db.lot_rent_changes = [];
  db.lot_reservations = [{
    id: "res-jan", park_lot_id: "lot-14", renter_id: "renter-doris", renter_unit_id: "unit-1",
    during: "[2027-01-01,2027-02-01)", status: "active", term: "monthly", quoted_amount: 400,
    origin: "application", agreement_chain_id: "chain-a", agreement_seq: 1,
    due_day: 15, tenancy_began_on: "2019-04-01",
    amount_source: "tenant_confirmed", amount_source_at: "2027-01-01T15:00:00Z",
    extend_token: TOKEN, extended_count: 0,
    ...over,
  }];
}

describe("renewAgreement — the owner's door", () => {
  beforeEach(() => { TODAY = "2027-01-20"; seed(); });

  it("carries the household's own facts onto the successor", async () => {
    const res = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(res.ok).toBe(true);
    const row = inserted.find((r) => r.__table === "lot_reservations")!;
    expect(row.due_day).toBe(15);
    expect(row.tenancy_began_on).toBe("2019-04-01");
    expect(row.renter_unit_id).toBe("unit-1");
    expect(row.amount_source).toBe("tenant_confirmed");
    expect(row.amount_source_at).toBe("2027-01-01T15:00:00Z");
    expect(row.during).toBe("[2027-02-01,2027-05-01)");
    expect(row.agreement_chain_id).toBe("chain-a");
    expect(row.agreement_seq).toBe(2);
    expect(row.quoted_amount).toBe(400);
    expect(row.status).toBe("approved");
  });

  it("a NULL due day travels as NULL, not as the park's number", async () => {
    seed({ due_day: null });
    await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(inserted[0].due_day).toBeNull();
  });

  it("a renewal at a new rent is the owner's knowledge as of now", async () => {
    await renewAgreement("park-1", "res-jan", { months: 3, newRent: "425" });
    const row = inserted[0];
    expect(row.quoted_amount).toBe(425);
    expect(row.amount_source).toBe("owner_knowledge");
    expect(typeof row.amount_source_at).toBe("string");
    expect(row.amount_source_at).not.toBe("2027-01-01T15:00:00Z");
  });

  it("origin is the door's fact — never copied from the prior row", async () => {
    seed({ origin: "application" });
    await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(inserted[0].origin).toBe("office");
  });

  it("a gap starts a new chain by OMITTING the column the database mints", async () => {
    // Sending agreement_chain_id: null to a NOT NULL column is a constraint
    // error, not a fresh chain — the old door did exactly that.
    TODAY = "2027-02-10";
    const res = await renewAgreement("park-1", "res-jan", { months: 3, startFrom: "2027-03-01" });
    expect(res.ok).toBe(true);
    const row = inserted[0];
    expect("agreement_chain_id" in row).toBe(false);
    expect(row.agreement_seq).toBe(1);
    expect(row.during).toBe("[2027-03-01,2027-06-01)");
  });

  it("REFUSES a household still on the seller's arrangement, and names the roll's control", async () => {
    seed({ origin: "grandfathered", during: "[2027-01-01,2028-01-01)" });
    TODAY = "2027-12-01";
    const res = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Lot 14 is still on the arrangement they had with the previous owner. When they " +
      "sign your new lease, record it from their row on the rent roll — 'They signed the new lease'.",
    );
    expect(inserted).toHaveLength(0);

    // And the Today card says the same sentence instead of offering a button.
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.ok).toBe(true);
    expect(pre.preview!.plan.ok).toBe(false);
    expect(pre.preview!.refusalText).toBe(res.error);
  });

  it("the inherited sentence wins even over 'already ended' — that one points at a door that duplicates the household", async () => {
    seed({ origin: "grandfathered", during: "[2027-01-01,2028-01-01)" });
    TODAY = "2028-02-01";
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.plan.refusal).toBe("inherited");
    expect(pre.preview!.refusalText).toMatch(/^Lot 14 is still on the arrangement/);
  });

  it("the toast reads the length and the dates in words", async () => {
    const res = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(res.signal).toBe("Lot 14 renewed for 3 months, February 1, 2027 to May 1, 2027 at $400.00 a month. Consecutive with the last one.");
  });

  // -------------------------------------------------------------------------
  // THE LENGTH IS THE HOUSEHOLD'S CHOICE. The owner's decision: one, three or
  // six months at every renewal. This door used to write the CAP — every
  // "Renew at the same rent" turned Doris's one-month January lease into a
  // three-month one, and would have made it six the day the cap was raised.
  // -------------------------------------------------------------------------
  it("writes ONE month when one month is chosen — not the cap", async () => {
    const res = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-02-01,2027-03-01)");
    expect(res.signal).toBe("Lot 14 renewed for 1 month, February 1, 2027 to March 1, 2027 at $400.00 a month. Consecutive with the last one.");
  });

  it("the Today card plans EVERY length the park offers, starting on the house style", async () => {
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.ok).toBe(true);
    expect(pre.preview!.defaultMonths).toBe(1);
    expect(pre.preview!.lengths.map((l) => l.months)).toEqual([1, 3]);
    expect(pre.preview!.lengths[0].plan).toMatchObject({ ok: true, start: "2027-02-01", end: "2027-03-01", termMonths: 1 });
    expect(pre.preview!.lengths[1].plan).toMatchObject({ ok: true, start: "2027-02-01", end: "2027-05-01", termMonths: 3 });
    // The card's headline plan is the house style's.
    expect(pre.preview!.plan.end).toBe("2027-03-01");
  });

  it("refuses six months at a cap of three, reading the cap from the PARK — and writes it once the cap is six", async () => {
    const six = await renewAgreement("park-1", "res-jan", { months: 6 });
    expect(six.ok).toBe(false);
    expect(six.error).toBe("This park writes agreements of 1 or 3 months — pick one of those.");
    expect(inserted).toHaveLength(0);

    db.parks[0].max_agreement_months = 6;
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.lengths.map((l) => l.months)).toEqual([1, 3, 6]);
    // Twelve is still not offered at six. Asked BEFORE the renewal is
    // written: once a successor exists, the planner refuses every length with
    // "Lot 14's next agreement is already written" — the right answer to a
    // second tap, and not the one this line is about.
    const twelve = await renewAgreement("park-1", "res-jan", { months: 12 });
    expect(twelve.ok).toBe(false);
    expect(twelve.error).toBe("This park writes agreements of 1, 3 or 6 months — pick one of those.");

    const raised = await renewAgreement("park-1", "res-jan", { months: 6 });
    expect(raised.ok, raised.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-02-01,2027-08-01)");
  });

  it("refuses a call with no length rather than writing the house style for them", async () => {
    const res = await renewAgreement("park-1", "res-jan", { months: undefined as unknown as number });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("This park writes agreements of 1 or 3 months — pick one of those.");
    expect(inserted).toHaveLength(0);
  });

  it("a refusal empties the lengths — the card offers nothing to pick", async () => {
    seed({ origin: "grandfathered", during: "[2027-01-01,2028-01-01)" });
    TODAY = "2027-12-01";
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.plan.ok).toBe(false);
    expect(pre.preview!.lengths).toEqual([]);
  });

  it("when the season cuts the chosen length short, the toast and the card say so — never '3 months' beside six weeks of dates", async () => {
    // A slip lot: the park closes 15 October. A three-month renewal from
    // 1 September runs six weeks, and the toast used to read "renewed for
    // 3 months, September 1, 2027 to October 15, 2027". THE NIGHT OF THE
    // 15TH IS SOLD — the booking gate lets a stay run through it — so the
    // agreement ends on the morning of the 16th (agreementSeasonEnd); the
    // inline arithmetic this door used to carry ended it a night early.
    seed({ during: "[2027-06-01,2027-09-01)" });
    db.parks[0].season_open_month = 4; db.parks[0].season_open_day = 15;
    db.parks[0].season_close_month = 10; db.parks[0].season_close_day = 15;
    TODAY = "2027-08-20";
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.ok, pre.error).toBe(true);
    const three = pre.preview!.lengths.find((l) => l.months === 3)!;
    expect(three.plan).toMatchObject({ ok: true, start: "2027-09-01", end: "2027-10-16", termMonths: 3, cutShortBySeason: true });
    // One month from 1 September ends 1 October — inside the season, not cut.
    expect(pre.preview!.lengths.find((l) => l.months === 1)!.plan).toMatchObject({ end: "2027-10-01", cutShortBySeason: false });

    const res = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-09-01,2027-10-16)");
    expect(res.signal).toBe(
      "Lot 14 renewed for 3 months, cut short by the season close — September 1, 2027 to October 16, 2027 at $400.00 a month. Consecutive with the last one.",
    );
  });

  it("the LOT's own season wins over the park's, and a window that wraps the New Year closes the year after it opens", async () => {
    // The pads are year-round; the slip closes 15 October. And a winter lot
    // (open November, close March) renewed in December closes the NEXT April
    // — the inline arithmetic put it in the start's year, already gone, and
    // refused a valid winter renewal as season_closed.
    seed({ during: "[2027-06-01,2027-09-01)" });
    db.park_lots[0].season_open_month = 4; db.park_lots[0].season_open_day = 15;
    db.park_lots[0].season_close_month = 10; db.park_lots[0].season_close_day = 15;
    TODAY = "2027-08-20";
    const slip = await previewRenewal("park-1", "res-jan");
    expect(slip.preview!.lengths.find((l) => l.months === 3)!.plan).toMatchObject({ end: "2027-10-16", cutShortBySeason: true });

    seed({ during: "[2027-09-01,2027-12-01)" });
    db.park_lots[0].season_open_month = 11; db.park_lots[0].season_open_day = 1;
    db.park_lots[0].season_close_month = 3; db.park_lots[0].season_close_day = 31;
    TODAY = "2027-11-20";
    const winter = await previewRenewal("park-1", "res-jan");
    expect(winter.ok, winter.error).toBe(true);
    expect(winter.preview!.plan.ok).toBe(true);
    expect(winter.preview!.lengths.find((l) => l.months === 3)!.plan).toMatchObject({ start: "2027-12-01", end: "2028-03-01", cutShortBySeason: false });
  });

  it("a plan refused for the picked length names the lengths the park offers, never 'no fixed-length agreements'", async () => {
    // The season closes 15 October and the prior runs to 1 November: every
    // length is refused season_closed at the house style, so the card shows
    // that sentence — and the button, asked anyway, says the same words.
    seed({ during: "[2027-08-01,2027-11-01)" });
    db.parks[0].season_open_month = 4; db.parks[0].season_open_day = 15;
    db.parks[0].season_close_month = 10; db.parks[0].season_close_day = 15;
    TODAY = "2027-10-01";
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.preview!.plan.refusal).toBe("season_closed");
    expect(pre.preview!.refusalText).toBe("That spot is closed for the season. You can book it again when the season opens.");
    const res = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(pre.preview!.refusalText);
    expect(inserted).toHaveLength(0);
  });
});

describe("renewalsDue — how far ahead the Today card asks (R2)", () => {
  // THE LEAD IS THE AGREEMENT'S OWN LAST HALF, CAPPED AT 45 DAYS. A flat 45
  // days listed a one-month renewal the morning it was written: he tapped
  // Renew on Lot 14, the toast said "renewed", the page refreshed, and Lot 14
  // was back in "Agreements to write" reading "ends March 1, 2027".
  beforeEach(() => { TODAY = "2027-01-20"; seed(); });

  const listed = async () => ((await renewalsDue("park-1")).rows ?? []).map((r) => `${r.lotNumber}:${r.priorEnd}`);

  it("a one-month agreement lists in its last ~15 days, not 45", async () => {
    // Jan 1 – Feb 1 is 31 days: asked from 16 January.
    TODAY = "2027-01-15";
    expect(await listed()).toEqual([]);
    TODAY = "2027-01-16";
    expect(await listed()).toEqual(["14:2027-02-01"]);
  });

  it("a just-written one-month successor is NOT listed — the tap visibly took", async () => {
    TODAY = "2027-01-20";
    expect(await listed()).toEqual(["14:2027-02-01"]);
    const res = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(res.ok, res.error).toBe(true);
    // The prior has its successor; the successor (Feb 1 – Mar 1, 28 days) is
    // asked from 15 February and not before.
    expect(await listed()).toEqual([]);
    TODAY = "2027-02-01";
    expect(await listed()).toEqual([]);
    TODAY = "2027-02-14";
    expect(await listed()).toEqual([]);
    TODAY = "2027-02-15";
    expect(await listed()).toEqual(["14:2027-03-01"]);
  });

  it("a three-month agreement still lists 45 days out — the cap", async () => {
    seed({ during: "[2027-02-01,2027-05-01)" });
    TODAY = "2027-03-16";
    expect(await listed()).toEqual([]);
    TODAY = "2027-03-17";
    expect(await listed()).toEqual(["14:2027-05-01"]);
  });

  it("the lead is read from each agreement's own span — two lots, two leads, one morning", async () => {
    db.park_lots.push({
      id: "lot-15", lot_number: "15", park_id: "park-1", lifecycle: "live",
      season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null,
    });
    db.lot_reservations.push({
      id: "res-15", park_lot_id: "lot-15", renter_id: "renter-doris", during: "[2027-01-01,2027-04-01)",
      status: "active", term: "monthly", quoted_amount: 400, origin: "application",
      agreement_chain_id: "chain-b", agreement_seq: 1,
    });
    // 20 January: Lot 14's one-month (ends 1 Feb, 12 days off) is due; Lot
    // 15's three-month (ends 1 Apr, 71 days off) is not.
    TODAY = "2027-01-20";
    expect(await listed()).toEqual(["14:2027-02-01"]);
    // 16 February: Lot 15 is 44 days out — inside its 45-day lead. Lot 14's
    // January agreement lapsed with nothing behind it and STAYS listed —
    // that is the quiet-rent-stop this list exists to make visible.
    TODAY = "2027-02-16";
    expect(await listed()).toEqual(["14:2027-02-01", "15:2027-04-01"]);
    const rows = (await renewalsDue("park-1")).rows!;
    // The lapsed one is still planned CONSECUTIVELY from its own end — the
    // household never left, and the successor covers the days since.
    expect(rows.find((r) => r.lotNumber === "14")!.plan).toMatchObject({ ok: true, start: "2027-02-01", continuesChain: true });
    expect(rows.find((r) => r.lotNumber === "15")!.plan).toMatchObject({ ok: true, start: "2027-04-01" });
  });
});

// ---------------------------------------------------------------------------
// A LAPSED AGREEMENT'S DOOR. Fifteen of the eighteen one-month leases from
// the Jan 1 plan lapse on 1 February if nobody renews them; on 17 June the
// card still said "ends February 1, 2027 … Next one: 1 month, February 1 to
// March 1. Consecutive, so no new deposit", the button wrote a row that was
// over three months before it existed, and the next morning the same card
// read "ends March 1" — one tap per lapsed month, June unbilled throughout.
// ---------------------------------------------------------------------------
describe("a lapsed agreement on the owner's card", () => {
  beforeEach(() => {
    seed();
    // The Haven's real dials: a six-month cap, one-month house style.
    db.parks[0].max_agreement_months = 6;
    TODAY = "2027-06-17";
  });

  const listed = async () => (await renewalsDue("park-1")).rows ?? [];

  it("says lapsed, not ends, and offers only the lengths that reach past today", async () => {
    const [row] = await listed();
    expect(row).toBeDefined();
    expect(row.lapsed).toBe(true);
    expect(row.priorEnd).toBe("2027-02-01");
    // One and three months from 1 February are over already; six reaches
    // 1 August. The card's headline is the shortest length that can be
    // written, and the refused ones say why.
    expect(row.lengths.map((l) => `${l.months}:${l.plan.ok ? l.plan.end : l.plan.refusal}`))
      .toEqual(["1:already_ended", "3:already_ended", "6:2027-08-01"]);
    expect(row.plan).toMatchObject({ ok: true, start: "2027-02-01", end: "2027-08-01", termMonths: 6, continuesChain: true });
    expect(row.refusalText).toBeNull();
  });

  it("refuses a length that is over already IN THE CARD'S OWN WORDS — naming the one that reaches — and instructs no door the card lacks", async () => {
    // A per-length refusal is not a total one: on 17 June one and three
    // months from 1 February are over, six reaches August. The toast for a
    // 1-month tap read "there's nothing to write from here" — the sentence
    // written for 'no length reaches' — while the card offered 6 months.
    const one = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(one.ok).toBe(false);
    expect(one.error).toBe("From February 1, 2027, 1 month would be over already — pick 6 months.");
    expect(one.error).not.toMatch(/Start a new one|nothing to write/);
    expect(inserted).toHaveLength(0);
    const three = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(three.ok).toBe(false);
    expect(three.error).toBe("From February 1, 2027, 3 months would be over already — pick 6 months.");
    expect(inserted).toHaveLength(0);
  });

  it("across midnight the stale chip's tap is refused for its own length, and the next length writes", async () => {
    // The card loaded on 28 February shows the 1-month chip (1 Feb – 1 Mar
    // is fine). The tap lands at 00:05 on 1 March: `end <= today` refuses
    // one month; three and six reach.
    TODAY = "2027-03-01";
    const one = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(one.ok).toBe(false);
    expect(one.error).toBe("From February 1, 2027, 1 month would be over already — pick 3 or 6 months.");
    expect(inserted).toHaveLength(0);
    const three = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(three.ok, three.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-02-01,2027-05-01)");
  });

  it("writes the length that reaches past today — consecutively, already ACTIVE because it has started, and BILLS the months the run has passed", async () => {
    const res = await renewAgreement("park-1", "res-jan", { months: 6 });
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-02-01,2027-08-01)");
    expect(inserted[0].agreement_chain_id).toBe("chain-a");
    expect(inserted[0].agreement_seq).toBe(2);
    // ONE RULE with the resident's door: approved until it starts, active
    // from its first morning. This door hardcoded `approved`.
    expect(inserted[0].status).toBe("active");
    // THE MONEY FACT (decision 3): one tap made February–June billable at
    // the rent, and the run keys its bills on the row — so the door bills
    // them, on the row it just wrote, oldest first. June's run has not
    // happened (gap.ran is false), so June is the run's.
    expect(gap.billLostMonths).toHaveBeenCalledTimes(1);
    expect(gap.billLostMonths.mock.calls[0].slice(1)).toEqual(["park-1", "new-1", ["2027-02", "2027-03", "2027-04", "2027-05"]]);
    expect(res.signal).toBe(
      "Lot 14 renewed for 6 months, February 1, 2027 to August 1, 2027 at $400.00 a month. Consecutive with the last one. " +
      "February 2027, March 2027, April 2027 and May 2027 are now billed — $400.00, $400.00, $400.00 and $400.00 ($1,600.00 in all).",
    );
    expect(res.signal).not.toMatch(/nothing has billed/);
    // No treadmill: the lot is not back on the card tomorrow reading "ends
    // March 1" — the six-month successor is its own agreement, listed on its
    // own lead (Aug 1 is 45 days out on 17 June, so it IS due, as itself).
    TODAY = "2027-06-18";
    const rows = await listed();
    expect(rows.map((r) => `${r.lotNumber}:${r.priorEnd}:${r.lapsed}`)).toEqual(["14:2027-08-01:false"]);
  });

  it("when no length reaches past today the card shows the sentence, not buttons — and claims no 'so long ago'", async () => {
    db.parks[0].max_agreement_months = 3;
    const [row] = await listed();
    expect(row.plan.ok).toBe(false);
    expect(row.plan.refusal).toBe("already_ended");
    expect(row.lengths).toEqual([]);
    expect(row.refusalText).toBe(
      "That agreement has run out, and even the longest agreement this park writes, run from its end, would be over already — there's nothing to write from here.",
    );
    // The same sentence one day past the only length a park writes — not "so long ago".
    db.parks[0].max_agreement_months = 1; TODAY = "2027-03-02";
    const [oneDay] = await listed();
    expect(oneDay.refusalText).not.toMatch(/so long ago/);
    expect(oneDay.refusalText).toMatch(/nothing to write from here/);
    expect((await renewAgreement("park-1", "res-jan", { months: 1 })).error).toBe(oneDay.refusalText);
  });

  it("a fresh start after the gap is NOT toasted 'Consecutive', and mentions a deposit only when one is due", async () => {
    // No screen passes startFrom yet — the plumbing is exercised so the day
    // one does, the toast tells the truth. The Haven's deposit dial is null.
    const res = await renewAgreement("park-1", "res-jan", { months: 1, startFrom: "2027-07-01" });
    expect(res.ok, res.error).toBe(true);
    expect("agreement_chain_id" in inserted[0]).toBe(false);
    expect(res.signal).toBe(
      "Lot 14 renewed for 1 month, July 1, 2027 to August 1, 2027 at $400.00 a month. Starts a new chain — there was a gap after February 1, 2027.",
    );
    expect(res.signal).not.toMatch(/Consecutive|deposit/);

    // A park that takes a deposit says so, with the number.
    seed(); db.parks[0].max_agreement_months = 6; db.parks[0].deposit_amount = 300;
    const dep = await renewAgreement("park-1", "res-jan", { months: 1, startFrom: "2027-07-01" });
    expect(dep.signal).toMatch(/Starts a new chain — there was a gap after February 1, 2027\. A deposit of \$300\.00 is due\.$/);
    expect(inserted[0].deposit_amount).toBe(300);
  });

  it("the boundary is the plan's end, not the prior's: one day lapsed still backfills — and the current month is the run's until its run has happened", async () => {
    TODAY = "2027-02-02";
    const [row] = await listed();
    expect(row.lapsed).toBe(true);
    expect(row.plan).toMatchObject({ ok: true, start: "2027-02-01", end: "2027-03-01", termMonths: 1 });
    // February's run has not happened: nothing is behind, and the card
    // says the month bills when he bills the month.
    expect(row.lostMonths).toEqual([]);
    expect(row.backfillNote).toBe("It reaches back to February 1, 2027; February 2027 bills when you bill the month.");
    const res = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-02-01,2027-03-01)");
    expect(inserted[0].status).toBe("active");
    expect(gap.billLostMonths).toHaveBeenCalledWith(expect.anything(), "park-1", "new-1", []);
    expect(res.signal).toMatch(/Consecutive with the last one\.$/);

    // February's run HAS happened (a bill stands on some lot): February is
    // a month no run comes back for, so the card names it and the tap bills it.
    seed(); db.parks[0].max_agreement_months = 6; gap.ran = true;
    const [ranRow] = await listed();
    expect(ranRow.lostMonths).toEqual(["2027-02"]);
    expect(ranRow.backfillNote).toBe("Writing it bills this agreement for February 2027 — nothing has billed it for that month yet.");
    const after = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(after.ok, after.error).toBe(true);
    expect(gap.billLostMonths).toHaveBeenLastCalledWith(expect.anything(), "park-1", "new-1", ["2027-02"]);
    expect(after.signal).toMatch(/Consecutive with the last one\. February 2027 is now billed — \$400\.00\.$/);

    // And an agreement that has NOT lapsed is not called lapsed, and carries
    // no such note — nor does one written before it starts.
    seed(); db.parks[0].max_agreement_months = 6; TODAY = "2027-01-20";
    const [ahead] = await listed();
    expect(ahead.lapsed).toBe(false);
    expect(ahead.lostMonths).toEqual([]);
    expect(ahead.backfillNote).toBeNull();
    const early = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(early.signal).not.toMatch(/reaches back|billed/);
  });

  it("whether this month ran is read ONCE for the whole list, and once per tap", async () => {
    db.park_lots.push({ id: "lot-15", lot_number: "15", park_id: "park-1", lifecycle: "live",
      season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null });
    db.lot_reservations.push({
      id: "res-15", park_lot_id: "lot-15", renter_id: "renter-doris", during: "[2027-01-01,2027-02-01)",
      status: "active", term: "monthly", quoted_amount: 400, origin: "application", agreement_chain_id: "chain-b", agreement_seq: 1,
    });
    const rows = await listed();
    expect(rows).toHaveLength(2);
    expect(gap.parkRanMonth).toHaveBeenCalledTimes(1);
    expect(gap.parkRanMonth.mock.calls[0].slice(1)).toEqual(["park-1", "2027-06"]);
    gap.parkRanMonth.mockClear();
    await renewAgreement("park-1", "res-jan", { months: 6 });
    expect(gap.parkRanMonth).toHaveBeenCalledTimes(1);
  });

  it("a failed read of whether this month ran is a sentence, never 'bills when you bill the month' about a month that ran", async () => {
    gap.ran = { error: { message: "connection terminated" }, what: "the bills already raised this month" };
    const pre = await previewRenewal("park-1", "res-jan");
    expect(pre.ok).toBe(false);
    expect(pre.error).toMatch(/couldn't/i);
    expect(pre.preview).toBeUndefined();
    const res = await renewAgreement("park-1", "res-jan", { months: 6 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(pre.error);
    expect(inserted).toHaveLength(0);
    expect(gap.billLostMonths).not.toHaveBeenCalled();
    // The list stops rather than dropping the household — its caller is a
    // page under the error boundary.
    await expect(renewalsDue("park-1")).rejects.toThrow(/the bills already raised this month/);
  });

  it("what the tap could not bill is said with its door, after what it did", async () => {
    gap.billLostMonths.mockImplementation(async () => ({
      raised: [{ month: "2027-02", amount: 400, fromOnAccount: 150, toOlderBills: [], settleProblem: null }],
      problems: [{ month: "2027-03", reason: "no rent is set for the lot — set their rent on the roll, then bill it from the rent screen", why: "noRent" }],
    }));
    const res = await renewAgreement("park-1", "res-jan", { months: 6 });
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toMatch(
      /Consecutive with the last one\. February 2027 is now billed — \$400\.00, \$150\.00 of it settled from money on account\. ⚠️ March 2027 couldn't be billed — no rent is set for the lot — set their rent on the roll, then bill it from the rent screen\.$/,
    );
  });
});

describe("extendByToken — the resident's door — bills the remainder of the month it made billable", () => {
  // The tap lands on the agreement's last day (extend-stay refuses only a
  // stay already ended), so the successor starts TODAY. When this month's
  // run has already happened, the run visited the month before the row
  // existed and keys "already billed" per reservation — nothing else would
  // ever raise the remainder. Three doors write successors; this was the
  // one that did not bill what it made billable.
  beforeEach(() => {
    seed({ during: "[2027-01-01,2027-01-20)" });
    db.parks[0].cutover_date = "2027-01-01";
    TODAY = "2027-01-20";
  });

  it("the view carries the park and its go-live day — what the tap bills against, and the floor", async () => {
    const view = await loadExtendByToken(TOKEN, 1);
    expect(view!.parkId).toBe("park-1");
    expect(view!.cutoverDate).toBe("2027-01-01");
    expect(view!.newStart).toBe("2027-01-20");
  });

  it("after January's run, the tap bills January on the row it just wrote", async () => {
    gap.ran = true;
    const res = await extendByToken(TOKEN, 1);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-01-20,2027-02-20)");
    expect(gap.parkRanMonth.mock.calls[0].slice(1)).toEqual(["park-1", "2027-01"]);
    expect(gap.billLostMonths).toHaveBeenCalledTimes(1);
    expect(gap.billLostMonths.mock.calls[0].slice(1)).toEqual(["park-1", "new-1", ["2027-01"]]);
  });

  it("before the run, nothing is behind — January is the run's", async () => {
    gap.ran = false;
    const res = await extendByToken(TOKEN, 1);
    expect(res.ok).toBe(true);
    expect(gap.billLostMonths).toHaveBeenCalledWith(expect.anything(), "park-1", "new-1", []);
  });

  it("a month before go-live is never billed here — the floor is the park's cutover", async () => {
    db.parks[0].cutover_date = "2027-02-01";
    gap.ran = true;
    await extendByToken(TOKEN, 1);
    expect(gap.billLostMonths).toHaveBeenCalledWith(expect.anything(), "park-1", "new-1", []);
  });

  it("a failed read of whether this month ran is logged — the successor stands, nothing is billed, nothing is sent", async () => {
    gap.ran = { error: { message: "connection terminated" }, what: "the bills already raised this month" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await extendByToken(TOKEN, 1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("the bills already raised this month"), expect.anything());
    spy.mockRestore();
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(gap.billLostMonths).not.toHaveBeenCalled();
  });

  it("the source: the successor insert reads its id back, and the bill runs on it (never on the prior row)", () => {
    const src = code("src/lib/extend-server.ts");
    expect(src).toMatch(/const \{ data: succ, error: insErr \} = await admin\.from\("lot_reservations"\)\.insert\(successorRow\(/);
    expect(src).toMatch(/\)\)\.select\("id"\)\.single\(\);/);
    expect(src).toMatch(/billLostMonths\(admin, view\.parkId, succ\.id as string, lostMonths\(view\.newStart, today, view\.cutoverDate, ran\)\)/);
  });
});

// A MOVE-OUT INSIDE A SUCCESSOR marks only that link `ended` (planMoveOut
// trims it and withdraws the later ones) and leaves the expired prior held,
// run out, with nothing held after it. Read from held rows alone that is
// the lapsed shape: the family who left on 10 February sat under
// "Agreements to write", and the tap — a public endpoint — would have
// written a successor from 1 February over them and billed every month since.
describe("a household closed out of its successor has moved out — nothing to renew", () => {
  const feb = (status: string) => ({
    id: "res-feb", park_lot_id: "lot-14", renter_id: "renter-doris", renter_unit_id: "unit-1",
    during: "[2027-02-01,2027-02-11)", status, term: "monthly", quoted_amount: 400,
    origin: "office", agreement_chain_id: "chain-a", agreement_seq: 2,
    due_day: 15, tenancy_began_on: "2019-04-01", amount_source: "tenant_confirmed", amount_source_at: "2027-01-01T15:00:00Z",
    extend_token: null, extended_count: 0, moved_out_on: status === "ended" ? "2027-02-10" : null,
  });
  beforeEach(() => { seed(); db.parks[0].max_agreement_months = 6; TODAY = "2027-03-16"; gap.ran = true; });

  it("is not listed, the preview refuses, and the tap writes nothing and bills nothing", async () => {
    db.lot_reservations.push(feb("ended"));
    expect((await renewalsDue("park-1")).rows).toEqual([]);
    const p = await previewRenewal("park-1", "res-jan");
    expect(p.ok).toBe(true);
    expect(p.preview!.plan).toEqual({ ok: false, refusal: "moved_out" });
    expect(p.preview!.refusalText).toBe("Lot 14 was closed out after this agreement — they moved out — so there's nothing to renew.");
    expect(p.preview!.lengths).toEqual([]);
    expect(p.preview!.lostMonths).toEqual([]);
    expect(p.preview!.backfillNote).toBeNull();
    const res = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Lot 14 was closed out after this agreement — they moved out — so there's nothing to renew.");
    expect(inserted).toHaveLength(0);
    expect(gap.billLostMonths).not.toHaveBeenCalled();
  });

  it("collapsed the other way: the same successor WITHDRAWN leaves January lapsed and renewable", async () => {
    db.lot_reservations.push(feb("cancelled"));
    const rows = (await renewalsDue("park-1")).rows!;
    expect(rows.map((r) => r.reservationId)).toEqual(["res-jan"]);
    expect(rows[0].lapsed).toBe(true);
    expect(rows[0].plan.ok).toBe(true);
    const res = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-02-01,2027-05-01)");
  });

  it("an ended link EARLIER in the chain is history, not a close-out", async () => {
    // Seq 0 never happens, but an earlier ended link can: the prior of a
    // prior, closed by the old one-click path. The latest link is what counts.
    db.lot_reservations.push({ ...feb("ended"), id: "res-dec", during: "[2026-12-01,2026-12-20)", agreement_seq: 0, moved_out_on: null });
    const rows = (await renewalsDue("park-1")).rows!;
    expect(rows.map((r) => r.reservationId)).toEqual(["res-jan"]);
    expect(rows[0].plan.ok).toBe(true);
  });
});

describe("the card's own words for a lapsed agreement", () => {
  beforeEach(() => { seed(); db.parks[0].max_agreement_months = 6; });
  const card = async () => renderToStaticMarkup(createElement(ParkRenewals, { parkId: "park-1", rows: (await renewalsDue("park-1")).rows ?? [] }));

  it("says lapsed, names the lengths that are over, and offers only the one that reaches past today", async () => {
    TODAY = "2027-06-17";
    const html = await card();
    expect(html).toContain("This one has lapsed with nothing behind it — nothing has been billed to the household since.");
    expect(html).toContain("lapsed February 1, 2027 — nothing billed since");
    expect(html).not.toContain("ends February 1, 2027");
    expect(html).not.toContain("run out soon");
    expect(html).toContain("Next one: 6 months, February 1, 2027 to August 1, 2027. Consecutive with the last one. Writing it bills this agreement for February 2027, March 2027, April 2027 and May 2027 — nothing has billed it for those months yet.");
    expect(html).toContain("From February 1, 2027, 1 or 3 months would be over already, so only 6 months reaches past today.");
    expect(html).not.toMatch(/no new deposit|New chain/);
    // No chip for a length that cannot be written; one length is not a choice.
    expect(html).not.toContain("Renew for</span>");
    expect(html).toContain("Renew at the same rent");
  });

  // "IF THERE IS ANY" — the card promised "Writing it bills this agreement
  // for February 2027" over a row with no rent, beside a "Renew at the same
  // rent" button; the tap wrote the successor with no rent and the toast
  // said February couldn't be billed. Same for a row filed as paid yearly:
  // the successor copies the term, the run bills months only.
  it("a row with NO RENT promises nothing, names the door on the same card, and the same-rent button says what it writes", async () => {
    TODAY = "2027-03-16"; gap.ran = true;
    db.lot_reservations[0].quoted_amount = null;
    const html = await card();
    expect(html).toContain("No rent is set, so writing it can&#x27;t bill February 2027 and March 2027 — use Renew at a new rent and type what they pay.");
    expect(html).not.toContain("Writing it bills this agreement");
    expect(html).toContain("Renew with no rent set");
    expect(html).not.toContain("Renew at the same rent");
    expect(html).toContain("Renew at a new rent");
    // The tap at "the same rent" still writes what it says — no rent — and
    // the same-rent refusal names the button by the label it had.
    const res = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].quoted_amount).toBeNull();
    // Typing a rent on the door the note names is what makes February bill.
    seed(); db.parks[0].max_agreement_months = 6; gap.ran = true; db.lot_reservations[0].quoted_amount = null;
    const typed = await renewAgreement("park-1", "res-jan", { months: 3, newRent: "425" });
    expect(typed.ok, typed.error).toBe(true);
    expect(inserted[0].quoted_amount).toBe(425);
    // Collapsed the other way: with a rent, the promise stands.
    seed(); db.parks[0].max_agreement_months = 6; gap.ran = true;
    expect(await card()).toContain("Writing it bills this agreement for February 2027 and March 2027 — nothing has billed it for those months yet.");
  });

  it("a row filed as paid yearly promises nothing — the run's own sentence, Edit on the roll — and a nightly one is priced per stay", async () => {
    TODAY = "2027-03-16"; gap.ran = true;
    db.lot_reservations[0].term = "annual"; db.lot_reservations[0].quoted_amount = 3300;
    const [row] = (await renewalsDue("park-1")).rows!;
    expect(row.backfillNote).toBe(
      "Writing it won't bill February 2027 and March 2027: Lot 14 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent.",
    );
    expect(row.backfillNote).not.toMatch(/Writing it bills/);
    // The successor still copies the term — the sentence is true of the row written.
    const res = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].term).toBe("annual");
    seed(); db.parks[0].max_agreement_months = 6; gap.ran = true;
    db.lot_reservations[0].term = "nightly"; db.lot_reservations[0].quoted_amount = 80;
    const [night] = (await renewalsDue("park-1")).rows!;
    expect(night.backfillNote).toContain("priced per stay, not by the month");
    expect(night.backfillNote).not.toMatch(/Edit on the roll|monthly rent/);
  });

  it("with one length over and two that reach, the sentence is singular and the chips are the two", async () => {
    // 2 March: one month from 1 February ended yesterday; three and six reach.
    TODAY = "2027-03-02";
    const html = await card();
    expect(html).toContain("From February 1, 2027, 1 month would be over already, so it isn&#x27;t offered here.");
    expect(html).not.toContain("those aren&#x27;t");
    expect(html).toContain("Renew for</span>");
    expect(html).toContain(">3 months<");
    expect(html).toContain(">6 months<");
    expect(html).not.toContain(">1 month<");
    // The headline is the shortest that reaches, and February is named as unbilled.
    // February is behind; March's run has not happened, so it is not named.
    expect(html).toContain("Next one: 3 months, February 1, 2027 to May 1, 2027. Consecutive with the last one. Writing it bills this agreement for February 2027 — nothing has billed it for that month yet.");
  });

  it("splits the heading when some have lapsed and some are running out", async () => {
    db.park_lots.push({ id: "lot-15", lot_number: "15", park_id: "park-1", lifecycle: "live",
      season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null });
    db.lot_reservations.push({
      id: "res-15", park_lot_id: "lot-15", renter_id: "renter-doris", during: "[2027-06-01,2027-07-01)",
      status: "active", term: "monthly", quoted_amount: 400, origin: "application", agreement_chain_id: "chain-b", agreement_seq: 1,
    });
    TODAY = "2027-06-17";
    const html = await card();
    expect(html).toContain("1 of these has lapsed — nothing has been billed to that household since. The rest run out soon and have nothing behind them.");
    // Lapsed first, then the one ending.
    expect(html.indexOf("lapsed February 1, 2027")).toBeLessThan(html.indexOf("ends July 1, 2027"));
    // The un-lapsed row offers every length as chips, starting on the house style.
    expect(html).toContain("Next one: 1 month, July 1, 2027 to August 1, 2027. Consecutive with the last one.");
    expect(html).toContain("Renew for</span>");
  });

  it("with nothing lapsed the heading is the old one, and the card never quotes a deposit that is not due", async () => {
    TODAY = "2027-01-20";
    const html = await card();
    expect(html).toContain("These run out soon and have nothing behind them.");
    expect(html).toContain("ends February 1, 2027");
    expect(html).not.toMatch(/lapsed|deposit/);
  });
});

// ---------------------------------------------------------------------------
// "WRITE IT" WITH THE BOX EMPTY. The new-rent input shows the current rent as
// a grey placeholder, and a press with nothing typed filed the OLD rent under
// a toast identical to a change — the placeholder wrote itself, and no
// screen after names the successor's rent before it bills.
// ---------------------------------------------------------------------------
describe("the new-rent door", () => {
  beforeEach(() => { TODAY = "2027-01-20"; seed(); });

  it("refuses a blank on the new-rent door and writes nothing", async () => {
    for (const blank of ["", "   "]) {
      const res = await renewAgreement("park-1", "res-jan", { months: 1, newRent: blank });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("Type the new rent, or use Renew at the same rent.");
      expect(res.error).not.toMatch(/try again/i);
    }
    expect(inserted).toHaveLength(0);
  });

  it("the same-rent door — no field sent at all — still writes in one tap", async () => {
    const res = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].quoted_amount).toBe(400);
  });

  it("both toasts name the rent written, and a change says what it was", async () => {
    const changed = await renewAgreement("park-1", "res-jan", { months: 3, newRent: "425" });
    expect(changed.ok, changed.error).toBe(true);
    expect(changed.signal).toBe(
      "Lot 14 renewed for 3 months, February 1, 2027 to May 1, 2027 at $425.00 a month (was $400.00). Consecutive with the last one.",
    );
    expect(inserted[0].quoted_amount).toBe(425);
    seed();
    const same = await renewAgreement("park-1", "res-jan", { months: 3 });
    expect(same.signal).toContain("at $400.00 a month. Consecutive");
    expect(same.signal).not.toContain("(was");
  });

  it("the card's 'Write it' is off while the box is empty (source)", () => {
    const card = code("src/components/ParkRenewals.tsx");
    expect(card).toMatch(/disabled=\{busy \|\| !rent\.trim\(\)\}\s*onClick=\{\(\) => renew\(r, rent\)\}>Write it/);
  });
});

describe("the successor's rent is the rent IN FORCE at its start", () => {
  /** The finding's dates: Feb 5 he schedules $425 from Apr 1 on the Feb–May
   *  row and records notice; Mar 17 Today lists it (May 1 is within 45 days). */
  function seedFebMay() {
    seed({
      id: "res-feb", during: "[2027-02-01,2027-05-01)", agreement_seq: 2,
      amount_source: "owner_knowledge", amount_source_at: null,
    });
    db.lot_rent_changes = [{
      id: "c1", park_id: "park-1", reservation_id: "res-feb",
      effective_on: "2027-04-01", from_amount: 400, to_amount: 425,
      notice_given_on: "2027-02-05", applied_at: null, cancelled_at: null,
      created_at: "2027-02-05T10:00:00Z",
    }];
    TODAY = "2027-03-17";
  }

  beforeEach(() => seedFebMay());

  it("renewAgreement writes the served increase, not the pre-increase copy", async () => {
    const res = await renewAgreement("park-1", "res-feb", { months: 3 });
    expect(res.ok).toBe(true);
    expect(inserted[0].quoted_amount).toBe(425);
    expect(inserted[0].during).toBe("[2027-05-01,2027-08-01)");
  });

  it("the Today card shows the same number the button writes", async () => {
    const pre = await previewRenewal("park-1", "res-feb");
    expect(pre.preview!.quotedAmount).toBe(425);
    expect(pre.preview!.priorQuotedAmount).toBe(400);
    expect(pre.preview!.rentChangeOn).toBe("2027-04-01");
  });

  it("an increase nobody has been told about is not history yet", async () => {
    db.lot_rent_changes[0].notice_given_on = null;
    await renewAgreement("park-1", "res-feb", { months: 3 });
    expect(inserted[0].quoted_amount).toBe(400);
    const pre = await previewRenewal("park-1", "res-feb");
    expect(pre.preview!.priorQuotedAmount).toBe(400);
    expect(pre.preview!.rentChangeOn).toBeNull();
  });

  it("a cancelled increase is not history either", async () => {
    db.lot_rent_changes[0].cancelled_at = "2027-03-01T00:00:00Z";
    await renewAgreement("park-1", "res-feb", { months: 3 });
    expect(inserted[0].quoted_amount).toBe(400);
  });

  it("extendByToken — the resident's door — writes the same rent and the same facts", async () => {
    const res = await extendByToken(TOKEN, 3);
    expect(res.ok).toBe(true);
    const row = inserted.find((r) => r.__table === "lot_reservations")!;
    expect(row.quoted_amount).toBe(425);
    expect(row.due_day).toBe(15);
    expect(row.tenancy_began_on).toBe("2019-04-01");
    expect(row.renter_unit_id).toBe("unit-1");
    expect(row.origin).toBe("office");
    expect(row.agreement_chain_id).toBe("chain-a");
    expect(row.agreement_seq).toBe(3);
    // ONE RULE with the owner's door: a successor that has not started is
    // `approved`. This door wrote `active` for the same fact.
    expect(row.status).toBe("approved");
    expect(row.during).toBe("[2027-05-01,2027-08-01)");
    // A successor at a NEW number is the owner's knowledge, not confirmed.
    expect(row.amount_source).toBe("owner_knowledge");
  });

  it("extendByToken at an unchanged rent keeps the confirmation", async () => {
    db.lot_rent_changes = [];
    db.lot_reservations[0].amount_source = "tenant_confirmed";
    db.lot_reservations[0].amount_source_at = "2027-02-01T15:00:00Z";
    await extendByToken(TOKEN, 3);
    const row = inserted[0];
    expect(row.quoted_amount).toBe(400);
    expect(row.amount_source).toBe("tenant_confirmed");
    expect(row.amount_source_at).toBe("2027-02-01T15:00:00Z");
  });

  it("the resident's page shows the number the tap writes — the served increase, not the pre-increase copy", async () => {
    // The page used to print `quoted_amount` off the prior row ("for $400")
    // while the tap wrote the rent in force at the successor's start ($425).
    const view = await loadExtendByToken(TOKEN);
    expect(view!.refusal).toBeNull();
    expect(view!.isRenewal).toBe(true);
    expect(view!.price).toBe(425);
    await extendByToken(TOKEN, 3);
    expect(inserted[0].quoted_amount).toBe(view!.price);
  });

  it("the resident's page prefers their own rent to the park's asking rate on a renewal", async () => {
    // The card is the asking rate for a NEW tenant. Writing it onto a sitting
    // tenant's renewal would be a rent change with no notice served — and the
    // page would say one number while the tap wrote another.
    db.lot_rates = [{ park_lot_id: "lot-14", term: "monthly", amount: 500 }];
    const view = await loadExtendByToken(TOKEN);
    expect(view!.price).toBe(425);
    await extendByToken(TOKEN, 3);
    expect(inserted[0].quoted_amount).toBe(425);
  });

  it("with no rent on file and no history, the card is the only number — shown and written", async () => {
    db.lot_rent_changes = [];
    db.lot_reservations[0].quoted_amount = null;
    db.lot_rates = [{ park_lot_id: "lot-14", term: "monthly", amount: 500 }];
    const view = await loadExtendByToken(TOKEN);
    expect(view!.price).toBe(500);
    await extendByToken(TOKEN, 3);
    expect(inserted[0].quoted_amount).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// CALLING AN INCREASE OFF after a renewal has already carried it. The
// successor doors write the rent IN FORCE at their start, so on 17 March a
// served $425-from-1-April lands on the May–August row. If he calls the
// increase off on the 25th, April bills $400 (a cancelled change is not
// history) — and the May row must come back to $400 too, or the increase he
// cancelled bills from May with nothing pending on any screen.
// ---------------------------------------------------------------------------
describe("cancelReRate mirrors the carry-down", () => {
  /** The clock the successor doors stamp `amount_source_at` with. Real time is
   *  2026 and the walk is in 2027, so a successor stamped "now" would sit
   *  BEFORE a change scheduled in February 2027 and read as one he typed. */
  const at = (iso: string) => { TODAY = iso.slice(0, 10); vi.setSystemTime(new Date(`${iso}Z`)); };

  const CHANGE = {
    id: "c1", park_id: "park-1", reservation_id: "res-feb",
    effective_on: "2027-04-01", from_amount: 400, to_amount: 425,
    notice_given_on: "2027-02-05", applied_at: null, cancelled_at: null,
    // Scheduled the day the notice went out.
    created_at: "2027-02-05T10:00:00Z",
  };

  function seedFebMay() {
    // The pinned row is CONFIRMED with the household, with a stamp — so the
    // restore of both `amount_source` and `amount_source_at` is asserted, not
    // just the one that happens to differ from the default.
    seed({ id: "res-feb", during: "[2027-02-01,2027-05-01)", agreement_seq: 2 });
    db.lot_rent_changes = [{ ...CHANGE }];
    at("2027-03-17T15:00:00");
  }
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); seedFebMay(); });
  afterEach(() => { vi.useRealTimers(); });

  const successor = () => db.lot_reservations.find((r) => r.during === "[2027-05-01,2027-08-01)")!;

  it("renew, then cancel: the successor goes back to the old rent, and the signal says so", async () => {
    await renewAgreement("park-1", "res-feb", { months: 3 });
    expect(successor().quoted_amount).toBe(425);

    at("2027-03-25T09:00:00");
    const res = await cancelReRate("park-1", "2027-04-01");
    expect(res.ok).toBe(true);
    expect(db.lot_rent_changes[0].cancelled_at).toBeTruthy();
    expect(successor().quoted_amount).toBe(400);
    // And it takes back the confirmation it would have inherited.
    expect(successor().amount_source).toBe("tenant_confirmed");
    expect(successor().amount_source_at).toBe("2027-01-01T15:00:00Z");
    expect(res.signal).toBe(
      "1 scheduled change called off. Lot 14's agreement from May 1, 2027 was written at $425.00 " +
      "while it was scheduled and goes back to $400.00.",
    );
  });

  it("renew-then-cancel ends where cancel-then-renew does — the order does not matter", async () => {
    await renewAgreement("park-1", "res-feb", { months: 3 });
    await cancelReRate("park-1", "2027-04-01");
    const late = { ...successor() };

    seedFebMay();
    await cancelReRate("park-1", "2027-04-01");
    await renewAgreement("park-1", "res-feb", { months: 3 });
    const early = { ...successor() };

    expect(late.amount_source).toBe("tenant_confirmed");
    for (const k of ["quoted_amount", "amount_source", "amount_source_at", "due_day", "origin", "agreement_seq"]) {
      expect(late[k]).toEqual(early[k]);
    }
  });

  it("leaves alone a successor he re-rated himself to some other number", async () => {
    await renewAgreement("park-1", "res-feb", { months: 3, newRent: "450" });
    const res = await cancelReRate("park-1", "2027-04-01");
    expect(res.ok).toBe(true);
    expect(successor().quoted_amount).toBe(450);
    expect(res.signal).toBe("1 scheduled change called off.");
  });

  it("leaves alone a successor he TYPED at the change's own number before the change existed", async () => {
    // 10 March: 'Renew at a new rent', $425, nothing scheduled. 12 March: he
    // schedules $400→$425 from 1 April on the Feb–May row. 25 March: calls it
    // off. Matching on the number alone moved the rent he chose to $400 and
    // said it had been "written while it was scheduled" — a sentence about
    // provenance the filter never established.
    db.lot_rent_changes = [];
    at("2027-03-10T11:00:00");
    await renewAgreement("park-1", "res-feb", { months: 3, newRent: "425" });
    expect(successor().quoted_amount).toBe(425);
    expect(successor().amount_source_at).toBe("2027-03-10T11:00:00.000Z");

    db.lot_rent_changes = [{ ...CHANGE, created_at: "2027-03-12T09:00:00Z" }];
    at("2027-03-25T09:00:00");
    const res = await cancelReRate("park-1", "2027-04-01");
    expect(res.ok).toBe(true);
    expect(db.lot_rent_changes[0].cancelled_at).toBeTruthy();
    expect(successor().quoted_amount).toBe(425);
    expect(successor().amount_source).toBe("owner_knowledge");
    expect(res.signal).toBe("1 scheduled change called off.");
  });

  it("a successor of the successor at the carried number moves back too — its stamp is the first one's", async () => {
    await renewAgreement("park-1", "res-feb", { months: 3 });                 // May–Aug at 425, stamped 17 Mar
    at("2027-03-20T10:00:00");
    const may = successor();
    await renewAgreement("park-1", may.id as string, { months: 3 });          // Aug–Nov at 425, copies May's stamp
    const aug = db.lot_reservations.find((r) => r.during === "[2027-08-01,2027-11-01)")!;
    expect(aug.quoted_amount).toBe(425);
    expect(aug.amount_source_at).toBe(may.amount_source_at);

    at("2027-03-25T09:00:00");
    const res = await cancelReRate("park-1", "2027-04-01");
    expect(res.ok).toBe(true);
    expect(successor().quoted_amount).toBe(400);
    expect(aug.quoted_amount).toBe(400);
    expect(res.signal).toContain("Lot 14's agreement from May 1, 2027 was written at $425.00");
    expect(res.signal).toContain("Lot 14's agreement from August 1, 2027 was written at $425.00");
  });

  it("cancels nothing that has already taken effect on the pinned row", async () => {
    db.lot_rent_changes[0].applied_at = "2027-04-01T05:00:00Z";
    db.lot_reservations[0].quoted_amount = 425;
    at("2027-04-02T09:00:00");
    const res = await cancelReRate("park-1", "2027-04-01");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe("0 scheduled changes called off.");
    expect(db.lot_reservations[0].quoted_amount).toBe(425);
  });

  it("says so when the nightly applied the change between the revert and the cancel", async () => {
    // Midnight-only window: the successors were moved back, then the change
    // took effect and re-carried the new rent onto them. "Goes back to
    // $400.00" would describe a state that lasted seconds.
    await renewAgreement("park-1", "res-feb", { months: 3 });
    at("2027-04-01T00:00:05");
    let fired = false;
    afterWrite = (t) => {
      if (t !== "lot_reservations" || fired) return;
      fired = true;
      db.lot_rent_changes[0].applied_at = "2027-04-01T00:00:06Z";
      db.lot_reservations[0].quoted_amount = 425;
      successor().quoted_amount = 425;
    };
    const res = await cancelReRate("park-1", "2027-04-01");
    expect(fired).toBe(true);
    expect(res.ok).toBe(true);
    expect(db.lot_rent_changes[0].cancelled_at).toBeFalsy();
    expect(successor().quoted_amount).toBe(425);
    expect(res.signal).toBe(
      "Nothing was called off — that change had already taken effect, and the agreement written under it follows it.",
    );
  });

  it("and when a second tap called it off first", async () => {
    await renewAgreement("park-1", "res-feb", { months: 3 });
    at("2027-03-25T09:00:00");
    let fired = false;
    afterWrite = (t) => {
      if (t !== "lot_reservations" || fired) return;
      fired = true;
      db.lot_rent_changes[0].cancelled_at = "2027-03-25T09:00:01Z";
    };
    const res = await cancelReRate("park-1", "2027-04-01");
    expect(fired).toBe(true);
    expect(res.ok).toBe(true);
    expect(successor().quoted_amount).toBe(400);
    expect(res.signal).toBe(
      "That change had already been called off. The agreement written while it was scheduled is back at the old rent.",
    );
  });
});

describe("a household still on the seller's arrangement cannot renew from its texted link", () => {
  beforeEach(() => {
    seed({ origin: "grandfathered", during: "[2027-01-01,2028-01-01)" });
    TODAY = "2027-12-01";
  });

  it("the page refuses with a sentence that points at the park, and the tap writes nothing", async () => {
    // Writing the successor as 'office' would file the Grounds fee onto a
    // household that has signed nothing — the owner's door refuses this for
    // exactly that reason, and the resident's door must not be the one that
    // does not.
    const view = await loadExtendByToken(TOKEN);
    expect(view!.refusal).toBe("inherited");
    expect(view!.newEnd).toBeNull();
    expect(view!.message).toBe(
      "Your new agreement is signed with the park — give them a call and they'll have it ready.",
    );

    const res = await extendByToken(TOKEN, 1);
    expect(res.ok).toBe(false);
    expect(res.error).toBe(view!.message);
    expect(inserted).toHaveLength(0);
  });

  it("still refuses on the replayed POST even if the page's read said yes", () => {
    // The token path can be replayed, so the writer re-reads origin itself
    // before the insert rather than trusting the view it was handed.
    const src = code("src/lib/extend-server.ts");
    const body = src.slice(src.indexOf("export async function extendByToken"));
    const check = body.indexOf('=== "grandfathered"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf(".insert("));
    expect(body).toMatch(/\.select\("[^"]*\borigin\b[^"]*"\)/);
  });
});

// ---------------------------------------------------------------------------
// THE TEXT THAT MINTS THE TOKEN. The nightly reminder is the only path that
// creates an extend link, and it used to price the offer itself — the park's
// card, thirty nights out — while the page it linked to showed the household's
// rent in force and a new three-month agreement. Now it quotes the view the
// page renders, so the two are one resolution and cannot disagree.
// ---------------------------------------------------------------------------
describe("remindExpiringStays quotes what the /x page will show", () => {
  const consenting = {
    id: "renter-doris", display_name: "Doris", email: "doris@example.com",
    mobile_e164: "+12605550101", mobile_verified_at: "2027-01-02T00:00:00Z",
    sms_consent_operational_at: "2027-01-02T00:00:00Z", contact_pref: "sms",
  };

  /** 20 April: the Feb–May agreement ends 1 May (inside the 14-day lead), a
   *  $425 increase noticed for 1 April is served history. */
  function seedApril(over: Partial<Row> = {}) {
    seed({
      id: "res-feb", during: "[2027-02-01,2027-05-01)", agreement_seq: 2,
      extend_token: null, extend_reminded_at: null, ...over,
    });
    db.park_renters = [{ ...consenting }];
    db.lot_rent_changes = [{
      id: "c1", park_id: "park-1", reservation_id: "res-feb",
      effective_on: "2027-04-01", from_amount: 400, to_amount: 425,
      notice_given_on: "2027-02-05", applied_at: null, cancelled_at: null,
      created_at: "2027-02-05T10:00:00Z",
    }];
    TODAY = "2027-04-20";
    process.env.NEXT_PUBLIC_SITE_URL = "https://lakelife.test";
  }
  beforeEach(() => seedApril());

  const row = () => db.lot_reservations[0];

  const NONE_REFUSED = { inherited: 0, lot_taken: 0, no_rate: 0, other: 0 };

  /** The page the text links to, and the page after the tap — the real
   *  handlers, read as the resident reads them. The tap is the button they
   *  pressed: a form posting the length it names. */
  const page = async (token: string) =>
    (await extendPage(new Request(`https://lakelife.test/x/${token}`), { params: Promise.resolve({ token }) })).text();
  const tap = async (token: string, months?: number) => {
    const body = new URLSearchParams();
    if (months != null) body.set("months", String(months));
    const req = new Request(`https://lakelife.test/x/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return (await extendTap(req, { params: Promise.resolve({ token }) })).text();
  };

  it("texts the rent in force and the lengths on offer — the page's number, not the card's, and no single length", async () => {
    db.lot_rates = [{ park_lot_id: "lot-14", term: "monthly", amount: 500 }];
    const out = await remindExpiringStays();
    expect(out).toEqual({ ok: true, reminded: 1, unreached: 0, refused: NONE_REFUSED, skipped: [] });
    expect(sent).toHaveLength(1);

    const token = row().extend_token as string;
    expect(token).toMatch(/^x[0-9a-f]{32}$/);
    // THE OWNER'S DECISION, in the household's text: they pick one or three
    // months (six once the cap is raised) — the text names the choice, not
    // the cap, and quotes no date it does not know yet.
    expect(sent[0].sms).toBe(
      "LakeLife: your agreement at lot 14 runs to May 1, 2027. Want to renew for 1 or 3 months " +
      `at $425.00 a month? One tap: https://lakelife.test/x/${token}`,
    );
    expect(sent[0].subject).toBe("Your agreement runs to May 1, 2027 — renew for 1 or 3 months?");
    expect(sent[0].body).toContain("Want to renew for 1 or 3 months at $425.00 a month?");
    for (const t of [sent[0].sms, sent[0].subject, sent[0].body!]) {
      expect(t).not.toMatch(/3-month agreement|next 3 months|2027-0/);
    }

    // The page that link opens offers the same lengths, starts on the house
    // style, and the tap writes the one pressed.
    const view = await loadExtendByToken(token);
    expect(view!.isRenewal).toBe(true);
    expect(view!.price).toBe(425);
    expect(view!.offeredMonths).toEqual([1, 3]);
    expect(view!.renewMonths).toBe(1);
    expect(view!.newStart).toBe("2027-05-01");
    expect(view!.newEnd).toBe("2027-06-01");
    const html = await page(token);
    expect(html).toContain("Renew for 1 month");
    expect(html).toContain("Renew for 3 months");
    expect(html).not.toContain("Renew for 6 months");
    expect(html).toContain('name="months" value="3"');
    expect(html).toContain("Pick how long to renew for");
    expect(html).not.toMatch(/NEW \d+-month agreement/);
    // ONE POST FORM PER CHOICE, on the SAME card shell every token page
    // uses — the badge, the title, the sentence. A GET never writes.
    expect(html.match(/<form method="post"/g)).toHaveLength(2);
    expect(html).toContain('<span class="badge">LakeLife</span>');
    expect(html).toContain('name="months" value="1"');
    expect(html).not.toMatch(/method="get"/);

    const res = await extendByToken(token, 3);
    expect(res.ok, res.error).toBe(true);
    expect(res.renewMonths).toBe(3);
    expect(inserted[0].quoted_amount).toBe(425);
    expect(inserted[0].during).toBe("[2027-05-01,2027-08-01)");
  });

  it("the tap writes the length pressed — one month is one month, and the page after says so", async () => {
    await remindExpiringStays();
    const token = row().extend_token as string;
    const after = await tap(token, 1);
    expect(after).toContain("Your next agreement runs");
    expect(after).toContain("1 month at $425.00 a month");
    expect(after).not.toContain("Your site is yours through");
    expect(inserted[0].during).toBe("[2027-05-01,2027-06-01)");
  });

  it("refuses six months at a cap of three on the REPLAYED post, reading the cap from the park — and honours it at six", async () => {
    await remindExpiringStays();
    const token = row().extend_token as string;
    const six = await extendByToken(token, 6);
    expect(six.ok).toBe(false);
    expect(six.error).toBe("The park doesn't write agreements of that length. Open the link again and pick one of the lengths it offers.");
    expect(inserted).toHaveLength(0);
    expect(await tap(token, 6)).toContain("doesn&#39;t write agreements of that length");

    // The cap raised to six between the text and the tap: six is honoured,
    // twelve still is not.
    db.parks[0].max_agreement_months = 6;
    expect((await loadExtendByToken(token))!.offeredMonths).toEqual([1, 3, 6]);
    const twelve = await extendByToken(token, 12);
    expect(twelve.ok).toBe(false);
    const raised = await extendByToken(token, 6);
    expect(raised.ok, raised.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-05-01,2027-11-01)");
  });

  it("a tap with no length at a capped park writes nothing — the house style is never chosen for them, and 'that length' names nothing", async () => {
    await remindExpiringStays();
    const token = row().extend_token as string;
    const res = await extendByToken(token);
    expect(res.ok).toBe(false);
    // Not "doesn't write agreements of that length" — no length was sent.
    expect(res.error).toBe("Pick how long to renew for — open the link again and tap one of the lengths it offers.");
    expect(inserted).toHaveLength(0);
    expect(await tap(token)).toContain("tap one of the lengths it offers");
    expect(await tap(token)).not.toContain("of that length");
  });

  // THE SEASON, ON THE RESIDENT'S DOOR AS ON THE OWNER'S. On a slip lot
  // closing 15 October the owner's Renew wrote the successor cut to the
  // close; the household's own tap for the same three months wrote three full
  // months — two doors, two rows for one act, and nothing in the database
  // refuses the second (0065 checks the cap only).
  it("the resident's tap clamps to the lot's season exactly as the owner's Renew does — one row for one act", async () => {
    // The pads are year-round; this lot is a slip, closing 15 October. A
    // three-month renewal from 1 September runs to the morning of the 16th.
    seedApril({ during: "[2027-06-01,2027-09-01)" });
    db.park_lots[0].season_open_month = 4; db.park_lots[0].season_open_day = 15;
    db.park_lots[0].season_close_month = 10; db.park_lots[0].season_close_day = 15;
    TODAY = "2027-08-20";
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(1);
    const token = row().extend_token as string;
    // Both lengths are still offered — both start inside the season.
    const atHouse = await loadExtendByToken(token);
    expect(atHouse!.offeredMonths).toEqual([1, 3]);
    expect(atHouse!.renewMonths).toBe(1);
    expect(atHouse!.newEnd).toBe("2027-10-01");
    expect(atHouse!.cutShortBySeason).toBe(false);
    // And each button's real end travels with it, so the page can say so.
    expect(atHouse!.lengths).toEqual([
      { months: 1, end: "2027-10-01", cutShortBySeason: false },
      { months: 3, end: "2027-10-16", cutShortBySeason: true },
    ]);
    const atThree = await loadExtendByToken(token, 3);
    expect(atThree!.newStart).toBe("2027-09-01");
    expect(atThree!.newEnd).toBe("2027-10-16");
    expect(atThree!.cutShortBySeason).toBe(true);
    // THE OWNER'S DOOR PLANS THE SAME ROW — the end comes from one home.
    const owner = await previewRenewal("park-1", "res-feb");
    expect(owner.ok, owner.error).toBe(true);
    expect(owner.preview!.lengths.find((l) => l.months === 3)!.plan).toMatchObject({ start: "2027-09-01", end: "2027-10-16", cutShortBySeason: true });

    const res = await extendByToken(token, 3);
    expect(res.ok, res.error).toBe(true);
    expect(res.newEnd).toBe("2027-10-16");
    expect(res.cutShortBySeason).toBe(true);
    expect(inserted[0].during).toBe("[2027-09-01,2027-10-16)");
    // And the page after the tap quotes the clamped end, never December.
    seedApril({ during: "[2027-06-01,2027-09-01)" });
    db.park_lots[0].season_open_month = 4; db.park_lots[0].season_open_day = 15;
    db.park_lots[0].season_close_month = 10; db.park_lots[0].season_close_day = 15;
    TODAY = "2027-08-20";
    await remindExpiringStays();
    // The page BEFORE the tap wears the clamp on the button itself, so a
    // resident never taps "3 months" for an agreement written to the close.
    const before = await page(row().extend_token as string);
    expect(before).toContain("Renew for 3 months — cut short by the season close, to Saturday, October 16");
    expect(before).toContain("Renew for 1 month<");
    const after = await tap(row().extend_token as string, 3);
    expect(after).toContain("to Saturday, October 16");
    expect(after).toContain("3 months, cut short by the season close");
    expect(after).not.toContain("December");
  });

  it("a renewal that would start after the close is refused on the page, the tap and the nightly — nothing to renew into", async () => {
    // The season closes 15 October; the agreement runs to 1 November.
    seedApril({ during: "[2027-08-01,2027-11-01)", extend_token: TOKEN });
    db.park_lots[0].season_open_month = 4; db.park_lots[0].season_open_day = 15;
    db.park_lots[0].season_close_month = 10; db.park_lots[0].season_close_day = 15;
    TODAY = "2027-10-20";
    const view = await loadExtendByToken(TOKEN);
    expect(view!.refusal).toBe("season_closed");
    expect(view!.offeredMonths).toEqual([]);
    expect(view!.message).toBe(
      "Your spot is closed for the season after your dates, so there's nothing to renew into yet — the park can book you in again when it opens.",
    );
    expect(await page(TOKEN)).toContain("closed for the season after your dates");
    const res = await extendByToken(TOKEN, 1);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("closed for the season");
    expect(inserted).toHaveLength(0);
    // The nightly sends nothing the page would refuse.
    seedApril({ during: "[2027-08-01,2027-11-01)" });
    db.park_lots[0].season_open_month = 4; db.park_lots[0].season_open_day = 15;
    db.park_lots[0].season_close_month = 10; db.park_lots[0].season_close_day = 15;
    TODAY = "2027-10-20";
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(0);
    expect(sent).toEqual([]);
    expect(out.refused).toEqual({ ...NONE_REFUSED, other: 1 });
  });

  it("a length whose dates are already taken is not offered — no button the tap cannot honour", async () => {
    // Somebody else holds the lot from 1 July: a three-month renewal from
    // 1 May would land on them; one month would not.
    db.lot_reservations.push({
      id: "res-next", park_lot_id: "lot-14", renter_id: "renter-x", during: "[2027-07-01,2027-10-01)",
      status: "approved", term: "monthly", quoted_amount: 400, origin: "application",
    });
    await remindExpiringStays();
    const token = row().extend_token as string;
    expect(sent[0].sms).toContain("Want to renew for 1 month at $425.00 a month?");
    const view = await loadExtendByToken(token);
    expect(view!.offeredMonths).toEqual([1]);
    expect(await page(token)).not.toContain("Renew for 3 months");
    const three = await extendByToken(token, 3);
    expect(three.ok).toBe(false);
    expect(three.error).toBe("That lot is spoken for after your dates. The park can look for another one.");
    expect((await extendByToken(token, 1)).ok).toBe(true);
  });

  it("an empty card no longer silences a household with a rent on file", async () => {
    // The old sweep `continue`d on a null card price, so the page's "an empty
    // card never strands somebody" was unreachable through the only path that
    // mints its token.
    db.lot_rates = [];
    db.lot_rent_changes = [];
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(1);
    expect(sent[0].sms).toContain("at $400.00 a month");
    expect((await loadExtendByToken(row().extend_token as string))!.price).toBe(400);
  });

  it("sends nothing the page would refuse — a household still on the seller's arrangement", async () => {
    seedApril({ origin: "grandfathered" });
    // A card is on file, so origin is the ONLY reason not to ask — the old
    // sweep skipped this household for its empty card, not for this.
    db.lot_rates = [{ park_lot_id: "lot-14", term: "monthly", amount: 500 }];
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(0);
    expect(sent).toHaveLength(0);
    // And mints no token: a credential nobody was texted is a credential
    // lying around, and the stamp would stop the question ever being asked.
    expect(row().extend_token).toBeNull();
    expect(row().extend_reminded_at).toBeNull();
    // Counted for the run, not narrated per stay: a line a night for the
    // fortnight before every inherited household's end would be the digest
    // nagging about what the Today card already names.
    expect(out.refused).toEqual({ ...NONE_REFUSED, inherited: 1 });
    expect(out.skipped).toEqual([]);
  });

  it("a household with no rent on file and no card is counted as no_rate, and told nothing", async () => {
    seedApril({ quoted_amount: null });
    db.lot_rates = [];
    db.lot_rent_changes = [];
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(0);
    expect(sent).toHaveLength(0);
    expect(out.refused).toEqual({ ...NONE_REFUSED, no_rate: 1 });
    expect(row().extend_token).toBeNull();
  });

  it("says nothing about a deposit to a household that never paid one — text, page, and the page after the tap", async () => {
    // The Haven: parks.deposit_amount is null and no household has one on the
    // ledger. "Your deposit carries over" was printed to all of them.
    expect(db.park_payments).toEqual([]);
    await remindExpiringStays();
    const token = row().extend_token as string;
    expect(sent[0].body).toContain("at $425.00 a month");
    expect(sent[0].body).not.toMatch(/deposit/i);
    expect(sent[0].sms).not.toMatch(/deposit/i);
    expect((await loadExtendByToken(token))!.depositHeld).toBe(false);
    const html = await page(token);
    expect(html).toContain("Renew for 3 months");
    expect(html).not.toMatch(/deposit/i);
    const after = await tap(token, 3);
    expect(after).toContain("Your next agreement runs");
    expect(after).toContain("3 months at $425.00 a month");
    expect(after).not.toMatch(/deposit/i);
  });

  it("tells a household whose deposit the park is holding that it carries over — on all three", async () => {
    // The ledger's fact, by the resident's own front page's predicate: a
    // deposit payment neither reversed nor handed back nor pulled back.
    db.park_payments = [{
      id: "pay-dep", park_id: "park-1", renter_id: "renter-doris", kind: "deposit", amount: 400,
      charge_id: null, received_on: "2019-04-01", reversed_at: null, returned_on: null, returned_at: null,
    }];
    await remindExpiringStays();
    const token = row().extend_token as string;
    expect(sent[0].body).toContain("Want to renew for 1 or 3 months at $425.00 a month? Your deposit carries over.");
    expect((await loadExtendByToken(token))!.depositHeld).toBe(true);
    expect(await page(token)).toContain("Your deposit carries over — there&#39;s nothing more to pay on it.");
    expect(await tap(token, 3)).toContain("nothing more to pay on your deposit");
  });

  it("a deposit handed back at move-out, pulled back by the bank, or reversed is not held", async () => {
    for (const gone of [{ returned_on: "2026-12-31" }, { returned_at: "2027-01-03T00:00:00Z" }, { reversed_at: "2019-04-02T00:00:00Z" }]) {
      seedApril();
      db.park_payments = [{
        id: "pay-dep", park_id: "park-1", renter_id: "renter-doris", kind: "deposit", amount: 400,
        charge_id: null, received_on: "2019-04-01", reversed_at: null, returned_on: null, returned_at: null, ...gone,
      }];
      await remindExpiringStays();
      expect(sent[0].body, JSON.stringify(gone)).not.toMatch(/deposit/i);
      expect(await page(row().extend_token as string), JSON.stringify(gone)).not.toMatch(/deposit/i);
    }
  });

  it("a failed read is a skip the office can read — no text, no token, and worded for the office", async () => {
    // Before this ran, the branch was pinned only by a source scan.
    failNext("lot_rent_changes");
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(0);
    expect(sent).toEqual([]);
    expect(row().extend_token).toBeNull();
    expect(row().extend_reminded_at).toBeNull();
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatch(/^Stay res-feb: couldn't read the household's rent history, so the extend question wasn't asked/);
    expect(out.skipped[0]).toContain("still ends May 1, 2027");
    // The reader is the office, about somebody else's household — never
    // "couldn't read your rent history" on the owner's morning list.
    expect(out.skipped[0]).not.toMatch(/\byour\b/);
    // Not a refusal: the household was not asked, and is asked again tomorrow.
    expect(out.refused).toEqual(NONE_REFUSED);
  });

  it("and a failed deposit read stops the offer rather than printing nothing about a deposit", async () => {
    failNext("park_payments");
    const out = await remindExpiringStays();
    expect(sent).toEqual([]);
    expect(row().extend_token).toBeNull();
    expect(out.skipped[0]).toMatch(/couldn't read the household's deposit/);
  });

  it("at a park with no cap it is still one more period at the card price, through the same end the page shows", async () => {
    db.parks[0].max_agreement_months = null;
    db.lot_rates = [{ park_lot_id: "lot-14", term: "monthly", amount: 500 }];
    await remindExpiringStays();
    const token = row().extend_token as string;
    expect(sent[0].sms).toBe(
      "LakeLife: your lot 14 is booked through May 1, 2027. Want to keep it through May 31, 2027 for $500.00? " +
      `One tap: https://lakelife.test/x/${token}`,
    );
    // The email's subject names the lot the way the body does — "Your site
    // is booked" sat over "Your lot 14 is booked" for a long-term household.
    expect(sent[0].subject).toBe("Your lot 14 is booked through May 1, 2027 — keep it through May 31, 2027?");
    expect(sent[0].body).toContain("for $500.00?");
    const view = await loadExtendByToken(token);
    expect(view!.isRenewal).toBe(false);
    expect(view!.price).toBe(500);
    expect(view!.newEnd).toBe("2027-05-31");
  });

  it("the consent gate still sits in front of all of it", async () => {
    db.park_renters[0].sms_consent_operational_at = null;
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(0);
    expect(sent).toHaveLength(0);
    expect(row().extend_token).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE HOUSEHOLD WHO ALREADY RENEWED. After the tap (or the office renewing
// for them) the successor sat in the loader's "others" and the re-opened link
// read "That site is spoken for after your dates. The park can look for
// another one." — to a household whose home lot was theirs. And the sweep
// read the old row again the next night and counted its own successor as
// "lot taken", nightly to 1 February.
// ---------------------------------------------------------------------------
describe("a household who already renewed", () => {
  const consenting = {
    id: "renter-doris", display_name: "Doris", email: "doris@example.com",
    mobile_e164: "+12605550101", mobile_verified_at: "2027-01-02T00:00:00Z",
    sms_consent_operational_at: "2027-01-02T00:00:00Z", contact_pref: "sms",
  };
  const NONE_REFUSED = { inherited: 0, lot_taken: 0, no_rate: 0, other: 0 };

  /** Lot 14 in January: a one-month signed lease, asked on 18 January. */
  function seedJanuary() {
    seed({ extend_token: null, extend_reminded_at: null });
    db.park_renters = [{ ...consenting }];
    process.env.NEXT_PUBLIC_SITE_URL = "https://lakelife.test";
    TODAY = "2027-01-18";
  }
  beforeEach(() => seedJanuary());

  const row = () => db.lot_reservations[0];
  const page = async (token: string) =>
    (await extendPage(new Request(`https://lakelife.test/x/${token}`), { params: Promise.resolve({ token }) })).text();
  const tap = async (token: string, months?: number) => {
    const body = new URLSearchParams();
    if (months != null) body.set("months", String(months));
    const req = new Request(`https://lakelife.test/x/${token}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    return (await extendTap(req, { params: Promise.resolve({ token }) })).text();
  };

  it("the re-opened link says 'already set' with the successor's dates — never 'spoken for' — under a non-error title", async () => {
    await remindExpiringStays();
    const token = row().extend_token as string;
    TODAY = "2027-01-20";
    const after = await tap(token, 3);
    expect(after).toContain("Your next agreement runs Monday, February 1 to Saturday, May 1");
    expect(inserted[0].during).toBe("[2027-02-01,2027-05-01)");

    const view = await loadExtendByToken(token);
    expect(view!.refusal).toBe("already_renewed");
    expect(view!.message).toBe(
      "You're already set — your next agreement runs February 1, 2027 to May 1, 2027. The park will send the agreement to sign.",
    );
    const html = await page(token);
    expect(html).toContain("You&#39;re already set");
    expect(html).toContain("runs February 1, 2027 to May 1, 2027");
    expect(html).not.toMatch(/spoken for|another one|can&#39;t do that/);
    expect(html).toContain('<span class="badge">LakeLife</span>');
    expect(html).not.toContain("Heads up");
    expect(html).not.toContain("<form");

    // A replayed tap writes nothing and reads the same sentence, not "We couldn't extend it".
    const replay = await tap(token, 1);
    expect(inserted).toHaveLength(1);
    expect(replay).toContain("You&#39;re already set");
    expect(replay).toContain("runs February 1, 2027 to May 1, 2027");
    expect(replay).not.toMatch(/couldn&#39;t extend|spoken for/);
  });

  it("re-opened after the old row's end, with the next one in force, it is STILL 'already set' — never 'already finished'", async () => {
    await remindExpiringStays();
    const token = row().extend_token as string;
    TODAY = "2027-01-20";
    await tap(token, 3);
    // 2 February: the January row is over; February–May is running. The old
    // row keeps its token (the sweep no longer re-mints), so the same text
    // link opens — and read the `already_ended` sentence ("That stay has
    // already finished. Give the park a call and they'll sort out what
    // happens next.") to a household whose new one had begun.
    TODAY = "2027-02-02";
    const view = await loadExtendByToken(token);
    expect(view!.refusal).toBe("already_renewed");
    const html = await page(token);
    expect(html).toContain("You&#39;re already set");
    expect(html).toContain("runs February 1, 2027 to May 1, 2027");
    expect(html).not.toMatch(/already finished|Give the park a call|can&#39;t do that/);
    const replay = await tap(token, 3);
    expect(inserted).toHaveLength(1);
    expect(replay).toContain("You&#39;re already set");
    expect(replay).not.toMatch(/already finished/);
  });

  it("at a park with NO cap a guest's own later booking keeps the extension on offer — the page, the tap and the nightly", async () => {
    // A park that writes no fixed lengths: the stay is widened by one period
    // at the card price, and "already set" is a renewal-path sentence that
    // must never reach it. Doris also holds 1–30 April on the same lot.
    db.parks[0].max_agreement_months = null;
    db.lot_rates = [{ park_lot_id: "lot-14", term: "monthly", amount: 500 }];
    db.lot_reservations.push({
      id: "res-april", park_lot_id: "lot-14", renter_id: "renter-doris", during: "[2027-04-01,2027-05-01)",
      status: "approved", term: "monthly", quoted_amount: 500, origin: "application",
    });
    const out = await remindExpiringStays();
    expect(out).toEqual({ ok: true, reminded: 1, unreached: 0, refused: NONE_REFUSED, skipped: [] });
    const token = row().extend_token as string;
    expect(sent[0].sms).toContain("Want to keep it through March 3, 2027 for $500.00?");

    const view = await loadExtendByToken(token);
    expect(view!.refusal).toBeNull();
    expect(view!.isRenewal).toBe(false);
    expect(view!.newEnd).toBe("2027-03-03");
    const html = await page(token);
    expect(html).toContain("Stay longer on lot 14?");
    expect(html).toContain("keep it through Wednesday, March 3 for $500.00");
    expect(html).not.toMatch(/already set|agreement to sign/);
    expect(html).toContain("<form");

    // The tap widens the stay; nothing new is inserted, and the April
    // booking is untouched.
    const after = await tap(token);
    expect(after).toContain("Your lot is yours through Wednesday, March 3");
    expect(inserted).toHaveLength(0);
    expect(row().during).toBe("[2027-01-01,2027-03-03)");
    expect(db.lot_reservations.find((r) => r.id === "res-april")!.during).toBe("[2027-04-01,2027-05-01)");

    // Their own later booking still counts for the clash: when it sits on
    // the days the extension would take, the page says so — in the lot's
    // own noun — rather than "already set".
    seedJanuary();
    db.parks[0].max_agreement_months = null;
    db.lot_rates = [{ park_lot_id: "lot-14", term: "monthly", amount: 500 }];
    db.lot_reservations[0].extend_token = TOKEN;
    db.lot_reservations.push({
      id: "res-feb", park_lot_id: "lot-14", renter_id: "renter-doris", during: "[2027-02-15,2027-03-15)",
      status: "approved", term: "monthly", quoted_amount: 500, origin: "application",
    });
    const clash = await loadExtendByToken(TOKEN);
    expect(clash!.refusal).toBe("lot_taken");
    expect(clash!.message).toBe("That lot is spoken for after your dates. The park can look for another one.");
  });

  it("the office renewing for them reads the same — keyed on the household, not the chain", async () => {
    await remindExpiringStays();
    const token = row().extend_token as string;
    TODAY = "2027-01-19";
    // A gap renewal from the office starts a NEW chain for the same household.
    const office = await renewAgreement("park-1", "res-jan", { months: 1, startFrom: "2027-02-15" });
    expect(office.ok, office.error).toBe(true);
    expect("agreement_chain_id" in inserted[0]).toBe(false);
    TODAY = "2027-01-20";
    const view = await loadExtendByToken(token);
    expect(view!.refusal).toBe("already_renewed");
    expect(view!.message).toContain("runs February 15, 2027 to March 15, 2027");
    // And the sweep counts nothing for them — not a refusal, they renewed.
    const out = await remindExpiringStays();
    expect(out.refused).toEqual(NONE_REFUSED);
  });

  it("somebody else after their dates is still 'spoken for'", async () => {
    db.lot_reservations.push({
      id: "res-next", park_lot_id: "lot-14", renter_id: "renter-x", during: "[2027-02-01,2027-05-01)",
      status: "approved", term: "monthly", quoted_amount: 400, origin: "application",
    });
    const out = await remindExpiringStays();
    expect(out.refused).toEqual({ ...NONE_REFUSED, lot_taken: 1 });
    seedJanuary();
    db.lot_reservations[0].extend_token = TOKEN;
    db.lot_reservations.push({
      id: "res-next", park_lot_id: "lot-14", renter_id: "renter-x", during: "[2027-02-01,2027-05-01)",
      status: "approved", term: "monthly", quoted_amount: 400, origin: "application",
    });
    expect((await loadExtendByToken(TOKEN))!.refusal).toBe("lot_taken");
  });

  it("the night after a tap the old row is not swept again — its chain has a later link", async () => {
    await remindExpiringStays();
    const token = row().extend_token as string;
    TODAY = "2027-01-20";
    await extendByToken(token, 3);
    // The old row keeps its stamp — it WAS asked; the successor has its own.
    expect(row().extend_reminded_at).not.toBeNull();
    expect(row().extended_at).toBeTruthy();
    for (const night of ["2027-01-21", "2027-01-25", "2027-02-01"]) {
      TODAY = night;
      sent.length = 0;
      const out = await remindExpiringStays();
      expect(out, night).toEqual({ ok: true, reminded: 0, unreached: 0, refused: NONE_REFUSED, skipped: [] });
      expect(sent).toEqual([]);
    }
    // The successor is asked in its own right, in its own window.
    TODAY = "2027-04-20";
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(1);
    expect(sent[0].sms).toContain("runs to May 1, 2027");
  });

  it("the night after the OFFICE renewed a row the sweep never asked, it is not counted 'lot taken' either", async () => {
    TODAY = "2027-01-17";
    const office = await renewAgreement("park-1", "res-jan", { months: 1 });
    expect(office.ok, office.error).toBe(true);
    TODAY = "2027-01-21";
    const out = await remindExpiringStays();
    expect(out).toEqual({ ok: true, reminded: 0, unreached: 0, refused: NONE_REFUSED, skipped: [] });
    expect(row().extend_token).toBeNull();
  });

  it("a household closed out THROUGH its renewal link is not asked to renew the link before it — an ended successor is a later link", async () => {
    // The office renewed lot 14 in January before the sweep asked (no stamp
    // on the prior), then the family left on the morning of 1 February —
    // recorded through the successor, which is `ended` now; the January
    // link is approved/active with nothing HELD after it. On the night of
    // 1 February January has 0 days left — inside the lead — and a chain
    // map built from the held rows alone could not see the successor: the
    // sweep texted a family who had moved out, asking whether they wanted
    // to renew.
    db.lot_reservations.push({
      id: "res-feb", park_lot_id: "lot-14", renter_id: "renter-doris", renter_unit_id: "unit-1",
      during: "[2027-02-01,2027-02-02)", status: "ended", moved_out_on: "2027-02-01", term: "monthly", quoted_amount: 400,
      origin: "renewal", agreement_chain_id: "chain-a", agreement_seq: 2, extend_token: null, extend_reminded_at: null, extended_count: 0,
    });
    TODAY = "2027-02-01";
    const out = await remindExpiringStays();
    expect(out).toEqual({ ok: true, reminded: 0, unreached: 0, refused: NONE_REFUSED, skipped: [] });
    expect(sent).toEqual([]);
    expect(row().extend_token).toBeNull();
    expect(row().extend_reminded_at).toBeNull();
    // The same night with the successor WITHDRAWN instead (cancelled — the
    // renewal never stood) the prior has no later link, and IS asked: the
    // rule is about a link that was lived in, not any row with a bigger
    // sequence number. Both halves, or the pin measures nothing.
    db.lot_reservations[1].status = "cancelled";
    db.lot_reservations[1].moved_out_on = null;
    const asked = await remindExpiringStays();
    expect(asked.reminded).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("the sweep reads the same predicate the owner's list does (source)", () => {
    const auto = code("src/lib/automation.ts");
    const sweep = auto.slice(auto.indexOf("export async function remindExpiringStays"), auto.indexOf("export function extendReminderText"));
    // Built from EVERY row including the ended ones — read once, split
    // once — exactly the shape renewalsDue below and Today use; only the
    // held rows are swept.
    expect(sweep).toMatch(/\.in\("status", \["approved", "active", "ended"\]\)/);
    expect(sweep).toContain('const stays = (everyRow ?? []).filter((s) => s.status === "approved" || s.status === "active");');
    expect(sweep).toMatch(/const maxSeq = latestSeqByChain\(everyRow \?\? \[\]\);/);
    expect(sweep).not.toMatch(/latestSeqByChain\(stays/);
    expect(sweep).toMatch(/for \(const s of stays \?\? \[\]\)/);
    expect(sweep).toMatch(/if \(hasLaterLink\(s, maxSeq\)\) continue;/);
    const renew = code("src/app/park/renew-actions.ts");
    const due = renew.slice(renew.indexOf("export async function renewalsDue("));
    // Built from EVERY row including the ended ones — a household closed
    // out of its successor has a later link, it is just `ended` — while
    // only the held rows are candidates.
    expect(due).toMatch(/latestSeqByChain\(everyRow \?\? \[\]\)/);
    expect(due).toMatch(/\.in\("status", \["approved", "active", "ended"\]\)/);
    expect(due).toContain('const stays = (everyRow ?? []).filter((s) => s.status === "approved" || s.status === "active");');
    expect(due).toMatch(/const due = stays\.filter/);
    expect(due).toMatch(/!hasLaterLink\(s, maxSeq\)/);
    expect(due).not.toMatch(/new Map<string, number>/);
    // The stamp is not cleared on the predecessor by the resident's door.
    const extend = code("src/lib/extend-server.ts");
    const renewal = extend.slice(extend.indexOf("if (view.isRenewal && view.newStart && view.newEnd)"), extend.indexOf("const { data: updated, error }"));
    expect(renewal).not.toMatch(/extend_reminded_at: null/);
    expect(renewal).toMatch(/\.update\(\{ extended_at: new Date\(\)\.toISOString\(\) \}\)/);
  });

  it("both doors write the successor's status by ONE rule (source)", () => {
    for (const p of ["src/app/park/renew-actions.ts", "src/lib/extend-server.ts"]) {
      const src = code(p);
      expect(src, p).toMatch(/status: successorStatus\(/);
      expect(src, p).not.toMatch(/status: "(approved|active)"/);
    }
  });

  it("a tap on the end day starts the successor today — ACTIVE; a tap before it — APPROVED", async () => {
    await remindExpiringStays();
    const token = row().extend_token as string;
    TODAY = "2027-02-01";
    const res = await extendByToken(token, 1);
    expect(res.ok, res.error).toBe(true);
    expect(inserted[0].status).toBe("active");
    seedJanuary();
    await remindExpiringStays();
    TODAY = "2027-01-25";
    await extendByToken(row().extend_token as string, 1);
    expect(inserted[0].status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// UNDER THE HOLD THE NIGHTLY STAMPED THE HOUSEHOLD AS REMINDED. The stamp is
// the claim, written before the send; when notify() reached nobody nothing
// released it, so the household's one reminder was consumed on a night no
// door was open, `reminded: 1` said they were asked, and after the hold
// lifted nobody was ever asked. The hold itself is NOT re-checked here — it
// lives in the two transports and nowhere else.
// ---------------------------------------------------------------------------
describe("a reminder that reached nobody", () => {
  const consenting = {
    id: "renter-doris", display_name: "Doris", email: "doris@example.com",
    mobile_e164: "+12605550101", mobile_verified_at: "2027-01-02T00:00:00Z",
    sms_consent_operational_at: "2027-01-02T00:00:00Z", contact_pref: "sms",
  };
  const NONE_REFUSED = { inherited: 0, lot_taken: 0, no_rate: 0, other: 0 };
  const REFUSED_NOTE = "Couldn't tell them about the renter that her stay is ending, with the one tap that extends it (stay res-jan) — the text didn't queue and the email didn't send.";
  const row = () => db.lot_reservations[0];

  beforeEach(() => {
    seed({ extend_token: null, extend_reminded_at: null });
    db.park_renters = [{ ...consenting }];
    process.env.NEXT_PUBLIC_SITE_URL = "https://lakelife.test";
    TODAY = "2027-01-18";
  });
  afterEach(() => {
    vi.mocked(notify).mockImplementation(async (_what, _to, msg) => {
      sent.push(msg);
      return { reached: true, bySms: false, byEmail: true };
    });
  });

  it("releases the claim, counts it unreached — not reminded — and asks again the next night", async () => {
    vi.mocked(notify).mockImplementation(async () => ({ reached: false, bySms: false, byEmail: false, note: REFUSED_NOTE }));
    const held = await remindExpiringStays();
    expect(held.reminded).toBe(0);
    expect(held.unreached).toBe(1);
    expect(held.refused).toEqual(NONE_REFUSED);
    expect(row().extend_reminded_at).toBeNull();
    expect(row().extend_token).toBeNull();
    // One line for the run, carrying the transport's reason, and what happens next.
    expect(held.skipped).toEqual([
      "1 household couldn't be told its agreement is ending, with the one tap that renews or extends it — the text didn't queue and the email didn't send. " +
      "Nothing was stamped; it will be asked again the next night the agreement is still running.",
    ]);

    // The hold lifts: the next night asks, and the stamp is written then.
    vi.mocked(notify).mockImplementation(async (_what, _to, msg) => {
      sent.push(msg);
      return { reached: true, bySms: false, byEmail: true };
    });
    TODAY = "2027-01-20";
    const lifted = await remindExpiringStays();
    expect(lifted).toEqual({ ok: true, reminded: 1, unreached: 0, refused: NONE_REFUSED, skipped: [] });
    expect(sent).toHaveLength(1);
    expect(row().extend_reminded_at).toBeTruthy();
    expect(row().extend_token).toMatch(/^x[0-9a-f]{32}$/);
  });

  it("collapses many unreached households into ONE line, never one a night per stay", async () => {
    db.park_lots.push({ id: "lot-15", lot_number: "15", park_id: "park-1", lifecycle: "live",
      season_open_month: null, season_open_day: null, season_close_month: null, season_close_day: null });
    db.lot_reservations.push({
      id: "res-15", park_lot_id: "lot-15", renter_id: "renter-doris", during: "[2027-01-01,2027-02-01)",
      status: "active", term: "monthly", quoted_amount: 400, origin: "application",
      agreement_chain_id: "chain-b", agreement_seq: 1, extend_token: null, extend_reminded_at: null,
    });
    vi.mocked(notify).mockImplementation(async () => ({ reached: false, bySms: false, byEmail: false, note: REFUSED_NOTE }));
    const out = await remindExpiringStays();
    expect(out.unreached).toBe(2);
    expect(out.reminded).toBe(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatch(/^2 households couldn't be told their agreement is ending/);
    expect(out.skipped[0]).toContain("they will be asked again the next night the agreement is still running.");
    // Never a promise the boundary breaks: on the end night there is no tomorrow.
    expect(out.skipped[0]).not.toMatch(/tomorrow/);
    expect(db.lot_reservations.every((r) => r.extend_reminded_at == null && r.extend_token == null)).toBe(true);
  });

  it("when the release itself fails, says the household will NOT be asked again automatically", async () => {
    // The claim is written, the send is refused, and then the release write
    // fails: the stamp stands, and rendering that as "asked again tomorrow"
    // would be a failed write rendered as a retry.
    vi.mocked(notify).mockImplementation(async () => {
      failNext("lot_reservations");
      return { reached: false, bySms: false, byEmail: false, note: REFUSED_NOTE };
    });
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(0);
    expect(out.unreached).toBe(1);
    expect(row().extend_reminded_at).toBeTruthy();
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatch(/^Stay res-jan: the message didn't reach the household/);
    expect(out.skipped[0]).toContain("will NOT be asked again automatically");
    expect(out.skipped[0]).toContain("still ends February 1, 2027 unless somebody asks by hand");
  });

  it("when the CLAIM write fails, the household is named as unasked — not skipped as 'another run took it'", async () => {
    // `{ data: null, error }` on the stamp write read as an empty claim: no
    // text, no token, and not a word in the digest.
    failNextWrite("lot_reservations");
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(0);
    expect(out.unreached).toBe(0);
    expect(sent).toEqual([]);
    expect(row().extend_token).toBeNull();
    expect(row().extend_reminded_at).toBeNull();
    expect(out.skipped).toEqual([
      "Stay res-jan: couldn't mark the reminder as sent, so the extend question wasn't asked — the tenancy still ends February 1, 2027 unless somebody asks by hand.",
    ]);
    // The fake failed the update and nothing else: the next night asks.
    TODAY = "2027-01-19";
    expect((await remindExpiringStays()).reminded).toBe(1);
  });

  it("the hold is never re-checked at this call site (source)", () => {
    const auto = code("src/lib/automation.ts");
    const sweep = auto.slice(auto.indexOf("export async function remindExpiringStays"), auto.indexOf("export function extendReminderText"));
    expect(sweep).not.toMatch(/notices_held_at|noticesHeld|notice-hold/);
    // The release is guarded on the token, and reminded moves below the reached check.
    expect(sweep).toMatch(/\.update\(\{ extend_reminded_at: null, extend_token: null \}\)\s*\.eq\("id", s\.id as string\)\s*\.eq\("extend_token", token\)/);
    expect(sweep).toMatch(/if \(told\.reached\) \{\s*reminded\+\+;/);
    expect(sweep).not.toMatch(/reminded\+\+;\s*const msg/);
  });
});

// ---------------------------------------------------------------------------
// THE HOUSEHOLD IS QUOTED THE MONTHLY BILL, NOT THE BARE RENT. The successor
// bills rent plus the park's monthly fee from its first morning — the owner's
// signing toast says "$542.53 ($400.00 rent + $142.53 fees)" — and the text,
// the page and the page after the tap all said "$400 a month". And "site 2"
// to a household whose lease, invite and home page say Lot 2.
// ---------------------------------------------------------------------------
describe("the resident's text and page quote rent plus the fee", () => {
  const consenting = {
    id: "renter-doris", display_name: "Doris", email: "doris@example.com",
    mobile_e164: "+12605550101", mobile_verified_at: "2027-01-02T00:00:00Z",
    sms_consent_operational_at: "2027-01-02T00:00:00Z", contact_pref: "sms",
  };
  const row = () => db.lot_reservations[0];
  const page = async (token: string) =>
    (await extendPage(new Request(`https://lakelife.test/x/${token}`), { params: Promise.resolve({ token }) })).text();
  const tap = async (token: string, months: number) => {
    const body = new URLSearchParams(); body.set("months", String(months));
    const req = new Request(`https://lakelife.test/x/${token}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    return (await extendTap(req, { params: Promise.resolve({ token }) })).text();
  };

  beforeEach(() => {
    seed({ extend_token: null, extend_reminded_at: null });
    db.park_lots[0].rental_mode = "long_term";
    db.park_renters = [{ ...consenting }];
    // The Haven's one fee, exactly as the biller reads it.
    db.park_fees = [{ id: "fee-1", park_id: "park-1", label: "Grounds fee", amount: "142.53", cadence: "monthly", applies_to: "long_term", active: true }];
    process.env.NEXT_PUBLIC_SITE_URL = "https://lakelife.test";
    TODAY = "2027-01-18";
  });

  const ALL_IN = "$400.00 rent plus the $142.53 Grounds fee — $542.53 a month";

  it("on all three surfaces, and says 'lot' for a long-term lot", async () => {
    const out = await remindExpiringStays();
    expect(out.reminded).toBe(1);
    const token = row().extend_token as string;
    expect(sent[0].sms).toBe(
      `LakeLife: your agreement at lot 14 runs to February 1, 2027. Want to renew for 1 or 3 months at ${ALL_IN}? One tap: https://lakelife.test/x/${token}`,
    );
    expect(sent[0].body).toContain(`Want to renew for 1 or 3 months at ${ALL_IN}?`);
    expect(sent[0].sms).not.toMatch(/site/);

    const view = await loadExtendByToken(token);
    expect(view!.rentalMode).toBe("long_term");
    expect(view!.monthlyFees).toEqual([{ label: "Grounds fee", amount: 142.53 }]);
    const html = await page(token);
    expect(html).toContain("Stay on at lot 14?");
    expect(html).toContain(`The next agreement starts Monday, February 1 at ${ALL_IN}.`);
    expect(html).not.toMatch(/site 14|\$400 a month/);

    TODAY = "2027-01-20";
    const after = await tap(token, 3);
    expect(after).toContain(`Your next agreement runs Monday, February 1 to Saturday, May 1: 3 months at ${ALL_IN}.`);
    expect(inserted[0].quoted_amount).toBe(400);
  });

  it("a fee that does not reach this lot is not quoted — a short-term site, an inactive fee, another audience", async () => {
    db.park_lots[0].rental_mode = "short_term";
    await remindExpiringStays();
    expect(sent[0].sms).toContain("your agreement at site 14 runs to");
    expect(sent[0].sms).toContain("at $400.00 a month?");
    expect(sent[0].sms).not.toContain("Grounds");
    expect(await page(row().extend_token as string)).toContain("Stay on at site 14?");

    for (const off of [{ active: false }, { applies_to: "short_term" }, { cadence: "annual" }]) {
      seed({ extend_token: null, extend_reminded_at: null });
      db.park_lots[0].rental_mode = "long_term";
      db.park_renters = [{ ...consenting }];
      db.park_fees = [{ id: "fee-1", park_id: "park-1", label: "Grounds fee", amount: "142.53", cadence: "monthly", applies_to: "long_term", active: true, ...off }];
      await remindExpiringStays();
      expect(sent[0].sms, JSON.stringify(off)).toContain("at $400.00 a month?");
      expect(sent[0].sms, JSON.stringify(off)).not.toContain("Grounds");
    }
  });

  it("a failed fee read stops the text rather than quoting the bare rent as the all-in", async () => {
    failNext("park_fees");
    const out = await remindExpiringStays();
    expect(sent).toEqual([]);
    expect(row().extend_token).toBeNull();
    expect(out.skipped[0]).toMatch(/couldn't read the park's fees/);
    expect(out.skipped[0]).not.toMatch(/\byour\b/);
  });

  it("the three surfaces read ONE helper (source)", () => {
    expect(code("src/lib/automation.ts")).toMatch(/renewalRentWords\(\{ price: view\.price, term: view\.term, fees: view\.monthlyFees \}\)/);
    const route = code("src/app/x/[token]/route.ts");
    expect(route.match(/renewalRentWords\(/g) ?? []).toHaveLength(2);
    expect(route).not.toMatch(/function rentWords/);
    expect(route).not.toMatch(/"site"|`site/);
    expect(route.match(/lotWord\(/g) ?? []).toHaveLength(2);
  });
});

describe("htmlPage with choices — the one card shell, one form per choice", () => {
  // /x/[token] used to carry its own copy of the card (choicePage) because
  // htmlPage rendered exactly one submit. Two copies of the resident-facing
  // CSS drift — the badge colour already differed. One home now.
  const read = async (r: Response) => r.text();

  it("renders one POST form per choice, each carrying its hidden field, all escaped", async () => {
    const html = await read(htmlPage("Stay on?", "Pick one.", true, "/x/tok", undefined, undefined, [
      { name: "months", value: "1", label: "Renew for 1 month" },
      { name: "months", value: "3", label: 'Renew for 3 months <b>"now"</b>' },
    ]));
    expect(html.match(/<form method="post" action="\/x\/tok"/g)).toHaveLength(2);
    expect(html).toContain('<input type="hidden" name="months" value="1">');
    expect(html).toContain('<input type="hidden" name="months" value="3">');
    expect(html).toContain("Renew for 1 month</button>");
    expect(html).toContain("Renew for 3 months &lt;b&gt;&quot;now&quot;&lt;/b&gt;</button>");
    expect(html).not.toContain("<b>");
    // The single-button form is NOT also rendered.
    expect(html.match(/<button type="submit"/g)).toHaveLength(2);
    expect(html).not.toContain(">Confirm</button>");
  });

  it("with no choices the page is exactly what it always was — one button, or none", async () => {
    const one = await read(htmlPage("T", "B", true, "/a/tok/confirm", "Yes"));
    expect(one.match(/<form method="post"/g)).toHaveLength(1);
    expect(one).toContain(">Yes</button>");
    const none = await read(htmlPage("T", "B", false));
    expect(none).not.toContain("<form");
    expect(none).toContain('<span class="badge">Heads up</span>');
    // An EMPTY choices list renders no forms rather than one dead button.
    const empty = await read(htmlPage("T", "B", true, "/x/tok", undefined, undefined, []));
    expect(empty).not.toContain("<form");
  });

  it("the /x page has no card of its own any more", () => {
    const route = code("src/app/x/[token]/route.ts");
    expect(route).not.toMatch(/function choicePage/);
    expect(route).not.toMatch(/<style>/);
    expect(route).not.toMatch(/class="badge"/);
    expect(route).toMatch(/htmlPage\([\s\S]*?choices/);
  });
});

describe("both doors build the row one way (source)", () => {
  it("the stripper still finds the doors it scans", () => {
    expect(code("src/app/park/renew-actions.ts")).toContain("export async function renewAgreement");
    expect(code("src/lib/extend-server.ts")).toContain("export async function extendByToken");
    expect(code("src/app/park/sign-helpers.ts")).toContain("export function planSigning");
    expect(code("src/app/park/actions.ts")).toContain("export async function editTenancy");
    expect(code("src/components/ParkRenewals.tsx")).toContain("export function ParkRenewals");
  });

  it("the toast and the Today card quote the span from ONE helper that reads the plan — never the picked length beside the dates", () => {
    const toast = code("src/app/park/renew-actions.ts");
    const card = code("src/components/ParkRenewals.tsx");
    expect(toast).toContain("agreementSpanWords(plan)");
    expect(card).toContain("agreementSpanWords(at.plan)");
    // The old shape: the request's length next to the plan's dates.
    expect(toast).not.toMatch(/lengthInWords\(opts\.months\)/);
    expect(card).not.toMatch(/longDate\(at\.plan\.start\)/);
    expect(card).not.toMatch(/lengthInWords\(at\.months\)\)/);
  });

  it("both doors read the season's morning from ONE home, and the page's buttons are canExtend's own verdicts", () => {
    const renew = code("src/app/park/renew-actions.ts");
    const extend = code("src/lib/extend-server.ts");
    const stay = code("src/lib/extend-stay.ts");
    // The owner's door no longer types the close day inline; the resident's
    // door reads the same function.
    expect(renew).toMatch(/seasonEnd: agreementSeasonEnd\(startISO, season\)/);
    expect(renew).not.toMatch(/season\.closeMonth && season\.closeDay/);
    expect(extend).toMatch(/agreementSeasonEnd\(range\.end, season\)/);
    expect(extend).toMatch(/effectiveSeason\(/);
    // The successor's end is agreementEnd's — the clamp included — on the
    // resident's side too, never start + months.
    expect(stay).toMatch(/agreementEnd\(current\.end, renewMonths, \{ seasonEnd/);
    expect(stay).not.toMatch(/addMonths\(current\.end/);
    // The buttons: canExtend per length on one ask, no re-typed overlap test.
    expect(extend).toMatch(/const v = canExtend\(\{ \.\.\.ask, renewMonths: m \}\);/);
    expect(extend).toMatch(/const offeredMonths = lengths\.map\(\(l\) => l\.months\);/);
    expect(extend).toMatch(/canExtend\(\{ \.\.\.ask, renewMonths: resolvedMonths \}\)/);
    expect(extend).not.toMatch(/h\.start < next\.end/);
    expect(extend).not.toMatch(/extendedRange\(/);
    // The scanner still sees the one overlap test where it lives.
    expect(stay).toMatch(/h\.start < next\.end && next\.start < h\.end/);
  });

  it("renewalsDue's lead is the agreement's own (renewalLeadDays), not a flat window", () => {
    const src = code("src/app/park/renew-actions.ts");
    const at = src.indexOf("export async function renewalsDue(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at);
    expect(body).toMatch(/renewalLeadDays\(r\.start, r\.end, leadCapDays\)/);
    expect(body).not.toMatch(/withinDays \* 86_400_000/);
  });

  it("NO NOTICE GATE in any door that writes or edits an agreement — the rent-increase notice is the owner's to give", () => {
    // The owner's decision: he tells them the rents go up in 2027; nothing
    // here gates a renewal, a signing, a tap or an edit on rent_notice_days,
    // and nothing sends a notice. The re-rate door keeps its own reading.
    const fn = (p: string, name: string) => {
      const src = code(p);
      const at = src.indexOf(`export async function ${name}(`);
      expect(at, `${name} is gone — this scan measures nothing`).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport ", at + 1);
      return src.slice(at, next === -1 ? undefined : next);
    };
    for (const [p, name] of [
      ["src/app/park/renew-actions.ts", "renewAgreement"],
      ["src/lib/extend-server.ts", "extendByToken"],
      ["src/app/park/sign-actions.ts", "recordSigning"],
      ["src/app/park/actions.ts", "editTenancy"],
    ] as const) {
      const body = fn(p, name);
      expect(body, `${name} reads the notice period`).not.toMatch(/rent_notice_days|noticeDays|notice_given_on/);
    }
    // The scanner can see a notice read where one exists.
    expect(code("src/app/park/actions.ts")).toMatch(/rent_notice_days/);
  });

  it("every writing door takes the CHOSEN length, and none reads the cap as a length", () => {
    // The cap-as-length bug in every coat: `addMonths(x, cap)`, `capMonths`
    // as an end, `agreementMonthsFor(...)` handed to a builder. The writers
    // read the choice through chooseAgreementLength / planRenewal / the
    // view's resolved length instead.
    const renew = code("src/app/park/renew-actions.ts");
    expect(renew).toMatch(/opts: \{ months: number;/);
    expect(renew).toMatch(/pre\.preview\.lengths\.find\(\(l\) => l\.months === opts\.months\)/);
    expect(renew).not.toMatch(/agreementEnd\(/);
    const extend = code("src/lib/extend-server.ts");
    expect(extend).toMatch(/renewMonths: resolvedMonths/);
    expect(extend).toMatch(/view\.renewMonths !== renewMonths/);
    const stay = code("src/lib/extend-stay.ts");
    expect(stay).toMatch(/capMonths != null \? renewMonths : null/);
    expect(stay).not.toMatch(/addMonths\([^)]*capMonths\)/);
    const sign = code("src/app/park/sign-helpers.ts");
    expect(sign).toMatch(/chooseAgreementLength\(input\.agreementMonths, ctx\.defaultAgreementMonths, ctx\.maxAgreementMonths\)/);
    expect(sign).not.toMatch(/agreementMonthsFor\(/);
    const add = code("src/app/park/actions.ts");
    expect(add).toMatch(/chooseAgreementLength\(\s*input\.agreementMonths \?\? null,/);
    expect(add).not.toMatch(/agreementMonthsFor\(/);
    const onboard = code("src/app/park/onboard-actions.ts");
    expect(onboard).toMatch(/r\.agreementMonths,/);
    expect(onboard).not.toMatch(/parkTerm/);
    const helpers = code("src/app/park/onboard-helpers.ts");
    expect(helpers).toMatch(/chooseAgreementLength\(r\.agreementMonths, dials\?\.defaultMonths \?\? null, dials\?\.capMonths \?\? null\)/);
  });

  it("renewAgreement never copies origin from the prior row", () => {
    expect(code("src/app/park/renew-actions.ts")).not.toMatch(/prior\.origin\s*\?\?/);
    expect(code("src/app/park/renew-actions.ts")).not.toMatch(/origin:\s*(prior|res)\.origin/);
  });

  it("all three doors call successorRow( and none sends a null chain id", () => {
    // The third door — recording a signed lease from the roll — builds its
    // row in sign-helpers.ts and hands it to sign-actions.ts to insert.
    for (const p of ["src/app/park/renew-actions.ts", "src/lib/extend-server.ts", "src/app/park/sign-helpers.ts"]) {
      const src = code(p);
      expect(src.match(/successorRow\(/g) ?? []).toHaveLength(1);
      expect(src).not.toMatch(/agreement_chain_id:\s*[\s\S]{0,160}?:\s*null/);
    }
  });
});
