"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { retryAssign } from "@/app/ops/dispatch-actions";
import { PreferredCrew } from "./PreferredCrew";
import type { NeedsAttentionJob } from "@/app/ops/dispatch-data";
import type { ActiveVendor } from "@/app/ops/data";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function prettyDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * The auto-dispatch "needs attention" bucket: jobs the machine couldn't crew.
 * Each card lets ops set a preferred crew and re-run dispatch. The real fix is
 * usually to recruit a crew for that lake/service — surfaced as a note.
 */
export function NeedsAttention({ jobs, crews }: { jobs: NeedsAttentionJob[]; crews: ActiveVendor[] }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span className="ll-pill warn">Needs a crew</span>
          <span className="mut" style={{ fontSize: 13 }}>{jobs.length}</span>
        </div>
        <p className="mut" style={{ fontSize: 13, margin: 0 }}>
          Auto-dispatch couldn&apos;t place these. Set a preferred crew and try again, or recruit a crew for that lake.
        </p>
      </div>

      {jobs.length === 0 ? (
        <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>All jobs have a crew ✓</div>
          <div className="mut" style={{ fontSize: 13, marginTop: 4 }}>The machine placed everything on the board.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {jobs.map((j) => (
            <AttentionCard key={j.id} job={j} crews={crews} />
          ))}
        </div>
      )}
    </div>
  );
}

function AttentionCard({ job, crews }: { job: NeedsAttentionJob; crews: ActiveVendor[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const meta = [job.lake_name, prettyDate(job.date)].filter(Boolean).join(" · ");

  async function retry() {
    if (busy) return;
    setBusy(true);
    const res = await retryAssign(job.id);
    setBusy(false);
    if (!res.ok) return toast(res.error ?? "Dispatch didn't run.");
    if (res.assigned) {
      toast("Placed — a crew picked it up. 🌊");
      router.refresh();
    } else {
      toast("Still no crew fits — recruit one for this lake.");
    }
  }

  return (
    <div className="ll-card ll-card-pad" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{job.service_name ?? "Service"}</div>
          <div className="mut" style={{ fontSize: 13 }}>{job.address ?? "Address on file"}</div>
          <div className="mut" style={{ fontSize: 12.5 }}>{meta}</div>
        </div>
        {/* Ops-only money column (rule 1). */}
        <div style={{ textAlign: "right", minWidth: 110, fontSize: 13 }}>
          <div>Customer <b>{job.customer_price == null ? "—" : money.format(job.customer_price)}</b></div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="ll-pill warn">{job.reason}</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <PreferredCrew
          propertyId={job.property_id}
          current={job.preferred_vendor}
          currentCompany={job.preferred_company}
          crews={crews}
        />
        <button className="ll-btn gold sm" onClick={retry} disabled={busy}>
          {busy ? "Trying…" : "Try again"}
        </button>
      </div>

      <p className="mut" style={{ fontSize: 11.5, margin: 0 }}>
        No crew fitting? Recruit a crew for {job.lake_name ?? "this lake"} on the Crews tab — that&apos;s the real unblock.
      </p>
    </div>
  );
}
