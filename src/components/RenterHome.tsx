import Link from "next/link";
import type { RenterHome as RenterHomeView, Bill } from "@/app/parks/my-data";
import { PayRentButton } from "@/components/PayRentButton";
import { IPaidForm } from "@/components/IPaidForm";
import { TextOptIn } from "@/components/TextOptIn";
import { EnableLotBooking } from "@/components/EnableLotBooking";
import { money, monthList } from "@/app/park/ledger-helpers";
import { describeAllocations } from "@/lib/allocations";
import { releasedLead } from "@/lib/released-words";
import { longDay } from "@/lib/lake-time";

/**
 * WHAT THE RESIDENT SEES.
 *
 * The park owner has had a rent roll, a ledger, a visits board and a task list
 * since the module shipped. This is the first screen built for the person
 * paying the rent.
 *
 * THE DIVIDER NEAR THE BOTTOM IS LOAD-BEARING. Rent above it is owed to the
 * PARK; services below it are owed to LAKELIFE. They are never added together
 * and never netted, and the sentence under the heading says so — because a
 * platform that withheld a mow over late rent would have become a debt
 * collector without anybody deciding to.
 */

/**
 * "3 July 2026" — a date a person reads, never 2026-07-03. FOR A BARE DATE
 * ONLY (YYYY-MM-DD): it splits on "-", so a timestamptz such as `reversed_at`
 * or `returned_at` comes out "Invalid Date". Those go through `longDay` from
 * lib/lake-time, which parses a timestamp on the lakes' clock.
 */
function pretty(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

/** The two figures every "where did the money come from" sentence reads. */
type Source = Pick<Bill, "fromOnAccount" | "fromCancelledBill">;

/**
 * WHAT WAS PAID ON A BILL THE OFFICE CANCELLED (0169) — "what you'd already
 * paid on the January 2027 bill that was cancelled". She paid January; she
 * left on the 20th; the office cancelled the whole-month bill and raised
 * the part month, settled from the money the cancelled bill released. Her
 * list shows that cheque against January, so "money you had on account" is
 * a sentence about money she never put on account. Said in her words.
 *
 * AND BOTH BILLS WHEN THERE WERE TWO — "the January 2027 and February 2027
 * bills that were cancelled". The close-out cascade settles a part month
 * from a part-paid January AND a February she had paid ahead; naming one
 * left her February cheque read as "money you had on account". `monthList`
 * is the one joiner (ledger-helpers), never a second copy.
 */
function cancelledBillWords(c: NonNullable<Bill["fromCancelledBill"]>): string {
  const bills = c.months.length === 1 ? "bill that was" : "bills that were";
  return `what you'd already paid on the ${monthList(c.months)} ${bills} cancelled`;
}

/**
 * The part of `fromOnAccount` that is NOT a cancelled bill's money — a
 * cheque she put on account, the excess over an earlier bill. Two figures
 * from the same allocation rows, nested by the loader (every cancelled
 * bill's share, summed, is counted inside `fromOnAccount`), so the rest is
 * what is left of the one after the other. Zero when all of it was released
 * money.
 */
function plainOnAccount(b: Source): number {
  if (!b.fromCancelledBill) return b.fromOnAccount;
  return Math.max(0, Math.round((b.fromOnAccount - b.fromCancelledBill.amount) * 100)) / 100;
}

/**
 * "$542.53 of it came from money you had on account." — the sentence a settled
 * or part-settled bill adds when money on account paid some of it (0167).
 * Said in her words: she "had money on account"; the run "put it against"
 * the bill. Only ever rendered when the figure is above zero.
 *
 * WHEN THAT MONEY WAS A CANCELLED BILL'S (0169): "$472.53 of it came from
 * what you'd already paid on the January 2027 bill that was cancelled." —
 * and, if some of it was ordinary money on account too, that after it, so
 * the $57.47 of a $600 cheque is not left unaccounted for.
 */
function fromOnAccountWords(b: Source): string {
  const c = b.fromCancelledBill;
  if (!c) return `${money(b.fromOnAccount)} of it came from money you had on account.`;
  const rest = plainOnAccount(b);
  return `${money(c.amount)} of it came from ${cancelledBillWords(c)}`
    + (rest > 0 ? `, and ${money(rest)} from money you had on account.` : ".");
}

/**
 * "$300.00 received so far — $100.00 of it from money you had on account."
 *
 * `paidTotal` already counts what came off money on account
 * (recompute_charge_paid adds allocations), so the two figures are nested,
 * not added. When ALL of it came off money on account there is no cheque
 * for this month on her list, and the sentence says so in one breath.
 *
 * AND THE SAME THREAD FOR A CANCELLED BILL'S MONEY (0169): a $400 cheque on
 * January released against a $472.53 part month reads "$400.00 received so
 * far — all of it from what you'd already paid on the January 2027 bill
 * that was cancelled." — never "from money you had on account" about the
 * cheque she can see against January on her own list.
 */
function receivedSoFar(b: { paidTotal: number } & Source): string {
  const head = `${money(b.paidTotal)} received so far`;
  if (b.fromOnAccount <= 0) return `${head}.`;
  const c = b.fromCancelledBill;
  if (c) {
    const all = Math.round(c.amount * 100) >= Math.round(b.paidTotal * 100);
    const rest = plainOnAccount(b);
    return `${head} — ${all ? "all of it" : `${money(c.amount)} of it`} from ${cancelledBillWords(c)}`
      + (rest > 0 ? `, and ${money(rest)} from money you had on account.` : ".");
  }
  if (Math.round(b.fromOnAccount * 100) >= Math.round(b.paidTotal * 100)) {
    return `${head} — from money you had on account.`;
  }
  return `${head} — ${money(b.fromOnAccount)} of it from money you had on account.`;
}

/** The three fields the released cheque's own line reads. */
type Released = Pick<RenterHomeView["payments"][number], "releasedFrom" | "allocations" | "onAccountRemaining">;

/**
 * "The January 2027 bill this paid was cancelled, so this money went on
 * account with the office. Where it went: $472.53 to the $472.53 bill
 * raised again for January 2027 (27 of 31 days), $70.00 on account." —
 * under the cheque, so the $70.00 on her card is tied to the cheque it is
 * left of. The lead is /paid/[token]'s, from the ONE place both read it
 * (lib/released-words — that page also names the day, which this loader
 * does not read); the three states after it are that page's too: applied,
 * held, or gone — and when it has gone the handed-back line under this one
 * says where. The January raised again is named apart from the January
 * cancelled because the loader marks that line (withRaisedAgain) and
 * describeAllocations prints the mark — nothing here decides which line
 * collides. Empty for a payment no cancelled bill released.
 */
function releasedWords(p: Released): string {
  if (!p.releasedFrom) return "";
  const lead = releasedLead(p.releasedFrom.month);
  const applied = p.allocations.some((l) => l.amount > 0);
  if (applied) return `${lead} Where it went: ${describeAllocations(p.allocations, p.onAccountRemaining)}.`;
  return p.onAccountRemaining > 0 ? `${lead} It's held for you.` : `${lead} None of it is still held.`;
}

/**
 * HOW TO PAY, WHEN THERE IS NO BUTTON TO TAP.
 *
 * THE WORST GAP ON THIS SCREEN. With online rent off — every park without a
 * processor, including The Haven in January — the pay button renders nothing,
 * and the only control left invites her to declare she has ALREADY paid. The
 * screen showed $542.53 owed and said nowhere on earth to take it. Seventeen
 * of The Haven's eighteen households pay cash or a cheque, so that was almost
 * all of them.
 *
 * The sentence does exist elsewhere: in the invite email and on an overdue
 * notice. Both are messages, both sit behind `parks.notices_held_at`, and the
 * overdue one only fires once the office has already chased her. Neither is on
 * the screen she opens on the 1st.
 *
 * RENDERED ONCE, above the months, and NOT inside the bill card — a household
 * whose January is paid and December is not has no current outstanding bill,
 * so a sentence living in that card would vanish for exactly the person most
 * in need of it.
 */
function HowToPay({ parkName, parkAddress }: { parkName: string; parkAddress: string | null }) {
  return (
    <p className="mut" style={{ fontSize: 13, margin: "10px 0 0", lineHeight: 1.6 }}>
      {parkName} doesn&apos;t take card payments through LakeLife yet
      {parkAddress ? <> — pay the office at {parkAddress}</> : " — pay the office"},
      the same way you do now. Once you have, tap &ldquo;I&apos;ve already paid
      this&rdquo; so it shows here while the office confirms it.
    </p>
  );
}

export function RenterHome({ view }: { view: RenterHomeView }) {
  const b = view.bill;

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 48, maxWidth: 620 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Lot {view.lotNumber}</h1>
        <span className="mut" style={{ fontSize: 14 }}>{view.parkName}</span>
        {view.leavingOn && (
          <span className="ll-pill warn" style={{ marginLeft: "auto" }}>
            Leaving {pretty(view.leavingOn)}
          </span>
        )}
      </div>
      <p className="mut" style={{ fontSize: 13, margin: "4px 0 16px" }}>
        {view.displayName}
        {view.tenancyEnded
          ? ` · lived here${view.since ? ` from ${pretty(view.since)}` : ""} until ${pretty(view.tenancyEnded)}`
          : view.since ? ` · living here since ${pretty(view.since)}` : ""}
      </p>

      {/* ------------------------------------------------------ moved out --- */}
      {/* THE DAY THE OFFICE CLOSED HER OUT, THIS WHOLE SCREEN USED TO VANISH —
          replaced by "No lot on your account. We looked for a tenancy attached
          to this sign-in and didn't find one", every clause of it false. Her
          file was linked; it was the tenancy that ended. Behind that sentence
          went her deposit and her final part-month, which runCharges raises
          AFTER the move-out on purpose (0101) — a bill she could never see.

          She keeps the money half of the screen and loses the lot half: no
          reporting a broken step on a pad somebody else now lives on, and no
          booking against it. */}
      {view.tenancyEnded && (
        <div className="ll-card ll-card-pad" style={{ marginBottom: 12, borderLeft: "3px solid var(--sun)" }}>
          <strong style={{ fontSize: 15 }}>Your tenancy has ended</strong>
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
            You moved out on {pretty(view.tenancyEnded)}. This page stays here
            while anything is still open between you and the park &mdash;{" "}
            <strong>anything you still owe, any deposit still held, and any money of yours still on account.</strong>{" "}
            Your receipts stay too &mdash; the last two years are below, and the
            office holds every one of them by receipt number.
          </p>
        </div>
      )}

      {/* ---------------------------------------------------- what you owe -- */}
      <div className="ll-card ll-card-pad">
        {!b ? (
          // NOT "$0.00". A month the park has not billed yet is not a month you
          // are square for, and a zero here would say the wrong one.
          <>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Nothing to pay right now</div>
            <p className="mut" style={{ fontSize: 13, margin: "4px 0 0", lineHeight: 1.55 }}>
              Your next bill hasn&apos;t been sent yet. When it is, it shows up
              here with what it&apos;s made of.
            </p>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="mut" style={{ fontSize: 13 }}>Rent — {b.monthLabel}</span>
              <span className="mut" style={{ fontSize: 12.5, marginLeft: "auto" }}>
                due {pretty(b.dueOn)}
              </span>
            </div>
            {/* THE BIG NUMBER IS WHAT SHE OWES, OR WHAT SHE PAID — never the
                bill's face value over a payment that exceeded it. Below zero
                the truthful figure is what she handed over, with the excess
                named on the next line. */}
            <div style={{ fontSize: 26, fontWeight: 800, margin: "6px 0 2px" }}>
              {money(b.outstanding > 0 ? b.outstanding : b.outstanding < 0 ? b.paidTotal : b.amount)}
            </div>

            {/* A DISAGREEMENT OUTRANKS A BALANCE. If they have told the park
                the ledger is wrong, nothing is being chased until somebody
                looks — and this screen must say so rather than nag. */}
            {b.disputed ? (
              /* SAY BACK WHAT THEY ACTUALLY TOLD US. This once read "you've
                 told the office this doesn't look right" — written when the
                 office was the only one who could open a claim, and wrong the
                 moment a resident could. `park_payment_claims` is not a
                 general dispute: it is "I already paid this", and the date is
                 the detail they want to see repeated back. */
              <div style={{ fontSize: 13, color: "var(--ink-warn)" }}>
                You&apos;ve told the office you paid this
                {b.claimedPaidOn ? ` on ${pretty(b.claimedPaidOn)}` : ""}.
                Nothing is being chased until they&apos;ve confirmed it.
              </div>
            ) : b.outstanding < 0 ? (
              /* NOT "PAID IN FULL". That sentence over a $600 payment on a
                 $542.53 bill hid the $57.47 from the one person it belongs to.
                 New payments are split on account before they reach here, so
                 this is the older shape — and it still has to say what it is,
                 without promising the software will apply it: nothing does on
                 its own. */
              <div style={{ fontSize: 13, color: "var(--ink-good)" }}>
                Paid — {money(-b.outstanding)} more than this bill. The office is
                holding that; ask them to put it toward your next one.
              </div>
            ) : b.outstanding === 0 ? (
              /* HOW IT WAS PAID, when money on account paid it (0167). Her
                 payment list shows one $1,627.59 cheque and no $542.53, so
                 "Paid in full" over a month she never wrote a cheque for is
                 the sentence that sends her to the office to ask. */
              <div style={{ fontSize: 13, color: "var(--ink-good)" }}>
                Paid in full — thank you.
                {b.fromOnAccount > 0 && ` ${fromOnAccountWords(b)}`}
              </div>
            ) : (
              <div className="mut" style={{ fontSize: 13 }}>
                {b.paidTotal > 0 ? receivedSoFar(b) : "Not paid yet."}
              </div>
            )}

            {/* PAY IT. Only when the park has switched online rent on — the
                software must not offer a payment the landlord has not agreed
                to take. A disputed bill hides it: nothing is being chased
                until somebody looks, so nothing should be collected either. */}
            {view.acceptsOnlineRent && b.outstanding > 0 && (
              <PayRentButton
                chargeId={b.id}
                amount={b.outstanding}
                parkName={view.parkName}
                hasCard={view.hasCard}
                cardFeePct={view.cardFeePct}
                disabled={b.disputed}
              />
            )}

            {/* HOW TO PAY IT, WHEN THERE IS NO BUTTON.
                THE WORST GAP ON THE RESIDENT'S SCREEN. With online rent off —
                which is every park without a processor, including The Haven in
                January — the card above this renders nothing, and the only
                control left invites her to declare she has ALREADY paid. The
                screen showed her $542.53 owed and said nowhere on earth to
                take it. Seventeen of The Haven's eighteen households pay cash
                or a cheque, so that was almost all of them.
                The sentence exists elsewhere — in the invite email and on an
                overdue notice — and both are messages, both sit behind
                `parks.notices_held_at`, and the overdue one only fires after
                the office has already chased her. Neither is on the screen she
                opens on the 1st. */}
            {/* "I ALREADY PAID THIS", AND IT IS NOT GATED ON acceptsOnlineRent.
                The pay button above is — a resident must never be offered a
                payment their landlord hasn't agreed to take. This is the
                opposite case: the park that takes no card at all is exactly
                the park where every payment is cash or a cheque, so it is the
                park that needs this MOST. Hidden once a claim is open, because
                the sentence above already says nothing is being chased. */}
            {b.outstanding > 0 && !b.disputed && (
              <IPaidForm
                chargeId={b.id}
                monthLabel={b.monthLabel}
                today={view.today}
              />
            )}

            {b.lines.length > 0 && (
              <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 10 }}>
                {/* THE BILL SHOWS ITS WORKING. `lines` is stored as the
                    resident saw it, so a water share can never turn up as an
                    unexplained jump in the total. */}
                {b.lines.map((l, i) => (
                  <div key={`${l.label}-${i}`}
                    style={{ display: "flex", fontSize: 13, padding: "3px 0" }}>
                    <span className="mut">
                      {l.label}
                      {/* A PART MONTH SAYS SO. Without this a resident who
                          moved in on the 20th sees a $55 fee charged at $19.35
                          and no reason for the number. */}
                      {l.basis && l.basis !== "for the month" && (
                        <span style={{ opacity: 0.75 }}> · {l.basis}</span>
                      )}
                    </span>
                    <span style={{ marginLeft: "auto" }}>{money(l.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ------------------------------------------------ earlier months --- */}
      {/* THE MONTHS THAT USED TO DISAPPEAR. The bill read was `.limit(1)`, so
          the morning February was raised an unpaid January left this screen
          entirely — she could not see it, pay it, or say she already had, and
          if February was then settled the card above read "Paid in full —
          thank you." to a household a month in arrears. Her only route to her
          own back rent was ringing the office.

          Oldest first, because that is the one to clear first, and each row
          carries the SAME two controls as the current bill: paying and saying
          "I already paid this" are exactly as necessary here. */}
      {/* ONE SENTENCE, FOR ANY MONTH SHE STILL OWES ON — current or back.
          Placed between the bill and the arrears so it reads as the answer to
          "what do I owe", which is where her eye already is. */}
      {!view.acceptsOnlineRent &&
        ((view.bill?.outstanding ?? 0) > 0 || view.arrears.some((a) => a.outstanding > 0)) && (
          <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
            <h3 style={{ fontSize: 15, margin: 0 }}>How to pay</h3>
            <HowToPay parkName={view.parkName} parkAddress={view.parkAddress} />
          </div>
        )}

      {view.arrears.length > 0 && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>
            Still owing from earlier{view.arrears.length > 1 ? ` — ${view.arrears.length} months` : ""}
          </h3>
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
            These are older bills with a balance left on them. Clearing the
            oldest first is usually the right order.
          </p>
          {view.arrears.map((a) => (
            <div
              key={a.id}
              style={{
                borderTop: "1px solid var(--line)",
                marginTop: 10,
                paddingTop: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 14 }}>{a.monthLabel}</strong>
                <span className="mut" style={{ fontSize: 12.5 }}>
                  due {pretty(a.dueOn)}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 17, fontWeight: 800 }}>
                  {money(a.outstanding)}
                </span>
              </div>

              {/* WHAT MONEY ON ACCOUNT ALREADY TOOK OFF THIS MONTH. The big
                  number is what is left; without this line a household whose
                  quarter-ahead cheque half-covered January reads $242.53 owed
                  with no sign the other $300 was ever counted. And when that
                  money was a cancelled bill's (0169), the bill is named —
                  the same thread as the current month's sentence. */}
              {a.fromOnAccount > 0 && (
                <div className="mut" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {a.fromCancelledBill
                    ? fromOnAccountWords(a)
                    : `${money(a.fromOnAccount)} came off money you had on account.`}
                </div>
              )}

              {a.disputed ? (
                <div style={{ fontSize: 13, color: "var(--ink-warn)", marginTop: 4 }}>
                  You&apos;ve told the office you paid this
                  {a.claimedPaidOn ? ` on ${pretty(a.claimedPaidOn)}` : ""}. Nothing
                  is being chased until they&apos;ve checked.
                </div>
              ) : (
                <>
                  {view.acceptsOnlineRent && (
                    <PayRentButton
                      chargeId={a.id}
                      amount={a.outstanding}
                      parkName={view.parkName}
                      hasCard={view.hasCard}
                      cardFeePct={view.cardFeePct}
                    />
                  )}
                  <IPaidForm
                    chargeId={a.id}
                    monthLabel={a.monthLabel}
                    today={view.today}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------------------- deposit and agreement -- */}
      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <div className="ll-card ll-card-pad" style={{ flex: "1 1 200px" }}>
          <div className="mut" style={{ fontSize: 13 }}>Deposit held</div>
          {view.deposit ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>
                {money(view.deposit.amount)}
              </div>
              <div className="mut" style={{ fontSize: 12 }}>
                since {pretty(view.deposit.since)}
              </div>
            </>
          ) : (
            /* NOT "None held." ALONE the week after the office handed $500
               back across the window. The card said nothing of the return
               she was waiting on; the stamp on the deposit row is the
               record, and this reads it. */
            <div className="mut" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.4 }}>
              None held.
              {view.depositReturned && (
                <> {money(view.depositReturned.amount)} was handed back to you on {longDay(view.depositReturned.on)}.</>
              )}
            </div>
          )}
        </div>
        {/* MONEY OF THEIRS STILL ON ACCOUNT. The office has seen this row
            under "Money not against a bill" since 0102; the resident never
            saw it at all. Only rendered when there is some — a "$0.00 on
            account" card is a number nobody asked for.

            "IT COMES OFF YOUR BILLS, OLDEST FIRST" IS TRUE (0167, R1). This
            card used to say "paid, not yet against a bill" and nothing more,
            because nothing applied the money on its own. Every door now
            settles her oldest open bill from it — the run the moment it
            raises one, the office the moment money is keyed, or by hand —
            and the figure is what is STILL held, not what she handed over.
            Not "next bills": after the office takes a line back off a bill
            (R3) the money is on account while that bill is open again, and
            it is that bill, not a next one, the next run puts it against.

            UNTIL THERE IS NO NEXT BILL. Once the tenancy has ended AND the
            move-out month is billed, nothing further is raised for her —
            "comes off your bills" promised a bill that will never come, to
            the one person the money belongs to. The card then says only what
            is true: the office holds it and nothing more bills. Whether it is
            owed back to her, or held against something, is the office's to
            say — not this card's. While the final month is still to be
            billed the money WILL come off it, so `tenancyEnded` alone is not
            the test. */}
        {view.onAccount != null && view.onAccount > 0 && (
          <div className="ll-card ll-card-pad" style={{ flex: "1 1 200px" }}>
            <div className="mut" style={{ fontSize: 13 }}>On account</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>
              {money(view.onAccount)}
            </div>
            <div className="mut" style={{ fontSize: 12, lineHeight: 1.4 }}>
              {view.tenancyEnded && view.finalMonthBilled
                ? "with the office — nothing more bills for you"
                : "with the office — it comes off your bills, oldest first"}
            </div>
          </div>
        )}
        <div className="ll-card ll-card-pad" style={{ flex: "1 1 200px" }}>
          <div className="mut" style={{ fontSize: 13 }}>Your agreement</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, textTransform: "capitalize" }}>
            {view.term}
          </div>
          <div className="mut" style={{ fontSize: 12 }}>
            {view.leavingOn ? `ends ${pretty(view.leavingOn)}` : "rolls on"}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- payments -- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Payments</h3>
        {view.payments.length === 0 ? (
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0" }}>
            Nothing recorded yet.
          </p>
        ) : (
          <div style={{ marginTop: 6 }}>
            {/* SAY WHEN THIS IS A SLICE. The card above promises her receipts
                stay; a list that silently stopped at the newest few made that
                a lie from her seventh payment onward. Two years is a sensible
                page — and the sentence below is what keeps the promise honest
                for a resident of eleven years, who does exist. */}
            {view.payments.map((p, i) => (
              <div key={`${p.on}-${i}`} style={{
                display: "flex", gap: 8, fontSize: 13,
                padding: "6px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap",
              }}>
                <span className="mut">{pretty(p.on)} · {p.method}</span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontWeight: 700,
                    // Struck through, not deleted — by EITHER route. Their bank
                    // statement shows the debit AND the reversal; she holds the
                    // receipt for the cheque that bounced. A row that quietly
                    // vanished from our copy would make us look wrong about
                    // their money.
                    textDecoration: p.takenBackOn ? "line-through" : undefined,
                    opacity: p.takenBackOn ? 0.55 : undefined,
                  }}
                >
                  {money(p.amount)}
                </span>
                {/* The receipt number is the thing they can quote at the
                    window. It is why assign_receipt_no exists. */}
                {p.receiptNo != null && (
                  <span className="mut" style={{ fontSize: 12, minWidth: 52, textAlign: "right" }}>
                    #{p.receiptNo}
                  </span>
                )}
                {/* WHAT THE CARD WAS ACTUALLY CHARGED. The bold number above is
                    the rent, because that is what the ledger credits. Their bank
                    shows the sum, and until this line existed the difference was
                    a phone call to the office. */}
                {p.fee != null && p.fee > 0 && (
                  <span className="mut" style={{ flexBasis: "100%", fontSize: 12, lineHeight: 1.4 }}>
                    plus {money(p.fee)} card fee &mdash; {money(p.amount + p.fee)} left your card
                  </span>
                )}
                {/* WITHOUT THIS LINE THE SCREEN CONTRADICTS ITSELF. A returned
                    payment reopens its bill (recompute_charge_paid excludes it,
                    0155), so the rent card above says OPEN while this list still
                    shows the payment and its receipt number. The resident rings
                    the office quoting a receipt for money that is not there.
                    Says what happened and what it means, in that order. */}
                {/* `longDay`, not `pretty`: these are timestamps, and pretty()
                    printed "Invalid Date" for one. */}
                {p.bankReturnedOn ? (
                  <span style={{ flexBasis: "100%", fontSize: 12, lineHeight: 1.4, color: "var(--danger)" }}>
                    Your bank sent this payment back on {longDay(p.bankReturnedOn)}, so this
                    month is showing as unpaid again.
                  </span>
                ) : p.takenBackOn ? (
                  /* THE OFFICE TOOK IT BACK — a bounced cheque, a number keyed
                     wrong. Never "your bank": the ledger cannot tell a bounce
                     from a typo; only the office's reason can, and it is the
                     same reason /paid/[token] already shows her. Anything the
                     payment had settled reopened that day (recompute_charge_paid
                     drops it and its allocations) — said as the EVENT, not as
                     the state of her bills now: once she has paid January
                     again another way, "is showing as owed again" is false on
                     the same screen that shows it paid. */
                  <span style={{ flexBasis: "100%", fontSize: 12, lineHeight: 1.4, color: "var(--danger)" }}>
                    This payment was taken back on {longDay(p.takenBackOn)}
                    {p.takenBackWhy?.trim() ? ` — ${p.takenBackWhy.trim()}` : ""}. Anything it
                    had paid was reopened that day.
                  </span>
                ) : null}
                {/* THE BILL THIS PAID WAS CANCELLED (0169), and where its money
                    is now. Her list showed a $542.53 cheque, the part month
                    said $472.53 came from what she'd paid on the cancelled
                    January bill, and the On account card said $70.00 — three
                    figures on one screen and nothing tying them together but
                    her own subtraction. Said only of a payment that stands
                    (a released row since taken back is a taken-back receipt,
                    and the branch above says so), in the words /paid/[token]
                    already uses for the same row, and never the cancelled
                    bill's reason: a void has a free-text office reason and
                    the part month it may or may not have been re-raised as
                    is a bill on this screen, not a fact this row holds.
                    `describeAllocations` is the ONE sentence for where money
                    on account went; the remainder is the view's, never the
                    cheque less the lines. Not on the On account card: the
                    card is the sum over every row still held, and a cheque
                    on account beside a released one would make "left over
                    from your January cheque" a lie there. */}
                {p.releasedFrom && !p.takenBackOn && (
                  <span className="mut" style={{ flexBasis: "100%", fontSize: 12, lineHeight: 1.4 }}>
                    {releasedWords(p)}
                  </span>
                )}
                {/* MONEY FROM THIS PAYMENT HANDED BACK TO HER (0168). The row
                    stays at what she handed over; this is where the rest went
                    — the $57.47 of a $600 cheque, across the window after she
                    left. Her on-account card above has already stopped
                    counting it (the view's remaining); without this line the
                    card simply shrank and the cheque sat here unmarked. */}
                {p.handedBack > 0 && p.handedBackOn && (
                  <span className="mut" style={{ flexBasis: "100%", fontSize: 12, lineHeight: 1.4 }}>
                    {money(p.handedBack)} of this was handed back to you on {longDay(p.handedBackOn)}.
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --------------------------------------------- what you reported --- */}
      {/* THE LOT HALF OF THE SCREEN, and it stops at the move-out. The original
          reason for hiding an ended tenancy was exactly right about this part:
          a former resident is not owed a live screen about a pad somebody else
          now lives on, and must not be able to report a broken step on it. The
          money half above stays. */}
      {!view.tenancyEnded && (
      <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>What you reported</h3>
        {/* "NOTHING YET" AND "WE COULDN'T LOOK" ARE DIFFERENT SENTENCES, and
            only one of them is ever a fact. Every other read on this screen
            fails the page rather than guess; this list degrades instead,
            because nobody should lose sight of their rent balance over a
            maintenance query — but it has to admit what happened. */}
        {view.reportedFailed ? (
          <p style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55, color: "var(--ink-warn)" }}>
            {/* Explicit {" "} — JSX trims each line's leading whitespace, so
                the space after </em> at a line break is eaten and this renders
                "nota list". Caught in the DOM, not by reading. */}
            We couldn&apos;t load this just now — so this is <em>not</em>{" "}
            a list of nothing, it&apos;s a list we failed to fetch. Everything
            else on this page is current. Try reloading in a moment.
          </p>
        ) : view.reported.length === 0 ? (
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
            {/* THE STICKER HAS TO EXIST TO BE SCANNED. `park_lots.qr_token` is
                null until the office mints and physically fixes one, and no
                lot at The Haven has one — so this told a household with a
                leaking riser to go outside and scan something that is not
                there, from a card that offers her no other button. */}
            {view.hasSticker
              ? "Nothing yet. The sticker on your pedestal opens a form — no login, no app."
              : "Nothing yet. Tell the office and they'll log it for you. When they put a sticker on your pedestal, scanning it will open the same form — no login, no app."}
          </p>
        ) : (
          <div style={{ marginTop: 6 }}>
            {view.reported.map((r, i) => (
              <div key={i} style={{ padding: "7px 0", borderTop: "1px solid var(--line)" }}>
                <div style={{ fontSize: 13.5 }}>{r.note}</div>
                {/* THE ANSWER TO "why has nothing happened", finally shown to
                    the person who asked. The office is made to write this note
                    when they close a job; until now only they could read it. */}
                <div className="mut" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {r.status === "done"
                    ? (r.resolutionNote ? `Done — “${r.resolutionNote}”` : "Done.")
                    : r.status === "in_hand"
                      ? `Someone has it · reported ${r.ageDays === 0 ? "today" : `${r.ageDays} days ago`}`
                      : `Reported ${r.ageDays === 0 ? "today" : `${r.ageDays} days ago`}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* ============ THE LINE. Different money, different creditor. ======== */}
      <div style={{ borderTop: "2px solid var(--line)", marginTop: 22, paddingTop: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Services</h3>
          <span className="ll-pill slate" style={{ fontSize: 12 }}>Separate from rent</span>
        </div>
        <p className="mut" style={{ fontSize: 12.5, margin: "4px 0 10px", lineHeight: 1.55 }}>
          Work you book is paid to LakeLife on your own card — never added to
          your rent, and never held back because rent is due.{" "}
          {/* A PRIVACY ASSURANCE THAT WAS NOT TRUE.
              This said the office "can see that a crew came to your lot, but
              not what you booked". The park owner's visits screen renders the
              SERVICE NAME on every row — park_site_visits selects `s.name as
              service` (0107:172) and /park/visits prints it as its widest
              column. So "what you booked" is exactly what he sees.
              The design is deliberate and stays: he sees what he could see out
              of his own window — a crew, doing a thing, on a day. What he
              never sees is the money. Promising more than that, to the person
              deciding whether to book at all, is the wrong thing to be wrong
              about. */}
          Your park office sees that a crew came to your lot, what they were
          there to do, and when — the same things they&apos;d see out the
          window. They never see what you paid.
        </p>
        {/* Not offered once the tenancy has ended — it sets up services against
            the LOT, which is no longer hers. */}
        {!view.tenancyEnded && <EnableLotBooking ready={view.bookingReady} />}
      </div>

      {/* HER NUMBER, HER CHOICE, BELOW HER RENT. The park has had a phone
          number for this household all along and the software has never been
          allowed to use it. This is the only door that changes that. */}
      <TextOptIn parkName={view.parkName} on={view.textsOn} number={view.textNumber} />

      {/* THE RESIDENT'S PORTAL IS THIS ONE PAGE, so the way back to what she
          agreed to is a card on it rather than a tab she does not have. The
          text-consent sentence she read is on that page too — 0133 snapshotted
          it precisely so it could be shown back, and until now nothing did. */}
      <Link
        href="/agreements"
        className="ll-card ll-card-pad"
        style={{ display: "block", textDecoration: "none", color: "inherit", marginTop: 12 }}
      >
        <div style={{ fontWeight: 800, fontSize: 15 }}>What you&apos;ve agreed to &rarr;</div>
        <div className="mut" style={{ fontSize: 13 }}>
          Your LakeLife terms and your text-message consent, in the exact words
          you read at the time.
        </div>
      </Link>
    </div>
  );
}
