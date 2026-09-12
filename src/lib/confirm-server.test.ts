import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE RENTER'S LINK LANDS ON THE BILL ROW OF A SPLIT PAYMENT.
 *
 * recordPayment records $600 on a $542.53 bill as two rows in one insert —
 * the bill's share against the charge, the rest on account under the same
 * idempotency key + ":onaccount" — and the receipt's confirm link carries the
 * bill row's token. So /paid asked "does this match what you handed over?"
 * showing $542.53 to somebody who handed over $600. A careful resident
 * answers "no", and the dispute is one we manufactured.
 *
 * The real loader, against a fake of the four tables it reads.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Fail the next read on `table` that filters on `column` — so the SIBLING read can fail while the main one succeeds. */
let nextReadError: { table: string; column: string; error: { code: string; message: string } } | null = null;

/** Every row a door wrote, by table — the claim note is read back from here. */
const inserted: Record<string, Row[]> = {};
/** Every UPDATE a door issued: which table, which rows it reached, what it wrote. */
const updates: Array<{ table: string; ids: string[]; patch: Row }> = [];

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private cols: string[] = [];
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  insert(row: Row) {
    (inserted[this.t] ??= []).push(row);
    return Promise.resolve({ data: null, error: null });
  }
  update(patch: Row) { this.patch = patch; return this; }
  eq(c: string, v: unknown) { this.cols.push(c); this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.cols.push(c); this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.cols.push(c); this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  maybeSingle() {
    if (nextReadError && nextReadError.table === this.t && this.cols.includes(nextReadError.column)) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e });
    }
    const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    return Promise.resolve({ data: hit[0] ?? null, error: null });
  }
  /** An update chain is awaited as itself — supabase-js builders are thenable. Applies the patch to every matching row. */
  then<T>(resolve: (v: { data: null; error: null }) => T) {
    const hit = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.patch) {
      for (const r of hit) Object.assign(r, this.patch);
      updates.push({ table: this.t, ids: hit.map((r) => String(r.id)), patch: this.patch });
    }
    return Promise.resolve({ data: null, error: null }).then(resolve);
  }
}
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
const { loadPaymentByToken, disputeByToken, confirmByToken } = await import("./confirm-server");
const { ReadFailed } = await import("@/lib/must-read");

const TOKEN = "a".repeat(32) + "b".repeat(8);
const ACCT_TOKEN = "c".repeat(32) + "d".repeat(8);

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(inserted)) delete inserted[k];
  updates.length = 0;
  nextReadError = null;
  db.parks = [{ id: "park-haven", name: "The Haven" }];
  db.park_lots = [{ id: "lot-9", lot_number: "9" }];
  db.park_charges = [{ id: "charge-9", park_id: "park-haven", park_lot_id: "lot-9" }];
  db.park_payments = [
    {
      id: "pay-bill", charge_id: "charge-9", park_id: "park-haven", kind: "rent", amount: 542.53, fee_amount: null,
      method: "check", reference: "1042", received_on: "2027-01-04", receipt_no: 101, renter_confirmed_at: null,
      confirm_token: TOKEN, idempotency_key: "form-key", reversed_at: null,
    },
    {
      id: "pay-acct", charge_id: null, park_id: "park-haven", kind: "rent", amount: 57.47, fee_amount: null,
      method: "check", reference: "1042", received_on: "2027-01-04", receipt_no: 102, renter_confirmed_at: null,
      confirm_token: ACCT_TOKEN, idempotency_key: "form-key:onaccount", reversed_at: null,
    },
  ];
});

describe("a split receipt shows what was handed over", () => {
  it("folds the on-account sibling back in, and says how much of it is on account", async () => {
    const v = await loadPaymentByToken(TOKEN);
    expect(v).not.toBeNull();
    expect(v!.amount).toBe(600);
    expect(v!.onAccount).toBe(57.47);
    expect(v!.lotNumber).toBe("9");
    expect(v!.ref).toMatch(/0101/);
  });

  it("an ordinary receipt is unchanged — one row, nothing on account", async () => {
    db.park_payments.pop();
    const v = await loadPaymentByToken(TOKEN);
    expect(v!.amount).toBe(542.53);
    expect(v!.onAccount).toBeNull();
    expect(v!.onAccountApplied).toBe(false);
  });

  it("says the rest is still held only while it is — once applied, the page reads that instead", async () => {
    // The link is a permanent URL on a paper receipt. applyOnAccount moves
    // the $57.47 by setting the sibling's charge_id; "held for you, not yet
    // put against a bill" is false from that day. The whole stays $600.
    expect((await loadPaymentByToken(TOKEN))!.onAccountApplied).toBe(false);
    db.park_payments[1].charge_id = "charge-feb";
    const v = await loadPaymentByToken(TOKEN);
    expect(v!.amount).toBe(600);
    expect(v!.onAccount).toBe(57.47);
    expect(v!.onAccountApplied).toBe(true);
  });

  it("a sibling the office has since reversed no longer counts", async () => {
    db.park_payments[1].reversed_at = "2027-01-05T10:00:00Z";
    const v = await loadPaymentByToken(TOKEN);
    expect(v!.amount).toBe(542.53);
    expect(v!.onAccount).toBeNull();
  });

  it("money with no bill behind it never goes looking for a sibling", async () => {
    // A deposit, or a cheque taken before the bill existed (recordOnAccount),
    // has no charge and therefore no split. Its own key must not be read as
    // somebody else's ":onaccount".
    const v = await loadPaymentByToken(ACCT_TOKEN);
    expect(v!.amount).toBe(57.47);
    expect(v!.onAccount).toBeNull();
    expect(v!.lotNumber).toBe("—");
  });

  it("a failed sibling read refuses rather than showing the bill's share as the whole", async () => {
    // The whole point of this page is asking her to agree to a figure. A
    // read that failed and rendered as "no sibling" would ask her to agree
    // to $542.53 about $600.
    nextReadError = { table: "park_payments", column: "idempotency_key", error: { code: "57P01", message: "terminating connection" } };
    await expect(loadPaymentByToken(TOKEN)).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError, "the sibling read never happened — the error was never consumed").toBeNull();
  });
});

/**
 * THE RULE IN ONE DOORWAY OF TWO. The page said $600; she tapped "That's not
 * what I paid"; the claim the office read said the receipt records $542.53 —
 * a figure nobody printed for her. Both doors now resolve the whole through
 * one helper, and this proves the second door uses it.
 */
describe("the claim she files quotes the figure she was shown", () => {
  it("disputing the split receipt names $600.00, and says how much is on account", async () => {
    const res = await disputeByToken(TOKEN);
    expect(res).toEqual({ ok: true });
    const claims = inserted.park_payment_claims ?? [];
    expect(claims).toHaveLength(1);
    expect(claims[0].charge_id).toBe("charge-9");
    expect(claims[0].asserted_by).toBe("renter");
    const note = String(claims[0].note);
    expect(note).toContain("it records $600.00 taken on January 4, 2027");
    expect(note).toContain("($57.47 of it on account with the office)");
    expect(note).not.toContain("$542.53");
  });

  it("a claim filed after the office applied the rest says so, not 'on account'", async () => {
    // A claim note is never corrected later. Filed in March about money the
    // office put against February in January, "on account with the office"
    // would send them looking in a drawer for $57.47 that is on a bill.
    db.park_payments[1].charge_id = "charge-feb";
    const res = await disputeByToken(TOKEN);
    expect(res).toEqual({ ok: true });
    const note = String((inserted.park_payment_claims ?? [])[0]?.note);
    expect(note).toContain("it records $600.00 taken on January 4, 2027");
    expect(note).toContain("($57.47 of it since put against a bill)");
    expect(note).not.toContain("on account with the office");
  });

  it("an ordinary receipt's claim names the one figure and says nothing about account", async () => {
    db.park_payments.pop();
    const res = await disputeByToken(TOKEN);
    expect(res).toEqual({ ok: true });
    const note = String((inserted.park_payment_claims ?? [])[0]?.note);
    expect(note).toContain("it records $542.53 taken on January 4, 2027.");
    expect(note).not.toContain("on account");
  });

  it("a failed sibling read refuses the dispute rather than filing the bill's share as the whole", async () => {
    // Writing $542.53 into the claim log here is the exact lie this fixes,
    // and nothing later corrects a claim note. Refuse, say nothing changed.
    nextReadError = { table: "park_payments", column: "idempotency_key", error: { code: "57P01", message: "terminating connection" } };
    const res = await disputeByToken(TOKEN);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing has been changed/i);
    expect(inserted.park_payment_claims ?? []).toHaveLength(0);
    expect(nextReadError, "the sibling read never happened").toBeNull();
  });

  it("all three token doors resolve the whole through ONE helper — no door folds its own", () => {
    // Comments stripped: the doc above the helper names the doors in prose.
    const src = readFileSync(join(process.cwd(), "src", "lib", "confirm-server.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const body = (fn: string) => src.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? "";
    const doors = { load: body("loadPaymentByToken"), dispute: body("disputeByToken"), confirm: body("confirmByToken") };
    for (const [name, code] of Object.entries(doors)) {
      expect(code.length, `${name}: door not found — this scan is measuring nothing`).toBeGreaterThan(300);
      expect(code, `${name} does not read the whole through the helper`).toMatch(/await wholeHandedOver\(admin, pay\)/);
      expect(code, `${name} spells the sibling key itself`).not.toMatch(/onaccount/);
    }
    // The ":onaccount" sibling key is spelled in exactly one place, and the
    // helper reads it through that one spelling.
    expect(src.match(/:onaccount/g)?.length, "the sibling key is spelled once, in siblingKey").toBe(1);
    expect(src).toMatch(/\.eq\("idempotency_key", siblingKey\(key\)\)/);
    // And each door selects the columns the helper needs — a column it
    // doesn't fetch is a sibling it can never find.
    expect(doors.dispute).toMatch(/select\("id, charge_id, amount, received_on, receipt_no, idempotency_key"\)/);
    expect(doors.confirm).toMatch(/select\("id, charge_id, amount, idempotency_key, renter_confirmed_at"\)/);
  });
});

/**
 * THE RULE IN ONE DOORWAY OF THREE — the third door. The page said $600 and
 * she tapped "Yes, that's right"; the stamp landed on the $542.53 row alone,
 * and the $57.47 sibling — the row the office later moves to February — sat
 * in park_payments_unconfirmed_idx (0077) with no account of how it was
 * given. 0077 calls her confirmation "the only second party there will ever
 * be"; it has to cover what she was shown.
 */
describe("'Yes, that's right' lands on everything she was shown", () => {
  it("confirming the split receipt stamps the bill row AND the on-account sibling, in one update", async () => {
    const res = await confirmByToken(TOKEN);
    expect(res).toEqual({ ok: true });
    const bill = db.park_payments.find((r) => r.id === "pay-bill")!;
    const acct = db.park_payments.find((r) => r.id === "pay-acct")!;
    expect(bill.renter_confirmed_at).toBeTruthy();
    expect(bill.renter_confirmed_via).toBe("link");
    expect(acct.renter_confirmed_at).toBe(bill.renter_confirmed_at);
    expect(acct.renter_confirmed_via).toBe("link");
    // ONE update, both ids: both rows carry her confirmation or neither does.
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("park_payments");
    expect(updates[0].ids.sort()).toEqual(["pay-acct", "pay-bill"]);
  });

  it("an ordinary receipt stamps its one row and nothing else", async () => {
    db.park_payments.pop();
    db.park_payments.push({ id: "pay-other", charge_id: "charge-8", park_id: "park-haven", amount: 400, received_on: "2027-01-04",
      confirm_token: "e".repeat(40), idempotency_key: "other-key", renter_confirmed_at: null, reversed_at: null });
    expect(await confirmByToken(TOKEN)).toEqual({ ok: true });
    expect(updates).toHaveLength(1);
    expect(updates[0].ids).toEqual(["pay-bill"]);
    expect(db.park_payments.find((r) => r.id === "pay-other")!.renter_confirmed_at).toBeNull();
  });

  it("a sibling the office has since applied still gets her stamp — it is still money she handed over", async () => {
    db.park_payments[1].charge_id = "charge-feb";
    expect(await confirmByToken(TOKEN)).toEqual({ ok: true });
    expect(updates[0].ids.sort()).toEqual(["pay-acct", "pay-bill"]);
  });

  it("a reversed sibling is not stamped, and one already confirmed keeps its own stamp", async () => {
    db.park_payments[1].reversed_at = "2027-01-05T10:00:00Z";
    expect(await confirmByToken(TOKEN)).toEqual({ ok: true });
    expect(updates[0].ids).toEqual(["pay-bill"]);
    expect(db.park_payments[1].renter_confirmed_at).toBeNull();

    // Fresh pair; the sibling was confirmed at the window on paper first.
    db.park_payments[0].renter_confirmed_at = null; db.park_payments[1].reversed_at = null;
    db.park_payments[1].renter_confirmed_at = "2027-01-06T09:00:00Z"; db.park_payments[1].renter_confirmed_via = "paper";
    updates.length = 0;
    expect(await confirmByToken(TOKEN)).toEqual({ ok: true });
    expect(updates[0].ids).toEqual(["pay-bill"]);
    expect(db.park_payments[1].renter_confirmed_at).toBe("2027-01-06T09:00:00Z");
    expect(db.park_payments[1].renter_confirmed_via).toBe("paper");
  });

  it("tapping twice is fine, and writes nothing the second time", async () => {
    await confirmByToken(TOKEN);
    updates.length = 0;
    expect(await confirmByToken(TOKEN)).toEqual({ ok: true });
    expect(updates).toHaveLength(0);
  });

  it("a failed sibling read refuses rather than stamping half of what she was shown", async () => {
    nextReadError = { table: "park_payments", column: "idempotency_key", error: { code: "57P01", message: "terminating connection" } };
    const res = await confirmByToken(TOKEN);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing has been changed/i);
    expect(updates).toHaveLength(0);
    expect(db.park_payments[0].renter_confirmed_at).toBeNull();
    expect(nextReadError, "the sibling read never happened").toBeNull();
  });

  it("the stamp is one update over both ids, filtered to rows not yet confirmed", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "confirm-server.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const confirm = src.match(/export async function confirmByToken[\s\S]*?\n}/)?.[0] ?? "";
    expect(confirm.length).toBeGreaterThan(300);
    expect(confirm.match(/\.update\(/g)?.length, "one update, not one per row").toBe(1);
    expect(confirm).toMatch(/\.in\("id", ids\)/);
    expect(confirm).toMatch(/\.is\("renter_confirmed_at", null\)/);
    expect(confirm).toMatch(/whole\.siblingId/);
  });
});

/**
 * A FIELD WITH NO READER. `onAccount` was added so the page could say where
 * the $57.47 sits, and for one round nothing read it: the resident was asked
 * to agree to $600 with no word that part of it was not against her bill.
 * The paper receipt said it; the emailed page did not.
 */
describe("the page that asks 'does this match?' reads every field the loader writes for it", () => {
  const route = readFileSync(join(process.cwd(), "src", "app", "paid", "[token]", "route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the scanner reads the route it thinks it reads", () => {
    expect(route).toContain("loadPaymentByToken(token)");
    expect(route).toContain("view.amount.toFixed(2)");
  });

  it("/paid reads view.onAccount and says it is on account with the office", () => {
    expect(route).toMatch(/view\.onAccount == null/);
    expect(route).toMatch(/\$\$\{view\.onAccount\.toFixed\(2\)\} of that is on account with the office/);
    // The same promise as the receipt — none. Nothing applies it on its own.
    expect(route).toMatch(/not yet put against a bill/);
    expect(route).not.toMatch(/applied to your next bill|will be applied/i);
  });

  it("and reads view.onAccountApplied, so a permanent link stops saying 'held for you' about applied money", () => {
    // Both branches, and the sentence changes with the fact.
    expect(route).toMatch(/view\.onAccountApplied\s*\?/);
    expect(route).toMatch(/\$\$\{view\.onAccount\.toFixed\(2\)\} of that went on account with the office and has since been put against a bill\./);
    const applied = route.indexOf("has since been put against a bill");
    const held = route.indexOf("held for you, not yet put against a bill");
    expect(applied).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(applied);
    // Never "a later bill": applyOnAccount offers every open bill of that
    // household, arrears included, so "later" is a fact nothing checked.
    expect(route).not.toMatch(/later bill/);
  });
});
