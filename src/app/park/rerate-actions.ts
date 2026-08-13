"use server";

import { revalidatePath } from "next/cache";
import { applyDueRentChangesFor } from "@/lib/rent-changes";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
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
  const { data: park } = await admin
    .from("parks").select("rent_notice_days").eq("id", parkId).maybeSingle();
  const noticeDays = (park?.rent_notice_days as number) ?? 30;

  const targets = await loadTargets(admin, parkId, lotIds);
  const plan = planReRate({
    targets,
    toAmount,
    effectiveOn,
    noticeGivenOn: noticeGivenOn || todayLakeDate(),
    noticeDays,
  });

  return { ok: true, preview: { plan, noticeDays, parkId } };
}

async function loadTargets(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  lotIds: string[],
): Promise<ReRateTarget[]> {
  const { data: lots } = await admin
    .from("park_lots")
    .select("id, lot_number")
    .eq("park_id", parkId);
  const wanted = new Set(lotIds);
  const scoped = (lots ?? []).filter((l) => wanted.size === 0 || wanted.has(l.id as string));
  if (scoped.length === 0) return [];

  const { data: stays } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, during, term, quoted_amount, status")
    .in("park_lot_id", scoped.map((l) => l.id as string))
    .in("status", ["approved", "active"]);

  const byLot = new Map((stays ?? []).map((s) => [s.park_lot_id as string, s]));

  return scoped.map((l) => {
    const s = byLot.get(l.id as string);
    const range = s ? parseDaterange(s.during as string) : null;
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
      error: `That's inside your ${noticeDays}-day notice period. The earliest this can start is ${plan.earliestEffective}.`,
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
      `${rows.length} rent ${rows.length === 1 ? "change is" : "changes are"} scheduled for ${effectiveOn}. ` +
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

/** Call it off. Only while it has not taken effect. */
export async function cancelReRate(parkId: string, effectiveOn: string): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("lot_rent_changes")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("park_id", parkId)
    .eq("effective_on", effectiveOn)
    .is("applied_at", null)
    .is("cancelled_at", null)
    .select("id");
  if (error) return { ok: false, error: "Couldn't cancel that — try again." };

  revalidatePath("/park");
  return {
    ok: true,
    signal: `${data?.length ?? 0} scheduled ${(data?.length ?? 0) === 1 ? "change" : "changes"} called off.`,
  };
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
  const { data } = await admin
    .from("lot_rent_changes")
    .select("effective_on, to_amount, from_amount, notice_given_on, notice_days_required")
    .eq("park_id", parkId)
    .is("applied_at", null)
    .is("cancelled_at", null)
    .order("effective_on");

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
