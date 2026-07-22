"use client";

import { useState } from "react";
import { JobBoard } from "./JobBoard";
import { MarginTable } from "./MarginTable";
import { LakeConditions } from "./LakeConditions";
import { RouteBuilder } from "./RouteBuilder";
import { MessageBoard } from "./MessageBoard";
import { CrewBoard } from "./CrewBoard";
import { NeedsAttention } from "./NeedsAttention";
import { PlatformSettingsCard } from "./PlatformSettingsCard";
import type { NeedsAttentionJob, PropertyPreferred } from "@/app/ops/dispatch-data";
import type { OpsJob, ActiveVendor, MarginRow, LakeCondition, RouteSummary } from "@/app/ops/data";
import type { OpsThread } from "@/app/ops/messages-data";
import type { OpsCrew } from "@/app/ops/crews-data";

const TABS = [
  { key: "jobs", label: "Jobs" },
  { key: "dispatch", label: "Dispatch" },
  { key: "margin", label: "Revenue & margin" },
  { key: "lakes", label: "Lake conditions" },
  { key: "routing", label: "Routing" },
  { key: "crews", label: "Crews" },
  { key: "messages", label: "Messages" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function OpsShell({
  jobs,
  vendors,
  margin,
  lakes,
  routes,
  routeDate,
  threads,
  crews,
  crewServiceNames,
  needsAttention,
  preferredJobIds,
  preferredProps,
  settings,
}: {
  jobs: OpsJob[];
  vendors: ActiveVendor[];
  margin: { rows: MarginRow[]; total: MarginRow };
  lakes: LakeCondition[];
  routes: RouteSummary[];
  routeDate: string;
  threads: OpsThread[];
  crews: OpsCrew[];
  crewServiceNames: string[];
  needsAttention: NeedsAttentionJob[];
  preferredJobIds: string[];
  preferredProps: PropertyPreferred[];
  settings: { marginFloorPct: number; surgeCapPct: number };
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

      {tab === "jobs" && <JobBoard jobs={jobs} vendors={vendors} preferredJobIds={preferredJobIds} />}

      {tab === "dispatch" && <NeedsAttention jobs={needsAttention} crews={vendors} properties={preferredProps} />}
      {tab === "dispatch" && <PlatformSettingsCard settings={settings} />}
      {tab === "margin" && <MarginTable rows={margin.rows} total={margin.total} />}
      {tab === "lakes" && <LakeConditions lakes={lakes} />}
      {tab === "routing" && <RouteBuilder routes={routes} date={routeDate} />}

      {tab === "crews" && <CrewBoard crews={crews} activeServiceNames={crewServiceNames} />}

      {tab === "messages" && <MessageBoard threads={threads} />}
    </div>
  );
}
