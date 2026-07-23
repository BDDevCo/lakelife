"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildRoutesForDate } from "@/app/ops/actions";
import { toast } from "@/components/Toast";
import type { RouteSummary } from "@/app/ops/data";

export function RouteBuilder({ routes, date }: { routes: RouteSummary[]; date: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const pretty = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  async function build() {
    setBusy(true);
    const res = await buildRoutesForDate(date);
    setBusy(false);
    if (!res.ok) { toast(res.error ?? "Couldn't build routes."); return; }
    toast(
      `Built ${res.routes} route${res.routes === 1 ? "" : "s"} · ${res.stops} stop${res.stops === 1 ? "" : "s"}` +
      (res.overflow ? ` · ${res.overflow} over capacity — reschedule those` : "") +
      (res.texted ? ` · ${res.texted} crew${res.texted === 1 ? "" : "s"} texted` : ""),
    );
    router.refresh();
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="ll-card ll-card-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <b style={{ fontSize: 16 }}>Tomorrow&apos;s routes — {pretty}</b>
          <p className="mut" style={{ fontSize: 12.5, marginTop: 2 }}>
            The scheduler runs this automatically at 8pm. Build early any time — it&apos;s a clean rebuild, and each crew gets their map link by text.
          </p>
        </div>
        <button className="ll-btn gold" onClick={build} disabled={busy}>
          {busy ? "Building…" : "Build routes now"}
        </button>
      </div>

      {routes.length === 0 ? (
        <div className="ll-card ll-card-pad">
          <p className="mut" style={{ fontSize: 13.5 }}>No routes built for {pretty} yet.</p>
        </div>
      ) : (
        routes.map((r) => (
          <div key={r.id} className="ll-card ll-card-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <b style={{ fontSize: 15 }}>
                {r.vendor_company ?? "Crew"}
                {r.unit_name && <span className="mut" style={{ fontWeight: 400 }}> — {r.unit_name}</span>}
              </b>
              <div className="mut" style={{ fontSize: 12.5 }}>
                {r.stops} stop{r.stops === 1 ? "" : "s"} · ~{r.drive_minutes ?? "—"} min drive
                {r.est_miles != null && <> · ~{r.est_miles} mi</>}
                {r.est_fuel != null && <> · ~${r.est_fuel.toFixed(2)} fuel</>}
              </div>
            </div>
            {r.map_url && (
              <a className="ll-btn ghost sm" href={r.map_url} target="_blank" rel="noreferrer">Open map ➤</a>
            )}
          </div>
        ))
      )}
    </div>
  );
}
