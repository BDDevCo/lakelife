"use client";

import { useState } from "react";
import { JobBoard } from "./JobBoard";
import { MarginTable } from "./MarginTable";
import { LakeConditions } from "./LakeConditions";
import type { OpsJob, ActiveVendor, MarginRow, LakeCondition } from "@/app/ops/data";

const TABS = [
  { key: "jobs", label: "Jobs" },
  { key: "margin", label: "Revenue & margin" },
  { key: "lakes", label: "Lake conditions" },
  { key: "routing", label: "Routing" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function OpsShell({
  jobs,
  vendors,
  margin,
  lakes,
}: {
  jobs: OpsJob[];
  vendors: ActiveVendor[];
  margin: { rows: MarginRow[]; total: MarginRow };
  lakes: LakeCondition[];
}) {
  const [tab, setTab] = useState<TabKey>("jobs");

  return (
    <div>
      <div
        style={{
          display: "flex", gap: 4, borderBottom: "2px solid var(--line)",
          flexWrap: "wrap", margin: "18px 0 18px",
        }}
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "10px 14px", fontWeight: 700, fontSize: 14, whiteSpace: "nowrap",
                background: "none", border: "none", cursor: "pointer",
                color: active ? "var(--teal-dark)" : "var(--sub)",
                borderBottom: `2px solid ${active ? "var(--teal)" : "transparent"}`,
                marginBottom: -2,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "jobs" && <JobBoard jobs={jobs} vendors={vendors} />}
      {tab === "margin" && <MarginTable rows={margin.rows} total={margin.total} />}
      {tab === "lakes" && <LakeConditions lakes={lakes} />}
      {tab === "routing" && (
        <div className="ll-card ll-card-pad">
          <span className="ll-pill slate">Ships next</span>
          <h3 style={{ fontSize: 18, margin: "10px 0 6px" }}>Nightly auto-routing</h3>
          <p className="mut" style={{ fontSize: 13.5, lineHeight: 1.6, maxWidth: 560 }}>
            Right now you assign each job to a crew, day, and time by hand from the Jobs tab.
            The next phase adds the 8pm router: it takes tomorrow&apos;s scheduled jobs, clusters
            them by lake and shore, orders each crew&apos;s stops by drive direction, caps at daily
            capacity, and texts every crew their map link — no manual sequencing.
          </p>
        </div>
      )}
    </div>
  );
}
