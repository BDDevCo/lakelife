import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE ROLL-UNDO GUARD FOLLOWS `remaining`, NOT `charge_id` (0167).
 *
 * Applying money on account never moves the payment row — `charge_id` stays
 * null forever and the allocation is a separate fact. The guard counted
 * charge-less payments and said "Apply or give that money back first, then
 * undo": for a cheque the run had already spent that instruction could not
 * be followed (applying it changes nothing the count can see), and the only
 * exit was a reversal recording the money as never having arrived.
 *
 * Two facts, two sentences now. Money STILL HELD (the view's remaining > 0,
 * or a deposit not yet returned) can be put against a bill or given back,
 * and that clears it. Money already applied, given back or taken back is a
 * record — and 0102's anchor means the household file cannot be deleted
 * while any charge-less payment row hangs off it — so the guard says so and
 * points at the roll, the same door the bills guard points at. The real
 * undoImport, against a fake of the tables it touches.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const deleted: Array<{ table: string; ids: unknown[] }> = [];
const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
function onAccountView(): Row[] {
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.charge_id == null && p.reversed_at == null && p.returned_at == null)
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && a.removed_at == null).reduce((t, a) => t + cents(a.amount), 0);
      return { payment_id: p.id, renter_id: p.renter_id, amount: p.amount, remaining: Math.max(0, cents(p.amount) - allocated) / 100 };
    });
}
/**
 * The table whose SELECT (or DELETE) drops. Supabase answers a failed read
 * with `{ data: null, error }`, which is the same shape as "there is nothing
 * there" — the whole reason the undo's closing sentence needed rewriting.
 */
let breakRead: string | null = null;
let breakDelete: string | null = null;
const dropped = { message: "connection lost", code: "57P01" };
class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private head = false;
  private patch: Row | null = null;
  private del = false;
  constructor(private t: string) {}
  select(_c?: string, o?: { count?: string; head?: boolean }) { this.head = !!o?.head; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  update(patch: Row) { this.patch = patch; return this; }
  delete() { this.del = true; return this; }
  private source(): Row[] { return this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []); }
  private resolve() {
    if (this.del && breakDelete === this.t) return Promise.resolve({ data: null, error: dropped, count: null });
    if (!this.del && !this.patch && breakRead === this.t) return Promise.resolve({ data: null, error: dropped, count: null });
    const hit = this.source().filter((r) => this.fs.every((f) => f(r)));
    if (this.del) {
      deleted.push({ table: this.t, ids: hit.map((r) => r.id) });
      db[this.t] = (db[this.t] ?? []).filter((r) => !hit.includes(r));
      // `lot_rates.park_lot_id` is ON DELETE CASCADE (0052), which is the
      // whole reason the undo's arithmetic works: a card on a pad the import
      // made goes with the pad, and only a card on a lot he already had is
      // still there to be named. A fake that kept the card would let the
      // sentence be tested against a rule the database does not follow.
      if (this.t === "park_lots") {
        const gone = new Set(hit.map((r) => r.id));
        db.lot_rates = (db.lot_rates ?? []).filter((r) => !gone.has(r.park_lot_id));
      }
      return Promise.resolve({ data: null, error: null, count: null });
    }
    if (this.patch) { for (const r of hit) Object.assign(r, this.patch); }
    return Promise.resolve({ data: this.head ? null : hit, error: null, count: hit.length });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown; count: number | null }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => new Q(t) }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
const { undoImport } = await import("./import-actions");

const PARK = "park-haven";
beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  deleted.length = 0;
  breakRead = null;
  breakDelete = null;
  // `counts` is written by both commit doorways, so every batch that can be
  // undone carries one. `rates` is the number of rate cards it wrote.
  db.park_import_batches = [{ id: "b1", park_id: PARK, committed_at: "2026-09-01T00:00:00Z", undone_at: null, counts: { rates: 0 } }];
  db.park_import_rows = [{ batch_id: "b1", created_reservation_id: "stay-9", created_renter_id: "renter-9", created_lot_id: null }];
  db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9" }];
  db.park_renters = [{ id: "renter-9", park_id: PARK }];
  db.park_charges = [];
  db.park_payments = [];
  db.park_payment_allocations = [];
});

describe("undoImport and the money a household on the import has handed over", () => {
  it("nothing recorded: the undo goes through", async () => {
    const res = await undoImport("b1");
    expect(res.ok).toBe(true);
    expect(deleted.map((d) => d.table)).toEqual(["lot_reservations", "park_renters"]);
  });

  it("a cheque still on account (remaining > 0) blocks it, with an instruction the office can follow", async () => {
    db.park_payments = [{ id: "q", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, reversed_at: null, returned_at: null, returned_on: null }];
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "You're holding money from a household on this import — 1 payment is still on account or held as a deposit. Put it against a bill or give it back first, then undo.",
    );
    expect(deleted).toEqual([]);
  });

  it("a deposit still held blocks it the same way; one already returned does not count as held", async () => {
    db.park_payments = [
      { id: "d1", renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, reversed_at: null, returned_at: null, returned_on: null },
    ];
    expect((await undoImport("b1")).error).toMatch(/1 payment is still on account or held as a deposit/);
    db.park_payments[0].returned_on = "2026-09-02";
    const res = await undoImport("b1");
    expect(res.error).not.toMatch(/still on account/);
    expect(res.error).toMatch(/can't be removed/);
  });

  it("a cheque the run has spent in full (remaining 0) is NOT 'apply it first' — it is a record, and the file cannot be removed", async () => {
    db.park_payments = [{ id: "q", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, reversed_at: null, returned_at: null, returned_on: null }];
    db.park_charges = [{ id: "jan", park_lot_id: "lot-9", renter_id: "renter-9" }];
    db.park_payment_allocations = [{ id: "al-1", payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null }];
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Money has been recorded for a household on this import — 1 payment that has since been put against bills, given back, or taken back — " +
      "so that household's file can't be removed. Fix each household from its row on the rent roll instead.",
    );
    expect(res.error).not.toMatch(/Apply or give/);
    expect(res.error).not.toMatch(/Put it against a bill/);
    expect(deleted, "nothing half-undone").toEqual([]);
  });

  it("an allocation taken back off its bill puts the money back on account — and the instruction follows", async () => {
    db.park_payments = [{ id: "q", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, reversed_at: null, returned_at: null, returned_on: null }];
    db.park_payment_allocations = [{ id: "al-1", payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: "2027-01-09T00:00:00Z", removed_reason: "wrong month" }];
    const res = await undoImport("b1");
    expect(res.error).toMatch(/1 payment is still on account or held as a deposit\. Put it against a bill or give it back first, then undo\./);
  });

  it("a reversed or bank-returned payment is a record too — never 'apply it', and the undo does not run into the anchor constraint half-way", async () => {
    db.park_payments = [
      { id: "q", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, reversed_at: "2027-01-09T00:00:00Z", returned_at: null, returned_on: null },
      { id: "r", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "ach", reversed_at: null, returned_at: "2027-01-10T00:00:00Z", returned_on: null },
    ];
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/2 payments that have since been put against bills, given back, or taken back/);
    expect(deleted).toEqual([]);
  });

  it("the guard reads the view for what is still held, and never instructs 'apply' about money that is applied", () => {
    const src = readFileSync(fileURLToPath(new URL("./import-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const at = src.indexOf("export async function undoImport");
    const fn = src.slice(at, src.indexOf("\nexport ", at + 1));
    expect(fn.length).toBeGreaterThan(1000);
    expect(fn).toMatch(/\.from\("park_on_account_payments"\)/);
    expect(fn).toMatch(/Number\(r\.remaining \?\? 0\) > 0/);
    expect(fn).not.toMatch(/Apply or give that money back/);
  });
});

/**
 * "THAT IMPORT IS UNDONE. YOUR ROLL IS BACK HOW IT WAS."
 *
 * It was not, in two different ways, and the office read the sentence and
 * stopped looking.
 *
 * A rate card has no undo. Deleting a pad the import made takes its card with
 * it (0052 cascades), but a rent written onto a lot he already had is still
 * there afterwards, and so is a pad somebody else has since been put on. The
 * closing sentence names both now, with the count and the screen to go and
 * change them on, and only claims the roll is restored when there is genuinely
 * nothing left behind.
 *
 * And a failed read reported a clean undo: the read was stepped over, the work
 * was skipped, `undone_at` was stamped so the undo could never be retried, and
 * the toast still said the roll was back. Every read now happens before the
 * first delete, so a failure refuses with the shared sentence, nothing changed
 * and nothing stamped.
 */
describe("the undo sentence says what the undo actually did", () => {
  const batch = () => db.park_import_batches[0];
  const signal = async () => (await undoImport("b1")).signal;

  beforeEach(() => {
    // Two lines: one brought a new pad into being, one went onto a lot he
    // already had. The import wrote a rent card on each — `counts.rates: 2`.
    batch().counts = { rates: 2 };
    db.park_import_rows = [
      { batch_id: "b1", created_reservation_id: "stay-a", created_renter_id: "renter-a", created_lot_id: "lot-a" },
      { batch_id: "b1", created_reservation_id: "stay-b", created_renter_id: "renter-b", created_lot_id: null },
    ];
    db.lot_reservations = [
      { id: "stay-a", renter_id: "renter-a", park_lot_id: "lot-a" },
      { id: "stay-b", renter_id: "renter-b", park_lot_id: "lot-his" },
    ];
    db.park_renters = [{ id: "renter-a", park_id: PARK }, { id: "renter-b", park_id: PARK }];
    db.park_lots = [{ id: "lot-a", park_id: PARK }, { id: "lot-his", park_id: PARK }];
    db.lot_rates = [
      { id: "rate-a", park_lot_id: "lot-a", term: "monthly", amount: 400 },
      { id: "rate-his", park_lot_id: "lot-his", term: "monthly", amount: 400 },
    ];
  });

  it("names the rent left on a lot he already had, and does not claim the roll is back", async () => {
    // The card on lot-a goes with the pad; the card on lot-his is the one he
    // has to go and change, and nothing else on any screen would tell him.
    expect(await signal()).toBe(
      "That import is undone. 1 lot kept the rent this import set — change it on Lots & rates.",
    );
    expect(db.lot_rates.map((r) => r.id)).toEqual(["rate-his"]);
  });

  it("two of them reads as two, and 'back how it was' is only said when nothing is left", async () => {
    db.lot_rates = [
      { id: "rate-his", park_lot_id: "lot-his", term: "monthly", amount: 400 },
      { id: "rate-his2", park_lot_id: "lot-his2", term: "monthly", amount: 400 },
    ];
    const both = await signal();
    expect(both).toBe(
      "That import is undone. 2 lots kept the rents this import set — change them on Lots & rates.",
    );
    expect(both).not.toContain("back how it was");
  });

  it("every card it wrote went with a pad it made: then the roll really is back how it was", async () => {
    batch().counts = { rates: 1 };
    db.lot_rates = [{ id: "rate-a", park_lot_id: "lot-a", term: "monthly", amount: 400 }];
    expect(await signal()).toBe("That import is undone. Your roll is back how it was.");
  });

  it("an import that wrote no cards at all says so by saying nothing", async () => {
    batch().counts = { rates: 0 };
    db.lot_rates = [];
    expect(await signal()).toBe("That import is undone. Your roll is back how it was.");
  });

  it("a pad somebody else is on is left, counted, and its card counted with it", async () => {
    db.lot_reservations.push({ id: "stay-new", renter_id: "renter-z", park_lot_id: "lot-a" });
    expect(await signal()).toBe(
      "That import is undone. 1 lot this import made is still on your roll — check it on Lots & rates. " +
      "2 lots kept the rents this import set — change them on Lots & rates.",
    );
    expect(db.park_lots.map((l) => l.id), "his inventory now, not our mess").toContain("lot-a");
  });

  it("a pad the database refuses to delete is still a pad on his roll, not a silent one", async () => {
    breakDelete = "park_lots";
    const said = await signal();
    expect(said).toContain("1 lot this import made is still on your roll");
    expect(said).not.toContain("back how it was");
  });

  it("a batch whose counts never recorded the cards says it cannot tell, rather than zero", async () => {
    delete batch().counts;
    const said = await signal();
    expect(said).toBe("That import is undone. We can't tell what rents it set, so check Lots & rates.");
    expect(said).not.toContain("back how it was");
  });

  // ---- a failed read is never a clean undo -------------------------------
  const FAILED = "We couldn't check something just now, so no money has moved. Try again in a moment.";

  it("the read of what the import created: refuses, changes nothing, stamps nothing", async () => {
    breakRead = "park_import_rows";
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(FAILED);
    expect(deleted).toEqual([]);
    expect(batch().undone_at, "stamping it would make the undo unretryable").toBeNull();
  });

  it("the read of who is on the pads it made: refuses before the first delete", async () => {
    breakRead = "lot_reservations";
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(FAILED);
    expect(res.signal).toBeUndefined();
    expect(deleted).toEqual([]);
    expect(db.park_renters).toHaveLength(2);
    expect(batch().undone_at).toBeNull();
  });

  it("the read of the rents on those pads: refuses, because the sentence needs it to be true", async () => {
    breakRead = "lot_rates";
    const res = await undoImport("b1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(FAILED);
    expect(deleted).toEqual([]);
    expect(batch().undone_at).toBeNull();
  });

  // The same promise, made BEFORE he taps. The modal is where he decides,
  // and "you can undo the whole thing" was the sentence that decided it —
  // over a rate card no undo has ever put back. Scanned rather than
  // rendered, because it is a line of copy in a client component and the
  // thing worth pinning is the words.
  it("the modal promises back exactly what the undo gives back, and names what it does not", () => {
    const src = readFileSync(fileURLToPath(new URL("../../components/ParkImportRead.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const at = src.indexOf("You can undo the whole thing afterwards");
    expect(at, "the modal's promise about undo").toBeGreaterThan(-1);
    const para = src.slice(at, src.indexOf("</p>", at)).replace(/\s+/g, " ");
    expect(para).toContain(
      "A rent it writes onto a lot you already had stays there; change it on Lots &amp; rates.",
    );
  });

  it("a refusal is retryable: the same undo run again after the read comes back finishes the job", async () => {
    breakRead = "lot_reservations";
    expect((await undoImport("b1")).ok).toBe(false);
    breakRead = null;
    const res = await undoImport("b1");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe(
      "That import is undone. 1 lot kept the rent this import set — change it on Lots & rates.",
    );
    expect(batch().undone_at).not.toBeNull();
  });
});
