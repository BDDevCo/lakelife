"use client";

import { toast } from "@/components/Toast";

/**
 * Copyable personal calendar-feed URL + one-tap webcal subscribe. The URL is
 * the signed-in owner's unguessable ICS token link.
 */
export function CalendarSubscribe({ url }: { url: string }) {
  const webcal = url.replace(/^https?/, "webcal");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast("Copied — paste into your calendar app");
    } catch {
      toast("Couldn't copy — long-press the link instead.");
    }
  }

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <code
        style={{
          flex: "1 1 200px", minWidth: 0, maxWidth: "100%", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5,
          background: "#f7fafb", border: "1.5px solid var(--line)", borderRadius: 8,
          padding: "10px 12px", color: "var(--sub)",
        }}
      >
        {url}
      </code>
      <button className="ll-btn ghost sm" onClick={copy} style={{ minHeight: 44 }}>
        Copy
      </button>
      <a className="ll-btn sm" href={webcal} style={{ minHeight: 44, textDecoration: "none" }}>
        Subscribe (iPhone/Mac)
      </a>
    </div>
  );
}
