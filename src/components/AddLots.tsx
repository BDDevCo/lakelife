"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { addLots } from "@/app/park/actions";
import { lotLabelRange, denominatorImpact } from "@/app/park/park-helpers";

/**
 * ADDING PADS AS THEY COME ONLINE.
 *
 * Until now nothing outside the importer could create a lot, so a park could
 * only ever be as big as the seller's roll — and The Haven's four proforma
 * pads had nowhere to live.
 *
 * THE IMPACT LINE IS THE POINT OF THIS SCREEN. A rentable lot enlarges the
 * divisor on every shared cost, so each household's share drops and the park
 * picks up the new pad's share until somebody is on it. That is correct, and
 * it is a real monthly cost of holding empty inventory — so it is stated
 * before the tap rather than discovered on the next statement.
 */
export function AddLots({
  parkId, rentableNow, payersNow, monthlyShared,
}: {
  parkId: string;
  rentableNow: number;
  payersNow: number;
  /** What the park spends a month on costs that get split. 0 = unknown yet. */
  monthlyShared: number;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [siteType, setSiteType] = useState("rv_site");
  const [rentalMode, setRentalMode] = useState<"long_term" | "short_term">("long_term");
  const [liveNow, setLiveNow] = useState(false);

  const range = lotLabelRange(from || "0", to || from || "0");
  const n = from.trim() ? range.labels.length : 0;
  // Only a LIVE pad changes anybody's bill. A not-yet-built one is inventory
  // on a list and moves no money, so claiming otherwise would be a lie.
  const impact = liveNow && n > 0
    ? denominatorImpact({ monthlyShared, rentableNow, payersNow, adding: n })
    : null;

  const usd = (x: number) => `$${x.toFixed(2)}`;

  if (!open) {
    return (
      <button className="ll-btn ghost sm" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        Add lots or RV sites
      </button>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
      <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>Add lots or RV sites</h3>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div className="ll-field" style={{ flex: "1 1 110px" }}>
          <label>From</label>
          <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="22" inputMode="numeric" />
        </div>
        <div className="ll-field" style={{ flex: "1 1 110px" }}>
          <label>To</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="25" inputMode="numeric" />
        </div>
        <div className="ll-field" style={{ flex: "1 1 150px" }}>
          <label>What are they?</label>
          <select value={siteType} onChange={(e) => setSiteType(e.target.value)}>
            <option value="rv_site">RV site</option>
            <option value="mh_single">Single-wide pad</option>
            <option value="mh_double">Double-wide pad</option>
            <option value="tent">Tent site</option>
            <option value="slip">Boat slip</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 4 }}>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={rentalMode === "short_term"}
            onChange={(e) => setRentalMode(e.target.checked ? "short_term" : "long_term")} />
          Rented by the night
        </label>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={liveNow} onChange={(e) => setLiveNow(e.target.checked)} />
          Built and rentable now
        </label>
      </div>

      {range.error && from.trim() ? (
        <p style={{ fontSize: 13, color: "var(--ink-warn, #9a6b15)", margin: "8px 0 0" }}>
          {range.error}
        </p>
      ) : n > 0 ? (
        <p className="mut" style={{ fontSize: 12.5, margin: "8px 0 0", lineHeight: 1.5 }}>
          {n === 1 ? "One lot" : `${n} lots`}: {range.labels.slice(0, 6).join(", ")}
          {range.labels.length > 6 ? `, … ${range.labels[range.labels.length - 1]}` : ""}
          {liveNow ? "" : " — added as not built yet, so they share no costs until you mark one live."}
        </p>
      ) : null}

      {/* WHAT IT COSTS HIM. Only shown when it is actually true. */}
      {impact && (
        <div style={{
          marginTop: 10, background: "var(--sand, #f6f3ec)",
          borderRadius: 10, padding: "10px 12px",
        }}>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>
            What this does to a {usd(monthlyShared)} month of shared costs
          </div>
          <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            Each household: {usd(impact.eachNow)} → <strong>{usd(impact.eachAfter)}</strong>
            <br />
            You carry: {usd(impact.carryNow)} → <strong>{usd(impact.carryAfter)}</strong>{" "}a
            month until they&apos;re rented.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button
          className="ll-btn gold"
          style={{ minHeight: 44 }}
          disabled={busy || n === 0}
          onClick={() =>
            start(async () => {
              const res = await addLots(parkId, {
                from, to: to || from, siteType, rentalMode, liveNow,
              });
              toast(res.ok ? (res.signal ?? "Added.") : (res.error ?? "Couldn't add those."));
              if (res.ok) {
                setOpen(false); setFrom(""); setTo(""); setLiveNow(false);
                router.refresh();
              }
            })
          }
        >
          {busy ? "Adding…" : n > 1 ? `Add ${n} lots` : "Add it"}
        </button>
        <button className="ll-btn ghost" style={{ minHeight: 44 }} disabled={busy}
          onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
