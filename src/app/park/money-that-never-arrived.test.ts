import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { refundRefusal, type RefundablePayment } from "./refund-helpers";
import { isClearing, notCollectedAt } from "./receipts-helpers";

/**
 * MONEY THAT NEVER ARRIVED CANNOT BE SENT BACK.
 *
 * Found by an adversarial audit of the money rails and proven against
 * production the same day, inside a block that rolled back:
 *
 *   1 in_flight(unsettled=t) bill=open/0.00
 *   2 REFUND_AGAINST_UNCLEARED_ACCEPTED=t      <-- the hole
 *   3 refund_against_returned_refused=t
 *
 * `guard_park_refund` already refused a refund against a RETURNED payment, and
 * the words it refused with were "it never settled, so it cannot also be
 * refunded". *It never settled* is the reason, and both the guard and
 * `refundRefusal` tested the wrong column for it. A bank return is one way a
 * payment fails to settle; the ordinary way is that it simply has not settled
 * YET — an ACH debit three working days from landing.
 *
 * IT BECAME REACHABLE THE DAY THE BANK RAIL GAINED AN INLET. Before that
 * nothing wrote `method: 'ach'`, so no row could be in flight. Neither commit
 * opened refund-helpers.ts. **Widening a rail widens every guard that reads
 * it, whether or not anybody edited them.**
 *
 * The cost is real money out of the park owner's own bank account for money
 * that never reached it, and `park_refunds` is append-only so it cannot be
 * unsaid.
 */

/** A cleared ACH debit — the only ACH payment that may be refunded. */
const LANDED: RefundablePayment = {
  amount: 542.53,
  fee_amount: null,
  method: "ach",
  reference: "ch_1",
  charge_id: "charge-9",
  released: false,
  kind: "rent",
  reversed_at: null,
  returned_at: null,
  settled_at: "2027-01-05T10:00:00Z",
};
const LEFT = { amount: 542.53, fee: 0 };

describe("a refund against money still on its way", () => {
  it("IS REFUSED, IN WORDS", () => {
    const said = refundRefusal({ ...LANDED, settled_at: null }, LEFT);
    expect(said).toMatch(/hasn't landed yet/i);
    expect(said).toMatch(/still on its way from their bank/i);
    expect(said).toMatch(/nothing of theirs to send back/i);
  });

  it("and the sentence says what to do instead, both ways", () => {
    // It is "not yet", not "never" — so it names the two things that end the
    // wait rather than leaving the office with a dead end.
    const said = refundRefusal({ ...LANDED, settled_at: null }, LEFT)!;
    expect(said).toMatch(/wait until it clears/i);
    expect(said).toMatch(/record the bank's return/i);
  });

  it("BUT A LANDED ONE IS STILL REFUNDABLE — or this proves nothing", () => {
    // Collapsed the other way on purpose: a guard that refused every ACH
    // refund would pass the first test on its own and break the rail it
    // exists to protect.
    expect(refundRefusal(LANDED, LEFT)).toBeNull();
  });

  it("a card payment is untouched, because it settles on arrival", () => {
    // 0191 stamps every rail but ACH on insert and a CHECK enforces it, so a
    // card row can never be in this state. January is unaffected.
    expect(refundRefusal({ ...LANDED, method: "card", fee_amount: 12 }, { amount: 542.53, fee: 12 }))
      .toBeNull();
  });
});

describe("which refusal a person reads when several are true", () => {
  it("A RETURN COMES FIRST, because it is the more specific thing", () => {
    // The two overlap: an ACH debit can be returned before it ever settles.
    // "The bank took it back" tells the office something it can act on;
    // "hasn't landed yet" would read as patience about money that is gone.
    const said = refundRefusal(
      { ...LANDED, settled_at: null, returned_at: "2027-01-08T00:00:00Z" }, LEFT,
    );
    expect(said).toMatch(/the bank took that payment back/i);
    expect(said).not.toMatch(/hasn't landed yet/i);
  });

  it("a reversal comes before it too", () => {
    const said = refundRefusal({ ...LANDED, settled_at: null, reversed_at: "2027-01-08T00:00:00Z" }, LEFT);
    expect(said).toMatch(/never having arrived/i);
    expect(said).not.toMatch(/hasn't landed yet/i);
  });

  it("AND THE ORDER IS PINNED IN THE SOURCE, not inferred from a fixture", () => {
    // A behavioural test cannot pin this one. The rail clause only fires for
    // a method that is neither card nor ach, and 0191 makes every such row
    // settled on arrival — so no reachable row triggers both clauses, and
    // swapping them changes no output. A mutation that moved the clause
    // passed a behavioural assertion for exactly that reason.
    //
    // The order still matters for the next person who adds a rail: "no card
    // to send it back to" is false of an unsettled debit, which has a rail
    // and simply has not arrived. So it is asserted where it is true — in the
    // shape of the function.
    const src = readFileSync(
      fileURLToPath(new URL("./refund-helpers.ts", import.meta.url)), "utf8");
    const body = src.slice(src.indexOf("export function refundRefusal"));
    const returned = body.indexOf("if (pay.returned_at)");
    const reversed = body.indexOf("if (pay.reversed_at)");
    const landed = body.indexOf("if (!pay.settled_at)");
    const rail = body.indexOf('if (pay.method !== "card"');
    for (const [name, at] of [["returned", returned], ["reversed", reversed], ["landed", landed], ["rail", rail]] as const) {
      expect(at, `${name} clause is gone — repoint this`).toBeGreaterThan(-1);
    }
    expect(returned).toBeLessThan(landed);
    expect(reversed).toBeLessThan(landed);
    expect(landed).toBeLessThan(rail);
  });
});

describe("one predicate for whether money has arrived", () => {
  it("is clearing while nothing has stamped it", () => {
    expect(isClearing({ settledAt: null })).toBe(true);
    expect(isClearing({ settledAt: "2027-01-05T10:00:00Z" })).toBe(false);
  });

  it("IS NOT THE SAME QUESTION AS WHETHER IT FAILED TO STAY", () => {
    // `notCollectedAt` answers "did this money fail to stay" — reversed, or
    // taken back. A debit on its second working day has not failed, and a
    // screen that struck it through would be wrong.
    expect(notCollectedAt({ reversedAt: null, bankReturnedAt: null })).toBeNull();
    expect(isClearing({ settledAt: null })).toBe(true);
  });
});

// ------------------------------------------------------------- the wiring --

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const here = (p: string) => strip(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));

describe("the guard cannot be switched off by a forgotten select", () => {
  const helpers = here("./refund-helpers.ts");
  const actions = here("./ledger-actions.ts");

  it("`settled_at` IS REQUIRED ON THE TYPE, not optional", () => {
    // The file's own comment, written about `returned_at` going unfetched for
    // months: "`?` on a field a guard reads is how a guard gets switched off
    // silently." The compiler is the only thing that enforces it.
    expect(helpers).toMatch(/\n  settled_at: string \| null;/);
    expect(helpers).not.toMatch(/settled_at\?:/);
  });

  it("AND THE SELECT FETCHES IT", () => {
    // A condition widened without its select compiles, reads undefined, and
    // refuses nobody — which is exactly what happened to `returned_at` here.
    // SCOPED TO `refundableOn`, not to the first park_payments read in the
    // file — there are a dozen, and the first version of this assertion
    // measured an unrelated one and failed for the wrong reason.
    const at = actions.indexOf("export async function refundableOn");
    expect(at, "refundableOn is gone — repoint this").toBeGreaterThan(-1);
    const fn = actions.slice(at, actions.indexOf("export async function refundParkPayment", at));
    const sel = fn.slice(fn.indexOf('.from("park_payments")'), fn.indexOf("maybeSingle()"));
    expect(sel.length, "the refund read is gone — this scan is measuring nothing")
      .toBeGreaterThan(40);
    expect(sel).toMatch(/\.select\("[^"]*\bsettled_at\b[^"]*"\)/);
  });

  it("and the object handed to the guard carries it", () => {
    const at = actions.indexOf("const forRefusal: RefundablePayment = {");
    expect(at, "forRefusal is gone — repoint this").toBeGreaterThan(-1);
    const obj = actions.slice(at, actions.indexOf("refundRefusal(forRefusal", at));
    expect(obj).toMatch(/settled_at: \(pay\.settled_at as string \| null\) \?\? null,/);
  });
});

describe("the screen does not offer what the guard will refuse", () => {
  const panel = here("../../components/ParkStatements.tsx");

  it("THE REFUND BUTTON IS HIDDEN ON A CLEARING ROW", () => {
    // The same row already carries the `clearing` pill. Offering "Refund to
    // card" beside it is a control that pays the household out of the owner's
    // own pocket, on the screen where somebody is trying to fix money.
    expect(panel).toMatch(/!notCollectedAt\(r\) && !isClearing\(r\) && !canReverse\(r\.method\) && paymentsLive/);
  });

  it("and the row says why, rather than going quiet", () => {
    expect(panel).toMatch(/!notCollectedAt\(r\) && isClearing\(r\) && paymentsLive/);
    expect(panel).toMatch(/can&apos;t be sent back until it lands/);
  });

  it("ONE DERIVATION, shared with the pill that says the same thing", () => {
    // The pill derived `!r.settledAt` inline. A second copy here is how one
    // row comes to show "clearing" and offer "Refund to card" at once — the
    // mistake `canReverse` was extracted to fix.
    expect(panel).toMatch(/import \{[\s\S]*?\bisClearing\b[\s\S]*?\} from "@\/app\/park\/receipts-helpers"/);
    expect(panel).toMatch(/isClearing\(r\) && !notCollectedAt\(r\)/);
    expect(panel).not.toMatch(/!r\.settledAt/);
  });
});

describe("the database refuses it too, and keeps what it already had", () => {
  const sql = readFileSync(fileURLToPath(
    new URL("../../../supabase/migrations/0198_money_that_never_arrived_cannot_be_sent_back.sql", import.meta.url)),
    "utf8");

  it("the new clause reads settled_at and says it in words", () => {
    expect(sql).toMatch(/if pay\.settled_at is null then/);
    expect(sql).toMatch(/has not landed yet/);
  });

  it("AND THE SELECT INSIDE THE GUARD FETCHES IT", () => {
    const at = sql.indexOf("select p.id, p.park_id");
    const sel = sql.slice(at, sql.indexOf("for update", at));
    expect(sel).toMatch(/p\.settled_at/);
  });

  it("THE THREE THINGS A REWRITE WOULD HAVE DROPPED ARE STILL THERE", () => {
    // A first draft of 0198 rewrote this function from memory and lost all
    // three. `for update` is a documented race guard, the allocation ceiling
    // stops money already on bills going back, and security definer decides
    // who the trigger runs as.
    expect(sql).toMatch(/for update;/);
    expect(sql).toMatch(/still unapplied/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/set search_path to 'public'/);
  });

  it("and the migration asserts all three for itself", () => {
    expect(sql).toMatch(/lost its FOR UPDATE race guard/);
    expect(sql).toMatch(/lost the allocation ceiling/);
    expect(sql).toMatch(/lost security definer/);
  });

  it("the probe proves it BOTH ways — refused before, accepted after", () => {
    // A guard that refused every ACH refund would pass the first probe alone.
    expect(sql).toMatch(/\[a in-flight refund refused=%s\]/);
    expect(sql).toMatch(/\[b refund after it landed accepted=true\]/);
    expect(sql).toMatch(/\[c card refund still accepted=true\]/);
  });
});
