import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE NIGHTLY, UNDER "THE CREW SETS THE PRICE" (0174).
 *
 * Three things have to be true at once and this file pins all three:
 *
 *  1. On a crew_priced service the nightly must NOT write a menu price. That
 *     pass is the only thing in the codebase that changes a live customer
 *     price with nobody watching, and a service whose price the crew sets has
 *     no menu for it to raise.
 *  2. A fill-in offer on a crew-priced job is anchored on the CREW'S OWN CARD
 *     and expressed as a PAYOUT — what lands in their account — not on a
 *     menu-derived ceiling.
 *  3. Nothing changes on the crew_priced = false path. That is the whole
 *     contract of the flag, so every test below has a menu-priced twin that
 *     must come out exactly as it did before 0174 existed.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/payments-server", () => ({ LakeLifePaymentsServer: { charge: vi.fn(async () => ({ ok: true, ref: "ref_test" })) } }));
vi.mock("@/app/book/dispatch", () => ({
  revalidateJob: vi.fn(async () => {}),
  autoAssignJob: vi.fn(async () => null),
  // Every property in this file is a 2-acre lot with a medium lawn — the
  // profile only has to be non-null and consistent; the prices under test come
  // from the flat `base` on each rate card, never from the profile.
  loadPricingProfileById: vi.fn(async () => ({ lawn_band: "medium", pier_sections: 0, boats: [] })),
}));
vi.mock("@/app/vendor/onboarding-helpers", () => ({ coiRevalidationDue: () => false }));
vi.mock("@/app/requests/offer-data", () => ({ computeScarcityOffer: vi.fn(async () => null) }));
vi.mock("@/app/ops/data", () => ({ computeMenuSuggestions: vi.fn(async () => []) }));
vi.mock("@/lib/menu-core", () => ({ executeMenuUpdate: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/vendor/open-data", () => ({ loadGapAnchor: vi.fn(async () => null) }));

const SETTINGS = {
  marginFloor: 0.20,
  priceAutoapplyMaxPct: 0.40,
  gapAnchorPct: 0.95,
  gapMinOffer: 20,
  fillinDigestMin: 100,
  fillinDigestCooldownDays: 30,
  lakeDemotionCooldownDays: 30,
  platformFeeCustomerPct: 0.12,
  platformFeeCrewPct: 0.12,
};
vi.mock("@/lib/settings", () => ({ getPlatformSettings: vi.fn(async () => SETTINGS) }));

// ---------------------------------------------------------------------------
// A fake Supabase small enough to read: an in-memory table per name, the
// chainable builder shape the runners use, and ONE extra knob the existing
// harness doesn't have — an error injectable at a single named read, so
// "couldn't tell whether this service is crew-priced" can be tested without
// breaking every other read of the same table.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const table = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};
/** [table, substring of the selected column list] -> the error it answers with. */
let failRead: { table: string; cols: string; error: { code?: string; message: string } } | null = null;

interface Filter { kind: string; col: string; val: unknown }
const matches = (row: Row, f: Filter): boolean => {
  const v = row[f.col];
  switch (f.kind) {
    case "eq": return v === f.val;
    case "in": return (f.val as unknown[]).includes(v);
    case "is": return v == null;
    case "not_is": return v != null;
    case "lt": return String(v) < String(f.val);
    case "lte": return String(v) <= String(f.val);
    case "gte": return String(v) >= String(f.val);
    default: return true;
  }
};

class Query implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | null = null;
  private cols = "";
  private wantSingle = false;
  private limitN = Infinity;
  constructor(private name: string) {}
  select(cols?: string) { if (this.op === "select") this.cols = cols ?? ""; return this; }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push({ kind: "eq", col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ kind: "in", col, val }); return this; }
  is(col: string) { this.filters.push({ kind: "is", col, val: null }); return this; }
  not(col: string) { this.filters.push({ kind: "not_is", col, val: null }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ kind: "lt", col, val }); return this; }
  lte(col: string, val: unknown) { this.filters.push({ kind: "lte", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ kind: "gte", col, val }); return this; }
  order() { return this; }
  limit(n: number) { this.limitN = n; return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }

  private run() {
    if (failRead && this.op === "select" && this.name === failRead.table && this.cols.includes(failRead.cols)) {
      return { data: null, error: failRead.error };
    }
    const rows = table(this.name);
    if (this.op === "insert") {
      const row: Row = { id: `${this.name}-${rows.length + 1}`, ...(this.payload ?? {}) };
      rows.push(row);
      return { data: this.wantSingle ? row : [row], error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => matches(r, f)));
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.payload);
      return { data: this.wantSingle ? hit[0] ?? null : hit, error: null };
    }
    if (this.op === "delete") {
      for (const r of hit) { const i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1); }
      return { data: hit, error: null };
    }
    const page = hit.slice(0, Number.isFinite(this.limitN) ? this.limitN : undefined);
    return this.wantSingle ? { data: page[0] ?? null, error: null } : { data: page, error: null };
  }
  then<A, B>(res?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null, rej?: ((r: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run() as { data: unknown; error: { message: string } | null }).then(res, rej);
  }
}
const fakeClient = { from: (name: string) => new Query(name) };
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => fakeClient }));

const {
  autoApplyPriceSuggestions, runFillInDigest, resolveRushFallbacks,
  crewPricedGapOffer, isMissingColumnError, loadCrewPricedServiceIds,
} = await import("@/lib/automation");
const { computeMenuSuggestions } = await import("@/app/ops/data");
const { executeMenuUpdate } = await import("@/lib/menu-core");
const { loadGapAnchor } = await import("@/app/vendor/open-data");
const { sendEmail } = await import("@/lib/email");

beforeEach(() => {
  db.clear();
  failRead = null;
  vi.mocked(computeMenuSuggestions).mockReset().mockResolvedValue([]);
  vi.mocked(executeMenuUpdate).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(loadGapAnchor).mockReset().mockResolvedValue(null as never);
  vi.mocked(sendEmail).mockReset().mockResolvedValue({ ok: true } as never);
});

// ===========================================================================
// 1. "We could not tell" is not "no".
// ===========================================================================
describe("isMissingColumnError — a column that does not exist yet is a FACT, a dropped read is not", () => {
  it("recognises PostgREST's 42703 by code", () => {
    expect(isMissingColumnError({ code: "42703", message: `column services.crew_priced does not exist` })).toBe(true);
  });
  it("recognises it by message alone, for a client that drops the code", () => {
    expect(isMissingColumnError({ message: `column services.crew_priced does not exist` })).toBe(true);
  });
  it("does NOT swallow a real read failure", () => {
    expect(isMissingColumnError({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false);
    expect(isMissingColumnError({ message: "TypeError: fetch failed" })).toBe(false);
  });
  it("is false for no error at all", () => {
    expect(isMissingColumnError(null)).toBe(false);
  });
});

describe("loadCrewPricedServiceIds — the three answers it can give", () => {
  it("names the crew-priced services and only those", async () => {
    table("services").push({ id: "svc-mow", crew_priced: false }, { id: "svc-wash", crew_priced: true });
    const ids = await loadCrewPricedServiceIds(fakeClient as never);
    expect([...(ids ?? [])]).toEqual(["svc-wash"]);
  });
  it("answers 'none' — not 'unknown' — before 0174 has been applied", async () => {
    failRead = { table: "services", cols: "crew_priced", error: { code: "42703", message: `column services.crew_priced does not exist` } };
    const ids = await loadCrewPricedServiceIds(fakeClient as never);
    expect(ids).toBeInstanceOf(Set);
    expect(ids?.size).toBe(0);
  });
  it("answers 'unknown' — not 'none' — when the read genuinely failed", async () => {
    failRead = { table: "services", cols: "crew_priced", error: { code: "57014", message: "statement timeout" } };
    expect(await loadCrewPricedServiceIds(fakeClient as never)).toBeNull();
  });
});

// ===========================================================================
// 2. The fill-in offer arithmetic, on its own.
// ===========================================================================
describe("crewPricedGapOffer — anchored on the crew's own card, paid as a payout", () => {
  const fee = { customerPct: 0.12, crewPct: 0.12 };

  it("is 95% of their anchor rate, $5-stepped, LESS the crew fee", () => {
    // Anchor $200 → 95% is $190 → already on a $5 step → payout 190 × 0.88.
    // 167.20 is computed here from the SEEDED anchor and the SEEDED dials, not
    // from the expression under test.
    expect(crewPricedGapOffer(200, fee, 0.95, 20)).toBe(167.2);
  });

  it("is NOT the crew's card, and NOT 95% of it — the fee has to be visible in the number", () => {
    const offer = crewPricedGapOffer(200, fee, 0.95, 20);
    expect(offer).not.toBe(200);
    expect(offer).not.toBe(190);
  });

  it("carries cents rather than rounding to dollars", () => {
    // $416 of anchor → 95% is $395.20 → $5-stepped DOWN to $395 → × 0.88.
    expect(crewPricedGapOffer(416, fee, 0.95, 20)).toBe(347.6);
  });

  it("applies the dust guard to the PAYOUT, not to the quote", () => {
    // Anchor $25 → 95% is $23.75 → $5-stepped to $20, which clears the $20
    // minimum as a QUOTE — but $17.60 lands in their account, and that is the
    // number the minimum is a statement about.
    expect(crewPricedGapOffer(25, fee, 0.95, 20)).toBeNull();
    // $30 of anchor → $28.50 → $25 → $22.00 in hand: over the line.
    expect(crewPricedGapOffer(30, fee, 0.95, 20)).toBe(22);
  });

  it("never invents an offer for a crew with no card", () => {
    expect(crewPricedGapOffer(null, fee, 0.95, 20)).toBeNull();
    expect(crewPricedGapOffer(0, fee, 0.95, 20)).toBeNull();
    expect(crewPricedGapOffer(-40, fee, 0.95, 20)).toBeNull();
  });

  it("does not depend on a job id — there is no jitter on this path", () => {
    // The signature cannot take one, which is the point: jittering a figure
    // the crew can compute from their own card and a published 12% only makes
    // their pay look arbitrary.
    expect(crewPricedGapOffer.length).toBeLessThanOrEqual(4);
    expect(crewPricedGapOffer(200, fee, 0.95, 20)).toBe(crewPricedGapOffer(200, fee, 0.95, 20));
  });
});

// ===========================================================================
// 3. The nightly menu-price writer.
// ===========================================================================
describe("autoApplyPriceSuggestions — a crew-priced service has no menu to raise", () => {
  const suggestion = (serviceId: string, serviceName: string) => ({
    serviceId, serviceName, lakeName: "Big Long", field: "base" as const,
    newValue: 150, currentValue: 120, raisePct: 0.25,
    label: `raise ${serviceName} base to $150`, drivenByVendorId: null,
  });

  it("applies a suggestion on a MENU-priced service, exactly as it always has", async () => {
    table("services").push({ id: "svc-mow", crew_priced: false, last_auto_priced_at: null });
    vi.mocked(computeMenuSuggestions).mockResolvedValue([suggestion("svc-mow", "Mow & blow")]);
    const r = await autoApplyPriceSuggestions();
    expect(r.applied).toBe(1);
    expect(vi.mocked(executeMenuUpdate).mock.calls[0]?.[1]).toMatchObject({ serviceId: "svc-mow" });
    expect(r.skipped).toEqual([]);
  });

  it("does NOT touch the menu of a crew-priced service, and names it in the digest", async () => {
    table("services").push({ id: "svc-wash", crew_priced: true, last_auto_priced_at: null });
    vi.mocked(computeMenuSuggestions).mockResolvedValue([suggestion("svc-wash", "Window washing")]);
    const r = await autoApplyPriceSuggestions();
    expect(r.applied).toBe(0);
    expect(executeMenuUpdate).not.toHaveBeenCalled();
    expect(r.skipped.join(" ")).toContain("Window washing");
    expect(r.skipped.join(" ")).toContain("crew sets the price");
  });

  it("holds back only the crew-priced one when both are suggested the same night", async () => {
    table("services").push(
      { id: "svc-mow", crew_priced: false, last_auto_priced_at: null },
      { id: "svc-wash", crew_priced: true, last_auto_priced_at: null },
    );
    vi.mocked(computeMenuSuggestions).mockResolvedValue([
      suggestion("svc-wash", "Window washing"), suggestion("svc-mow", "Mow & blow"),
    ]);
    const r = await autoApplyPriceSuggestions();
    expect(r.applied).toBe(1);
    expect(vi.mocked(executeMenuUpdate).mock.calls.map((c) => (c[1] as { serviceId: string }).serviceId)).toEqual(["svc-mow"]);
    expect(r.skipped.join(" ")).toContain("Window washing");
    expect(r.skipped.join(" ")).not.toContain("Mow & blow");
  });

  it("applies everything as usual before 0174 has been applied (no column, no crew pricing)", async () => {
    table("services").push({ id: "svc-mow", last_auto_priced_at: null });
    failRead = { table: "services", cols: "crew_priced", error: { code: "42703", message: `column services.crew_priced does not exist` } };
    vi.mocked(computeMenuSuggestions).mockResolvedValue([suggestion("svc-mow", "Mow & blow")]);
    const r = await autoApplyPriceSuggestions();
    expect(r.applied).toBe(1);
    expect(r.skipped).toEqual([]); // and it does NOT nag every night until the migration lands
  });

  it("FAILS CLOSED and prices nothing when it cannot tell which services the crew prices", async () => {
    table("services").push({ id: "svc-mow", crew_priced: false, last_auto_priced_at: null });
    failRead = { table: "services", cols: "crew_priced", error: { code: "57014", message: "statement timeout" } };
    vi.mocked(computeMenuSuggestions).mockResolvedValue([suggestion("svc-mow", "Mow & blow")]);
    const r = await autoApplyPriceSuggestions();
    expect(r.applied).toBe(0);
    expect(executeMenuUpdate).not.toHaveBeenCalled();
    expect(r.skipped.join(" ")).toContain("couldn't read which services the crew prices");
  });
});

// ===========================================================================
// 4. The fill-in digest, end to end — the number a real crew is emailed.
// ===========================================================================
describe("runFillInDigest — what a crew is told a crew-priced fill-in pays", () => {
  const yesterday = new Date(Date.now() - 36 * 3_600_000).toISOString();
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

  /** Two aged, unassigned jobs on the crew's lake for the same service. */
  const seed = (serviceId: string, crewPriced: boolean, customerPrice: number, card: number) => {
    table("services").push({ id: serviceId, crew_priced: crewPriced });
    for (const n of [1, 2]) {
      table("jobs").push({
        id: `job-${n}`, date: soon, customer_price: customerPrice, service_id: serviceId,
        property_id: `prop-${n}`, created_at: yesterday, status: "requested",
        vendor_id: null, group_id: null, is_rush: null,
        services: { name: "Window washing", pricing_model: "flat" },
        properties: { lake_id: "lake-1" },
      });
    }
    table("vendors").push({
      id: "v-1", user_id: "u-1", company: "Shoreline Crew", status: "active",
      service_types: ["Window washing"], service_lakes: ["lake-1"], work_days: [],
      coi_expiry: "2099-01-01", "users.is_fixture": false,
    });
    table("vendor_rates").push({ vendor_id: "v-1", service_id: serviceId, base: card, unit_rate: 0, band_pricing: null });
    table("users").push({ id: "u-1", email: "crew@example.com" });
  };

  const subjectSent = () => String(vi.mocked(sendEmail).mock.calls[0]?.[0]?.subject ?? "");

  it("offers a PAYOUT off the crew's own card — not the menu-derived ceiling", async () => {
    // Card $200. Customer price on a crew-priced service is 200 × 1.12 = $224,
    // seeded so the MENU branch would also fire if it were reached: it would
    // offer gapTakeHome($224, 0.20) = $175 (less jitter), never $167.20.
    seed("svc-wash", true, 224, 200);
    vi.mocked(loadGapAnchor).mockResolvedValue(200 as never);
    const r = await runFillInDigest();
    expect(r.sent).toBe(1);
    // 2 × $167.20 = $334.40, printed to whole dollars.
    expect(subjectSent()).toContain("$334");
    expect(subjectSent()).not.toContain("$350"); // 2 × $175, the menu-path answer
  });

  it("leaves the MENU path byte for byte — same fixture, crew_priced false", async () => {
    seed("svc-wash", false, 224, 200);
    vi.mocked(loadGapAnchor).mockResolvedValue(200 as never);
    const r = await runFillInDigest();
    expect(r.sent).toBe(1);
    // gapTakeHome(224, 0.20) = floor(179.2/5)*5 = 175, minus a $0/$5/$10
    // per-job jitter, capped by 95% of the $200 anchor ($190) — so each job
    // offers 165, 170 or 175 and the pair totals 330…350. The point of the
    // assertion is that it is the menu ladder, not the fee arithmetic.
    const total = Number(subjectSent().match(/\$(\d+)/)?.[1]);
    expect(total).toBeGreaterThanOrEqual(330);
    expect(total).toBeLessThanOrEqual(350);
    expect(total % 5).toBe(0); // the $5 step survives — the fee path has no step
  });

  it("emails nobody, and says so, when it cannot tell which model applies", async () => {
    seed("svc-wash", true, 224, 200);
    vi.mocked(loadGapAnchor).mockResolvedValue(200 as never);
    failRead = { table: "services", cols: "crew_priced", error: { code: "57014", message: "statement timeout" } };
    const r = await runFillInDigest();
    expect(r.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.skipped.join(" ")).toContain("couldn't read which services the crew prices");
  });

  it("does not email a FIXTURE crew a real dollar figure", async () => {
    seed("svc-wash", true, 224, 200);
    table("vendors")[0]["users.is_fixture"] = true; // the scratch accounts, fenced off every other crew doorway
    vi.mocked(loadGapAnchor).mockResolvedValue(200 as never);
    const r = await runFillInDigest();
    expect(r.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. THE ALARM. A machine that can now skip a whole class of services has to
//    be able to say it skipped them — otherwise the digest reports a quiet
//    night while rush jobs sit unresolved.
// ===========================================================================
describe("resolveRushFallbacks — a rush job it cannot roll is NAMED, not silently left", () => {
  const dayBefore = () => {
    const d = new Date(Date.now() - 2 * 86_400_000);
    return d.toISOString().slice(0, 10);
  };

  const seedRush = (serviceId: string, crewPriced: boolean) => {
    table("services").push({ id: serviceId, crew_priced: crewPriced });
    table("jobs").push({
      id: "job-rush", date: dayBefore(), rush_fallback: "roll", service_id: serviceId,
      property_id: "prop-1", customer_price: 280, status: "requested", vendor_id: null, is_rush: true,
      services: { name: "Window washing", pricing_model: "flat", base: 0, unit_rate: 0, band_pricing: null },
      properties: { owner_id: "owner-1", address: "12 Shore Rd", nickname: "The Cottage" },
    });
    table("users").push({ id: "owner-1", phone: "+15550000000", email: "owner@example.com" });
  };

  it("says out loud that a crew-priced rush job has no standard price to roll to", async () => {
    seedRush("svc-wash", true);
    const r = await resolveRushFallbacks();
    expect(r.rolled).toBe(0);
    expect(r.skipped.join(" ")).toContain("job-rush");
    expect(r.skipped.join(" ")).toContain("priced by the crew");
    // And the job is still sitting there for a person — not quietly deleted
    // or quietly moved with its 25% same-day premium intact.
    expect(table("jobs")[0].date).toBe(dayBefore());
    expect(table("jobs")[0].customer_price).toBe(280);
  });

  it("says out loud when it could not even tell which model applies", async () => {
    seedRush("svc-wash", false);
    failRead = { table: "services", cols: "crew_priced", error: { code: "57014", message: "statement timeout" } };
    const r = await resolveRushFallbacks();
    expect(r.rolled).toBe(0);
    expect(r.skipped.join(" ")).toContain("couldn't read whether this service is crew-priced");
  });

  it("rolls a MENU-priced rush job to tomorrow's standard price, exactly as before", async () => {
    seedRush("svc-wash", false);
    // The menu row the roll reprices from: $200 flat, well under the $280 the
    // same-day premium bought.
    const job = table("jobs")[0] as { services: Record<string, unknown> };
    job.services.base = 200;
    const r = await resolveRushFallbacks();
    expect(r.rolled).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(table("jobs")[0].customer_price).toBe(200);
    expect(table("jobs")[0].is_rush).toBe(false);
  });
});
