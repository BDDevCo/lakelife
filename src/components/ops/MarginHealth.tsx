"use client";

/**
 * Margin health — the owner's menu-tuning instrument (ops-only). One row per
 * service × lake: volume, blended margin, how many crews could actually take
 * the work, and how much demand is WAITING. Sorted trouble-first.
 *
 * Etiology (docs/margin-gap-design.md, 2026-07-23): when demand is waiting,
 * the loader splits WHY — a ready crew exists but is at capacity (recruit),
 * or every crew here is priced under the floor (the menu is the problem).
 * Ops-side only; prices are allowed here (never on a vendor/customer surface).
 *
 * Margin-stranded rows carry a one-tap price suggestion — a gold chip with
 * an Apply button that, after a confirm(), writes the raise straight to the
 * live services menu (menu-actions.ts). That changes what customers pay
 * going forward; existing booked jobs keep the price they were quoted.
 */

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import type { MarginHealthRow } from "@/app/ops/data";
import { applyMenuSuggestion } from "@/app/ops/menu-actions";

export function MarginHealth({ rows }: { rows: MarginHealthRow[] }) {
  const router = useRouter();
  const [applyingKey, setApplyingKey] = useState<string | null>(null);

  if (rows.length === 0) return null;

  async function apply(rowKey: string, suggestion: NonNullable<MarginHealthRow["suggestion"]>) {
    if (applyingKey) return;
    const ok = window.confirm("Raises the menu for ALL future bookings of this service. Apply?");
    if (!ok) return;
    setApplyingKey(rowKey);
    const res = await applyMenuSuggestion({
      serviceId: suggestion.serviceId,
      field: suggestion.field,
      newValue: suggestion.newValue,
    });
    setApplyingKey(null);
    if (!res.ok) {
      toast(res.error ?? "Couldn't apply that price change.");
      return;
    }
    toast(res.applied ?? "Menu price updated. 🌊");
    router.refresh();
  }
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
              <Fragment key={`${r.service_name}|${r.lake_name}`}>
                <tr style={{ borderTop: "1px solid var(--line)" }}>
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
                {r.etiology && (
                  <tr>
                    <td colSpan={6} style={{ padding: "0 8px 10px" }}>
                      {r.etiology === "capacity_stranded" ? (
                        <span className="ll-pill teal">capacity-stranded — recruit/expand</span>
                      ) : (
                        <>
                          <span className="ll-pill gold">margin-stranded — menu-price-up candidate</span>
                          <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
                            Every crew here prices above the floor — the fill-in price is the market talking. Consider raising the menu.
                          </p>
                          {r.suggestion && (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                              <span className="ll-pill gold">{r.suggestion.label}</span>
                              <button
                                className="ll-btn ghost sm"
                                disabled={applyingKey === `${r.service_name}|${r.lake_name}`}
                                onClick={() => apply(`${r.service_name}|${r.lake_name}`, r.suggestion as NonNullable<MarginHealthRow["suggestion"]>)}
                              >
                                {applyingKey === `${r.service_name}|${r.lake_name}` ? "Applying…" : "Apply"}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
