"use client";

/**
 * THE CREW CALENDAR — the month view a crew never had (2026-07-26). Until now
 * a crew could only see TODAY: next week's pier pulls, last month's work, and
 * the free return visit they booked were all invisible to them.
 *
 * Deliberately the same visual language as the ops calendar
 * (src/components/ops/OpsCalendar.tsx): identical status colors, identical
 * dot-per-job grid, so the product reads as one system. What differs is whose
 * view it is — these are only THIS crew's jobs, and the only dollars shown are
 * the crew's own take-home (rule 1: no customer price, no margin, ever).
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { loadCrewCalendarYear } from "@/app/vendor/job-detail-actions";
import type { CrewCalRow } from "@/app/vendor/job-detail-data";
import { formatCurrency } from "@/app/vendor/earnings-helpers";

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

type StatusKey = "requested" | "scheduled" | "in_progress" | "complete" | "paid";

/** Mirrors OpsCalendar's map exactly — one product, one color language. */
const STATUS_COLORS: Record<StatusKey, { dot: string; bg: string; fg: string; label: string }> = {
  requested: { dot: "var(--sun)", bg: "var(--sun-soft)", fg: "#8a6420", label: "Requested" },
  scheduled: { dot: "var(--teal)", bg: "#e0f0f3", fg: "var(--teal-dark)", label: "Scheduled" },
  in_progress: { dot: "var(--teal-dark)", bg: "#cfe6ea", fg: "var(--teal-dark)", label: "In progress" },
  complete: { dot: "var(--ok)", bg: "#e4f2ea", fg: "var(--ok)", label: "Complete" },
  paid: { dot: "var(--slate, #8a99a0)", bg: "#e9eff1", fg: "var(--sub)", label: "Paid" },
};
const LEGEND_ORDER: StatusKey[] = ["requested", "scheduled", "in_progress", "complete", "paid"];

function statusMeta(status: string) {
  return STATUS_COLORS[status as StatusKey] ?? { dot: "var(--sub)", bg: "#e9eff1", fg: "var(--sub)", label: status };
}

const pad = (n: number) => String(n).padStart(2, "0");

function prettyFullDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function VendorCalendar({
  today,
  initialYear,
  initialRows,
}: {
  today: string; // "YYYY-MM-DD" at the lakes, from the server
  initialYear: number;
  initialRows: CrewCalRow[];
}) {
  const todayYear = Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7));

  const [yearData, setYearData] = useState<Record<number, CrewCalRow[]>>({ [initialYear]: initialRows });
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialYear === todayYear ? todayMonth : 1);
  const [selectedDate, setSelectedDate] = useState<string | null>(
    initialYear === todayYear ? today : null,
  );
  const [pending, startTransition] = useTransition();

  function ensureYear(y: number) {
    if (yearData[y]) return;
    startTransition(async () => {
      try {
        const rows = await loadCrewCalendarYear(y);
        setYearData((prev) => ({ ...prev, [y]: rows }));
      } catch {
        toast("Couldn't load that year — try again.");
      }
    });
  }

  function goToMonth(y: number, m: number) {
    setYear(y);
    setMonth(m);
    setSelectedDate(y === todayYear && m === todayMonth ? today : null);
    ensureYear(y);
  }
  function prevMonth() {
    if (month === 1) goToMonth(year - 1, 12);
    else goToMonth(year, month - 1);
  }
  function nextMonth() {
    if (month === 12) goToMonth(year + 1, 1);
    else goToMonth(year, month + 1);
  }

  const rows = yearData[year] ?? [];
  const monthTitle = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const monthPrefix = `${year}-${pad(month)}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();

  const byDay = new Map<number, CrewCalRow[]>();
  for (const r of rows) {
    if (r.date.slice(0, 7) === monthPrefix) {
      const d = Number(r.date.slice(8, 10));
      byDay.set(d, [...(byDay.get(d) ?? []), r]);
    }
  }
  const cells: Array<{ day: number | null; jobs: CrewCalRow[] }> = [];
  for (let i = 0; i < firstDow; i++) cells.push({ day: null, jobs: [] });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, jobs: byDay.get(d) ?? [] });

  const monthRows = rows.filter((r) => r.date.slice(0, 7) === monthPrefix);
  const monthTakeHome = Math.round(monthRows.reduce((s, r) => s + (r.takeHome ?? 0), 0) * 100) / 100;

  const dayJobs = selectedDate ? rows.filter((r) => r.date === selectedDate) : [];
  const dayTakeHome = Math.round(dayJobs.reduce((s, r) => s + (r.takeHome ?? 0), 0) * 100) / 100;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <p className="mut" style={{ fontSize: 13, margin: 0 }}>
          {monthRows.length} job{monthRows.length === 1 ? "" : "s"} this month
          {monthTakeHome > 0 ? ` · ${formatCurrency(monthTakeHome)} take-home` : ""}
        </p>
        <button className="ll-btn ghost sm" onClick={() => goToMonth(todayYear, todayMonth)}>Today</button>
      </div>

      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <button className="ll-btn ghost sm" aria-label="Previous month" onClick={prevMonth}>‹</button>
          <h3 style={{ fontSize: 16 }}>
            {monthTitle}
            {pending && !yearData[year] ? <span className="mut" style={{ fontSize: 12, fontWeight: 600 }}> · loading…</span> : null}
          </h3>
          <button className="ll-btn ghost sm" aria-label="Next month" onClick={nextMonth}>›</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
          {DOW.map((d) => (
            <div key={d} className="mut" style={{ fontSize: 11, fontWeight: 800, textAlign: "center", padding: "2px 0" }}>
              {d}
            </div>
          ))}
          {cells.map((c, i) => {
            if (c.day == null) return <div key={`blank-${i}`} />;
            const dateStr = `${monthPrefix}-${pad(c.day)}`;
            const isToday = dateStr === today;
            const isSelected = dateStr === selectedDate;
            const has = c.jobs.length > 0;
            return (
              <button
                key={c.day}
                type="button"
                onClick={() => setSelectedDate(dateStr)}
                style={{
                  minHeight: 56, minWidth: 0, padding: "5px 4px", borderRadius: 8,
                  display: "flex", flexDirection: "column", gap: 3, textAlign: "left",
                  background: isSelected ? "#dceef1" : has ? "#f2f8f9" : "transparent",
                  border: isToday ? "1.5px solid var(--teal)" : "1.5px solid transparent",
                  boxShadow: isSelected ? "inset 0 0 0 1.5px var(--teal-dark)" : "none",
                  color: "inherit", font: "inherit", cursor: "pointer",
                }}
              >
                <span style={{ fontSize: 12, fontWeight: isToday ? 800 : 600, color: isToday ? "var(--teal-dark)" : undefined }}>
                  {c.day}
                </span>
                {has && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
                    {c.jobs.slice(0, 4).map((j) => (
                      <span
                        key={j.id}
                        aria-hidden
                        title={`${statusMeta(j.status).label} — ${j.service_name ?? "Service"}`}
                        style={{ width: 6.5, height: 6.5, borderRadius: 99, background: statusMeta(j.status).dot, flex: "0 0 auto" }}
                      />
                    ))}
                    {c.jobs.length > 4 && (
                      <span style={{ fontSize: 9.5, fontWeight: 800, color: "var(--sub)" }}>+{c.jobs.length - 4}</span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
          {LEGEND_ORDER.map((s) => {
            const m = STATUS_COLORS[s];
            return (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: 99, background: m.dot, flex: "0 0 auto" }} />
                <span className="mut" style={{ fontSize: 11.5, fontWeight: 700 }}>{m.label}</span>
              </div>
            );
          })}
        </div>

        {/* ---- the day panel: every job links to its own page ---- */}
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h4 style={{ fontSize: 14, marginBottom: 8 }}>
              {selectedDate ? prettyFullDate(selectedDate) : "Pick a day"}
            </h4>
            {dayTakeHome > 0 && (
              <span className="mut" style={{ fontSize: 12.5, fontWeight: 700 }}>
                {formatCurrency(dayTakeHome)} take-home
              </span>
            )}
          </div>

          {selectedDate == null ? (
            <p className="mut" style={{ fontSize: 13 }}>Tap a day to see what you&apos;re working.</p>
          ) : dayJobs.length === 0 ? (
            <p className="mut" style={{ fontSize: 13 }}>Nothing on your books this day. 🌊</p>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {dayJobs.map((j) => {
                const m = statusMeta(j.status);
                return (
                  <Link
                    key={j.id}
                    href={`/vendor/jobs/${j.id}`}
                    className="ll-card ll-card-pad"
                    style={{
                      display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap",
                      textDecoration: "none", color: "inherit",
                    }}
                  >
                    <span aria-hidden style={{ width: 9, height: 9, borderRadius: 99, background: m.dot, marginTop: 5, flex: "0 0 auto" }} />
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>
                        {j.service_name ?? "Service"}
                        {j.isCorrection ? <span className="ll-pill gold" style={{ fontSize: 10.5, marginLeft: 6 }}>Make it right</span> : null}
                      </div>
                      <div className="mut" style={{ fontSize: 12.5 }}>
                        {j.address ?? "Address on file"}{j.lake_name ? ` · ${j.lake_name}` : ""}
                      </div>
                      {j.takeHome != null && (
                        <div style={{ fontSize: 12.5, marginTop: 4 }}>
                          <b>{formatCurrency(j.takeHome)}</b>
                          <span className="mut">
                            {j.payoutStatus === "held" ? " · on hold" : j.payoutStatus === "released" ? " · released" : " · awaiting release"}
                          </span>
                        </div>
                      )}
                    </div>
                    <span className="ll-pill" style={{ background: m.bg, color: m.fg }}>{m.label}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
