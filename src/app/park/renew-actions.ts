"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { longDate } from "@/lib/lake-time";
import { parseDaterange, effectiveSeason } from "@/lib/parks";
import {
  planRenewal, renewalRefusalText, chainNotice, monthsBetween,
  type PlannedRenewal, type AgreementTerms,
} from "./agreement-helpers";
import { rentForPeriod } from "./rerate-helpers";
import { servedRentHistory } from "@/lib/rent-changes";
import { successorRow, type PriorLink } from "@/lib/successor-row";
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
 *
 * THE ROW IS BUILT BY `successorRow`, shared with the resident's own extend
 * link, so the two doors cannot disagree about what travels: the household's
 * due day, their move-in date, whether the rent was confirmed with them. And
 * THE RENT IS THE ONE IN FORCE ON THE SUCCESSOR'S FIRST MORNING, resolved from
 * the same served history the bills use — because a rent increase is pinned to
 * one link of a chain, and copying `quoted_amount` off that link before the
 * increase had been applied wrote the successor at the old number. The
 * increase then evaporated after one month, with nothing on any screen saying
 * so.
 */

const DENIED = "You don't manage that park.";

export interface RenewalPreview {
  reservationId: string;
  lotNumber: string;
  renterName: string | null;
  priorStart: string;
  priorEnd: string;
  /**
   * The rent the successor WILL BE WRITTEN AT — the number in force on its
   * first morning, once every served increase has been applied. This is what
   * the button writes, so it is what the card shows.
   */
  quotedAmount: number | null;
  /** What the prior row carries today. Differs from `quotedAmount` only when
   *  a served increase lands between now and the successor's start. */
  priorQuotedAmount: number | null;
  /** The effective date of that increase, when there is one. */
  rentChangeOn: string | null;
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

/** The preview plus the prior row it was planned from — the row the successor
 *  is built FROM. Internal: the exported action hands back only the preview. */
type Planned = PreviewResult & { prior?: PriorLink };

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
): Promise<Planned> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  // "That tenancy isn't here." and "You don't manage that park." are both
  // statements of fact, and a dropped read has no facts to state. The first
  // sends the owner hunting for a row sitting in front of him; the second tells
  // him something false about his own access.
  //
  // ONE READ of the prior row, and it carries everything the successor copies
  // — the household's due day, move-in date and rent confirmation travel with
  // them, so they are read here rather than dropped on the floor by a second,
  // narrower select at write time.
  const res = mustRead("that tenancy", await admin
    .from("lot_reservations")
    // ONE string literal — supabase-js types a concatenated select as an error.
    .select("id, park_lot_id, renter_id, renter_unit_id, during, quoted_amount, term, agreement_chain_id, agreement_seq, status, origin, due_day, tenancy_began_on, amount_source, amount_source_at")
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
  const chainId = (res.agreement_chain_id as string) ?? (res.id as string);
  const seq = (res.agreement_seq as number) ?? 1;
  const priorQuoted = res.quoted_amount == null ? null : Number(res.quoted_amount);

  // THE CHAIN'S REAL LENGTH, for the long-run sentence. Every earlier live link
  // by its own dates, plus this one — not the sequence number times the cap,
  // which at a park whose first lease is one month and whose renewals are three
  // said "six months" after four. A failed read here would make the chain look
  // short and keep the sentence quiet, so it stops instead.
  const links = mustRead("that household's earlier agreements", await admin
    .from("lot_reservations")
    .select("id, during, agreement_seq")
    .eq("agreement_chain_id", chainId)
    .in("status", ["approved", "active"]));
  const chainMonthsSoFar = (links ?? [])
    .filter((l) => l.id !== res.id && ((l.agreement_seq as number) ?? 1) < seq)
    .reduce((sum, l) => {
      const r = parseDaterange(l.during as string);
      return r ? sum + monthsBetween(r.start, r.end) : sum;
    }, monthsBetween(range.start, range.end));

  let plan = planRenewal(
    {
      id: res.id as string,
      chainId,
      seq,
      start: range.start,
      end: range.end,
      quotedAmount: priorQuoted,
      term: (res.term as string) ?? "monthly",
      chainMonthsSoFar,
    },
    terms,
    today,
    startFrom,
  );

  // A HOUSEHOLD STILL ON THE SELLER'S ARRANGEMENT is not renewed from here.
  // Their new lease is a different act — it ends the holdover and starts the
  // fee — and it is recorded from their row on the rent roll. Writing a
  // successor here would either copy 'grandfathered' onto a lease they had
  // just signed (the fee never bills) or assert 'office' on one they had not
  // (a fee they never agreed to). So the card says where the control is.
  // Whatever else the planner said — "already ended, start a new one" would
  // send him to a door that files a second renter for the same household.
  if (res.origin === "grandfathered") {
    plan = { ok: false, refusal: "inherited" };
  }

  // THE RENT IN FORCE ON THE SUCCESSOR'S FIRST MORNING — from the same served
  // history the bills read, so a $425 increase served for 1 April is what a
  // May–August agreement written on 17 March carries, not the $400 still
  // sitting on the February row. A failed read of that history would quietly
  // write the old number, so it stops.
  const hist = await servedRentHistory([res.id as string]);
  if (hist.error) {
    console.error("[read failed] the rent history for that tenancy:", hist.error);
    throw new ReadFailed("the rent history for that tenancy", String((hist.error as { message?: string })?.message ?? ""));
  }
  const changes = hist.byRes.get(res.id as string) ?? [];
  const successorStart = plan.ok && plan.start ? plan.start : (startFrom ?? range.end);
  const quotedAmount = rentForPeriod(changes, successorStart, priorQuoted);
  const inForce = [...changes]
    .filter((c) => c.effective_on <= successorStart)
    .sort((a, b) => a.effective_on.localeCompare(b.effective_on))
    .at(-1);

  const renter = res.renter_id
    ? mustRead("the name on that tenancy", await admin
        .from("park_renters").select("display_name")
        .eq("id", res.renter_id as string).maybeSingle())
    : null;

  const lotNumber = (lot.lot_number as string) ?? "?";
  return {
    ok: true,
    preview: {
      reservationId: res.id as string,
      lotNumber,
      renterName: (renter?.display_name as string) ?? null,
      priorStart: range.start,
      priorEnd: range.end,
      quotedAmount,
      priorQuotedAmount: priorQuoted,
      rentChangeOn: inForce && quotedAmount !== priorQuoted ? inForce.effective_on : null,
      plan,
      refusalText: plan.refusal ? renewalRefusalText(plan.refusal, lotNumber) : null,
      chainNote: plan.totalMonthsAfter ? chainNotice(plan.totalMonthsAfter) : null,
    },
    prior: {
      id: res.id as string,
      park_lot_id: res.park_lot_id as string,
      renter_id: res.renter_id as string,
      renter_unit_id: (res.renter_unit_id as string | null) ?? null,
      term: (res.term as string) ?? "monthly",
      quoted_amount: priorQuoted,
      agreement_chain_id: (res.agreement_chain_id as string | null) ?? null,
      agreement_seq: seq,
      due_day: (res.due_day as number | null) ?? null,
      tenancy_began_on: (res.tenancy_began_on as string | null) ?? null,
      amount_source: (res.amount_source as string | null) ?? null,
      amount_source_at: (res.amount_source_at as string | null) ?? null,
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
  const { ok, error, preview } = await plannedOrSentence(parkId, reservationId, startFrom);
  return { ok, error, preview };
}

async function plannedOrSentence(
  parkId: string,
  reservationId: string,
  startFrom?: string,
): Promise<Planned> {
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

  // The prior row is read ONCE, by the planner, and the successor is built
  // from that same read — so a failed read never reaches the insert as a row
  // attached to nobody: the planner's sentence comes back instead.
  const pre = await plannedOrSentence(parkId, reservationId, opts.startFrom);
  if (!pre.ok || !pre.preview || !pre.prior) return { ok: false, error: pre.error ?? "Couldn't work that out." };
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

  // A SUCCESSOR ROW, never an edit. Last term's dates and rent are what the
  // ledger already billed against; rewriting them would restate history.
  //
  // Built by the one builder both doors share. `origin` is this door's fact —
  // an agreement the owner wrote is 'office' — never a copy of the prior's.
  // A gap OMITS the chain column so the database mints a new chain; sending
  // null to it is a constraint error, not a fresh start.
  const { error } = await admin.from("lot_reservations").insert(successorRow(pre.prior, {
    start: plan.start,
    end: plan.end,
    status: "approved",
    quotedAmount: quoted,
    origin: "office",
    continuesChain: plan.continuesChain ?? false,
    nextSeq: plan.nextSeq ?? 1,
    // The owner's own rule, and the database refuses a deposit on a
    // consecutive renewal regardless — so the two cannot drift apart.
    depositAmount: plan.depositDue ? plan.depositAmount : null,
    nowISO: new Date().toISOString(),
  }));
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
    // A date a person reads is words — "May 1, 2027", never "2027-05-01".
    signal: plan.depositDue
      ? `Lot ${lotNumber} runs to ${longDate(plan.end)}. This one starts a new chain, so a deposit is due.`
      : `Lot ${lotNumber} runs to ${longDate(plan.end)}. Consecutive — no new deposit.`,
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
