import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { getOpsParks } from "@/app/ops/parks-data";
import { getStuckHouseholds, getClaimTally } from "@/app/ops/claims-data";
import { OpsStuckClaims } from "@/components/OpsStuckClaims";
import { getSmsHealth, type SmsHealth } from "@/app/ops/sms-health";
import { OpsSmsHealth } from "@/components/OpsSmsHealth";
import { OpsShell } from "@/components/ops/OpsShell";
import { JobSearch } from "@/components/ops/JobSearch";
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
import { EscalationDecision } from "@/components/ops/EscalationDecision";
import { getMessageThreads } from "./messages-data";
import { getCrews, getActiveServiceNames } from "./crews-data";
import { getNeedsAttention, getPreferredJobIds, getPropertiesWithPreferred } from "./dispatch-data";
import { getProposedFees } from "./recovery-actions";
import { ProposedFees } from "@/components/ops/ProposedFees";
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

  // Parks are fetched SEPARATELY and defensively. The Promise.all above is
  // all-or-nothing: one loader throwing 500s the entire operations dashboard.
  // A brand-new module is the likeliest thing to throw, and losing the jobs
  // board over an empty parks table would be a self-inflicted outage.
  // WHO CANNOT GET IN. Read defensively, like parks below: a claim-log query
  // that throws must not take the whole console down with it.
  // WHETHER THE TEXTS ARE ARRIVING. Defensive like the rest: a Twilio hiccup
  // must not take the console down, and it must not read as healthy either —
  // a null window renders as "we couldn't check".
  // ALL FIVE AT ONCE, each still isolated.
  //
  // These were five sequential `await`s, each wrapped in its own try/catch —
  // and the sequencing was accidental, a by-product of writing the blocks one
  // after another rather than a decision. It cost five round trips in a row
  // before the console painted, and the FIRST of them, getSmsHealth, is a live
  // call out to Twilio's API. On LTE, in a truck, on the screen checked twenty
  // times a day.
  //
  // allSettled gives exactly what the try/catch blocks gave — one loader
  // throwing cannot touch the others — with none of the queue. Every fallback
  // and every log line below is the one that sat with its own await.
  //
  // CAUGHT SEPARATELY, because the fallbacks are not equally harmless. `stuck`
  // falls back to an empty list; `tally` falls back to `empty: true`, which the
  // card renders as "nobody has started onboarding a park yet". Sharing one
  // catch meant a failed stuck-households read reset a tally that had already
  // come back fine, inventing that sentence out of the other read's failure.
  // Settling them separately keeps that apart by construction.
  const [smsRes, stuckRes, tallyRes, parksRes, feesRes] = await Promise.allSettled([
    getSmsHealth(),
    getStuckHouseholds(),
    getClaimTally(),
    getOpsParks(),
    getProposedFees(),
  ]);

  const why = (r: PromiseRejectedResult) =>
    r.reason instanceof Error ? r.reason.message : r.reason;

  // WHETHER THE TEXTS ARE ARRIVING. A Twilio hiccup must not take the console
  // down, and it must not read as healthy either — a null window renders as
  // "we couldn't check".
  let smsHealth: SmsHealth = {
    configured: false, window: null, reasons: [], oldest: null, newest: null,
  };
  if (smsRes.status === "fulfilled") smsHealth = smsRes.value;
  else console.error("[ops] sms health failed", why(smsRes));

  // WHO CANNOT GET IN.
  let stuck: Awaited<ReturnType<typeof getStuckHouseholds>> = [];
  if (stuckRes.status === "fulfilled") stuck = stuckRes.value;
  else console.error("[ops] stuck households unavailable", why(stuckRes));

  let tally = {
    invitesSent: 0, slipsPrinted: 0, claimed: 0,
    refused: 0, refusedUnattributed: 0, declined: 0, empty: true,
  };
  if (tallyRes.status === "fulfilled") tally = tallyRes.value;
  else console.error("[ops] claim tally unavailable", why(tallyRes));

  // Parks are read defensively for the same reason as the rest: a brand-new
  // module is the likeliest thing to throw, and losing the jobs board over an
  // empty parks table would be a self-inflicted outage.
  let parks: Awaited<ReturnType<typeof getOpsParks>> = [];
  if (parksRes.status === "fulfilled") parks = parksRes.value;
  else console.error("ops: parks board unavailable", why(parksRes));

  // Newest loader on the page, so the likeliest to throw — and a fee decision
  // nobody can see is a much smaller problem than a jobs board nobody can.
  let proposedFees: Awaited<ReturnType<typeof getProposedFees>> = [];
  if (feesRes.status === "fulfilled") proposedFees = feesRes.value;
  else console.error("ops: proposed fees unavailable", why(feesRes));

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
              {lakes.filter((l) => !l.is_fixture).map((l) => l.name.replace(/ Lake$/, "")).join(" · ") || "No lakes yet"}
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

        <JobSearch />

        <OpsSmsHealth health={smsHealth} />

        <OpsStuckClaims stuck={stuck} tally={tally} />

        {escalations.length > 0 && (
          <div className="ll-card ll-card-pad" style={{ marginTop: 18, borderLeft: "4px solid var(--gold)" }}>
            <span className="ll-pill gold">Make-It-Right · waiting on you</span>
            <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>
              {escalations.length === 1 ? "1 dispute needs a human call" : `${escalations.length} disputes need a human call`}
            </h2>
            <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
              The machine handled everything it could — these crossed the auto-refund line. Crew pay is frozen on each until you decide.
            </p>
            <div style={{ display: "grid", gap: 10 }}>
              {escalations.map((e) => (
                <div key={e.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--sand-light)", borderRadius: 12 }}>
                  <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{e.service} · {e.where} · {money.format(e.customerPrice)}</div>
                    {e.note && <div className="mut" style={{ fontSize: 12.5 }}>Customer: &ldquo;{e.note}&rdquo;</div>}
                    {e.why && <div className="mut" style={{ fontSize: 12 }}>{e.why} · opened {e.openedAt}</div>}
                  </div>
                  <EscalationDecision disputeId={e.id} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* FEE DECISIONS WAITING ON A PERSON. Sits beside the Make-It-Right
            escalations because it is the same kind of thing: the machine did
            everything it could and stopped at the point where money moves. */}
        {proposedFees.length > 0 && (
          <div className="ll-card ll-card-pad" style={{ marginTop: 18, borderLeft: "4px solid var(--warn)" }}>
            {/* THE COUNT SAID THERE WAS WORK WAITING WHEN THERE WASN'T.
                getProposedFees selects fee_proposed, fee_waived AND
                fee_charging with no date bound, and `fee_waived` is terminal —
                nothing in the tree ever moves a row out of it. The card only
                renders buttons for `fee > 0 && state === "fee_proposed"`, so
                the heading could read "5 visit fees to decide" with nothing
                decidable, permanently, and the number never went down.
                The blurb was wrong twice more: waived rows include stand-downs
                the nightly auto-waived because OUR profile was wrong, where
                "nobody was home" is false; and "Nothing is charged until you
                say so" sat above fee_charging cards whose own text says a
                charge was started and may have gone through. */}
            {(() => {
              const decidable = proposedFees.filter((f) => f.fee > 0 && f.state === "fee_proposed");
              const settled = proposedFees.length - decidable.length;
              return (
                <>
                  <span className={`ll-pill ${decidable.length > 0 ? "warn" : "slate"}`}>
                    {decidable.length > 0 ? "Missed visits · waiting on you" : "Missed visits"}
                  </span>
                  <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>
                    {decidable.length === 0
                      ? "Nothing to decide right now"
                      : decidable.length === 1
                        ? "1 visit fee to decide"
                        : `${decidable.length} visit fees to decide`}
                    {settled > 0 && (
                      <span className="mut" style={{ fontWeight: 400, fontSize: 14 }}>
                        {" "}· {settled} already settled below
                      </span>
                    )}
                  </h2>
                </>
              );
            })()}
            <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
              Where nobody was home and the customer didn&apos;t rebook, nothing is
              charged until you say so. Rows already waived or charging are listed
              too, so you can see what was decided.
            </p>
            <ProposedFees rows={proposedFees} />
          </div>
        )}

        <OpsShell marginHealth={marginHealth} storageLedger={storageLedger} payoutQueue={payoutQueue} jobs={jobs} vendors={vendors} margin={margin} lakes={lakes} routes={routes} routeDate={tomorrow} threads={threads} crews={crews} crewServiceNames={crewServiceNames} needsAttention={needsAttention} preferredJobIds={preferredJobIds} preferredProps={preferredProps} settings={{ marginFloorPct: Math.round(s.marginFloor * 100), surgeCapPct: Math.round(s.surgeCapPct * 100) }} calendarYear={calendarYear} calendarRows={calendarRows}
          parks={parks} />
      </div>
    </>
  );
}
