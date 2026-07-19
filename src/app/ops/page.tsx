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
} from "./data";

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

  const [summary, jobs, vendors, margin, lakes] = await Promise.all([
    getOpsSummary(),
    getJobBoard(),
    getActiveVendors(),
    getMarginByService(),
    getLakeConditions(),
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
            <p className="mut" style={{ fontSize: 14 }}>Big Long · Pretty · Big Turkey</p>
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

        <OpsShell jobs={jobs} vendors={vendors} margin={margin} lakes={lakes} />
      </div>
    </>
  );
}
