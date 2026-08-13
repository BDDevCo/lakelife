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
  const creditQ = supabase.from("user_credits").select("amount");

  // A TIP IS CHARGED BUT NEVER INVOICED (0097), so it cannot appear in the
  // list above — and a charge the customer cannot find is the worst kind.
  // `payments_owner_reads_own_tip` lets them read their own; the job ids come
  // from `owner_jobs` so the active-property filter still applies, since
  // `payments` has no property of its own.
  const tipQ = supabase.from("payments").select("id, amount, status, created_at, tip_job_id")
    .not("tip_job_id", "is", null)
    .eq("status", "captured")
    .order("created_at", { ascending: false });
  let tippedJobsQ = supabase.from("owner_jobs").select("id, service_name, property_id");
  if (activeId) tippedJobsQ = tippedJobsQ.eq("property_id", activeId);

  const [cards, { data: jobs }, { data: invoices }, { data: credits }, { data: tipRows }, { data: tipJobs }] =
    await Promise.all([listPaymentMethods(), upcomingQ, invoiceQ, creditQ, tipQ, tippedJobsQ]);

  const defaultCard = cards.find((c) => c.is_default) ?? cards[0];
  const upcoming = jobs ?? [];
  const creditBalance = (credits ?? []).reduce((sum, c) => sum + Number(c.amount ?? 0), 0);

  const jobName = new Map((tipJobs ?? []).map((j) => [j.id as string, (j.service_name as string) ?? "a visit"]));
  const tips = (tipRows ?? [])
    // Scoped to the property being viewed. A tip whose job is not in this
    // property's list belongs to another place they own, not to this bill.
    .filter((t) => jobName.has(t.tip_job_id as string))
    .map((t) => ({
      id: t.id as string,
      amount: Number(t.amount ?? 0),
      created_at: t.created_at as string,
      label: `Thank-you to the crew · ${jobName.get(t.tip_job_id as string)}`,
    }));

  const history: Array<{
    id: string; when: string; amount: number; pill: string; label?: string;
  }> = [
    ...(invoices ?? []).map((inv) => ({
      id: inv.id as string,
      when: (inv.created_at as string) ?? "",
      amount: Number(inv.amount ?? 0),
      // A refund is ops-only at RLS, so this surface never queries the refunds
      // ledger directly — it only ever reads invoice status. A FULL refund
      // flips status to 'refunded'; a partial leaves it 'paid' with no amount
      // shown here (v1 — see docs/refunds-design.md).
      pill: inv.status === "refunded" ? "↩ Refunded" : ((inv.status as string) ?? ""),
    })),
    ...tips.map((t) => ({
      id: t.id, when: t.created_at, amount: t.amount, pill: "tip", label: t.label,
    })),
  ].sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""));

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>
        <h1 style={{ fontSize: 26, marginBottom: 16 }}>Billing</h1>

        {/* referral credit balance */}
        {creditBalance > 0 && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 16, borderColor: "var(--teal)" }}>
            <span className="ll-pill ok">Referral credit</span>
            <div style={{ fontWeight: 700, fontSize: 18, margin: "8px 0 4px" }}>
              ${creditBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in service credits
            </div>
            <p className="mut" style={{ fontSize: 13.5, margin: 0 }}>
              Applies automatically to your next bill — earned by spreading the word. 🌊
            </p>
          </div>
        )}

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

        {/* billing history — invoices AND tips, because both were charged */}
        <div className="ll-card ll-card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>Billing history</h3>
          {history.length === 0 ? (
            <p className="mut" style={{ fontSize: 14 }}>Nothing charged yet — this fills in after your first completed service.</p>
          ) : (
            history.map((row) => (
              <div key={row.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "9px 0", borderBottom: "1px dashed var(--line)", fontSize: 14 }}>
                <span className="mut">
                  {row.when ? new Date(row.when).toLocaleDateString() : ""}
                  {row.label && (
                    <span style={{ display: "block", fontSize: 12.5 }}>{row.label}</span>
                  )}
                </span>
                <span style={{ whiteSpace: "nowrap" }}>
                  <span className={`ll-pill ${row.pill === "tip" ? "ok" : "slate"}`} style={{ marginRight: 8 }}>
                    {row.pill}
                  </span>
                  <b>{formatPrice(row.amount)}</b>
                </span>
              </div>
            ))
          )}
          {tips.length > 0 && (
            <p className="mut" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              Tips go to the crew in full — LakeLife takes no share of a thank-you.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
