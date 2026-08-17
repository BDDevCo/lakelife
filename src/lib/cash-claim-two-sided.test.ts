import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * LAKELIFE HANDLES NO CASH. THE LEDGER STILL HAS TO BE RIGHT.
 *
 * Rent paid in cash or by cheque goes hand to hand from the resident to the
 * park owner; no LakeLife account is ever near it. So the only thing the
 * software can offer is a record BOTH parties agreed to — the resident says
 * they paid, the owner confirms they collected it, and nothing counts as
 * received until the second half happens.
 *
 * 0074 built the table for this and got the hard parts right. What was missing
 * was the resident: `logPaymentClaim` sits behind `assertMyPark` on the
 * office's screen, so a row stamped `asserted_by: 'renter'` could only ever be
 * written by somebody who was not the renter. Every test below names the
 * failure it prevents, not the code it matches.
 */

// The repo path contains a space, so URL.pathname hands back "%20" and
// readFileSync looks for a directory that does not exist. fileURLToPath decodes.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const payActions = () => read("../app/parks/pay-actions.ts");
const ledger = () => read("../app/park/ledger-actions.ts");
const iPaid = () => read("../components/IPaidForm.tsx");
const resolve = () => read("../components/ResolveClaimForm.tsx");
const renterHome = () => read("../components/RenterHome.tsx");

/**
 * Slice from a marker, and FAIL if the marker is gone.
 *
 * `s.slice(s.indexOf(missing))` is `s.slice(-1)` — one character — against
 * which every `not.toMatch` passes for free. A rename would have turned half
 * the negative assertions below into decoration without failing anything.
 */
function after(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`marker vanished, so this test proves nothing: ${marker}`);
  return source.slice(at);
}

describe("the files this test scans exist", () => {
  it("finds all five, with comments stripped", () => {
    expect(payActions()).toMatch(/export async function sayIPaid/);
    expect(ledger()).toMatch(/export async function confirmClaimCollected/);
    expect(iPaid()).toMatch(/export function IPaidForm/);
    expect(resolve()).toMatch(/export function ResolveClaimForm/);
    expect(renterHome()).toMatch(/IPaidForm/);
  });
});

describe("the resident can say it themselves", () => {
  it("writes the claim as the renter's OWN assertion, logged to their account", () => {
    // The whole point. Before this, `asserted_by: 'renter'` was written only by
    // `logPaymentClaim`, which requires assertMyPark — so the one thing the
    // column recorded was never true of the person who wrote the row.
    expect(payActions()).toMatch(/asserted_by: "renter"/);
    expect(payActions()).toMatch(/logged_by: user\.id/);
  });

  it("is reachable from the resident's screen, not just the office's", () => {
    expect(renterHome()).toMatch(/<IPaidForm/);
    expect(iPaid()).toMatch(/sayIPaid\(/);
  });

  it("does NOT depend on the park taking online rent", () => {
    // The park that accepts no card is exactly the park where every payment is
    // cash or a cheque, so it needs this most. Gating it behind
    // acceptsOnlineRent — the way the Pay button correctly is — would hide it
    // from the only households that will ever use it.
    //
    // READ THE GUARD, NOT THE ELEMENT. The first version of this test sliced
    // FROM "<IPaidForm" and asserted the remainder had no acceptsOnlineRent —
    // but the guard sits immediately BEFORE the element, so adding the gate
    // left the test green. It caught nothing until it captured the condition.
    const guard = renterHome().match(/\{([^{}]*?)&&\s*\(\s*<IPaidForm/);
    expect(guard, "the IPaidForm guard expression").not.toBeNull();
    const cond = guard![1];
    expect(cond).not.toMatch(/acceptsOnlineRent/);
    // And it IS still gated on the two that matter: something is owed, and no
    // claim is already open.
    expect(cond).toMatch(/outstanding > 0/);
    expect(cond).toMatch(/!b\.disputed/);
  });
});

describe("saying it does not make it so", () => {
  it("credits nothing — no payment row comes out of the resident's claim", () => {
    // If this ever inserts into park_payments, a resident can settle their own
    // rent by typing into a form. The claim's only power is to stop the chase.
    const fn = after(payActions(), "export async function sayIPaid");
    expect(fn).toMatch(/from\("park_payment_claims"\)\s*\.insert/);
    expect(fn).not.toMatch(/from\("park_payments"\)\s*\.insert/);
  });

  it("proves the bill is theirs before writing anything", () => {
    // The charge id arrives from a browser. The path from the signed-in
    // account to the bill has to run through the claimed renter file — the
    // same gate payRent uses — or one resident can dispute another's rent.
    const fn = after(payActions(), "export async function sayIPaid");
    expect(fn).toMatch(/from\("park_renters"\)/);
    expect(fn).toMatch(/\.eq\("user_id", user\.id\)/);
    expect(fn).toMatch(/That isn't your bill\./);
  });

  it("refuses a payment date that has not happened yet", () => {
    const fn = after(payActions(), "export async function sayIPaid");
    expect(fn).toMatch(/paidOn > todayLakeDate\(\)/);
  });

  it("allows only one open claim per bill", () => {
    // Every open claim is a household not being chased. One is the record;
    // unlimited is a way never to be asked for rent again.
    const fn = after(payActions(), "export async function sayIPaid");
    expect(fn).toMatch(/is\("resolved_at", null\)/);
    expect(fn).toMatch(/already told the office/);
  });

  it("still records the claim when the owner's email fails to send", () => {
    // The record is the point; the notification is the courtesy. A Resend
    // outage must not cost a resident their proof that they spoke up.
    expect(payActions()).toMatch(/async function tellTheOffice/);
    const notify = after(payActions(), "async function tellTheOffice");
    expect(notify).toMatch(/try \{/);
    expect(notify).toMatch(/\} catch \{/);
  });
});

describe("the owner's confirmation is what moves the money", () => {
  it("offers the affirmative answer AT ALL", () => {
    // The form shipped with two endings, both bad news. The ordinary case —
    // the resident is right, the cash is in the drawer — had no button, only a
    // trip to another form to retype an amount this screen was already showing.
    expect(resolve()).toMatch(/setResolution\("collected"\)/);
    expect(resolve()).toMatch(/confirmClaimCollected\(/);
  });

  it("defaults to it, because it is the usual answer", () => {
    expect(resolve()).toMatch(/useState<"collected" \| "not_found" \| "withdrawn">\("collected"\)/);
  });

  it("routes the confirmation through recordPayment, not a second insert", () => {
    // 0074's trigger closes the claim as 'matched' on the payment insert, and
    // recordPayment is where the receipt number, the date sanity window and
    // 0081's double-tap index live. A bespoke insert here would silently skip
    // all four.
    const fn = after(ledger(), "export async function confirmClaimCollected");
    expect(fn).toMatch(/return recordPayment\(/);
    expect(fn).not.toMatch(/from\("park_payments"\)\s*\.insert/);
  });

  it("scopes the claim to the park before touching it", () => {
    const fn = after(ledger(), "export async function confirmClaimCollected");
    expect(fn).toMatch(/assertMyPark\(parkId\)/);
    expect(fn).toMatch(/park_charges!inner\(park_id\)/);
    expect(fn).toMatch(/owner !== parkId/);
  });

  it("will not confirm one twice", () => {
    const fn = after(ledger(), "export async function confirmClaimCollected");
    expect(fn).toMatch(/claim\.resolved_at/);
    expect(fn).toMatch(/already been answered/);
  });

  it("keeps the written reason on the answer that creates a debt", () => {
    // "I checked and there's no such payment" puts a household back in arrears
    // on the park's word alone. Adding a third option must not have loosened
    // the note requirement on that one.
    expect(resolve()).toMatch(/needsNote = resolution === "not_found"/);
    expect(resolve()).toMatch(/needsNote && !note\.trim\(\)/);
    expect(ledger()).toMatch(/Say what you checked\./);
  });
});

describe("the screens say what actually happened", () => {
  it("tells the resident they reported a PAYMENT, not a complaint", () => {
    // This once read "you've told the office this doesn't look right" —
    // written when only the office could open a claim, and wrong the moment a
    // resident could. park_payment_claims is "I already paid this".
    expect(renterHome()).toMatch(/told the office you paid this/);
    expect(renterHome()).not.toMatch(/told the office this doesn't look right/);
    expect(payActions()).not.toMatch(/this bill doesn't look right/);
  });

  it("reads dates as a person reads them, on both sides", () => {
    // MEMORY: a date on screen is "August 14, 2026", never 2026-08-14. The
    // office's claim summary printed the raw column for months.
    expect(resolve()).toMatch(/pretty\(claim\.claimed_paid_on\)/);
    expect(renterHome()).toMatch(/pretty\(b\.claimedPaidOn\)/);
  });

  it("does not promise a text, because no text has ever arrived", () => {
    // 0 of 81 delivered since July — A2P 10DLC is unregistered. Email carries
    // this notification alone, and the copy must not claim otherwise.
    expect(payActions()).toMatch(/sendEmail\(/);
    const notify = after(payActions(), "async function tellTheOffice");
    expect(notify).not.toMatch(/sendSms/);
  });
});
