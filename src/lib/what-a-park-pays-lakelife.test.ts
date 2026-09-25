import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  countableLots, feeFor, rateCentsFor, feeSentence, feeMonthWords, money,
  invoiceRefusal, MIN_FEE_PER_LOT, MAX_FEE_PER_LOT, type FeeLot,
} from "./park-platform-fee";
import { firstBillablePeriod } from "./billing-start";

/**
 * WHAT A PARK PAYS LAKELIFE — $8 PER LOT PER MONTH, AND NOBODY IS CHARGED.
 *
 * Two classes of test, and the second is the important one. The arithmetic is
 * easy; what is hard is that LakeLife's own revenue must never land on a
 * resident's bill, and that a figure written down is never mistaken for a bill
 * that was sent. Those are structural, so they are scanned rather than asserted.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const lot = (over: Partial<FeeLot> = {}): FeeLot => ({
  lotNumber: "1", active: true, lifecycle: "live", parkOwnedHome: false, siteType: "mh_single", ...over,
});

/** The Haven as production actually holds it: 21 lots, Lot 11 the park's own. */
const HAVEN: FeeLot[] = ["1","2","6","7","9","10","11","14","15","16","17","18","19","20","21","22","23","24","26","27","28"]
  .map((n) => lot({ lotNumber: n, parkOwnedHome: n === "11" }));

// ---------------------------------------------------------------------------
describe("which lots the fee counts", () => {
  it("counts The Haven at 20, not 21 — the park's own home is not billed", () => {
    const c = countableLots(HAVEN);
    expect(c.count).toBe(20);
    expect(c.lotNumbers).not.toContain("11");
    expect(c.excluded).toEqual([{ lotNumber: "11", because: "the park's own home" }]);
  });

  it("is $160.00 a month, not $168.00", () => {
    // THE WHOLE POINT OF EXCLUDING LOT 11. $10,850.60 — the 1 January roll — is
    // exactly 20 x $542.53, so his own plan already treats the park-owned home
    // as a lot that earns nothing. Charging $8 for it invoices him for his own
    // house.
    expect(feeFor(HAVEN, 800).amountCents).toBe(16000);
    expect(money(feeFor(HAVEN, 800).amountCents)).toBe("$160.00");
    expect(money(feeFor(HAVEN.map((l) => ({ ...l, parkOwnedHome: false })), 800).amountCents)).toBe("$168.00");
  });

  it("drops a lot that is not live, out of service, a slip or a storage space", () => {
    const mixed: FeeLot[] = [
      lot({ lotNumber: "1" }),
      lot({ lotNumber: "2", lifecycle: "planned" }),
      lot({ lotNumber: "3", active: false }),
      lot({ lotNumber: "4", siteType: "slip" }),
      lot({ lotNumber: "5", siteType: "storage" }),
      lot({ lotNumber: "6", lifecycle: "retired" }),
    ];
    const c = countableLots(mixed);
    expect(c.lotNumbers).toEqual(["1"]);
    expect(c.excluded.map((e) => e.lotNumber)).toEqual(["2", "3", "4", "5", "6"]);
    // Every exclusion says WHY, because the bill prints them.
    for (const e of c.excluded) expect(e.because.length).toBeGreaterThan(3);
  });

  it("never asks about occupancy — there is no tenancy input at all", () => {
    // Occupancy reads ZERO today (park_renters is empty) and four existing
    // helpers disagree about it on 1 January: 18, 19, 20 or 21, a $24/month
    // spread decided by which file the code was copied from. The type is the
    // enforcement — there is nowhere to put a tenancy.
    const keys = Object.keys(lot());
    expect(keys.sort()).toEqual(["active", "lifecycle", "lotNumber", "parkOwnedHome", "siteType"]);
    const src = strip(read("lib/park-platform-fee.ts"));
    for (const forbidden of [/park_renters/, /reservation/i, /\btenanc/i, /occupied/i]) {
      expect(src, `the rule reached for ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
describe("the rate for one park", () => {
  it("uses the list price when the park has no rate of its own", () => {
    expect(rateCentsFor(8, null)).toBe(800);
    expect(rateCentsFor(8, undefined)).toBe(800);
  });

  it("A PARK HELD FREE STAYS FREE — 0 is a rate, not an absence", () => {
    // `||` would treat 0 as absent and silently invoice the list price. This is
    // the falsy-versus-null mistake this codebase has already paid for, and it
    // is worth real money: a pilot park billed $160 it was promised it would not be.
    expect(rateCentsFor(8, 0)).toBe(0);
    expect(feeFor(HAVEN, rateCentsFor(8, 0)).amountCents).toBe(0);
  });

  it("a park's own rate REPLACES the list price and never blends with it", () => {
    expect(rateCentsFor(8, 1200)).toBe(1200);
    expect(rateCentsFor(8, 600)).toBe(600);
  });

  it("clamps a nonsense list price rather than inventing one", () => {
    expect(rateCentsFor(Number.NaN, null)).toBe(0);
    expect(rateCentsFor(-5, null)).toBe(0);
    expect(rateCentsFor(MAX_FEE_PER_LOT + 50, null)).toBe(MAX_FEE_PER_LOT * 100);
    expect(rateCentsFor(MIN_FEE_PER_LOT, null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("what the bill says it counted", () => {
  const fee = feeFor(HAVEN, 800);

  it('says "20 of 21 lots counted", never "20 lots in service"', () => {
    // "In service" is the owner-facing label of park_lots.active, and at The
    // Haven TWENTY-ONE lots carry that tick. A bill claiming "20 lots in
    // service" disagrees by one lot and $8 with the lots screen — and the bill
    // is the one asserting money.
    const s = feeSentence({
      parkName: "The Haven", periodMonth: "2027-01",
      count: fee.count, rateCents: fee.rateCents, amountCents: fee.amountCents, excluded: fee.excluded,
    });
    expect(s).toContain("20 of 21 lots counted");
    expect(s).not.toMatch(/lots in service/);
    expect(s).toContain("$8.00");
    expect(s).toContain("$160.00");
    expect(s).toContain("Not counted: Lot 11 (the park's own home)");
  });

  it("writes the month in words a person reads", () => {
    expect(feeMonthWords("2027-01")).toBe("January 2027");
    expect(feeMonthWords("2026-12")).toBe("December 2026");
    const s = feeSentence({ parkName: "X", periodMonth: "2027-01", count: 1, rateCents: 800, amountCents: 800 });
    expect(s).toContain("January 2027");
    expect(s).not.toContain("2027-01");
  });

  it("opens on the park, not a dangling dash, when there is no month", () => {
    // The dial's per-park preview asks "what would a month raised today say" —
    // which has no month. Interpolating the empty string left every line on
    // that screen starting " — The Haven", which reads as a figure whose
    // period went missing.
    const s = feeSentence({ parkName: "The Haven", periodMonth: "", count: 20, rateCents: 800, amountCents: 16000 });
    expect(s.startsWith("The Haven.")).toBe(true);
    expect(s).not.toContain(" — ");
  });

  it("formats money to the cent, never a bare rounded dollar", () => {
    expect(money(16000)).toBe("$160.00");
    expect(money(800)).toBe("$8.00");
    expect(money(0)).toBe("$0.00");
    expect(money(123456789)).toBe("$1,234,567.89");
  });
});

// ---------------------------------------------------------------------------
describe("when a month may be invoiced", () => {
  it("refuses every month while the park has no start month", () => {
    // The fact that is FALSE on day one, for every park including The Haven.
    expect(invoiceRefusal({ periodMonth: "2027-01", startMonth: null, cutoverDate: null }))
      .toMatch(/isn't being billed yet/);
  });

  it("refuses a month before the park's fee starts", () => {
    expect(invoiceRefusal({ periodMonth: "2026-12", startMonth: "2027-01", cutoverDate: null }))
      .toMatch(/December 2026 is before/);
  });

  it("refuses a month that began before the park was taken over", () => {
    // The park section of the terms IN FORCE says, unqualified as to whose
    // bill: "Once you tell us the day you took the park over, it will not bill
    // for any month that began before it." An invoice for December when the
    // park changed hands on 15 December contradicts a sentence he has accepted.
    const r = invoiceRefusal({ periodMonth: "2026-12", startMonth: "2026-12", cutoverDate: "2026-12-15" });
    expect(r).toMatch(/began before this park was taken over/);
    expect(r).toContain("January 2027");
  });

  it("asks the function that already encodes the boundary, not a second copy", () => {
    // Two implementations of one date rule is how they come to disagree.
    expect(firstBillablePeriod("2026-12-15")).toBe("2027-01");
    expect(invoiceRefusal({ periodMonth: "2027-01", startMonth: "2027-01", cutoverDate: "2026-12-15" })).toBeNull();
    expect(strip(read("lib/park-platform-fee.ts"))).toMatch(/firstBillablePeriod\(/);
  });

  it("lets the right month through", () => {
    expect(invoiceRefusal({ periodMonth: "2027-01", startMonth: "2027-01", cutoverDate: "2026-12-15" })).toBeNull();
    expect(invoiceRefusal({ periodMonth: "2027-06", startMonth: "2027-01", cutoverDate: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("LakeLife's revenue cannot reach a resident's bill", () => {
  const FEE_FILES = [
    "lib/park-platform-fee.ts",
    "app/ops/park-fee-data.ts",
    "app/ops/park-fee-actions.ts",
    "components/ops/ParkPlatformFeeDial.tsx",
  ];

  it("no fee file writes a park→resident money table", () => {
    // THE NEXT, VERY PLAUSIBLE ASK is owner convenience: "when ops raises the
    // invoice, also file it in his books so his CPA sees it." A park_costs row
    // SPLITS across lots and lands on nineteen rent bills — that one edit turns
    // LakeLife's revenue into a resident charge, and it would pass typecheck.
    const FORBIDDEN = ["park_costs", "park_fees", "park_charges", "lot_cost_shares", "park_payments", "lot_fee_assignments"];
    for (const f of FEE_FILES) {
      const src = strip(read(f));
      for (const table of FORBIDDEN) {
        expect(src, `${f} names ${table}`).not.toContain(table);
      }
    }
  });

  it("no fee file can charge, refund or send", () => {
    for (const f of FEE_FILES) {
      const src = strip(read(f));
      for (const forbidden of ["sendEmail", "sendSms", "takePayment", "giveRefund", "notify("]) {
        expect(src, `${f} imports or calls ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("NOTHING ANYWHERE IN src/ THAT TOUCHES THIS FEE CAN SEND", () => {
    // A four-file allowlist is not a fence — the next file is not on it. This
    // scans EVERY source file and fails if any file naming this feature also
    // reaches for a send. His instruction is absolute: nothing goes out until
    // he says.
    const NAMES = /lakelife_park_invoices|lakelife_park_terms|park_platform_fee_per_lot|parkPlatformFeePerLot|raiseParkPlatformInvoice/;
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = strip(readFileSync(file, "utf8"));
      if (!NAMES.test(src)) continue;
      if (/\bsendEmail\b|\bsendSms\b/.test(src)) offenders.push(file.slice(SRC.length));
    }
    expect(offenders, "a file that handles the park fee also sends messages").toEqual([]);
  });

  it("the invoice table carries no column a household could hang on", () => {
    const sql = read("../supabase/migrations/0182_what_a_park_pays_lakelife.sql");
    const table = sql.slice(sql.indexOf("create table if not exists public.lakelife_park_invoices"));
    const body = table.slice(0, table.indexOf(");"));
    for (const forbidden of [/renter_id/, /park_lot_id/, /reservation_id/, /charge_id/, /\bpaid\b/, /\bsent\b/]) {
      expect(body, `the invoice table grew ${forbidden}`).not.toMatch(forbidden);
    }
    // And its direction is single-valued, so the DB refuses any other claim.
    expect(sql).toMatch(/check \(direction = 'lakelife_to_park'\)/);
  });

  it("the tables are unreachable by any client", () => {
    const sql = read("../supabase/migrations/0182_what_a_park_pays_lakelife.sql");
    expect(sql).toMatch(/revoke all on public\.lakelife_park_terms\s+from anon, authenticated/);
    expect(sql).toMatch(/revoke all on public\.lakelife_park_invoices from anon, authenticated/);
    // And no policy, so nothing outside the service role can select either.
    expect(sql).not.toMatch(/create policy \w*lakelife_park/);
  });

  it("the commercial terms are NOT on `parks`, which anon may read", () => {
    // 0052 grants `select on public.parks ... to anon` with a policy of
    // `active or manages or ops` — so on any ACTIVE park every column is
    // readable by anyone holding the publishable key in the browser bundle.
    // LakeLife's negotiated per-park rate is not a public fact.
    const sql = read("../supabase/migrations/0182_what_a_park_pays_lakelife.sql");
    expect(sql).not.toMatch(/alter table public\.parks\s+add column/i);
    expect(strip(read("app/ops/park-fee-actions.ts"))).not.toMatch(/from\("parks"\)[\s\S]{0,80}\.update/);
  });
});

// ---------------------------------------------------------------------------
describe("the count is read in ONE place", () => {
  it("only park-fee-data.ts fetches the lots the fee counts", () => {
    // THE BUG THIS PREVENTS, and it is live in the codebase today: the ops
    // board's own park_lots select omits `park_owned_home`, and Lot.parkOwnedHome
    // is OPTIONAL — so handing that row to countableLots compiles, `undefined
    // !== true` passes, and Lot 11 joins the count. The board would print $168
    // while the raise froze $160, with nothing red anywhere.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length);
      if (rel === "app/ops/park-fee-data.ts") continue;
      const src = strip(readFileSync(file, "utf8"));
      if (/countableLots\(|feeFor\(/.test(src) && /\.from\(\s*["']park_lots["']\s*\)/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders, "a second place fetches lots and applies the fee rule").toEqual([]);
    expect(strip(read("app/ops/park-fee-data.ts"))).toMatch(/\.from\("park_lots"\)/);
  });

  it("the raise CALLS feeFor rather than rebuilding the multiplication", () => {
    // A rebuilt expression passes its own test with the real one deleted.
    const src = strip(read("app/ops/park-fee-actions.ts"));
    expect(src).toMatch(/feeFor\(lots, rateCents\)/);
    expect(src, "the action multiplies the money itself").not.toMatch(/count\s*\*\s*rate/i);
  });

  it("FeeLot has no optional field", () => {
    const src = read("lib/park-platform-fee.ts");
    const iface = src.slice(src.indexOf("export interface FeeLot"), src.indexOf("}", src.indexOf("export interface FeeLot")));
    expect(iface).not.toMatch(/\?\s*:/);
  });
});

// ---------------------------------------------------------------------------
describe("the dial fails to OFF", () => {
  it("the code fallback is 0 while the seeded row is 8, on purpose", () => {
    // getPlatformSettings returns DEFAULT_SETTINGS wholesale on a failed read.
    // A code default of 8 would point that path at the ON value: ops sets the
    // dial to 0 to pause a park, the read blips, and a month freezes at $8 a
    // lot. Same property as aiAutoreplyEnabled.
    const settings = strip(read("lib/settings.ts"));
    expect(settings).toMatch(/parkPlatformFeePerLotMonthly:\s*0,/);
    const sql = read("../supabase/migrations/0182_what_a_park_pays_lakelife.sql");
    expect(sql).toMatch(/'park_platform_fee_per_lot_monthly', '8'::jsonb/);
  });

  it("the dial is in the key list, or it would silently read the fallback forever", () => {
    const settings = read("lib/settings.ts");
    expect(settings).toContain('"park_platform_fee_per_lot_monthly"');
    expect(settings).toMatch(/parkPlatformFeePerLotMonthly: parseSetting\(/);
  });
});

// ---------------------------------------------------------------------------
describe("the scanners bite", () => {
  it("catches a forbidden table and clears a clean file", () => {
    const bad = strip(`await admin.from("park_costs").insert({ category: "other" });`);
    expect(bad).toContain("park_costs");
    const good = strip(`// park_costs is the thing we must never write\nawait admin.from("lakelife_park_invoices").insert({});`);
    expect(good).not.toContain("park_costs");
  });

  it("is reading real files, not empty strings", () => {
    expect(read("lib/park-platform-fee.ts").length).toBeGreaterThan(3000);
    expect(read("app/ops/park-fee-actions.ts").length).toBeGreaterThan(3000);
    expect(sourceFiles(SRC).length).toBeGreaterThan(200);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (!/\.tsx?$/.test(name) || name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}
