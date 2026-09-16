import "server-only";
import { chainReservationIds } from "@/lib/tenancy-chain";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { prettyMonth } from "@/app/park/ledger-helpers";
import { parseDaterange } from "@/lib/parks";
import { coversDay, lapsedRowOf } from "@/app/park/park-helpers";
import { notCollectedAt, takenBackWhy, takenBackOfRow } from "@/app/park/receipts-helpers";
import { todayLakeDate, lakeDaysSince } from "@/lib/booking";
import { paymentsAreLive } from "@/lib/charge-gate";
import { mustRead, mustCount, softRead } from "@/lib/must-read";
import { surchargePct } from "@/app/parks/card-fee";
import { withRaisedAgain, type AllocationLine } from "@/lib/allocations";

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
  /**
   * DOLLARS OF THIS BILL SETTLED FROM MONEY SHE HAD ON ACCOUNT (0167) — the
   * quarter paid ahead, the excess over an earlier bill. Counted inside
   * `paidTotal` already (recompute_charge_paid adds allocations); carried
   * separately so "Paid in full" can say HOW, because the payment list shows
   * one $1,627.59 cheque and no $542.53 — and a resident tying the two
   * together is exactly who rings the office. Zero when nothing on account
   * touched it.
   */
  fromOnAccount: number;
  /**
   * AND WHEN THAT MONEY HAD BEEN PAID ON A BILL THE OFFICE CANCELLED (0169).
   * She paid January in full; she left on the 20th; the office cancelled the
   * whole-month bill and raised the part month, which was settled from the
   * money the cancelled bill released. "$472.53 of it came from money you
   * had on account" is then a sentence about money she never put on account
   * — she paid a January bill, and her list shows that cheque against
   * January. This names the bills it was paid on: `months` is their YYYY-MM,
   * sorted (prettyMonth at the edge), `amount` the dollars of THIS bill that
   * came from them together — counted inside `fromOnAccount` already, so the
   * two are nested, not added. Null when none of it did. Membership in the
   * on-account view (released_from_month set) is the test, never the
   * payment's charge_id.
   *
   * A LIST, because the close-out cascade writes two. January part-paid by
   * cheque, February raised early and paid in full, the move-out recorded
   * after both: endTenancy cancels both bills, and the part month is settled
   * from both cancelled bills' money (finalMonthNow, park/actions.ts). One
   * month named here left the other's cheque read as "money you had on
   * account" — money she never put there.
   */
  fromCancelledBill: { months: string[]; amount: number } | null;
}

export interface RenterHome {
  parkName: string;
  /**
   * WHERE SHE TAKES THE MONEY, when there is no card to pay with.
   *
   * The bill screen showed what she owed, offered nothing but "I've already
   * paid this", and said nowhere to take it. Seventeen of The Haven's
   * eighteen households pay cash or cheque, so for almost all of them the
   * only control on the screen invited them to assert something untrue.
   *
   * Null when the park has no address on file — the sentence is then written
   * without one rather than printing "undefined" at somebody.
   */
  parkAddress: string | null;
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
  /**
   * Set once they have given notice — on ANY live link in her chain, the rule
   * the owner's Today screen uses. A renewal is a successor row written in
   * the agreement's last half, and the notice stands on the link the roll
   * called current; read off the newest row alone, the February successor
   * carried no notice and this screen said "rolls on" to somebody who had
   * given it.
   */
  leavingOn: string | null;

  /** True when the park has agreed to take rent through LakeLife (0108). */
  acceptsOnlineRent: boolean;
  /** They need a card before any pay button is worth showing. */
  hasCard: boolean;
  /** True once their lot has been minted as a bookable place. */
  bookingReady: boolean;
  /**
   * Percent that will ACTUALLY be added when they tap Pay, on the card that
   * will actually be charged. 0 = no fee, and the screen says so out loud.
   *
   * Not `parks.card_fee_pct` — that is the park's dial, and it may only reach
   * a credit card (card-fee.ts). Quoting the dial to somebody holding a debit
   * card would name a fee the charge never takes.
   */
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
  /**
   * WHETHER THE MOVE-OUT MONTH HAS ALREADY BEEN BILLED — a non-void charge
   * for that month anywhere in her chain. False while the tenancy stands.
   * The on-account card's "it comes off your bills, oldest first" is true
   * right up to the last bill; once the final month is billed there is no
   * next bill for it to come off, and the card must stop promising one. A
   * move-out recorded before that month's run still raises a prorated final
   * bill, which money on account settles — so `tenancyEnded` alone is not
   * the test.
   */
  finalMonthBilled: boolean;

  /** Deposit still held. Null when there has never been one, or none is held any more. */
  deposit: { amount: number; since: string } | null;
  /**
   * A DEPOSIT HANDED BACK TO HER — the most recent one, when any was. The
   * card read "None held." the day after the office returned $500 across the
   * window, which is true and says nothing about the single most argued-
   * about number in this business. The record is the stamp on the deposit
   * row (returned_on, returned_amount — 0102); this is that stamp, read.
   */
  depositReturned: { amount: number; on: string } | null;

  /**
   * RENT MONEY OF THEIRS STILL ON ACCOUNT — what has not yet been put against
   * a bill. $57.47 handed over with a $600 cheque for a $542.53 month, a
   * quarter paid ahead in December — the rows `recordOnAccount` and the split
   * in `recordPayment` write (kind 'rent', no charge). The office could see it
   * under "Money not against a bill"; the person it belongs to could not see
   * it anywhere, and was chased for the next month in full. Zero when none.
   *
   * WHAT IS LEFT, NOT WHAT ARRIVED (0167). The payment row never moves: a
   * quarter paid ahead keeps `charge_id null` forever while the run puts
   * $542.53 of it against each month as it raises it. Summing `amount` here
   * read $1,627.59 "on account" the morning January was settled from it, and
   * still in March when every cent was spent. This is the view's `remaining`.
   *
   * INCLUDING MONEY A CANCELLED BILL RELEASED (0169). The view lists a
   * payment against a bill the office has since cancelled — the row never
   * moved — so the $70.00 left of her January cheque after the part month
   * took its share is here by the view's own word, with no test of its own.
   *
   * AND NOW A PROMISE THE SOFTWARE KEEPS. Every door settles her OLDEST open
   * bill from it (R1): the run the moment it raises one, the office the
   * moment money is keyed, or by hand — so the screen may say "it comes off
   * your bills, oldest first", which is what she wants to know. Not "next":
   * after the office takes a line back off a bill (R3) the money is on
   * account while that bill is open again, and it is that bill the next run
   * puts it against.
   *
   * Optional only so a view built before this field existed still type-checks;
   * the loader always writes it, and the screen shows nothing when it is
   * absent or zero — which is the truth for every household today.
   */
  onAccount?: number;

  /**
   * `amount` is the RENT. `fee` is the card convenience fee charged on top and
   * is null on every other rail. Two figures because the card statement shows
   * their sum and the rent ledger shows only the first — a resident comparing
   * the two deserves to find the difference here rather than ring the office.
   */
  payments: {
    on: string;
    amount: number;
    fee: number | null;
    method: string;
    receiptNo: number | null;
    /**
     * The day the BANK pulled this payment back after it had settled — an ACH
     * return or a chargeback. Not `returned_on`, which is a deposit the park
     * handed back. Non-null means the money is gone again and the bill it paid
     * has reopened, so the row must not read as money received.
     */
    bankReturnedOn: string | null;
    /**
     * THIS PAYMENT NO LONGER STANDS, by either route: the office took it back
     * (`reversed_at` — a bounced cheque, a typo) or the bank returned it
     * (`returned_at`). The same pair /paid/[token] shows the same resident.
     * Reversed rows used to be dropped from this list on the theory that a
     * reversal "never happened" — so a household holding receipt #101 for a
     * cheque that bounced read "Nothing recorded yet" and two months flipped
     * to unpaid with no sentence saying why. Money received stays the row it
     * was; the correction is these two fields. `takenBackWhy` is the office's
     * reason or the bank's return code, exactly as confirm-server derives it.
     */
    takenBackOn: string | null;
    takenBackWhy: string | null;
    /**
     * MONEY FROM THIS PAYMENT HANDED BACK TO HER ACROSS THE WINDOW (0168) —
     * how much, and the day. The $57.47 of a $600 cheque on account, given
     * back after she left. Zero and null while none has. The row stays at
     * its full amount (money received stays the row it was); this is the
     * record of the money going back, and her on-account card has already
     * stopped counting it. Not to be confused with `bankReturnedOn`, which
     * is the bank pulling the payment back.
     */
    handedBack: number;
    handedBackOn: string | null;
    /**
     * THE BILL THIS PAID WAS CANCELLED (0169), and its money went on account
     * — by the on-account view's word (released_from_month), never the
     * row's charge_id. `month` is that bill's YYYY-MM. Null for every other
     * payment. Before this the released cheque sat on her list at $542.53
     * against nothing, the part month said $472.53 "came from what you'd
     * already paid on the January 2027 bill that was cancelled", and the
     * On account card said $70.00 — and the only way to tie the three
     * together was her own subtraction. The row now says so itself, under
     * the cheque, in the words /paid/[token] already uses.
     */
    releasedFrom: { month: string } | null;
    /**
     * WHERE THIS PAYMENT'S MONEY ON ACCOUNT WENT — its live allocations,
     * each with the month of the bill it went to, and what the view says is
     * STILL held of it (`onAccountRemaining`, the same `remaining` the On
     * account card sums; zero when nothing is, or when nothing of this
     * payment was ever on account). Read, never derived: the lines are the
     * allocation rows scoped to her household above, the remainder is the
     * view's. A line against a bill outside the 24-bill slice on screen
     * carries no month here and is left out of the sentence rather than
     * named as a bill she cannot see. The line against the bill raised
     * again for the cancelled month is marked apart (`raisedAgain`, with
     * that bill's own `billAmount`) the way /paid/[token] marks it, so
     * "Where it went" reads the same on both.
     */
    allocations: AllocationLine[];
    onAccountRemaining: number;
  }[];

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
  // THE LINK THAT COVERS TODAY, the way buildRentRoll picks `current` — not
  // the newest row. A renewal is a successor row written up to 45 days early
  // (renew-actions), and the notice she gave stands on the link the roll
  // called current; picking the newest row read the February successor
  // (no notice) and told her "rolls on". Falls back to the next link to
  // start (signed, not yet moved in), then to the link that LAPSED — a
  // household whose monthly agreement ran out with no successor written is
  // still living there and must not get the wrap-up screen — and only then
  // to the ended row, which carries the wrap-up.
  //
  // "LAPSED" IS THE ROLL'S ONE RULE (lapsedRowOf), which sees the ended
  // rows. "Any live link" was the fallback here, and it could not: a
  // household closed out THROUGH their renewal leaves the link before it
  // approved/active, run out, with nothing held after it — the successor
  // they moved out from is `ended`, a later link all the same — and that
  // run-out link was picked as where she lives. Ten days after she left,
  // her screen was January's lot, not the wrap-up with her final month and
  // her deposit on it. The roll, Today and the nightly all ask lapsedRowOf;
  // so does this.
  const today = todayLakeDate();
  const liveStays = (stays ?? []).filter((r) => (r.status as string) !== "ended");
  const startOf = (r: Record<string, unknown>) => parseDaterange(r.during as string)?.start ?? "";
  const lapsed = lapsedRowOf(
    (stays ?? []).map((r) => ({ row: r, status: String(r.status ?? ""), range: parseDaterange(r.during as string), term: String(r.term ?? "") })),
    today,
  )?.row;
  const liveStay =
    liveStays.find((r) => coversDay(parseDaterange(r.during as string), today))
    ?? [...liveStays].filter((r) => startOf(r) > today).sort((a, b) => startOf(a).localeCompare(startOf(b)))[0]
    ?? lapsed;
  const stay = liveStay ?? stays?.[0];
  if (!stay) return null;
  const tenancyEnded = liveStay
    ? null
    : ((stay.moved_out_on as string | null) ?? (stay.expected_move_out as string | null) ?? null);
  // THE NOTICE, WHEREVER IT STANDS. giveNotice writes ONE link — the roll's
  // current one — and the successor carries nothing; Today already reads
  // every stay for it. At most one live link carries a date.
  const leavingOn = liveStay
    ? (liveStays.map((r) => (r.expected_move_out as string | null) ?? null).find((d) => !!d) ?? null)
    : ((stay.expected_move_out as string | null) ?? null);

  const file = files.find((f) => f.id === stay.renter_id) ?? files[0];
  const range = parseDaterange(stay.during as string);
  // "WHAT YOU REPORTED" IS SCOPED TO HER TIME ON THIS LOT, not to the picked
  // link's start: from the day the owner writes February, a January-start
  // window would drop every report she filed in January and tell her
  // "Nothing yet. Tell the office" about a riser she already reported. The
  // earliest start across her chain on THIS lot — never another lot's, or a
  // previous household's reports would surface.
  const reportedSince = (stays ?? [])
    .filter((r) => r.renter_id === stay.renter_id && r.park_lot_id === stay.park_lot_id)
    .map(startOf)
    .filter(Boolean)
    .sort()[0] ?? range?.start ?? null;

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
  const [lotRes, parkRes, cardsRes, chargesRes, paysRes, propsRes, reqsRes, acctRes, allocRes, releasedRes] = await Promise.all([
    // `qr_token` because the "What you reported" card asserts a sticker on
    // her pedestal. No lot at The Haven has one — a token exists only after
    // the office runs mintStickers and physically fixes them — so the card
    // sent a household with a leaking riser outside to scan something that is
    // not there, from a screen with no other way to report anything.
    admin.from("park_lots").select("lot_number, qr_token").eq("id", stay.park_lot_id as string).maybeSingle(),
    admin.from("parks").select("name, address, accepts_online_rent, card_fee_pct").eq("id", file.park_id as string).maybeSingle(),
    // THE CARD payRent WILL ACTUALLY CHARGE, not a head-count of cards.
    // Same table, same `is_default` ordering, same limit as the action — the
    // fee quoted on the confirm panel has to be resolved from the same row the
    // charge is resolved from, or the screen names one number and the
    // processor takes another.
    admin.from("payment_methods").select("funding").eq("user_id", user.id).order("is_default", { ascending: false }).limit(1),
    admin
      .from("park_charges")
      .select("id, period_month, due_on, amount, paid_total, status, lines")
      // ACROSS HER WHOLE CHAIN AT THIS PARK, not the newest row alone. A
      // renewal is a successor row and every bill is pinned to the agreement
      // whose month it is — so reading one id dropped every bill under the
      // previous agreement the moment the office wrote the next one, up to 45
      // days early, and she read "Nothing to pay right now" while her current
      // month sat open. See lib/tenancy-chain.
      .in("reservation_id", chainReservationIds(
        (stays ?? []) as { id: string; renter_id: string }[],
        stay as { id: string; renter_id: string },
      ))
      .neq("status", "void")
      .order("period_month", { ascending: false })
      .limit(24),
    admin
      .from("park_payments")
      // `returned_at` is the BANK pulling a settled payment back (0155), and
      // it is not `returned_on`, which is this park handing money back across
      // the window — a deposit (0102), rent on account (0168) — with
      // `returned_amount` saying how much. Both are on this row, one letter
      // apart, and the list below reads both.
      // `id` so the row can be tied to its allocations and to the view's
      // remaining — the same keys the office's screens use.
      .select("id, amount, fee_amount, method, received_on, receipt_no, kind, returned_on, returned_amount, reversed_at, reversed_reason, returned_at, return_code")
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
    reportedSince
      ? admin
          .from("park_requests")
          .select("note, status, resolution_note, created_at")
          .eq("park_lot_id", stay.park_lot_id as string)
          .gte("created_at", `${reportedSince}T00:00:00Z`)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null, error: null }),
    // Money on account — the SAME view getHeldMoney lists for the office
    // (0167): kind rent, no charge, still standing, with the database's own
    // `remaining` after allocations and refunds. Its own read rather than a
    // filter over the 24-row receipt slice above, because a row older than
    // that slice is still their money. Only what is still held: a cheque
    // every cent of which has gone to bills is not money on account.
    admin
      .from("park_on_account_payments")
      .select("payment_id, remaining")
      .eq("renter_id", file.id as string)
      .gt("remaining", 0),
    // WHERE HER MONEY ON ACCOUNT HAS GONE — the allocations from HER payments,
    // scoped through the payment's household (the FK to park_payments), so the
    // read only needs the file and can sit in this trip. Keyed by bill below,
    // so a settled month can say "$542.53 of it from money you had on
    // account" beside a payment list that shows one $1,627.59 cheque.
    // The payment's own standing comes along: an allocation SURVIVES a
    // reversal as record (0167), so a bounced cheque's rows are skipped below
    // rather than read as money that paid the month. And LIVE LINES ONLY: a
    // line the office took back off its bill (R3, removed_at set) is the
    // record of a correction — the view and the recompute leave it out, and
    // so does this, or February would read "$542.53 of it came from money
    // you had on account" the day after that money went back on account.
    admin
      .from("park_payment_allocations")
      .select("charge_id, payment_id, amount, park_payments!inner(renter_id, reversed_at, returned_at)")
      .eq("park_payments.renter_id", file.id as string)
      .is("removed_at", null),
    // WHERE HER MONEY ON ACCOUNT CAME FROM (0169): the same view, every row
    // of hers whether or not anything is left on it, with the month of the
    // cancelled bill a released row was paid on. Its own read rather than
    // the one above, because that one keeps only what is still held — and
    // the part month settled in full from released money is exactly the
    // case where nothing is left. A released row's money is spoken of as
    // "what you'd already paid on the January 2027 bill that was cancelled",
    // never as money she had on account.
    admin
      .from("park_on_account_payments")
      .select("payment_id, released_from_month")
      .eq("renter_id", file.id as string),
  ]);
  const lot = mustRead("your lot", lotRes);
  const park = mustRead("your park", parkRes);
  // Their default card, which is the one payRent charges. mustRead, so a
  // failed read still refuses rather than rendering "add a way to pay" at
  // somebody who has one.
  const cards = mustRead("your saved cards", cardsRes) as Array<{ funding: string | null }> | null;
  const defaultCard = (cards ?? [])[0] ?? null;

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
  // WHAT EACH BILL GOT FROM MONEY ON ACCOUNT, in cents per bill. A failed
  // read here would render "Paid in full — thank you" with no word of how,
  // under a payment list that shows no payment for that month — the shape of
  // sentence that sends somebody to the office to ask where their money went.
  // mustRead, like every other money read on this screen.
  const allocRows = mustRead("where your money on account went", allocRes);
  // WHICH OF HER PAYMENTS ARE MONEY A CANCELLED BILL RELEASED (0169), by the
  // view's own word — a failed read here would print "came from money you
  // had on account" about a January cheque she can see on her own list.
  const releasedMonthOf = new Map<string, string>();
  for (const r of mustRead("where your money came from", releasedRes) ?? []) {
    if (r.released_from_month != null) releasedMonthOf.set(r.payment_id as string, String(r.released_from_month));
  }
  const fromOnAccountCents = new Map<string, number>();
  // Per bill, per cancelled bill's month: the cents that came from it.
  const fromCancelledCents = new Map<string, Map<string, number>>();
  // Per PAYMENT: the bills its money on account went to. The bills read
  // above are the only ones in hand — the whole row, not its month alone,
  // because the line against a bill raised again needs that bill's frozen
  // lines and amount (below).
  const billOf = new Map((charges ?? []).map((c) => [c.id as string, c]));
  const wentTo = new Map<string, AllocationLine[]>();
  for (const a of allocRows ?? []) {
    // A reversed or bank-returned cheque's allocations are the record of
    // where it HAD gone; recompute_charge_paid no longer counts them and
    // neither does this. PostgREST embeds a many-to-one as an object.
    const raw = a.park_payments as unknown;
    const pay = (Array.isArray(raw) ? raw[0] : raw) as { reversed_at?: unknown; returned_at?: unknown } | null;
    if (pay?.reversed_at != null || pay?.returned_at != null) continue;
    const key = a.charge_id as string;
    const c = Math.round(Number(a.amount ?? 0) * 100);
    fromOnAccountCents.set(key, (fromOnAccountCents.get(key) ?? 0) + c);
    // The same line, keyed the other way — by the payment it came off — for
    // the sentence under the cheque. Only a bill in hand can be named.
    const month = releasedMonthOf.get(a.payment_id as string);
    const bill = billOf.get(key);
    if (bill != null && c > 0) {
      // THE BILL RAISED AGAIN FOR THE CANCELLED MONTH is named apart (0169),
      // as /paid/[token] names it. A move-out cancels January and raises
      // January again for the days they were here — same month, two bills
      // — and "$472.53 to January 2027" one sentence after "the January
      // 2027 bill this paid was cancelled" read as money put against the
      // bill just cancelled. The one decision of which line collides is
      // lib/allocations' (withRaisedAgain: the line whose month is the
      // released-from month — every live line in that month IS the
      // re-raise, since 0169's guard refuses to cancel a bill with live
      // lines on it); the re-raised bill's own amount rides on that line
      // alone so every ordinary line keeps its shape.
      const line = withRaisedAgain(
        { periodMonth: String(bill.period_month ?? ""), amount: c / 100 },
        month ?? null,
        bill.lines,
      );
      const mine = wentTo.get(a.payment_id as string) ?? [];
      mine.push(line.raisedAgain && bill.amount != null ? { ...line, billAmount: Number(bill.amount) } : line);
      wentTo.set(a.payment_id as string, mine);
    }
    if (month == null) continue;
    const byMonth = fromCancelledCents.get(key) ?? new Map<string, number>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + c);
    fromCancelledCents.set(key, byMonth);
  }
  /**
   * EVERY cancelled bill this bill drew from, and how much from them
   * together. The close-out cascade settles a part month from two cancelled
   * bills' money when the household had paid the month after as well, so
   * naming one month would leave the other cheque unaccounted for on her
   * screen. Months sorted; the amount is the sum, in cents until the edge.
   */
  const fromCancelledBill = (chargeId: string): Bill["fromCancelledBill"] => {
    const byMonth = fromCancelledCents.get(chargeId);
    if (!byMonth) return null;
    const months = [...byMonth.keys()].sort();
    const c = [...byMonth.values()].reduce((sum, n) => sum + n, 0);
    return c > 0 ? { months, amount: c / 100 } : null;
  };

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
      fromOnAccount: (fromOnAccountCents.get(c.id as string) ?? 0) / 100,
      fromCancelledBill: fromCancelledBill(c.id as string),
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

  // `live` feeds the DEPOSIT maths only. The receipt list below is built from
  // every row: a reversed payment is not money, but it is a receipt she
  // holds, and the screen says what became of it rather than pretending it
  // was never written.
  const live = (pays ?? []).filter((p) => p.reversed_at == null);

  // A deposit is money of theirs the park is holding — the single most
  // disputed number in this business, eighteen months later at move-out. It
  // sits on the front page all year so that argument never happens.
  // THREE WAYS A DEPOSIT STOPS BEING HELD, and only two were checked. It can
  // be reversed (`live`, above — it never happened), handed back at move-out
  // (`returned_on`), or the bank can pull the original debit back after it
  // settled (`returned_at`, 0155). The third arrived with its balance readers
  // wired and its DISPLAY readers not, so this figure would have gone on
  // claiming the park holds money that left its account days ago.
  const heldDeposits = live.filter(
    (p) => p.kind === "deposit" && p.returned_on == null && p.returned_at == null,
  );
  const depositTotal = heldDeposits.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const depositSince = heldDeposits
    .map((p) => p.received_on as string)
    .sort()[0] ?? null;
  // THE DEPOSIT THAT WENT BACK — the most recent stamp, so the card can say
  // "$500.00 was handed back to you on January 28, 2027" instead of "None
  // held." over a return she is waiting on. A deposit the office reversed
  // never happened and carries no stamp.
  const depositReturned = live
    .filter((p) => p.kind === "deposit" && p.returned_on != null && Number(p.returned_amount ?? 0) > 0)
    .sort((a, b) => String(b.returned_on).localeCompare(String(a.returned_on)))
    .map((p) => ({ amount: Number(p.returned_amount), on: String(p.returned_on) }))[0] ?? null;

  // A failed read here would print "nothing on account" at somebody who handed
  // over $57.47 more than the bill last week. mustRead, like the deposit.
  // WHAT IS STILL HELD — the view's `remaining` — never the cheque's amount.
  const acctRows = mustRead("money you have on account", acctRes);
  const onAccount = Math.round(
    (acctRows ?? []).reduce((sum, p) => sum + Number(p.remaining ?? 0), 0) * 100,
  ) / 100;
  // The same rows by payment, so the cheque the $70.00 is left of can say
  // so on its own line, and the card and the row cannot disagree.
  const remainingOf = new Map<string, number>();
  for (const p of acctRows ?? []) remainingOf.set(p.payment_id as string, Number(p.remaining ?? 0));

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
  if (reportedSince) {
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
    parkAddress: ((park?.address as string) ?? "").trim() || null,
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
    hasCard: defaultCard != null,
    bookingReady: (lotProps ?? 0) > 0,
    cardFeePct: surchargePct(park?.card_fee_pct, defaultCard?.funding),
    today,
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
    leavingOn,
    bill: charge ? toBill(charge) : null,
    arrears: older.map(toBill),
    tenancyEnded,
    // The move-out month has a bill — a non-void charge for that month in her
    // chain. `charges` is newest-first and skips void, and the final month is
    // the newest, so it is inside the slice read above.
    finalMonthBilled: !!tenancyEnded
      && (charges ?? []).some((c) => String(c.period_month ?? "") === tenancyEnded.slice(0, 7)),
    deposit: depositTotal > 0 && depositSince
      ? { amount: depositTotal, since: depositSince }
      : null,
    depositReturned,
    onAccount,
    payments: (pays ?? [])
      .filter((p) => p.kind !== "deposit")
      // TWENTY-FOUR, NOT SIX, AND THE SCREEN SAYS WHEN IT IS SHOWING A SLICE.
      //
      // The move-out card promises "Your receipts stay too, so you can always
      // show what you paid." At six, her seventh monthly payment silently
      // pushed the oldest off with nothing saying more existed — and this is
      // the only payment history a resident ever sees, so it is also what she
      // would reach for to prove she paid a month the park is chasing her for.
      // The read above already fetches 24; the cap was throwing away rows it
      // had paid for.
      .slice(0, 24)
      .map((p) => ({
        on: p.received_on as string,
        amount: Number(p.amount ?? 0),
        fee: p.fee_amount == null ? null : Number(p.fee_amount),
        method: (p.method as string) ?? "payment",
        receiptNo: (p.receipt_no as number) ?? null,
        // KEPT ON THE LIST, NOT HIDDEN — BY EITHER ROUTE. A BANK RETURN says
        // the payment happened and then came back; the resident's own
        // statement shows both legs, and a screen that quietly dropped our
        // copy would make us look wrong about their money. A REVERSAL is the
        // office's word for a cheque that bounced or a number keyed wrong —
        // and at a park where 17 of 18 pay by cheque, a bounce IS a reversal
        // (the database refuses `returned_at` on a cheque). She holds the
        // receipt; the row shows, labelled with the day and the reason, and
        // counts toward nothing. The reason is already hers to read on
        // /paid/[token]; this is the same sentence on the screen she opens
        // first — from the ONE derivation (receipts-helpers) every reader of
        // these four fields shares.
        bankReturnedOn: (p.returned_at as string) ?? null,
        takenBackOn: notCollectedAt(takenBackOfRow(p)),
        takenBackWhy: takenBackWhy(takenBackOfRow(p)),
        // Money from this payment handed back across the window (0168): the
        // stamp on the row, read — so the $57.47 she was handed after she
        // left is under the cheque it came off, and her on-account card
        // (the view's remaining) and this row agree.
        handedBack: p.returned_on != null ? Number(p.returned_amount ?? 0) : 0,
        handedBackOn: p.returned_on != null && Number(p.returned_amount ?? 0) > 0 ? String(p.returned_on) : null,
        // The bill this paid was cancelled (0169) — by the view's word — and
        // where its money is now: the allocations keyed by this payment
        // above, and the view's remaining. Both maps are already in hand;
        // the row was the one reader of neither.
        releasedFrom: releasedMonthOf.has(p.id as string) ? { month: releasedMonthOf.get(p.id as string) as string } : null,
        allocations: wentTo.get(p.id as string) ?? [],
        onAccountRemaining: remainingOf.get(p.id as string) ?? 0,
      })),
    reported,
    reportedFailed,
  };
}
