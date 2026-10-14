"use client";

import { JobBoard } from "./JobBoard";
import { MarginTable } from "./MarginTable";
import { LakeConditions } from "./LakeConditions";
import { RouteBuilder } from "./RouteBuilder";
import { MessageBoard } from "./MessageBoard";
import { CrewBoard } from "./CrewBoard";
import { CrewCoverage } from "./CrewCoverage";
import { ParkEnquiries } from "./ParkEnquiries";
import { NeedsAttention } from "./NeedsAttention";
import { PlatformSettingsCard } from "./PlatformSettingsCard";
import type { NeedsAttentionJob, PropertyPreferred } from "@/app/ops/dispatch-data";
import { MarginHealth } from "./MarginHealth";
import type { MarginHealthRow } from "@/app/ops/data";
import { StorageLedger } from "./StorageLedger";
import type { StorageLedger as StorageLedgerData } from "@/app/ops/storage-data";
import { PayoutQueue } from "./PayoutQueue";
import type { PayoutQueue as PayoutQueueData } from "@/app/ops/payout-data";
import type { CrewCoverage as Coverage } from "@/app/ops/crews-data";
import type { ParkEnquiry } from "@/app/ops/parks-data";
import type { OpsJob, ActiveVendor, MarginRow, LakeCondition, RouteSummary } from "@/app/ops/data";
import type { OpsThread } from "@/app/ops/messages-data";
import type { OpsCrew, SetupService } from "@/app/ops/crews-data";
import { OpsCalendar } from "./OpsCalendar";
import type { CalRow } from "@/app/ops/calendar-data";
import { ParkBoard } from "./ParkBoard";
import type { OpsParkRow } from "@/app/ops/parks-data";
import { OPS_TAB_STRIP_ID, useOpsTab } from "./OpsTabs";
import type { OpsTab } from "@/app/ops/ops-today-helpers";

const TABS = [
  { key: "jobs", label: "Jobs" },
  { key: "calendar", label: "Calendar" },
  { key: "dispatch", label: "Dispatch" },
  { key: "margin", label: "Revenue & margin" },
  { key: "lakes", label: "Lake conditions" },
  { key: "routing", label: "Routing" },
  { key: "crews", label: "Crews" },
  { key: "messages", label: "Messages" },
  { key: "parks", label: "Parks" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * THE STRIP'S KEYS AND THE TASK LIST'S TABS ARE THE SAME SET.
 *
 * `OpsTab` is hand-written in ops-today-helpers, because that module is pure
 * and must not import a component. So there are two spellings of the nine
 * tabs, and nothing stopped them drifting: add a tab here and forget it there
 * and the task list cannot point at it; the reverse and a task's button opens
 * a tab that does not exist, which renders as nothing happening.
 *
 * This is the assertion, in the type system, so either omission is a compile
 * error rather than a dead button.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _tabsAgree: Mutual<OpsTab, TabKey> = true;
void _tabsAgree;

export function OpsShell({
  jobs,
  vendors,
  margin,
  marginHealth,
  lakes,
  routes,
  routeDate,
  threads,
  crews,
  setupServices,
  coverage,
  enquiries,
  needsAttention,
  preferredJobIds,
  preferredProps,
  settings,
  storageLedger,
  payoutQueue,
  calendarYear,
  calendarRows,
  parks,
  openingTab,
}: {
  jobs: OpsJob[];
  vendors: ActiveVendor[];
  margin: { rows: MarginRow[]; total: MarginRow };
  marginHealth: MarginHealthRow[];
  lakes: LakeCondition[];
  routes: RouteSummary[];
  routeDate: string;
  threads: OpsThread[];
  crews: OpsCrew[];
  setupServices: SetupService[];
  coverage: Coverage;
  enquiries: ParkEnquiry[];
  needsAttention: NeedsAttentionJob[];
  preferredJobIds: string[];
  preferredProps: PropertyPreferred[];
  settings: { marginFloorPct: number; surgeCapPct: number; feeCustomerPct: number; feeCrewPct: number };
  storageLedger: StorageLedgerData;
  payoutQueue: PayoutQueueData;
  calendarYear: number;
  calendarRows: CalRow[];
  parks: OpsParkRow[];
  /**
   * THE TAB IT OPENS ON. It was hard-coded to "jobs", which in production is
   * an empty board — so the first thing the console ever showed was nothing.
   * Now it opens where the top job is.
   *
   * Only a FALLBACK here: the live tab lives in OpsTabProvider, so the "needs
   * you today" card can sit at the top of the page and still drive this strip
   * — see OpsTabs.tsx for why that mattered.
   */
  openingTab: OpsTab;
}) {
  const { tab, setTab } = useOpsTab(openingTab);

  return (
    <div>

      <div
        id={OPS_TAB_STRIP_ID}
        style={{
          display: "flex", gap: 4, borderBottom: "2px solid var(--line)",
          flexWrap: "wrap", margin: "18px 0 18px",
          // Sticks so the nine tabs stay reachable while he reads a long
          // board, and so "Open dispatch" lands on a strip that is still
          // visible after the scroll.
          position: "sticky", top: 0, zIndex: 20, background: "var(--mist)",
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

      {tab === "calendar" && (
        <OpsCalendar
          initialYear={calendarYear}
          initialRows={calendarRows}
          lakes={lakes.map((l) => ({ id: l.id, name: l.name }))}
        />
      )}

      {tab === "dispatch" && <NeedsAttention jobs={needsAttention} crews={vendors} properties={preferredProps} />}
      {tab === "dispatch" && <StorageLedger ledger={storageLedger} />}
      {tab === "dispatch" && <PayoutQueue queue={payoutQueue} />}
      {/* THE PRICING DIALS BELONG WITH THE MONEY, NOT WITH DISPATCH.
          His words, 24 Sep 2026: "move them they are not apart of any crew
          decision making. rev and margin is best spot."

          They were on Dispatch for a reason that made sense once and stopped
          making sense three passes later. The margin FLOOR lived there because
          it gates routing — a dispatch decision. 0174 put the two platform-fee
          dials beside it because that is where the dials were; 0178 added the
          standing dial beside those; 0179 added the per-service crew-priced
          switch beside those. Each step was "put it with the other dials", each
          was locally sensible, and the result was that the control which
          defines what LakeLife charges sat on a jobs-triage tab, between
          "Needs attention" and a payouts queue, with a tab literally called
          "Revenue & margin" next to it. He went looking for it and could not
          find it — which is the only test of a control's location that counts.

          They go FIRST on this tab, above the tables: these are the numbers
          that PRODUCE the margin below them, and reading the output before the
          input is backwards. */}
      {tab === "margin" && (
        <>
          <PlatformSettingsCard settings={settings} />
          <MarginTable rows={margin.rows} total={margin.total} />
          <MarginHealth rows={marginHealth} />
        </>
      )}
      {tab === "lakes" && <LakeConditions lakes={lakes} />}
      {tab === "routing" && <RouteBuilder routes={routes} date={routeDate} />}

      {tab === "crews" && (
        <>
          {/* ABOVE the roster on purpose. The roster answers "who have we
              got"; this answers "is that enough", and the second question is
              the one nobody thinks to ask until a job is already stuck. */}
          <CrewCoverage coverage={coverage} />
          <CrewBoard crews={crews} setupServices={setupServices} lakes={lakes.map((l) => ({ id: l.id, name: l.name }))} />
        </>
      )}

      {tab === "messages" && <MessageBoard threads={threads} />}
      {tab === "parks" && (
        <>
          {/* ABOVE the board. Somebody waiting on a reply outranks the parks
              already running, and this is the only screen that knows. */}
          <ParkEnquiries enquiries={enquiries} />
          <ParkBoard parks={parks} lakes={lakes.map((l) => ({ id: l.id, name: l.name }))} />
        </>
      )}
    </div>
  );
}
