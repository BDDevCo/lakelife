import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { formatPrice } from "@/lib/pricing";
import { listPaymentMethods } from "@/app/profile/payment-actions";
import { getActivePropertyId } from "@/app/profile/data";

export default async function BillingPage() {
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
  let upcomingQ = supabase
    .from("owner_jobs")
    .select("id, service_name, date, status, customer_price")
    .in("status", ["requested", "scheduled", "in_progress"])
    .order("date", { ascending: true });
  let invoiceQ = supabase.from("invoices").select("id, amount, status, created_at").order("created_at", { ascending: false });
  if (activeId) {
    upcomingQ = upcomingQ.eq("property_id", activeId);
    invoiceQ = invoiceQ.eq("property_id", activeId);
  }
  const [cards, { data: jobs }, { data: invoices }] = await Promise.all([listPaymentMethods(), upcomingQ, invoiceQ]);

  const defaultCard = cards.find((c) => c.is_default) ?? cards[0];
  const upcoming = jobs ?? [];

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>
        <h1 style={{ fontSize: 26, marginBottom: 16 }}>Billing</h1>

        {/* payment method */}
        <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, marginBottom: 8 }}>Autopay method</h3>
          {defaultCard ? (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 14 }}>
                <b>{defaultCard.brand} •••• {defaultCard.last4}</b>
                <span className="mut"> · exp {String(defaultCard.exp_month).padStart(2, "0")}/{String(defaultCard.exp_year).slice(-2)} · charged on completion</span>
              </div>
              <Link className="ll-btn ghost sm" href="/profile">Manage</Link>
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span className="mut" style={{ fontSize: 14 }}>No card on file yet.</span>
              <Link className="ll-btn sm" href="/profile">Add a card</Link>
            </div>
          )}
        </div>

        {/* upcoming charges */}
        <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, marginBottom: 4 }}>Upcoming</h3>
          <p className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>
            Estimates for booked services. You&apos;re charged only after each is completed and photo-verified.
          </p>
          {upcoming.length === 0 ? (
            <p className="mut" style={{ fontSize: 14 }}>Nothing scheduled yet. <Link href="/book" style={{ color: "var(--teal-dark)", fontWeight: 700 }}>Book a service</Link>.</p>
          ) : (
            upcoming.map((j) => (
              <div key={j.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px dashed var(--line)", fontSize: 14 }}>
                <div>
                  <b>{j.service_name ?? "Service"}</b>
                  <div className="mut" style={{ fontSize: 12.5 }}>
                    {j.date ? new Date(j.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "date TBD"} · {j.status}
                  </div>
                </div>
                <b>{j.customer_price != null ? formatPrice(Number(j.customer_price)) : "—"}</b>
              </div>
            ))
          )}
        </div>

        {/* invoice history */}
        <div className="ll-card ll-card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>Invoice history</h3>
          {(!invoices || invoices.length === 0) ? (
            <p className="mut" style={{ fontSize: 14 }}>No invoices yet — they appear here after your first completed service.</p>
          ) : (
            invoices.map((inv) => (
              <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px dashed var(--line)", fontSize: 14 }}>
                <span className="mut">{inv.created_at ? new Date(inv.created_at).toLocaleDateString() : ""}</span>
                <span><span className="ll-pill slate" style={{ marginRight: 8 }}>{inv.status}</span><b>{inv.amount != null ? formatPrice(Number(inv.amount)) : "—"}</b></span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
