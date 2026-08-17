import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { prettyMonth } from "@/app/park/ledger-helpers";
import { parseDaterange } from "@/lib/parks";
import { todayLakeDate } from "@/lib/booking";

/**
 * THE RESIDENT'S OWN SCREEN.
 *
 * Everything the park knows about THEM, and nothing about anybody else. The
 * park owner has had a rent roll, a ledger, a visits board and a task list
 * since the module shipped; the person actually paying the rent has had
 * nothing at all.
 *
 * WHO THIS IS FOR. A resident whose `park_renters` file is CLAIMED — user_id
 * set. Applying through a park's public page already does that
 * (`apply-actions.ts` writes user_id, claimed_at and source='self_signup'), so
 * anybody who came in through the website has one. The households the owner
 * typed in are unclaimed and see nothing here; inviting them is a separate
 * problem about flip phones and is not solved by this file.
 *
 * TWO LEDGERS THAT NEVER TOUCH. Rent is owed to the PARK — LakeLife only
 * administers it. A service booking is owed to LAKELIFE. They are rendered
 * apart and they are never netted, because a platform that withheld a mow over
 * late rent would have quietly become a collections tool.
 */

export interface BillLine { label: string; amount: number }

export interface RenterHome {
  parkName: string;
  lotNumber: string;
  displayName: string;
  /** Their tenancy's start, for "living here since". */
  since: string | null;
  /**
   * Whether THEY have turned texts on, and the number they gave.
   *
   * `textsOn` reads consent, not the number: a verified mobile with no consent
   * is still a number we may not use, and the send path reads consent. The
   * number off the park's old records never appears here at all.
   */
  textsOn: boolean;
  textNumber: string | null;
  term: string;
  /** Set once they have given notice. */
  leavingOn: string | null;

  /** True when the park has agreed to take rent through LakeLife (0108). */
  acceptsOnlineRent: boolean;
  /** They need a card before any pay button is worth showing. */
  hasCard: boolean;
  /** True once their lot has been minted as a bookable place. */
  bookingReady: boolean;
  /** Percent added if they pay rent by card. 0 = no fee. */
  cardFeePct: number;
  /**
   * Lake-local today, so "when did you pay it?" cannot offer tomorrow. Taken
   * from the server rather than the handset — a phone left on the wrong
   * timezone would otherwise widen the window by a day.
   */
  today: string;

  /** This month's bill, or null when the park has not raised it yet. */
  bill: {
    /** Needed by payRent — the only id this screen hands back to the server. */
    id: string;
    monthLabel: string;
    dueOn: string;
    amount: number;
    paidTotal: number;
    outstanding: number;
    status: string;
    /** An unanswered "I already paid this" is open against this bill. */
    disputed: boolean;
    /** The day they said they paid, when they gave one. */
    claimedPaidOn: string | null;
    lines: BillLine[];
  } | null;

  /** Deposit still held. Null when there has never been one. */
  deposit: { amount: number; since: string } | null;

  /**
   * `amount` is the RENT. `fee` is the card convenience fee charged on top and
   * is null on every other rail. Two figures because the card statement shows
   * their sum and the rent ledger shows only the first — a resident comparing
   * the two deserves to find the difference here rather than ring the office.
   */
  payments: { on: string; amount: number; fee: number | null; method: string; receiptNo: number | null }[];

  /** Reported from their lot, during their tenancy. */
  reported: { note: string; status: string; resolutionNote: string | null; ageDays: number }[];
}

export async function getRenterHome(): Promise<RenterHome | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createServiceClient();

  // THE FILE MUST BE CLAIMED BY THIS ACCOUNT. Everything below is scoped
  // through it, so this single check is what keeps one resident out of
  // another's ledger.
  const { data: files } = await admin
    .from("park_renters")
    .select("id, park_id, display_name, mobile_e164, sms_consent_operational_at")
    .eq("user_id", user.id);
  if (!files?.length) return null;

  const renterIds = files.map((f) => f.id as string);

  // The tenancy they are actually living in. `ended` rows are deliberately
  // excluded: a former resident is not owed a live screen about a lot
  // somebody else now lives on.
  const { data: stays } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, term, status, expected_move_out, tenancy_began_on")
    .in("renter_id", renterIds)
    .in("status", ["approved", "active"])
    .order("created_at", { ascending: false });
  const stay = stays?.[0];
  if (!stay) return null;

  const file = files.find((f) => f.id === stay.renter_id) ?? files[0];
  const range = parseDaterange(stay.during as string);

  const [{ data: lot }, { data: park }, { count: cards }] = await Promise.all([
    admin.from("park_lots").select("lot_number").eq("id", stay.park_lot_id as string).maybeSingle(),
    admin.from("parks").select("name, accepts_online_rent, card_fee_pct").eq("id", file.park_id as string).maybeSingle(),
    admin.from("payment_methods").select("id", { count: "exact", head: true }).eq("user_id", user.id),
  ]);

  // ---- the bill -----------------------------------------------------------
  // The LATEST charge, not "this month's". A month the park has not billed yet
  // has no row, and showing $0.00 for it would read as "you are square" when
  // the truth is "the bill has not been sent".
  const { data: charges } = await admin
    .from("park_charges")
    .select("id, period_month, due_on, amount, paid_total, status, lines")
    .eq("reservation_id", stay.id as string)
    .neq("status", "void")
    .order("period_month", { ascending: false })
    .limit(1);
  const charge = charges?.[0];

  // THE OPEN CLAIM, not just whether there is one. `park_payment_claims` is
  // specifically "I already paid this" — the date is the thing the resident
  // most wants read back to them, and a screen that says only "you disputed
  // it" describes something they never did.
  let disputed = false;
  let claimedPaidOn: string | null = null;
  if (charge) {
    const { data: claims } = await admin
      .from("park_payment_claims")
      .select("id, claimed_paid_on")
      .eq("charge_id", charge.id as string)
      .is("resolved_at", null)
      .limit(1);
    disputed = (claims?.length ?? 0) > 0;
    claimedPaidOn = (claims?.[0]?.claimed_paid_on as string | null) ?? null;
  }

  // ---- money in -----------------------------------------------------------
  const { data: pays } = await admin
    .from("park_payments")
    .select("amount, fee_amount, method, received_on, receipt_no, kind, returned_on, reversed_at")
    .eq("renter_id", file.id as string)
    .order("received_on", { ascending: false })
    .limit(24);

  const live = (pays ?? []).filter((p) => p.reversed_at == null);

  // A deposit is money of theirs the park is holding — the single most
  // disputed number in this business, eighteen months later at move-out. It
  // sits on the front page all year so that argument never happens.
  const heldDeposits = live.filter((p) => p.kind === "deposit" && p.returned_on == null);
  const depositTotal = heldDeposits.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const depositSince = heldDeposits
    .map((p) => p.received_on as string)
    .sort()[0] ?? null;

  // ---- what they reported -------------------------------------------------
  // Scoped to their tenancy's start: park_requests key on the LOT, not the
  // renter, so without this a new resident would be shown the last one's
  // broken step.
  let reported: RenterHome["reported"] = [];
  if (range?.start) {
    const { data: reqs } = await admin
      .from("park_requests")
      .select("note, status, resolution_note, created_at")
      .eq("park_lot_id", stay.park_lot_id as string)
      .gte("created_at", `${range.start}T00:00:00Z`)
      .order("created_at", { ascending: false })
      .limit(10);
    const now = Date.now();
    reported = (reqs ?? []).map((r) => ({
      note: (r.note as string) ?? "",
      status: (r.status as string) ?? "new",
      resolutionNote: (r.resolution_note as string) ?? null,
      ageDays: Math.max(0, Math.floor((now - Date.parse(r.created_at as string)) / 86_400_000)),
    }));
  }

  // Their lot as a bookable place. Found by OWNER, never by a pointer on the
  // tenancy — 0107 dropped that column and 0062's renewal chain is why.
  const { count: lotProps } = await admin
    .from("properties")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", user.id)
    .eq("park_id", file.park_id as string);

  const amount = Number(charge?.amount ?? 0);
  const paidTotal = Number(charge?.paid_total ?? 0);

  return {
    parkName: (park?.name as string) ?? "your park",
    acceptsOnlineRent: Boolean(park?.accepts_online_rent),
    hasCard: (cards ?? 0) > 0,
    bookingReady: (lotProps ?? 0) > 0,
    cardFeePct: Number(park?.card_fee_pct ?? 0),
    today: todayLakeDate(),
    lotNumber: (lot?.lot_number as string) ?? "—",
    displayName: (file.display_name as string) ?? "Resident",
    // WHEN SHE ARRIVED, NOT WHEN THE PAPERWORK STARTED. This read the
    // agreement window's start and labelled it "living here since" — two facts
    // the schema deliberately keeps apart (see buildTenant). A household filed
    // on their first day in the system was greeted with "living here since"
    // today, which for someone who has been on the lot eleven years is simply
    // false, and false in a way she notices immediately. Unknown now renders as
    // nothing at all, which is what we actually know.
    since: (stay.tenancy_began_on as string | null) ?? null,
    textsOn: file.sms_consent_operational_at != null,
    textNumber: (file.mobile_e164 as string | null) ?? null,
    term: (stay.term as string) ?? "monthly",
    leavingOn: (stay.expected_move_out as string) ?? null,
    bill: charge
      ? {
          id: charge.id as string,
          monthLabel: prettyMonth(charge.period_month as string),
          dueOn: charge.due_on as string,
          amount,
          paidTotal,
          outstanding: Math.round((amount - paidTotal) * 100) / 100,
          status: (charge.status as string) ?? "open",
          disputed,
          claimedPaidOn,
          lines: ((charge.lines as { label?: string; amount?: number }[]) ?? []).map((l) => ({
            label: String(l.label ?? "Rent"),
            amount: Number(l.amount ?? 0),
          })),
        }
      : null,
    deposit: depositTotal > 0 && depositSince
      ? { amount: depositTotal, since: depositSince }
      : null,
    payments: live
      .filter((p) => p.kind !== "deposit")
      .slice(0, 6)
      .map((p) => ({
        on: p.received_on as string,
        amount: Number(p.amount ?? 0),
        fee: p.fee_amount == null ? null : Number(p.fee_amount),
        method: (p.method as string) ?? "payment",
        receiptNo: (p.receipt_no as number) ?? null,
      })),
    reported,
  };
}
