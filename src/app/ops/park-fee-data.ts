import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, softRead } from "@/lib/must-read";
import { getPlatformSettings } from "@/lib/settings";
import {
  countableLots,
  feeFor,
  rateCentsFor,
  type FeeLot,
  type Fee,
  unbilledMonths,
  lastClosedMonth,
} from "@/lib/park-platform-fee";

/**
 * WHAT A PARK PAYS LAKELIFE — the ops side, and the ONE place the lots are read.
 *
 * ============ WHY THERE IS EXACTLY ONE FETCH ============
 *
 * The count appears on three surfaces — the parks board, the raise control's
 * preview, and the raise itself — and three fetches is how they come to
 * disagree. The ops board's existing `park_lots` select
 * (`src/app/ops/parks-data.ts`) does not fetch `park_owned_home` at all, and
 * `Lot.parkOwnedHome` in `src/lib/parks.ts` is OPTIONAL — so handing that row to
 * a rule which excludes park-owned homes compiles cleanly, `undefined !== true`
 * passes, and Lot 11 (The Haven's own house) joins the count. The board would
 * print $168 while the raise, fetching its own rows, froze $160, and nothing
 * anywhere would be red.
 *
 * So `FeeLot` has no optional fields and this function is the only thing that
 * builds one. A caller who forgets a column now fails to compile.
 */

/** The select, as ONE string literal — a broken-up one makes every column GenericStringError. */
const FEE_LOT_COLUMNS = "lot_number, active, lifecycle, park_owned_home, site_type";

export async function fetchFeeLots(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
): Promise<FeeLot[]> {
  // THROWS on a failed read. An empty list here is a $0.00 invoice — a park
  // billed nothing for a month it was owed for, with a frozen row to prove it.
  // "We could not read the lots" and "this park has no lots" must never arrive
  // as the same answer when money is about to be written down.
  const rows = mustRead(
    "this park's lots",
    await admin.from("park_lots").select(FEE_LOT_COLUMNS).eq("park_id", parkId),
  );
  return (rows ?? []).map((l) => ({
    lotNumber: String(l.lot_number ?? ""),
    active: l.active !== false,
    lifecycle: (l.lifecycle as string | null) ?? "live",
    parkOwnedHome: l.park_owned_home === true,
    siteType: (l.site_type as string | null) ?? "",
  }));
}

export interface ParkFeeTerms {
  /** This park's own negotiated rate in cents, or null = it pays the list price. */
  feePerLotCents: number | null;
  /** The month its fee starts. NULL = NOT BEING BILLED, which is every park today. */
  feeStartMonth: string | null;
}

export interface ParkFeeInvoice {
  id: string;
  periodMonth: string;
  lotCount: number;
  lotNumbers: string[];
  rateCents: number;
  amountCents: number;
  status: "draft" | "issued" | "void";
  countedAt: string | null;
}

export interface ParkFeeView {
  parkId: string;
  parkName: string;
  /** The park's own takeover date, for the refusal the terms already promise. */
  cutoverDate: string | null;
  terms: ParkFeeTerms;
  /** Dollars per lot per month, from the ops dial. */
  listPriceDollars: number;
  /** What this park would be invoiced for a month raised right now. */
  wouldInvoice: Fee;
  /** Months already raised, newest first. `null` = we could not read them. */
  raised: ParkFeeInvoice[] | null;
}

/**
 * ONE PARK'S FEE PICTURE, for the ops parks board.
 *
 * Returns the LIVE figure ("would invoice") and the FROZEN rows separately, and
 * never blends them: once a month is raised its number is the row's, not
 * today's lot table. A screen showing both unlabelled beside each other is how
 * somebody voids a correct month to make two numbers agree.
 */
export async function getParkFeeView(parkId: string, parkName: string, cutoverDate: string | null): Promise<ParkFeeView> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();

  const [lots, termsRes, invRes] = await Promise.all([
    fetchFeeLots(admin, parkId),
    admin.from("lakelife_park_terms").select("fee_per_lot_cents, fee_start_month").eq("park_id", parkId).maybeSingle(),
    admin
      .from("lakelife_park_invoices")
      .select("id, period_month, lot_count, lot_numbers, rate_cents, amount_cents, status, counted_at")
      .eq("park_id", parkId)
      .order("period_month", { ascending: false })
      .limit(24),
  ]);

  // A FAILED TERMS READ MUST NOT READ AS "NOT BILLING". `fee_start_month: null`
  // is the value that means this park is switched off, and answering it from a
  // dropped connection would tell ops a park is safe when nobody knows.
  const terms = mustRead("what this park has been quoted", termsRes);

  // The raised list is a table on a card; losing it must not take the card
  // down, but an empty array would read as "nothing has ever been raised",
  // which is the sentence somebody acts on by raising it again.
  const [invRows, invFailed] = softRead("the months already raised for this park", invRes, null);

  const rateCents = rateCentsFor(
    settings.parkPlatformFeePerLotMonthly,
    (terms?.fee_per_lot_cents as number | null) ?? null,
  );

  return {
    parkId,
    parkName,
    cutoverDate,
    terms: {
      feePerLotCents: (terms?.fee_per_lot_cents as number | null) ?? null,
      feeStartMonth: (terms?.fee_start_month as string | null) ?? null,
    },
    listPriceDollars: settings.parkPlatformFeePerLotMonthly,
    wouldInvoice: feeFor(lots, rateCents),
    raised: invFailed
      ? null
      : (invRows ?? []).map((r) => ({
          id: r.id as string,
          periodMonth: r.period_month as string,
          lotCount: Number(r.lot_count ?? 0),
          lotNumbers: (r.lot_numbers as string[] | null) ?? [],
          rateCents: Number(r.rate_cents ?? 0),
          amountCents: Number(r.amount_cents ?? 0),
          status: (r.status as ParkFeeInvoice["status"]) ?? "draft",
          countedAt: (r.counted_at as string | null) ?? null,
        })),
  };
}

/**
 * WHAT MOVED SINCE THE LAST MONTH WE RAISED.
 *
 * The lot flags this fee counts — `active`, `lifecycle`, `park_owned_home` —
 * are all written from the PARK's own screens, by any park manager, with no
 * sentence anywhere saying a tick changes what LakeLife invoices. Untick "In
 * service" on six empty pads and next month's bill is $48 lighter; add a row of
 * pads and it is heavier. Neither shows up as anything but a different number.
 *
 * So the raise control names the lots that moved. Derived from the previous
 * row's own frozen `lot_numbers`, which is the only record of what was counted
 * last time.
 */
export function lotsThatMoved(
  previous: string[] | null | undefined,
  now: string[],
): { added: string[]; gone: string[] } {
  if (!previous) return { added: [], gone: [] };
  const before = new Set(previous);
  const after = new Set(now);
  return {
    added: now.filter((l) => !before.has(l)),
    gone: previous.filter((l) => !after.has(l)),
  };
}

/** Re-exported so a caller never reaches for a second copy of the rule. */
export { countableLots };

export interface PlatformBillingGap {
  parkId: string;
  parkName: string;
  /** True when this park cannot be invoiced at all — no fee start month. */
  notBillable: boolean;
  /** Months owed and never raised. Empty when notBillable. */
  unbilled: string[];
  /** What one month is worth at today's countable lots, in cents. */
  monthlyCents: number;
}

/**
 * WHERE LAKELIFE'S OWN REVENUE IS LEAKING.
 *
 * Two different problems, and they need telling apart because the fix differs:
 *
 *   NOT BILLABLE — the park has no `fee_start_month`, so `invoiceRefusal`
 *   refuses every month. Nothing can ever be raised for it. On 17 Oct 2026
 *   that was The Haven: `lakelife_park_terms` empty, the $8 dial set, 21 lots,
 *   and no screen anywhere saying LakeLife could not bill it a penny.
 *
 *   UNBILLED — the park is set up and months have gone by unraised. Raising
 *   is a manual act on a tab somebody has to remember, and nothing reminded
 *   anyone.
 *
 * `null` means the read failed, never "nothing is owed" — the reassuring way
 * to be wrong about your own revenue.
 */
export async function getPlatformBillingGaps(
  today: string,
): Promise<PlatformBillingGap[] | null> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();
  const through = lastClosedMonth(today);

  const [parksRes, termsRes, invRes] = await Promise.all([
    admin.from("parks").select("id, name, cutover_date").order("name"),
    admin.from("lakelife_park_terms").select("park_id, fee_per_lot_cents, fee_start_month"),
    admin.from("lakelife_park_invoices").select("park_id, period_month, status"),
  ]);
  if (parksRes.error || termsRes.error || invRes.error) {
    console.error(
      "[ops] where our own billing is leaking:",
      parksRes.error?.message ?? termsRes.error?.message ?? invRes.error?.message,
    );
    return null;
  }

  const termsBy = new Map((termsRes.data ?? []).map((t) => [t.park_id as string, t]));
  const raisedBy = new Map<string, string[]>();
  for (const r of invRes.data ?? []) {
    // A VOIDED MONTH IS NOT A RAISED ONE. Counting it would hide the exact
    // case somebody voided it to fix.
    if ((r.status as string) === "void") continue;
    const list = raisedBy.get(r.park_id as string) ?? [];
    list.push(r.period_month as string);
    raisedBy.set(r.park_id as string, list);
  }

  const out: PlatformBillingGap[] = [];
  for (const p of parksRes.data ?? []) {
    const id = p.id as string;
    const t = termsBy.get(id);
    const startMonth = (t?.fee_start_month as string | null) ?? null;
    const rateCents = rateCentsFor(
      settings.parkPlatformFeePerLotMonthly,
      (t?.fee_per_lot_cents as number | null) ?? null,
    );
    let monthlyCents = 0;
    try {
      monthlyCents = feeFor(await fetchFeeLots(admin, id), rateCents).amountCents;
    } catch {
      // One park's lots failing must not empty the answer for the others; the
      // month count still stands, only its worth is unknown.
      monthlyCents = 0;
    }
    out.push({
      parkId: id,
      parkName: (p.name as string) ?? "A park",
      notBillable: !startMonth,
      unbilled: unbilledMonths({
        startMonth,
        cutoverDate: (p.cutover_date as string | null) ?? null,
        raised: raisedBy.get(id) ?? [],
        throughMonth: through,
      }),
      monthlyCents,
    });
  }
  return out;
}
