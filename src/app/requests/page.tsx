import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { formatPrice } from "@/lib/pricing";
import { getActivePropertyId } from "@/app/profile/data";
import { CancelRequestButton } from "@/components/CancelRequestButton";
import { todayLakeDate } from "@/lib/booking";

const STATUS_PILL: Record<string, string> = {
  requested: "warn", scheduled: "teal", in_progress: "teal", complete: "ok", paid: "slate",
};
const STATUS_LABEL: Record<string, string> = {
  requested: "Requested", scheduled: "Scheduled", in_progress: "In progress", complete: "Complete", paid: "Paid",
};

export default async function RequestsPage() {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Sign in first</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const activeId = await getActivePropertyId();
  let query = supabase
    .from("owner_jobs")
    .select("id, service_name, date, frequency, status, customer_price, created_at")
    .order("created_at", { ascending: false });
  if (activeId) query = query.eq("property_id", activeId);
  const { data: jobs } = await query;

  const rows = jobs ?? [];

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24 }}>
        <h1 style={{ fontSize: 26, marginBottom: 16 }}>My requests</h1>

        {rows.length === 0 ? (
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
              No requests yet. Book your first service to see it here.
            </p>
            <Link className="ll-btn gold" href="/book">Book a service →</Link>
          </div>
        ) : (
          <div className="ll-card" style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: "left", background: "#f7fafb" }}>
                    <Th>Service</Th><Th>Frequency</Th><Th>Date</Th><Th>Status</Th><Th right>Price</Th><Th right>{""}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const cancellable =
                      r.status === "requested" ||
                      (r.status === "scheduled" && (!r.date || r.date > todayLakeDate()));
                    return (
                      <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                        <Td><b>{r.service_name ?? "Service"}</b></Td>
                        <Td muted>{r.frequency ?? "—"}</Td>
                        <Td>{r.date ? new Date(r.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</Td>
                        <Td><span className={`ll-pill ${STATUS_PILL[r.status] ?? "slate"}`}>{STATUS_LABEL[r.status] ?? r.status}</span></Td>
                        <Td right>{r.customer_price != null ? formatPrice(Number(r.customer_price)) : "—"}</Td>
                        <Td right>{cancellable ? <CancelRequestButton jobId={r.id} serviceName={r.service_name ?? "this service"} /> : null}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th style={{ padding: "11px 14px", fontSize: 12, color: "var(--sub)", textAlign: right ? "right" : "left" }}>{children}</th>;
}
function Td({ children, right, muted }: { children: React.ReactNode; right?: boolean; muted?: boolean }) {
  return <td style={{ padding: "11px 14px", textAlign: right ? "right" : "left", color: muted ? "var(--sub)" : "inherit" }}>{children}</td>;
}
