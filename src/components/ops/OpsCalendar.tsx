"use client";

/**
 * Ops scheduling calendar: toggle a lake, browse Month or Year, see what's
 * requested/scheduled/in progress/complete/paid at a glance. Pure client
 * render off rows already on hand — the only network call is a year fetch
 * when navigation crosses into a year we haven't loaded yet (calendar-actions
 * .loadOpsCalendarYear). Logistics only, no dollar amounts (rule 1 doesn't
 * need it here and this view isn't the place for it).
 */

import { useState, useTransition } from "react";
import { ChoiceChips } from "@/components/wizard-controls";
import { toast } from "@/components/Toast";
import { loadOpsCalendarYear } from "@/app/ops/calendar-actions";
import type { CalRow } from "@/app/ops/calendar-data";

const LAKE_TZ = "America/Indiana/Indianapolis";
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const ALL_LAKES = "All lakes";

type StatusKey = "requested" | "scheduled" | "in_progress" | "complete" | "paid";

/** The one shared color map — every dot, square, and pill in this file reads from here. */
const STATUS_COLORS: Record<StatusKey, { dot: string; bg: string; fg: string; label: string }> = {
  requested: { dot: "var(--sun)", bg: "var(--sun-soft)", fg: "#8a6420", label: "Requested" },
  scheduled: { dot: "var(--teal)", bg: "#e0f0f3", fg: "var(--teal-dark)", label: "Scheduled" },
  in_progress: { dot: "var(--teal-dark)", bg: "#cfe6ea", fg: "var(--teal-dark)", label: "In progress" },
  complete: { dot: "var(--ok)", bg: "#e4f2ea", fg: "var(--ok)", label: "Complete" },
  paid: { dot: "var(--slate, #8a99a0)", bg: "#e9eff1", fg: "var(--sub)", label: "Paid" },
};
const LEGEND_ORDER: StatusKey[] = ["requested", "scheduled", "in_progress", "complete", "paid"];
// Dominant-status priority for the year view's mini-month squares.
const DOMINANT_ORDER: StatusKey[] = ["requested", "in_progress", "scheduled", "complete", "paid"];

function statusMeta(status: string) {
  return STATUS_COLORS[status as StatusKey] ?? { dot: "var(--sub)", bg: "#e9eff1", fg: "var(--sub)", label: status };
}

function dominantStatus(statuses: string[]): StatusKey | null {
  for (const s of DOMINANT_ORDER) if (statuses.includes(s)) return s;
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function OpsCalendar({
  initialYear,
  initialRows,
  lakes,
}: {
  initialYear: number;
  initialRows: CalRow[];
  lakes: { id: string; name: string }[];
}) {
  // en-CA gives YYYY-MM-DD directly, in lake time.
  const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: LAKE_TZ }).format(new Date());
  const todayYear = Number(todayISO.slice(0, 4));
  const todayMonth = Number(todayISO.slice(5, 7));
  const todayDay = Number(todayISO.slice(8, 10));

  const [yearData, setYearData] = useState<Record<number, CalRow[]>>({ [initialYear]: initialRows });
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(year === todayYear ? todayMonth : 1);
  const [view, setView] = useState<"month" | "year">("month");
  const [lakeName, setLakeName] = useState<string>(ALL_LAKES);
  const [selectedDate, setSelectedDate] = useState<string | null>(
    year === todayYear && month === todayMonth ? todayISO : null,
  );
  const [pending, startTransition] = useTransition();

  const idByName = new Map(lakes.map((l) => [l.name, l.id]));
  const lakeId = lakeName === ALL_LAKES ? null : (idByName.get(lakeName) ?? null);

  function ensureYear(y: number) {
    if (yearData[y]) return;
    startTransition(async () => {
      try {
        const rows = await loadOpsCalendarYear(y);
        setYearData((prev) => ({ ...prev, [y]: rows }));
      } catch {
        toast("Couldn't load that year — try again.");
      }
    });
  }

  function goToMonth(y: number, m: number) {
    setYear(y);
    setMonth(m);
    setSelectedDate(y === todayYear && m === todayMonth ? todayISO : null);
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
  function prevYear() {
    const y = year - 1;
    setYear(y);
    ensureYear(y);
  }
  function nextYear() {
    const y = year + 1;
    setYear(y);
    ensureYear(y);
  }
  function goToday() {
    goToMonth(todayYear, todayMonth);
    setView("month");
  }

  const yearRows = yearData[year] ?? [];
  const rows = lakeId == null ? yearRows : yearRows.filter((r) => r.lake_id === lakeId);

  const monthTitle = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const monthPrefix = `${year}-${pad(month)}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const byDay = new Map<number, CalRow[]>();
  for (const r of rows) {
    if (r.date.slice(0, 7) === monthPrefix) {
      const d = Number(r.date.slice(8, 10));
      byDay.set(d, [...(byDay.get(d) ?? []), r]);
    }
  }
  const cells: Array<{ day: number | null; jobs: CalRow[] }> = [];
  for (let i = 0; i < firstDow; i++) cells.push({ day: null, jobs: [] });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, jobs: byDay.get(d) ?? [] });

  const dayJobs = selectedDate ? rows.filter((r) => r.date === selectedDate) : [];

  return (
    <div>
      <ChoiceChips
        options={[ALL_LAKES, ...lakes.map((l) => l.name)]}
        value={lakeName}
        onChange={setLakeName}
      />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 16 }}>
        <ViewSwitch view={view} onChange={setView} />
        <button className="ll-btn ghost sm" onClick={goToday}>Today</button>
      </div>

      {view === "month" ? (
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
              const isToday = year === todayYear && month === todayMonth && c.day === todayDay;
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

          <Legend />

          <DayPanel selectedDate={selectedDate} jobs={dayJobs} lakeName={lakeName} />
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <button className="ll-btn ghost sm" aria-label="Previous year" onClick={prevYear}>‹</button>
            <h3 style={{ fontSize: 16 }}>
              {year}
              {pending && !yearData[year] ? <span className="mut" style={{ fontSize: 12, fontWeight: 600 }}> · loading…</span> : null}
            </h3>
            <button className="ll-btn ghost sm" aria-label="Next year" onClick={nextYear}>›</button>
          </div>

          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <MiniMonth
                key={m}
                year={year}
                month={m}
                rows={rows}
                isCurrentMonth={year === todayYear && m === todayMonth}
                onClick={() => {
                  goToMonth(year, m);
                  setView("month");
                }}
              />
            ))}
          </div>

          <Legend />
        </div>
      )}
    </div>
  );
}

function ViewSwitch({ view, onChange }: { view: "month" | "year"; onChange: (v: "month" | "year") => void }) {
  const opts: Array<{ key: "month" | "year"; label: string }> = [
    { key: "month", label: "Month" },
    { key: "year", label: "Year" },
  ];
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {opts.map((o) => {
        const on = view === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={on}
            style={{
              padding: "8px 16px", borderRadius: 99, border: `1.5px solid ${on ? "var(--teal)" : "var(--line)"}`,
              background: on ? "var(--teal)" : "#fff", color: on ? "#fff" : "var(--text)",
              fontWeight: 700, fontSize: 13.5, cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
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
  );
}

function prettyFullDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function DayPanel({
  selectedDate,
  jobs,
  lakeName,
}: {
  selectedDate: string | null;
  jobs: CalRow[];
  lakeName: string;
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <h4 style={{ fontSize: 14, marginBottom: 8 }}>
        {selectedDate ? prettyFullDate(selectedDate) : "Pick a day"}
      </h4>
      {selectedDate == null ? (
        <p className="mut" style={{ fontSize: 13 }}>Tap a day on the grid to see what&apos;s on the books.</p>
      ) : jobs.length === 0 ? (
        <p className="mut" style={{ fontSize: 13 }}>
          Nothing on the books for this day{lakeName !== ALL_LAKES ? ` on ${lakeName}` : ""}. 🌊
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {jobs.map((j) => {
            const m = statusMeta(j.status);
            return (
              <div key={j.id} className="ll-card ll-card-pad" style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <span aria-hidden style={{ width: 9, height: 9, borderRadius: 99, background: m.dot, marginTop: 5, flex: "0 0 auto" }} />
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>{j.service_name ?? "Service"}</div>
                  <div className="mut" style={{ fontSize: 12.5 }}>
                    {j.address ?? "Address on file"}{j.lake_name ? ` · ${j.lake_name}` : ""}
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>
                    Crew: <b>{j.crew ?? "unassigned"}</b>
                  </div>
                </div>
                <span className="ll-pill" style={{ background: m.bg, color: m.fg }}>{m.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniMonth({
  year,
  month,
  rows,
  isCurrentMonth,
  onClick,
}: {
  year: number;
  month: number;
  rows: CalRow[];
  isCurrentMonth: boolean;
  onClick: () => void;
}) {
  const prefix = `${year}-${pad(month)}`;
  const monthRows = rows.filter((r) => r.date.slice(0, 7) === prefix);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const byDay = new Map<number, string[]>();
  for (const r of monthRows) {
    const d = Number(r.date.slice(8, 10));
    byDay.set(d, [...(byDay.get(d) ?? []), r.status]);
  }
  const cells: Array<{ day: number | null; dominant: StatusKey | null }> = [];
  for (let i = 0; i < firstDow; i++) cells.push({ day: null, dominant: null });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, dominant: dominantStatus(byDay.get(d) ?? []) });

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "short" });

  return (
    <button
      type="button"
      onClick={onClick}
      className="ll-card ll-card-pad"
      style={{
        textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit",
        border: isCurrentMonth ? "1.5px solid var(--teal)" : "1px solid var(--line)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>{monthLabel}</b>
        <span className="mut" style={{ fontSize: 11.5 }}>{monthRows.length} job{monthRows.length === 1 ? "" : "s"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {cells.map((c, i) => (
          <span
            key={i}
            aria-hidden
            style={{
              aspectRatio: "1", borderRadius: 2,
              background: c.day == null || !c.dominant ? "transparent" : STATUS_COLORS[c.dominant].dot,
              border: c.day == null ? "none" : "1px solid var(--line)",
            }}
          />
        ))}
      </div>
    </button>
  );
}
