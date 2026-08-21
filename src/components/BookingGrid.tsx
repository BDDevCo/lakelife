"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatPrice } from "@/lib/pricing";
import { dayStatus, toISODate, isRecurring, type DayStatus } from "@/lib/booking";
import { MAX_BATCH_DATES, shortDay } from "@/lib/batch-booking";
import { RUSH_OPEN_HOUR, rushPrice } from "@/lib/rush";
import { getAvailability, createBookingBatch, type RushWindow } from "@/app/book/actions";
import { toast } from "@/components/Toast";
import { TosAgreeModal } from "@/components/TosAgreeModal";

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
  /**
   * These dates are a GUESS — rolled from a past year, or copied off a
   * neighbouring lake when this one was born from "my lake isn't listed".
   * The grid still uses them (a guessed window beats no window), but a person
   * about to commit money to a date inside it is told so.
   */
  provisional?: boolean;
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
  // SEVERAL DAYS AT ONCE (owner, 2026-08-14). The selection is a list even in
  // one-day mode, so the calendar, the summary and the confirm all read from
  // one place; single mode simply never lets it hold two.
  const [multi, setMulti] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [fullDates, setFullDates] = useState<Set<string>>(new Set());
  const [findingCrew, setFindingCrew] = useState(false);
  // WHICH gap — see getServiceAvailability. "lake" means new water for us;
  // "service" means crews work this lake already, just not on this job.
  const [crewGap, setCrewGap] = useState<"lake" | "service" | null>(null);
  /** The calendar couldn't be READ — which is neither open nor full. No day is
   *  offered while this is true, because we don't know which ones are free. */
  const [unavailable, setUnavailable] = useState(false);
  const [rush, setRush] = useState<RushWindow | null>(null);
  const [rushFallback, setRushFallback] = useState<"roll" | "cancel">("roll");
  const [busy, setBusy] = useState(false);
  const [tosOpen, setTosOpen] = useState(false);
  /** What came back from a batch that only partly landed — stays on screen
   *  (a toast fades, and a visit nobody booked must not fade with it). */
  const [outcome, setOutcome] = useState<{ headline: string; lines: string[] } | null>(null);
  /** Bumped after a booking so the calendar re-reads which days are now full. */
  const [reload, setReload] = useState(0);

  // TODAY ON THE LAKE, NOT ON THIS DEVICE. The browser clock disagreed with the
  // server for anyone outside Indiana time, so an owner in Chicago at 11:40pm
  // was offered a date the confirm then refused as already passed. Seeded from
  // the device so the first paint isn't blank, then replaced by the server's
  // answer as soon as availability lands.
  const [today, setToday] = useState(toISODate(now));

  useEffect(() => {
    let cancelled = false;
    getAvailability(service.id, year, month)
      .then((res) => {
        if (!cancelled) {
          setUnavailable(!!res.unavailable);
          setFullDates(new Set(res.fullDates));
          setFindingCrew(!!res.findingCrew);
          setCrewGap(res.crewGap ?? null);
          setRush(res.rush);
          if (res.today) setToday(res.today);
        }
      })
      // The action answers `unavailable` for a failed read; this catch is for
      // everything else that can reject on the way (a dropped request). Either
      // way the squares below stay unpickable rather than all-white-and-open.
      .catch(() => { if (!cancelled) setUnavailable(true); });
    return () => { cancelled = true; };
  }, [service.id, year, month, reload]);

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
    // Only one-day mode forgets: a multi-day pick that spans June and July has
    // to survive turning the page, or it can't span anything.
    if (!multi) setPicked([]);
    setCal((c) => {
      let m = c.month + delta, y = c.year;
      if (m < 0) { m = 11; y--; }
      if (m > 11) { m = 0; y++; }
      return { year: y, month: m };
    });
  }

  function toggleDay(iso: string) {
    setOutcome(null);
    setPicked((prev) => {
      if (!multi) return [iso];
      if (prev.includes(iso)) return prev.filter((d) => d !== iso);
      if (prev.length >= MAX_BATCH_DATES) {
        toast(`${MAX_BATCH_DATES} visits is the most you can lock in at once — book the rest right after.`);
        return prev;
      }
      return [...prev, iso].sort();
    });
  }

  function setMode(on: boolean) {
    setMulti(on);
    setOutcome(null);
    // Leaving multi-day mode keeps the earliest day rather than silently
    // booking five the customer can no longer see.
    setPicked((prev) => (on ? prev : prev.slice(0, 1)));
  }

  // TODAY is the only day that can be a rush job, and only inside the window.
  // Derived from the server's clock (not the cell) so it survives paging to
  // another month with today still selected.
  const rushOpen = rush != null && rush.nowHour >= RUSH_OPEN_HOUR && rush.nowHour < rush.cutoffHour;
  const pickedIsRush = rushOpen && picked.includes(today);
  const rushAllIn = rush ? rushPrice(service.price, rush.surchargePct) : service.price;
  const totalPrice = picked.length === 0
    ? 0
    : service.price * (picked.length - (pickedIsRush ? 1 : 0)) + (pickedIsRush ? rushAllIn : 0);

  async function confirm(tosAccepted?: boolean) {
    if (picked.length === 0) return;
    const asked = picked.length;
    setBusy(true);
    const res = await createBookingBatch(
      service.id,
      picked,
      service.frequency_options[freq] ?? "",
      pickedIsRush ? rushFallback : undefined,
      tosAccepted,
    );
    setBusy(false);
    if (res.needsTos) { setTosOpen(true); return; }
    setTosOpen(false);
    const bookedCount = res.booked?.length ?? 0;
    const lines = res.lines ?? [];

    // NOTHING LANDED. One date has one sentence; several get the panel, which
    // stays put — a toast that fades can't be the only record of a visit that
    // was refused.
    if (bookedCount === 0) {
      if (lines.length > 0 && asked > 1) setOutcome({ headline: res.headline ?? "", lines });
      else toast(res.error ?? "Couldn't book that.");
      setReload((n) => n + 1);
      return;
    }

    // PART OF IT LANDED. Keep the modal open, say which days did not, drop the
    // stale selection and re-read the calendar so the full days now look full.
    if (lines.length > 0) {
      setOutcome({ headline: res.headline ?? "", lines });
      setPicked([]);
      setReload((n) => n + 1);
      router.refresh();
      return;
    }

    toast(asked === 1 ? `${service.name} booked — see “My requests.”` : (res.headline ?? "Booked."));
    onClose();
    router.refresh();
  }

  const recurring = isRecurring(service.frequency_options[freq] ?? "");
  const prettyPicked = picked.length === 1
    ? new Date(picked[0] + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    : null;

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
                border: "1.5px solid var(--gold)", borderRadius: 12, padding: "10px 14px",
                marginBottom: 14, fontSize: 13.5, lineHeight: 1.45,
              }}
            >
              {crewGap === "service" ? (
                <>
                  <b>Nobody does this one here yet 🧰</b> — crews work your lake, but none of
                  them takes {service.name} so far.
                </>
              ) : (
                <>
                  <b>New water for us 🌊</b> — no regular crew on your lake yet.
                </>
              )}{" "}
              Book any day and we&apos;ll hunt one down; you&apos;re never charged until the
              work is done, and we&apos;ll tell you straight if we can&apos;t line one up in
              time.
            </div>
          )}

          {/* We couldn't READ the calendar. Not "full", not "open" — unknown,
              and no day is offered until we can say which are free. */}
          {unavailable && (
            <div
              role="status"
              style={{
                border: "1.5px solid var(--line)", borderRadius: 12, padding: "10px 14px",
                marginBottom: 14, fontSize: 13.5, lineHeight: 1.45, background: "#f0f3f4",
              }}
            >
              <b>We couldn&apos;t check the calendar just now.</b> Nothing has been booked, and
              we&apos;d rather not guess which days are free. Close this and try again in a moment.
            </div>
          )}

          {/* what actually happened to a batch that only partly landed */}
          {outcome && (
            <div
              role="status"
              style={{
                border: "1.5px solid var(--gold)", borderRadius: 12, padding: "10px 14px",
                marginBottom: 14, fontSize: 13.5, lineHeight: 1.5, background: "#FBF3E1",
              }}
            >
              <b>{outcome.headline}</b>
              {outcome.lines.map((l, i) => (
                <div key={i} style={{ marginTop: 4 }}>{l}</div>
              ))}
              <div className="mut" style={{ marginTop: 6, fontSize: 12.5 }}>
                Pick other days below — the visits that did book are already on their way.
              </div>
            </div>
          )}

          {/* frequency */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            {service.frequency_options.map((f, i) => (
              <button
                key={f}
                onClick={() => { setFreq(i); setPicked([]); setOutcome(null); }}
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

          {/* one day, or several — the rung between a one-off and Autopilot */}
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }} role="radiogroup" aria-label="How many days">
            {([
              { on: false, label: "One day" },
              { on: true, label: "Several days" },
            ]).map((opt) => (
              <button
                key={opt.label}
                role="radio"
                aria-checked={multi === opt.on}
                onClick={() => setMode(opt.on)}
                style={{
                  padding: "8px 13px", borderRadius: 99, fontWeight: 700, fontSize: 13, cursor: "pointer",
                  border: `1.5px solid ${multi === opt.on ? "var(--ink)" : "var(--line)"}`,
                  background: multi === opt.on ? "var(--ink)" : "#fff",
                  color: multi === opt.on ? "#fff" : "var(--text)",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="mut" style={{ fontSize: 12.5, marginBottom: 8, lineHeight: 1.5 }}>
            {multi
              ? `Tap every day you want — up to ${MAX_BATCH_DATES}, across as many months as you like. Each visit is booked and priced on its own, and nothing repeats after them: this is not Autopilot.`
              : recurring
                ? "Pick your first visit — we'll line up the repeats with you once it's confirmed."
                : "Pick your date."}
          </div>

          {/* THE WINDOW IS A GUESS AND THE PERSON PAYING SHOULD KNOW.
              Water work only — the ice-out / pull-deadline gate is the only
              thing these dates decide, so on a mow this would be noise.
              Deliberately NOT a blocker and not a greyed-out calendar: a
              guessed window is still the best window we have, and refusing to
              take the booking would be worse than taking it honestly. */}
          {service.is_water_work && season.provisional && (
            <div
              style={{
                fontSize: 12.5, lineHeight: 1.5, marginBottom: 8,
                padding: "8px 10px", borderRadius: 8,
                background: "var(--sun-soft)", border: "1px solid #ecd9ad", color: "#7a5a1e",
              }}
            >
              <b>{season.lake ? `${season.lake}'s season dates aren't confirmed yet.` : "These season dates aren't confirmed yet."}</b>{" "}
              They&apos;re our best estimate, not this year&apos;s measured ice-out. You can book now
              — if the water moves the date, we&apos;ll come back to you before anyone drives out.
            </div>
          )}

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
              const clickable = !unavailable && (c.status === "available" || isRushDay);
              const sel = picked.includes(c.iso);
              const bg = sel
                ? (isRushDay ? "var(--gold)" : "var(--teal)")
                : isRushDay ? "#FBF3E1"
                : c.status === "available" ? "#fff" : c.status === "full" ? "#F4EDE4" : "#f0f3f4";
              const color = sel ? "#fff" : clickable ? "var(--text)" : "#aab6ba";
              const border = sel
                ? (isRushDay ? "var(--gold)" : "var(--teal)")
                : isRushDay ? "var(--gold)" : "var(--line)";
              // "Available" is a fact we don't have when the read failed — the
              // tooltip must not assert it while the banner above says otherwise.
              const title = unavailable ? "We couldn't check this day"
                : c.status === "off-season" ? "Outside the water-work season"
                : c.status === "full" ? "Crew at capacity"
                : c.status === "past" ? ""
                : isRushDay ? "Book today — rush rate" : "Available";
              return (
                <button
                  key={i}
                  onClick={() => clickable && toggleDay(c.iso)}
                  disabled={!clickable && !sel}
                  aria-pressed={sel}
                  title={sel && multi ? "Tap again to remove" : title}
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
                <span className="mut">{recurring && !multi ? "First visit" : "Date"}</span><b>{prettyPicked}</b>
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

          {/* several days: every one named, every one removable, one total */}
          {picked.length > 1 && (
            <div style={{ marginTop: 14, padding: "12px 14px", background: "#F2F9FA", borderRadius: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 8 }}>
                <span className="mut">Your visits</span><b>{picked.length} days</b>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {picked.map((d) => (
                  <button
                    key={d}
                    onClick={() => toggleDay(d)}
                    aria-label={`Remove ${shortDay(d)}`}
                    style={{
                      padding: "5px 9px", borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                      border: `1px solid ${d === today && rushOpen ? "var(--gold)" : "var(--line)"}`,
                      background: "#fff", color: "var(--text)",
                    }}
                  >
                    {shortDay(d)}{d === today && rushOpen ? " ⚡" : ""} ✕
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15 }}>
                <b>Your total</b><b>{formatPrice(totalPrice)}</b>
              </div>
              <div className="mut" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
                {formatPrice(service.price)} per visit{pickedIsRush ? ` · today is ${formatPrice(rushAllIn)} at the rush rate` : ""}. Each
                one is charged only after it&apos;s done — and cancelling one visit never touches the others.
              </div>
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
            {picked.length > 1
              ? `Confirming creates ${picked.length} separate requests — no standing schedule, nothing repeats. Autopay charges each one only after that visit is completed and its photos are uploaded, never before.`
              : "Confirming creates a request. Autopay charges only after the service is completed and its photos are uploaded — never before."}
          </p>

          <button className="ll-btn gold" style={{ width: "100%", marginTop: 12 }} onClick={() => confirm()} disabled={unavailable || picked.length === 0 || busy}>
            {busy
              ? "Booking…"
              : picked.length > 1
                ? `Book ${picked.length} visits — ${formatPrice(totalPrice)}`
                : pickedIsRush
                  ? `Book today ⚡ — ${formatPrice(rushAllIn)}`
                  : "Confirm booking"}
          </button>
        </div>
      </div>

      <TosAgreeModal
        open={tosOpen}
        busy={busy}
        onAgree={() => confirm(true)}
        onClose={() => setTosOpen(false)}
      />
    </div>
  );
}
