import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LakeLifePayments } from "./payments";
// THE CHECKSUM LIVES IN `payouts.ts`, WHERE IT ALREADY WAS. The first draft
// of the bank tokenizer wrote a second copy of it in payments.ts; two copies
// of a validation rule is how two doorways come to disagree about whether a
// bank account is valid. Imported from its one home so this test would fail
// if a third copy ever shadowed it.
import { abaValid } from "./payouts";
import { surchargePct, cardFeeCents } from "@/app/parks/card-fee";

/**
 * PAYING RENT FROM A BANK ACCOUNT — the inlet the rail never had.
 *
 * Verified the day this was written: NOTHING in the application wrote
 * `method: 'ach'`. All sixteen `'ach'` sites in src/ were READS — a refund
 * rail, a sentence, a refusal. `pay-actions.ts` wrote `method: "card"` and
 * `payment_methods` was card-shaped (brand, last4, exp_month, exp_year,
 * funding) with nowhere to put a bank account.
 *
 * Meanwhile the database had modelled provisional settlement since 0191, bank
 * returns since 0155, and five screens explained money on its way. 0197 adds
 * the shape; this is the arithmetic and the doorway rules.
 *
 * THE MONEY: pay-actions has carried the figure since online rent was built —
 * about $1,860 a year in card fees at The Haven against roughly $230 on ACH.
 */

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const here = (p: string) => strip(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));

// ------------------------------------------------- the routing checksum ---

describe("the ABA checksum", () => {
  it("accepts real routing numbers", () => {
    // 3-7-1 repeating, summed, mod 10. These are live Fed/bank numbers.
    for (const good of ["074000010", "021000021", "111000025", "071000013"]) {
      expect(abaValid(good), good).toBe(true);
    }
  });

  it("CATCHES A TRANSPOSED DIGIT, which is the whole reason it exists", () => {
    // The commonest data-entry error there is, and the direct cause of an R04
    // return: the debit goes out, comes back days later, the bill reopens, the
    // park is charged a return fee and the household is told their payment
    // failed — for two digits swapped.
    expect(abaValid("074000010")).toBe(true);
    expect(abaValid("070400010")).toBe(false);
    expect(abaValid("021000021")).toBe(true);
    expect(abaValid("201000021")).toBe(false);
  });

  it("refuses all zeroes, which the arithmetic alone would pass", () => {
    // 0 x anything is 0 and 0 mod 10 is 0. It is also what a blank field and a
    // lazy fixture both produce.
    expect(abaValid("000000000")).toBe(false);
  });

  it("and anything that is not nine digits", () => {
    for (const bad of ["", "   ", "07400001", "0740000100", "07400001x", "074-000-010", "abcdefghi"]) {
      expect(abaValid(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("THERE IS EXACTLY ONE COPY OF IT IN THE TREE", () => {
    // The mistake this test exists to stop recurring: the bank tokenizer's
    // first draft wrote a second `abaValid` in payments.ts, next to one that
    // had been in payouts.ts since the crew payout rails were built. Two
    // copies of a validation rule is how two doorways come to disagree about
    // whether a bank account is valid, and this codebase has already paid for
    // it once — ten copies of the HTML escaper became one.
    const roots = ["./payments.ts", "./payouts.ts", "../app/vendor/bank-actions.ts"];
    const defs = roots.filter((r) => /export function abaValid/.test(here(r)));
    expect(defs, "more than one module defines the ABA checksum").toEqual(["./payouts.ts"]);
  });
});

// ------------------------------------------------------ tokenizing it ----

describe("tokenizing a bank account", () => {
  const good = { routing: "074000010", account: "000123456789", accountKind: "checking" as const };

  it("returns a token, four digits and which kind", async () => {
    const res = await LakeLifePayments.tokenizeBank({ ...good, bankName: "Farmers State Bank" });
    expect(res.ok).toBe(true);
    expect(res.token!.last4).toBe("6789");
    expect(res.token!.account_kind).toBe("checking");
    expect(res.token!.bank_name).toBe("Farmers State Bank");
    expect(res.token!.token.length).toBeGreaterThan(10);
  });

  it("THE ROUTING AND ACCOUNT NUMBERS DO NOT COME BACK", () => {
    // Rule 4's whole point, and the reason 0197 asserts that no column on
    // payment_methods is even NAMED like a bank credential.
    return LakeLifePayments.tokenizeBank(good).then((res) => {
      const all = JSON.stringify(res);
      expect(all).not.toContain("074000010");
      expect(all).not.toContain("000123456789");
      // The last four are the one fragment that is kept, deliberately: with no
      // brand and no expiry it is all that tells two accounts apart.
      expect(all).toContain("6789");
    });
  });

  it("THE TOKEN'S DIGIT RUNS ARE BOUNDED BY CONSTRUCTION", async () => {
    // The card tokenizer shipped with a comment claiming its tail was base36
    // when crypto.randomUUID() is HEX — ten digits in sixteen symbols — so
    // about one token in a few hundred carried twelve digits in a row and our
    // own charge() rejected our own token. It surfaced as a 1-in-900 flake.
    // 0007's CHECK refuses /[0-9]{13,19}/ on the column too.
    for (let i = 0; i < 400; i += 1) {
      const res = await LakeLifePayments.tokenizeBank({ ...good, account: "9999999999999999" });
      const tail = res.token!.token.replace(/^tok_[a-z0-9]+_\d{4}_/, "");
      expect(/\d{12,}/.test(tail), res.token!.token).toBe(false);
      expect(res.token!.token.length).toBeLessThanOrEqual(64);
    }
  });

  it("a bad routing number is said to be a likely typo, not a verdict on their bank", async () => {
    const res = await LakeLifePayments.tokenizeBank({ ...good, routing: "070400010" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/two digits swapped/i);
  });

  it("a routing number of the wrong length says where to find it", async () => {
    const res = await LakeLifePayments.tokenizeBank({ ...good, routing: "0740" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nine digits/i);
    expect(res.error).toMatch(/cheque/i);
  });

  it("an account number outside 4 to 17 digits is refused", async () => {
    // NACHA's own ceiling, and the floor is what guarantees last4 has four.
    for (const account of ["", "12", "123", "123456789012345678"]) {
      const res = await LakeLifePayments.tokenizeBank({ ...good, account });
      expect(res.ok, account).toBe(false);
      expect(res.error, account).toMatch(/4 and 17/);
    }
    expect((await LakeLifePayments.tokenizeBank({ ...good, account: "1234" })).ok).toBe(true);
    expect((await LakeLifePayments.tokenizeBank({ ...good, account: "12345678901234567" })).ok).toBe(true);
  });

  it("and a kind that is neither checking nor savings is refused", async () => {
    const res = await LakeLifePayments.tokenizeBank({
      ...good, accountKind: "brokerage" as unknown as "checking",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/checking or a savings/i);
  });

  it("spaces and dashes a person types are not an error", async () => {
    const res = await LakeLifePayments.tokenizeBank({
      routing: "074-000-010", account: "0001 2345 6789", accountKind: "savings",
    });
    expect(res.ok).toBe(true);
    expect(res.token!.last4).toBe("6789");
    expect(res.token!.account_kind).toBe("savings");
  });

  it("no bank name is null, not an empty string", async () => {
    const res = await LakeLifePayments.tokenizeBank({ ...good, bankName: "   " });
    expect(res.token!.bank_name).toBeNull();
  });
});

// ------------------------------------------------------ the surcharge ----

describe("a bank debit is never surcharged", () => {
  it("THREE GUARDS, AND THIS IS THE ONE A READER CAN SEE", () => {
    // 0109 refuses `fee_amount > 0` on a non-card at the database, and 0197
    // pins a bank row's funding to 'unknown' which surchargePct answers with
    // zero. Both are true. Neither is visible in pay-actions, so the action
    // says it by KIND as well — a rule true only by accident of a column
    // default is a rule waiting to be broken by the next migration.
    expect(surchargePct(3, "unknown")).toBe(0);
    expect(cardFeeCents(54_253, 0)).toBe(0);
  });

  it("and a credit card still is, or this proves nothing", () => {
    // Collapse it the other way: a change that simply stopped all surcharging
    // would pass the test above on its own.
    expect(surchargePct(3, "credit")).toBe(3);
    expect(cardFeeCents(54_253, 3)).toBe(1628);
  });
});

// -------------------------------------------------------- the doorways ---


describe("saving a bank account", () => {
  const src = here("../app/profile/payment-actions.ts");

  it("writes kind 'bank' and the two facts a bank row carries", () => {
    const at = src.indexOf("export async function saveBankAccount");
    expect(at, "saveBankAccount is gone — repoint this").toBeGreaterThan(-1);
    const body = src.slice(at);
    const write = body.slice(body.indexOf(".insert({"), body.indexOf("if (error)"));
    expect(write).toMatch(/kind: "bank"/);
    expect(write).toMatch(/account_kind:/);
    expect(write).toMatch(/bank_name:/);
  });

  it("NOTHING HERE PASSES `funding`", () => {
    // The column is NOT NULL and defaults to 'unknown'; 0197's trigger pins it
    // on a bank row. A doorway writing it would be taking responsibility for a
    // rule that belongs to all of them — and 'credit' is the one value that
    // would let a surcharge be computed against a bank debit.
    const body = src.slice(src.indexOf("export async function saveBankAccount"));
    const write = body.slice(body.indexOf(".insert({"), body.indexOf("if (error)"));
    expect(write.length, "the insert is gone — this scan is measuring nothing").toBeGreaterThan(40);
    expect(write).not.toMatch(/funding/);
  });

  it("A BANK ROW MUST SAY WHICH ACCOUNT IT IS — unlike a card's, last4 is required", () => {
    const body = src.slice(
      src.indexOf("export async function saveBankAccount"),
      src.indexOf("export async function removePaymentMethod"),
    );
    expect(body).toMatch(/\/\^\\d\{4\}\$\/\.test/);
  });

  it("and both rails share one rule-4 shape guard", () => {
    // A rule in one doorway of two is the shape this codebase has paid for
    // repeatedly. There is exactly one copy and both callers reach it.
    expect((src.match(/function tokenShapeRefusal/g) ?? []).length).toBe(1);
    expect((src.match(/tokenShapeRefusal\(/g) ?? []).length).toBe(3);
  });

  it("the guard does NOT require a `tok_` prefix", () => {
    // That is the mock's format. A real processor issues its own, so a prefix
    // test means nothing can ever be saved the day the SDK is swapped in.
    const guard = src.slice(src.indexOf("function tokenShapeRefusal"), src.indexOf("async function isTheirFirstMethod"));
    expect(guard).not.toMatch(/startsWith\("tok_"\)/);
    expect(guard).toMatch(/\\d\{13,19\}/);
  });

  it("a failed count never silently reassigns which method autopay uses", () => {
    const guard = src.slice(src.indexOf("async function isTheirFirstMethod"));
    const body = guard.slice(0, guard.indexOf("export async function savePaymentMethod"));
    expect(body).toMatch(/countRes\.error/);
    expect(body).toMatch(/return \{ ok: false/);
  });
});

describe("the rent charge path picks its rail", () => {
  const src = here("../app/parks/pay-actions.ts");

  it("READS `kind`, or a bank account would be charged as a card", () => {
    // method 'card' on the row, settled on arrival, and a surcharge computed
    // against a bank debit that 0109 refuses — so the insert would fail AFTER
    // the money had left their account.
    const read = src.slice(src.indexOf('.from("payment_methods")'));
    const select = read.slice(0, read.indexOf("maybeSingle()"));
    expect(select).toMatch(/\.select\("[^"]*\bkind\b[^"]*"\)/);
  });

  it("THE CAPABILITY IS CHECKED PER RAIL", () => {
    // `rentCapability` has returned byAch and byCard since 0196 and every
    // doorway branched on `canTakeOnlineRent` alone — so a merchant approved
    // for cards only would have accepted a bank debit, and the processor
    // declines it after the resident has been told it is going through.
    //
    // THE WHOLE CONDITION, NOT THE TOKEN. The first version of this asserted
    // `/capability\.byAch/` and PASSED when the branch was mutated to
    // `if (false && !capability.byAch)` — the token was still present and the
    // guard was dead. A source scan proves a token is present, never that it
    // is reachable, and this test had to learn that about itself.
    expect(src).toMatch(/const byBank = pm\.kind === "bank";/);
    expect(src).toMatch(/if \(byBank && !capability\.byAch\) \{/);
    expect(src).toMatch(/if \(!byBank && !capability\.byCard\) \{/);
    expect(src).toMatch(/can't take bank transfers yet/);
    expect(src).toMatch(/can't take card payments yet/);
    // And neither guard has been short-circuited open.
    expect(src).not.toMatch(/if \((?:false|true) &&/);
  });

  it("writes method 'ach' for a bank method and 'card' otherwise", () => {
    expect(src).toMatch(/method: byBank \? "ach" : "card"/);
  });

  it("DOES NOT PASS `settled_at`, which is what makes an ACH debit provisional", () => {
    // 0191's trigger stamps it for every rail that settles on arrival and
    // leaves ACH null. Passing a value would claim money had arrived that is
    // three working days away — and the bill, the arrears figure and the
    // reminder run all key on it.
    const at = src.indexOf('.from("park_payments")');
    const write = src.slice(at, src.indexOf("if (error)", at));
    expect(write.length, "the insert is gone — this scan is measuring nothing").toBeGreaterThan(40);
    expect(write).not.toMatch(/settled_at/);
  });

  it("charges no fee on a bank debit, said by KIND", () => {
    expect(src).toMatch(/const feePct = byBank \? 0 :/);
  });

  it("AND NEVER TELLS THEM IT IS PAID", () => {
    // `park_charge_paid_total` does not count an unsettled payment, so the
    // bill is still open — "Paid" would contradict the resident's own ledger
    // on the next screen.
    const tail = src.slice(src.indexOf("if (byBank) {"));
    const signal = tail.slice(0, tail.indexOf("return {\n    ok: true,\n    signal: feeCents > 0"));
    expect(signal.length, "the bank signal is gone — repoint this").toBeGreaterThan(40);
    expect(signal).not.toMatch(/\bPaid\b/);
    expect(signal).toMatch(/few working days/);
    expect(signal).toMatch(/on its way/);
    expect(signal).toMatch(/Nobody will chase you/);
  });

  it("and the idempotent replay says the same thing for a bank debit", () => {
    // The 23505 path is reached when the twin call already filed this exact
    // payment. It used to be one sentence for both rails: "That's paid."
    const at = src.indexOf('code === "23505"');
    const branch = src.slice(at, at + 420);
    expect(branch).toMatch(/byBank/);
    expect(branch).toMatch(/on its way/);
  });
});

describe("the wallet shows both, and tells them apart", () => {
  const panel = here("../components/PaymentMethods.tsx");

  it("has a door for a bank account", () => {
    expect(panel).toMatch(/Add a bank account/);
    expect(panel).toMatch(/saveBankAccount\(/);
    expect(panel).toMatch(/tokenizeBank\(/);
  });

  it("NO EXPIRY LINE ON A BANK ROW", () => {
    // It has none. The card line's padStart/slice over a null renders
    // "exp NaN/ed" — the shape this codebase calls a number nobody set.
    expect(panel).toMatch(/c\.kind === "bank"/);
    // ANCHORED ON CODE, NOT ON A COMMENT. The first version of this sliced
    // from a `{/* … */}` marker that `strip` had already removed, so it
    // measured the empty string and would have passed over a deleted branch.
    const at = panel.lastIndexOf('c.kind === "bank"');
    const row = panel.slice(at, panel.indexOf("c.is_default ?", at));
    expect(row.length, "the kind branch is gone — this scan is measuring nothing")
      .toBeGreaterThan(40);
    expect(row).toMatch(/savings account/);
    expect(row).toMatch(/checking account/);
    // And the expiry is INSIDE the card arm, not printed for both.
    expect(row).toMatch(/exp \$\{String\(c\.exp_month\)/);
  });

  it("says a bank payment is slower before they choose it", () => {
    // Cheaper and slower, and "slower" is the half that causes a phone call
    // if nobody mentions it.
    expect(panel).toMatch(/no card fee/);
    expect(panel).toMatch(/few working days to land/);
    expect(panel).toMatch(/nobody\s*\n?\s*will chase you|nobody will chase you/i);
  });

  it("and never claims to store the account number", () => {
    expect(panel).toMatch(/never see or store your account number/);
  });
});
