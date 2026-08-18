"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange, toDaterange, effectiveSeason } from "@/lib/parks";
import {
  planRenewal, renewalRefusalText, chainNotice,
  type PlannedRenewal, type AgreementTerms,
} from "./agreement-helpers";
import type { ParkResult } from "./actions";
import { mustRead, ReadFailed, readFailedMessage } from "@/lib/must-read";

/**
 * WRITING THE NEXT AGREEMENT — from the owner's side.
 *
 * This is the recurring workload at a park with a three-month cap: nineteen
 * households renewing four times a year is roughly seventy-six agreements
 * annually, and until now there was NO WAY TO DO ONE from the owner's screens.
 * `planRenewal` had no caller at all, and the only path that existed was the
 * renter's own `/x/{token}` link — which needs a token minted by an SMS
 * reminder, and SMS is switched off pending carrier registration.
 *
 * So the Today screen said "write the next one, or their rent stops being
 * billed" and pointed at a screen that could not write it.
 *
 * WHY THE STAKES ARE HIGHER THAN A MISSING BUTTON: when a tenancy lapses,
 * `buildStatement` returns zero days, the charge run drops the row, and the
 * rent simply stops being billed. No error, no empty state, no warning. The
 * household stays on the lot and the money quietly stops.
 *
 * The renewal itself is INSERTED, never edited in place. Last term's dates and
 * its rent are what the ledger already billed against, and rewriting them would
 * silently restate history.
 */

const DENIED = "You don't manage that park.";

export interface RenewalPreview {
  reservationId: string;
  lotNumber: string;
  renterName: string | null;
  priorStart: string;
  priorEnd: string;
  quotedAmount: number | null;
  plan: PlannedRenewal;
  refusalText: string | null;
  /** Said out loud past a year of consecutive short agreements. */
  chainNote: string | null;
}

async function loadTerms(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  lotId: string,
  startISO: string,
): Promise<AgreementTerms> {
  const [parkRes, lotRes] = await Promise.all([
    admin.from("parks")
      .select("max_agreement_months, deposit_amount, season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", parkId).maybeSingle(),
    admin.from("park_lots")
      .select("season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", lotId).maybeSingle(),
  ]);

  // A FAILED READ IS NOT AN ABSENT SETTING, and here that distinction writes
  // itself into an agreement. A null park makes `maxAgreementMonths` null,
  // which planRenewal reads as "this park doesn't write fixed-length
  // agreements" and refuses — telling the owner a fact about his own park that
  // we did not have. A null LOT is worse, because it does not refuse: the lot's
  // own earlier season close silently disappears, effectiveSeason falls back to
  // the park's, and the agreement is written running past the morning the slip
  // comes out of the water. The clamp exists precisely to stop that, and a
  // dropped read must not be able to lift it.
  const park = mustRead("your park's agreement terms", parkRes);
  const lot = mustRead("that lot's season", lotRes);

  // A lot may close before its park does — a slip comes out of the water while
  // the pads stay open. effectiveSeason takes the LOT's season only when all
  // four of its dates are set, which is the all-or-nothing rule 0063 enforces.
  const season = effectiveSeason(
    {
      openMonth: (lot?.season_open_month as number) ?? null,
      openDay: (lot?.season_open_day as number) ?? null,
      closeMonth: (lot?.season_close_month as number) ?? null,
      closeDay: (lot?.season_close_day as number) ?? null,
    },
    {
      openMonth: (park?.season_open_month as number) ?? null,
      openDay: (park?.season_open_day as number) ?? null,
      closeMonth: (park?.season_close_month as number) ?? null,
      closeDay: (park?.season_close_day as number) ?? null,
    },
  );

  const year = Number(startISO.slice(0, 4));
  const seasonEnd = season.closeMonth && season.closeDay
    ? `${year}-${String(season.closeMonth).padStart(2, "0")}-${String(season.closeDay).padStart(2, "0")}`
    : null;

  return {
    maxAgreementMonths: (park?.max_agreement_months as number) ?? null,
    depositAmount: park?.deposit_amount == null ? null : Number(park.deposit_amount),
    seasonEnd,
  };
}

type PreviewResult = { ok: boolean; error?: string; preview?: RenewalPreview };

/**
 * What the next agreement WOULD be. Nothing is written.
 *
 * THROWS `ReadFailed` rather than reporting a missing tenancy. Two callers want
 * two different things from that: the exported action below turns it into a
 * sentence for the button that is awaiting one, and `renewalsDue` lets it go up
 * to the page boundary, because a household quietly dropped out of the "write
 * the next one" list is the failure this whole file exists to prevent.
 */
async function planNextAgreement(
  parkId: string,
  reservationId: string,
  startFrom?: string,
): Promise<PreviewResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  // "That tenancy isn't here." and "You don't manage that park." are both
  // statements of fact, and a dropped read has no facts to state. The first
  // sends the owner hunting for a row sitting in front of him; the second tells
  // him something false about his own access.
  const res = mustRead("that tenancy", await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, quoted_amount, term, agreement_chain_id, agreement_seq, status")
    .eq("id", reservationId)
    .maybeSingle());
  if (!res) return { ok: false, error: "That tenancy isn't here." };

  const lot = mustRead("that lot", await admin
    .from("park_lots").select("id, lot_number, park_id")
    .eq("id", res.park_lot_id as string).maybeSingle());
  if (!lot || lot.park_id !== parkId) return { ok: false, error: DENIED };

  const range = parseDaterange(res.during as string);
  if (!range) return { ok: false, error: "That tenancy has no dates to renew from." };

  const today = todayLakeDate();
  const terms = await loadTerms(admin, parkId, lot.id as string, startFrom ?? range.end);

  const plan = planRenewal(
    {
      id: res.id as string,
      chainId: (res.agreement_chain_id as string) ?? res.id as string,
      seq: (res.agreement_seq as number) ?? 1,
      start: range.start,
      end: range.end,
      quotedAmount: res.quoted_amount == null ? null : Number(res.quoted_amount),
      term: (res.term as string) ?? "monthly",
    },
    terms,
    today,
    startFrom,
  );

  const renter = res.renter_id
    ? mustRead("the name on that tenancy", await admin
        .from("park_renters").select("display_name")
        .eq("id", res.renter_id as string).maybeSingle())
    : null;

  return {
    ok: true,
    preview: {
      reservationId: res.id as string,
      lotNumber: (lot.lot_number as string) ?? "?",
      renterName: (renter?.display_name as string) ?? null,
      priorStart: range.start,
      priorEnd: range.end,
      quotedAmount: res.quoted_amount == null ? null : Number(res.quoted_amount),
      plan,
      refusalText: plan.refusal ? renewalRefusalText(plan.refusal) : null,
      chainNote: plan.totalMonthsAfter ? chainNotice(plan.totalMonthsAfter) : null,
    },
  };
}

/**
 * The same thing, in the shape a button can read.
 *
 * A rejected promise inside a transition surfaces as a blank failure with no
 * sentence attached, so this catches and answers in its own result shape.
 */
export async function previewRenewal(
  parkId: string,
  reservationId: string,
  startFrom?: string,
): Promise<PreviewResult> {
  try {
    return await planNextAgreement(parkId, reservationId, startFrom);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("that tenancy", e) };
  }
}

/**
 * Write it.
 *
 * `newRent` is optional — a renewal at the same rent is the common case, and
 * demanding a number every time is how a three-month cycle becomes a chore.
 */
export async function renewAgreement(
  parkId: string,
  reservationId: string,
  opts: { startFrom?: string; newRent?: string } = {},
): Promise<ParkResult & { newEnd?: string }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const pre = await previewRenewal(parkId, reservationId, opts.startFrom);
  if (!pre.ok || !pre.preview) return { ok: false, error: pre.error ?? "Couldn't work that out." };
  const { plan, lotNumber } = pre.preview;
  if (!plan.ok || !plan.start || !plan.end) {
    return { ok: false, error: pre.preview.refusalText ?? "Can't renew that one." };
  }

  let quoted = pre.preview.quotedAmount;
  const raw = (opts.newRent ?? "").trim();
  if (raw) {
    const n = Number(raw.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "That rent isn't a dollar amount." };
    if (n > 100_000) return { ok: false, error: "That rent looks like a typo." };
    quoted = Math.round(n * 100) / 100;
  }

  const admin = createServiceClient();
  const priorRes = await admin
    .from("lot_reservations")
    .select("park_lot_id, renter_id, renter_unit_id, term, agreement_chain_id, origin")
    .eq("id", reservationId).maybeSingle();
  // This is the row the successor is copied FROM — its lot, its renter, its
  // chain. A failed read here reaching the insert below would write an
  // agreement attached to nobody, so it stops, and it says so rather than
  // claiming the tenancy is gone.
  if (priorRes.error) {
    return { ok: false, error: readFailedMessage("that tenancy", priorRes.error, { money: true }) };
  }
  const prior = priorRes.data;
  if (!prior) return { ok: false, error: "That tenancy isn't here." };

  // A SUCCESSOR ROW, never an edit. Last term's dates and rent are what the
  // ledger already billed against; rewriting them would restate history.
  const { error } = await admin.from("lot_reservations").insert({
    park_lot_id: prior.park_lot_id,
    renter_id: prior.renter_id,
    renter_unit_id: prior.renter_unit_id,
    during: toDaterange({ start: plan.start, end: plan.end }),
    status: "approved",
    term: prior.term,
    quoted_amount: quoted,
    origin: prior.origin ?? "application",
    agreement_chain_id: plan.continuesChain
      ? (prior.agreement_chain_id as string) ?? reservationId
      : null,
    agreement_seq: plan.nextSeq ?? 1,
    // The owner's own rule, and the database refuses a deposit on a
    // consecutive renewal regardless — so the two cannot drift apart.
    deposit_amount: plan.depositDue ? plan.depositAmount : null,
  });
  if (error) {
    return {
      ok: false,
      error:
        "Couldn't write that one — check the dates don't overlap another " +
        "tenancy on the same lot.",
    };
  }

  revalidatePath("/park");
  revalidatePath("/park/today");
  revalidatePath("/park/rent");
  return {
    ok: true,
    newEnd: plan.end,
    signal: plan.depositDue
      ? `Lot ${lotNumber} runs to ${plan.end}. This one starts a new chain, so a deposit is due.`
      : `Lot ${lotNumber} runs to ${plan.end}. Consecutive — no new deposit.`,
  };
}

/**
 * Everything ending soon, so a whole cycle can be worked in one sitting.
 *
 * THROWS `ReadFailed`. Its one caller is `/park/today`, a server component
 * under the root error boundary, and that is deliberate: the caller renders
 * `rows ?? []`, and `ParkRenewals` renders NOTHING for an empty list. So a
 * dropped read used to remove the entire "Agreements to write" section from the
 * owner's morning screen without a mark — which is indistinguishable from a
 * quiet quarter, and ends with a tenancy lapsing and the rent stopping.
 */
export async function renewalsDue(
  parkId: string,
  withinDays = 45,
): Promise<{ ok: boolean; rows?: RenewalPreview[] }> {
  if (!(await assertMyPark(parkId))) return { ok: false };

  const admin = createServiceClient();
  const today = todayLakeDate();

  const lots = mustRead("your lots", await admin
    .from("park_lots").select("id").eq("park_id", parkId).eq("lifecycle", "live"));
  const ids = (lots ?? []).map((l) => l.id as string);
  if (!ids.length) return { ok: true, rows: [] };

  // The maxSeq map below decides which agreements ALREADY have a successor
  // written. Built from a failed read it would be empty, and every chain would
  // look unrenewed — so this read has to answer or stop.
  const stays = mustRead("who is on your lots", await admin
    .from("lot_reservations")
    .select("id, park_lot_id, during, agreement_chain_id, agreement_seq")
    .in("park_lot_id", ids)
    .in("status", ["approved", "active"]));

  // A chain with a later link already has its next agreement written.
  const maxSeq = new Map<string, number>();
  for (const s of stays ?? []) {
    const cid = (s.agreement_chain_id as string) ?? null;
    if (!cid) continue;
    maxSeq.set(cid, Math.max(maxSeq.get(cid) ?? 0, (s.agreement_seq as number) ?? 1));
  }

  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) + withinDays * 86_400_000)
    .toISOString().slice(0, 10);

  const due = (stays ?? []).filter((s) => {
    const r = parseDaterange(s.during as string);
    if (!r || r.end > cutoff) return false;
    const cid = (s.agreement_chain_id as string) ?? null;
    const seq = (s.agreement_seq as number) ?? 1;
    return !(cid && (maxSeq.get(cid) ?? 0) > seq);
  });

  const rows: RenewalPreview[] = [];
  for (const s of due) {
    // The THROWING core, not the button-shaped wrapper. `if (p.ok)` would drop
    // a household whose read failed straight out of the list, silently, which
    // is the one outcome this list exists to make impossible.
    const p = await planNextAgreement(parkId, s.id as string);
    if (p.ok && p.preview) rows.push(p.preview);
  }
  rows.sort((a, b) => a.priorEnd.localeCompare(b.priorEnd));
  return { ok: true, rows };
}
