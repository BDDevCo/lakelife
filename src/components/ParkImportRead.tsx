"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { commitImport, resolveRow, undoImport } from "@/app/park/import-actions";
import {
  importBlockerText,
  cadenceTotals,
  checkTotals,
  type PlannedRow,
  type ImportBlocker,
  type RollReconciliation,
} from "@/app/park/import-helpers";

/**
 * Screen 2 — Read. The ORDER of this screen is the whole product.
 *
 * The walk list comes FIRST. The obvious layout puts 79 tenant rows at the top
 * and the empty lots at the bottom, and he commits and closes the tab before
 * ever reaching the only output he could not have produced himself with an
 * afternoon and a pen.
 *
 * So: walk list, then the seller's own arithmetic, then the questions, then
 * the boring part.
 */

export interface ReadView {
  batchId: string;
  parkName: string;
  linesTotal: number;
  linesRead: number;
  rawText: string;
  committedAt: string | null;
  undoneAt: string | null;
  rows: PlannedRow[];
  ready: PlannedRow[];
  needsYou: PlannedRow[];
  lotsToCreate: string[];
  monthlyTotal: number;
  namelessRoll: boolean;
  rates: { lineNo: number; lotLabel: string; amount: number | null; createsLot: boolean }[];
  others: { lineNo: number; text: string; verdict: string; why: string | null }[];
  blockQuestions: { code: string; question: string }[];
  /** jsonb — tallies AND, since the failures fix, the list of rows that
   *  didn't take. Read through `num()` / `commitFailures()` below. */
  counts: Record<string, unknown>;
  refusedColumns: string[];
  reconciliation: RollReconciliation;
  statedTotal: number | null;
}

/** A tally out of the jsonb bag, or 0. */
const num = (c: Record<string, unknown>, k: string): number =>
  typeof c[k] === "number" ? (c[k] as number) : 0;

export interface CommitFailure { lot: string | null; name: string | null; message: string }

/**
 * The rows the commit could not write, BY NAME.
 *
 * `commitImport` has always returned these — per row, in his words, never a
 * rollback of what worked — and the receipt threw them away and printed
 * "3 rows didn't take. Open the rent roll to see where the gaps are." On a
 * 79-row roll that is not a task anybody finishes: a household that failed to
 * file and a genuinely empty lot look identical on every screen, and the one
 * that failed is never billed and never surfaces again.
 */
function commitFailures(counts: Record<string, unknown>): CommitFailure[] {
  const raw = counts.failures;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is CommitFailure =>
      !!f && typeof f === "object" && typeof (f as CommitFailure).message === "string",
  );
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function ParkImportRead({ view }: { view: ReadView }) {
  const [showPaste, setShowPaste] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const done = view.committedAt != null && view.undoneAt == null;

  // The walk list: lots his roll never accounted for. An empty lot and a cash
  // tenant the seller forgot look exactly the same on paper.
  const walk = view.others.filter((o) => o.verdict === "vacant");
  /**
   * HIS LOTS THAT THE SHEET NEVER NAMES.
   *
   * `walk` is built from lines that were in the file. A seller who lists only
   * his 19 occupied lots and never mentions the 2 empties produced "0 empty"
   * here — and the empties are exactly what the park carries, so they are the
   * ones that matter for every shared cost.
   */
  const absent = view.reconciliation.neverMentioned;
  const skipped = view.others.filter((o) => o.verdict !== "vacant");

  // WHAT THE LIST SAYS, NOT WHAT IS READY TO WRITE.
  //
  // This read `view.ready`, and on a park that does not have its lots yet —
  // which is every park pasting a roll for the first time — EVERY row carries
  // the `lot_unknown` blocker, so `ready` is empty and the panel below said
  // "No amounts on this list yet" while holding nineteen amounts the parser
  // had read as `stated`.
  //
  // It said that at the exact moment the number matters most: a buyer at
  // closing, checking the roll against the figure the seller quoted him.
  // Whether a lot record exists yet has nothing to do with what the sheet
  // claims he collects.
  //
  // Same population as `totals` on the next line, which had it right all
  // along — the rows he has NOT stood down.
  const live = view.rows.filter((r) => !r.skipped);
  const cadence = cadenceTotals(live);
  /** Of the rows in that figure, how many still need an answer from him. */
  const pendingInCadence = view.needsYou.filter((r) => r.amount != null).length;
  // Against the rows he has NOT stood down. Once he answers "Fry lives there
  // now", Newman's $410 stops being part of what this sheet claims — so the
  // comparison has to move with his answers, or the section keeps arguing a
  // point he already settled.
  const totals = checkTotals(view.statedTotal, live);

  function answer(lineNo: number, resolved: Record<string, unknown>) {
    start(async () => {
      const res = await resolveRow(view.batchId, lineNo, resolved);
      if (!res.ok) { toast(res.error ?? "Couldn't save that."); return; }
      router.refresh();
    });
  }

  function commit() {
    start(async () => {
      const res = await commitImport(view.batchId);
      setConfirming(false);
      if (!res.ok) { toast(res.error ?? "Couldn't put them in."); return; }
      toast(res.signal ?? "In.");
      router.refresh();
    });
  }

  if (done) return <Receipt view={view} />;

  return (
    <div className="wrap" style={{ paddingTop: 24, paddingBottom: 140, maxWidth: 760 }}>
      <Link className="mut" href="/park/import" style={{ fontSize: 14 }}>← Start over</Link>

      <h1 style={{ fontSize: 24, margin: "14px 0 4px" }}>
        We read {view.linesRead} of the {view.linesTotal} lines.
      </h1>
      <p className="mut" style={{ marginTop: 0 }}>Nothing is saved yet.</p>

      {view.blockQuestions.map((q) => (
        <div
          key={q.code}
          className="ll-card ll-card-pad"
          style={{ marginTop: 14, background: "rgba(200,60,40,.08)" }}
        >
          <strong>{q.question}</strong>
        </div>
      ))}

      {/* ---- Section 1: WALK THESE FIRST. Deliberately above everything. --- */}
      {(walk.length > 0 || absent.length > 0) && (
        <section className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 10px" }}>
            {walk.length + absent.length}{" "}
            {walk.length + absent.length === 1 ? "lot has" : "lots have"} nobody on this list
          </h2>
          <ul style={{ margin: "0 0 12px", paddingLeft: 18, lineHeight: 1.7 }}>
            {walk.map((w) => (
              <li key={w.lineNo}>
                <strong>{w.text}</strong>
                {w.why ? <span className="mut"> — {w.why}</span> : null}
              </li>
            ))}
            {/* NOT ON THE SHEET AT ALL. The list above is built from lines
                that were physically in the file, so a pad the seller simply
                left off was invisible here and counted as "0 empty" on the
                bar — a false statement at the moment of decision, on the one
                screen whose whole job is to be the output he could not have
                produced himself. */}
            {absent.map((label) => (
              <li key={`absent-${label}`}>
                <strong>Lot {label}</strong>
                <span className="mut"> — not on this list at all</span>
              </li>
            ))}
          </ul>
          <p className="mut" style={{ margin: 0, lineHeight: 1.5 }}>
            Walk these on Saturday. An empty lot and a cash tenant nobody
            wrote down look exactly the same on paper.
          </p>
        </section>
      )}

      {/* ---- Section 2: the seller's own arithmetic. ---------------------- */}
      <section className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <h2 style={{ fontSize: 18, margin: "0 0 10px" }}>What this list says you collect</h2>
        {cadence.byTerm.length === 0 ? (
          <p className="mut" style={{ margin: 0 }}>
            No amounts on this list yet. That&apos;s fine — you can fill them in
            as you meet people.
          </p>
        ) : cadence.mixed ? (
          <>
            <p style={{ margin: "0 0 8px", lineHeight: 1.5 }}>
              This sheet mixes cadences, so one grand total wouldn&apos;t mean
              anything. What he actually collects:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              {cadence.byTerm.map((t) => (
                <li key={t.term}>
                  <strong>{money(t.total)}</strong> {perTerm(t.term)}
                  <span className="mut"> · {t.count} {t.count === 1 ? "row" : "rows"}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            <strong>{money(cadence.byTerm[0].total)}</strong> {perTerm(cadence.byTerm[0].term)},
            across {cadence.byTerm[0].count} {cadence.byTerm[0].count === 1 ? "row" : "rows"}.{" "}
            <span className="mut">
              These came off the list, not from anyone confirming them. Your rent
              roll will say so.
              {pendingInCadence > 0 && (
                <>
                  {" "}
                  {pendingInCadence} of those {pendingInCadence === 1 ? "row is" : "rows are"}{" "}
                  still waiting on an answer below, so the figure is what the
                  sheet claims rather than what will be written.
                </>
              )}
            </span>
          </p>
        )}

        {/* HIS arithmetic, against HIS rows. Compared over every row on the
            sheet, not just the ones ready to import — this is a check on the
            seller's spreadsheet, not on our progress through it. */}
        {totals && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,.08)" }}>
            {totals.ties ? (
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                <strong>His total ties to the penny: {money(totals.stated)}.</strong>{" "}
                <span className="mut">
                  That means his spreadsheet adds up. It doesn&apos;t mean the
                  rents are right.
                </span>
              </p>
            ) : (
              <>
                <p style={{ margin: "0 0 8px", fontWeight: 700 }}>
                  The total at the bottom doesn&apos;t match the rows above it.
                </p>
                <div style={{ display: "grid", gap: 2, fontVariantNumeric: "tabular-nums" }}>
                  <Row label="the total says" value={money(totals.stated)} />
                  <Row label="the rows add up to" value={money(totals.computed)} />
                  <Row
                    label={totals.difference > 0 ? "short" : "over"}
                    value={money(Math.abs(totals.difference))}
                    strong
                  />
                </div>
                {/* Each of these is EARNED by the arithmetic. When neither
                    holds, the gap gets no explanation — which is the honest
                    outcome and leaves him looking at the numbers themselves. */}
                {totals.oneMissingRent && (
                  <p className="mut" style={{ margin: "10px 0 0", lineHeight: 1.5 }}>
                    That&apos;s about one lot&apos;s rent. Lot {totals.oneMissingRent} is
                    the only lot on this sheet with no amount next to it.
                  </p>
                )}
                {totals.doubleCountedLots.length > 0 && (
                  <p className="mut" style={{ margin: "10px 0 0", lineHeight: 1.5 }}>
                    Our sum is the higher one because lot{" "}
                    {totals.doubleCountedLots.join(", ")} appears twice on his
                    sheet — he counted it once. Say who lives there and these
                    should meet.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {/* ---- Section 3: NEEDS YOU. ---------------------------------------- */}
      {view.needsYou.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Needs you ({view.needsYou.length})</h2>
          <p className="mut" style={{ margin: "0 0 6px" }}>
            We won&apos;t guess at these. Each one changes a number you&apos;d be relying on.
          </p>
          <p className="mut" style={{ margin: "0 0 14px", lineHeight: 1.5 }}>
            <strong>A lot and a name. That&apos;s the whole requirement.</strong> Rent,
            dates, phone numbers — put them in if you have them, leave them if you
            don&apos;t. You&apos;ll be standing in front of these people for the
            next month anyway.
          </p>

          {view.needsYou.map((r) => (
            <AskCard key={r.lineNo} row={r} onAnswer={answer} busy={pending} />
          ))}
        </section>
      )}

      {/* ---- DOES THIS SHEET NUMBER THE PADS THE WAY YOU DO? -------------
           The most likely way a takeover import goes wrong, and until now it
           produced a screen that looked fine: The Haven's pads are 1, 2, 6, 7,
           9, 10, 11, 14, 15-24, 26, 27, 28, so a seller's book numbered 1..21
           matches FIFTEEN of them by coincidence and imports them without a
           word. Nothing anywhere compared the two lists. */}
      {(view.reconciliation.wouldCreate.length > 0 ||
        view.reconciliation.neverMentioned.length > 0) && (
        <div
          className="ll-card ll-card-pad"
          style={{
            marginTop: 14,
            borderLeft: view.reconciliation.looksMisnumbered ? "4px solid var(--gold)" : undefined,
          }}
        >
          <strong style={{ fontSize: 15 }}>
            {view.reconciliation.looksMisnumbered
              ? "This list may be numbered differently from your lots"
              : "How this list lines up with your lots"}
          </strong>

          {view.reconciliation.looksMisnumbered && (
            <p style={{ fontSize: 13.5, margin: "6px 0 0", lineHeight: 1.55 }}>
              It names {view.reconciliation.wouldCreate.length} lots you
              don&apos;t have and never mentions{" "}
              {view.reconciliation.neverMentioned.length} you do. That usually
              means whoever wrote it numbered their own list rather than using
              your lot numbers — in which case the ones that <em>did</em> match
              are matching by coincidence, and those households would go onto
              the wrong lots. Worth a phone call before you put anyone in.
            </p>
          )}

          <ul className="mut" style={{ fontSize: 13.5, margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
            <li>
              Matched {view.reconciliation.matched.length} of your{" "}
              {view.reconciliation.parkLots.length} lots.
            </li>
            {view.reconciliation.wouldCreate.length > 0 && (
              <li>
                Not in your park:{" "}
                <strong>{view.reconciliation.wouldCreate.join(", ")}</strong>.
                {" "}Creating {view.reconciliation.wouldCreate.length === 1 ? "it" : "them"} would
                take you to {view.reconciliation.parkLots.length + view.reconciliation.wouldCreate.length} lots,
                and every shared cost is divided by that number.
              </li>
            )}
            {view.reconciliation.neverMentioned.length > 0 && (
              <li>
                Your lots this list never mentions:{" "}
                <strong>{view.reconciliation.neverMentioned.join(", ")}</strong>.
              </li>
            )}
          </ul>
        </div>
      )}

      {/* ---- WHAT WE REFUSED TO KEEP ------------------------------------- */}
      {view.refusedColumns.length > 0 && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
          <strong style={{ fontSize: 15 }}>
            We didn&apos;t import{" "}
            {view.refusedColumns.map((c) => `"${c}"`).join(", ")}
          </strong>
          <p className="mut" style={{ fontSize: 13.5, margin: "6px 0 0", lineHeight: 1.55 }}>
            Socials, dates of birth and bank details aren&apos;t kept here — not in
            the records, and not in the copy of what you pasted. We administer
            your park; we&apos;re not a screening bureau, and the safest place for
            that information is nowhere. Everything else on those lines came
            through.
          </p>
        </div>
      )}

      {/* ---- The NAMELESS ROLL. His sheet has lots and rents and nobody on
              it. That is a real shape, not a broken one, and it is exactly
              what a proforma looks like. We set up inventory and the money,
              and we record no tenants — because inventing them is the one
              thing this importer will not do. ------------------------------ */}
      {view.namelessRoll && (
        <section style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 6px" }}>
            This list has lots and rents, but no names
          </h2>
          <p className="mut" style={{ margin: "0 0 14px", lineHeight: 1.5 }}>
            So we won&apos;t record anyone as living anywhere — it doesn&apos;t say
            who. We&apos;ll set up {view.rates.length}{" "}
            {view.rates.length === 1 ? "lot" : "lots"} and what each one brings
            in today. Add the people as you meet them; every lot below will be
            waiting for a name.
          </p>
          <div className="ll-card">
            {view.rates.map((r) => (
              <div
                key={r.lineNo}
                style={{
                  padding: "10px 14px", borderTop: "1px solid rgba(0,0,0,.06)",
                  display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
                }}
              >
                <strong style={{ minWidth: 72 }}>Lot {r.lotLabel}</strong>
                <span className="mut" style={{ flex: 1 }}>no name on the list</span>
                <span>{r.amount == null ? "Rent not set" : money(r.amount)}</span>
                {r.createsLot && <span className="ll-pill slate">new lot</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Section 4: the boring part, and it should look boring. ------- */}
      {view.ready.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 10px" }}>Ready to go in ({view.ready.length})</h2>
          <div className="ll-card">
            {view.ready.map((r) => (
              <div
                key={r.lineNo}
                style={{
                  padding: "10px 14px",
                  borderTop: "1px solid rgba(0,0,0,.06)",
                  cursor: "pointer",
                }}
                onClick={() => setExpanded(expanded === r.lineNo ? null : r.lineNo)}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong style={{ minWidth: 62 }}>Lot {r.lotLabel}</strong>
                  <span style={{ flex: 1 }}>{r.name}</span>
                  <span className="mut">
                    {r.amount == null ? "Rent not set" : money(r.amount)}
                  </span>
                  <span className="mut" style={{ fontSize: 13 }}>{r.term}</span>
                  {r.createsLot && <span className="ll-pill slate">new lot</span>}
                </div>
                <ContactLine email={r.email} phone={r.phone} />
                {expanded === r.lineNo && (
                  <div style={{ marginTop: 10, fontSize: 14 }}>
                    <div className="mut" style={{ marginBottom: 6 }}>
                      From line {r.lineNo}:
                    </div>
                    <pre
                      style={{
                        margin: 0, padding: 8, fontSize: 12, overflowX: "auto",
                        background: "rgba(0,0,0,.04)", borderRadius: 6,
                      }}
                    >{r.source.join("\n")}</pre>
                    {r.notes.length > 0 && (
                      <>
                        <div className="mut" style={{ margin: "10px 0 4px" }}>
                          We&apos;re also keeping, as notes:
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                          {r.notes.map((n, i) => <li key={i}>{n}</li>)}
                        </ul>
                      </>
                    )}
                    <button
                      className="ll-btn ghost"
                      style={{ marginTop: 12 }}
                      disabled={pending}
                      onClick={(e) => { e.stopPropagation(); answer(r.lineNo, { skip: true }); }}
                    >
                      Don&apos;t import this row
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Footer: lines we skipped. NEVER hidden. ---------------------- */}
      {skipped.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <button className="ll-btn ghost" onClick={() => setShowSkipped(!showSkipped)}>
            Lines we skipped ({skipped.length}) {showSkipped ? "▾" : "▸"}
          </button>
          {showSkipped && (
            <div className="ll-card ll-card-pad" style={{ marginTop: 10 }}>
              {skipped.map((s) => (
                <div key={s.lineNo} style={{ padding: "4px 0", fontSize: 14 }}>
                  <span className="mut" style={{ display: "inline-block", minWidth: 64 }}>
                    Line {s.lineNo}
                  </span>
                  <span>{s.text || <em className="mut">blank</em>}</span>
                  {s.why && <span className="mut"> — {s.why}</span>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---- The paste itself: "attach the page", and it costs one <pre>. - */}
      <section style={{ marginTop: 22 }}>
        <button className="ll-btn ghost" onClick={() => setShowPaste(!showPaste)}>
          {showPaste ? "Hide the paste" : "Show the paste"}
        </button>
        {showPaste && (
          <pre
            style={{
              marginTop: 10, padding: 12, fontSize: 12, maxHeight: 320,
              overflow: "auto", background: "rgba(0,0,0,.04)", borderRadius: 8,
            }}
          >{view.rawText}</pre>
        )}
      </section>

      {/* ---- The sticky commit bar. -------------------------------------- */}
      <div
        style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 20,
          background: "var(--card)", borderTop: "1px solid rgba(0,0,0,.12)",
          padding: "12px 16px",
        }}
      >
        <div
          style={{
            maxWidth: 760, margin: "0 auto", display: "flex",
            alignItems: "center", gap: 12, flexWrap: "wrap",
          }}
        >
          <span className="mut" style={{ flex: 1, fontSize: 14 }}>
            {view.namelessRoll
              ? `${view.rates.length} lots · no names on this list · ${walk.length + absent.length} empty`
              : `${view.ready.length} ready · ${view.needsYou.length} need you · ${walk.length + absent.length} empty`}
          </span>
          <button
            className="ll-btn"
            disabled={pending || (view.namelessRoll ? view.rates.length === 0 : view.ready.length === 0)}
            onClick={() => setConfirming(true)}
          >
            {view.namelessRoll
              ? `Set up ${view.rates.length} ${view.rates.length === 1 ? "lot" : "lots"}`
              : `Put ${view.ready.length} ${view.ready.length === 1 ? "tenant" : "tenants"} in`}
          </button>
        </div>
      </div>

      {confirming && (
        <div className="ll-overlay" onClick={() => setConfirming(false)}>
          <div className="ll-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ll-modal-head">
              <strong>Ready?</strong>
              <button className="ll-x" onClick={() => setConfirming(false)}>×</button>
            </div>
            <div className="ll-modal-body">
              <p style={{ marginTop: 0, lineHeight: 1.5 }}>
                {view.namelessRoll ? (
                  <>
                    This sets up {view.rates.length}{" "}
                    {view.rates.length === 1 ? "lot" : "lots"} and what each one
                    rents for. <strong>Nobody is recorded as living on them</strong> —
                    your list doesn&apos;t say who.
                  </>
                ) : (
                  <>
                    This adds {view.ready.length}{" "}
                    {view.ready.length === 1 ? "tenant" : "tenants"}
                    {view.lotsToCreate.length > 0 && <>, creates {view.lotsToCreate.length}{" "}
                      {view.lotsToCreate.length === 1 ? "lot" : "lots"}</>}.
                  </>
                )}
              </p>
              <p className="mut" style={{ lineHeight: 1.5 }}>
                Nothing gets texted, emailed, or charged to anybody. Rent amounts
                come in as the list&apos;s numbers — not as anything a household
                has confirmed — and the rent roll will say so.
              </p>
              <p className="mut" style={{ lineHeight: 1.5 }}>
                You can undo the whole thing afterwards.
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button className="ll-btn" onClick={commit} disabled={pending}>
                  {pending ? "Putting them in…" : "Put them in"}
                </button>
                <button className="ll-btn ghost" onClick={() => setConfirming(false)}>Back</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function perTerm(term: string): string {
  switch (term) {
    case "nightly": return "a night";
    case "weekly": return "a week";
    case "monthly": return "a month";
    case "seasonal": return "for the season";
    case "annual": return "a year";
    default: return term;
  }
}

/**
 * One question, stated in his words, showing the line it came from, offering
 * the smallest set of real choices. Never a free-form "fix this".
 */
/**
 * WHAT WE PICKED UP TO REACH THEM WITH.
 *
 * On both the ready rows and the ones still needing an answer — a household
 * stuck behind "create this lot" has an email just as much as a clean one
 * does, and this line is how the owner sees, before committing, which of his
 * residents can be invited with one message and which need a slip printing.
 *
 * Neither is permission. The email is stored and used only for the invite he
 * chooses to send; the number goes where nothing automated can reach it.
 */
function ContactLine({ email, phone }: { email: string | null; phone: string | null }) {
  if (!email && !phone) return null;
  return (
    <div className="mut" style={{ fontSize: 13, marginTop: 3 }}>
      {email && <span>✉ {email}</span>}
      {email && phone && <span> · </span>}
      {phone && <span>☎ {phone}</span>}
    </div>
  );
}

function AskCard({
  row, onAnswer, busy,
}: {
  row: PlannedRow;
  onAnswer: (lineNo: number, resolved: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(row.name ?? "");
  const [rent, setRent] = useState(row.amount == null ? "" : String(row.amount));

  const primary = row.blockers[0] as ImportBlocker | undefined;
  const title = row.lotLabel ? `Lot ${row.lotLabel}` : `Line ${row.lineNo}`;

  // A card offers a control for EVERY blocker it has, not just the first one.
  // A row that needs both a name and a lot must be answerable in one pass —
  // otherwise he types the name, taps Save, and the row is still stuck with no
  // visible way forward. That is the dead end the whole screen exists to avoid.
  const has = (b: ImportBlocker) => row.blockers.includes(b);
  const wantsName = has("no_name");
  const wantsRent = has("bad_amount") || has("no_name");

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <strong>{title}</strong>
        <span className="ll-pill warn">{shortReason(primary)}</span>
      </div>

      <ContactLine email={row.email} phone={row.phone} />

      {/* "His sheet" assumed a seller. Most parks were never bought, and the
          list is often the owner's own. */}
      <div className="mut" style={{ margin: "10px 0 4px", fontSize: 13 }}>The list says:</div>
      <pre
        style={{
          margin: 0, padding: 8, fontSize: 12, overflowX: "auto",
          background: "rgba(0,0,0,.04)", borderRadius: 6,
        }}
      >{row.source.join("\n")}</pre>

      <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
        {row.blockers.map((b) => (
          <li key={b}>{importBlockerText(b, row.lotLabel ?? undefined)}</li>
        ))}
      </ul>

      {(wantsName || wantsRent) && (
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          {wantsName && (
            <label className="ll-field" style={{ fontSize: 13 }}>
              <span className="mut">Who&apos;s on {row.lotLabel ? `lot ${row.lotLabel}` : "it"}?</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            </label>
          )}
          {wantsRent && (
            <label className="ll-field" style={{ fontSize: 13 }}>
              <span className="mut">Rent {has("bad_amount") ? "" : "(optional)"}</span>
              <input
                value={rent}
                onChange={(e) => setRent(e.target.value)}
                inputMode="decimal"
                placeholder="385"
              />
            </label>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {/* Every blocker gets its own control, and they compose: a row missing
            both a name and a lot shows the name box AND the create button. */}
        {has("lot_unknown") && row.lotLabel && (
          <button
            className="ll-btn"
            disabled={busy}
            onClick={() => onAnswer(row.lineNo, { createLot: row.lotLabel })}
          >
            Create lot {row.lotLabel}
          </button>
        )}
        {(wantsName || wantsRent) && (
          <button
            className="ll-btn"
            disabled={busy || (wantsName && !name.trim())}
            onClick={() =>
              onAnswer(row.lineNo, {
                name: name.trim() || undefined,
                rent: rent.trim() || undefined,
              })
            }
          >
            Save
          </button>
        )}
        {has("lot_twice_in_paste") && row.name && (
          <button
            className="ll-btn"
            disabled={busy}
            onClick={() => onAnswer(row.lineNo, { current: true })}
          >
            {row.name} lives there now
          </button>
        )}
        <button className="ll-btn ghost" disabled={busy} onClick={() => onAnswer(row.lineNo, { skip: true })}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

function shortReason(b: ImportBlocker | undefined): string {
  switch (b) {
    case "no_name": return "needs a name";
    case "no_lot": return "needs a lot";
    case "lot_unknown": return "no lot like that";
    case "lot_ambiguous": return "which lot?";
    case "lot_taken": return "lot taken";
    case "lot_twice_in_paste": return "two people on it";
    case "label_too_long": return "odd lot name";
    case "bad_amount": return "rent unreadable";
    case "no_season": return "no season set";
    default: return "needs you";
  }
}

/**
 * Screen 3 — the receipt. Not a green tick: the number, and where it came from.
 */
function Receipt({ view }: { view: ReadView }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const tenants = num(view.counts, "tenants");
  const monthly = num(view.counts, "monthly");
  const failed = num(view.counts, "failed");
  const failures = commitFailures(view.counts);

  return (
    <div className="wrap" style={{ paddingTop: 24, paddingBottom: 60, maxWidth: 640 }}>
      <h1 style={{ fontSize: 26, margin: "0 0 16px" }}>
        {tenants} {tenants === 1 ? "tenant is" : "tenants are"} in. ✓
      </h1>

      <div className="ll-card ll-card-pad">
        <div style={{ display: "grid", gap: 6, fontVariantNumeric: "tabular-nums" }}>
          <Row label="expected each month" value={money(monthly)} strong />
          <Row label="confirmed by tenants" value={money(0)} />
          <Row label="from the old roll only" value={money(monthly)} strong />
        </div>
        <p className="mut" style={{ marginTop: 14, marginBottom: 0, lineHeight: 1.5 }}>
          Every one of those came off his spreadsheet. As you confirm them at the
          window over the next month, this splits — and the bottom line is the
          one you&apos;re still exposed on.
        </p>
      </div>

      {failed > 0 && (
        <div
          className="ll-card ll-card-pad"
          style={{ marginTop: 14, borderLeft: "4px solid var(--warn)" }}
        >
          <strong>
            {/* {" "} explicitly: the DOM came back ["1"," ","row","didn't take"]
                — JSX dropped the space after the ternary and it read
                "1 rowdidn't take". Pre-dates this card; visible now that the
                card actually appears. */}
            {failed} {failed === 1 ? "row" : "rows"}{" "}didn&apos;t take
          </strong>
          {failures.length > 0 ? (
            <>
              {/* NAMED, because "open the rent roll and look" is not a task
                  anybody completes on a 79-row park — and an unfiled
                  household is never billed and never appears again. */}
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                {failures.map((f, i) => (
                  <li key={i}>
                    <strong>
                      {f.lot ? `Lot ${f.lot}` : "No lot"}
                      {f.name ? ` — ${f.name}` : ""}
                    </strong>
                    <span className="mut"> · {f.message}</span>
                  </li>
                ))}
              </ul>
              <p className="mut" style={{ margin: "10px 0 0", lineHeight: 1.5 }}>
                Everything else went in. Add these by hand on the rent roll, or
                fix the line and paste the list again.
              </p>
            </>
          ) : (
            <p className="mut" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
              Everything else went in. Open the rent roll to see where the gaps are.
            </p>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
        <Link className="ll-btn" href="/park">See my rent roll</Link>
        <button
          className="ll-btn ghost"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await undoImport(view.batchId);
              toast(res.ok ? (res.signal ?? "Undone.") : (res.error ?? "Couldn't undo that."));
              router.refresh();
            })
          }
        >
          Undo this import
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ minWidth: 96, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{value}</span>
      <span className="mut">{label}</span>
    </div>
  );
}
