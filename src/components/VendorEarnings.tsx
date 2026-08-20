"use client";

/**
 * "Your earnings" — a crew's own payout history, grouped by week, with CPA
 * exports (CSV + a print-to-PDF statement).
 *
 * CLAUDE.md rule 1: every dollar shown here is the crew's OWN take-home (their
 * vendor_cost). There is NO customer price and NO margin anywhere on this
 * screen — the data layer never loads them.
 */

import { useMemo, useState } from "react";
import type { EarningsTotals } from "@/app/vendor/earnings-data";
import {
  groupByWeek,
  formatCurrency,
  periodRanges,
  statusLabel,
  earningsRowLabel,
  tipsByCrew,
  type EarningRow,
} from "@/app/vendor/earnings-helpers";

type PeriodKey = "thisMonth" | "thisQuarter" | "ytd";

const PERIOD_LABEL: Record<PeriodKey, string> = {
  thisMonth: "This month",
  thisQuarter: "This quarter",
  ytd: "Year to date",
};

export function VendorEarnings({
  rows,
  totals,
  today,
}: {
  rows: EarningRow[];
  totals: EarningsTotals;
  today: string; // "YYYY-MM-DD" at the lakes (passed from the server)
}) {
  const [period, setPeriod] = useState<PeriodKey>("ytd");
  const ranges = useMemo(() => periodRanges(today), [today]);
  const groups = useMemo(() => groupByWeek(rows), [rows]);

  const range = ranges[period];
  const tips = useMemo(() => tipsByCrew(rows, range), [rows, range]);
  const csvHref = `/vendor/earnings/export?from=${range.from}&to=${range.to}`;
  const statementHref = `/vendor/earnings/statement?from=${range.from}&to=${range.to}`;

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Your earnings</h1>
      <p className="mut" style={{ fontSize: 14, marginBottom: 16, maxWidth: 560 }}>
        {/* THERE IS NO FRIDAY. `runMonthlyPayoutBatches` gates on
            `isLastDayOfMonth` (automation.ts) and nothing anywhere runs weekly.
            earnings-helpers.ts:214 found this exact falsehood in the per-row
            status label, fixed it there, and wrote down why — and the headline
            paragraph on the same screen kept saying it. Telling a crew the
            wrong week for their own money is the fastest way to lose one.
            The fee is not named here on purpose: it is a platform dial, and
            the button below prints the actual dollar amount. */}
        Your pay is released once a job&apos;s photos are verified, and goes out in the
        month-end payout. You can pull released money earlier from the card below,
        for a fee. These are your take-home numbers — yours to keep.
      </p>

      {/* Big totals row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <TotalCard label="This week" value={totals.thisWeek} />
        <TotalCard label="This month" value={totals.thisMonth} />
        <TotalCard label="Year to date" value={totals.ytd} />
      </div>

      {/* Export controls */}
      <div className="ll-card ll-card-pad" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label style={{ display: "block" }}>
            <span className="mut" style={{ fontSize: 13 }}>Statement period</span>
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as PeriodKey)}
              style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
            >
              {(Object.keys(PERIOD_LABEL) as PeriodKey[]).map((k) => (
                <option key={k} value={k}>
                  {PERIOD_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: 1, minWidth: 220 }}>
            <a className="ll-btn ghost sm" href={csvHref} style={{ minHeight: 44 }}>
              Download CSV
            </a>
            <a
              className="ll-btn ghost sm"
              href={statementHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{ minHeight: 44 }}
            >
              Print statement / Save as PDF
            </a>
          </div>
        </div>
        <p className="mut" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
          For your CPA: the CSV imports into bookkeeping software; the statement opens in a new tab —
          use your browser&apos;s Print → Save as PDF.
        </p>
      </div>

      {/* Weekly list */}
      {groups.length === 0 ? (
        <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
          <p className="mut" style={{ fontSize: 14, margin: 0 }}>
            No completed jobs yet — your payouts show up here after your first photo-verified job. 🌊
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {groups.map((g) => (
            <section key={g.key}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <h2 style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>{g.label}</h2>
                <span className="mut" style={{ fontSize: 13, fontWeight: 700 }}>
                  {formatCurrency(g.subtotal)}
                </span>
              </div>
              <div className="ll-card" style={{ overflow: "hidden" }}>
                {g.rows.map((r, i) => (
                  <JobRow key={r.id} row={r} first={i === 0} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {totals.jobCount > 0 && (
        <p className="mut" style={{ fontSize: 12.5, marginTop: 16 }}>
          {totals.jobCount} completed {totals.jobCount === 1 ? "job" : "jobs"} all-time ·{" "}
          {formatCurrency(totals.allTimeReleased)} released so far.
        </p>
      )}

      {tips.count > 0 && <TipsToPassOn tips={tips} periodLabel={PERIOD_LABEL[period]} />}
    </div>
  );
}

function TotalCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="ll-card ll-card-pad" style={{ padding: "14px 14px" }}>
      <div className="mut" style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: "var(--teal-dark)", marginTop: 2 }}>
        {formatCurrency(value)}
      </div>
    </div>
  );
}

/**
 * WHO GETS TIPPED OUT.
 *
 * LakeLife pushes money to ONE bank account per company, so every tip lands
 * with the owner no matter who earned it. Without this the owner has a lump
 * sum and no way to split it, and the person who was actually thanked never
 * sees a cent — which would defeat "every cent goes to the crew" one layer
 * below where that promise is enforced.
 *
 * Attribution is the truck/crew name from the route the job ran on. Tips we
 * cannot attribute are listed SEPARATELY rather than hidden or lumped in: the
 * owner still recognises their own job from the date and address, and a wrong
 * name here would send money to the wrong person.
 */
function TipsToPassOn({
  tips,
  periodLabel,
}: {
  tips: ReturnType<typeof tipsByCrew>;
  periodLabel: string;
}) {
  return (
    <div className="ll-card" style={{ marginBottom: 24, overflow: "hidden" }}>
      <div style={{ padding: "14px 14px 10px" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Tips to pass on</h2>
        <p className="mut" style={{ fontSize: 12.5, margin: "4px 0 0", lineHeight: 1.5 }}>
          {formatCurrency(tips.total)} from {tips.count} {tips.count === 1 ? "customer" : "customers"}
          {" "}· {periodLabel.toLowerCase()}. This is included in your payouts — it
          reaches your account with everything else, so the split is yours to make.
        </p>
      </div>

      {tips.byCrew.map((c, i) => (
        <div key={c.crew ?? "__none"} style={{ borderTop: i === 0 ? "1px solid var(--line)" : "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 14px 4px" }}>
            <strong style={{ fontSize: 14 }}>{c.crew ?? "Crew not recorded"}</strong>
            <span style={{ marginLeft: "auto", fontSize: 15, fontWeight: 800 }}>{formatCurrency(c.total)}</span>
          </div>
          {c.crew == null && (
            <p className="mut" style={{ fontSize: 12, margin: "0 14px 4px", lineHeight: 1.45 }}>
              These jobs weren&apos;t on a named truck, so we can&apos;t say which
              crew. The date and address should tell you who you sent.
            </p>
          )}
          {c.rows.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 10, padding: "3px 14px 3px", fontSize: 12.5 }}>
              <span className="mut" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {r.jobDate}{r.service ? ` · ${r.service}` : ""}{r.address ? ` · ${r.address}` : ""}
              </span>
              <span style={{ fontWeight: 700 }}>{formatCurrency(r.amount)}</span>
            </div>
          ))}
          <div style={{ height: 8 }} />
        </div>
      ))}
    </div>
  );
}

function JobRow({ row, first }: { row: EarningRow; first: boolean }) {
  const released = row.status === "released";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 14px",
        borderTop: first ? "none" : "1px solid var(--line)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{earningsRowLabel(row)}</div>
        <div className="mut" style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {row.jobDate}
          {row.address ? ` · ${row.address}` : ""}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>{formatCurrency(row.amount)}</div>
        <span className={`ll-pill ${released ? "ok" : "slate"}`} style={{ marginTop: 3 }}>
          {statusLabel(row.status)}
        </span>
      </div>
    </div>
  );
}
