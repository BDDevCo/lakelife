import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { formatPrice } from "@/lib/pricing";
import { getActivePropertyId, getMyCalendarUrl } from "@/app/profile/data";
import { CancelRequestButton } from "@/components/CancelRequestButton";
import { ScarcityOffers } from "@/components/ScarcityOffers";
import { UpcomingCalendar } from "@/components/UpcomingCalendar";
import { CalendarSubscribe } from "@/components/CalendarSubscribe";
import { getScarcityOffers } from "@/app/requests/offer-data";
import { getPackageBreakdowns, getStorageStatusCards, type PackageBreakdown, type StorageStatusCard } from "@/app/requests/package-data";
import { todayLakeDate } from "@/lib/booking";
import { createServiceClient } from "@/lib/supabase/server";

const STATUS_PILL: Record<string, string> = {
  requested: "warn", scheduled: "teal", in_progress: "teal", complete: "ok", paid: "slate", cancelled: "slate",
};
const STATUS_LABEL: Record<string, string> = {
  // A `requested` job is by definition still unassigned — say so honestly.
  requested: "Finding a crew", scheduled: "Scheduled", in_progress: "In progress", complete: "Complete", paid: "Paid", cancelled: "Cancelled",
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

  const stuckIds = rows.filter((r) => r.status === "requested").map((r) => r.id as string);
  const offers = stuckIds.length > 0 ? await getScarcityOffers(stuckIds) : [];

  // Package visits (storage/winterize) show what's inside — CUSTOMER prices
  // only, shaped server-side from job_items (see package-data.ts).
  const packageBreakdowns = await getPackageBreakdowns(rows.map((r) => r.id as string));

  // "Your boat is tucked in" — active season envelopes with a boat currently
  // in_storage. job_groups is owner-readable directly at RLS (job_groups_read
  // policy), so this fetch is real RLS, not a manual ownership check; only
  // the resulting ids go to the service-role shaping in package-data.ts
  // (storage_stays itself is OPS/vendor-only at RLS).
  let groupQuery = supabase.from("job_groups").select("id").eq("status", "active");
  if (activeId) groupQuery = groupQuery.eq("property_id", activeId);
  const { data: groupRows } = await groupQuery;
  const storageCards = await getStorageStatusCards((groupRows ?? []).map((g) => g.id as string));

  // Month-at-a-glance: confirmed visits only (scheduled / in progress), today
  // or later in lake time.
  const today = todayLakeDate();
  const events = rows
    .filter((r) => r.date && (r.status === "scheduled" || r.status === "in_progress") && (r.date as string) >= today)
    .map((r) => ({
      id: r.id as string,
      date: r.date as string,
      serviceName: (r.service_name as string) ?? "Service",
      status: r.status as string,
    }));

  // Personal ICS feed (null until the migration adds tokens → hide the card).
  const calendarUrl = await getMyCalendarUrl();

  // "Your crew ⭐" — the preferred-crew lock, visible so the owner KNOWS their
  // crew is theirs (never silently swapped). Ownership is verified before the
  // service-role read; only the company name is exposed — never rates/margin.
  let preferredCompany: string | null = null;
  if (activeId) {
    const admin = createServiceClient();
    const { data: prop } = await admin
      .from("properties")
      .select("owner_id, preferred_vendor, vendors:preferred_vendor(company)")
      .eq("id", activeId)
      .maybeSingle();
    if (prop && prop.owner_id === user.id) {
      const v = Array.isArray(prop.vendors) ? prop.vendors[0] : prop.vendors;
      preferredCompany = (v as { company?: string } | null)?.company ?? null;
    }
  }

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24 }}>
        <h1 style={{ fontSize: 26, marginBottom: 6 }}>My requests</h1>
        {preferredCompany && (
          <p style={{ fontSize: 13.5, fontWeight: 700, color: "var(--teal-dark)", marginBottom: 16 }}>
            ⭐ Your crew: {preferredCompany} — always first on your jobs.
          </p>
        )}
        {!preferredCompany && <div style={{ marginBottom: 10 }} />}

        {offers.length > 0 && <ScarcityOffers offers={offers} />}

        {events.length > 0 && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
            <UpcomingCalendar events={events} />
          </div>
        )}

        {storageCards.length > 0 && <StorageStatusCards cards={storageCards} />}

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
                    const pkg = packageBreakdowns[r.id as string];
                    return (
                      <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                        <Td>{pkg ? <PackageServiceCell name={r.service_name ?? "Service"} breakdown={pkg} /> : <b>{r.service_name ?? "Service"}</b>}</Td>
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

        {calendarUrl && (
          <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>📅 Live in your calendar</div>
            <p className="mut" style={{ fontSize: 13, marginBottom: 10 }}>
              Subscribe once and every LakeLife visit shows up automatically.
            </p>
            <CalendarSubscribe url={calendarUrl} />
          </div>
        )}
      </div>
    </>
  );
}

// Package visits (storage/winterize): a small "🧊 package" pill next to the
// service name, expandable to each fall leg + (when quoted) next spring's
// preview. CUSTOMER prices only — breakdown is shaped server-side in
// package-data.ts, which never selects job_items.vendor_cost.
function PackageServiceCell({ name, breakdown }: { name: string; breakdown: PackageBreakdown }) {
  return (
    <details>
      <summary style={{ cursor: "pointer", listStyle: "none" }}>
        <b>{name}</b> <span className="ll-pill teal" style={{ marginLeft: 6 }}>🧊 package</span>
      </summary>
      <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
        {breakdown.legs.map((leg, i) => (
          <div key={i}>{leg.name} — {formatPrice(leg.price)}</div>
        ))}
        {breakdown.spring && (
          <div className="mut" style={{ marginTop: 4 }}>
            Next spring: {breakdown.spring.names.join(", ")} — ~{formatPrice(breakdown.spring.quote)} quoted now, billed at splash.
          </div>
        )}
      </div>
    </details>
  );
}

// "Your boat is tucked in" status card(s) — CUSTOMER-safe fields only
// (company name, dates, spring quote, per-diem meter). One card per active
// stay; multiple boats in storage stack as separate cards.
function shortDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StorageStatusCards({ cards }: { cards: StorageStatusCard[] }) {
  return (
    <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
      {cards.map((c) => (
        <div key={c.groupId} className="ll-card ll-card-pad">
          <div style={{ fontWeight: 800, fontSize: 16 }}>🛥️ Your boat is tucked in at {c.vendorCompany}</div>
          <p className="mut" style={{ fontSize: 13.5, margin: "4px 0 0" }}>
            In storage since {shortDate(c.intakeAt)} · season through {shortDate(c.seasonEnd)} · spring visit ~
            {formatPrice(c.springQuote)} — quoted at booking, billed at splash.
          </p>
          {c.meterDollars != null && (
            <span className="ll-pill gold" style={{ marginTop: 10, display: "inline-block" }}>
              ⏱ Storage meter: {formatPrice(c.meterDollars)} (${c.perdiemDaily}/day past season end) — pick your splash day.
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th style={{ padding: "11px 14px", fontSize: 12, color: "var(--sub)", textAlign: right ? "right" : "left" }}>{children}</th>;
}
function Td({ children, right, muted }: { children: React.ReactNode; right?: boolean; muted?: boolean }) {
  return <td style={{ padding: "11px 14px", textAlign: right ? "right" : "left", color: muted ? "var(--sub)" : "inherit" }}>{children}</td>;
}
