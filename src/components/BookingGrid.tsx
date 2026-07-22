"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatPrice } from "@/lib/pricing";
import { dayStatus, toISODate, isRecurring, type DayStatus } from "@/lib/booking";
import { rushPrice } from "@/lib/rush";
import { getAvailability, createBooking, type RushWindow } from "@/app/book/actions";
import { toast } from "@/components/Toast";

interface Service {
  id: string;
  name: string;
  price: number;
  frequency_options: string[];
  is_water_work: boolean;
}
interface Season {
  start: string | null;
  end: string | null;
  lake: string | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

export function BookingGrid({ services, season }: { services: Service[]; season: Season }) {
  const [active, setActive] = useState<Service | null>(null);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        {services.map((s) => (
          <div key={s.id} className="ll-card ll-card-pad">
            {s.is_water_work && <span className="ll-pill teal" style={{ marginBottom: 8 }}>Seasonal water work</span>}
            <h3 style={{ fontSize: 17, margin: s.is_water_work ? "6px 0 2px" : "0 0 2px" }}>{s.name}</h3>
            <div className="mut" style={{ fontSize: 12.5 }}>{s.frequency_options.join(" · ")}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 20, color: "var(--ink)" }}>
                {formatPrice(s.price)}
              </span>
              <button className="ll-btn sm" onClick={() => setActive(s)}>Schedule</button>
            </div>
          </div>
        ))}
        {services.length === 0 && (
          <div className="ll-card ll-card-pad mut">No services chosen yet — add some in guided setup.</div>
        )}
      </div>

      {active && <BookingModal service={active} season={season} onClose={() => setActive(null)} />}
    </>
  );
}

function BookingModal({ service, season, onClose }: { service: Service; season: Season; onClose: () => void }) {
  const router = useRouter();
  const now = new Date();
  const [freq, setFreq] = useState(0);
  // year + month kept together so functional updates handle year-boundary crossings.
  const [cal, setCal] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const { year, month } = cal;
  const [picked, setPicked] = useState<string | null>(null);
  const [fullDates, setFullDates] = useState<Set<string>>(new Set());
  const [findingCrew, setFindingCrew] = useState(false);
  const [rush, setRush] = useState<RushWindow | null>(null);
  const [rushFallback, setRushFallback] = useState<"roll" | "cancel">("roll");
  const [busy, setBusy] = useState(false);

  const today = toISODate(now);

  useEffect(() => {
    let cancelled = false;
    getAvailability(service.id, year, month).then((res) => {
      if (!cancelled) {
        setFullDates(new Set(res.fullDates));
        setFindingCrew(!!res.findingCrew);
        setRush(res.rush);
      }
    });
    return () => { cancelled = true; };
  }, [service.id, year, month]);

  const cells = useMemo(() => {
    const first = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const out: Array<{ day: number; iso: string; status: DayStatus } | null> = [];
    for (let i = 0; i < first; i++) out.push(null);
    for (let d = 1; d <= days; d++) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const status = dayStatus(iso, {
        today,
        isWaterWork: service.is_water_work,
        seasonStart: season.start,
        seasonEnd: season.end,
        fullDates,
        rushNowHour: rush?.nowHour,
        rushCutoffHour: rush?.cutoffHour,
      });
      out.push({ day: d, iso, status });
    }
    return out;
  }, [year, month, fullDates, service.is_water_work, season.start, season.end, today, rush]);

  function move(delta: number) {
    setPicked(null);
    setCal((c) => {
      let m = c.month + delta, y = c.year;
      if (m < 0) { m = 11; y--; }
      if (m > 11) { m = 0; y++; }
      return { year: y, month: m };
    });
  }

  // Is the picked date today's rush slot? (Status lives on the cell.)
  const pickedIsRush = picked != null && cells.some((c) => c?.iso === picked && c.status === "rush");
  const rushAllIn = rush ? rushPrice(service.price, rush.surchargePct) : service.price;

  async function confirm() {
    if (!picked) return;
    setBusy(true);
    const res = await createBooking(
      service.id,
      picked,
      service.frequency_options[freq] ?? "",
      pickedIsRush ? rushFallback : undefined,
    );
    setBusy(false);
    if (!res.ok) { toast(res.error ?? "Couldn't book that."); return; }
    toast(`${service.name} booked — see “My requests.”`);
    onClose();
    router.refresh();
  }

  const recurring = isRecurring(service.frequency_options[freq] ?? "");
  const prettyPicked = picked ? new Date(picked + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : null;

  return (
    <div className="ll-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ll-modal" style={{ maxWidth: 460 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill teal">Schedule</span>
            <h3 style={{ fontSize: 20, marginTop: 8 }}>{service.name}</h3>
            <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>{formatPrice(service.price)}</div>
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="ll-modal-body">
          {/* Cold-start honesty: no regular crew here YET — book anyway, we hunt. */}
          {findingCrew && (
            <div
              style={{
                border: "1.5px solid var(--gold, #d9a441)", borderRadius: 12, padding: "10px 14px",
                marginBottom: 14, fontSize: 13.5, lineHeight: 1.45,
              }}
            >
              <b>New water for us 🌊</b> — no regular crew on your lake yet. Book any day and
              we&apos;ll hunt one down; you&apos;re never charged until the work is done, and
              we&apos;ll tell you straight if we can&apos;t line one up in time.
            </div>
          )}

          {/* frequency */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            {service.frequency_options.map((f, i) => (
              <button
                key={f}
                onClick={() => { setFreq(i); setPicked(null); }}
                style={{
                  padding: "8px 13px", borderRadius: 99, fontWeight: 700, fontSize: 13, cursor: "pointer",
                  border: `1.5px solid ${i === freq ? "var(--teal)" : "var(--line)"}`,
                  background: i === freq ? "var(--teal)" : "#fff", color: i === freq ? "#fff" : "var(--text)",
                }}
              >
                {f}
              </button>
            ))}
          </div>

          <div className="mut" style={{ fontSize: 12.5, marginBottom: 8 }}>
            {recurring
              ? "Pick your first visit — we'll line up the repeats with you once it's confirmed."
              : "Pick your date."}
          </div>

          {/* calendar */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <button className="ll-btn ghost sm" onClick={() => move(-1)}>‹</button>
            <b style={{ fontFamily: "var(--font-display)" }}>{MONTHS[month]} {year}</b>
            <button className="ll-btn ghost sm" onClick={() => move(1)}>›</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, textAlign: "center" }}>
            {DOW.map((d, i) => (
              <div key={i} className="mut" style={{ fontSize: 11, fontWeight: 700, padding: "4px 0" }}>{d}</div>
            ))}
            {cells.map((c, i) => {
              if (!c) return <div key={i} />;
              const isRushDay = c.status === "rush";
              const clickable = c.status === "available" || isRushDay;
              const sel = picked === c.iso;
              const bg = sel
                ? (isRushDay ? "var(--gold, #d9a441)" : "var(--teal)")
                : isRushDay ? "#FBF3E1"
                : c.status === "available" ? "#fff" : c.status === "full" ? "#F4EDE4" : "#f0f3f4";
              const color = sel ? "#fff" : clickable ? "var(--text)" : "#aab6ba";
              const border = sel
                ? (isRushDay ? "var(--gold, #d9a441)" : "var(--teal)")
                : isRushDay ? "var(--gold, #d9a441)" : "var(--line)";
              const title = c.status === "off-season" ? "Outside the water-work season"
                : c.status === "full" ? "Crew at capacity"
                : c.status === "past" ? ""
                : isRushDay ? "Book today — rush rate" : "Available";
              return (
                <button
                  key={i}
                  onClick={() => clickable && setPicked(c.iso)}
                  disabled={!clickable && !sel}
                  title={title}
                  style={{
                    aspectRatio: "1", borderRadius: 8, fontSize: 13, fontWeight: 600,
                    border: `${isRushDay ? "1.5px" : "1px"} solid ${border}`,
                    background: bg, color, cursor: clickable ? "pointer" : "default",
                    textDecoration: c.status === "off-season" ? "line-through" : "none",
                  }}
                >
                  {c.day}
                  {isRushDay && <span style={{ fontSize: 9, verticalAlign: "top" }}>⚡</span>}
                </button>
              );
            })}
          </div>

          {/* legend */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, fontSize: 11 }} className="mut">
            <span>⬜ Available</span>
            <span>🟫 Crew full</span>
            {service.is_water_work && <span>▪️ Off-season</span>}
          </div>

          {/* summary + confirm */}
          {prettyPicked && (
            <div style={{ marginTop: 14, padding: "12px 14px", background: pickedIsRush ? "#FBF3E1" : "#F2F9FA", borderRadius: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                <span className="mut">{recurring ? "First visit" : "Date"}</span><b>{prettyPicked}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15 }}>
                <b>Your price</b><b>{pickedIsRush ? formatPrice(rushAllIn) : formatPrice(service.price)}</b>
              </div>
              {pickedIsRush && (
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  ⚡ Same-day rush — includes the rush premium
                </div>
              )}
            </div>
          )}

          {/* rush fallback: customer pre-picks what happens if no crew claims by cutoff */}
          {pickedIsRush && (
            <div style={{ marginTop: 12 }} role="radiogroup" aria-label="If no crew frees up by cutoff">
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>If no crew frees up by cutoff:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {([
                  { value: "roll" as const, label: "Move to tomorrow at standard price" },
                  { value: "cancel" as const, label: "Cancel — no charge" },
                ]).map((opt) => {
                  const on = rushFallback === opt.value;
                  return (
                    <button
                      key={opt.value}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setRushFallback(opt.value)}
                      style={{
                        padding: "10px 13px", minHeight: 44, borderRadius: 99, fontWeight: 700, fontSize: 13, cursor: "pointer",
                        border: `1.5px solid ${on ? "var(--teal)" : "var(--line)"}`,
                        background: on ? "var(--teal)" : "#fff", color: on ? "#fff" : "var(--text)",
                      }}
                    >
                      {opt.label}{opt.value === "roll" ? " (default)" : ""}
                    </button>
                  );
                })}
              </div>
              <p className="mut" style={{ fontSize: 12.5, margin: "8px 0 0", lineHeight: 1.5 }}>
                We&apos;ll offer this to crews already out on your lake. You&apos;re only charged after the work is done.
              </p>
            </div>
          )}

          <p className="mut" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
            Confirming creates a request. Autopay charges only after the service is
            completed and its photos are uploaded — never before.
          </p>

          <button className="ll-btn gold" style={{ width: "100%", marginTop: 12 }} onClick={confirm} disabled={!picked || busy}>
            {busy ? "Booking…" : pickedIsRush ? `Book today ⚡ — ${formatPrice(rushAllIn)}` : "Confirm booking"}
          </button>
        </div>
      </div>
    </div>
  );
}
