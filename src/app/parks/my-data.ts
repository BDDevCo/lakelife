import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { prettyMonth } from "@/app/park/ledger-helpers";
import { parseDaterange } from "@/lib/parks";
import { todayLakeDate, lakeDaysSince } from "@/lib/booking";
import { paymentsAreLive } from "@/lib/charge-gate";
import { mustRead, mustCount, softRead } from "@/lib/must-read";

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

/**
 * WHY THIS LINE IS THIS SIZE. `basis` is what `buildStatement` writes beside
 * every line — "for the month", or "12 of 31 days" when a tenancy started or
 * ended mid-month. It was dropped here, so a resident who moved in on the 20th
 * saw a fee at a fraction of its stated amount with nothing saying why. The
 * screen's own comment promises the bill "shows its working"; the working is
 * this field.
 */
export interface BillLine { label: string; amount: number; basis: string | null }

export interface Bill {
  /** Needed by payRent and sayIPaid — the only id this screen hands back. */
  id: string;
  monthLabel: string;
  dueOn: string;
  amount: number;
  paidTotal: number;
  outstanding: number;
  status: string;
  /** An unanswered "I already paid this" is open against THIS bill. */
  disputed: boolean;
  /** The day they said they paid, when they gave one. */
  claimedPaidOn: string | null;
  lines: BillLine[];
}

export interface RenterHome {
  parkName: string;
  lotNumber: string;
  /** Her pedestal has a scannable sticker. False for every Haven lot today. */
  hasSticker: boolean;
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
  bill: Bill | null;

  /**
   * EVERY EARLIER BILL THEY STILL OWE ON, oldest first.
   *
   * This read used to be `.limit(1)`, so the morning February was raised an
   * unpaid January left the screen entirely — no balance, no Pay button, no
   * "I already paid this", and if February was then settled the card read
   * "Paid in full — thank you." to a household a month in arrears. Her only
   * route to her own back rent was ringing the office, which is the call this
   * module exists to prevent.
   */
  arrears: Bill[];

  /**
   * Set when the tenancy has ENDED, to the last day.
   *
   * The tenancy read excluded `ended` rows, so the day the office closed her
   * out the whole screen became "No lot on your account — we looked for a
   * tenancy attached to this sign-in and didn't find one", and her deposit and
   * her final part-month went with it. `runCharges` deliberately raises that
   * final prorated month AFTER the move-out (0101), so it was a bill she could
   * never see. The original exclusion was right about the LOT — she is not
   * owed a live screen about a pad somebody else now lives on — and wrong
   * about her money. When this is set the screen shows the wrap-up, not the
   * lot.
   */
  tenancyEnded: string | null;

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
  /**
   * True when that list could not be READ — as opposed to being empty. The
   * screen must distinguish them: "nothing yet" and "we couldn't look" are
   * different sentences and only one of them is ever a fact.
   */
  reportedFailed: boolean;
}

export async function getRenterHome(): Promise<RenterHome | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createServiceClient();

  // ===========================================================================
  // EVERY READ BELOW EITHER ANSWERS OR THROWS. See `mustRead`.
  //
  // This loader returns `null` to mean "you have no tenancy here", and the page
  // renders a full paragraph telling the reader their file isn't linked and to
  // ring the office. That sentence used to be reachable two ways: because it
  // was true, or because a read failed. Told to a household who has paid rent
  // for eleven years, the second one is a lie the software has no business
  // telling. `null` now means exactly one thing.
  // ===========================================================================

  // THE FILE MUST BE CLAIMED BY THIS ACCOUNT. Everything below is scoped
  // through it, so this single check is what keeps one resident out of
  // another's ledger.
  const files = mustRead(
    "your file",
    await admin
      .from("park_renters")
      .select("id, park_id, display_name, mobile_e164, sms_consent_operational_at")
      .eq("user_id", user.id),
  );
  if (!files?.length) return null;

  const renterIds = files.map((f) => f.id as string);

  // The tenancy they are living in — or, failing that, the one they have just
  // left. `ended` used to be excluded outright, on the reasoning that a former
  // resident is not owed a live screen about a lot somebody else now lives on.
  // That reasoning is right about the LOT and wrong about the MONEY: the day
  // the office closed her out, her deposit and her final prorated month
  // vanished with the screen, and 0101 raises that final month AFTER the
  // move-out on purpose — so it was a bill she could never see or pay.
  //
  // A live tenancy still wins if she has one. Only when there is none does the
  // ended row carry the screen, and then it renders the wrap-up.
  const stays = mustRead(
    "your tenancy",
    await admin
      .from("lot_reservations")
      .select("id, park_lot_id, renter_id, during, term, status, expected_move_out, tenancy_began_on, moved_out_on")
      .in("renter_id", renterIds)
      .in("status", ["approved", "active", "ended"])
      .order("created_at", { ascending: false }),
  );
  const liveStay = (stays ?? []).find((r) => (r.status as string) !== "ended");
  const stay = liveStay ?? stays?.[0];
  if (!stay) return null;
  const tenancyEnded = liveStay
    ? null
    : ((stay.moved_out_on as string | null) ?? (stay.expected_move_out as string | null) ?? null);

  const file = files.find((f) => f.id === stay.renter_id) ?? files[0];
  const range = parseDaterange(stay.during as string);

  // EVERYTHING THAT ONLY NEEDED THE TENANCY, IN ONE TRIP.
  //
  // These were six round trips in a row, and only ONE of them had to be: the
  // claims read below genuinely needs the bill's id. The rest each depend on
  // `stay`, `file` or `user` — all known here — and were sequential purely
  // because they were written one after another. Measured on a real render:
  // park_renters 289ms, lot_reservations 90, park_lots 77, parks 632,
  // payment_methods 793, park_charges 75, claims 80, park_payments 383,
  // properties 67 — four and a half seconds, most of it spent queueing.
  //
  // Each still answers or throws; see mustRead. What they feed is what a
  // person acts on: the lot number she'd quote to the office, the park's name,
  // whether a Pay button appears at all, the percentage added if she uses it,
  // what she owes, what she has paid, and her deposit.
  const [lotRes, parkRes, cardsRes, chargesRes, paysRes, propsRes, reqsRes] = await Promise.all([
    // `qr_token` because the "What you reported" card asserts a sticker on
    // her pedestal. No lot at The Haven has one — a token exists only after
    // the office runs mintStickers and physically fixes them — so the card
    // sent a household with a leaking riser outside to scan something that is
    // not there, from a screen with no other way to report anything.
    admin.from("park_lots").select("lot_number, qr_token").eq("id", stay.park_lot_id as string).maybeSingle(),
    admin.from("parks").select("name, accepts_online_rent, card_fee_pct").eq("id", file.park_id as string).maybeSingle(),
    admin.from("payment_methods").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    admin
      .from("park_charges")
      .select("id, period_month, due_on, amount, paid_total, status, lines")
      .eq("reservation_id", stay.id as string)
      .neq("status", "void")
      .order("period_month", { ascending: false })
      .limit(24),
    admin
      .from("park_payments")
      .select("amount, fee_amount, method, received_on, receipt_no, kind, returned_on, reversed_at")
      .eq("renter_id", file.id as string)
      .order("received_on", { ascending: false })
      .limit(24),
    admin
      .from("properties")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("park_id", file.park_id as string),
    // Also only needs the tenancy. Conditional, because a tenancy with no
    // parsable start has no window to scope the list to — and an unscoped one
    // would show a new resident the LAST household's broken step.
    range?.start
      ? admin
          .from("park_requests")
          .select("note, status, resolution_note, created_at")
          .eq("park_lot_id", stay.park_lot_id as string)
          .gte("created_at", `${range.start}T00:00:00Z`)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null, error: null }),
  ]);
  const lot = mustRead("your lot", lotRes);
  const park = mustRead("your park", parkRes);
  const cards = mustCount("your saved cards", cardsRes);

  // ---- the bill -----------------------------------------------------------
  // The LATEST charge, not "this month's". A month the park has not billed yet
  // has no row, and showing $0.00 for it would read as "you are square" when
  // the truth is "the bill has not been sent".
  //
  // AND A FAILED READ MUST NOT LOOK LIKE AN UNSENT BILL. `bill: null` renders
  // no rent card at all, which reads as "nothing is owed" — the most expensive
  // wrong impression on the screen.
  const charges = mustRead("your bill", chargesRes);
  const charge = charges?.[0];
  // EVERY EARLIER MONTH SHE STILL OWES ON, oldest first — the ones `.limit(1)`
  // used to drop off the screen the moment the next month was raised.
  const older = (charges ?? [])
    .slice(1)
    .filter((c) => Number(c.amount ?? 0) - Number(c.paid_total ?? 0) > 0.005)
    .reverse();

  // THE OPEN CLAIM, not just whether there is one. `park_payment_claims` is
  // specifically "I already paid this" — the date is the thing the resident
  // most wants read back to them, and a screen that says only "you disputed
  // it" describes something they never did.
  //
  // ACROSS EVERY BILL ON SCREEN, not just the newest. An arrears month she has
  // already told the office about must show the same "nothing is being chased"
  // line and must NOT offer to take payment again — the same rule as the
  // current month, applied to the months that used to be invisible.
  const claimedOn = new Map<string, string | null>();
  const billIds = (charges ?? []).map((c) => c.id as string);
  if (billIds.length > 0) {
    // A swallowed error here says "no open claim", which un-says the "nothing
    // is being chased" banner and puts the Pay button back on a bill they have
    // already told the office they paid. `payRent` would still refuse it
    // server-side, so no money moves — but the screen would be inviting a
    // second payment, which is not a thing to be relaxed about.
    const claims = mustRead(
      "what you've told the office",
      await admin
        .from("park_payment_claims")
        .select("charge_id, claimed_paid_on")
        .in("charge_id", billIds)
        .is("resolved_at", null),
    );
    for (const c of claims ?? []) {
      const key = c.charge_id as string;
      if (!claimedOn.has(key)) claimedOn.set(key, (c.claimed_paid_on as string | null) ?? null);
    }
  }
  /** One charge row shaped for the screen. Used for the current bill and each
   *  arrears month, so they cannot drift apart. */
  const toBill = (c: Record<string, unknown>): Bill => {
    const amt = Number(c.amount ?? 0);
    const paid = Number(c.paid_total ?? 0);
    return {
      id: c.id as string,
      monthLabel: prettyMonth(c.period_month as string),
      dueOn: c.due_on as string,
      amount: amt,
      paidTotal: paid,
      outstanding: Math.round((amt - paid) * 100) / 100,
      status: (c.status as string) ?? "open",
      disputed: claimedOn.has(c.id as string),
      claimedPaidOn: claimedOn.get(c.id as string) ?? null,
      lines: ((c.lines as { label?: string; amount?: number; basis?: string }[]) ?? []).map((l) => ({
        label: String(l.label ?? "Rent"),
        amount: Number(l.amount ?? 0),
        // Older charges were frozen before this was carried through, so a
        // missing basis is a real state and reads as no explanation rather
        // than an empty one.
        basis: l.basis == null ? null : String(l.basis),
      })),
    };
  };

  // ---- money in -----------------------------------------------------------
  // This one read produces BOTH the receipt list and the deposit figure. An
  // error swallowed here prints "Nothing recorded yet" to somebody holding a
  // receipt, and "None held" to somebody whose deposit is $500 — and the
  // deposit is, in this business, the single most argued-about number there is.
  const pays = mustRead("your payments", paysRes);

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
  //
  // THE ONE READ ON THIS SCREEN THAT DEGRADES INSTEAD OF FAILING. Everything
  // above is identity or money and is worth withholding the page over. A list
  // of things they reported about the lot is not — nobody should lose sight of
  // their rent balance because a maintenance query timed out.
  //
  // But "Nothing yet" is still a lie when the truth is "we couldn't look", so
  // the flag travels to the screen and the screen has to say so. `softRead`
  // returns a pair rather than a bare fallback precisely so that ignoring the
  // failure would mean writing code that visibly ignores it.
  let reported: RenterHome["reported"] = [];
  let reportedFailed = false;
  if (range?.start) {
    const [reqs, failed] = softRead("what you've reported", reqsRes, null);
    reportedFailed = failed;
    reported = (reqs ?? []).map((r) => ({
      note: (r.note as string) ?? "",
      status: (r.status as string) ?? "new",
      resolutionNote: (r.resolution_note as string) ?? null,
      // LAKE CALENDAR DAYS, NOT ELAPSED HOURS. Flooring elapsed time called a
    // report filed at 8pm last night "today" all the next morning. This
    // expression exists twice — here and on the other screen that shows the
    // same rows — so both were wrong in the same way.
    ageDays: lakeDaysSince(r.created_at as string, todayLakeDate()),
    }));
  }

  // Their lot as a bookable place. Found by OWNER, never by a pointer on the
  // tenancy — 0107 dropped that column and 0062's renewal chain is why.
  const lotProps = mustCount("your lot's service setup", propsRes);

  return {
    parkName: (park?.name as string) ?? "your park",
    // TWO CONDITIONS, NOT ONE. `accepts_online_rent` is the park's WISH; a
    // connected processor is what makes it possible. The Haven has the flag on
    // and there is no processor, so this rendered a gold "Pay $542.53" button,
    // a confirm panel naming her card, and a decline every single time. The
    // charge gate made that failure honest; it left the offer standing.
    //
    // Hidden rather than disabled on purpose: right below it is the "I already
    // paid" form, which is the path that actually works today. A dead button
    // above a live one teaches her the screen is broken.
    acceptsOnlineRent: Boolean(park?.accepts_online_rent) && paymentsAreLive(),
    hasCard: (cards ?? 0) > 0,
    bookingReady: (lotProps ?? 0) > 0,
    cardFeePct: Number(park?.card_fee_pct ?? 0),
    today: todayLakeDate(),
    lotNumber: (lot?.lot_number as string) ?? "—",
    // Whether the sticker the report card talks about actually exists.
    hasSticker: lot?.qr_token != null,
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
    bill: charge ? toBill(charge) : null,
    arrears: older.map(toBill),
    tenancyEnded,
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
    reportedFailed,
  };
}
