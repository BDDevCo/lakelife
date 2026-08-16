"use client";

import { useSyncExternalStore } from "react";
import { fullRouteUrl, mapAppName } from "@/lib/navlink";
import { toast } from "@/components/Toast";

/**
 * Which map app the button offers is a fact about the DEVICE — Apple Maps on
 * an iPhone, Google Maps elsewhere — and the server has no idea which one is
 * asking.
 *
 * That is why this was an effect, and the effect was not wrong: reading the
 * user agent during render would make the server render "Maps" and the browser
 * render "Apple Maps", which is a hydration mismatch. But it cost a render —
 * every crew on an iPhone saw the button say "Maps" and then change.
 *
 * useSyncExternalStore is the API for precisely this: it takes a SERVER answer
 * and a CLIENT answer and lets React use the right one on each side, with no
 * mismatch and no second paint. `subscribe` sits at module scope because React
 * re-subscribes whenever that function identity changes, and this value never
 * changes after mount — there is nothing to subscribe to.
 */
const subscribeToNothing = () => () => {};

export function VendorRouteButton({ points, count }: { points: Array<{ lat: number; lng: number }>; count: number }) {
  const app = useSyncExternalStore(subscribeToNothing, mapAppName, () => "Maps");

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
