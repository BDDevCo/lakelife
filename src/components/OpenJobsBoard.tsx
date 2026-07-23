"use client";

/**
 * OPEN JOBS claim board — crew-facing list of unassigned jobs (Phase D).
 *
 * CLAUDE.md rule 1: every dollar here is the crew's OWN take-home (their rate
 * card priced for the property). There is NO customer price and NO margin in
 * the data, and none is ever rendered. First qualified crew to tap Claim wins;
 * the server re-checks everything, so a stale board just means a friendly
 * "already taken" toast and a refresh.
 */

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { claimJob } from "@/app/vendor/open-actions";
import { formatCurrency } from "@/app/vendor/earnings-helpers";
import type { OpenJob } from "@/app/vendor/open-data";

/**
 * FILL-IN RATES (docs/margin-gap-design.md, 2026-07-23): a job that failed
 * dispatch on margin becomes a posted-price offer, same consent pattern as
 * same-day rush. RULE 1: takeHome already carries the fill-in number (same
 * shape as rush's discounted take-home); this file never sees, and never
 * renders, a crew's own card rate next to it.
 */

type Blocker = NonNullable<OpenJob["blocker"]>;

/** Short on-card reason a job can't be claimed (no_rate gets a link instead). */
const BLOCKER_REASON: Record<Exclude<Blocker, "no_rate">, string> = {
  off_day: "Not one of your work days",
  day_blocked: "You've blocked this day",
  day_full: "Your day is full",
  rate_too_high: "Doesn't clear at your current rate",
  no_coi: "Update your insurance first",
  wrong_service: "Not available",
  not_active: "Not available",
  lake_paused: "Paused on this lake — finish strong elsewhere and it reopens",
  custody_job: "Storage jobs are routed, never claimed",
};

function prettyDate(date: string): string {
  return new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function OpenJobsBoard({ jobs }: { jobs: OpenJob[] }) {
  if (jobs.length === 0) {
    return (
      <div className="ll-card ll-card-pad">
        <p style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>
          No open jobs right now.
        </p>
        <p className="mut" style={{ fontSize: 14, margin: 0 }}>
          When a job near you needs a crew, it shows up here first-come,
          first-served. 🌊
        </p>
      </div>
    );
  }

  const gapCount = jobs.filter((j) => j.gap).length;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {gapCount > 0 && (
        <div className="ll-card ll-card-pad" style={{ background: "var(--sun-soft)" }}>
          <p style={{ fontSize: 14, fontWeight: 800, margin: 0 }}>
            {gapCount === 1
              ? "1 job on your lakes is offering fill-in rates — first tap takes it."
              : `${gapCount} jobs on your lakes are offering fill-in rates — first tap takes them.`}
          </p>
        </div>
      )}
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
    </div>
  );
}

function JobCard({ job }: { job: OpenJob }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const gap = job.gap;
  const hasSubline = job.rush || gap; // either sub-line pins the take-home line up to make room

  function claim() {
    startTransition(async () => {
      const res = await claimJob(job.id);
      if (res.ok) {
        toast("It's yours — added to your schedule. 🌊");
      } else {
        toast(res.error ?? "Couldn't claim that one — try the next.");
      }
      router.refresh(); // either way the board may be stale — repaint it
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 17, margin: 0, flex: 1, minWidth: 160 }}>{job.serviceName}</h3>
        {gap && <span className="ll-pill gold">FILL-IN RATE</span>}
        {job.rush && <span className="ll-pill gold">⚡ Today</span>}
        {job.onMyLake ? (
          <span className="ll-pill ok">Your lake</span>
        ) : job.milesAway != null ? (
          <span className="ll-pill slate">~{job.milesAway} mi away</span>
        ) : (
          <span className="ll-pill slate">New lake</span>
        )}
      </div>

      <p className="mut" style={{ fontSize: 14, margin: "4px 0 10px" }}>
        {job.lakeName} &middot; {prettyDate(job.date)}
      </p>

      {job.takeHome != null ? (
        <p style={{ fontSize: 17, fontWeight: 800, color: "var(--teal-dark)", margin: hasSubline ? "0 0 4px" : "0 0 12px" }}>
          You&apos;d take home {formatCurrency(job.takeHome)}
        </p>
      ) : (
        <p className="mut" style={{ fontSize: 14, margin: hasSubline ? "0 0 4px" : "0 0 12px" }}>
          Set your rate to see your take-home
        </p>
      )}
      {job.rush && (
        <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
          Same-day fill-in — fits a gap in your day. First claim wins.
        </p>
      )}
      {gap && (
        <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
          Posted rate for this job — your regular rates stay yours.
        </p>
      )}

      {job.claimable ? (
        <button
          className="ll-btn gold"
          onClick={claim}
          disabled={pending}
          style={{ width: "100%", minHeight: 48 }}
        >
          {pending ? "Claiming…" : gap ? `Claim at ${formatCurrency(job.takeHome)}` : job.rush ? "Claim today's job ⚡" : "Claim this job"}
        </button>
      ) : job.blocker === "no_rate" ? (
        <Link
          className="ll-btn"
          href="/vendor/rates"
          style={{ display: "block", width: "100%", minHeight: 48, textAlign: "center" }}
        >
          Set your rate to claim
        </Link>
      ) : (
        <>
          <button className="ll-btn" disabled style={{ width: "100%", minHeight: 48 }}>
            Claim this job
          </button>
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0" }}>
            {BLOCKER_REASON[(job.blocker ?? "not_active") as Exclude<Blocker, "no_rate">]}
          </p>
        </>
      )}
    </div>
  );
}
