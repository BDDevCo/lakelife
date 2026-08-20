import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { assertOps, getActiveVendors } from "@/app/ops/data";
import { getOpsJobFile } from "@/app/ops/job-detail-data";
import { EscalationDecision } from "@/components/ops/EscalationDecision";
import { JobPhotoGallery } from "@/components/JobPhotoGallery";
import { JobActions, JobThread } from "@/components/ops/JobFile";

/**
 * THE OPS JOB FILE — one job, everything about it, plus the levers.
 *
 * Why it's its own route and not another tab inside OpsShell: /ops already
 * loads ~15 datasets for every view, and OpsShell is a single client component
 * with useState tabs (no routing). A per-job fan-out belongs to one job, so it
 * gets one assertOps-gated route that nobody pays for unless they open it.
 * The trade-off is that it renders OUTSIDE the tab shell — hence the explicit
 * "back to ops" link at the top.
 *
 * force-dynamic is not optional: the photo URLs are signed bearer tokens with
 * a one-hour life, and a cached page would serve dead images (or worse, serve
 * a live one to whoever the cache is shared with).
 */
export const dynamic = "force-dynamic";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const STATUS_TONE: Record<string, string> = {
  requested: "warn",
  scheduled: "teal",
  in_progress: "teal",
  complete: "ok",
  paid: "slate",
  cancelled: "slate",
};
const STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  scheduled: "Scheduled",
  in_progress: "In progress",
  complete: "Complete",
  paid: "Paid",
  cancelled: "Cancelled",
};

const SLOT_LABEL: Record<string, string> = { "8a": "8:00 am", "10a": "10:00 am", "1p": "1:00 pm", "3p": "3:00 pm" };

/**
 * Every kind of money that reaches a crew, named.
 *
 * A map rather than a ternary precisely because the ternary was the bug: a
 * two-way `earning : "Clawback adjustment"` silently absorbed two new kinds as
 * they were added (`trip` in 0090, `tip` in 0091) and described both as
 * clawbacks. A lookup with a fallback to the raw kind means the next one added
 * shows up as an unfamiliar word rather than as a confident wrong answer.
 */
const PAYOUT_KIND_LABEL: Record<string, string> = {
  earning: "Crew earning",
  adjustment: "Clawback adjustment",
  trip: "Trip fee — the crew drove out",
  tip: "Tip, passed on in full",
};

function prettyDay(d: string | null): string {
  if (!d) return "no date yet";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" });
}
function prettyStamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

/** Plain English for a payout row — a HELD row must never read as normal. */
function payoutStatusLine(status: string): string {
  switch (status) {
    case "held": return "on hold — Make-It-Right in progress";
    case "released": return "released — nets into the next payout batch";
    case "clawed": return "clawed back to zero — nothing left on this row";
    case "paid": return "paid out";
    // "WAITING ON THE PHOTO GATE" DESCRIBES A STATE THAT CANNOT COEXIST WITH
    // THIS ROW EXISTING. The sole writer of 'pending' is settleJob —
    // `openDispute ? "held" : job.vendor_cost != null ? "released" : "pending"`
    // — so pending means we have no vendor_cost and don't know what to pay.
    // And settleJob only runs on a job already complete/paid, which completeJob
    // refuses to set until photoCount >= minPhotos. So a payout row existing at
    // all proves the gate passed; the same page prints "gate clear" beside it.
    // Ops went chasing photos already on file instead of setting the missing
    // crew cost, and the payout kept missing every month-end batch.
    case "pending": return "pending — no crew cost recorded on this job yet, so there's nothing to pay out";
    default: return status;
  }
}

const DISPUTE_LABEL: Record<string, string> = {
  crew_review: "With the crew",
  fixing: "Return visit booked",
  verifying: "With the customer",
  talk: "In conversation",
  escalated: "Escalated — waiting on you",
  resolved_fixed: "Resolved — return visit accepted",
  resolved_verified: "Resolved — customer accepted",
  resolved_refunded: "Resolved — refunded",
  resolved_closed: "Closed",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 24, paddingBottom: 60 }}>{children}</div>
    </>
  );
}

function Row({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", padding: "5px 0" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: strong ? 800 : 500 }}>{label}</div>
        {sub && <div className="mut" style={{ fontSize: 12 }}>{sub}</div>}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: strong ? 800 : 700, whiteSpace: "nowrap" }}>{value}</div>
    </div>
  );
}

function SectionHead({ pill, title, note }: { pill: string; title: string; note?: string }) {
  return (
    <>
      <span className="ll-pill teal">{pill}</span>
      <h2 style={{ fontSize: 18, margin: "10px 0 2px" }}>{title}</h2>
      {note && <p className="mut" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.5 }}>{note}</p>}
    </>
  );
}

export default async function OpsJobPage(ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  if (!hasSupabaseEnv()) {
    return <Shell><div style={{ paddingTop: 24 }}>Add your Supabase keys first.</div></Shell>;
  }

  // Same gate, same words as /ops — a non-ops account never learns whether
  // this job id exists.
  const ops = await assertOps();
  if (!ops) {
    return (
      <Shell>
        <div style={{ maxWidth: 480, margin: "24px auto 0" }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Operations only</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>This is the ops console</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              Your account isn&apos;t an operations account. If you think that&apos;s wrong, contact your admin.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </Shell>
    );
  }

  const [file, vendors] = await Promise.all([getOpsJobFile(id), getActiveVendors()]);

  if (!file) {
    return (
      <Shell>
        <Link className="mut" href="/ops" style={{ fontSize: 13, textDecoration: "none" }}>← Back to ops</Link>
        <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
          <h2 style={{ fontSize: 20 }}>No job with that id</h2>
          <p className="mut" style={{ fontSize: 14 }}>
            It may have been deleted, or the link is wrong. Try searching for it from the ops console.
          </p>
        </div>
      </Shell>
    );
  }

  const h = file.header;
  const t = file.totals;
  const where = h.nickname || h.address || "Property on file";
  const invoiceStatus = file.invoices[0]?.status ?? null;
  const openDispute = file.disputes.find((d) => !d.status.startsWith("resolved_")) ?? null;
  const latestDispute = openDispute ?? file.disputes[0] ?? null;
  const capturedAt = file.invoices
    .flatMap((i) => i.payments)
    .filter((p) => p.status === "captured")
    .map((p) => p.createdAt)
    .sort()[0] ?? null;
  const earning = file.payouts.find((p) => p.kind === "earning") ?? null;

  const timeline: Array<{ label: string; when: string | null; note?: string }> = [
    { label: "Booked", when: h.createdAt, note: h.isRush ? "same-day rush request" : undefined },
    {
      label: h.vendorId ? "Scheduled" : "Waiting on a crew",
      when: null,
      note: h.date ? `${prettyDay(h.date)}${h.slot ? ` · ${SLOT_LABEL[h.slot] ?? h.slot}` : ""}${h.crewCompany ? ` · ${h.crewCompany}` : ""}` : "no date on the books yet",
    },
    { label: "Crew started", when: h.startedAt },
    { label: "Crew finished", when: h.completedAt, note: `${file.photoCount} photo${file.photoCount === 1 ? "" : "s"} on file${h.minPhotos > 0 ? ` · ${h.minPhotos} required` : ""}` },
    { label: "Invoiced", when: file.invoices[0]?.createdAt ?? null, note: file.invoices[0] ? `${money.format(file.invoices[0].amount)} · ${file.invoices[0].status}` : undefined },
    { label: "Card charged", when: capturedAt, note: capturedAt ? money.format(t.captured) : undefined },
    { label: "Crew pay", when: earning?.createdAt ?? null, note: earning ? `${money.format(earning.amount)} · ${payoutStatusLine(earning.status)}` : undefined },
  ];

  return (
    <Shell>
      <Link className="mut" href="/ops" style={{ fontSize: 13, textDecoration: "none" }}>← Back to ops</Link>

      {/* ---- HEADER ---- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span className={`ll-pill ${STATUS_TONE[h.status] ?? "slate"}`}>{STATUS_LABEL[h.status] ?? h.status}</span>
              {h.isRush && <span className="ll-pill warn">Same-day rush</span>}
              {h.gapClaim && <span className="ll-pill teal">Gap fill-in</span>}
              {h.correctionOf && <span className="ll-pill gold">Make-It-Right return visit</span>}
              {!h.priceFinalized && <span className="ll-pill slate">Price not final</span>}
              {file.flags.some((f) => f.status === "pending") && <span className="ll-pill warn">Crew correction pending</span>}
            </div>
            <h1 style={{ fontSize: 26, margin: "10px 0 2px" }}>{h.serviceName ?? "Service"}</h1>
            <p className="mut" style={{ fontSize: 14 }}>
              {prettyDay(h.date)}{h.slot ? ` · ${SLOT_LABEL[h.slot] ?? h.slot}` : ""}{h.frequency ? ` · ${h.frequency}` : ""}
            </p>
          </div>
          <div style={{ textAlign: "right", fontSize: 13.5 }}>
            <div>Customer <b>{h.customerPrice == null ? "—" : money.format(h.customerPrice)}</b></div>
            <div className="mut">Crew {h.vendorCost == null ? "—" : money.format(h.vendorCost)}</div>
            <div style={{ color: "var(--teal-dark)", fontWeight: 800 }}>
              Margin {h.margin == null ? "—" : money.format(h.margin)}{h.marginPct != null ? ` · ${h.marginPct}%` : ""}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 12, marginTop: 16, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <div>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em" }}>Property</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{where}</div>
            {h.nickname && h.address && <div className="mut" style={{ fontSize: 12.5 }}>{h.address}</div>}
            <div className="mut" style={{ fontSize: 12.5 }}>{h.lakeName ?? "No lake on file"}</div>
          </div>
          <div>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em" }}>Customer</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{h.customerName ?? "Homeowner"}</div>
            {h.customerPhone && <div className="mut" style={{ fontSize: 12.5 }}>{h.customerPhone}</div>}
            {h.customerEmail && <div className="mut" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{h.customerEmail}</div>}
          </div>
          <div>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em" }}>Crew</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{h.crewCompany ?? "Unassigned"}</div>
            {h.minPhotos > 0 && (
              <div className="mut" style={{ fontSize: 12.5 }}>
                📷 {file.photoCount}/{h.minPhotos} photos{file.photoCount >= h.minPhotos ? " — gate clear" : " — gate not met"}
              </div>
            )}
            {h.correctionOf && (
              <Link href={`/ops/jobs/${h.correctionOf}`} style={{ fontSize: 12.5, color: "var(--teal-dark)", fontWeight: 700 }}>
                See the original job →
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ---- OPS LEVERS ---- */}
      <JobActions
        jobId={h.id}
        status={h.status}
        serviceName={h.serviceName}
        address={h.address}
        customerName={h.customerName}
        crewCompany={h.crewCompany}
        vendorId={h.vendorId}
        vendorCost={h.vendorCost}
        customerPrice={h.customerPrice}
        date={h.date}
        slot={h.slot}
        invoiceStatus={invoiceStatus}
        inGroup={file.group != null}
        vendors={vendors}
      />

      {/* ---- MAKE-IT-RIGHT ---- */}
      {latestDispute && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 14, borderLeft: "4px solid var(--gold)" }}>
          <SectionHead
            pill="Make-It-Right"
            title={DISPUTE_LABEL[latestDispute.status] ?? latestDispute.status}
            note={`Opened ${prettyStamp(latestDispute.openedAt)}${latestDispute.respondBy ? ` · crew had until ${prettyStamp(latestDispute.respondBy)}` : ""}${latestDispute.resolvedAt ? ` · resolved ${prettyStamp(latestDispute.resolvedAt)}` : ""}`}
          />
          {latestDispute.customerNote && (
            <p style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 8 }}>
              Customer: &ldquo;{latestDispute.customerNote}&rdquo;
            </p>
          )}
          {latestDispute.resolution && (
            <p className="mut" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 8 }}>{latestDispute.resolution}</p>
          )}
          {latestDispute.correction && (
            <p style={{ fontSize: 13, marginBottom: 8 }}>
              Free return visit:{" "}
              <Link href={`/ops/jobs/${latestDispute.correction.id}`} style={{ color: "var(--teal-dark)", fontWeight: 700 }}>
                {prettyDay(latestDispute.correction.date)}
              </Link>
              {` · ${latestDispute.correction.status}${latestDispute.correction.crewCompany ? ` · ${latestDispute.correction.crewCompany}` : ""}`}
            </p>
          )}
          {latestDispute.status === "escalated" && (
            <>
              <p className="mut" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 8 }}>
                The machine handled everything it could — this crossed the auto-refund line. The crew&apos;s pay
                for this job is frozen until you decide.
              </p>
              <EscalationDecision disputeId={latestDispute.id} />
            </>
          )}
          {file.disputes.length > 1 && (
            <p className="mut" style={{ fontSize: 12, marginTop: 10 }}>
              {file.disputes.length} disputes have been opened on this job — the most recent is shown.
            </p>
          )}
        </div>
      )}

      {/* ---- THE MONEY FILE ---- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <SectionHead
          pill="The money"
          title="Every dollar that moved on this job"
          note="Customer cash in, crew pay out, and what LakeLife keeps. Ops-only — the customer sees one all-in price and the crew only ever sees their own cost."
        />

        {file.items.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>
              Legs on this visit
            </div>
            {file.items.map((i) => (
              <Row
                key={i.id}
                label={i.serviceName ?? "Line item"}
                sub={`crew ${money.format(i.vendorCost)}`}
                value={money.format(i.customerPrice)}
              />
            ))}
          </div>
        )}

        <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>
          Bill &amp; cash
        </div>
        {file.invoices.length === 0 ? (
          <p className="mut" style={{ fontSize: 13 }}>No invoice yet — nothing has been billed on this job.</p>
        ) : (
          file.invoices.map((inv) => (
            <div key={inv.id} style={{ marginBottom: 8 }}>
              <Row label={`Invoice ${shortId(inv.id)}`} sub={`${inv.status} · raised ${prettyStamp(inv.createdAt)}`} value={money.format(inv.amount)} />
              {inv.payments.length === 0 ? (
                <p className="mut" style={{ fontSize: 12.5, paddingLeft: 12 }}>No charge attempted yet.</p>
              ) : (
                inv.payments.map((p) => (
                  <div key={p.id} style={{ paddingLeft: 12 }}>
                    <Row
                      label={p.status === "captured" ? "Card charged" : `Charge ${p.status}`}
                      sub={`${prettyStamp(p.createdAt)}${p.processorRef ? ` · ref ${p.processorRef}` : ""}`}
                      value={money.format(p.amount)}
                    />
                  </div>
                ))
              )}
            </div>
          ))
        )}

        {file.credits.length > 0 && (
          <>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", margin: "12px 0 4px" }}>
              Service credits
            </div>
            {file.credits.map((c) => (
              <Row
                key={c.id}
                label={c.amount < 0 ? "Credit applied to this bill" : "Credit granted"}
                sub={`${c.userName ?? "customer"}${c.reason ? ` · ${c.reason}` : ""} · ${prettyStamp(c.createdAt)}`}
                value={money.format(c.amount)}
              />
            ))}
          </>
        )}

        {file.refunds.length > 0 && (
          <>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", margin: "12px 0 4px" }}>
              Refunds
            </div>
            {file.refunds.map((r) => (
              <Row
                key={r.id}
                label={`Refunded to the customer`}
                sub={`${r.reason} · ${r.createdByName ?? "automatic (Make-It-Right policy)"} · ${prettyStamp(r.createdAt)}${r.crewClawback > 0 ? ` · crew clawback ${money.format(r.crewClawback)}` : " · no crew clawback (goodwill)"}${r.processorRef ? ` · ref ${r.processorRef}` : ""}`}
                value={`−${money.format(r.amount)}`}
              />
            ))}
          </>
        )}

        <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", margin: "12px 0 4px" }}>
          Crew pay
        </div>
        {file.payouts.length === 0 ? (
          <p className="mut" style={{ fontSize: 13 }}>No payout row yet — crew pay is written when the job completes its photo gate.</p>
        ) : (
          file.payouts.map((p) => (
            <div
              key={p.id}
              style={p.status === "held" ? { background: "var(--sun-soft)", borderRadius: 8, padding: "2px 8px", margin: "2px -8px" } : undefined}
            >
              <Row
                /* FOUR KINDS, NOT TWO. This was a two-way ternary over a
                   four-value column: `earning` or else "Clawback adjustment".
                   0090 added `trip` and 0091 added `tip`, so a $35 trip fee
                   and a $50 tip both rendered as a POSITIVE-VALUED clawback —
                   ops reading "we clawed back $50" on a job where we had in
                   fact paid the crew $50. An omission is a gap; this was the
                   screen stating the opposite of what happened, on the one
                   screen that exists to settle arguments. */
                label={PAYOUT_KIND_LABEL[p.kind] ?? p.kind}
                sub={`${payoutStatusLine(p.status)}${p.originalAmount != null && p.originalAmount !== p.amount ? ` · originally ${money.format(p.originalAmount)}` : ""}${p.batchId ? ` · batch ${shortId(p.batchId)}${p.batchStatus ? ` (${p.batchStatus})` : ""}` : " · not batched yet"} · ${prettyStamp(p.createdAt)}`}
                value={money.format(p.amount)}
              />
            </div>
          ))
        )}

        {file.referrals.length > 0 && (
          <>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", margin: "12px 0 4px" }}>
              Referral money this job generated
            </div>
            {file.referrals.map((r) => (
              <Row
                key={r.id}
                label={r.kind.replace(/_/g, " ")}
                sub={`${r.beneficiaryName ?? "beneficiary"} · ${r.status}${r.maturedAt ? ` · matured ${prettyStamp(r.maturedAt)}` : ""} · accrued ${prettyStamp(r.accruedAt)}`}
                value={money.format(r.amount)}
              />
            ))}
          </>
        )}

        <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 8 }}>
          <Row label="Customer cash, net of refunds" value={money.format(t.netCustomerCash)} strong />
          <Row label="Crew take-home on this job" sub={t.crewAdjustments < 0 ? `earning ${money.format(t.crewNow)} less ${money.format(Math.abs(t.crewAdjustments))} in clawbacks` : undefined} value={money.format(t.crewNet)} strong />
          {t.referralAccrued > 0 && <Row label="Referral money owed out" value={money.format(t.referralAccrued)} strong />}
          <Row label="LakeLife keeps" value={money.format(t.lakelifeNet)} strong />
          {t.tipCharged > 0 && (
            /* OUTSIDE the totals on purpose, and said so on the screen. The
               customer's card moved by this much, so ops must be able to see
               it when they ring up — but it is not billed, not captured
               revenue and not ours, so it must never be summed into the lines
               above. A tip that appeared inside "LakeLife keeps" would be a
               lie on the one screen that exists to settle arguments. */
            <Row
              label="Tip to the crew"
              sub="charged to the customer, passed on in full — not counted in any line above"
              value={money.format(t.tipCharged)}
            />
          )}
        </div>
      </div>

      {/* ---- PHOTOS ---- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <SectionHead
          pill="Proof of work"
          title={`${file.photoCount} photo${file.photoCount === 1 ? "" : "s"}${h.minPhotos > 0 ? ` · ${h.minPhotos} required` : ""}`}
          note="The crew's own evidence, straight from the job. These are what settle a dispute."
        />
        <JobPhotoGallery
          photos={file.photos}
          emptyNote="No photos on this job yet. A job can't reach complete — and the crew can't be paid — until the required count is uploaded."
        />
      </div>

      {/* ---- COMMENTS ---- */}
      <JobThread
        jobId={h.id}
        propertyId={h.propertyId}
        ownerName={h.customerName}
        messages={file.messages}
        serviceName={h.serviceName}
      />

      {/* ---- PACKAGE GROUP ---- */}
      {file.group && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
          <SectionHead
            pill="Package"
            title={file.group.packageName ?? "Storage package"}
            note={`This visit is one leg of a season envelope (${file.group.status}). Every leg goes to the same crew — custody doesn't get re-dispatched.`}
          />
          {file.group.legs.map((l) => (
            <div key={l.id} style={{ padding: "4px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: l.isThisJob ? 800 : 500 }}>
                    {l.isThisJob ? "▸ " : ""}{l.serviceName ?? "Leg"}
                    {l.phase ? ` · ${l.phase}` : ""}
                  </div>
                  <div className="mut" style={{ fontSize: 12 }}>
                    {prettyDay(l.date)} · {STATUS_LABEL[l.status] ?? l.status}
                    {l.vendorCost != null ? ` · crew ${money.format(l.vendorCost)}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{l.customerPrice == null ? "—" : money.format(l.customerPrice)}</span>
                  {!l.isThisJob && (
                    <Link href={`/ops/jobs/${l.id}`} style={{ fontSize: 12.5, color: "var(--teal-dark)", fontWeight: 700 }}>open</Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- QUALITY + CORRECTIONS ---- */}
      {(file.confirmation?.verdict || file.flags.length > 0) && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
          <SectionHead pill="Quality" title="What came back from the field" />
          {file.confirmation?.verdict && (
            <p style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              Customer verdict: <b>{file.confirmation.verdict === "good" ? "👍 happy" : "👎 flagged an issue"}</b>
              {file.confirmation.respondedAt ? ` · ${prettyStamp(file.confirmation.respondedAt)}` : ""}
              {file.confirmation.note ? ` — “${file.confirmation.note}”` : ""}
            </p>
          )}
          {file.flags.map((f) => (
            <p key={f.id} className="mut" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 6 }}>
              Crew correction ({f.type ?? "profile"}) · {f.status} · {prettyStamp(f.createdAt)}
              {f.note ? ` — ${f.note}` : ""}
              {f.status === "pending" ? " · nothing changes and nothing bills until the homeowner approves." : ""}
            </p>
          ))}
        </div>
      )}

      {/* ---- TIMELINE ---- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <SectionHead pill="Timeline" title="How this job got here" />
        <div style={{ display: "grid", gap: 6 }}>
          {timeline.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, minWidth: 130 }}>{e.label}</span>
              <span className="mut" style={{ fontSize: 12.5 }}>
                {[e.when ? prettyStamp(e.when) : null, e.note].filter(Boolean).join(" · ") || "hasn't happened yet"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <Link className="ll-btn ghost" href="/ops">← Back to ops</Link>
      </div>
    </Shell>
  );
}
