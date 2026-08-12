import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { JobPhotoGallery } from "@/components/JobPhotoGallery";
import { CrewJobActions, CrewMakeItRight, CrewNavigateButton } from "@/components/VendorJobPanel";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { todayLakeDate } from "@/lib/booking";
import { getMyVendorId } from "../../data";
import { getCrewJobDetail } from "../../job-detail-data";
import { crewStatusLabel, disputeViewForCrew } from "@/lib/job-view";
import { formatCurrency, statusLabel, earningsRowLabel } from "../../earnings-helpers";

/**
 * ONE JOB, THE CREW'S VIEW (2026-07-26).
 *
 * Everything on this page is either the crew's own work or the crew's own
 * money. There is no customer price and no margin anywhere on it — not in a
 * tooltip, not in a data attribute — because the loader never reads those
 * columns (rule 1). The gate code appears only on the day of this crew's job
 * at this property (rule 3), decrypted server-side and re-guarded in the
 * loader. Photos are signed URLs with a one-hour life, which is exactly why
 * this page is force-dynamic.
 */
export const dynamic = "force-dynamic";

function prettyDate(iso: string | null): string {
  if (!iso) return "Not scheduled yet";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

function shortDate(iso: string | null): string {
  if (!iso) return "TBD";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

const STATUS_PILL: Record<string, string> = {
  requested: "warn",
  scheduled: "teal",
  in_progress: "teal",
  complete: "ok",
  paid: "slate",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar />
      <VendorNav />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>{children}</div>
    </>
  );
}

export default async function VendorJobDetailPage(ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

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

  const vendorId = await getMyVendorId();
  if (!vendorId) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Crews only</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>This is the vendor area</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              Your account isn&apos;t set up as a LakeLife crew.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  // THE GATE. getCrewJobDetail runs assertVendorJob first and returns null for
  // any job that isn't this crew's — a guessed URL learns nothing.
  const job = await getCrewJobDetail(id);
  if (!job) {
    return (
      <Shell>
        <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
          <span className="ll-pill slate">Not your job</span>
          <h2 style={{ fontSize: 20, margin: "12px 0 6px" }}>That job isn&apos;t on your route</h2>
          <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
            It may have been reassigned, or the link is wrong. Your own work is on your schedule.
          </p>
          <Link className="ll-btn" href="/vendor/schedule">My schedule</Link>
        </div>
      </Shell>
    );
  }

  const today = todayLakeDate();
  const pill = STATUS_PILL[job.status] ?? "slate";
  const isCorrection = job.correctionOf != null;
  const dv = job.dispute
    ? disputeViewForCrew({ status: job.dispute.status, correctionDate: job.correctionVisit?.date ?? null })
    : null;
  const subline = [job.lakeName, job.facts, job.ownerName ? `owner: ${job.ownerName}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <Shell>
      <p style={{ fontSize: 13, marginBottom: 10 }}>
        <Link href="/vendor/schedule" style={{ color: "var(--teal-dark)", fontWeight: 700, textDecoration: "none" }}>
          ‹ Back to my schedule
        </Link>
      </p>

      {/* ---------------- header ---------------- */}
      <div className="ll-card ll-card-pad">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
          <span className={`ll-pill ${pill}`}>{crewStatusLabel(job.status)}</span>
          {job.unitName && <span className="ll-pill slate">{job.unitName}</span>}
          {isCorrection && <span className="ll-pill gold">Make-it-right visit</span>}
        </div>
        <h1 style={{ fontSize: 24, margin: "0 0 2px" }}>{job.serviceName ?? "Service"}</h1>
        <p style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px" }}>{prettyDate(job.date)}</p>

        {job.legs.length > 1 && (
          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
            🧊 This visit: {job.legs.join(" · ")}
          </p>
        )}

        <p style={{ fontSize: 14, margin: "0 0 2px" }}>{job.address ?? "Address on file"}</p>
        {subline && <p className="mut" style={{ fontSize: 12.5, margin: "0 0 10px" }}>{subline}</p>}

        <CrewNavigateButton lat={job.lat} lng={job.lng} address={job.address} />

        {isCorrection && (
          <p style={{ fontSize: 13, marginTop: 12, padding: "9px 12px", background: "var(--sun-soft)", border: "1px solid #ecd9ad", borderRadius: 10, color: "#7a5a1e", lineHeight: 1.5 }}>
            <b>Make-it-right visit — no charge.</b>{" "}
            {`Photos are still required to close it. This puts right the ${job.correctionOf?.serviceName ?? "earlier job"} from ${shortDate(job.correctionOf?.date ?? null)}.`}{" "}
            <Link href={`/vendor/jobs/${job.correctionOf?.id}`} style={{ color: "inherit", fontWeight: 700 }}>
              Open the original job ›
            </Link>
          </p>
        )}
      </div>

      {/* ---------------- make it right ---------------- */}
      {job.dispute && dv && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 14, borderLeft: "4px solid var(--sun)" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
            <span className="ll-pill warn">{dv.pill}</span>
            {dv.payOnHold && <span className="ll-pill slate">Pay on hold</span>}
          </div>
          <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Make it right 🌊</h3>
          <p style={{ fontSize: 13.5, lineHeight: 1.55, margin: "0 0 8px" }}>{dv.line}</p>

          {job.dispute.customerNote && (
            <blockquote style={{ margin: "0 0 8px", padding: "9px 12px", background: "#f4f8f9", borderRadius: 10, fontSize: 13, lineHeight: 1.5 }}>
              <span className="mut" style={{ fontSize: 11.5, fontWeight: 800, display: "block", marginBottom: 3 }}>
                WHAT THE CUSTOMER SAID
              </span>
              {job.dispute.customerNote}
            </blockquote>
          )}

          {job.correctionVisit && (
            <p style={{ fontSize: 13, margin: "0 0 4px" }}>
              Return visit booked for {shortDate(job.correctionVisit.date)} —{" "}
              <Link href={`/vendor/jobs/${job.correctionVisit.id}`} style={{ color: "var(--teal-dark)", fontWeight: 700 }}>
                open that visit ›
              </Link>
            </p>
          )}

          <CrewMakeItRight
            jobId={job.id}
            today={today}
            canFix={job.dispute.canFix}
            canVerify={job.dispute.canVerify}
            canTalk={job.dispute.canTalk}
          />
        </div>
      )}

      {/* ---------------- their money, and only theirs ---------------- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Your take-home</h3>
        {job.payouts.length === 0 ? (
          <p className="mut" style={{ fontSize: 13.5, margin: 0 }}>
            {isCorrection
              ? "A make-it-right visit carries no charge and no separate pay — finishing it releases the hold on the original job."
              : "Your pay for this job posts when it's complete and photo-verified."}
          </p>
        ) : (
          <>
            <p style={{ fontSize: 22, fontWeight: 800, color: "var(--teal-dark)", margin: "0 0 8px" }}>
              {formatCurrency(job.takeHome)}
            </p>
            <div style={{ display: "grid", gap: 6 }}>
              {job.payouts.map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                  <span>{earningsRowLabel({ kind: p.kind, service: job.serviceName })}</span>
                  <span style={{ textAlign: "right" }}>
                    <b>{formatCurrency(p.amount)}</b>
                    <span className="mut" style={{ display: "block", fontSize: 11.5 }}>{statusLabel(p.status)}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {job.payOnHold && (
          <p style={{ fontSize: 12.5, marginTop: 10, color: "var(--warn)", fontWeight: 700, lineHeight: 1.5 }}>
            {job.dispute
              ? "This pay is frozen while the make-it-right above is open. It releases the moment the job is settled."
              : "This pay is frozen while a question about this job is settled. It releases the moment it is."}
          </p>
        )}
        <p className="mut" style={{ fontSize: 11.5, margin: "10px 0 0" }}>
          These are your numbers — what the homeowner pays LakeLife is between them and us.
        </p>
      </div>

      {/* ---------------- gate code, day-of only (rule 3) ---------------- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Getting in</h3>
        {job.gateCode ? (
          <div style={{ padding: "9px 12px", background: "var(--sun-soft)", border: "1px solid #ecd9ad", borderRadius: 10, fontSize: 13.5, color: "#7a5a1e" }}>
            🔑 Gate / door code:{" "}
            <b style={{ fontFamily: "var(--font-display)", letterSpacing: ".08em" }}>{job.gateCode}</b>
            <span className="mut" style={{ display: "block", fontSize: 11.5 }}>
              Shown only today, only for this job.
            </span>
          </div>
        ) : (
          <p className="mut" style={{ fontSize: 13.5, margin: 0 }}>
            🔒 {job.isToday
              ? "No gate or door code on file for this property."
              : "The gate code unlocks the morning of the job — it's never shown early."}
          </p>
        )}
      </div>

      {/* ---------------- photos ---------------- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Photos on file</h3>
        <JobPhotoGallery
          photos={job.photos}
          emptyNote="No photos yet. Shoot them as you work — they're what closes this job."
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <CrewJobActions
          jobId={job.id}
          address={job.address}
          photoCount={job.photoCount}
          minPhotos={job.minPhotos}
          status={job.status}
          isCorrection={isCorrection}
        />
      </div>

      {/* ---------------- flags raised here ---------------- */}
      {job.flags.length > 0 && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 14, marginBottom: 24 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Flags you raised</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {job.flags.map((f) => (
              <div key={f.id} style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap", fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 180 }}>
                  <b>{f.type ?? "Correction"}</b>
                  {f.note ? <span className="mut"> — {f.note}</span> : null}
                </span>
                <span className={`ll-pill ${f.status === "approved" ? "ok" : f.status === "declined" ? "slate" : "warn"}`}>
                  {f.status === "approved" ? "Owner approved" : f.status === "declined" ? "Owner declined" : "Waiting on the owner"}
                </span>
              </div>
            ))}
          </div>
          <p className="mut" style={{ fontSize: 11.5, margin: "10px 0 0", lineHeight: 1.5 }}>
            Nothing changes and nothing bills until the homeowner approves a flag.
          </p>
        </div>
      )}

      <div style={{ height: 24 }} />
    </Shell>
  );
}
