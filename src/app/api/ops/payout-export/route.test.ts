import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * THE MOST SENSITIVE FILE THIS PRODUCT PRODUCES.
 *
 * One download carries every payee's DECRYPTED routing and account number.
 * Three things were wrong with the way it was handed over:
 *
 *   1. It did not know what a fixture is. Production holds three released
 *      payouts totalling $224 to GreenEdge Lawn Co., whose owner is
 *      `is_fixture = true` — an account we invented ourselves. The moment
 *      somebody puts bank details on a test crew, the bank pays it.
 *   2. Nothing recorded who pulled it. No name, no time, no batch list.
 *   3. The queued → exported flip was a SIDE EFFECT. The comment said as much
 *      — "the CSV is returned regardless" — so a failed flip left the batch
 *      queued AND in ops' hands, and the next export re-included it. Upload
 *      both and the crew is paid twice.
 *
 * These are behavioural. The defects are all in the wiring between a read, a
 * write and a response body, and only running the handler proves the wiring.
 */
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {
  payout_batches: [],
  payout_accounts: [],
  payout_export_events: [],
};

/** Forced failures, keyed `op:table` — the thing that used to be shrugged off. */
const errors: Record<string, string | null> = {};
/** Runs just before an UPDATE resolves, to stage a lost race honestly. */
let beforeUpdate: (() => void) | null = null;

let seq = 0;

class Q implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row | null = null;
  private ins: Row[] = [];
  constructor(private t: string) {}
  select() { return this; }
  update(p: Row) { this.op = "update"; this.patch = p; return this; }
  insert(v: Row | Row[]) { this.op = "insert"; this.ins = Array.isArray(v) ? v : [v]; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  order() { return this; }
  limit() { return this; }
  private run(): { data: Row[] | null; error: { message: string } | null } {
    const forced = errors[`${this.op}:${this.t}`];
    if (forced) return { data: null, error: { message: forced } };
    if (this.op === "insert") {
      const made = this.ins.map((r) => ({ id: `gen-${++seq}`, ...r }));
      (db[this.t] ??= []).push(...made);
      return { data: made, error: null };
    }
    if (this.op === "update" && beforeUpdate) beforeUpdate();
    const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.op === "update" && this.patch) for (const r of hit) Object.assign(r, this.patch);
    return { data: hit, error: null };
  }
  single() {
    const r = this.run();
    if (r.error) return Promise.resolve(r);
    return Promise.resolve({ data: r.data?.[0] ?? null, error: r.data?.length ? null : { message: "no rows" } });
  }
  maybeSingle() {
    const r = this.run();
    return Promise.resolve({ data: r.error ? null : (r.data?.[0] ?? null), error: r.error });
  }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const OPS = { id: "ops-1", name: "Brendon" };
let opsUser: { id: string; name: string | null } | null = OPS;
vi.mock("@/app/ops/data", () => ({ assertOps: async () => opsUser }));

process.env.GATE_ENCRYPTION_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// A DIFFERENT key, because that is now the point: this suite's fixtures go
// through sealSecret, which seals v2 on the bank key and refuses without it.
process.env.BANK_ENCRYPTION_KEY =
  "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

const { sealSecret } = await import("@/lib/gate");
const { POST } = await import("./route");

const ROUTING = "021000021";

/** One batch and the bank account behind it. `fixture` = an account we made up. */
function crew(id: string, name: string, opts: { fixture?: boolean; account: string }) {
  db.payout_batches.push({
    id,
    user_id: `u-${id}`,
    kind: "monthly",
    net: 120,
    status: "queued",
    paid_at: null,
    created_at: "2026-09-30T12:00:00Z",
    vendors: { company: name },
    users: { name, is_fixture: opts.fixture === true },
  });
  db.payout_accounts.push({
    user_id: `u-${id}`,
    bank_name: "First Federal",
    routing_encrypted: sealSecret(ROUTING),
    account_encrypted: sealSecret(opts.account),
  });
}

const pull = async (qs = "") =>
  (await POST(new Request(`http://localhost/api/ops/payout-export${qs}`, { method: "POST" }))) as Response;

beforeEach(() => {
  db.payout_batches = [];
  db.payout_accounts = [];
  db.payout_export_events = [];
  for (const k of Object.keys(errors)) delete errors[k];
  beforeUpdate = null;
  opsUser = OPS;
});

describe("a fixture crew is never in the bank file", () => {
  it("leaves out the made-up crew's bank numbers, and says it did", async () => {
    crew("b-real", "Twin Lakes Crew", { account: "1111222233" });
    crew("b-fake", "GreenEdge Lawn Co.", { fixture: true, account: "9999888877" });

    const body = await (await pull()).text();

    expect(body, "a test account's bank details went into the bank's file").not.toContain("9999888877");
    expect(body).not.toContain("GreenEdge");
    expect(body).toContain("Twin Lakes Crew");
    expect(body).toContain("1111222233");
    expect(body).toMatch(/# excluded \(test accounts[^\n]*: 1/);
  });

  it("does not mark the fixture batch exported — it was never in a file", async () => {
    crew("b-fake", "GreenEdge Lawn Co.", { fixture: true, account: "9999888877" });
    await pull();
    expect(db.payout_batches.find((b) => b.id === "b-fake")!.status).toBe("queued");
  });
});

describe("the flip is a precondition of delivery, not a side effect", () => {
  it("hands over nothing it could not mark exported", async () => {
    crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
    errors["update:payout_batches"] = "deadlock detected";

    const res = await pull();
    const body = await res.text();

    expect(body, "the file went out with a batch still queued — the next export pays it again")
      .not.toContain("1111222233");
    expect(body).toMatch(/# WITHHELD/);
    expect(db.payout_batches[0].status).toBe("queued");
  });

  it("drops only the batch that lost the race, and keeps the rest", async () => {
    crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
    crew("b-2", "Harbor Dock Co.", { account: "4444555566" });
    // Somebody marks b-2 paid between the read and the flip: the guarded
    // update no longer matches it, so it must not be in the file either.
    beforeUpdate = () => {
      db.payout_batches.find((b) => b.id === "b-2")!.status = "paid";
      beforeUpdate = null;
    };

    const body = await (await pull()).text();

    expect(body).toContain("1111222233");
    expect(body, "a batch nobody could mark exported was handed over anyway").not.toContain("4444555566");
    expect(body).toMatch(/# WITHHELD[^\n]*1/);
  });
});

describe("who pulled the bank file", () => {
  it("records the puller, the count and the batches — and no bank numbers", async () => {
    crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
    await pull();

    expect(db.payout_export_events, "nothing anywhere says who downloaded it").toHaveLength(1);
    const ev = db.payout_export_events[0];
    expect(ev.exported_by).toBe("ops-1");
    expect(ev.row_count).toBe(1);
    expect(ev.batch_ids).toEqual(["b-1"]);
    expect(ev.redownload).toBe(false);
    expect(JSON.stringify(ev)).not.toContain(ROUTING);
    expect(JSON.stringify(ev)).not.toContain("1111222233");
  });

  it("marks a re-download as one", async () => {
    crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
    db.payout_batches[0].status = "exported";
    await pull("?redownload=1");
    expect(db.payout_export_events[0].redownload).toBe(true);
  });

  it("refuses to hand the file over when it cannot record the pull", async () => {
    crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
    errors["insert:payout_export_events"] = "relation does not exist";

    const res = await pull();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("1111222233");
  });

  it("writes no audit row for a download with nothing in it", async () => {
    // Nothing sensitive left the building; an empty pull is not a disclosure.
    await pull();
    expect(db.payout_export_events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("nobody else gets to touch a bank number", () => {
  /**
   * THE RULE, NOT THE INSTANCE. This repo's dominant defect is a rule living
   * in one doorway out of three, and the doorway that matters here is "code
   * that can read a crew's routing and account number". Today there are two —
   * one writer, one reader — and the reader is the only place a bank number
   * becomes plaintext.
   *
   * A THIRD ONE FAILS THIS TEST UNTIL A HUMAN CLASSIFIES IT. That is the whole
   * point: the failure mode is an omission, and you cannot write a behavioural
   * test for a fence somebody has not written yet.
   */
  const SRC = join(process.cwd(), "src");

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
      return [p];
    });
  }

  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const ALLOWED = new Set([
    "app/vendor/bank-actions.ts",              // writes them, sealed, never reads back
    "app/api/ops/payout-export/route.ts",      // the only place they become plaintext
    "app/api/ops/payout-export/export-plan.ts", // names the columns; imports no opener
  ]);

  it("the planner cannot decrypt anything on its own", () => {
    // It is on the list above because it names the two columns in a type. The
    // opener is passed in, so it holds no key and no route to one.
    const src = readFileSync(join(SRC, "app/api/ops/payout-export/export-plan.ts"), "utf8");
    expect(src).not.toMatch(/@\/lib\/gate/);
  });

  it("only the two known files name a routing or account blob", () => {
    const touching = walk(SRC)
      .filter((p) => /routing_encrypted|account_encrypted/.test(strip(readFileSync(p, "utf8"))))
      .map((p) => relative(SRC, p).split(sep).join("/"));

    expect(touching.length, "the scanner found nothing — it has stopped working").toBeGreaterThan(0);
    expect(new Set(touching)).toEqual(ALLOWED);
  });

  it("the file that decrypts them fences fixtures and records the pull first", () => {
    const src = strip(readFileSync(join(SRC, "app/api/ops/payout-export/route.ts"), "utf8"));

    // The batch read must carry the payee's own is_fixture, or the planner has
    // nothing to refuse on and GreenEdge is back in the bank's file.
    expect(src).toMatch(/is_fixture/);
    // And the record of who pulled it must be written before the file is.
    const audit = src.indexOf("payout_export_events");
    const handOver = src.lastIndexOf("return csvFile(");
    expect(audit).toBeGreaterThan(-1);
    expect(audit, "the file is handed over before the pull is recorded").toBeLessThan(handOver);
  });
});

/**
 * A KEY THAT IS NOT THERE MUST COST A DELAY, NEVER A WRONG FILE.
 *
 * Bank numbers are sealed on BANK_ENCRYPTION_KEY. If it is missing or rotated,
 * the blob does not open — and the one thing that must not happen is a row in
 * the bank's file with empty routing/account cells, or a batch marked exported
 * that nobody was paid for.
 */
describe("an unopenable bank blob skips its batch, and says so", () => {
  const BANK = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
  afterEach(() => {
    process.env.BANK_ENCRYPTION_KEY = BANK;
  });

  /**
   * THE TWO FAILURES ARE NOT ALIKE, and they used to be counted as one.
   *
   * `gate.ts` goes out of its way to rethrow a named `BankKeyMissingError`
   * rather than let the generic "unable to authenticate data" through, so a
   * reader hunts for an unset environment variable. `planExport` then
   * swallowed it in a bare `catch {}` and counted it as "no bank on file" —
   * so a missing key produced a header-only file, nothing flipped, and a
   * trailing note telling ops that N crews had no bank details. All of them
   * had details; none of them could be read.
   */
  it("A MISSING KEY HANDS OVER NOTHING AND FLIPS NOTHING", async () => {
    crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
    crew("b-2", "Shoreline Mowing", { account: "4444555566" });
    delete process.env.BANK_ENCRYPTION_KEY; // sealed, then the key goes away

    const res = await pull();
    const body = await res.text();

    expect(res.status, "a missing key must not read as a successful export").toBe(503);
    expect(body).not.toContain("1111222233");
    expect(body).not.toContain("4444555566");
    // AND IT BLAMES THE RIGHT THING. "No bank on file" about a crew who has
    // one is the sentence that sends somebody to chase the crews.
    expect(body).toMatch(/configuration, not the crews/i);
    expect(body).toMatch(/still queued/i);
    expect(body).not.toMatch(/no bank on file/i);
    for (const b of db.payout_batches) {
      expect(b.status, "a batch nobody was paid for was marked exported").toBe("queued");
    }
  });

  it("but ONE corrupt blob skips only its own batch", async () => {
    // The promise planExport's own comment makes — "one corrupt or key-rotated
    // blob skips ITS batch, never the whole export" — which had no test that
    // could tell it from the missing-key case, because the only fixture
    // deleted the key.
    crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
    crew("b-2", "Shoreline Mowing", { account: "4444555566" });
    const bad = db.payout_accounts.find((a) => a.user_id === "u-b-1")!;
    bad.account_encrypted = "\\x4c4c02deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const body = await (await pull()).text();

    expect(body, "the corrupt one shipped anyway").not.toContain("1111222233");
    expect(body, "a healthy crew was punished for another's blob").toContain("4444555566");
    expect(body).toMatch(/# skipped \(no bank on file or undecryptable\): 1/);
    expect(db.payout_batches.find((b) => b.id === "b-1")!.status).toBe("queued");
    expect(db.payout_batches.find((b) => b.id === "b-2")!.status).toBe("exported");
  });

  it("ships the same crew normally once the key is back — both ways, same fixture", async () => {
    crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
    process.env.BANK_ENCRYPTION_KEY = BANK;

    const body = await (await pull()).text();

    expect(body).toContain("1111222233");
    expect(body).toMatch(/# skipped \(no bank on file or undecryptable\): 0/);
  });
});

describe("a malformed key is as useless as a missing one", () => {
  const BANK = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
  afterEach(() => {
    process.env.BANK_ENCRYPTION_KEY = BANK;
  });

  /**
   * `bankKeyConfigured` asks `bankKey()`, which needs 64 hex characters (32
   * bytes). A key that is SET but the wrong length, or not hex, seals nothing
   * and opens nothing — and a presence check (`!!process.env`) calls it
   * configured. That is the difference between refusing in a sentence and
   * handing ops a header-only file with every payout still queued.
   */
  for (const [what, key] of [
    ["too short", "ffeeddcc"],
    ["not hex", "zzzz".repeat(16)],
    ["empty", ""],
  ] as const) {
    it(`refuses when the key is ${what}`, async () => {
      crew("b-1", "Twin Lakes Crew", { account: "1111222233" });
      process.env.BANK_ENCRYPTION_KEY = key;

      const res = await pull();
      const body = await res.text();

      expect(res.status, `a ${what} key read as a successful export`).toBe(503);
      expect(body).not.toContain("1111222233");
      expect(body).toMatch(/configuration, not the crews/i);
      expect(db.payout_batches[0].status).toBe("queued");
    });
  }
});

describe("a re-download pulls only what has already been in a file", () => {
  /**
   * The flag used to widen the pull to ['queued','exported'], while the button
   * that sets it reads "Re-download N already-exported" and N counts the
   * exported ones alone. So with both kinds waiting it handed over more rows
   * than it named, FLIPPED the queued ones to exported through a button that
   * claimed to be re-fetching old ones, and wrote an audit row calling the
   * whole disclosure a re-download.
   *
   * The old test set the batch to 'exported' first, so it only ever exercised
   * one kind — which is why this survived.
   */
  it("LEAVES A QUEUED BATCH ALONE, and does not flip it", async () => {
    crew("b-old", "Twin Lakes Crew", { account: "1111222233" });
    crew("b-new", "Shoreline Mowing", { account: "4444555566" });
    db.payout_batches.find((b) => b.id === "b-old")!.status = "exported";

    const body = await (await pull("?redownload=1")).text();

    expect(body).toContain("1111222233");
    expect(body, "a queued batch rode a re-download").not.toContain("4444555566");
    expect(db.payout_batches.find((b) => b.id === "b-new")!.status,
      "a fresh batch was marked exported by the re-download button").toBe("queued");
  });

  it("and the audit row names only what it actually handed over", async () => {
    crew("b-old", "Twin Lakes Crew", { account: "1111222233" });
    crew("b-new", "Shoreline Mowing", { account: "4444555566" });
    db.payout_batches.find((b) => b.id === "b-old")!.status = "exported";

    await pull("?redownload=1");

    const ev = db.payout_export_events[0];
    expect(ev.redownload).toBe(true);
    expect(ev.batch_ids).toEqual(["b-old"]);
    expect(ev.row_count).toBe(1);
  });

  it("the ordinary download still takes the queued one — or this proves nothing", async () => {
    crew("b-old", "Twin Lakes Crew", { account: "1111222233" });
    crew("b-new", "Shoreline Mowing", { account: "4444555566" });
    db.payout_batches.find((b) => b.id === "b-old")!.status = "exported";

    const body = await (await pull()).text();

    expect(body).toContain("4444555566");
    expect(body, "an already-exported batch rode the ordinary download").not.toContain("1111222233");
    expect(db.payout_batches.find((b) => b.id === "b-new")!.status).toBe("exported");
  });
});
