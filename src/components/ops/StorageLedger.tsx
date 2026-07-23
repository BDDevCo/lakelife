"use client";

/**
 * Storage — the winter-custody ledger (ops-only). Per-vendor capacity bars
 * (committed feet vs the seasonal pool, garagekeepers doc status) and the
 * stays table (who's holding what, and who's running the overstay meter).
 */

import type { StorageLedger as StorageLedgerData } from "@/app/ops/storage-data";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function prettyDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_PILL: Record<string, { tone: string; label: string }> = {
  reserved: { tone: "slate", label: "reserved" },
  in_storage: { tone: "ok", label: "in storage" },
  released: { tone: "teal", label: "released" },
  cancelled: { tone: "slate", label: "cancelled" },
};

const EMPTY_COPY = "No boats in storage yet — flip the packages on when rates are set.";

export function StorageLedger({ ledger }: { ledger: StorageLedgerData }) {
  const { vendors, stays } = ledger;
  const wholePanelEmpty = vendors.length === 0 && stays.length === 0;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 17, margin: "0 0 2px" }}>Storage</h3>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        Who&apos;s holding what, how full each yard is, and who&apos;s running the overstay meter.
      </p>

      {wholePanelEmpty ? (
        <p className="mut" style={{ fontSize: 13.5, padding: "6px 2px" }}>{EMPTY_COPY}</p>
      ) : (
        <div style={{ display: "grid", gap: 20 }}>
          {vendors.length > 0 && (
            <div>
              <div
                className="mut"
                style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}
              >
                Vendor capacity
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {vendors.map((v) => {
                  const overCap = v.utilization_pct > 90;
                  const docWarn = !v.garagekeepers_ok;
                  const barPct = Math.min(100, v.utilization_pct);
                  return (
                    <div key={v.vendor_id}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13.5 }}>
                          <strong>{v.company ?? "Unnamed crew"}</strong>: {v.committed_feet}/{v.capacity_feet} ft committed
                          {" · "}
                          {v.garagekeepers_expiry
                            ? `garagekeepers through ${prettyDate(v.garagekeepers_expiry)}`
                            : "no garagekeepers doc on file"}
                        </span>
                        {(overCap || docWarn) && (
                          <span className="ll-pill warn">
                            {docWarn ? "garagekeepers missing/expired" : "over 90% full"}
                          </span>
                        )}
                      </div>
                      <div style={{ height: 8, borderRadius: 4, background: "var(--line)", marginTop: 5, overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${barPct}%`,
                            background: overCap ? "var(--warn)" : "var(--teal)",
                            borderRadius: 4,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <div
              className="mut"
              style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}
            >
              Stays
            </div>
            {stays.length === 0 ? (
              <p className="mut" style={{ fontSize: 13.5, padding: "4px 2px" }}>{EMPTY_COPY}</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--sub)" }}>
                      <th style={{ padding: "6px 8px" }}>Property</th>
                      <th style={{ padding: "6px 8px" }}>Vendor</th>
                      <th style={{ padding: "6px 8px", textAlign: "right" }}>Feet</th>
                      <th style={{ padding: "6px 8px" }}>Status</th>
                      <th style={{ padding: "6px 8px" }}>Intake</th>
                      <th style={{ padding: "6px 8px" }}>Season end</th>
                      <th style={{ padding: "6px 8px" }}>Overstay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stays.map((s) => {
                      const pill = STATUS_PILL[s.status] ?? { tone: "slate", label: s.status };
                      return (
                        <tr key={s.id} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "7px 8px", fontWeight: 700 }}>{s.address ?? "—"}</td>
                          <td style={{ padding: "7px 8px" }}>{s.vendor_company ?? "—"}</td>
                          <td style={{ padding: "7px 8px", textAlign: "right" }}>{s.boat_feet}</td>
                          <td style={{ padding: "7px 8px" }}>
                            <span className={`ll-pill ${pill.tone}`}>{pill.label}</span>
                          </td>
                          <td style={{ padding: "7px 8px" }}>{prettyDate(s.intake_at)}</td>
                          <td style={{ padding: "7px 8px" }}>{prettyDate(s.season_end)}</td>
                          <td style={{ padding: "7px 8px" }}>
                            {s.overstay_days > 0 ? (
                              <span className="ll-pill gold">⏱ {money(s.overstay_charge)} meter</span>
                            ) : (
                              <span className="mut">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
