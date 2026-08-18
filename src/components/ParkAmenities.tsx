"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  saveAmenity, setAmenityActive, addAmenityUnit, blackoutDays,
  bookAmenityForStay, cancelAmenityBooking, collectAmenityMoney, staysOverlapping,
  type AmenityRow,
} from "@/app/park/amenity-actions";
import { priceLine, daysIn } from "@/lib/amenities";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Presentation only. Nothing else in this file may branch on `kind`. */
const ICON: Record<string, string> = {
  boat: "🛥️", watercraft: "🛶", vehicle: "🛻", space: "🏛️", other: "🔑",
};

const KINDS = [
  ["boat", "A boat"], ["watercraft", "Kayaks, paddleboards"],
  ["vehicle", "A cart or truck"], ["space", "A pavilion or room"], ["other", "Something else"],
] as const;

const WHO = [
  ["guests", "Short-stay guests only"],
  ["residents", "Residents only"],
  ["both", "Both"],
] as const;

/**
 * THINGS YOU RENT OUT.
 *
 * The Haven comes with a boat and it is for the short-stay guests. The model is
 * general because a park also has a pavilion, a cart, four kayaks, a slip — and
 * baking in one park's boat is exactly what this codebase keeps having to undo.
 *
 * THE LINE THIS SCREEN DRAWS, said out loud at the top: if a crew gets paid for
 * it, it is not here — that is service work, and it lives on /park/services with
 * a vendor and a photo gate behind it. This is the park renting its own things.
 */
export function ParkAmenities({
  parkId, rows, today,
}: { parkId: string; rows: AmenityRow[]; today: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Things you rent out</h1>
      <p className="mut" style={{ marginTop: 0, lineHeight: 1.5, maxWidth: 640 }}>
        The boat, the pavilion, a cart, a kayak — anything you own that one
        person has to themselves for a while. This is your money, not
        LakeLife&apos;s. Work a crew gets paid for isn&apos;t here; that&apos;s
        on your services page.
      </p>

      {rows.length === 0 && !adding && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
          <p className="mut" style={{ fontSize: 13, margin: 0, lineHeight: 1.55 }}>
            {/* Says what it checked. An empty list that just says "none" reads
                the same as one that failed to load. */}
            Nothing set up yet. If the park owns something guests ask to
            borrow — a boat, the pavilion, a golf cart — put it here and it gets
            a calendar nobody can double-book.
          </p>
        </div>
      )}

      {rows.map((a) => (
        <AmenityCard
          key={a.id} parkId={parkId} a={a} today={today}
          editing={editing === a.id} onEdit={() => setEditing(editing === a.id ? null : a.id)}
          busy={busy} start={start} router={router}
        />
      ))}

      {adding ? (
        <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 10px" }}>Add something</h3>
          <AmenityForm
            parkId={parkId} busy={busy} start={start}
            onDone={() => { setAdding(false); router.refresh(); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <button className="ll-btn ghost" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
          Add something you rent out
        </button>
      )}
    </div>
  );
}

function AmenityCard({
  parkId, a, today, editing, onEdit, busy, start, router,
}: {
  parkId: string; a: AmenityRow; today: string; editing: boolean; onEdit: () => void;
  busy: boolean; start: React.TransitionStartFunction;
  router: ReturnType<typeof useRouter>;
}) {
  const [unitLabel, setUnitLabel] = useState("");
  const [booking, setBooking] = useState<string | null>(null);

  const upcoming = a.held.filter((h) => h.to > today);

  return (
    <section className="ll-card ll-card-pad" style={{ marginTop: 16, opacity: a.active ? 1 : 0.72 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 20 }}>{ICON[a.kind] ?? ICON.other}</span>
        <h2 style={{ fontSize: 18, margin: 0 }}>{a.name}</h2>
        <span className="mut" style={{ fontSize: 12.5 }}>{priceLine(a)}</span>
        {!a.active && <span className="ll-pill slate">Off</span>}
        <button
          className="ll-btn ghost sm" style={{ marginLeft: "auto" }} disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await setAmenityActive(parkId, a.id, !a.active);
              toast(res.ok ? (res.signal ?? "Done.") : (res.error ?? "Couldn't do that."));
              if (res.ok) router.refresh();
            })
          }
        >
          {a.active ? "Switch off" : "Switch on"}
        </button>
        <button className="ll-btn ghost sm" disabled={busy} onClick={onEdit}>
          {editing ? "Close" : "Edit"}
        </button>
      </div>

      <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>
        {WHO.find(([v]) => v === a.whoMayBook)?.[1]}
        {a.maxDays != null && ` · up to ${a.maxDays} ${a.maxDays === 1 ? "day" : "days"} at a time`}
        {a.season.openMonth != null &&
          ` · ${String(a.season.openMonth).padStart(2, "0")}-${String(a.season.openDay).padStart(2, "0")} to ${String(a.season.closeMonth).padStart(2, "0")}-${String(a.season.closeDay).padStart(2, "0")}`}
      </p>

      {/* 0118, where a person can act on it rather than as a comment in a
          migration. If residents can book it, its upkeep probably isn't the
          park's alone to carry. */}
      {a.whoMayBook !== "guests" && (
        <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
          Your residents can book this one, so its upkeep probably isn&apos;t
          yours alone to carry — worth checking how you split its costs.
        </p>
      )}

      {a.rules && (
        <p style={{ fontSize: 12.5, margin: "8px 0 0", lineHeight: 1.5, fontStyle: "italic" }}>
          &ldquo;{a.rules}&rdquo;
        </p>
      )}

      {editing && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <AmenityForm
            parkId={parkId} initial={a} busy={busy} start={start}
            onDone={() => { onEdit(); router.refresh(); }} onCancel={onEdit}
          />
        </div>
      )}

      {/* WHICH ONE. Only worth showing once there is more than one — a park
          with one boat should never have to learn the word "unit". */}
      {a.units.length > 1 && (
        <div style={{ marginTop: 10, fontSize: 12.5 }}>
          <span className="mut">Yours: </span>
          {a.units.map((u) => u.label).join(" · ")}
        </div>
      )}

      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="ll-input" value={unitLabel} placeholder="Add another — 'Kayak 2'"
          onChange={(e) => setUnitLabel(e.target.value)}
          style={{ padding: "8px 10px", maxWidth: 220 }}
        />
        <button
          className="ll-btn ghost sm" disabled={busy || !unitLabel.trim()}
          onClick={() =>
            start(async () => {
              const res = await addAmenityUnit(parkId, a.id, unitLabel);
              toast(res.ok ? (res.signal ?? "Added.") : (res.error ?? "Couldn't add that."));
              if (res.ok) { setUnitLabel(""); router.refresh(); }
            })
          }
        >
          Add
        </button>
        <button
          className="ll-btn sm" disabled={busy}
          onClick={() => setBooking(booking ? null : a.units[0]?.id ?? null)}
        >
          {booking ? "Close" : "Book it for somebody"}
        </button>
      </div>

      {booking && (
        <BookForSomebody
          parkId={parkId} a={a} today={today} busy={busy} start={start}
          onDone={() => { setBooking(null); router.refresh(); }}
        />
      )}

      {/* WHO HAS IT AND WHAT IS OWED. */}
      <div style={{ marginTop: 12 }}>
        {upcoming.length === 0 ? (
          <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>
            Nothing booked from today on.
          </p>
        ) : (
          upcoming.map((h) => {
            const owed = (h.quotedAmount ?? 0) - h.collected;
            return (
              <div key={h.id} style={{
                display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
                padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13,
              }}>
                <span style={{ fontWeight: 700, minWidth: 150 }}>
                  {pretty(h.from)}{h.to > nextDay(h.from) ? ` → ${pretty(prevDay(h.to))}` : ""}
                </span>
                <span className="mut" style={{ minWidth: 150 }}>
                  {h.status === "blackout"
                    ? "Held back — nobody can book it"
                    : `${h.who ?? "a guest"}${h.lotNumber ? ` · Lot ${h.lotNumber}` : ""}`}
                </span>
                {a.units.length > 1 && <span className="mut">{h.unitLabel}</span>}
                {h.status !== "blackout" && (
                  <span style={{ marginLeft: "auto", fontWeight: 700 }}>
                    {h.quotedAmount === 0
                      ? "included"
                      : owed > 0 ? `${money(owed)} to collect` : `${money(h.collected)} in`}
                  </span>
                )}
                {h.status !== "blackout" && owed > 0 && (
                  <button
                    className="ll-btn ghost sm" disabled={busy}
                    onClick={() =>
                      start(async () => {
                        const res = await collectAmenityMoney(parkId, h.id, String(owed), "cash");
                        toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't record that."));
                        if (res.ok) router.refresh();
                      })
                    }
                  >
                    Took cash
                  </button>
                )}
                <button
                  className="ll-btn ghost sm" disabled={busy}
                  onClick={() =>
                    start(async () => {
                      const res = await cancelAmenityBooking(parkId, h.id, "Cancelled by the office");
                      toast(res.ok ? (res.signal ?? "Cancelled.") : (res.error ?? "Couldn't cancel that."));
                      if (res.ok) router.refresh();
                    })
                  }
                >
                  Cancel
                </button>
              </div>
            );
          })
        )}
      </div>

      <HoldBackDays
        parkId={parkId} unitId={a.units[0]?.id ?? ""} busy={busy} start={start}
        onDone={() => router.refresh()}
      />
    </section>
  );
}

/** A date a person reads is "Sat, Aug 15" — never "2026-08-15". The guest's
 *  page has always said it this way; the owner's was still printing the
 *  database's format at him. */
function pretty(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}

function nextDay(iso: string) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
function prevDay(iso: string) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function AmenityForm({
  parkId, initial, busy, start, onDone, onCancel,
}: {
  parkId: string; initial?: AmenityRow; busy: boolean;
  start: React.TransitionStartFunction; onDone: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState(initial?.kind ?? "boat");
  const [charged, setCharged] = useState((initial?.chargeModel ?? "included") === "per_day");
  const [rate, setRate] = useState(initial?.dayRate != null ? String(initial.dayRate) : "");
  const [who, setWho] = useState(initial?.whoMayBook ?? "guests");
  const [maxDays, setMaxDays] = useState(initial?.maxDays != null ? String(initial.maxDays) : "");
  const [open, setOpen] = useState(
    initial?.season.openMonth != null
      ? `${String(initial.season.openMonth).padStart(2, "0")}-${String(initial.season.openDay).padStart(2, "0")}` : "");
  const [close, setClose] = useState(
    initial?.season.closeMonth != null
      ? `${String(initial.season.closeMonth).padStart(2, "0")}-${String(initial.season.closeDay).padStart(2, "0")}` : "");
  const [rules, setRules] = useState(initial?.rules ?? "");

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">What guests call it</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="The pontoon" />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">What sort of thing</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Who can book it</span>
          <select value={who} onChange={(e) => setWho(e.target.value as typeof who)}>
            {WHO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Longest booking (optional)</span>
          <input inputMode="numeric" value={maxDays} placeholder="no limit"
                 onChange={(e) => setMaxDays(e.target.value)} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">In the water from (optional)</span>
          <input value={open} placeholder="05-01" onChange={(e) => setOpen(e.target.value)} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Out again</span>
          <input value={close} placeholder="10-15" onChange={(e) => setClose(e.target.value)} />
        </label>
      </div>

      {/* INCLUDED AND FREE ARE DIFFERENT ANSWERS, and storing them the same way
          is how a day sheet ends up reading "$0.00 — unpaid" for a boat that
          came with the cabin. */}
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>What it costs</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className={charged ? "ll-btn ghost sm" : "ll-btn sm"}
                  onClick={() => setCharged(false)}>
            Included with the stay
          </button>
          <button type="button" className={charged ? "ll-btn sm" : "ll-btn ghost sm"}
                  onClick={() => setCharged(true)}>
            Charged by the day
          </button>
          {charged && (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="mut">$</span>
              <input className="ll-input" inputMode="decimal" value={rate} placeholder="150.00"
                     onChange={(e) => setRate(e.target.value)}
                     style={{ width: 110, padding: "8px 10px" }} />
              <span className="mut">a day</span>
            </span>
          )}
        </div>
      </div>

      <label className="ll-field" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
        <span className="mut">Your rules, in your words — this prints above their button</span>
        <textarea rows={2} value={rules} onChange={(e) => setRules(e.target.value)}
                  placeholder="Life jackets are in the dock box. Back by six, please." />
      </label>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button
          className="ll-btn" disabled={busy || !name.trim()}
          onClick={() =>
            start(async () => {
              const res = await saveAmenity(parkId, {
                id: initial?.id, name, kind,
                chargeModel: charged ? "per_day" : "included",
                dayRate: rate, whoMayBook: who, maxDays,
                seasonOpen: open, seasonClose: close, rules,
              });
              toast(res.ok ? (res.signal ?? "Saved.") : (res.error ?? "Couldn't save that."));
              if (res.ok) onDone();
            })
          }
        >
          {busy ? "Saving…" : initial ? "Save" : "Add it"}
        </button>
        <button className="ll-btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

function BookForSomebody({
  parkId, a, today, busy, start, onDone,
}: {
  parkId: string; a: AmenityRow; today: string; busy: boolean;
  start: React.TransitionStartFunction; onDone: () => void;
}) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(nextDay(today));
  const [unitId, setUnitId] = useState(a.units[0]?.id ?? "");
  const [stays, setStays] = useState<Array<{ id: string; who: string; lotNumber: string; shortStay: boolean }> | null>(null);

  const nights = from && to && to > from ? daysIn({ start: from, end: to }).length : 0;
  const quote = a.chargeModel === "included" ? 0 : (a.dayRate ?? 0) * nights;

  // THE CAP, BEFORE HE TAPS. The trigger enforces it and passes its own
  // sentence back, which is right — but a screen that quotes "3 days, $450 to
  // collect" and then refuses is a screen that invited the refusal. The
  // database stays the referee; this stops the pointless trip.
  const overCap = a.maxDays != null && nights > a.maxDays;

  return (
    <div style={{ marginTop: 10, background: "var(--sand)", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0, width: 150 }}>
          <span className="mut">From</span>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setStays(null); }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0, width: 150 }}>
          <span className="mut">Back on</span>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setStays(null); }} />
        </label>
        {a.units.length > 1 && (
          <label className="ll-field" style={{ fontSize: 13, margin: 0, width: 170 }}>
            <span className="mut">Which one</span>
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              {a.units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
        )}
        <button
          className="ll-btn ghost" disabled={busy || nights < 1 || overCap}
          onClick={() =>
            start(async () => {
              // `staysOverlapping` THROWS rather than returning [] on a failed
              // read, and a rejection inside this transition has nowhere to
              // go. Caught so it reaches a toast: leaving `stays` unset shows
              // nothing, where an empty array would print "Nobody is staying
              // across those days" about a park that may be full. A server
              // action's rejection is opaque on the client, so this cannot
              // narrow to ReadFailed — but no error here is an answer.
              try {
                const s = await staysOverlapping(parkId, from, to);
                setStays(s);
              } catch (e) {
                console.error("[LakeLife] couldn't read who's staying:", e);
                toast("We couldn't check who's staying just now, so nothing has been booked. Try again in a moment.");
              }
            })
          }
        >
          Who&apos;s here then?
        </button>
      </div>

      <p className="mut" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
        {nights < 1
          ? "Back-on is the morning they bring it back, so it's the day after the last day they have it."
          : overCap
            ? `${nights} days — you allow ${a.maxDays} at a time, so pick a shorter run or raise the limit.`
            : `${nights} ${nights === 1 ? "day" : "days"} · ${a.chargeModel === "included" ? "included with the stay" : `${money(quote)} to collect`}`}
      </p>

      {stays && (
        stays.length === 0 ? (
          <p className="mut" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
            Nobody is staying across those days, so there&apos;s nobody to book it for.
          </p>
        ) : (
          <div style={{ marginTop: 8 }}>
            {stays.map((s) => (
              <div key={s.id} style={{
                display: "flex", gap: 10, alignItems: "baseline", padding: "6px 0",
                borderTop: "1px solid var(--line)", fontSize: 13, flexWrap: "wrap",
              }}>
                <span style={{ fontWeight: 700 }}>Lot {s.lotNumber}</span>
                <span className="mut">{s.who}</span>
                {/* Says WHY it will be refused before he taps, rather than
                    letting the trigger tell him afterwards. */}
                {a.whoMayBook === "guests" && !s.shortStay && (
                  <span className="mut" style={{ fontSize: 12 }}>monthly — not eligible</span>
                )}
                <button
                  className="ll-btn sm" style={{ marginLeft: "auto" }}
                  disabled={busy || overCap || (a.whoMayBook === "guests" && !s.shortStay)}
                  onClick={() =>
                    start(async () => {
                      const res = await bookAmenityForStay(
                        parkId, unitId || a.units[0].id, s.id, daysIn({ start: from, end: to }),
                      );
                      toast(res.ok ? (res.signal ?? "Booked.") : (res.error ?? "Couldn't book that."));
                      if (res.ok) onDone();
                    })
                  }
                >
                  Book it
                </button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function HoldBackDays({
  parkId, unitId, busy, start, onDone,
}: {
  parkId: string; unitId: string; busy: boolean;
  start: React.TransitionStartFunction; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  if (!unitId) return null;

  return open ? (
    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <label className="ll-field" style={{ fontSize: 13, margin: 0, width: 150 }}>
        <span className="mut">Hold back from</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="ll-field" style={{ fontSize: 13, margin: 0, width: 150 }}>
        <span className="mut">Free again on</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <button
        className="ll-btn ghost sm" disabled={busy || !from || !to}
        onClick={() =>
          start(async () => {
            const res = await blackoutDays(parkId, unitId, from, to);
            toast(res.ok ? (res.signal ?? "Held.") : (res.error ?? "Couldn't hold those."));
            if (res.ok) { setOpen(false); setFrom(""); setTo(""); onDone(); }
          })
        }
      >
        Hold them
      </button>
      <button className="ll-btn ghost sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  ) : (
    <button className="ll-btn ghost sm" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
      Hold days back for yourself
    </button>
  );
}
