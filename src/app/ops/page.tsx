import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OpsShell } from "@/components/ops/OpsShell";
import { hasSupabaseEnv } from "@/lib/env";
import {
  assertOps,
  getOpsSummary,
  getJobBoard,
  getActiveVendors,
  getMarginByService,
  getLakeConditions,
  getRoutesForDate,
  getMarginHealth,
  getEscalatedDisputes,
} from "./data";
import { resolveEscalationAction } from "./dispute-actions";
import { getMessageThreads } from "./messages-data";
import { getCrews, getActiveServiceNames } from "./crews-data";
import { getNeedsAttention, getPreferredJobIds, getPropertiesWithPreferred } from "./dispatch-data";
import { getStorageLedger } from "./storage-data";
import { getPayoutQueue } from "./payout-data";
import { getOpsCalendar } from "./calendar-data";
import { getPlatformSettings } from "@/lib/settings";
import { todayLakeDate } from "@/lib/booking";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default async function OpsPage() {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const ops = await assertOps();
  if (!ops) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Operations only</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>This is the ops console</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              Your account isn&apos;t an operations account. If you think that&apos;s wrong, contact your admin.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  // Tomorrow in lake time — the router's default target.
  const t = new Date(todayLakeDate() + "T12:00:00");
  t.setDate(t.getDate() + 1);
  const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  const calendarYear = Number(todayLakeDate().slice(0, 4));

  const [summary, jobs, vendors, margin, lakes, routes, threads, crews, crewServiceNames, needsAttention, preferredJobIds, preferredProps, s, marginHealth, storageLedger, payoutQueue, calendarRows, escalations] = await Promise.all([
    getOpsSummary(),
    getJobBoard(),
    getActiveVendors(),
    getMarginByService(),
    getLakeConditions(),
    getRoutesForDate(tomorrow),
    getMessageThreads(),
    getCrews(),
    getActiveServiceNames(),
    getNeedsAttention(),
    getPreferredJobIds(),
    getPropertiesWithPreferred(),
    getPlatformSettings(),
    getMarginHealth(),
    getStorageLedger(),
    getPayoutQueue(),
    getOpsCalendar(calendarYear),
    getEscalatedDisputes(),
  ]);

  const kpis = [
    { v: String(summary.requestsWaiting), l: "Requests waiting" },
    { v: String(summary.jobsThisWeek), l: "Jobs this week" },
    { v: money.format(summary.weekRevenue), l: "Week revenue (customer)" },
    { v: money.format(summary.weekMargin), l: "Week LakeLife margin", d: `${summary.weekMarginPct}% blended` },
  ];

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10 }}>
          <div>
            <span className="ll-pill gold" style={{ marginBottom: 8, display: "inline-block" }}>Operations · Internal</span>
            <h1 style={{ fontSize: 26 }}>The logistics brain</h1>
            {/* Dynamic — a new lakes row shows up here (and everywhere) with zero code changes. */}
            <p className="mut" style={{ fontSize: 14 }}>
              {lakes.filter((l) => !l.name.startsWith("zz-")).map((l) => l.name.replace(/ Lake$/, "")).join(" · ") || "No lakes yet"}
            </p>
          </div>
          <span className="ll-pill teal">30% platform margin · hidden from customers &amp; crews</span>
        </div>

        <div
          style={{
            display: "grid", gap: 12, marginTop: 18,
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          }}
        >
          {kpis.map((k, i) => (
            <div key={i} className="ll-card ll-card-pad">
              <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "var(--font-display)" }}>{k.v}</div>
              <div className="mut" style={{ fontSize: 12.5 }}>{k.l}</div>
              {k.d && <div style={{ fontSize: 11.5, color: "var(--teal-dark)", fontWeight: 700, marginTop: 2 }}>{k.d}</div>}
            </div>
          ))}
        </div>

        {escalations.length > 0 && (
          <div className="ll-card ll-card-pad" style={{ marginTop: 18, borderLeft: "4px solid var(--gold, #d9a441)" }}>
            <span className="ll-pill gold">Make-It-Right · waiting on you</span>
            <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>
              {escalations.length === 1 ? "1 dispute needs a human call" : `${escalations.length} disputes need a human call`}
            </h2>
            <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
              The machine handled everything it could — these crossed the auto-refund line. Crew pay is frozen on each until you decide.
            </p>
            <div style={{ display: "grid", gap: 10 }}>
              {escalations.map((e) => (
                <div key={e.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--sand-light, #f7f4ec)", borderRadius: 12 }}>
                  <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{e.service} · {e.where} · {money.format(e.customerPrice)}</div>
                    {e.note && <div className="mut" style={{ fontSize: 12.5 }}>Customer: &ldquo;{e.note}&rdquo;</div>}
                    {e.why && <div className="mut" style={{ fontSize: 12 }}>{e.why} · opened {e.openedAt}</div>}
                  </div>
                  <form action={resolveEscalationAction} style={{ display: "flex", gap: 8 }}>
                    <input type="hidden" name="disputeId" value={e.id} />
                    <button className="ll-btn" type="submit" name="outcome" value="refund" style={{ fontSize: 13 }}>Refund the customer</button>
                    <button className="ll-btn ghost" type="submit" name="outcome" value="close" style={{ fontSize: 13 }}>Close in crew&apos;s favor</button>
                  </form>
                </div>
              ))}
            </div>
          </div>
        )}

        <OpsShell marginHealth={marginHealth} storageLedger={storageLedger} payoutQueue={payoutQueue} jobs={jobs} vendors={vendors} margin={margin} lakes={lakes} routes={routes} routeDate={tomorrow} threads={threads} crews={crews} crewServiceNames={crewServiceNames} needsAttention={needsAttention} preferredJobIds={preferredJobIds} preferredProps={preferredProps} settings={{ marginFloorPct: Math.round(s.marginFloor * 100), surgeCapPct: Math.round(s.surgeCapPct * 100) }} calendarYear={calendarYear} calendarRows={calendarRows} />
      </div>
    </>
  );
}
