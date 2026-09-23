"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { assignAndSchedule } from "@/app/ops/actions";
import { toast } from "@/components/Toast";
import { RefundModal } from "@/components/ops/RefundModal";
import type { OpsJob, ActiveVendor, CrewRateCard } from "@/app/ops/data";
import { crewListsService } from "@/lib/crew-services";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
/** A CREW'S OWN RATE IS PRINTED TO THE CENT. The whole-dollar formatter above
 *  would round $48.50 a section to $49 and put a number on screen that is not
 *  on their card. */
const rateUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const SLOTS = [
  { value: "8a", label: "8:00 am" },
  { value: "10a", label: "10:00 am" },
  { value: "1p", label: "1:00 pm" },
  { value: "3p", label: "3:00 pm" },
];

const BUCKETS: Array<{ key: string; label: string; statuses: string[]; tone: string }> = [
  { key: "requested", label: "Machine hunting (no approval needed)", statuses: ["requested"], tone: "warn" },
  { key: "scheduled", label: "Scheduled", statuses: ["scheduled"], tone: "teal" },
  { key: "in_progress", label: "In progress", statuses: ["in_progress"], tone: "slate" },
  // NAMED FOR WHAT IT HOLDS. The loader bounds finished work to the last 30
  // days (see DONE_WINDOW_DAYS) — the three live buckets stay unbounded,
  // because an old requested job with no crew is still a thing to do. Calling
  // this one "Complete" while showing a month of it is the kind of quiet
  // half-truth this codebase keeps finding; the label says the window instead.
  { key: "done", label: "Complete — last 30 days", statuses: ["complete", "paid"], tone: "ok" },
];

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
  const [refunding, setRefunding] = useState<OpsJob | null>(null);
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
              <div className="mut" style={{ fontSize: 13, padding: "4px 2px" }}>
                {b.key === "done" ? "Nothing finished in the last 30 days." : "Nothing here right now."}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {rows.map((j) => (
                  <JobRow
                    key={j.id}
                    job={j}
                    preferred={preferred.has(j.id)}
                    onAssign={() => setAssigning(j)}
                    onRefund={() => setRefunding(j)}
                  />
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

      {refunding && (
        <RefundModal
          jobId={refunding.id}
          serviceName={refunding.service_name}
          address={refunding.address}
          onClose={() => setRefunding(null)}
        />
      )}
    </div>
  );
}

function JobRow({
  job,
  preferred,
  onAssign,
  onRefund,
}: {
  job: OpsJob;
  preferred?: boolean;
  onAssign: () => void;
  onRefund: () => void;
}) {
  const isRequested = job.status === "requested";
  // Heuristic: a scheduled job that carries a crew was placed by auto-dispatch.
  const isAuto = job.status === "scheduled" && !!job.vendor_id;
  // Refunds apply once cash has actually been captured (complete/paid jobs
  // with a paid invoice); a fully-refunded invoice shows a pill instead.
  const isRefunded = job.invoice_status === "refunded";
  const canRefund = (job.status === "complete" || job.status === "paid") && !isRefunded;
  const meta = [job.lake_name, job.owner_name ? `owner: ${job.owner_name}` : null, prettyDate(job.date), job.slot]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="ll-card ll-card-pad" style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {/* The whole job file — comments, photos, money, levers — is one click away. */}
          <Link href={`/ops/jobs/${job.id}`} style={{ fontWeight: 800, fontSize: 15, color: "inherit" }}>
            {job.service_name ?? "Service"}
          </Link>
          {isAuto && <span className="ll-pill teal" title="Placed by auto-dispatch">AUTO</span>}
          {preferred && <span className="ll-pill gold" title="Assigned crew is this property's preferred crew">⭐ preferred</span>}
          {/* THE BOARD KEEPS THESE; THE NUMBERS ABOVE DO NOT COUNT THEM.
              Ops is the only person who can work or clear a scratch job, so
              hiding them here would be the worse half of the trade. Saying so
              on the row is what stops the console contradicting itself — three
              jobs listed, zero jobs in every figure at the top of the page. */}
          {job.is_fixture && (
            <span className="ll-pill slate" title="One end of this job is an account we invented, so it is left out of the revenue, margin and waiting figures.">
              test account · not counted above
            </span>
          )}
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

      <div style={{ width: "100%", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
        <Link className="ll-btn ghost sm" href={`/ops/jobs/${job.id}`} style={{ marginRight: "auto" }}>
          Open job file →
        </Link>
        {isRequested ? (
          <button className="ll-btn ghost sm" onClick={onAssign} title="The machine keeps hunting on its own — sweeps, claim board, scarcity offers. Override only if you must.">Override (manual assign)</button>
        ) : job.status === "scheduled" ? (
          <button className="ll-btn ghost sm" onClick={onAssign}>Reassign</button>
        ) : null}
        {isRefunded && <span className="ll-pill slate">↩ refunded</span>}
        {canRefund && <button className="ll-btn ghost sm" onClick={onRefund}>Refund…</button>}
      </div>
    </div>
  );
}

/**
 * THE OVERRIDE WITH NOBODY TO OVERRIDE TO.
 *
 * `getActiveVendors` fences test accounts out of this dropdown — correctly,
 * and precisely when auto-dispatch has already found nobody. Production's
 * three vendors are all test accounts, so the list is empty today and stays
 * empty until a real crew activates: the modal drew an inert "Choose a
 * vendor…", a disabled Confirm, and a footer still explaining how payout
 * releases, with not one word about why. This is the control ops reaches for
 * the first time a real customer books on any lake.
 *
 * WORDED FOR WHATEVER THE CAUSE IS. The coverage card on the Crews tab says
 * "every vendor on the platform is a test account" because it is computed from
 * numbers this modal never receives; an empty list here only means "no active
 * crew with insurance on file", which is equally true the day a real crew is
 * invited but not yet activated. Both modals import this one, so the sentence
 * cannot be half-corrected later.
 */
export function NoCrewToAssign({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="ll-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ll-modal" style={{ maxWidth: 460 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill teal">Manual override</span>
            <h3 style={{ fontSize: 20, marginTop: 8 }}>{title}</h3>
            <div className="mut" style={{ fontSize: 13 }}>{subtitle}</div>
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ll-modal-body">
          <div style={{ padding: "12px 14px", borderRadius: 12, background: "var(--alarm-bg)" }}>
            <strong style={{ fontSize: 14 }}>No crew can be assigned by hand.</strong>
            <p style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
              There is no active crew with insurance on file, so there is nobody to route this to —
              by hand or by machine. Recruit or activate a crew on the Crews tab of the ops console;
              that&apos;s the real unblock.
            </p>
          </div>
          <button className="ll-btn ghost" style={{ width: "100%", marginTop: 14 }} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A CREW'S RATE CARD, IN WORDS. Their numbers only — nothing derived from the
 * customer price, nothing averaged, nothing filled in.
 *
 * Empty string when the card holds no number we can name, which the caller
 * treats exactly as "no rate on file": a card that renders to nothing must
 * never be announced as a rate.
 */
function rateWords(card: CrewRateCard): string {
  const parts: string[] = [];
  const unit =
    card.pricing_model === "per_section" ? "section"
      : card.pricing_model === "per_foot" ? "foot"
        : "unit";
  const hasUnit = card.unit_rate != null && card.unit_rate > 0;
  if (card.base != null && card.base > 0) {
    parts.push(hasUnit ? `${rateUsd.format(card.base)} base` : `${rateUsd.format(card.base)} flat`);
  }
  if (hasUnit) parts.push(`${rateUsd.format(card.unit_rate as number)} per ${unit}`);
  const bp = card.band_pricing ?? {};
  for (const k of ["small", "medium", "large"] as const) {
    const v = bp[k];
    if (typeof v === "number") parts.push(`${k} ${rateUsd.format(v)}`);
  }
  const tiers = bp.tiers;
  if (Array.isArray(tiers)) {
    tiers.forEach((t, i) => {
      const p = (t as { price?: unknown } | null)?.price;
      if (typeof p === "number") parts.push(`tier ${i + 1} ${rateUsd.format(p)}`);
    });
  }
  return parts.join(" · ");
}

/**
 * THE BOX THAT SETS A CONTRACTOR'S PAY, WITH SOMETHING TRUE BESIDE IT.
 *
 * Both override modals used to open this field pre-filled with
 * `round(customer_price × 0.7)` under the label "Suggested $423 (30% margin)".
 * Nobody ever quoted that number. `assignAndSchedule` consults no rate card —
 * it writes whatever is in the box to `jobs.vendor_cost` — so the hour the
 * first real crew goes active, a figure this product invented becomes the
 * default answer to "what do we pay this contractor". That is LakeLife setting
 * a crew's price, which is the exact thing the model change abolished: "I do
 * not want lakelife setting the pricing for crews."
 *
 * So the box opens EMPTY — an empty box asks a question, a filled one answers
 * it wrongly — and what sits beside it is the crew's own card, which is a
 * fact. The manual path itself is untouched: ops must still be able to record
 * a number that was actually negotiated.
 *
 * BOTH DOORWAYS IMPORT THIS ONE. The board's modal and the job file's had two
 * copies of the prefill and two copies of the label; a sentence about somebody
 * else's income cannot be half-corrected later.
 */
export function CrewRateNote({
  crew,
  serviceName,
}: {
  crew: ActiveVendor | null;
  serviceName: string | null;
}) {
  const style: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, margin: "8px 0 0" };
  if (!crew) {
    return (
      <p className="mut" style={style}>
        Choose a crew above and their own rate for this service appears here.
      </p>
    );
  }
  const who = crew.company ?? "This crew";
  const card = crew.rate_cards.find((c) => c.service_name === serviceName) ?? null;
  const words = card && card.priced ? rateWords(card) : "";
  if (!words) {
    return (
      <p style={{ ...style, color: "var(--warn)" }}>
        {who} has no rate on file for {serviceName ?? "this service"}. Ask them for their number —
        they set it on their own Rates screen. LakeLife doesn&apos;t price crews.
      </p>
    );
  }
  return (
    <p className="mut" style={style}>
      {who}&apos;s own rate for {serviceName}: <b>{words}</b>. That is their card, not this job&apos;s
      total — the size of this property decides that.
    </p>
  );
}

function AssignModal({ job, vendors, onClose }: { job: OpsJob; vendors: ActiveVendor[]; onClose: () => void }) {
  const router = useRouter();
  const price = job.customer_price ?? 0;
  // NO COMPUTED DEFAULT (see CrewRateNote). A cost already on the job is a
  // number somebody actually agreed, so a reassign still opens with it; a job
  // with none opens EMPTY rather than with `round(price × 0.7)`.
  const [vendorId, setVendorId] = useState<string>(job.vendor_id ?? "");
  const [cost, setCost] = useState<string>(job.vendor_cost != null ? String(job.vendor_cost) : "");
  const [date, setDate] = useState<string>(job.date ?? "");
  const [slot, setSlot] = useState<string>(job.slot ?? "8a");
  const [busy, setBusy] = useState(false);

  // Vendors annotated for this job's service, COI-invalid ones disabled.
  const options = useMemo(
    () =>
      vendors
        .map((v) => ({ v, service_ok: crewListsService(v.service_types, job.service_name) }))
        // list service-matching vendors first, then the rest
        .sort((a, b) => Number(b.service_ok) - Number(a.service_ok)),
    [vendors, job.service_name],
  );

  // Quantize to whole cents so the preview matches what the server stores.
  //
  // AN EMPTY BOX IS NOT ZERO. `Number("")` is 0, so with the prefill gone the
  // old test would have called an untouched field valid, enabled Confirm, and
  // written vendor_cost = 0 — a crew paid nothing, through a path that looks
  // entirely deliberate. The typed text has to be there before it can be read.
  const typed = cost.trim();
  const costNum = Math.round(Number(typed) * 100) / 100;
  const costValid = typed !== "" && Number.isFinite(costNum) && costNum >= 0 && costNum <= price;
  const margin = costValid ? price - costNum : 0;
  const marginPct = price > 0 && costValid ? Math.round((margin / price) * 100) : 0;
  const chosen = vendors.find((v) => v.id === vendorId) ?? null;
  const canSubmit = !!vendorId && !!chosen?.coi_ok && costValid && !!date && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    const res = await assignAndSchedule(job.id, { vendorId, vendorCost: costNum, date, slot });
    if (!res.ok) {
      toast.err(res.error ?? "Couldn't schedule that job.");
      setBusy(false);
      return;
    }
    toast.ok("Scheduled — crew and homeowner notified. 🌊");
    router.refresh();
    onClose();
  }

  const selectStyle: React.CSSProperties = {
    width: "100%", padding: "11px 13px", border: "1.5px solid var(--line)",
    borderRadius: 10, fontSize: 16, fontFamily: "inherit", background: "#fff", color: "var(--text)",
  };

  // After the hooks, before the form: with nobody to choose, every field below
  // describes a transaction that cannot start.
  if (vendors.length === 0) {
    return (
      <NoCrewToAssign
        title={job.service_name ?? "Service"}
        subtitle={`${job.address}${job.owner_name ? ` · ${job.owner_name}` : ""}`}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="ll-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ll-modal" style={{ maxWidth: 460 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill teal">Manual override</span>
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
                  {/* The same two-way label the job file uses. "Doesn't list
                      this service" is true but unhelpful for a crew who lists
                      none at all — the remedy is a different one, so the
                      sentence has to be too. */}
                  {!v.coi_ok
                    ? " — COI expired/missing"
                    : service_ok
                      ? ""
                      : v.service_types.length === 0
                        ? " — lists no services at all"
                        : " — doesn't list this service"}
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
            <input
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="What this crew agreed to"
            />
            <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 12.5, marginTop: 6 }}>
              {/* An untouched field is not a wrong one — the range only shouts
                  once somebody has typed something outside it. */}
              {typed !== "" && (
                <span style={{ color: costValid ? "var(--teal-dark)" : "var(--warn)", fontWeight: 700 }}>
                  {costValid ? `Margin ${money.format(margin)} · ${marginPct}%` : "Cost must be 0–" + money.format(price)}
                </span>
              )}
            </div>
            <CrewRateNote crew={chosen} serviceName={job.service_name} />
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
