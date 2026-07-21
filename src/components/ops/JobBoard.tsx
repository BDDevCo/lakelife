"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { assignAndSchedule } from "@/app/ops/actions";
import { toast } from "@/components/Toast";
import type { OpsJob, ActiveVendor } from "@/app/ops/data";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const SLOTS = [
  { value: "8a", label: "8:00 am" },
  { value: "10a", label: "10:00 am" },
  { value: "1p", label: "1:00 pm" },
  { value: "3p", label: "3:00 pm" },
];

const BUCKETS: Array<{ key: string; label: string; statuses: string[]; tone: string }> = [
  { key: "requested", label: "Needs scheduling", statuses: ["requested"], tone: "warn" },
  { key: "scheduled", label: "Scheduled", statuses: ["scheduled"], tone: "teal" },
  { key: "in_progress", label: "In progress", statuses: ["in_progress"], tone: "slate" },
  { key: "done", label: "Complete", statuses: ["complete", "paid"], tone: "ok" },
];

/** Does this vendor list this service? Empty service_types = generalist. */
function serviceOk(vendor: ActiveVendor, serviceName: string | null): boolean {
  if (!vendor.service_types.length) return true;
  const svc = (serviceName ?? "").toLowerCase();
  return vendor.service_types.some((t) => {
    const tt = String(t).toLowerCase();
    return svc.includes(tt) || tt.includes(svc.split(" ")[0]);
  });
}

function prettyDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function JobBoard({
  jobs,
  vendors,
  preferredJobIds = [],
}: {
  jobs: OpsJob[];
  vendors: ActiveVendor[];
  preferredJobIds?: string[];
}) {
  const [assigning, setAssigning] = useState<OpsJob | null>(null);
  const preferred = useMemo(() => new Set(preferredJobIds), [preferredJobIds]);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {BUCKETS.map((b) => {
        const rows = jobs.filter((j) => b.statuses.includes(j.status));
        return (
          <div key={b.key}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span className={`ll-pill ${b.tone}`}>{b.label}</span>
              <span className="mut" style={{ fontSize: 13 }}>{rows.length}</span>
            </div>
            {rows.length === 0 ? (
              <div className="mut" style={{ fontSize: 13, padding: "4px 2px" }}>Nothing here right now.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {rows.map((j) => (
                  <JobRow key={j.id} job={j} preferred={preferred.has(j.id)} onAssign={() => setAssigning(j)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {assigning && (
        <AssignModal
          job={assigning}
          vendors={vendors}
          onClose={() => setAssigning(null)}
        />
      )}
    </div>
  );
}

function JobRow({ job, preferred, onAssign }: { job: OpsJob; preferred?: boolean; onAssign: () => void }) {
  const isRequested = job.status === "requested";
  // Heuristic: a scheduled job that carries a crew was placed by auto-dispatch.
  const isAuto = job.status === "scheduled" && !!job.vendor_id;
  const meta = [job.lake_name, job.owner_name ? `owner: ${job.owner_name}` : null, prettyDate(job.date), job.slot]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="ll-card ll-card-pad" style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{job.service_name ?? "Service"}</span>
          {isAuto && <span className="ll-pill teal" title="Placed by auto-dispatch">AUTO</span>}
          {preferred && <span className="ll-pill gold" title="Assigned crew is this property's preferred crew">⭐ preferred</span>}
        </div>
        <div className="mut" style={{ fontSize: 13 }}>{job.address ?? "Address on file"}</div>
        <div className="mut" style={{ fontSize: 12.5 }}>{meta}</div>
        {job.vendor_company && (
          <div style={{ fontSize: 12.5, marginTop: 4 }}>
            Crew: <b>{job.vendor_company}</b>
          </div>
        )}
      </div>

      {/* Ops-only money column (rule 1). */}
      <div style={{ textAlign: "right", minWidth: 150, fontSize: 13 }}>
        <div>Customer <b>{job.customer_price == null ? "—" : money.format(job.customer_price)}</b></div>
        <div className="mut">Vendor {job.vendor_cost == null ? "—" : money.format(job.vendor_cost)}</div>
        <div style={{ color: "var(--teal-dark)", fontWeight: 700 }}>
          Margin {job.margin == null ? "—" : money.format(job.margin)}
          {job.margin != null && job.customer_price ? ` · ${Math.round((job.margin / job.customer_price) * 100)}%` : ""}
        </div>
        {!isRequested && job.min_photos > 0 && (
          <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>📷 {job.photo_count}/{job.min_photos}</div>
        )}
      </div>

      <div style={{ width: "100%", display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {isRequested ? (
          <button className="ll-btn gold sm" onClick={onAssign}>Assign &amp; schedule</button>
        ) : job.status === "scheduled" ? (
          <button className="ll-btn ghost sm" onClick={onAssign}>Reassign</button>
        ) : null}
      </div>
    </div>
  );
}

function AssignModal({ job, vendors, onClose }: { job: OpsJob; vendors: ActiveVendor[]; onClose: () => void }) {
  const router = useRouter();
  const price = job.customer_price ?? 0;
  // Auto-suggest a 30% margin: vendor gets 70% of the customer price.
  const suggested = job.vendor_cost != null ? job.vendor_cost : Math.round(price * 0.7);

  const [vendorId, setVendorId] = useState<string>(job.vendor_id ?? "");
  const [cost, setCost] = useState<string>(String(suggested));
  const [date, setDate] = useState<string>(job.date ?? "");
  const [slot, setSlot] = useState<string>(job.slot ?? "8a");
  const [busy, setBusy] = useState(false);

  // Vendors annotated for this job's service, COI-invalid ones disabled.
  const options = useMemo(
    () =>
      vendors
        .map((v) => ({ v, service_ok: serviceOk(v, job.service_name) }))
        // list service-matching vendors first, then the rest
        .sort((a, b) => Number(b.service_ok) - Number(a.service_ok)),
    [vendors, job.service_name],
  );

  // Quantize to whole cents so the preview matches what the server stores.
  const costNum = Math.round(Number(cost) * 100) / 100;
  const costValid = Number.isFinite(costNum) && costNum >= 0 && costNum <= price;
  const margin = costValid ? price - costNum : 0;
  const marginPct = price > 0 && costValid ? Math.round((margin / price) * 100) : 0;
  const chosen = vendors.find((v) => v.id === vendorId) ?? null;
  const canSubmit = !!vendorId && !!chosen?.coi_ok && costValid && !!date && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    const res = await assignAndSchedule(job.id, { vendorId, vendorCost: costNum, date, slot });
    if (!res.ok) {
      toast(res.error ?? "Couldn't schedule that job.");
      setBusy(false);
      return;
    }
    toast("Scheduled — crew and homeowner notified. 🌊");
    router.refresh();
    onClose();
  }

  const selectStyle: React.CSSProperties = {
    width: "100%", padding: "11px 13px", border: "1.5px solid var(--line)",
    borderRadius: 10, fontSize: 16, fontFamily: "inherit", background: "#fff", color: "var(--text)",
  };

  return (
    <div className="ll-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ll-modal" style={{ maxWidth: 460 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill teal">Assign &amp; schedule</span>
            <h3 style={{ fontSize: 20, marginTop: 8 }}>{job.service_name ?? "Service"}</h3>
            <div className="mut" style={{ fontSize: 13 }}>{job.address}{job.owner_name ? ` · ${job.owner_name}` : ""}</div>
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ll-modal-body">
          <div className="ll-field">
            <label>Crew</label>
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} style={selectStyle}>
              <option value="">Choose a vendor…</option>
              {options.map(({ v, service_ok }) => (
                <option key={v.id} value={v.id} disabled={!v.coi_ok}>
                  {v.company ?? "Vendor"}
                  {!v.coi_ok ? " — COI expired/missing" : service_ok ? "" : " — doesn't list this service"}
                </option>
              ))}
            </select>
            {chosen && !chosen.coi_ok && (
              <p style={{ color: "var(--warn)", fontSize: 12, marginTop: 6 }}>
                That crew has no valid insurance on file — they can&apos;t be routed until COI is updated.
              </p>
            )}
          </div>

          <div className="ll-field">
            <label>Vendor cost (customer pays {money.format(price)})</label>
            <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginTop: 6 }}>
              <span className="mut">Suggested {money.format(Math.round(price * 0.7))} (30% margin)</span>
              <span style={{ color: costValid ? "var(--teal-dark)" : "var(--warn)", fontWeight: 700 }}>
                {costValid ? `Margin ${money.format(margin)} · ${marginPct}%` : "Cost must be 0–" + money.format(price)}
              </span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Time</label>
              <select value={slot} onChange={(e) => setSlot(e.target.value)} style={selectStyle}>
                {SLOTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>

          <button className="ll-btn gold" style={{ width: "100%" }} onClick={submit} disabled={!canSubmit}>
            {busy ? "Scheduling…" : "Confirm & notify crew"}
          </button>
          <p className="mut" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 10 }}>
            The crew never sees the customer price or margin — only their own cost and the stop details.
            Payout releases automatically once photos are in.
          </p>
        </div>
      </div>
    </div>
  );
}
