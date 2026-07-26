"use client";

/**
 * The interactive half of the ops job file (/ops/jobs/[id]). Everything the
 * server can render — the money ledger, the timeline, the photos — stays on
 * the server page; this file is only the bits that need a click.
 *
 * NOTHING here reimplements a money path. The refund runs through the existing
 * <RefundModal> (quoteRefund / issueRefund → the ledger-locked, clawback-
 * conserving executeRefund), the crew override runs through the existing
 * assignAndSchedule (COI gate, margin floor, season gate all server-side), and
 * replies run through the existing sendOpsMessage / draftReplyForThread.
 *
 * Ops surface: customer price, vendor cost and margin are all fair game here
 * (rule 1 is about crews and customers) — but this component lives under
 * components/ops/* and must never be mounted on a crew or customer page.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { assignAndSchedule } from "@/app/ops/actions";
import { sendOpsMessage, draftReplyForThread } from "@/app/ops/messages-actions";
import { RefundModal } from "@/components/ops/RefundModal";
import { toast } from "@/components/Toast";
import type { ActiveVendor } from "@/app/ops/data";
import type { OpsJobMessage } from "@/app/ops/job-detail-data";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const SLOTS = [
  { value: "8a", label: "8:00 am" },
  { value: "10a", label: "10:00 am" },
  { value: "1p", label: "1:00 pm" },
  { value: "3p", label: "3:00 pm" },
];

const selectStyle: React.CSSProperties = {
  width: "100%", padding: "11px 13px", border: "1.5px solid var(--line)",
  borderRadius: 10, fontSize: 16, fontFamily: "inherit", background: "#fff", color: "var(--text)",
};

/** Does this crew list this service? Empty service_types = generalist. */
function serviceOk(vendor: ActiveVendor, serviceName: string | null): boolean {
  if (!vendor.service_types.length) return true;
  const svc = (serviceName ?? "").toLowerCase();
  return vendor.service_types.some((t) => {
    const tt = String(t).toLowerCase();
    return svc.includes(tt) || tt.includes(svc.split(" ")[0]);
  });
}

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// ACTION BAR — refund + crew override
// ---------------------------------------------------------------------------

export interface JobActionsProps {
  jobId: string;
  status: string;
  serviceName: string | null;
  address: string | null;
  customerName: string | null;
  crewCompany: string | null;
  vendorId: string | null;
  vendorCost: number | null;
  customerPrice: number | null;
  date: string | null;
  slot: string | null;
  invoiceStatus: string | null;
  /** Package legs route as a unit — assignAndSchedule refuses them by design. */
  inGroup: boolean;
  vendors: ActiveVendor[];
}

export function JobActions(props: JobActionsProps) {
  const [assigning, setAssigning] = useState(false);
  const [refunding, setRefunding] = useState(false);

  const isRefunded = props.invoiceStatus === "refunded";
  const canRefund = (props.status === "complete" || props.status === "paid") && !isRefunded;
  const canAssign = props.status === "requested" || props.status === "scheduled";

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
      <span className="ll-pill gold">Ops levers</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        {canAssign && !props.inGroup && (
          <button className="ll-btn ghost sm" onClick={() => setAssigning(true)}>
            {props.vendorId ? "Reassign crew" : "Override (manual assign)"}
          </button>
        )}
        {canRefund && (
          <button className="ll-btn ghost sm" onClick={() => setRefunding(true)}>Refund…</button>
        )}
        {isRefunded && <span className="ll-pill slate">↩ refunded</span>}
        {!canAssign && !canRefund && !isRefunded && (
          <span className="mut" style={{ fontSize: 13 }}>
            Nothing to do from here right now — this job is {props.status.replace("_", " ")}.
          </span>
        )}
      </div>
      {canAssign && props.inGroup && (
        <p className="mut" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>
          This is one leg of a storage package. Packages route as a unit — the crew has to cover every
          leg (rates, insurance, barn space), so the machine places them. Fix the crew&apos;s docs or capacity
          and it will.
        </p>
      )}

      {assigning && <AssignModal {...props} onClose={() => setAssigning(false)} />}
      {refunding && (
        <RefundModal
          jobId={props.jobId}
          serviceName={props.serviceName}
          address={props.address}
          onClose={() => setRefunding(false)}
        />
      )}
    </div>
  );
}

function AssignModal({
  jobId, serviceName, address, customerName, vendorId, vendorCost, customerPrice, date, slot, vendors, onClose,
}: JobActionsProps & { onClose: () => void }) {
  const router = useRouter();
  const price = customerPrice ?? 0;
  const suggested = vendorCost != null ? vendorCost : Math.round(price * 0.7);

  const [chosenId, setChosenId] = useState<string>(vendorId ?? "");
  const [cost, setCost] = useState<string>(String(suggested));
  const [day, setDay] = useState<string>(date ?? "");
  const [time, setTime] = useState<string>(slot ?? "8a");
  const [busy, setBusy] = useState(false);

  const options = useMemo(
    () =>
      vendors
        .map((v) => ({ v, service_ok: serviceOk(v, serviceName) }))
        .sort((a, b) => Number(b.service_ok) - Number(a.service_ok)),
    [vendors, serviceName],
  );

  const costNum = Math.round(Number(cost) * 100) / 100;
  const costValid = Number.isFinite(costNum) && costNum >= 0 && costNum <= price;
  const marginNow = costValid ? price - costNum : 0;
  const marginPctNow = price > 0 && costValid ? Math.round((marginNow / price) * 100) : 0;
  const chosen = vendors.find((v) => v.id === chosenId) ?? null;
  const canSubmit = !!chosenId && !!chosen?.coi_ok && costValid && !!day && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    const res = await assignAndSchedule(jobId, { vendorId: chosenId, vendorCost: costNum, date: day, slot: time });
    if (!res.ok) {
      toast(res.error ?? "Couldn't schedule that job.");
      setBusy(false);
      return;
    }
    toast("Scheduled — crew and homeowner notified. 🌊");
    router.refresh();
    onClose();
  }

  return (
    <div className="ll-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ll-modal" style={{ maxWidth: 460 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill teal">Manual override</span>
            <h3 style={{ fontSize: 20, marginTop: 8 }}>{serviceName ?? "Service"}</h3>
            <div className="mut" style={{ fontSize: 13 }}>
              {address ?? "Address on file"}{customerName ? ` · ${customerName}` : ""}
            </div>
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ll-modal-body">
          <div className="ll-field">
            <label>Crew</label>
            <select value={chosenId} onChange={(e) => setChosenId(e.target.value)} style={selectStyle}>
              <option value="">Choose a crew…</option>
              {options.map(({ v, service_ok }) => (
                <option key={v.id} value={v.id} disabled={!v.coi_ok}>
                  {v.company ?? "Crew"}
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
            <label>Crew cost (customer pays {money.format(price)})</label>
            <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginTop: 6 }}>
              <span className="mut">Suggested {money.format(Math.round(price * 0.7))} (30% margin)</span>
              <span style={{ color: costValid ? "var(--teal-dark)" : "var(--warn)", fontWeight: 700 }}>
                {costValid ? `Margin ${money.format(marginNow)} · ${marginPctNow}%` : `Cost must be 0–${money.format(price)}`}
              </span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Date</label>
              <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </div>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Time</label>
              <select value={time} onChange={(e) => setTime(e.target.value)} style={selectStyle}>
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

// ---------------------------------------------------------------------------
// THREAD — the property's conversation, this job's messages called out
// ---------------------------------------------------------------------------

export function JobThread({
  propertyId,
  jobId,
  ownerName,
  messages,
  serviceName,
}: {
  propertyId: string;
  jobId: string;
  ownerName: string | null;
  messages: OpsJobMessage[];
  serviceName: string | null;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftMock, setDraftMock] = useState(false);
  const [onlyThisJob, setOnlyThisJob] = useState(false);

  const aboutCount = messages.filter((m) => m.aboutThisJob).length;
  const shown = onlyThisJob ? messages.filter((m) => m.aboutThisJob) : messages;

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    // Annotated with the job so the reply reads in context on both sides.
    const res = await sendOpsMessage(propertyId, text, jobId);
    setSending(false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't send — try again.");
      return;
    }
    setBody("");
    setDraftMock(false);
    router.refresh();
  }

  // Drafting only fills the box — ops still reads it and clicks Send. The AI
  // never sends a message on its own from here.
  async function draft() {
    if (drafting) return;
    setDrafting(true);
    const res = await draftReplyForThread(propertyId);
    setDrafting(false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't draft a reply — try again.");
      return;
    }
    setBody(res.text ?? "");
    setDraftMock(!!res.mock);
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="ll-pill teal">Comments</span>
        {aboutCount > 0 && (
          <button
            className="ll-btn ghost sm"
            onClick={() => setOnlyThisJob((v) => !v)}
            aria-pressed={onlyThisJob}
          >
            {onlyThisJob ? "Show the whole thread" : `Only this job (${aboutCount})`}
          </button>
        )}
      </div>
      <p className="mut" style={{ fontSize: 12.5, margin: "8px 0 12px", lineHeight: 1.5 }}>
        One thread per property — the messages tagged
        {" "}
        <span className="ll-pill gold" style={{ fontSize: 10, padding: "1px 7px" }}>about this job</span>
        {" "}
        were written about the {serviceName ?? "service"} on this page.
      </p>

      {shown.length === 0 ? (
        <p className="mut" style={{ fontSize: 13.5 }}>
          Nothing said yet on this property. Anything you send lands in the homeowner&apos;s portal and their inbox.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 400, overflowY: "auto" }}>
          {shown.map((m) => {
            const ops = m.from === "ops";
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: ops ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "80%" }}>
                  <div
                    style={{
                      padding: "9px 12px", borderRadius: 12, fontSize: 14, lineHeight: 1.45,
                      whiteSpace: "pre-wrap", wordBreak: "break-word",
                      background: ops ? "#eef6f7" : "var(--sun-soft)",
                      border: `1px solid ${ops ? "var(--line)" : "#f0e3c6"}`,
                      boxShadow: m.aboutThisJob ? "0 0 0 2px var(--sun)" : "none",
                    }}
                  >
                    {m.body}
                  </div>
                  <div
                    className="mut"
                    style={{
                      fontSize: 11.5, marginTop: 3, display: "flex", flexWrap: "wrap",
                      justifyContent: ops ? "flex-end" : "flex-start", alignItems: "center", gap: 6,
                    }}
                  >
                    <span>{ops ? "LakeLife dispatch" : (ownerName ?? "Owner")} · {whenLabel(m.createdAt)}</span>
                    {m.aboutThisJob && (
                      <span className="ll-pill gold" style={{ fontSize: 10, padding: "1px 7px" }}>about this job</span>
                    )}
                    {m.ai && (
                      <span className="ll-pill slate" style={{ fontSize: 10, padding: "1px 7px" }}>AI · auto-answered</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 14 }}>
        <button className="ll-btn ghost sm" onClick={() => void draft()} disabled={drafting || sending}>
          {drafting ? "Drafting…" : "✨ Draft reply"}
        </button>
        {draftMock && (
          <span className="ll-pill slate" style={{ fontSize: 11 }}>
            draft: offline template — add ANTHROPIC_API_KEY for Claude
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <input
          style={{
            flex: 1, padding: "11px 13px", border: "1.5px solid var(--line)",
            borderRadius: 10, fontFamily: "inherit", fontSize: 14,
          }}
          placeholder="Reply to this homeowner…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={sending}
          aria-label="Reply to homeowner"
        />
        <button className="ll-btn gold" onClick={() => void send()} disabled={sending || !body.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
