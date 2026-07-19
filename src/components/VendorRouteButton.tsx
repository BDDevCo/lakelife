"use client";

import { useEffect, useState } from "react";
import { fullRouteUrl, mapAppName } from "@/lib/navlink";
import { toast } from "@/components/Toast";

export function VendorRouteButton({ points, count }: { points: Array<{ lat: number; lng: number }>; count: number }) {
  const [app, setApp] = useState("Maps");
  useEffect(() => setApp(mapAppName()), []);

  function openRoute() {
    const url = fullRouteUrl(points);
    if (!url) { toast("No map locations on this route yet."); return; }
    window.open(url, "_blank");
  }

  async function sendToCrew() {
    const url = fullRouteUrl(points);
    if (!url) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "LakeLife route", url });
        return;
      } catch {}
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Route link copied — paste it to your crew.");
    } catch {
      window.open(url, "_blank");
    }
  }

  return (
    <div className="ll-card ll-card-pad" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontSize: 14 }}>
        <b>{count} stop{count === 1 ? "" : "s"}</b>
        <span className="mut"> · opens in {app} on this device</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="ll-btn sm" onClick={openRoute}>Open route in {app}</button>
        <button className="ll-btn ghost sm" onClick={sendToCrew}>Send to crew</button>
      </div>
    </div>
  );
}
