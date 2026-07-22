"use client";

/**
 * Margin health — the owner's menu-tuning instrument (ops-only). One row per
 * service × lake: volume, blended margin, how many crews could actually take
 * the work, and how much demand is WAITING. Sorted trouble-first.
 */

import type { MarginHealthRow } from "@/app/ops/data";

export function MarginHealth({ rows }: { rows: MarginHealthRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 17, margin: "0 0 2px" }}>Margin health by lake</h3>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        Your menu-tuning instrument. High margin + waiting demand → cut the menu price or recruit.
        Margin pinned near the floor → that market can bear a higher menu. Waiting with 0 ready
        crews → recruiting is the unblock, not pricing.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--sub)" }}>
              <th style={{ padding: "6px 8px" }}>Service</th>
              <th style={{ padding: "6px 8px" }}>Lake</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Jobs</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Blended margin</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Ready crews</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Waiting</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.service_name}|${r.lake_name}`} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ padding: "7px 8px", fontWeight: 700 }}>{r.service_name}</td>
                <td style={{ padding: "7px 8px" }}>{r.lake_name}</td>
                <td style={{ padding: "7px 8px", textAlign: "right" }}>{r.jobs}</td>
                <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: 700, color: r.jobs === 0 ? "var(--sub)" : r.margin_pct < 25 ? "var(--warn)" : "var(--teal-dark)" }}>
                  {r.jobs === 0 ? "—" : `${r.margin_pct}%`}
                </td>
                <td style={{ padding: "7px 8px", textAlign: "right", color: r.crews_with_rate === 0 ? "var(--warn)" : "inherit", fontWeight: r.crews_with_rate === 0 ? 700 : 400 }}>
                  {r.crews_with_rate}
                </td>
                <td style={{ padding: "7px 8px", textAlign: "right", color: r.waiting > 0 ? "var(--warn)" : "var(--sub)", fontWeight: r.waiting > 0 ? 700 : 400 }}>
                  {r.waiting}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
