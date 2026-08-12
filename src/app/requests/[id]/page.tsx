import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { formatPrice } from "@/lib/pricing";
import { JobPhotoGallery } from "@/components/JobPhotoGallery";
import { JobVerdictButtons, JobMessageComposer, DisputeAnswerButtons } from "@/components/JobDetailPanel";
import { CancelRequestButton } from "@/components/CancelRequestButton";
import { ScarcityOffers } from "@/components/ScarcityOffers";
import { loadCustomerJobDetail, type JobDetailView } from "@/app/requests/job-detail-data";

/**
 * THE CUSTOMER'S JOB FILE — /requests/[id].
 *
 * Clicking a job anywhere (calendar cell, upcoming row, requests table) opens
 * this. It is the first surface in the product's life where a homeowner can
 * actually SEE the photos of their own job — the completion SMS has been
 * promising "photos are in your portal" against a page that did not exist.
 *
 * force-dynamic is not optional: the photo URLs are signed bearer tokens with
 * a one-hour life, so a cached render would serve dead images (and cache a
 * credential). Everything shown is shaped by loadCustomerJobDetail, which runs
 * the ownership gate BEFORE any service-role read and never selects
 * vendor_cost, margin, crew rates, or a dispute's bearer tokens (rule 1).
 */

export const dynamic = "force-dynamic";

function SignInWall() {
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

export default async function JobDetailPage(ctx: { params: Promise<{ id: string }> }) {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <SignInWall />;

  const job = await loadCustomerJobDetail(id);
  if (!job) {
    // Someone else's job and a job that never existed give the SAME answer —
    // this page must not confirm a stranger's booking is real.
    return (
      <>
        <TopBar />
        <OwnerHeader />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Not found</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>We couldn&apos;t find that job</h3>
            <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
              It may have been cancelled, or it belongs to another account.
            </p>
            <Link className="ll-btn" href="/requests">Back to my requests</Link>
          </div>
        </div>
      </>
    );
  }

  const where = job.propertyNickname || job.propertyAddress || "your place";

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 760 }}>
        <Link href="/requests" className="mut" style={{ fontSize: 13.5, fontWeight: 700, textDecoration: "none" }}>
          ← My requests
        </Link>

        <HeaderCard job={job} where={where} />

        {job.offer && <ScarcityOffers offers={[job.offer]} />}

        {job.dispute && <MakeItRightCard job={job} />}

        {job.pendingConfirmationId && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 16, borderColor: "var(--teal)" }}>
            <JobVerdictButtons jobId={job.id} serviceName={job.serviceName} />
          </div>
        )}

        <PhotosCard job={job} />

        <MoneyCard job={job} />

        <CommentsCard job={job} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ header */

function HeaderCard({ job, where }: { job: JobDetailView; where: string }) {
  return (
    <div className="ll-card ll-card-pad" style={{ margin: "10px 0 16px" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className={`ll-pill ${job.statusPill}`}>{job.statusLabel}</span>
        {job.isCorrection && <span className="ll-pill teal">Make-it-right visit · no charge</span>}
        {job.money.legs.length > 0 && <span className="ll-pill teal">🧊 package</span>}
      </div>

      <h1 style={{ fontSize: 26, margin: "10px 0 4px" }}>{job.serviceName}</h1>
      <div style={{ fontSize: 15, fontWeight: 700 }}>
        {job.prettyDate ?? "Date to be confirmed"}
        {job.slot ? ` · ${job.slot}` : ""}
      </div>
      <p className="mut" style={{ fontSize: 13.5, margin: "4px 0 0" }}>
        {job.propertyNickname && job.propertyAddress ? `${job.propertyNickname} — ${job.propertyAddress}` : where}
      </p>

      {job.money.legs.length > 0 && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 13.5, marginBottom: 4 }}>What&apos;s in this visit</div>
          {job.money.legs.map((leg, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "2px 0" }}>
              <span>{leg.name}</span>
              <span className="mut">{formatPrice(leg.price)}</span>
            </div>
          ))}
          {job.money.spring && (
            <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
              {`Next spring: ${job.money.spring.names.join(", ")} — ~${formatPrice(job.money.spring.quote)} quoted now, billed at splash.`}
            </p>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13.5 }}>
          {job.crewCompany
            ? <>Your crew: <b>{job.crewCompany}</b></>
            : <span className="mut">We&apos;re lining up a crew — you&apos;ll see their name here the moment it&apos;s locked in.</span>}
        </div>
        {job.cancellable && <CancelRequestButton jobId={job.id} serviceName={job.serviceName} />}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- make-it-right */

function MakeItRightCard({ job }: { job: JobDetailView }) {
  const d = job.dispute!;
  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 16, borderColor: "var(--gold, #d9a441)" }}>
      <span className="ll-pill warn">{`Make it right · ${d.pill}`}</span>
      <p style={{ fontSize: 14.5, margin: "10px 0 0", lineHeight: 1.5 }}>{d.line}</p>
      {d.needsCustomer && <DisputeAnswerButtons jobId={job.id} />}
    </div>
  );
}

/* ------------------------------------------------------------------ photos */

function PhotosCard({ job }: { job: JobDetailView }) {
  const n = job.photos.length;
  const emptyNote =
    job.status === "cancelled"
      ? "No photos — this one was cancelled."
      : "No photos yet — they land here the moment your crew finishes.";

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 2px" }}>📸 Photos of the work</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        {n > 0
          ? `${n} photo${n === 1 ? "" : "s"} from your crew, taken on site. Tap any one to see it full size.`
          : "Every LakeLife job is photo-verified before your crew can mark it done — and before they get paid."}
      </p>

      <JobPhotoGallery photos={job.photos} emptyNote={emptyNote} />

      {job.siblings.map((s) => (
        <div key={s.jobId} style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <JobPhotoGallery
            photos={s.photos}
            caption={s.date ? `${s.serviceName} — ${shortDate(s.date)}` : s.serviceName}
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- money */

function invoiceCopy(job: JobDetailView): { pill: string; tone: string; note: string } {
  const s = job.money.invoiceStatus;
  if (s === "refunded") {
    return { pill: "↩ Refunded", tone: "slate", note: "We sent this one back to your card." };
  }
  if (s === "paid") {
    return {
      pill: "Paid",
      tone: "ok",
      note: job.money.paidAt
        ? `Charged to your card on file on ${new Date(job.money.paidAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}.`
        : "Charged to your card on file.",
    };
  }
  if (s === "due") {
    // The unconditional version of this told customers with NO card that we
    // would run it on their card on file — and those are exactly the ones the
    // settle silently did nothing for. Saying it's handled when it isn't is
    // how an unpaid job stays unpaid.
    return job.money.hasCardOnFile
      ? { pill: "Due", tone: "warn", note: "We'll run this on your card on file. Manage your card on the Billing page." }
      : {
          pill: "Needs a card",
          tone: "warn",
          note: "We don't have a card on file for you yet, so this hasn't been paid. Add one on the Billing page and we'll take care of it.",
        };
  }
  if (s === "draft") {
    return { pill: "Not billed yet", tone: "slate", note: "This invoice hasn't gone out yet." };
  }
  return {
    pill: "Nothing billed yet",
    tone: "slate",
    note: "You're charged only after the work is done and photo-verified — never before.",
  };
}

function MoneyCard({ job }: { job: JobDetailView }) {
  const inv = invoiceCopy(job);
  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 10px" }}>Your invoice</h2>

      {/* The headline must be what we actually BILLED, not what the job was
          quoted at. A late cancellation charges a fee while jobs.customer_price
          keeps the original quote — showing that quote beside a "Paid" pill
          told a cancelled customer they'd been charged the full price. */}
      {(() => {
        const billed = job.money.invoiceAmount;
        const quoted = job.money.customerPrice;
        const billedDiffers = billed != null && billed !== quoted;
        const headline = billedDiffers ? billed : quoted;
        return (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 26, fontWeight: 800 }}>{formatPrice(headline)}</div>
                <p className="mut" style={{ fontSize: 12.5, margin: "2px 0 0" }}>
                  {billedDiffers
                    ? `This is what we billed. The ${formatPrice(quoted)} quote was for the visit itself, which didn't happen.`
                    : "One all-in price — crew, materials, and LakeLife. No add-ons, no surprises."}
                </p>
              </div>
              <span className={`ll-pill ${inv.tone}`}>{inv.pill}</span>
            </div>

            <p className="mut" style={{ fontSize: 13.5, margin: "10px 0 0" }}>{inv.note}</p>
          </>
        );
      })()}

      {job.money.refunds.length > 0 && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 13.5, marginBottom: 4 }}>
            {`↩ Refunded to you: $${job.money.refundedTotal.toFixed(2)}`}
          </div>
          {job.money.refunds.map((r, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0" }}>
              <span className="mut">{new Date(r.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
              <span>{`$${r.amount.toFixed(2)}`}</span>
            </div>
          ))}
          <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
            Refunds land back on the card you were charged on, usually within a few business days.
          </p>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Link className="ll-btn ghost sm" href="/billing">See all billing</Link>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- comments */

function CommentsCard({ job }: { job: JobDetailView }) {
  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 2px" }}>Comments</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        About this job specifically. Dispatch sees it on your property board and usually replies same day. 🌊
      </p>

      {job.messages.length === 0 ? (
        <p className="mut" style={{ fontSize: 14, textAlign: "center", padding: "12px 0" }}>
          Nothing here yet — leave a note about this job and we&apos;ll pick it up.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {job.messages.map((m) => {
            const mine = m.from === "owner";
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "80%" }}>
                  <div
                    style={{
                      padding: "10px 13px", borderRadius: 12, fontSize: 14, lineHeight: 1.45,
                      whiteSpace: "pre-wrap", wordBreak: "break-word",
                      background: mine ? "var(--sun-soft)" : "#eef6f7",
                      border: `1px solid ${mine ? "#f0e3c6" : "var(--line)"}`,
                    }}
                  >
                    {m.body}
                  </div>
                  <div className="mut" style={{ fontSize: 11.5, marginTop: 4, textAlign: mine ? "right" : "left" }}>
                    {`${mine ? "You" : "LakeLife dispatch"} · ${whenLabel(m.created_at)}`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <JobMessageComposer jobId={job.id} />
    </div>
  );
}

/* ----------------------------------------------------------------- helpers */

function shortDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
