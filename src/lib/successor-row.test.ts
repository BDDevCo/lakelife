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
    if (failNextTable !== this.t) return null;
    failNextTable = null;
    return { data: null, error: { message: `connection terminated (${this.t})` } };
  }
  maybeSingle() {
    const f = this.failed();
    if (f) return Promise.resolve(f);
    const rows = this.rows(); return Promise.resolve({ data: rows[0] ?? null, error: null });
  }
  async insert(row: Row) {
    inserted.push({ ...row, __table: this.t });
    (db[this.t] ??= []).push({ id: `new-${inserted.length}`, ...row });
    return { error: null };
  }
  update(patch: Row) { this.patch = patch; return this; }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const f = this.failed();
    if (f) return Promise.resolve(f).then(ok, bad);
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
/** The next read of `table` fails. One-shot, cleared by `seed`. */
const failNext = (table: string) => { failNextTable = table; };

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => ({ role: "owner" }) }));
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

const { renewAgreement, previewRenewal, renewalsDue } = await import("@/app/park/renew-actions");
const { extendByToken, loadExtendByToken } = await import("@/lib/extend-server");
const { cancelReRate } = await import("@/app/park/rerate-actions");
const { remindExpiringStays } = await import("@/lib/automation");
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
  db.park_payments = [];
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
    expect(res.signal).toBe("Lot 14 renewed for 3 months, February 1, 2027 to May 1, 2027. Consecutive — no new deposit.");
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
    expect(res.signal).toBe("Lot 14 renewed for 1 month, February 1, 2027 to March 1, 2027. Consecutive — no new deposit.");
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
    const raised = await renewAgreement("park-1", "res-jan", { months: 6 });
    expect(raised.ok, raised.error).toBe(true);
    expect(inserted[0].during).toBe("[2027-02-01,2027-08-01)");
    // Twelve is still not offered at six.
    const twelve = await renewAgreement("park-1", "res-jan", { months: 12 });
    expect(twelve.ok).toBe(false);
    expect(twelve.error).toBe("This park writes agreements of 1, 3 or 6 months — pick one of those.");
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
      "Lot 14 renewed for 3 months, cut short by the season close — September 1, 2027 to October 16, 2027. Consecutive — no new deposit.",
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
    expect(row.status).toBe("active");
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
    expect(out).toEqual({ ok: true, reminded: 1, refused: NONE_REFUSED, skipped: [] });
    expect(sent).toHaveLength(1);

    const token = row().extend_token as string;
    expect(token).toMatch(/^x[0-9a-f]{32}$/);
    // THE OWNER'S DECISION, in the household's text: they pick one or three
    // months (six once the cap is raised) — the text names the choice, not
    // the cap, and quotes no date it does not know yet.
    expect(sent[0].sms).toBe(
      "LakeLife: your agreement at site 14 runs to May 1, 2027. Want to renew for 1 or 3 months " +
      `at $425 a month? One tap: https://lakelife.test/x/${token}`,
    );
    expect(sent[0].subject).toBe("Your agreement runs to May 1, 2027 — renew for 1 or 3 months?");
    expect(sent[0].body).toContain("Want to renew for 1 or 3 months at $425 a month?");
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
    expect(after).toContain("1 month at $425 a month");
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
    expect(sent[0].sms).toContain("Want to renew for 1 month at $425 a month?");
    const view = await loadExtendByToken(token);
    expect(view!.offeredMonths).toEqual([1]);
    expect(await page(token)).not.toContain("Renew for 3 months");
    const three = await extendByToken(token, 3);
    expect(three.ok).toBe(false);
    expect(three.error).toBe("That site is spoken for after your dates. The park can look for another one.");
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
    expect(sent[0].sms).toContain("at $400 a month");
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
    expect(sent[0].body).toContain("at $425 a month");
    expect(sent[0].body).not.toMatch(/deposit/i);
    expect(sent[0].sms).not.toMatch(/deposit/i);
    expect((await loadExtendByToken(token))!.depositHeld).toBe(false);
    const html = await page(token);
    expect(html).toContain("Renew for 3 months");
    expect(html).not.toMatch(/deposit/i);
    const after = await tap(token, 3);
    expect(after).toContain("Your next agreement runs");
    expect(after).toContain("3 months at $425 a month");
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
    expect(sent[0].body).toContain("Want to renew for 1 or 3 months at $425 a month? Your deposit carries over.");
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
      "LakeLife: your site 14 is booked through May 1, 2027. Want to keep it through May 31, 2027 for $500? " +
      `One tap: https://lakelife.test/x/${token}`,
    );
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
