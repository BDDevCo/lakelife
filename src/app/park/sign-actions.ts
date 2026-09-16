"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage } from "@/lib/must-read";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { toDaterange, parseDaterange } from "@/lib/parks";
import { feesForTenancy } from "./fee-helpers";
import { planSigning, type SigningInput } from "./sign-helpers";
import { dayInWords } from "./park-helpers";
import { prettyMonth, money } from "./ledger-helpers";
import { addDays } from "./rerate-helpers";
import { chargeStandings, voidUnpaidChargesFor, reraiseMonth, strandedSharesSentence, type ChargeStanding } from "./charge-edits";
import type { SuccessorRow } from "@/lib/successor-row";
import type { ParkResult } from "./actions";

/**
 * RECORD THAT A HOLDOVER HOUSEHOLD SIGNED THE NEW LEASE.
 *
 * The one write path for the transition `sign-helpers.ts` describes. It is
 * three writes on two tables and they are NOT one transaction, so the order
 * and the error sentences are the whole design:
 *
 *   1. The renter file — email and phone, the condition of the lease. First,
 *      because a failure here changes nothing else and is the easiest to say.
 *   2. The holdover — trimmed to end on the signing day (or cancelled, if it
 *      never had a day). This has to come BEFORE the successor: the exclusion
 *      constraint refuses two held rows on one lot with overlapping dates, and
 *      the holdover runs a year out.
 *   3. The successor — the signed agreement. If THIS fails, the holdover is
 *      put back as it was, and the sentence says the household is still on the
 *      arrangement they had. Nothing bills differently until all three land.
 *   4. THE BILLS ALREADY RAISED on the holdover for the signing month and
 *      after. January billed on the 1st and the signing recorded on the 2nd
 *      left the $400 January bill standing on a row that now covers no day
 *      of January, and the next run raised a SECOND January bill on the
 *      successor — one household, two live January bills, $942.53. The
 *      run's "already billed" set is keyed by reservation, not household,
 *      and the database index agrees (0081: one live charge per reservation
 *      per month), so nothing else could catch it. Now, AFTER the successor
 *      lands (never before — a failed successor must not leave the month
 *      unbilled), each unpaid bill on the old arrangement is cancelled with
 *      the reason, and the month is raised again the way the run would raise
 *      it: on the trimmed holdover for the days before the lease and on the
 *      successor from its day. Said in the toast, and a failed cancel is
 *      SAID too — a bill left open under "Recorded" is the defect this step
 *      exists to end.
 *
 *      A BILL WITH MONEY ON IT IS NEVER CANCELLED HERE. Read BEFORE step 1:
 *      if any bill from the signing month on carries money — handed over,
 *      or put against it from money on account — the signing is refused
 *      with nothing written, in voidCharge's own words. Money on account
 *      has a door (take it off that bill first); money taken against the
 *      bill has none, and the sentence stops at the truth rather than
 *      inventing one — dating the lease from the month after is NOT a way
 *      out: the paper says 1 January, and what a month already paid at the
 *      old rate owes under a lease effective that month is the owner's
 *      decision, not this door's.
 *
 * Never touches `origin` in place — the 0065 cap trigger fires on UPDATE and
 * would refuse it — and never creates a second renter file: the successor
 * carries the same `renter_id`, the same chain, one link on.
 */
export async function recordSigning(
  parkId: string,
  reservationId: string,
  input: SigningInput,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: "You don't manage that park." };

  const admin = createServiceClient();

  // THE ROW THE SUCCESSOR IS COPIED FROM — its lot, its renter, its chain, and
  // the facts that travel (due day, arrival date, provenance). A failed read
  // reaching the insert would file an agreement attached to nobody, so it
  // stops and says so.
  // ONE string literal on purpose: supabase-js types a concatenated select as
  // GenericStringError and every column below stops compiling.
  const priorRes = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, renter_unit_id, during, status, origin, term, quoted_amount, agreement_chain_id, agreement_seq, due_day, tenancy_began_on, amount_source, amount_source_at, park_lots(park_id, rental_mode)")
    .eq("id", reservationId)
    .maybeSingle();
  if (priorRes.error) {
    return { ok: false, error: readFailedMessage("that tenancy", priorRes.error, { money: true }) };
  }
  const prior = priorRes.data;
  if (!prior) return { ok: false, error: "That tenancy isn't there any more." };
  const lot = prior.park_lots as unknown as { park_id: string; rental_mode: string | null } | null;
  // Re-derived from the row, never trusted from the browser.
  if (!lot || lot.park_id !== parkId) return { ok: false, error: "You don't manage that park." };

  const [parkRes, feeRes] = await Promise.all([
    admin
      .from("parks")
      .select("cutover_date, default_agreement_months, max_agreement_months")
      .eq("id", parkId)
      .maybeSingle(),
    // WHAT THE FIRST MONTH BILLS. The same filter the biller uses — active,
    // monthly, an audience the run honours — so the sentence he reads cannot
    // quote a fee that will not bill, nor miss one that will.
    admin
      .from("park_fees")
      .select("amount, cadence, applies_to")
      .eq("park_id", parkId)
      .eq("active", true),
  ]);
  // The cutover bounds the date, and the two dials are what the household's
  // chosen length is judged against (chooseAgreementLength: the lengths the
  // park offers under its cap). A failed read would write the successor on
  // the horizon against a park with a cap — the database error 0065 exists to
  // raise — or date it into the seller's months.
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park's settings", parkRes.error, { money: true }) };
  }
  if (feeRes.error) {
    return { ok: false, error: readFailedMessage("your park's fees", feeRes.error, { money: true }) };
  }
  const monthlyFees = (feeRes.data ?? [])
    .filter((f) => (f.cadence as string) === "monthly")
    .filter((f) => ["all_lots", "long_term"].includes(f.applies_to as string));
  const feePerMonth = feesForTenancy(monthlyFees, { rental_mode: lot.rental_mode }, { origin: "office" })
    .reduce((sum, f) => sum + Number(f.amount), 0);

  const plan = planSigning(
    input,
    {
      id: prior.id as string,
      park_lot_id: prior.park_lot_id as string,
      renter_id: prior.renter_id as string,
      renter_unit_id: (prior.renter_unit_id as string | null) ?? null,
      term: prior.term as string,
      quoted_amount: prior.quoted_amount == null ? null : Number(prior.quoted_amount),
      agreement_chain_id: (prior.agreement_chain_id as string | null) ?? null,
      agreement_seq: (prior.agreement_seq as number | null) ?? null,
      due_day: (prior.due_day as number | null) ?? null,
      tenancy_began_on: (prior.tenancy_began_on as string | null) ?? null,
      amount_source: (prior.amount_source as string | null) ?? null,
      amount_source_at: (prior.amount_source_at as string | null) ?? null,
      range: parseDaterange(prior.during as string),
      status: prior.status as string,
      origin: (prior.origin as string | null) ?? null,
    },
    {
      todayISO: todayLakeDate(),
      cutoverDate: (parkRes.data?.cutover_date as string | null) ?? null,
      defaultAgreementMonths: (parkRes.data?.default_agreement_months as number | null) ?? null,
      maxAgreementMonths: (parkRes.data?.max_agreement_months as number | null) ?? null,
      nowISO: new Date().toISOString(),
      feePerMonth: Math.round(feePerMonth * 100) / 100,
    },
  );
  if (!plan.ok) return { ok: false, error: plan.error };

  // ---- 0. the bills already raised on the arrangement they had -----------
  // From the signing month on. Read before anything is written: a bill with
  // money on it refuses the whole signing, in words that say which kind of
  // money and where the door for it is. A failed read refuses too — it must
  // not let a paid January through to become two January bills.
  const signedOn = input.signedOn.trim();
  const signMonth = signedOn.slice(0, 7);
  const standing = await chargeStandings(admin, parkId, [prior.id as string], signMonth);
  if ("error" in standing) {
    return { ok: false, error: readFailedMessage(standing.what, standing.error, { money: true }) };
  }
  const priorBills = standing.charges;
  const withMoney = priorBills.filter((c) => c.money !== "none").sort((a, b) => a.month.localeCompare(b.month));
  if (withMoney.length > 0) {
    return { ok: false, error: paidBillRefusal(withMoney) };
  }

  // ---- 1. the renter file ----------------------------------------------
  const { error: renterErr } = await admin
    .from("park_renters")
    .update(plan.renter)
    .eq("id", prior.renter_id as string);
  if (renterErr) {
    return {
      ok: false,
      error: "Couldn't save their email and phone, so nothing was recorded — they're still on the arrangement they had.",
    };
  }

  // ---- 2. the holdover ----------------------------------------------------
  const originalDuring = prior.during as string;
  const originalStatus = prior.status as string;
  const holdoverPatch = "cancel" in plan.holdover
    ? { status: "cancelled" }
    : { during: toDaterange(plan.holdover.trimTo) };
  const { data: held, error: holdErr } = await admin
    .from("lot_reservations")
    .update(holdoverPatch)
    .eq("id", prior.id as string)
    .in("status", ["approved", "active"])   // one recorder wins a double-tap
    .select("id");
  if (holdErr) {
    return {
      ok: false,
      error:
        "Their email and phone are saved, but the new agreement couldn't be written — " +
        "they're still on the arrangement they had, and nothing bills differently.",
    };
  }
  if (!held?.length) return { ok: false, error: "Somebody just changed that one — refresh to see what happened." };

  // ---- 3. the successor ---------------------------------------------------
  // Typed as the successor row on purpose: `origin` is a required key of it,
  // so this door cannot file by the column default (every-stay-names-its-
  // origin.test.ts checks both halves of that).
  const successor: SuccessorRow = plan.successor;
  const { data: inserted, error: insErr } = await admin
    .from("lot_reservations")
    .insert(successor)
    .select("id")
    .single();
  if (insErr) {
    // PUT THE HOLDOVER BACK. Without this the household has been trimmed off
    // the lot on the signing day with nothing following — the lot reads
    // vacant, the charge run skips them, and the screen has reported a
    // failure that looks like nothing happened.
    const restore = "cancel" in plan.holdover
      ? { status: originalStatus }
      : { during: originalDuring };
    const { error: restoreErr } = await admin
      .from("lot_reservations")
      .update(restore)
      .eq("id", prior.id as string);
    if (restoreErr) {
      return {
        ok: false,
        error:
          "The new agreement couldn't be written, and their old arrangement couldn't be put back either — " +
          "so right now nothing holds their lot. That's ours to fix — get in touch and we'll sort it.",
      };
    }
    return {
      ok: false,
      error:
        "The new agreement couldn't be written, so their old arrangement was put back as it was. " +
        (insErr.code === "23P01"
          ? "Something else already holds that lot from that day — check the roll."
          : "Their email and phone are saved; nothing bills differently."),
    };
  }

  // ---- 4. the bills already raised on the arrangement they had -----------
  // Only now, with the successor standing. Each unpaid bill from the signing
  // month on is cancelled with the reason and the month raised again as the
  // run would raise it — the trimmed holdover's days before the lease, then
  // the successor from its day — and settled from money on account (R1).
  const tail: string[] = [];
  if (priorBills.length > 0) {
    const successorId = (inserted?.id as string | undefined) ?? null;
    const voided = await voidUnpaidChargesFor(
      admin, [prior.id as string], signMonth, `Replaced by the new lease from ${dayInWords(signedOn)}`,
    );
    if ("error" in voided) {
      tail.push(
        `⚠️ We couldn't read ${voided.what}, so the bills on the old arrangement still stand — ` +
        `cancel them from the rent screen before billing ${prettyMonth(signMonth)} again.`,
      );
    } else {
      // COST SHARES A VOID RELEASED (0104) stay keyed to the holdover. The
      // holdover's own re-raise takes them up again; a holdover that is
      // cancelled, or covers no day of the month, never bills again and
      // the shares are stranded — said, never silent.
      let holdoverStamped = 0;
      for (const v of [...voided.voided].sort((a, b) => a.month.localeCompare(b.month))) {
        const parts: string[] = [];
        const problems: string[] = [];
        let onAccount = 0;
        // The days before the lease, on the trimmed holdover — a lease from
        // the 15th keeps the 1st to the 14th on the arrangement they had.
        if (!("cancel" in plan.holdover)) {
          const h = await reraiseMonth(admin, parkId, prior.id as string, v.month);
          if ("error" in h) problems.push(`the old arrangement's days couldn't be billed again (${h.what})`);
          else if (h.raised) {
            parts.push(`${money(h.raised.amount)} to ${dayInWords(addDays(signedOn, -1))} on the arrangement they had`);
            onAccount += h.raised ? h.fromOnAccount : 0;
            holdoverStamped += h.sharesStamped;
            if (h.settleProblem) problems.push(h.settleProblem);
          }
        }
        if (successorId) {
          const n = await reraiseMonth(admin, parkId, successorId, v.month);
          if ("error" in n) problems.push(`the new lease couldn't be billed for it (${n.what})`);
          else if (n.raised) {
            parts.push(parts.length ? `${money(n.raised.amount)} on the new lease` : money(n.raised.amount));
            onAccount += n.fromOnAccount;
            if (n.settleProblem) problems.push(n.settleProblem);
          }
        }
        const label = `${prettyMonth(v.month)}'s ${money(v.amount)} bill on the old arrangement is cancelled`;
        if (parts.length === 0) {
          tail.push(
            `${label}, but ${prettyMonth(v.month)} couldn't be billed again on the new lease` +
            (problems.length ? ` — ${problems.join("; ")}` : "") +
            ` — bill ${prettyMonth(v.month)} from the rent screen.`,
          );
        } else {
          tail.push(
            `${label}; ${prettyMonth(v.month)} now bills ${parts.join(" and ")}` +
            (onAccount > 0 ? `, ${money(onAccount)} of it settled from money on account` : "") +
            "." +
            (problems.length ? ` ⚠️ ${problems.join("; ")}.` : ""),
          );
        }
      }
      for (const f of voided.failed) {
        tail.push(
          `⚠️ ${prettyMonth(f.month)}'s ${money(f.amount)} bill on the old arrangement is still open — ` +
          `cancel it from the rent screen, then bill ${prettyMonth(f.month)} again.`,
        );
      }
      for (const k of voided.skipped) {
        // Money landed on it between the read above and the void — a race,
        // not the ordinary path. The bill stands and the sentence says so.
        tail.push(
          `⚠️ ${prettyMonth(k.month)}'s ${money(k.amount)} bill on the old arrangement still stands — ` +
          `${money(k.paidTotal)} was recorded against it just now; sort that out from the rent screen.`,
        );
      }
      const stranded = strandedSharesSentence(voided.sharesReleased, holdoverStamped, "the arrangement they had");
      if (stranded) tail.push(`⚠️ ${stranded}`);
    }
  }

  revalidatePath("/park");
  revalidatePath("/park/today");
  revalidatePath("/park/rent");
  // The fees screen — "this won't be charged to the N households you
  // inherited" — is rendered at /park/costs. There is no /park/fees route;
  // revalidating one left that count cached with the old number.
  revalidatePath("/park/costs");
  return { ok: true, signal: [plan.signal, ...tail].join(" ") };
}

/**
 * WHY A SIGNING IS REFUSED WHEN A BILL ON THE OLD ARRANGEMENT HAS MONEY ON
 * IT — voidCharge's own sentences for the two kinds of money. Money on
 * account names its door (take it off that bill, then record the signing);
 * money taken against the bill has no door in the ledger — a reversal is
 * for a bounced cheque, un-apply is for money on account — so the sentence
 * says which month, which money, and that it needs sorting out before the
 * lease is dated into that month. It used to offer 'or record the new lease
 * from <the month after>': a way out the paper does not carry (every new
 * lease runs from 1 January) and a decision — what a month already paid at
 * the old rate owes under a lease effective that month — that is the
 * owner's to make. Nothing is written when this is returned.
 */
function paidBillRefusal(withMoney: readonly ChargeStanding[]): string {
  const first = withMoney[0];
  const month = prettyMonth(first.month);
  const allocated = first.allocations.reduce((s, a) => s + Math.round(a.amount * 100), 0) / 100;
  const more = withMoney.length > 1 ? ` (and ${withMoney.length - 1} more ${withMoney.length === 2 ? "bill" : "bills"} after it)` : "";
  if (first.money === "on_account" && allocated > 0) {
    return (
      `${money(allocated)} of ${month}'s bill on the arrangement they had${more} was settled from money on account ` +
      `(under "Money not against a bill", "Take it off this bill" on the ${month} line). Take that off it first, then record the signing.`
    );
  }
  const taken = first.direct > 0 ? first.direct : first.paidTotal;
  return (
    `You've already taken ${money(taken)} against ${month}'s bill on the arrangement they had${more} — ` +
    `cancelling it would make that money disappear from your totals while it's still in the bank. ` +
    `Nothing was recorded; ${month} needs sorting out before the new lease is dated into it.`
  );
}
