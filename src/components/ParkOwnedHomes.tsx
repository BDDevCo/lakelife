"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  enableHomeServices, focusOwnedHome, type OwnedHomeRow,
} from "@/app/park/service-actions";

/**
 * HOMES YOU OWN.
 *
 * The Haven's Lot 11 is a 28x60 the park owns and rents out. It needs cleaning
 * between tenants and winterizing in October — and until now there was nowhere
 * to book that, because a park-owned home was a boolean on a lot rather than a
 * place a crew could be sent to.
 *
 * These are ORDINARY HOUSES on the ordinary menu. Nothing here is park-only,
 * and that is the point: the grounds get a 21-lot mow, a house gets
 * housekeeping, and neither ever appears on the other's list.
 */
export function ParkOwnedHomes({
  parkId, homes, canEnable,
}: { parkId: string; homes: OwnedHomeRow[]; canEnable: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [setting, setSetting] = useState<string | null>(null);

  if (homes.length === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Homes you own</h3>
        <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
          {/* Says what it looked at, not just "none". */}
          None of your live lots is marked as a home you own. Tick that on
          Lots &amp; rates and the home shows up here, ready for cleaning and
          winterizing like any other house.
        </p>
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 16, margin: 0 }}>Homes you own</h3>
      <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
        Your own houses on your own lots. These get the ordinary house menu —
        cleaning, winterizing, de-winterizing — at the ordinary prices, billed to
        you. A home somebody else owns is theirs, and never appears here.
      </p>

      {homes.map((h) => (
        <div key={h.lotId} style={{
          padding: "10px 0", borderTop: "1px solid var(--line)",
          display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
        }}>
          <strong style={{ fontSize: 14, minWidth: 70 }}>Lot {h.lotNumber}</strong>

          {h.propertyId ? (
            <>
              <span className="mut" style={{ fontSize: 12.5, flex: 1, minWidth: 180 }}>
                {h.sqft?.toLocaleString()} sq ft
                {h.beds != null && ` · ${h.beds} bed`}
                {h.baths != null && ` · ${h.baths} bath`}
                {/* WHY IT MATTERS THAT SOMEBODY IS IN IT. Interior work on an
                    occupied home is arranged with the resident, not just
                    scheduled — the crew cannot get in otherwise. */}
                {h.occupied && " · somebody's living in it"}
              </span>
              <button
                className="ll-btn sm" disabled={busy}
                onClick={() =>
                  start(async () => {
                    const res = await focusOwnedHome(parkId, h.lotId);
                    if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
                    router.push("/book");
                  })
                }
              >
                Book work for it →
              </button>
            </>
          ) : setting === h.lotId ? (
            <SizeForm
              parkId={parkId} lotId={h.lotId} busy={busy} start={start}
              onDone={() => { setSetting(null); router.refresh(); }}
              onCancel={() => setSetting(null)}
            />
          ) : (
            <>
              <span className="mut" style={{ fontSize: 12.5, flex: 1, minWidth: 180 }}>
                Not set up for service yet
                {h.occupied && " · somebody's living in it"}
              </span>
              <button
                className="ll-btn ghost sm"
                disabled={busy || !canEnable}
                onClick={() => setSetting(h.lotId)}
              >
                Set it up
              </button>
            </>
          )}
        </div>
      ))}

      {!canEnable && (
        <p className="mut" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
          Only the park&apos;s owner can set a home up for service.
        </p>
      )}

      {homes.some((h) => h.occupied && h.propertyId) && (
        <p className="mut" style={{ fontSize: 12, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
          For anything inside an occupied home, arrange the day with the
          household first — a crew that can&apos;t get in is a no-show, and
          somebody pays for the trip.
        </p>
      )}
    </div>
  );
}

function SizeForm({
  parkId, lotId, busy, start, onDone, onCancel,
}: {
  parkId: string; lotId: string; busy: boolean;
  start: React.TransitionStartFunction; onDone: () => void; onCancel: () => void;
}) {
  const [w, setW] = useState("");
  const [l, setL] = useState("");
  const [beds, setBeds] = useState("");
  const [baths, setBaths] = useState("");

  const wn = Number(w) || 0;
  const ln = Number(l) || 0;
  const sqft = wn > 0 && ln > 0 ? Math.round(wn * ln) : 0;

  return (
    <div style={{ flexBasis: "100%", marginTop: 6 }}>
      {/* WIDTH BY LENGTH, because that is how every title and every listing
          describes a mobile home. Nobody knows their square footage; everyone
          knows they have a 28 by 60. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="ll-field" style={{ margin: 0, width: 92 }}>
          <label htmlFor={`w-${lotId}`}>Wide (ft)</label>
          <input id={`w-${lotId}`} inputMode="numeric" value={w} placeholder="28"
                 onChange={(e) => setW(e.target.value)} />
        </div>
        <div className="ll-field" style={{ margin: 0, width: 92 }}>
          <label htmlFor={`l-${lotId}`}>Long (ft)</label>
          <input id={`l-${lotId}`} inputMode="numeric" value={l} placeholder="60"
                 onChange={(e) => setL(e.target.value)} />
        </div>
        <div className="ll-field" style={{ margin: 0, width: 84 }}>
          <label htmlFor={`b-${lotId}`}>Beds</label>
          <input id={`b-${lotId}`} inputMode="numeric" value={beds} placeholder="3"
                 onChange={(e) => setBeds(e.target.value)} />
        </div>
        <div className="ll-field" style={{ margin: 0, width: 84 }}>
          <label htmlFor={`ba-${lotId}`}>Baths</label>
          <input id={`ba-${lotId}`} inputMode="decimal" value={baths} placeholder="2"
                 onChange={(e) => setBaths(e.target.value)} />
        </div>
      </div>

      <p className="mut" style={{ fontSize: 12, margin: "6px 0 8px", lineHeight: 1.5 }}>
        {sqft > 0
          ? `${sqft.toLocaleString()} sq ft — that's what cleaning is priced from.`
          : "Cleaning is priced by size, so this can't be a guess. It's on the title."}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          className="ll-btn sm" disabled={busy || sqft <= 0}
          onClick={() =>
            start(async () => {
              const res = await enableHomeServices(parkId, lotId, {
                widthFt: w, lengthFt: l, beds, baths,
              });
              toast(res.ok ? (res.signal ?? "Set up.") : (res.error ?? "Couldn't set that up."));
              if (res.ok) onDone();
            })
          }
        >
          {busy ? "Setting up…" : "Set it up"}
        </button>
        <button className="ll-btn ghost sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
