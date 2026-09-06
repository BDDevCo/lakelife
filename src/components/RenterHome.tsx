import Link from "next/link";
import type { RenterHome as RenterHomeView } from "@/app/parks/my-data";
import { PayRentButton } from "@/components/PayRentButton";
import { IPaidForm } from "@/components/IPaidForm";
import { TextOptIn } from "@/components/TextOptIn";
import { EnableLotBooking } from "@/components/EnableLotBooking";

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

const usd = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD" });

/** "3 July 2026" — a date a person reads, never 2026-07-03. */
function pretty(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
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
            <strong>anything you still owe, and any deposit still held.</strong>{" "}
            Your receipts stay too, so you can always show what you paid.
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
            <div style={{ fontSize: 26, fontWeight: 800, margin: "6px 0 2px" }}>
              {usd(b.outstanding > 0 ? b.outstanding : b.amount)}
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
            ) : b.outstanding <= 0 ? (
              <div style={{ fontSize: 13, color: "var(--ink-good)" }}>
                Paid in full — thank you.
              </div>
            ) : (
              <div className="mut" style={{ fontSize: 13 }}>
                {b.paidTotal > 0 ? `${usd(b.paidTotal)} received so far.` : "Not paid yet."}
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
                    <span style={{ marginLeft: "auto" }}>{usd(l.amount)}</span>
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
                  {usd(a.outstanding)}
                </span>
              </div>

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
                {usd(view.deposit.amount)}
              </div>
              <div className="mut" style={{ fontSize: 12 }}>
                since {pretty(view.deposit.since)}
              </div>
            </>
          ) : (
            <div className="mut" style={{ fontSize: 13, marginTop: 4 }}>None held.</div>
          )}
        </div>
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
                    // Struck through, not deleted. Their bank statement shows
                    // the debit AND the reversal; a row that quietly vanished
                    // from our copy would make us look wrong about their money.
                    textDecoration: p.bankReturnedOn ? "line-through" : undefined,
                    opacity: p.bankReturnedOn ? 0.55 : undefined,
                  }}
                >
                  {usd(p.amount)}
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
                    plus {usd(p.fee)} card fee &mdash; {usd(p.amount + p.fee)} left your card
                  </span>
                )}
                {/* WITHOUT THIS LINE THE SCREEN CONTRADICTS ITSELF. A returned
                    payment reopens its bill (recompute_charge_paid excludes it,
                    0155), so the rent card above says OPEN while this list still
                    shows the payment and its receipt number. The resident rings
                    the office quoting a receipt for money that is not there.
                    Says what happened and what it means, in that order. */}
                {p.bankReturnedOn && (
                  <span style={{ flexBasis: "100%", fontSize: 12, lineHeight: 1.4, color: "var(--danger)" }}>
                    Your bank sent this payment back on {pretty(p.bankReturnedOn)}, so this
                    month is showing as unpaid again.
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
