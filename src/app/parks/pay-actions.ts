"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { takePayment, paymentsAreLive } from "@/lib/charge-gate";
import { surchargePct, cardFeeCents } from "@/app/parks/card-fee";
import { rentDescriptor } from "@/lib/descriptor";
import { todayLakeDate } from "@/lib/booking";
import { sendEmail } from "@/lib/email";
import { prettyMonth } from "@/app/park/ledger-helpers";

/**
 * PAYING RENT FROM THE RESIDENT'S OWN SCREEN.
 *
 * RENT IS THE PARK'S MONEY. LakeLife moves it and records it; it never becomes
 * our revenue, never nets against a service debt, and a late bill here can
 * never hold back a mow. The row this writes is an ordinary `park_payments`
 * row — the same one the office writes for a cheque — so the existing paid
 * total, receipt number and claim-settling triggers all apply unchanged.
 * Online is a METHOD, not a second money path.
 *
 * ON THE RAIL. This charges the saved card through the same mock interface the
 * service side uses, so the processor is a later config decision. When real
 * keys arrive, rent belongs on ACH: The Haven is ~$5,200 a month, which is
 * about $1,860 a year in card fees versus roughly $230 on ACH. `method`
 * already accepts both.
 */

export interface PayResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

/**
 * A CHECK THAT COULD NOT BE RUN IS NOT A CHECK THAT PASSED.
 *
 * Every read in this file used to be written `const { data } = await ...`,
 * which cannot tell a failed read from an empty one. Four of them fail CLOSED
 * and merely lie — a dropped connection produced "We can't find that bill" or,
 * worse, "That isn't your bill", told to somebody looking at their own rent.
 *
 * ONE OF THEM FAILED OPEN, and that one took money. The disputed-bill guard
 * counted open claims and read `(count ?? 0) > 0`; a failed count is `null`, so
 * it evaluated false and the charge went through on a bill the resident had
 * formally disputed. The comment above it called that "the single worst thing
 * this action could do", and it was one dropped packet away at all times.
 *
 * The second-order effect is what makes it hard to notice afterwards: 0074's
 * `trg_settle_claims_on_payment` fires on the insert and marks the open claim
 * `matched` — "A payment was recorded against this bill." So the dispute is
 * closed as CONCEDED, and the only trace that the guard failed is destroyed by
 * the same transaction that failed it.
 *
 * Actions RETURN rather than throw — the caller is a button expecting a
 * result, not a page with an error boundary — so this is the shared refusal.
 * It names no fact about their account, because the whole problem is that we
 * do not have one.
 */
function couldNotCheck(what: string, error: unknown): PayResult {
  console.error(`[read failed] ${what}:`, error);
  return {
    ok: false,
    error: "We couldn't check something just now, so nothing has been charged. Try again in a moment.",
  };
}

/**
 * THE ONLY MONEY PATH IN THIS MODULE THAT WAS NOT KEYED.
 *
 * `recordPayment`, `recordOnAccount`, `recordDeposit` and
 * `confirmClaimCollected` all take an idempotency key and collide on 0081's
 * unique index — 0081 exists because a double-tapped submit "recorded the
 * money twice and burnt two receipt numbers". This path arrived later (0108,
 * 0109) and skipped it, so the only protection was `disabled={busy}` in the
 * button. That is client-side, and `payRent` is an exported "use server"
 * function any browser can call.
 *
 * Two calls in flight across the processor round-trip — two tabs, a phone and
 * a laptop — both read paid_total, both charge the saved card, both insert.
 * One month's rent taken twice, the roll reading "in credit", and NO REFUND
 * PATH anywhere in the product: `reversePayment` corrects the ledger and
 * returns nothing to the cardholder.
 *
 * The key now goes to the PROCESSOR as well as onto our row. That ordering
 * matters: our unique index can refuse a second ledger row, but only the
 * processor can refuse the second charge.
 */
export async function payRent(chargeId: string, idempotencyKey: string): Promise<PayResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in again." };

  const admin = createServiceClient();

  // ---- is this bill actually theirs? -------------------------------------
  // The charge id comes from a browser, so nothing is trusted about it. The
  // path from the signed-in account to the bill runs through the CLAIMED
  // renter file, which is the same gate the portal itself uses.
  const chargeRes = await admin
    .from("park_charges")
    .select("id, park_id, renter_id, amount, paid_total, status, period_month")
    .eq("id", chargeId)
    .maybeSingle();
  if (chargeRes.error) return couldNotCheck("the bill", chargeRes.error);
  const charge = chargeRes.data;
  if (!charge) return { ok: false, error: "We can't find that bill." };

  // "That isn't your bill" is an accusation. It must never be reachable by a
  // dropped connection, only by a charge that genuinely belongs elsewhere.
  const fileRes = await admin
    .from("park_renters")
    .select("id")
    .eq("id", charge.renter_id as string)
    .eq("user_id", user.id)
    .maybeSingle();
  if (fileRes.error) return couldNotCheck("whose bill this is", fileRes.error);
  const file = fileRes.data;
  if (!file) return { ok: false, error: "That isn't your bill." };

  if ((charge.status as string) === "void") {
    return { ok: false, error: "That bill was cancelled — nothing to pay." };
  }

  // ---- the park has to have agreed to take money this way ----------------
  const parkRes = await admin
    .from("parks")
    .select("accepts_online_rent, name, card_fee_pct")
    .eq("id", charge.park_id as string)
    .maybeSingle();
  if (parkRes.error) return couldNotCheck("the park's settings", parkRes.error);
  const park = parkRes.data;
  if (!park?.accepts_online_rent) {
    return { ok: false, error: "This park isn't taking online rent payments yet." };
  }

  // ---- A DISPUTED BILL IS NOT COLLECTED ----------------------------------
  // They have told the office the ledger is wrong and nothing is being chased
  // until somebody looks. Taking the money anyway — especially on a future
  // autopay run — is the single worst thing this action could do.
  //
  // THE ONE THAT FAILED OPEN. A head-count resolves to `{ count: null, error }`
  // when the read fails, and `(null ?? 0) > 0` is false — so a dropped
  // connection did not skip this guard, it PASSED it, and the card was charged
  // on a bill the resident had formally disputed. Checking the error is the
  // whole fix; the count is now only trusted when there was an answer.
  const claimsRes = await admin
    .from("park_payment_claims")
    .select("id", { count: "exact", head: true })
    .eq("charge_id", charge.id as string)
    .is("resolved_at", null);
  if (claimsRes.error) return couldNotCheck("whether you've flagged this bill", claimsRes.error);
  const openClaims = claimsRes.count;
  if ((openClaims ?? 0) > 0) {
    return {
      ok: false,
      error: "You've told the office you've already paid this, so we're not taking payment until they've confirmed it.",
    };
  }

  // CENTS, ONCE. Everything downstream — the fee, and the total that goes on
  // the wire — is integer arithmetic from here, so nothing is rounded twice on
  // its way to the processor.
  const owedCents = Math.round((Number(charge.amount ?? 0) - Number(charge.paid_total ?? 0)) * 100);
  const owed = owedCents / 100;
  if (owedCents <= 0) return { ok: false, error: "That bill is already settled." };

  // `funding` decides whether the park's card fee may be applied at all — see
  // card-fee.ts. Read here rather than inferred from `brand`, because a brand
  // has never said how a card is funded.
  const pmRes = await admin
    .from("payment_methods")
    .select("token, last4, funding")
    .eq("user_id", user.id)
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pmRes.error) return couldNotCheck("your saved card", pmRes.error);
  const pm = pmRes.data;
  if (!pm?.token) return { ok: false, error: "Add a payment method first." };

  // ---- what this card is allowed to cost ---------------------------------
  // A percentage of the rent, charged ON TOP and never added to `amount`, so
  // paid_total, the receipt and the arrears maths keep meaning what they meant
  // before online payments existed. ACH is not surcharged; 0109 refuses it at
  // the database.
  //
  // ONLY ON A CREDIT CARD. Network rules forbid surcharging debit at any rate
  // in every state. This line used to read the park's dial straight off the
  // row, so The Haven's 3% reached every card alike — a rule violation on
  // every debit payment the day a processor connects. `surchargePct` is the
  // one gate both this action and the screen that discloses the fee go
  // through; 0156 gave it the fact it needs, and 'unknown' — which is every
  // card on file today — is surcharged nothing.
  const feePct = surchargePct(park.card_fee_pct, pm.funding);
  const feeCents = cardFeeCents(owedCents, feePct);
  const fee = feeCents / 100;
  const totalCents = owedCents + feeCents;

  // ---- take it -----------------------------------------------------------
  const charged = await takePayment({
    token: pm.token as string,
    amountCents: totalCents,
    // The park's name on the statement, not LakeLife's — it is their rent, and
    // an unrecognised line on a bank statement is a chargeback.
    description: rentDescriptor(park.name as string),
    idempotencyKey,
  });
  if (!charged.ok || !charged.ref) {
    // "TRY AGAIN" IS ONLY TRUE OF A DECLINE. When the cause is that no
    // processor is connected, trying again can never work — and telling a
    // resident to retry a path that cannot succeed is the same defect as the
    // unique-index retry loop. Say which it is.
    if (!paymentsAreLive()) {
      return {
        ok: false,
        error: "Card payments aren't switched on for this park yet — ring the office and they'll take it another way.",
      };
    }
    return { ok: false, error: "That payment didn't go through. Try again, or ring the office." };
  }

  // 0108 refuses a card or ACH row with no processor reference, so a payment
  // that cannot be traced cannot be recorded at all.
  const { error } = await admin.from("park_payments").insert({
    park_id: charge.park_id,
    renter_id: file.id,
    charge_id: charge.id,
    amount: owed,
    method: "card",
    received_on: todayLakeDate(),
    reference: charged.ref,
    kind: "rent",
    fee_amount: feeCents > 0 ? fee : null,
    idempotency_key: idempotencyKey,
  });
  if (error) {
    // 23505 = 0081's unique index. The twin call already filed this exact
    // payment, and the processor replayed rather than re-charged, so the money
    // moved once and is recorded once. Telling them it failed would be a lie
    // that invites a THIRD attempt.
    if ((error as { code?: string }).code === "23505") {
      return { ok: true, signal: "That's paid — thank you. It's on your ledger." };
    }
    // The money left their account and the ledger did not record it. This is
    // the one failure ops must never discover from a resident.
    return {
      ok: false,
      error: `Your payment went through (${charged.ref}) but we couldn't file it. Ring the office with that reference — do not pay again.`,
    };
  }

  revalidatePath("/parks/my");
  return {
    ok: true,
    signal: feeCents > 0
      ? `Paid — ${owed.toFixed(2)} rent plus a ${feePct}% card fee of ${fee.toFixed(2)}.`
      : `Paid — thank you. It's on your ledger straight away.`,
  };
}

/**
 * "I ALREADY PAID THIS" — THE RESIDENT'S OWN END OF THE RECORD.
 *
 * ============================================================================
 * LAKELIFE HANDLES NO CASH. NOT A PHASE-ONE LIMIT — A RULE.
 * ============================================================================
 * A resident paying cash or by cheque hands it to the park owner directly,
 * hand to hand. No LakeLife account ever sees that money. What LakeLife owes
 * both of them is a record they AGREE ON, which takes two statements and not
 * one: the resident says they paid, the owner confirms they collected it, and
 * nothing counts as received until the owner has said so.
 *
 * This is the half that was missing. 0074 built the table — a bare "I paid
 * you" with no amount and no date is recordable on purpose, an unanswered
 * claim stops the chase, and the office cannot dismiss one without writing
 * down why. But the only writer was `logPaymentClaim`, which sits behind
 * `assertMyPark` on the OFFICE's screen. The office typed in what the resident
 * said. A row stamped `asserted_by: 'renter'` could only be created by
 * somebody who was not the renter.
 *
 * WHAT THIS DOES NOT DO, DELIBERATELY:
 *
 * - It does not credit the bill. `paid_total` does not move, no receipt number
 *   is minted, and the accountant's income figure does not change. Only the
 *   owner confirming — which records a real payment — does that.
 * - It does not let anyone mark themselves paid. The strongest thing a
 *   resident can do here is stop being chased while a human looks, which is
 *   the correct outcome when the ledger and the kitchen drawer disagree.
 */
export async function sayIPaid(
  chargeId: string,
  input: {
    /** ISO date. Optional — "I paid you" with no date is still their account. */
    paidOn?: string;
    method?: "cash" | "check" | "transfer" | "other";
    /** A cheque number, or a slip serial. */
    reference?: string;
    /** Whatever name they handed it to. At a takeover this is the whole answer. */
    paidTo?: string;
    note?: string;
  },
): Promise<PayResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in again." };

  const admin = createServiceClient();

  // ---- is this bill actually theirs? -------------------------------------
  // Same gate as payRent: the path from the signed-in account to the bill runs
  // through the CLAIMED renter file. The charge id came from a browser.
  const chargeRes = await admin
    .from("park_charges")
    .select("id, park_id, renter_id, amount, paid_total, status, period_month")
    .eq("id", chargeId)
    .maybeSingle();
  if (chargeRes.error) return couldNotCheck("the bill", chargeRes.error);
  const charge = chargeRes.data;
  if (!charge) return { ok: false, error: "We can't find that bill." };

  const fileRes = await admin
    .from("park_renters")
    .select("id, display_name")
    .eq("id", charge.renter_id as string)
    .eq("user_id", user.id)
    .maybeSingle();
  if (fileRes.error) return couldNotCheck("whose bill this is", fileRes.error);
  const file = fileRes.data;
  if (!file) return { ok: false, error: "That isn't your bill." };

  if ((charge.status as string) === "void") {
    return { ok: false, error: "That bill was cancelled — there's nothing to record against it." };
  }

  // ---- the date, lightly ---------------------------------------------------
  // Lightly on purpose. 0074's whole posture is that demanding paperwork before
  // recording anything silences exactly the households least able to produce
  // it. The one thing worth refusing is a date that hasn't happened yet.
  const paidOn = (input.paidOn ?? "").trim();
  if (paidOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
      return { ok: false, error: "That date didn't come through — pick it again." };
    }
    if (paidOn > todayLakeDate()) {
      return { ok: false, error: "That's a date in the future. Pick the day you actually handed it over." };
    }
  }

  // ---- one open claim at a time -------------------------------------------
  // A second claim on the same bill tells the office nothing the first didn't,
  // and every open claim is a household not being chased. One is the record;
  // more than one is a way to never be asked for rent again.
  // Same fails-open shape as payRent's guard, milder consequence: a failed
  // count would let a second claim be filed on the same bill. Refusing is the
  // safe direction here too — "try again" costs a tap; a duplicated claim
  // makes the office arbitrate a disagreement the resident never had.
  const openRes = await admin
    .from("park_payment_claims")
    .select("id", { count: "exact", head: true })
    .eq("charge_id", charge.id as string)
    .is("resolved_at", null);
  if (openRes.error) return couldNotCheck("what you've already told the office", openRes.error);
  const open = openRes.count;
  if ((open ?? 0) > 0) {
    return {
      ok: false,
      error: "You've already told the office about this bill. They'll confirm once they've checked.",
    };
  }

  const owed = Math.round((Number(charge.amount ?? 0) - Number(charge.paid_total ?? 0)) * 100) / 100;

  const { error } = await admin.from("park_payment_claims").insert({
    charge_id: charge.id,
    // The balance is what they'd have handed over, and it makes the owner's
    // confirmation one button instead of a form. Null is legal here (0074) and
    // the office can still record a different figure — this is a starting
    // point for a human, never an assertion about what is owed.
    claimed_amount: owed > 0 ? owed : null,
    claimed_paid_on: paidOn || null,
    method: input.method ?? null,
    reference: input.reference?.trim() || null,
    paid_to: input.paidTo?.trim() || null,
    note: input.note?.trim() || null,
    // The assertion is theirs, and now so is the row. This is the first code
    // path where those two facts are the same person.
    asserted_by: "renter",
    logged_by: user.id,
  });
  if (error) {
    return { ok: false, error: "We couldn't record that — try again, or ring the office." };
  }

  await tellTheOffice(charge.park_id as string, {
    who: (file.display_name as string) ?? "A resident",
    month: prettyMonth(charge.period_month as string),
    amount: owed,
    paidOn,
    method: input.method ?? null,
    reference: input.reference?.trim() || "",
    paidTo: input.paidTo?.trim() || "",
    note: input.note?.trim() || "",
  });

  revalidatePath("/parks/my");
  return {
    ok: true,
    signal: "Told the office. You won't be chased on this bill until they've confirmed it.",
  };
}

/**
 * Mail every owner of the park. SMS is a dead channel until A2P clears, so
 * email carries this on its own — and a claim nobody is told about is just a
 * silence that stops the chase, which is the worst of both worlds for the
 * owner. A send that fails must NOT fail the claim: the record is the point,
 * the notification is the courtesy.
 */
async function tellTheOffice(
  parkId: string,
  c: {
    who: string; month: string; amount: number; paidOn: string;
    method: string | null; reference: string; paidTo: string; note: string;
  },
): Promise<void> {
  try {
    const admin = createServiceClient();
    const [parkRes, membersRes] = await Promise.all([
      admin.from("parks").select("name").eq("id", parkId).maybeSingle(),
      admin.from("park_members").select("user_id").eq("park_id", parkId).eq("role", "owner"),
    ]);
    // Named for the same reason the owners' addresses are, below: an unread
    // member list is empty, and an empty one returns here as though the park
    // simply had no owner to tell. Same swallow, no silence.
    if (membersRes.error) {
      console.error("[read failed, notification skipped] the park's owners:", membersRes.error);
      return;
    }
    if (parkRes.error) {
      // Degraded, not fatal: the mail goes out headed "Your park".
      console.error("[read failed, degraded] the park's name:", parkRes.error);
    }
    const park = parkRes.data;
    const members = membersRes.data;
    const ids = (members ?? []).map((m) => m.user_id as string).filter(Boolean);
    if (ids.length === 0) return;

    // Swallowed like everything else in this helper — the claim is already
    // written and a failed notification must not undo it — but NAMED, so the
    // rule "no read discards its error silently" holds everywhere in this file
    // with no exception to remember. The office finding out late is a real
    // consequence; it just isn't one worth failing the resident's claim over.
    const peopleRes = await admin.from("users").select("id, email").in("id", ids);
    if (peopleRes.error) {
      console.error("[read failed, notification skipped] the park's owners:", peopleRes.error);
      return;
    }
    const people = peopleRes.data;
    const parkName = (park?.name as string) ?? "Your park";

    const lines = [
      `${c.who} says they've already paid ${c.month}.`,
      "",
      c.amount > 0 ? `Amount on the bill:  $${c.amount.toFixed(2)}` : "",
      c.paidOn ? `They say they paid:  ${c.paidOn}` : "They didn't give a date.",
      c.method ? `How:                 ${c.method}` : "",
      c.reference ? `Reference:           ${c.reference}` : "",
      c.paidTo ? `Handed to:           ${c.paidTo}` : "",
      c.note ? `They added:          ${c.note}` : "",
      "",
      "Nothing has been credited and they are NOT being chased until you answer.",
      "Confirm it on the Rent screen if you collected it — that's what records the payment.",
    ].filter((l) => l !== "");
    const body = lines.join("\n");

    for (const p of people ?? []) {
      const addr = (p.email as string) ?? "";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) continue;
      await sendEmail({
        to: addr,
        subject: `${parkName} — ${c.who} says they've paid ${c.month}`,
        text: body,
        html: `<pre style="font:14px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap">${
          body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        }</pre>`,
      });
    }
  } catch {
    // Swallowed on purpose — see the doc comment. The claim is already written.
  }
}
