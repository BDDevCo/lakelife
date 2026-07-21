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
  const csvHref = `/vendor/earnings/export?from=${range.from}&to=${range.to}`;
  const statementHref = `/vendor/earnings/statement?from=${range.from}&to=${range.to}`;

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Your earnings</h1>
      <p className="mut" style={{ fontSize: 14, marginBottom: 16, maxWidth: 560 }}>
        Payouts release every Friday once a job&apos;s photos are verified. These are your
        take-home numbers — yours to keep.
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
              style={{ display: "block", marginTop: 6, minHeight: 44, fontSize: 15, width: "100%" }}
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
        <div style={{ fontSize: 14, fontWeight: 700 }}>{row.service ?? "Service"}</div>
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
