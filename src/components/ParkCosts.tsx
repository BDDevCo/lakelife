"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { previewCostSplit, recordCost, removeCost, type CostRow, type BillableParkJob } from "@/app/park/cost-actions";
import {
  COST_CATEGORY_LABEL, allocationSummary,
  type CostCategory, type CostAllocation, carriedLine,
} from "@/app/park/cost-helpers";
import type { recoveryByCategory } from "@/app/park/cost-helpers";

/**
 * WHAT THE PARK PAYS, AND WHAT COMES BACK.
 *
 * The screen's job is to make one number impossible to miss: what the park is
 * STILL CARRYING after recovery. That is the number the proforma is betting on
 * and the one that quietly drifts — a vacancy, an uncategorised bill, a month
 * nobody split.
 */

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// `unit_electric` is deliberately absent: power for a home the PARK owns is
// metered to that home and billed directly, never divided across the lots.
// `canSplit` in cost-helpers is the rule; this list is the courtesy.
const CATEGORIES: CostCategory[] = [
  "water", "sewer", "trash", "common_electric", "grounds", "snow",
  // TAX AND INSURANCE BELONG HERE because a reminder can be SET for them.
  // `SCHEDULABLE_CATEGORIES` has carried both since 0123 and this list did
  // not, so /park/today could raise "Property tax for 2027 is due about now",
  // link to this page, and refuse to be dismissed — while the form it sent
  // him to had no way to enter one. `recordCost` accepts both and the
  // park_costs CHECK allows both; only the dropdown was missing them.
  //
  // cost-helpers spells out this exact hazard for `unit_electric` — "the
  // reminder would send him to a screen where it is not in the dropdown" —
  // and then tax and insurance were added to one list and not the other.
  "tax", "insurance",
  "other",
];

export function ParkCosts({
  parkId, rows, summary, fees, schedules, recoveredByFee, billable = [],
}: {
  parkId: string;
  rows: CostRow[];
  summary: ReturnType<typeof recoveryByCategory>;
  /** The fee section, rendered by the server page. */
  fees?: React.ReactNode;
  /** The recurring-bill reminders, same composition as `fees`. */
  schedules?: React.ReactNode;
  /**
   * TRUE when a live fee already covers these costs. Without this the summary
   * shouts "still yours" at a park that recovers everything through a flat
   * grounds fee — technically true of the per-bill split, and completely
   * misleading about the business.
   */
  recoveredByFee?: boolean;
  /**
   * Work the park has paid LakeLife for and not yet passed on. Rendered as
   * one-tap prefills — the last step in the loop that was still a person
   * reading a figure off one screen and typing it into another.
   */
  billable?: BillableParkJob[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  /** True = the park pays this one and nobody is billed a share (0118). */
  const [parkCarries, setParkCarries] = useState(false);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<CostCategory>("water");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<CostAllocation | null>(null);
  // Which prefill is being saved, so only its own button says "Splitting…".
  const [fillingId, setFillingId] = useState<string | null>(null);

  const amountNum = () => Number(amount.replace(/[$,\s]/g, ""));

  function doPreview() {
    start(async () => {
      const res = await previewCostSplit(parkId, category, from, to, amountNum());
      if (!res.ok || !res.preview) { toast(res.error ?? "Couldn't work that out."); return; }
      setPreview(res.preview.allocation);
    });
  }

  /**
   * ONE TAP: take the job's own figures and split them.
   *
   * It does NOT open the form pre-filled. A form asking him to confirm numbers
   * he did not type is a form he stops reading, and the whole point is that
   * nobody retypes the amount. The split is previewed on the row before he
   * commits.
   */
  function fillFrom(j: BillableParkJob) {
    setFillingId(j.jobId);
    start(async () => {
      const res = await recordCost(
        parkId, "grounds", j.periodStart, j.periodEnd, j.amount, j.note, j.jobId,
      );
      setFillingId(null);
      if (!res.ok) { toast(res.error ?? "Couldn't save that."); return; }
      toast(res.signal ?? "Split across the lots.");
      router.refresh();
    });
  }

  function save() {
    start(async () => {
      const res = await recordCost(parkId, category, from, to, amountNum(), note, null, parkCarries);
      if (!res.ok) { toast(res.error ?? "Couldn't save that."); return; }
      toast(res.signal ?? "Saved.");
      setOpen(false); setPreview(null); setAmount(""); setNote("");
      router.refresh();
    });
  }

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Costs &amp; fees</h1>
      <p className="mut" style={{ marginTop: 0, lineHeight: 1.5, maxWidth: 640 }}>
        What the park pays, and what it charges. Enter your bills here and the
        fee below gets checked against them — that comparison is the only
        honest answer to &ldquo;is my grounds fee set right?&rdquo;
      </p>

      {/* ---- THE NUMBER THAT MATTERS: what is still yours. --------------- */}
      {summary.lines.length > 0 && (
        <section className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
          <div style={{ display: "grid", gap: 3, fontVariantNumeric: "tabular-nums" }}>
            <Row label="you paid" value={money(summary.paid)} />
            {/* THREE NUMBERS, NOT ONE. "Passed on" used to be the amount he
                INTENDED to split, and nothing billed from it — so the screen
                reassured him about money no household had been asked for. */}
            <Row label="split across the lots" value={money(summary.allocated)} />
            <Row label="actually on a bill" value={money(summary.billed)} />
            {/* 0112's whole point, and until now it lived only in the preview:
                the empty pads are the owner's to pay for. */}
            {summary.absorbed > 0 && (
              <Row label="you carried for the empty lots" value={money(summary.absorbed)} />
            )}
            {summary.absorbedUnknown > 0 && (
              <p className="mut" style={{ fontSize: 12, margin: "4px 0 0", lineHeight: 1.5 }}>
                {summary.absorbedUnknown === 1
                  ? "One older bill was recorded before we started tracking who carried what, so the figure above is lower than the truth."
                  : `${summary.absorbedUnknown} older bills were recorded before we started tracking who carried what, so the figure above is lower than the truth.`}
              </p>
            )}
            {summary.allocated > summary.billed && (
              <p className="mut" style={{ fontSize: 12, margin: "4px 0 0", lineHeight: 1.5 }}>
                {/* The explicit space is load-bearing: JSX drops the one after
                    a line-leading interpolation, and this rendered
                    "$443.71is split but not yet billed" on screen. */}
                {money(summary.allocated - summary.billed)}{" "}is split but not
                yet billed — it goes onto each household&apos;s next rent bill
                when you raise the month.
              </p>
            )}
            <Row
              label={recoveredByFee ? "covered by your fee below" : summary.net < 0 ? "still yours" : "net"}
              value={money(Math.abs(summary.net))}
              strong
            />
          </div>

          <div style={{ marginTop: 14, borderTop: "1px solid rgba(0,0,0,.08)", paddingTop: 12 }}>
            {summary.lines.map((l) => (
              <div key={l.category}
                style={{ display: "flex", gap: 10, padding: "4px 0", flexWrap: "wrap", fontSize: 14 }}>
                <span style={{ flex: 1 }}>{COST_CATEGORY_LABEL[l.category]}</span>
                <span className="mut">{money(l.paid)} paid</span>
                <span className="mut">
                  {money(l.billed)} billed
                  {l.allocated > l.billed ? ` · ${money(l.allocated - l.billed)} waiting` : ""}
                </span>
                <span style={{ minWidth: 92, textAlign: "right", fontWeight: 700 }}>
                  {l.net < 0 ? `−${money(Math.abs(l.net))}` : money(l.net)}
                </span>
              </div>
            ))}
          </div>
          <p className="mut" style={{ fontSize: 13, marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
            {recoveredByFee ? (
              <>
                You recover these through a flat fee rather than splitting each
                bill, so &ldquo;back&rdquo; reads zero here on purpose. Whether
                the fee actually covers them is the line below.
              </>
            ) : (
              <>
                A category showing the full amount as &ldquo;still yours&rdquo; is
                one you haven&apos;t passed on — grounds and lighting are often
                deliberate, water and trash usually aren&apos;t.
              </>
            )}
          </p>
        </section>
      )}

      {/* WORK ALREADY PAID FOR, WAITING TO BE PASSED ON.

          Above the manual form deliberately: the figures are already exact,

          and the form below exists for the water bill that arrives on paper. */}

      {billable.length > 0 && (

        <div style={{ marginTop: 12 }}>

          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>

            Work LakeLife has done here, not yet passed on

          </div>

          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 8px", lineHeight: 1.5 }}>

            Work on the common ground. One tap splits it across the lots the

            same way a water bill splits — nothing to retype.

          </p>

          {billable.map((j) => (

            <div key={j.jobId} style={{

              display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",

              padding: "8px 0", borderTop: "1px solid var(--line)",

            }}>

              <span style={{ fontSize: 13.5, fontWeight: 700 }}>{j.service}</span>

              <span className="mut" style={{ fontSize: 12.5 }}>{j.date}</span>

              <span style={{ fontSize: 14, fontWeight: 800, marginLeft: "auto" }}>

                {j.amount.toLocaleString(undefined, { style: "currency", currency: "USD" })}

              </span>

              <button className="ll-btn ghost sm" disabled={busy}

                onClick={() => fillFrom(j)}>

                {fillingId === j.jobId ? "Splitting…" : "Split across the lots"}

              </button>

            </div>

          ))}

        </div>

      )}


      {!open ? (
        <button className="ll-btn" style={{ marginTop: 16 }} onClick={() => setOpen(true)}>
          Enter a bill
        </button>
      ) : (
        <section className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 17, margin: "0 0 12px" }}>Enter a bill</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">What for</span>
              <select value={category}
                onChange={(e) => { setCategory(e.target.value as CostCategory); setPreview(null); }}
                style={{ marginTop: 4 }}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{COST_CATEGORY_LABEL[c]}</option>
                ))}
              </select>
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Period from</span>
              <input type="date" value={from}
                onChange={(e) => { setFrom(e.target.value); setPreview(null); }} style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">to</span>
              <input type="date" value={to}
                onChange={(e) => { setTo(e.target.value); setPreview(null); }} style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">What it cost</span>
              <input value={amount} inputMode="decimal" placeholder="380.00"
                onChange={(e) => { setAmount(e.target.value); setPreview(null); }} style={{ marginTop: 4 }} />
            </label>
          </div>

          <label className="ll-field" style={{ fontSize: 13, marginTop: 12 }}>
            <span className="mut">Which bill (so you can find it later)</span>
            <input value={note} placeholder="March water — Wolcottville Utilities, acct 4471"
              onChange={(e) => setNote(e.target.value)} style={{ marginTop: 4 }} />
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            {/* No split to show when he is carrying it — offering the button
                anyway would preview an allocation that is never going to
                happen. */}
            <button className="ll-btn ghost" onClick={doPreview}
              disabled={busy || parkCarries || !from || !to || !amount}>
              {busy ? "Working…" : "Show me the split"}
            </button>
            <button className="ll-btn ghost" onClick={() => { setOpen(false); setPreview(null); }}>
              Cancel
            </button>
          </div>

          {/* WHO PAYS FOR THIS ONE.
              Everything on this screen has always been shared, so shared stays
              the default — but the guest boat is bookable by short-stay guests
              only, and winterizing it is not a cost of living on lot 14. Left
              unasked it would have gone in as "other" and landed on all
              twenty-one rentable lots. */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Who pays for it</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className={parkCarries ? "ll-btn ghost sm" : "ll-btn sm"}
                onClick={() => { setParkCarries(false); setPreview(null); }}
              >
                Split it across the lots
              </button>
              <button
                type="button"
                className={parkCarries ? "ll-btn sm" : "ll-btn ghost sm"}
                onClick={() => { setParkCarries(true); setPreview(null); }}
              >
                I carry this one
              </button>
            </div>
            <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
              {parkCarries
                ? "Recorded in your books and counted in the fee comparison — just not divided. For things that serve your side of the business: the guest boat, a home you own, a repair you've decided to eat."
                : "The normal way. Every rentable lot takes an equal share, and you carry the empty ones."}
            </p>
          </div>

          {/* A cost the park carries has no split to preview — the decision IS
              the whole thing, so it goes straight to the button. */}
          {/* THE DATES ARE NOT OPTIONAL ON THIS PATH EITHER. The split path
              gates on !from || !to; this one gated on the amount alone, and
              recordCost's parkCarries branch returns before previewCostSplit —
              the only thing that validates the period. So an empty date
              reached Postgres as "" against a `date not null` column, came
              back 22007, and the toast said "try again" about a path that
              could never work. */}
          {parkCarries && (
            <button className="ll-btn" onClick={save}
                    disabled={busy || !from || !to || !(amountNum() > 0)}
                    style={{ marginTop: 14 }}>
              {busy ? "Saving…" : "Record it — I carry this one"}
            </button>
          )}

          {!parkCarries && preview && (
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 16 }}>
                {allocationSummary(preview, category)}
              </p>
              {/* THE PER-LOT BREAKDOWN only exists when somebody is being
                  billed. The DECISION always does. */}
              {preview.shares.length > 0 && (
                <div style={{ display: "grid", gap: 2, fontVariantNumeric: "tabular-nums", marginBottom: 12 }}>
                  <Row label="you paid" value={money(amountNum())} />
                  <Row label="passed on" value={money(preview.allocated)} />
                  <Row label="you carry" value={money(preview.parkAbsorbs)} strong />
                </div>
              )}

              {/* SAVING WAS GATED ON THERE BEING SOMEBODY TO BILL.
                  A park with no tenancies on the roll — The Haven until
                  closing, and every park on its first day — got the sentence
                  "nobody is on a lot, so you carry all $380.00" and no button.
                  The server has supported this since 0112 ("an empty park is no
                  longer a refusal: the bill is recorded and the park carries
                  all of it"); only the screen refused. A bill he cannot record
                  is a bill missing from his books and from his own fee
                  comparison, which is the one thing this page is for. */}
              {preview.problem == null && (
                <button className="ll-btn" onClick={save} disabled={busy}>
                  {preview.shares.length > 0 ? "Save it and split it" : "Record it — I carry this one"}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {/* ---- the bills themselves ---------------------------------------- */}
      {rows.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 10px" }}>Bills</h2>
          <div className="ll-card">
            {rows.map((r) => (
              <div key={r.id}
                style={{ padding: "10px 14px", borderTop: "1px solid rgba(0,0,0,.06)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong style={{ minWidth: 170 }}>{COST_CATEGORY_LABEL[r.category]}</strong>
                <span className="mut" style={{ minWidth: 170 }}>
                  {r.periodStart} → {r.periodEnd}
                </span>
                <span style={{ flex: 1 }}>{money(r.amountPaid)}</span>
                {/* WHAT HE CARRIED, on the row, not just in the preview he saw
                    once before saving. "across 19 lots" was true and hid the
                    denominator of 21 and the money that difference cost him. */}
                <span className="mut" style={{ flex: 1, minWidth: 240 }}>
                  {carriedLine(r)}
                </span>
                <button className="ll-btn ghost" disabled={busy}
                  onClick={() =>
                    start(async () => {
                      const res = await removeCost(parkId, r.id);
                      toast(res.ok ? (res.signal ?? "Removed.") : (res.error ?? "Couldn't remove that."));
                      router.refresh();
                    })
                  }>
                  Remove
                </button>
              </div>
            ))}
          </div>
          {rows.some((r) => r.sourceNote) && (
            <p className="mut" style={{ fontSize: 13, marginTop: 10 }}>
              Every bill keeps the note you typed, so a resident asking &ldquo;what
              is this $20?&rdquo; has an answer with a date on it.
            </p>
          )}
        </section>
      )}

      {/* The reminders sit between the bills and the fees: they are about the
          same bills above, and they are what puts one on the morning screen. */}
      {schedules}

      {fees}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ minWidth: 110, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{value}</span>
      <span className="mut">{label}</span>
    </div>
  );
}
