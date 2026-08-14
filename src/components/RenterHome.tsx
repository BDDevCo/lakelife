import Link from "next/link";
import type { RenterHome as RenterHomeView } from "@/app/parks/my-data";
import { PayRentButton } from "@/components/PayRentButton";

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
        {view.since ? ` · living here since ${pretty(view.since)}` : ""}
      </p>

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
              <div style={{ fontSize: 13, color: "var(--ink-warn, #9a6b15)" }}>
                You&apos;ve told the office this doesn&apos;t look right. Nothing
                is being chased until they&apos;ve checked.
              </div>
            ) : b.outstanding <= 0 ? (
              <div style={{ fontSize: 13, color: "var(--ink-good, #0e7a6a)" }}>
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
                disabled={b.disputed}
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
                    <span className="mut">{l.label}</span>
                    <span style={{ marginLeft: "auto" }}>{usd(l.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

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
                <span style={{ marginLeft: "auto", fontWeight: 700 }}>{usd(p.amount)}</span>
                {/* The receipt number is the thing they can quote at the
                    window. It is why assign_receipt_no exists. */}
                {p.receiptNo != null && (
                  <span className="mut" style={{ fontSize: 12, minWidth: 52, textAlign: "right" }}>
                    #{p.receiptNo}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --------------------------------------------- what you reported --- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>What you reported</h3>
        {view.reported.length === 0 ? (
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
            Nothing yet. The sticker on your pedestal opens a form — no login,
            no app.
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

      {/* ============ THE LINE. Different money, different creditor. ======== */}
      <div style={{ borderTop: "2px solid var(--line)", marginTop: 22, paddingTop: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Services</h3>
          <span className="ll-pill slate" style={{ fontSize: 12 }}>Separate from rent</span>
        </div>
        <p className="mut" style={{ fontSize: 12.5, margin: "4px 0 10px", lineHeight: 1.55 }}>
          Work you book is paid to LakeLife on your own card — never added to
          your rent, and never held back because rent is due. Your park office
          can see that a crew came to your lot, but not what you booked or what
          you paid.
        </p>
        <div className="ll-card ll-card-pad">
          <p className="mut" style={{ fontSize: 13, margin: 0, lineHeight: 1.55 }}>
            Booking for your lot isn&apos;t switched on yet. When it is,
            it&apos;ll work the same way it does for any lake home — pick a
            service, pick a day.
          </p>
          <Link className="ll-btn ghost sm" href="/portal" style={{ marginTop: 10, display: "inline-block" }}>
            Go to my LakeLife portal
          </Link>
        </div>
      </div>
    </div>
  );
}
