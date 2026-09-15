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

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
/** park_on_account_payments, modelled (0167): standing rent with no bill, with the database's own `remaining` — live allocations and refunds netted. */
function onAccountView(): Row[] {
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.charge_id == null && p.reversed_at == null && p.returned_at == null)
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && a.removed_at == null).reduce((t, a) => t + cents(a.amount), 0);
      const refunded = (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((t, r) => t + cents(r.amount), 0);
      return { payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id, amount: p.amount,
        allocated: allocated / 100, refunded: refunded / 100, remaining: Math.max(0, cents(p.amount) - allocated - refunded) / 100 };
    });
}
class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private cols: string[] = [];
  private patch: Row | null = null;
  constructor(private t: string) {}
  private source(): Row[] { return this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []); }
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
    const hit = this.source().filter((r) => this.fs.every((f) => f(r)));
    return Promise.resolve({ data: hit[0] ?? null, error: null });
  }
  /** A chain is awaited as itself — supabase-js builders are thenable. Applies the patch to every matching row, or returns the rows. */
  then<T>(resolve: (v: { data: Row[] | null; error: { code: string; message: string } | null }) => T) {
    if (!this.patch && nextReadError && nextReadError.table === this.t && this.cols.includes(nextReadError.column)) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e }).then(resolve);
    }
    const hit = this.source().filter((r) => this.fs.every((f) => f(r)));
    if (this.patch) {
      for (const r of hit) Object.assign(r, this.patch);
      updates.push({ table: this.t, ids: hit.map((r) => String(r.id)), patch: this.patch });
      return Promise.resolve({ data: null, error: null }).then(resolve);
    }
    return Promise.resolve({ data: hit, error: null }).then(resolve);
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
  db.park_charges = [
    { id: "charge-9", park_id: "park-haven", park_lot_id: "lot-9", period_month: "2027-01" },
    { id: "charge-feb", park_id: "park-haven", park_lot_id: "lot-9", period_month: "2027-02" },
  ];
  db.park_payment_allocations = [];
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

  it("says the rest is still held only while it is — once applied, the page reads where it went instead", async () => {
    // The link is a permanent URL on a paper receipt. The run or the office
    // puts the $57.47 against February as an allocation row (0167); "held for
    // you, not yet put against a bill" is false from that day. The whole
    // stays $600, and the page can name the month.
    const before = (await loadPaymentByToken(TOKEN))!;
    expect(before.onAccountApplied).toBe(false);
    expect(before.onAccountRemaining).toBe(57.47);
    expect(before.allocations).toEqual([]);
    expect(before.whereItWent).toBe("$57.47 on account");
    db.park_payment_allocations.push({ id: "al-1", payment_id: "pay-acct", charge_id: "charge-feb", amount: 57.47 });
    const v = await loadPaymentByToken(TOKEN);
    expect(v!.amount).toBe(600);
    expect(v!.onAccount).toBe(57.47);
    expect(v!.onAccountApplied).toBe(true);
    expect(v!.onAccountRemaining).toBe(0);
    expect(v!.allocations).toEqual([{ periodMonth: "2027-02", amount: 57.47 }]);
    expect(v!.whereItWent).toBe("$57.47 to February 2027");
  });

  it("partly applied: the page has both the month and what is still held", async () => {
    db.park_payment_allocations.push({ id: "al-1", payment_id: "pay-acct", charge_id: "charge-feb", amount: 40 });
    const v = await loadPaymentByToken(TOKEN);
    expect(v!.onAccountApplied).toBe(true);
    expect(v!.onAccountRemaining).toBe(17.47);
    expect(v!.whereItWent).toBe("$40.00 to February 2027, $17.47 on account");
  });

  it("the on-account row's OWN link lists where the money has gone", async () => {
    // A quarter paid ahead has a receipt and a link of its own — no sibling,
    // no bill — and the household reads which months it paid for.
    db.park_payments[1].amount = 1627.59;
    db.park_payment_allocations.push(
      { id: "al-1", payment_id: "pay-acct", charge_id: "charge-9", amount: 542.53 },
      { id: "al-2", payment_id: "pay-acct", charge_id: "charge-feb", amount: 542.53 },
    );
    const v = await loadPaymentByToken(ACCT_TOKEN);
    expect(v!.amount).toBe(1627.59);
    expect(v!.onAccount).toBeNull();
    expect(v!.onAccountApplied).toBe(true);
    expect(v!.onAccountRemaining).toBe(542.53);
    expect(v!.whereItWent).toBe("$542.53 to January 2027, $542.53 to February 2027, $542.53 on account");
  });

  it("`remaining` is the view's, never amount − allocations here: a refund and a removed allocation both show", async () => {
    // ONE definition of what is left on a payment (park_payment_remaining).
    // The JS subtraction this file used to do ignored refunds and counted an
    // allocation the office had taken back off its bill.
    db.park_payments[1].amount = 600;
    db.park_payment_allocations.push(
      { id: "al-1", payment_id: "pay-acct", charge_id: "charge-feb", amount: 542.53 },
      { id: "al-0", payment_id: "pay-acct", charge_id: "charge-9", amount: 40, removed_at: "2027-01-09T00:00:00Z", removed_reason: "wrong month" },
    );
    db.park_refunds = [{ id: "rf-1", payment_id: "pay-acct", amount: 57.47 }];
    const v = await loadPaymentByToken(ACCT_TOKEN);
    expect(v!.allocations, "the removed line is not where the money went").toEqual([{ periodMonth: "2027-02", amount: 542.53 }]);
    expect(v!.onAccountRemaining).toBe(0);
    expect(v!.whereItWent).toBe("$542.53 to February 2027");
    expect(v!.takenBackOn).toBeNull();
  });

  it("a quarter-ahead cheque that BOUNCED after the run spent it: nothing is on account, and the page knows it was taken back", async () => {
    // The link is a permanent URL on paper. The office reversed the cheque;
    // the months it had paid are outstanding again; the page must not say
    // "held for you — it comes off the next bill" about money recorded as
    // never having arrived. The allocations stay as the record of where it
    // HAD gone; `remaining` is 0 because the view no longer lists the row.
    db.park_payments[1].amount = 1627.59;
    db.park_payments[1].reversed_at = "2027-02-03T15:00:00Z";
    db.park_payments[1].reversed_reason = "the cheque bounced";
    db.park_payment_allocations.push(
      { id: "al-1", payment_id: "pay-acct", charge_id: "charge-9", amount: 542.53 },
      { id: "al-2", payment_id: "pay-acct", charge_id: "charge-feb", amount: 542.53 },
    );
    const v = await loadPaymentByToken(ACCT_TOKEN);
    expect(v).not.toBeNull();
    expect(v!.amount).toBe(1627.59);
    expect(v!.onAccountRemaining).toBe(0);
    expect(v!.whereItWent).toBe("$542.53 to January 2027, $542.53 to February 2027");
    expect(v!.whereItWent).not.toMatch(/on account/);
    expect(v!.takenBackOn).toBe("2027-02-03T15:00:00Z");
    expect(v!.takenBackWhy).toBe("the cheque bounced");
  });

  it("a bank-returned ACH payment on account reads the return code as the reason", async () => {
    db.park_payments[1].method = "ach";
    db.park_payments[1].returned_at = "2027-01-08T09:00:00Z";
    db.park_payments[1].return_code = "R01";
    const v = await loadPaymentByToken(ACCT_TOKEN);
    expect(v!.takenBackOn).toBe("2027-01-08T09:00:00Z");
    expect(v!.takenBackWhy).toBe("R01");
    expect(v!.onAccountRemaining).toBe(0);
    // A standing payment carries neither.
    const standing = await loadPaymentByToken(TOKEN);
    expect(standing!.takenBackOn).toBeNull();
    expect(standing!.takenBackWhy).toBeNull();
  });

  it("a failed read of what is still on account refuses rather than saying 'held for you'", async () => {
    nextReadError = { table: "park_on_account_payments", column: "payment_id", error: { code: "57P01", message: "terminating connection" } };
    await expect(loadPaymentByToken(TOKEN)).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError).toBeNull();
  });

  it("the loader selects the row's own standing, and does no subtraction of its own", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "confirm-server.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const load = src.match(/export async function loadPaymentByToken[\s\S]*?\n}/)?.[0] ?? "";
    expect(load.length).toBeGreaterThan(300);
    expect(load).toMatch(/reversed_at, reversed_reason, returned_at, return_code"\)/);
    expect(load).toMatch(/takenBackOn:/);
    const went = src.match(/async function whereItWent[\s\S]*?\n}/)?.[0] ?? "";
    expect(went.length).toBeGreaterThan(200);
    expect(went).toMatch(/\.from\("park_on_account_payments"\)/);
    expect(went).toMatch(/\.is\("removed_at", null\)/);
    expect(went, "no second copy of the subtraction").not.toMatch(/amount - allocatedTotal/);
    expect(src).not.toMatch(/allocatedTotal/);
  });

  it("a deposit's link reads no allocations — it can have none", async () => {
    db.park_payments.push({ id: "pay-dep", charge_id: null, park_id: "park-haven", kind: "deposit", amount: 500, fee_amount: null,
      method: "cash", reference: null, received_on: "2027-01-04", receipt_no: 103, renter_confirmed_at: null,
      confirm_token: "f".repeat(40), idempotency_key: null, reversed_at: null });
    nextReadError = { table: "park_payment_allocations", column: "payment_id", error: { code: "57P01", message: "x" } };
    const v = await loadPaymentByToken("f".repeat(40));
    expect(v!.amount).toBe(500);
    expect(v!.whereItWent).toBe("");
    expect(nextReadError, "no allocations read was made for a deposit").not.toBeNull();
    nextReadError = null;
  });

  it("a failed read of where the money went refuses rather than saying 'still held'", async () => {
    db.park_payment_allocations.push({ id: "al-1", payment_id: "pay-acct", charge_id: "charge-feb", amount: 57.47 });
    nextReadError = { table: "park_payment_allocations", column: "payment_id", error: { code: "57P01", message: "terminating connection" } };
    await expect(loadPaymentByToken(TOKEN)).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError).toBeNull();
  });

  it("a sibling the office has since taken back is still part of what she handed over — and the page knows ITS standing, not the bill row's", async () => {
    // She handed over $600. The office later took the $57.47 half back
    // (reversePayment takes both halves together now; this is the record a
    // half-reversal left, or the on-account row reversed on its own before
    // that). Dropping it would print "$542.53" on a receipt written for
    // $600 and hide the correction; folding it in as "on account with the
    // office" would promise money the office has recorded as never having
    // arrived. So the whole stays $600, and the sibling's own reversed_at
    // and reason come along — separately from the bill row's.
    db.park_payments[1].reversed_at = "2027-01-05T10:00:00Z";
    db.park_payments[1].reversed_reason = "typo — she handed over $542.53";
    const v = await loadPaymentByToken(TOKEN);
    expect(v!.amount).toBe(600);
    expect(v!.onAccount).toBe(57.47);
    expect(v!.takenBackOn, "the bill row itself stands").toBeNull();
    expect(v!.siblingTakenBackOn).toBe("2027-01-05T10:00:00Z");
    expect(v!.siblingTakenBackWhy).toBe("typo — she handed over $542.53");
    // Nothing of it is on account: the view no longer lists the sibling.
    expect(v!.onAccountRemaining).toBe(0);
    expect(v!.whereItWent).toBe("");
  });

  it("both halves taken back — what reversePayment now writes — reads as taken back on both", async () => {
    db.park_payment_allocations.push({ id: "al-1", payment_id: "pay-acct", charge_id: "charge-feb", amount: 57.47 });
    for (const p of db.park_payments) { p.reversed_at = "2027-02-03T15:00:00Z"; p.reversed_reason = "the cheque bounced"; }
    const v = await loadPaymentByToken(TOKEN);
    expect(v!.amount).toBe(600);
    expect(v!.onAccount).toBe(57.47);
    expect(v!.takenBackOn).toBe("2027-02-03T15:00:00Z");
    expect(v!.siblingTakenBackOn).toBe("2027-02-03T15:00:00Z");
    expect(v!.siblingTakenBackWhy).toBe("the cheque bounced");
    // Where the on-account half HAD gone is still the record; nothing of it is held.
    expect(v!.onAccountApplied).toBe(true);
    expect(v!.whereItWent).toBe("$57.47 to February 2027");
    expect(v!.onAccountRemaining).toBe(0);
  });

  it("the bill row taken back while the sibling stands: the sibling's allocations still stand, and the page can tell", async () => {
    // route.ts used to say "It had been put against …; that no longer
    // stands" from the BILL row's reversed_at about the SIBLING's lines.
    db.park_payment_allocations.push({ id: "al-1", payment_id: "pay-acct", charge_id: "charge-feb", amount: 40 });
    db.park_payments[0].reversed_at = "2027-02-03T15:00:00Z";
    db.park_payments[0].reversed_reason = "keyed twice";
    const v = await loadPaymentByToken(TOKEN);
    expect(v!.takenBackOn).toBe("2027-02-03T15:00:00Z");
    expect(v!.siblingTakenBackOn).toBeNull();
    expect(v!.siblingTakenBackWhy).toBeNull();
    expect(v!.onAccount).toBe(57.47);
    expect(v!.onAccountApplied).toBe(true);
    expect(v!.onAccountRemaining).toBe(17.47);
    expect(v!.whereItWent).toBe("$40.00 to February 2027, $17.47 on account");
  });

  it("a standing split, and a row with no sibling, carry no sibling standing at all", async () => {
    expect((await loadPaymentByToken(TOKEN))!.siblingTakenBackOn).toBeNull();
    expect((await loadPaymentByToken(ACCT_TOKEN))!.siblingTakenBackOn).toBeNull();
    db.park_payments.pop();
    const alone = await loadPaymentByToken(TOKEN);
    expect(alone!.siblingTakenBackOn).toBeNull();
    expect(alone!.siblingTakenBackWhy).toBeNull();
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

  it("a claim filed after the office applied the rest says which bill, not 'on account'", async () => {
    // A claim note is never corrected later. Filed in March about money the
    // office put against February in January, "on account with the office"
    // would send them looking in a drawer for $57.47 that is on a bill.
    db.park_payment_allocations.push({ id: "al-1", payment_id: "pay-acct", charge_id: "charge-feb", amount: 57.47 });
    const res = await disputeByToken(TOKEN);
    expect(res).toEqual({ ok: true });
    const note = String((inserted.park_payment_claims ?? [])[0]?.note);
    expect(note).toContain("it records $600.00 taken on January 4, 2027");
    expect(note).toContain("($57.47 of it on account: $57.47 to February 2027)");
    expect(note).not.toContain("on account with the office");
  });

  it("a claim filed after the office took the on-account half back says so, not 'on account with the office'", async () => {
    db.park_payments[1].reversed_at = "2027-01-05T10:00:00Z";
    db.park_payments[1].reversed_reason = "typo";
    const res = await disputeByToken(TOKEN);
    expect(res).toEqual({ ok: true });
    const note = String((inserted.park_payment_claims ?? [])[0]?.note);
    expect(note).toContain("it records $600.00 taken on January 4, 2027");
    expect(note).toContain("($57.47 of it had gone on account and was taken back on January 5, 2027 — typo)");
    expect(note).not.toContain("on account with the office");
  });

  it("a failed read of where the rest went refuses the dispute too", async () => {
    nextReadError = { table: "park_payment_allocations", column: "payment_id", error: { code: "57P01", message: "terminating connection" } };
    const res = await disputeByToken(TOKEN);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing has been changed/i);
    expect(inserted.park_payment_claims ?? []).toHaveLength(0);
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
    // The sibling key is spelled ONCE in the codebase — ledger-helpers'
    // splitSiblingKey, which recordPayment writes with and reversePayment
    // reads with — and this file only calls it. Comments stripped above, so
    // the prose that explains the suffix does not count as a spelling.
    expect(src, "this file spells the sibling key itself").not.toMatch(/onaccount/);
    expect(src).toMatch(/return splitSiblingKey\(key, chargeId\)/);
    expect(src).toMatch(/\.eq\("idempotency_key", key\)/);
    // And the helper reads the sibling WHATEVER its standing — the standing
    // is reported, never used to drop half of what she handed over.
    const helper = src.slice(src.indexOf("async function wholeHandedOver"), src.indexOf("export async function loadPaymentByToken"));
    expect(helper.length).toBeGreaterThan(300);
    expect(helper).toMatch(/select\("id, amount, charge_id, reversed_at, reversed_reason, returned_at, return_code"\)/);
    expect(helper, "the sibling read must not filter on standing").not.toMatch(/\.is\("reversed_at", null\)/);
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
    db.park_payment_allocations.push({ id: "al-1", payment_id: "pay-acct", charge_id: "charge-feb", amount: 57.47 });
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
    // Still true while nothing has been applied. (Since 0167 the run does
    // apply it to the next bill it raises, so the page MAY say so — the
    // loader now hands it `whereItWent` and `onAccountRemaining` for that.)
    expect(route).toMatch(/not yet put against a bill/);
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
