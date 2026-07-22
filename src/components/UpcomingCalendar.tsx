/**
 * Lightweight month-at-a-glance of upcoming LakeLife visits. Pure render — no
 * actions, no libraries. "Today" is lake time (America/Indiana/Indianapolis).
 */

const LAKE_TZ = "America/Indiana/Indianapolis";
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD
  serviceName: string;
  status: string;
}

function prettyDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

export function UpcomingCalendar({ events }: { events: CalendarEvent[] }) {
  // en-CA gives YYYY-MM-DD directly.
  const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: LAKE_TZ }).format(new Date());
  const year = Number(todayISO.slice(0, 4));
  const month = Number(todayISO.slice(5, 7)); // 1-based
  const todayDay = Number(todayISO.slice(8, 10));
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const monthTitle = new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long", year: "numeric",
  });

  const byDay = new Map<number, CalendarEvent[]>();
  for (const e of events) {
    if (e.date.slice(0, 7) === todayISO.slice(0, 7)) {
      const d = Number(e.date.slice(8, 10));
      byDay.set(d, [...(byDay.get(d) ?? []), e]);
    }
  }

  const upcoming = events
    .filter((e) => e.date >= todayISO)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  const cells: Array<{ day: number | null; evts: CalendarEvent[] }> = [];
  for (let i = 0; i < firstDow; i++) cells.push({ day: null, evts: [] });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, evts: byDay.get(d) ?? [] });

  return (
    <div>
      <h3 style={{ fontSize: 16, marginBottom: 10 }}>Coming up — {monthTitle}</h3>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
        {DOW.map((d) => (
          <div key={d} className="mut" style={{ fontSize: 11, fontWeight: 800, textAlign: "center", padding: "2px 0" }}>
            {d}
          </div>
        ))}
        {cells.map((c, i) => {
          if (c.day == null) return <div key={`blank-${i}`} />;
          const isToday = c.day === todayDay;
          const has = c.evts.length > 0;
          return (
            <div
              key={c.day}
              style={{
                minHeight: 48, minWidth: 0, padding: "4px 3px", borderRadius: 8,
                background: has ? "#e0f0f3" : "transparent",
                border: isToday ? "1.5px solid var(--teal)" : "1.5px solid transparent",
              }}
            >
              <div
                className={has || isToday ? undefined : "mut"}
                style={{
                  fontSize: 12, fontWeight: isToday ? 800 : 600, textAlign: "center",
                  color: isToday ? "var(--teal-dark)" : undefined,
                }}
              >
                {c.day}
              </div>
              {has && (
                <div
                  title={c.evts.map((e) => e.serviceName).join(" · ")}
                  style={{
                    display: "flex", alignItems: "center", gap: 3, justifyContent: "center",
                    minWidth: 0, marginTop: 2,
                  }}
                >
                  <span
                    aria-hidden
                    style={{ width: 6, height: 6, borderRadius: 99, background: "var(--teal)", flex: "0 0 auto" }}
                  />
                  <span
                    style={{
                      fontSize: 10, fontWeight: 700, color: "var(--teal-dark)", minWidth: 0,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                  >
                    {c.evts[0].serviceName}
                    {c.evts.length > 1 ? ` +${c.evts.length - 1}` : ""}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {upcoming.length > 0 && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          {upcoming.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13.5, padding: "3px 0", minWidth: 0 }}>
              <b style={{ flex: "0 0 auto" }}>{prettyDate(e.date)}</b>
              <span className="mut" aria-hidden>—</span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.serviceName}
                {e.status === "in_progress" ? " (in progress)" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
