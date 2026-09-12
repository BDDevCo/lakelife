"use server";

import { revalidatePath } from "next/cache";
import { applyDueRentChangesFor } from "@/lib/rent-changes";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { longDate } from "@/lib/lake-time";
import { parseDaterange } from "@/lib/parks";
import { planReRate, type ReRatePlan, type ReRateTarget } from "./rerate-helpers";
import type { ParkResult } from "./actions";

/**
 * THE DAY-ONE RE-RATE — the write path.
 *
 * Scheduling a rent change writes a RECORD and touches nobody's rent. The
 * tenancy's `quoted_amount` moves only when the change is applied, on or after
 * its effective date, and only if notice was served in time. The database
 * enforces both of those (0061); this exists so the owner reads sentences
 * instead of constraint names.
 *
 * NOTHING HERE NOTIFIES ANYBODY. Serving notice on a rent increase is a
 * deliberate, documented act — often a letter, sometimes by hand — and the
 * owner records WHEN and HOW he did it. The software must not quietly text 19
 * households that their rent is going up 45%.
 */

const DENIED = "You don't manage that park.";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ReRatePreview {
  plan: ReRatePlan;
  noticeDays: number;
  parkId: string;
}

/** What the screen shows before he commits to anything. */
export async function previewReRate(
  parkId: string,
  lotIds: string[],
  toAmount: number,
  effectiveOn: string,
  noticeGivenOn?: string,
): Promise<{ ok: boolean; error?: string; preview?: ReRatePreview }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!Number.isFinite(toAmount) || toAmount < 0) {
    return { ok: false, error: "That new rent isn't a number." };
  }

  const admin = createServiceClient();
  // 30 IS A FALLBACK FOR "HE HASN'T SET ONE", not for "we couldn't look".
  // Quoting a 30-day notice period to a park that runs 45 is how a rent change
  // gets scheduled too early and served too late.
  const parkRes = await admin
    .from("parks").select("rent_notice_days").eq("id", parkId).maybeSingle();
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your notice period", parkRes.error) };
  }
  const noticeDays = (parkRes.data?.rent_notice_days as number) ?? 30;

  const targets = await loadTargets(admin, parkId, lotIds, effectiveOn);
  if (targets === null) {
    return {
      ok: false,
      error: readFailedMessage("your roll", "see the read above", { money: true }),
    };
  }
  const plan = planReRate({
    targets,
    toAmount,
    effectiveOn,
    noticeGivenOn: noticeGivenOn || todayLakeDate(),
    noticeDays,
  });

  return { ok: true, preview: { plan, noticeDays, parkId } };
}

/** NULL means the roll could not be read — not that nobody is on it. Every lot
 *  would otherwise come back with no tenancy and no current rent, and the plan
 *  built from that says "Nothing would change" about nineteen households.
 *
 *  WHICH ROW, when a lot carries two live agreements — which from the first
 *  renewal on is every lot whose successor has been written: the one whose
 *  dates COVER the effective date, because that is the row that will be
 *  billing when the new rent starts. Where none reaches that far, the
 *  latest-ending one, so "ends before the new rent would start" is said about
 *  the household's last agreement and not about whichever row the query
 *  happened to return last. */
async function loadTargets(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  lotIds: string[],
  effectiveOn: string,
): Promise<ReRateTarget[] | null> {
  const lotsRes = await admin
    .from("park_lots")
    .select("id, lot_number")
    .eq("park_id", parkId);
  if (lotsRes.error) {
    console.error("[read failed] your lots:", lotsRes.error);
    return null;
  }
  const wanted = new Set(lotIds);
  const scoped = (lotsRes.data ?? []).filter((l) => wanted.size === 0 || wanted.has(l.id as string));
  if (scoped.length === 0) return [];

  const staysRes = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, during, term, quoted_amount, status")
    .in("park_lot_id", scoped.map((l) => l.id as string))
    .in("status", ["approved", "active"]);
  if (staysRes.error) {
    console.error("[read failed] the tenancies on those lots:", staysRes.error);
    return null;
  }

  type Stay = NonNullable<typeof staysRes.data>[number];
  const byLot = new Map<string, { stay: Stay; range: ReturnType<typeof parseDaterange> }>();
  for (const stay of staysRes.data ?? []) {
    const range = parseDaterange(stay.during as string);
    const lotId = stay.park_lot_id as string;
    const covers = !!range && range.start <= effectiveOn && effectiveOn < range.end;
    const held = byLot.get(lotId);
    if (!held) { byLot.set(lotId, { stay, range }); continue; }
    const heldCovers = !!held.range && held.range.start <= effectiveOn && effectiveOn < held.range.end;
    if (heldCovers) continue;
    if (covers || (range?.end ?? "") > (held.range?.end ?? "")) byLot.set(lotId, { stay, range });
  }

  return scoped.map((l) => {
    const picked = byLot.get(l.id as string);
    const s = picked?.stay;
    const range = picked?.range ?? null;
    return {
      reservationId: (s?.id as string) ?? "",
      lotLabel: l.lot_number as string,
      currentAmount: s?.quoted_amount == null ? null : Number(s.quoted_amount),
      term: (s?.term as string) ?? "",
      endsOn: range?.end ?? null,
    };
  });
}

/**
 * Schedule the change. Writes one row per affected tenancy and moves NO money.
 *
 * `notice_given_on` is left NULL deliberately: he has not served anybody yet.
 * The database will refuse to apply any of these until he records that he has.
 */
export async function scheduleReRate(
  parkId: string,
  lotIds: string[],
  toAmount: number,
  effectiveOn: string,
): Promise<ParkResult & { scheduled?: number }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const pre = await previewReRate(parkId, lotIds, toAmount, effectiveOn);
  if (!pre.ok || !pre.preview) return { ok: false, error: pre.error };
  const { plan, noticeDays } = pre.preview;

  if (plan.tooSoon) {
    return {
      ok: false,
      // A date a person reads is words — "March 7, 2027", never "2027-03-07".
      error: `That's inside your ${noticeDays}-day notice period. The earliest this can start is ${longDate(plan.earliestEffective)}.`,
    };
  }
  if (plan.changing.length === 0) {
    return { ok: false, error: "Nothing would change." };
  }

  const admin = createServiceClient();
  const rows = plan.changing.map((l) => ({
    park_id: parkId,
    reservation_id: l.reservationId,
    from_amount: l.from,
    to_amount: l.to,
    effective_on: effectiveOn,
    notice_days_required: noticeDays,
  }));

  const { error } = await admin.from("lot_rent_changes").insert(rows);
  if (error) return { ok: false, error: "Couldn't schedule that — try again." };

  revalidatePath("/park");
  return {
    ok: true,
    scheduled: rows.length,
    signal:
      `${rows.length} rent ${rows.length === 1 ? "change is" : "changes are"} scheduled for ${longDate(effectiveOn)}. ` +
      `Nobody has been told yet — record your notice when it goes out.`,
  };
}

/**
 * Record that notice went out. This is the gate: until it is set, the database
 * will not let any of these take effect.
 */
export async function recordNotice(
  parkId: string,
  effectiveOn: string,
  noticeGivenOn: string,
  method: "letter" | "hand" | "posted" | "email" | "sms",
): Promise<ParkResult & { noticed?: number }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("lot_rent_changes")
    .update({ notice_given_on: noticeGivenOn, notice_method: method })
    .eq("park_id", parkId)
    .eq("effective_on", effectiveOn)
    .is("applied_at", null)
    .is("cancelled_at", null)
    .select("id");

  if (error) {
    // 23514 is the notice-period constraint: he is recording a notice date too
    // close to the effective date. That is a real answer, not a crash.
    if (error.code === "23514") {
      return {
        ok: false,
        error: "That notice date is too close to the start date. Push the start date back, or use an earlier notice date.",
      };
    }
    return { ok: false, error: "Couldn't record that — try again." };
  }

  revalidatePath("/park");
  return {
    ok: true,
    noticed: data?.length ?? 0,
    signal: `Notice recorded for ${data?.length ?? 0} ${(data?.length ?? 0) === 1 ? "tenancy" : "tenancies"}.`,
  };
}

/**
 * Apply everything that is due and properly served. Safe to run repeatedly —
 * an already-applied change is filtered out, so a double-run changes nothing.
 *
 * Called by the nightly, and available to ops. Per-row, so one failure does not
 * strand the rest.
 */
/**
 * The browser-reachable version — AUTHORIZED.
 *
 * The engine moved to `src/lib/rent-changes.ts` (server-only). This file
 * carries "use server", so every export here is a server action any browser
 * can call with an id it guessed; this one had NO membership check while every
 * sibling in the file had one, and its `parkId` was optional, so a call with no
 * argument swept every park in the system.
 *
 * A park is now REQUIRED and membership is asserted. The nightly's
 * all-parks sweep calls the engine directly and is cron-authenticated.
 */
export async function applyDueRentChanges(parkId: string): Promise<{
  applied: number; skipped: number; errors: string[];
}> {
  if (!parkId || !(await assertMyPark(parkId))) {
    return { applied: 0, skipped: 0, errors: ["not your park"] };
  }
  const res = await applyDueRentChangesFor(parkId);
  if (res.applied > 0) revalidatePath("/park");
  return res;
}

/**
 * Call it off.
 *
 * Only a change that has not been APPLIED can be called off — once the
 * nightly has moved the pinned row, the increase is history the bills rely
 * on. But "not applied" is not "has touched nothing". A renewal written while
 * the change was scheduled carries the rent in force at ITS start, so on
 * 17 March a served $425-from-1-April is already sitting on the May–August
 * row. Calling the change off on the 25th makes it not history — April bills
 * $400 — and the May row has to come back to $400 too, or the increase he
 * cancelled bills from May with nothing pending on any screen and the roll
 * reading $425 from a date nobody scheduled.
 *
 * So this mirrors the carry-down in `applyDueRentChangesFor`: every later
 * live link of the pinned row's chain still at the number the change moved
 * TO, and written AFTER the change was scheduled, goes back to the number it
 * moved FROM, and takes back the rent confirmation the successor would have
 * inherited had the change never existed. A later link at some other number
 * is one he set himself and is not ours to move — and so is one at the SAME
 * number that he typed through "Renew at a new rent" before the change ever
 * existed: matching on the number alone moved a rent he chose and then said
 * it had been "written while it was scheduled". The write time is the fact
 * that separates them: a successor at a changed rent stamps
 * `amount_source_at` when it is written, and one at an unchanged rent copies
 * its prior's, so a row stamped before the change was scheduled cannot be
 * the change's doing. Whatever moved is named in the signal.
 *
 * ORDER: the successors are moved back FIRST, then the change is cancelled.
 * If the cancel then fails the change is still pending, and the nightly's
 * carry-down puts the number back when it applies — the other order leaves a
 * cancelled change and a successor at a rent nobody scheduled, and nothing
 * self-heals.
 */
export async function cancelReRate(parkId: string, effectiveOn: string): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();

  const pendingRes = await admin
    .from("lot_rent_changes")
    .select("id, reservation_id, from_amount, to_amount, created_at")
    .eq("park_id", parkId)
    .eq("effective_on", effectiveOn)
    .is("applied_at", null)
    .is("cancelled_at", null);
  if (pendingRes.error) {
    return { ok: false, error: readFailedMessage("your scheduled rent changes", pendingRes.error) };
  }
  // A change that recorded no 'from' has nothing to match; one with no
  // scheduled-at stamp (the column is NOT NULL, so this is a read that came
  // back wrong) has no line to draw and must not move anything on a guess.
  const pending = (pendingRes.data ?? []).filter((c) => c.from_amount != null && c.created_at != null);

  // READ PHASE — where each pinned row sits in its chain, and what it would
  // have passed on. All the reads happen before any write, so a failed read
  // stops with "nothing has been changed" still true.
  const chains: Array<{ change: (typeof pending)[number]; chainId: string; seq: number; amountSource: string; amountSourceAt: string | null }> = [];
  for (const c of pending) {
    const pinnedRes = await admin
      .from("lot_reservations")
      .select("id, agreement_chain_id, agreement_seq, amount_source, amount_source_at")
      .eq("id", c.reservation_id as string)
      .maybeSingle();
    if (pinnedRes.error) {
      return { ok: false, error: readFailedMessage("the agreement that change is on", pinnedRes.error) };
    }
    const pinned = pinnedRes.data;
    if (!pinned?.agreement_chain_id) continue;
    chains.push({
      change: c,
      chainId: pinned.agreement_chain_id as string,
      seq: (pinned.agreement_seq as number) ?? 1,
      amountSource: (pinned.amount_source as string | null) ?? "owner_knowledge",
      amountSourceAt: (pinned.amount_source_at as string | null) ?? null,
    });
  }

  // WRITE PHASE, successors first.
  const movedBack: Array<{ lotId: string; start: string; from: number; to: number }> = [];
  for (const { change, chainId, seq, amountSource, amountSourceAt } of chains) {
    const { data: reverted, error: revErr } = await admin
      .from("lot_reservations")
      .update({
        quoted_amount: change.from_amount,
        // What `successorRow` would have carried at an unchanged rent: the
        // prior's own confirmation, not "owner's knowledge as of now".
        amount_source: amountSource,
        amount_source_at: amountSourceAt,
      })
      .eq("agreement_chain_id", chainId)
      .gt("agreement_seq", seq)
      .eq("quoted_amount", change.to_amount)
      // Written after the change was scheduled — see the note above. A row
      // with no stamp at all is excluded by the comparison, which is right: a
      // successor that took the change's number has one.
      .gte("amount_source_at", change.created_at as string)
      .in("status", ["approved", "active"])
      .select("id, park_lot_id, during");
    if (revErr) {
      console.error("[write failed] moving a successor back off a cancelled rent change:", revErr);
      return {
        ok: false,
        error:
          "Couldn't move an agreement written while this was scheduled back to its old rent. " +
          "The change is still scheduled — nothing was called off.",
      };
    }
    for (const r of reverted ?? []) {
      const range = parseDaterange(r.during as string);
      movedBack.push({
        lotId: r.park_lot_id as string,
        start: range?.start ?? "",
        from: Number(change.to_amount),
        to: Number(change.from_amount),
      });
    }
  }

  const { data, error } = await admin
    .from("lot_rent_changes")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("park_id", parkId)
    .eq("effective_on", effectiveOn)
    .is("applied_at", null)
    .is("cancelled_at", null)
    .select("id");
  if (error) {
    // The successors already moved back are at the old rent with the change
    // still pending: the nightly re-carries the increase when it applies, so
    // this is a true sentence and a retry can work.
    return { ok: false, error: "Couldn't call that off — it's still scheduled. Try again in a moment." };
  }

  // Lot numbers for the sentence. A failed read here changes nothing that
  // was written; it only costs the names, and saying "an agreement" is
  // better than saying nothing about a rent that just moved.
  const lotIds = [...new Set(movedBack.map((m) => m.lotId))];
  const lotsRes = lotIds.length
    ? await admin.from("park_lots").select("id, lot_number").in("id", lotIds)
    : { data: [], error: null };
  if (lotsRes.error) console.error("[read failed] lot numbers for the cancel signal:", lotsRes.error);
  const lotNumber = new Map((lotsRes.data ?? []).map((l) => [l.id as string, l.lot_number as string]));
  const name = (m: { lotId: string }) => {
    const n = lotNumber.get(m.lotId);
    return n ? `Lot ${n}'s agreement` : "An agreement";
  };

  const n = data?.length ?? 0;
  let signal = `${n} scheduled ${n === 1 ? "change" : "changes"} called off.`;
  if (n === 0 && movedBack.length > 0) {
    // Something took the change between the revert and the cancel. Two things
    // can: the nightly APPLIED it (a midnight-only window — it re-carries the
    // new rent onto the successors just moved back, so "goes back to" would
    // describe a state that lasted seconds), or a second tap CANCELLED it
    // first (the successors are at the old rent, by whichever tap got there).
    // Which one is a fact on the row, so it is read rather than guessed.
    const afterRes = await admin
      .from("lot_rent_changes")
      .select("id, applied_at, cancelled_at")
      .in("id", pending.map((c) => c.id as string));
    if (afterRes.error) console.error("[read failed] what happened to the change being called off:", afterRes.error);
    const applied = (afterRes.data ?? []).some((c) => c.applied_at != null);
    const agreements = movedBack.length === 1 ? "agreement" : "agreements";
    signal = afterRes.error
      ? `Nothing was called off here — that change was already applied or called off before this reached it. Check the rent roll for the rent it left.`
      : applied
        ? `Nothing was called off — that change had already taken effect, and the ${agreements} written under it ${movedBack.length === 1 ? "follows" : "follow"} it.`
        : `That change had already been called off. The ${agreements} written while it was scheduled ${movedBack.length === 1 ? "is" : "are"} back at the old rent.`;
  } else if (movedBack.length <= 3) {
    for (const m of movedBack) {
      signal +=
        ` ${name(m)} from ${longDate(m.start)} was written at ${money(m.from)} ` +
        `while it was scheduled and goes back to ${money(m.to)}.`;
    }
  } else {
    const lots = movedBack.map((m) => lotNumber.get(m.lotId)).filter(Boolean).join(", ");
    signal +=
      ` ${movedBack.length} agreements written while it was scheduled` +
      `${lots ? ` (Lots ${lots})` : ""} go back to their old rent.`;
  }

  revalidatePath("/park");
  return { ok: true, signal };
}

/** Everything scheduled and not yet applied, grouped for the screen. */
export interface PendingReRate {
  effectiveOn: string;
  count: number;
  toAmount: number;
  monthlyDelta: number;
  noticeGivenOn: string | null;
  noticeDaysRequired: number;
}

export async function pendingReRates(parkId: string): Promise<PendingReRate[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();
  // An empty list here means "nothing is scheduled", which on /park is read as
  // permission to forget about it.
  const data = mustRead("your scheduled rent changes", await admin
    .from("lot_rent_changes")
    .select("effective_on, to_amount, from_amount, notice_given_on, notice_days_required")
    .eq("park_id", parkId)
    .is("applied_at", null)
    .is("cancelled_at", null)
    .order("effective_on"));

  const byDate = new Map<string, PendingReRate>();
  for (const c of data ?? []) {
    const key = c.effective_on as string;
    const cur = byDate.get(key) ?? {
      effectiveOn: key,
      count: 0,
      toAmount: Number(c.to_amount),
      monthlyDelta: 0,
      noticeGivenOn: (c.notice_given_on as string) ?? null,
      noticeDaysRequired: c.notice_days_required as number,
    };
    cur.count += 1;
    cur.monthlyDelta += Number(c.to_amount) - Number(c.from_amount ?? 0);
    byDate.set(key, cur);
  }
  return [...byDate.values()];
}
