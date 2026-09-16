/**
 * THE DOOR THAT WRITES A ROW INTO THE PAST BILLS THE MONTHS IT MADE BILLABLE.
 *
 * Decision 3 (owner, 16 Sep): a household that stays past a lapsed
 * agreement is billed for the gap — "it's billed at the new rent, if there
 * is any". Two doors write a successor from a lapsed agreement's own end
 * (the owner's Renew button and the roll's "They signed the new lease"), so
 * the row starts in the past and covers months the run has already visited.
 * The run keys "already billed" per reservation and visits a month once,
 * when he presses Bill <month> — so nothing would ever raise those months
 * on the new row. The door used to say so ("which nothing has billed yet")
 * and leave them to a Bill button nobody would press for one household.
 *
 * Now the door bills them here, through the one re-raise the signing door
 * already used for a month billed twice (charge-edits reraiseMonth): the
 * same statement, the same classification, the same row shape, the same
 * settlement from money on account. Oldest month first, because money on
 * account settles the oldest open bill first. Each month is independent — a
 * failed read on February does not stop March — and nothing here throws:
 * the outcome says what landed and what did not, and the toast says it.
 *
 * WHICH MONTHS is agreement-helpers' `lostMonths`; whether the current
 * month's run has happened is `parkRanMonth` below. A plain module, NOT
 * "use server": every function takes the admin client and is called from
 * inside an action that has already asserted the park.
 */

import type { createServiceClient } from "@/lib/supabase/server";
import { reraiseMonth, type ReadProblem } from "./charge-edits";
import { money, prettyMonth, monthList, onAccountClause, notMonthlySentence, type SkipWhy } from "./ledger-helpers";

type Admin = ReturnType<typeof createServiceClient>;

/**
 * HAS THIS MONTH'S RUN HAPPENED AT THIS PARK — any live bill for the month,
 * on any lot. The run raises every lot's bill in one press, so one standing
 * bill for the month means the press happened and no run is coming back for
 * a row written since. A voided bill is not a run (the run's own "already
 * billed" set skips voids too). A failed read is returned as the problem it
 * is: read as "no", the current month would be left to a run that already
 * happened; read as "yes", a month the run has not reached would be billed
 * here and again by the run.
 */
export async function parkRanMonth(
  admin: Admin,
  parkId: string,
  month: string,
): Promise<boolean | ReadProblem> {
  const res = await admin
    .from("park_charges")
    .select("id")
    .eq("park_id", parkId)
    .eq("period_month", month)
    .neq("status", "void")
    .limit(1);
  if (res.error) return { error: res.error, what: "the bills already raised this month" };
  return (res.data ?? []).length > 0;
}

export interface LostMonthsOutcome {
  /**
   * Each bill that landed, oldest first, with what money on account came off
   * it — and what the same settlement put against OLDER open bills first
   * (R1 is oldest-open-bill-first: the money the re-raise found may have
   * paid off January before it touched this row's February). Carried from
   * the re-raise, never total minus fromOnAccount, so the sentence can say
   * where the whole movement went; it used to name this bill's share alone.
   */
  raised: {
    month: string;
    amount: number;
    fromOnAccount: number;
    toOlderBills: { periodMonth: string; amount: number }[];
    settleProblem: string | null;
  }[];
  /**
   * Each month that could not be billed, with the reason in the owner's
   * words. `why` is the run's own classification (null for a failed read),
   * so a caller that knows a month is not this row's — a trimmed holdover
   * that covers no day of it — can leave that one unsaid.
   */
  problems: { month: string; reason: string; why: SkipWhy | null }[];
}

/**
 * HOW THE ROW IS PAID, AND WHICH LOT — for the one refusal whose sentence
 * needs them. Read once per call, only when a month comes back notMonthly;
 * the re-raise reads the row itself but hands back the classification alone.
 * A failed read is returned as the problem it is, never as "monthly".
 */
async function howPaid(
  admin: Admin,
  reservationId: string,
): Promise<{ lotNumber: string; term: string } | ReadProblem> {
  const res = await admin
    .from("lot_reservations")
    .select("term, park_lots(lot_number)")
    .eq("id", reservationId)
    .maybeSingle();
  if (res.error) return { error: res.error, what: "how that lot is paid" };
  const row = res.data as { term?: unknown; park_lots?: { lot_number?: unknown } | { lot_number?: unknown }[] | null } | null;
  if (!row) return { error: new Error("row not found"), what: "how that lot is paid" };
  const lot = Array.isArray(row.park_lots) ? row.park_lots[0] : row.park_lots;
  return { lotNumber: String(lot?.lot_number ?? "?"), term: String(row.term ?? "monthly") };
}

/**
 * BILL THE MONTHS A NEW ROW HAS ALREADY MISSED, oldest first, on one
 * reservation. A month the run (or the signing door's own re-raise) already
 * raised comes back 'already' and is silent — it is billed, which is the
 * point. A rent nobody set is said with the door that sets it. A row filed
 * as paid some other way than monthly is said in the run's own words —
 * ledger-helpers' one spelling, which names Edit on the roll for a yearly
 * row and NO door for a nightly one (it is priced per stay; telling him to
 * make it monthly would be the wrong instruction). "Bill it from the rent
 * screen" was said for both, and the rent screen's Bill button refuses the
 * same row for the same reason. Never throws.
 */
export async function billLostMonths(
  admin: Admin,
  parkId: string,
  reservationId: string,
  months: readonly string[],
): Promise<LostMonthsOutcome> {
  const out: LostMonthsOutcome = { raised: [], problems: [] };
  let paid: Awaited<ReturnType<typeof howPaid>> | null = null;
  for (const month of [...months].sort()) {
    const r = await reraiseMonth(admin, parkId, reservationId, month);
    if ("error" in r) {
      console.error(`[billLostMonths] couldn't read ${r.what} for ${month}:`, r.error);
      out.problems.push({ month, reason: `we couldn't read ${r.what}; bill it from the rent screen`, why: null });
      continue;
    }
    if (r.raised) {
      out.raised.push({
        month,
        amount: r.raised.amount,
        fromOnAccount: r.fromOnAccount,
        toOlderBills: r.toOlderBills.map((o) => ({ periodMonth: o.periodMonth, amount: o.amount })),
        settleProblem: r.settleProblem,
      });
      continue;
    }
    if (r.why === "already") continue;
    let reason: string;
    if (r.why === "noRent") {
      // The run classifies the same row noRent and the rent screen lists it
      // under "no rent set" — so the rent screen's Bill button would refuse
      // it too. The door that fixes it is the roll's rent box.
      reason = "no rent is set for the lot — set their rent on the roll, then bill it from the rent screen";
    } else if (r.why === "notMonthly") {
      paid ??= await howPaid(admin, reservationId);
      if ("error" in paid) {
        console.error(`[billLostMonths] couldn't read ${paid.what} for ${month}:`, paid.error);
        reason = "the run wouldn't raise it, and we couldn't read how that lot is paid to say why; the rent screen for that month says why";
      } else {
        // The run's sentence ends the line; the toast's own full stop follows.
        reason = notMonthlySentence([paid]).replace(/\.$/, "");
      }
    } else {
      reason = "the run wouldn't raise it; bill it from the rent screen";
    }
    out.problems.push({ month, why: r.why, reason });
  }
  return out;
}

/** "$450.00 and $450.00", "$450.00, $450.00 and $425.00" — figures the way a person lists them. */
function amountList(amounts: readonly number[]): string {
  const words = amounts.map(money);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * WHAT LANDED, IN WORDS — "February 2027 and March 2027 are now billed —
 * $450.00 and $450.00 ($900.00 in all), $300.00 of it settled from money on
 * account. ⚠️ April 2027 couldn't be billed — no rent is set for the lot —
 * set their rent on the roll, then bill it from the rent screen." Empty when
 * nothing landed and nothing failed, so a caller can print nothing. Every
 * problem line ends at a door the screen has, or at the run's own sentence
 * for a row it refuses. Months in words, never ISO.
 *
 * WHERE THE MONEY ON ACCOUNT WENT is ledger-helpers' onAccountClause — the
 * ONE clause the run's preview and its signal print, so this door cannot
 * differ from them in shape. With nothing older it is the short form above;
 * when the settlement reached an older open bill first (R1) it names the
 * whole movement and every month: "; $700.00 of money on account went
 * against January 2027 and February 2027". A hand-rolled clause here named
 * this row's share alone, so a tap that moved $700 said $157.47.
 *
 * The clause takes ONE raised month. Money on account is fixed during the
 * loop, so an older bill can only be reached by the first month that took
 * money — and relative to the LAST month that took money, every bill the
 * tap settled before it is an older bill. So the earlier months that took
 * money ride in the older list, and the last is the month named; the total
 * and the month list come out the same as the run's would.
 */
export function lostMonthsWords(o: LostMonthsOutcome): string {
  const parts: string[] = [];
  if (o.raised.length > 0) {
    const months = o.raised.map((r) => r.month);
    const total = o.raised.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
    let line =
      `${monthList(months)} ${months.length === 1 ? "is" : "are"} now billed — ` +
      `${amountList(o.raised.map((r) => r.amount))}${months.length > 1 ? ` (${money(total)} in all)` : ""}`;
    const older = o.raised.flatMap((r) => r.toOlderBills).filter((b) => Math.round(b.amount * 100) > 0);
    const took = o.raised.filter((r) => Math.round(r.fromOnAccount * 100) > 0);
    const last = took[took.length - 1];
    const tense = { preview: "settled from money on account", older: "went" };
    const clause = older.length === 0
      // Nothing older: the short form, the whole of what came off these bills.
      ? onAccountClause(took.reduce((s, r) => s + Math.round(r.fromOnAccount * 100), 0) / 100, [], last?.month ?? "", tense)
      // Older bills reached: the earlier raised months that took money are
      // older than the last one, and ride with them.
      : onAccountClause(
          last?.fromOnAccount ?? 0,
          [...older, ...took.slice(0, -1).map((r) => ({ periodMonth: r.month, amount: r.fromOnAccount }))],
          last?.month ?? "",
          tense,
        );
    line += `${clause}.`;
    for (const r of o.raised) {
      if (r.settleProblem) line += ` ⚠️ ${prettyMonth(r.month)}: ${r.settleProblem}.`;
    }
    parts.push(line);
  }
  for (const p of o.problems) {
    parts.push(`⚠️ ${prettyMonth(p.month)} couldn't be billed — ${p.reason}.`);
  }
  return parts.join(" ");
}
