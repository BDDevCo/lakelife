"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { readFailedMessage } from "@/lib/must-read";
import { getPlatformSettings } from "@/lib/settings";
import { fetchFeeLots, lotsThatMoved } from "./park-fee-data";
import {
  feeFor,
  feeSentence,
  invoiceRefusal,
  rateCentsFor,
  MAX_FEE_PER_LOT,
  MIN_FEE_PER_LOT,
} from "@/lib/park-platform-fee";

/**
 * SETTING WHAT A PARK PAYS, AND WRITING DOWN ONE MONTH OF IT.
 *
 * ============ NOTHING HERE CHARGES, SENDS OR TELLS ANYBODY ============
 *
 * There is no processor — "As LakeLife we do not handle cash. at all. hard
 * stop." — and there is no park-facing surface for this yet. Raising a month
 * writes one frozen row to `lakelife_park_invoices`; it does not bill, it does
 * not email, and no park can pay it. The status vocabulary has no `paid` and no
 * `sent`, so nothing here is able to claim either.
 *
 * This file must never import sendEmail, sendSms, takePayment or giveRefund,
 * and a source scan over the whole of src/ fails the build if anything holding
 * this feature's names ever does.
 *
 * ============ AND NOTHING HERE TOUCHES A RESIDENT'S MONEY ============
 *
 * It writes exactly two tables, both `lakelife_`-prefixed. It never writes
 * `park_costs` (which SPLITS across lots onto nineteen rent bills), `park_fees`,
 * `park_charges` or `lot_cost_shares`. The obvious next ask — "file it in his
 * books so his CPA sees it" — is precisely the change that would put LakeLife's
 * revenue on a resident's bill, so an inverse source scan refuses it here.
 */

export interface FeeResult {
  ok: boolean;
  error?: string;
  /** What was written, in the words the row itself produces. */
  sentence?: string;
  /** Lots that joined or left the count since the last month raised. */
  moved?: { added: string[]; gone: string[] };
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * WHAT THIS PARK PAYS AND WHEN IT STARTS — two facts, set together because they
 * are two halves of one commercial conversation, and both default to absent.
 *
 * `feeStartMonth: null` is how a park is switched OFF, and it is the value
 * every park ships with. It is a separate act from the list price for a reason:
 * the price is LakeLife's own and is true on day one; "this park owes it" is
 * false for every park until somebody has actually agreed it.
 */
export async function setParkFeeTerms(input: {
  parkId: string;
  /** Dollars. Empty/null = this park pays the list price. */
  perLotDollars?: string | number | null;
  /** 'YYYY-MM', or null to stop billing this park. */
  startMonth?: string | null;
}): Promise<FeeResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!input?.parkId) return { ok: false, error: "No park selected." };

  // THE OVERRIDE IS `null` FOR ABSENT AND 0 FOR FREE, and they are different
  // things. A park held free — a pilot, or one paused mid-conversation — is a
  // deliberate 0 that must not fall back to the list price.
  let perLotCents: number | null = null;
  const raw = input.perLotDollars;
  if (raw != null && String(raw).trim() !== "") {
    const d = Number(raw);
    if (!Number.isFinite(d) || d < MIN_FEE_PER_LOT || d > MAX_FEE_PER_LOT) {
      return { ok: false, error: `A park's own rate has to be between $${MIN_FEE_PER_LOT} and $${MAX_FEE_PER_LOT} a lot.` };
    }
    perLotCents = Math.round(d * 100);
  }

  const start = (input.startMonth ?? "").trim();
  if (start && !MONTH.test(start)) {
    return { ok: false, error: "Write the start month as YYYY-MM, like 2027-01." };
  }

  const admin = createServiceClient();
  const { error } = await admin.from("lakelife_park_terms").upsert(
    {
      park_id: input.parkId,
      fee_per_lot_cents: perLotCents,
      fee_start_month: start || null,
      set_by: ops.id,
      set_at: new Date().toISOString(),
    },
    { onConflict: "park_id" },
  );
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    sentence: start
      ? `This park's fee starts ${start}. Nothing has been sent and nothing can be paid — raising a month only writes the figure down.`
      : "This park isn't being billed. Set a start month when that changes.",
  };
}

/**
 * WRITE DOWN ONE MONTH. The count is taken now, the rate is frozen onto the
 * row, and neither can be changed by anything that happens afterwards.
 *
 * The rate is FROZEN rather than re-read later for the same reason 0174 freezes
 * the fee percentages onto a job: moving the dial must not be able to reprice a
 * month already raised.
 */
export async function raiseParkPlatformInvoice(input: {
  parkId: string;
  periodMonth: string;
}): Promise<FeeResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!input?.parkId) return { ok: false, error: "No park selected." };

  const period = (input.periodMonth ?? "").trim();
  const admin = createServiceClient();

  const [parkRes, termsRes, settings] = await Promise.all([
    admin.from("parks").select("name, cutover_date").eq("id", input.parkId).maybeSingle(),
    admin.from("lakelife_park_terms").select("fee_per_lot_cents, fee_start_month").eq("park_id", input.parkId).maybeSingle(),
    getPlatformSettings(),
  ]);
  if (parkRes.error) return { ok: false, error: readFailedMessage("that park", parkRes.error) };
  if (!parkRes.data) return { ok: false, error: "That park doesn't exist." };
  // "This park isn't being billed yet" is a claim about a commercial
  // arrangement, and a dropped read has no standing to make it.
  if (termsRes.error) return { ok: false, error: readFailedMessage("what this park has been quoted", termsRes.error) };

  const terms = termsRes.data;
  const refusal = invoiceRefusal({
    periodMonth: period,
    startMonth: (terms?.fee_start_month as string | null) ?? null,
    cutoverDate: (parkRes.data.cutover_date as string | null) ?? null,
  });
  if (refusal) return { ok: false, error: refusal };

  // THE MONTH IS SELECTED FIRST, NEVER INSERTED-AND-CAUGHT. The partial unique
  // index would answer a bare insert with a raw 23505, which reads as
  // `data: null` and puts a Postgres string on an ops screen beside a retry
  // that can never work.
  const existingRes = await admin
    .from("lakelife_park_invoices")
    .select("id, status")
    .eq("park_id", input.parkId)
    .eq("period_month", period)
    .neq("status", "void")
    .maybeSingle();
  if (existingRes.error) return { ok: false, error: readFailedMessage("whether that month is already raised", existingRes.error) };
  if (existingRes.data) {
    return { ok: false, error: `${period} is already raised for this park. Void it first if the figure is wrong.` };
  }

  // THE LOTS, THROUGH THE ONE FETCH. It THROWS on a failed read rather than
  // hand back an empty list, which would freeze a $0.00 month.
  let lots;
  try {
    lots = await fetchFeeLots(admin, input.parkId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("this park's lots", e) };
  }

  const rateCents = rateCentsFor(
    settings.parkPlatformFeePerLotMonthly,
    (terms?.fee_per_lot_cents as number | null) ?? null,
  );
  // `feeFor` IS CALLED, never rebuilt. A second copy of the multiplication is
  // how two screens come to disagree about what a park owes, and a test that
  // asserts against a recomputed expression passes with the real one deleted.
  const fee = feeFor(lots, rateCents);

  // WHAT MOVED SINCE LAST TIME, read before the write so the previous row is
  // still the most recent one.
  const prevRes = await admin
    .from("lakelife_park_invoices")
    .select("lot_numbers")
    .eq("park_id", input.parkId)
    .neq("status", "void")
    .order("period_month", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevRes.error) console.error("[read failed, degraded] the previous month's lot list:", prevRes.error);
  const moved = lotsThatMoved((prevRes.data?.lot_numbers as string[] | null) ?? null, fee.lotNumbers);

  const countedAt = new Date().toISOString();
  const { error } = await admin.from("lakelife_park_invoices").insert({
    park_id: input.parkId,
    period_month: period,
    lot_count: fee.count,
    lot_numbers: fee.lotNumbers,
    rate_cents: fee.rateCents,
    amount_cents: fee.amountCents,
    counted_at: countedAt,
    raised_by: ops.id,
  });
  if (error) {
    // The trigger's sentences are already written for a person; the unique
    // index's is not.
    if (error.code === "23505") {
      return { ok: false, error: `${period} was raised for this park a moment ago.` };
    }
    return { ok: false, error: error.message };
  }

  return {
    ok: true,
    moved,
    sentence: feeSentence({
      parkName: (parkRes.data.name as string) ?? "this park",
      periodMonth: period,
      count: fee.count,
      rateCents: fee.rateCents,
      amountCents: fee.amountCents,
      excluded: fee.excluded,
      countedAt,
    }),
  };
}

/**
 * TAKE A MONTH BACK. The row stays — it is the record that a figure was once
 * struck — and voiding frees the month so it can be raised again, which is why
 * the unique index is partial.
 */
export async function voidParkPlatformInvoice(invoiceId: string, reason: string): Promise<FeeResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!invoiceId) return { ok: false, error: "Nothing selected." };
  const why = (reason ?? "").trim().slice(0, 500);
  // A voided figure with no reason is a number that changed and nobody knows
  // why — and re-raising resamples the lots, so the next figure may differ.
  if (!why) return { ok: false, error: "Say why it's being taken back — the next raise may count different lots." };

  const admin = createServiceClient();
  const { error } = await admin
    .from("lakelife_park_invoices")
    .update({ status: "void", voided_at: new Date().toISOString(), void_reason: why })
    .eq("id", invoiceId)
    .neq("status", "void");
  if (error) return { ok: false, error: error.message };
  return { ok: true, sentence: "Taken back. That month can be raised again." };
}

// ---- The dial, and what it would mean for each park ------------------------

/** A month already written down for this park. */
export interface RaisedMonth {
  id: string;
  periodMonth: string;
  amountCents: number;
  lotCount: number;
  status: "draft" | "issued" | "void";
  countedAt: string | null;
}

export interface ParkFeeRow {
  parkId: string;
  parkName: string;
  /** Null = pays the list price. */
  ownRateCents: number | null;
  /** Null = NOT BEING BILLED. Every park, today. */
  startMonth: string | null;
  /** What a month raised right now would say. */
  wouldSay: string;
  amountCents: number;
  /** Months already raised, newest first. `null` = we could not read them —
   *  never an empty array, which reads as "nothing has ever been raised" and
   *  is the sentence somebody acts on by raising it again. */
  raised: RaisedMonth[] | null;
}

export interface ParkFeeDialState {
  listPriceDollars: number;
  parks: ParkFeeRow[];
  /** Could not read something. The screen must not read as "no parks". */
  problem?: string;
}

/**
 * THE DIAL AND ITS CONSEQUENCES ON ONE SCREEN.
 *
 * The list price on its own is an abstraction — "$8" tells nobody what any park
 * would actually be invoiced. Each park's line is the same `feeFor` the raise
 * uses, over the same `fetchFeeLots`, so the number on this screen and the
 * number that would be frozen are the same number by construction rather than
 * by two implementations agreeing.
 */
export async function getParkFeeDial(): Promise<ParkFeeDialState> {
  const ops = await assertOps();
  if (!ops) return { listPriceDollars: 0, parks: [], problem: "Ops only." };

  const admin = createServiceClient();
  const settings = await getPlatformSettings();

  const parksRes = await admin.from("parks").select("id, name").order("name");
  // "No parks" is a sentence somebody would act on. A dropped read has not
  // earned it.
  if (parksRes.error) {
    return {
      listPriceDollars: settings.parkPlatformFeePerLotMonthly,
      parks: [],
      problem: readFailedMessage("the parks", parksRes.error),
    };
  }
  const termsRes = await admin.from("lakelife_park_terms").select("park_id, fee_per_lot_cents, fee_start_month");
  if (termsRes.error) {
    return {
      listPriceDollars: settings.parkPlatformFeePerLotMonthly,
      parks: [],
      problem: readFailedMessage("what each park has been quoted", termsRes.error),
    };
  }
  const termsBy = new Map((termsRes.data ?? []).map((t) => [t.park_id as string, t]));

  // ONE READ FOR EVERY PARK'S RAISED MONTHS, rather than one per park inside
  // the loop below. `null` on failure, carried onto every row.
  const raisedRes = await admin
    .from("lakelife_park_invoices")
    .select("id, park_id, period_month, amount_cents, lot_count, status, counted_at")
    .order("period_month", { ascending: false });
  if (raisedRes.error) console.error("[read failed, degraded] the months already raised:", raisedRes.error);
  const raisedBy = new Map<string, RaisedMonth[]>();
  if (!raisedRes.error) {
    for (const r of raisedRes.data ?? []) {
      const list = raisedBy.get(r.park_id as string) ?? [];
      list.push({
        id: r.id as string,
        periodMonth: r.period_month as string,
        amountCents: Number(r.amount_cents ?? 0),
        lotCount: Number(r.lot_count ?? 0),
        status: (r.status as RaisedMonth["status"]) ?? "draft",
        countedAt: (r.counted_at as string | null) ?? null,
      });
      raisedBy.set(r.park_id as string, list);
    }
  }
  const raisedFor = (id: string): RaisedMonth[] | null =>
    raisedRes.error ? null : (raisedBy.get(id) ?? []);

  const rows: ParkFeeRow[] = [];
  for (const p of parksRes.data ?? []) {
    const t = termsBy.get(p.id as string);
    const own = (t?.fee_per_lot_cents as number | null) ?? null;
    const rateCents = rateCentsFor(settings.parkPlatformFeePerLotMonthly, own);
    let fee;
    try {
      fee = feeFor(await fetchFeeLots(admin, p.id as string), rateCents);
    } catch {
      // One park's lots failing must not empty the whole screen, and must not
      // print a confident $0.00 either.
      rows.push({
        parkId: p.id as string,
        parkName: (p.name as string) ?? "a park",
        ownRateCents: own,
        startMonth: (t?.fee_start_month as string | null) ?? null,
        wouldSay: "We couldn't read this park's lots, so there's no figure to show.",
        amountCents: 0,
        raised: raisedFor(p.id as string),
      });
      continue;
    }
    rows.push({
      parkId: p.id as string,
      parkName: (p.name as string) ?? "a park",
      ownRateCents: own,
      startMonth: (t?.fee_start_month as string | null) ?? null,
      wouldSay: feeSentence({
        parkName: (p.name as string) ?? "a park",
        periodMonth: "",
        count: fee.count,
        rateCents: fee.rateCents,
        amountCents: fee.amountCents,
        excluded: fee.excluded,
      }),
      amountCents: fee.amountCents,
      raised: raisedFor(p.id as string),
    });
  }

  return { listPriceDollars: settings.parkPlatformFeePerLotMonthly, parks: rows };
}

/**
 * THE LIST PRICE — what LakeLife charges a park per lot per month.
 *
 * Unlike a crew's rate, which LakeLife may never set, this one is LakeLife's
 * own. Setting it bills nobody: a park is charged only once it has a start
 * month of its own, which is a separate act and is unset for every park.
 */
export async function setParkFeeListPrice(dollars: number): Promise<FeeResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const d = Number(dollars);
  if (!Number.isFinite(d) || d < MIN_FEE_PER_LOT || d > MAX_FEE_PER_LOT) {
    return { ok: false, error: `The list price has to be between $${MIN_FEE_PER_LOT} and $${MAX_FEE_PER_LOT} a lot.` };
  }
  const rounded = Math.round(d * 100) / 100;

  const admin = createServiceClient();
  const { error } = await admin
    .from("platform_settings")
    .upsert([{ key: "park_platform_fee_per_lot_monthly", value: rounded, updated_at: new Date().toISOString() }]);
  if (error) return { ok: false, error: error.message };
  return { ok: true, sentence: `List price saved. No park is billed it until you give that park a start month.` };
}
