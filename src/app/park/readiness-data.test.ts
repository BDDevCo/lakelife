import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE READINESS LOADER EITHER ANSWERS OR THROWS.
 *
 * A row on the list is a fact about a column. A dropped read rendered as
 * "not done" would tell the owner "No lots yet" over the twenty-one he is
 * looking at, so every read here goes through mustRead/mustCount and a
 * failure reaches the page boundary. Pinned two ways: a source scan that
 * every `.from(` sits inside one of the two, and a mocked database where a
 * failing table REJECTS the call rather than resolving with lots: 0.
 */

const src = readFileSync(fileURLToPath(new URL("./readiness-data.ts", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("readiness-data.ts, by shape", () => {
  it("is server-only and not a public endpoint", () => {
    expect(src).toMatch(/^import "server-only";/m);
    expect(src).not.toContain('"use server"');
  });

  it("every read is inside mustRead( or mustCount( — sequential and inline, so a failure throws", () => {
    // Slice each `.from("` back to the previous one and require one of the
    // two names in that slice — the read variable is not assigned first and
    // unwrapped later, which is what a Promise.all batch would look like.
    const froms = [...src.matchAll(/\.from\("/g)].map((m) => m.index ?? -1);
    expect(froms.length, "the scanner found no reads — it is measuring nothing").toBeGreaterThanOrEqual(8);
    let prev = 0;
    for (const at of froms) {
      const slice = src.slice(prev, at);
      expect(slice, `a read at ${at} is not inside mustRead/mustCount`).toMatch(/must(Read|Count)\(\s*"[^"]+",\s*await\s*$|must(Read|Count)\(\s*"[^"]+",\s*await admin\s*$/);
      prev = at;
    }
    expect(src).not.toContain("Promise.all");
  });

  it("selects the columns every row is earned by", () => {
    const parks = src.match(/\.from\("parks"\)\s*\.select\("([^"]*)"\)/);
    expect(parks).not.toBeNull();
    const cols = parks![1].split(", ");
    for (const c of ["active", "lake_id", "lat", "lng", "notices_held_at", "accepts_online_rent", "cutover_date", "max_agreement_months", "rent_due_day", "name"]) {
      expect(cols, `parks select lacks ${c}`).toContain(c);
    }
    const renters = src.match(/\.from\("park_renters"\)\.select\("([^"]*)"\)/);
    expect(renters).not.toBeNull();
    // claim_code_issued_at is the fourth contact witness — a slip printed
    // under the hold; without it here the fix ships in one loader of two.
    for (const c of ["email", "phone_on_file_with_park", "invite_sent_at", "claim_code_issued_at"]) expect(renters![1].split(", ")).toContain(c);
    expect(src).toMatch(/\.from\("park_lots"\)\.select\("id, lot_number, lifecycle, active"\)/);
    expect(src).toMatch(/\.in\("status", \["approved", "active", "ended"\]\)/);
    expect(src).toMatch(/\.from\("park_reminders"\)[\s\S]*?\.eq\("party", "resident"\)\.in\("outcome", \["sent", "printed"\]\)/);
    expect(src).toMatch(/\.from\("park_document_deliveries"\)/);
    expect(src).toMatch(/\.from\("park_charges"\)/);
    // Every payment, reversed and returned ones too — no .is("reversed_at") here.
    expect(src).toMatch(/\.from\("park_payments"\)\.select\("id", \{ count: "exact", head: true \}\)\.eq\("park_id", parkId\)/);
  });

  it("derives through the shared builder — no inline occupancy, and the ledger and processor are asked", () => {
    expect(src).toMatch(/readinessFactsFrom\(\{/);
    expect(src).not.toContain("occupiedLotIds");
    expect(src).toMatch(/hasAccepted\(\{ userId: user\.id \}, "tos", TOS_VERSION\)/);
    expect(src).toMatch(/processorLive: paymentsAreLive\(\)/);
    expect(src).toMatch(/viewerIsOwner: membership\.role === "owner"/);
  });
});

// ---------------------------------------------------------------- mocked ---

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const failing = new Set<string>();

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private head = false;
  constructor(private t: string) {}
  select(_c?: string, opts?: { head?: boolean }) { this.head = !!opts?.head; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  order() { return this; }
  limit() { return this; }
  private result() {
    if (failing.has(this.t)) {
      return { data: null, count: null, error: { code: "XX000", message: `mock: ${this.t} read failed` } };
    }
    const rows = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    return { data: this.head ? null : rows, count: rows.length, error: null };
  }
  maybeSingle() {
    const r = this.result();
    return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error });
  }
  then<A, B>(ok?: ((x: { data: Row[] | null; count: number | null; error: unknown }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.result()).then(ok, bad);
  }
}

const OWNER = "user-owner";
const PARK = "park-cedar";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { getReadinessFacts, readinessExtras } = await import("./readiness-data");
const { TOS_VERSION } = await import("@/lib/tos");

function seed() {
  failing.clear();
  for (const k of Object.keys(db)) delete db[k];
  db.park_members = [{ park_id: PARK, user_id: OWNER, role: "owner" }];
  db.parks = [{
    id: PARK, name: "Cedar Hollow", cutover_date: "2027-01-01", rent_due_day: 1, max_agreement_months: 6,
    active: false, lake_id: "lake-1", lat: 41.6, lng: -85.3, notices_held_at: "2026-08-21T14:00:00+00:00", accepts_online_rent: false,
  }];
  db.lakes = [{ id: "lake-1", name: "Big Long Lake" }];
  db.park_lots = [
    { id: "l1", park_id: PARK, lot_number: "1", lifecycle: "live", active: true },
    { id: "l2", park_id: PARK, lot_number: "2", lifecycle: "live", active: true },
    { id: "l9", park_id: "other", lot_number: "9", lifecycle: "live", active: true },
  ];
  db.lot_reservations = [
    { park_lot_id: "l1", renter_id: "r1", during: "[2026-01-01,2027-01-01)", status: "active", term: "monthly" },
    { park_lot_id: "l9", renter_id: "rx", during: "[2026-01-01,2027-01-01)", status: "active", term: "monthly" },
  ];
  db.lot_rates = [
    { park_lot_id: "l1", term: "monthly", amount: "400" },
    { park_lot_id: "l2", term: "monthly", amount: "425" },
  ];
  db.park_renters = [
    { id: "r1", park_id: PARK, email: "a@example.com", phone_on_file_with_park: "2605551212", invite_sent_at: "2026-09-01T00:00:00Z", claim_code_issued_at: null },
    { id: "r2", park_id: PARK, email: null, phone_on_file_with_park: null, invite_sent_at: null, claim_code_issued_at: "2026-09-03T00:00:00Z" },
  ];
  db.park_charges = [];
  db.park_payments = [
    { id: "p1", park_id: PARK, reversed_at: "2026-09-05T00:00:00Z" },
    { id: "p2", park_id: "other", reversed_at: null },
  ];
  db.park_fees = [{ id: "f1", park_id: PARK, active: true }, { id: "f2", park_id: PARK, active: false }];
  db.park_document_deliveries = [{ id: "d1", park_renter_id: "r1" }, { id: "d2", park_renter_id: "rx" }];
  db.park_reminders = [
    { id: "m1", park_id: PARK, party: "resident", outcome: "sent" },
    { id: "m2", park_id: PARK, party: "resident", outcome: "blocked" },
    { id: "m3", park_id: PARK, party: "owner", outcome: "sent" },
  ];
  db.acceptances = [{ user_id: OWNER, document_kind: "tos", act: "accepted", document_version: TOS_VERSION, occurred_at: "2026-08-01T00:00:00Z" }];
}

describe("getReadinessFacts, against a mocked database", () => {
  beforeEach(seed);

  it("comes back with the counts off the rows, scoped to the park", async () => {
    const res = await getReadinessFacts(PARK);
    expect(res).not.toBeNull();
    expect(res!.facts).toMatchObject({
      parkName: "Cedar Hollow", lots: 2, liveLots: 2, activeLots: 2, liveLotsWithRate: 2, monthlyRoll: 825,
      occupiedLiveLots: 1, reservedLiveLots: 0, householdsMissingContact: 0, cutoverOn: "2027-01-01", rentDueDay: 1, maxAgreementMonths: 6,
      activeFees: 1, lakeName: "Big Long Lake", hasMapPin: true, termsAccepted: true, published: false, viewerIsOwner: true,
      noticesHeldOn: "2026-08-21", onlineRentOn: false,
    });
    // slipsIssued off the stamp; paymentsRecorded counts the REVERSED row
    // (a bounced cheque still proves a receipt may have gone) and not the
    // other park's.
    expect(res!.contact).toEqual({ invitesSent: 1, documentsDelivered: 1, remindersSent: 1, slipsIssued: 1, chargesRaised: 0, paymentsRecorded: 1 });
  });

  it("is null for somebody who does not manage the park, and a manager is not the owner", async () => {
    db.park_members = [];
    expect(await getReadinessFacts(PARK)).toBeNull();
    db.park_members = [{ park_id: PARK, user_id: OWNER, role: "manager" }];
    expect((await getReadinessFacts(PARK))!.facts.viewerIsOwner).toBe(false);
  });

  it("a failed lots read REJECTS — never resolves with lots: 0", async () => {
    failing.add("park_lots");
    await expect(getReadinessFacts(PARK)).rejects.toThrow(/Couldn't read your lots/);
  });

  it("every other table failing rejects too, including the counts", async () => {
    for (const t of ["parks", "lot_reservations", "lot_rates", "park_renters", "park_charges", "park_payments", "lakes", "park_fees", "park_document_deliveries", "park_reminders", "acceptances"]) {
      seed();
      failing.add(t);
      await expect(getReadinessFacts(PARK), `${t} failing should reject`).rejects.toThrow(/Couldn't read/);
    }
  });

  it("readinessExtras alone: the lake is skipped without an id, deliveries without households", async () => {
    const e = await readinessExtras(PARK, null, []);
    expect(e).toMatchObject({ lakeName: null, activeFees: 1, documentsDelivered: 0, remindersSent: 1, paymentsRecorded: 1, termsAccepted: true });
    // No lake id, so a failing lakes table is never consulted…
    failing.add("lakes");
    expect((await readinessExtras(PARK, null, [])).lakeName).toBeNull();
    // …but with one it throws.
    await expect(readinessExtras(PARK, "lake-1", [])).rejects.toThrow(/lake/);
  });
});
