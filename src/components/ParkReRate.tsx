"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  previewReRate, scheduleReRate, recordNotice, cancelReRate,
  type PendingReRate,
} from "@/app/park/rerate-actions";
import { reRateSummary, type ReRatePlan } from "@/app/park/rerate-helpers";

/**
 * CHANGING THE RENT ON PEOPLE WHO ALREADY LIVE THERE.
 *
 * The screen's whole job is to make him look at two numbers before he commits:
 * how many HOUSEHOLDS this touches, and how big the largest single jump is.
 * The money is the number he wants; those two are the ones that decide whether
 * he does it all at once or staggers it, and the software should not bury them
 * under a total.
 */

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const METHODS = [
  { value: "letter", label: "Letter in the mail" },
  { value: "hand", label: "Handed to them" },
  { value: "posted", label: "Posted on the door" },
  { value: "email", label: "Email" },
  { value: "sms", label: "Text" },
] as const;

export function ParkReRate({
  parkId, noticeDays, pending, todayISO,
}: {
  parkId: string;
  noticeDays: number;
  pending: PendingReRate[];
  todayISO: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [plan, setPlan] = useState<ReRatePlan | null>(null);
  const [busy, start] = useTransition();

  function preview() {
    start(async () => {
      const n = Number(amount.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n)) { toast("That new rent isn't a number."); return; }
      const res = await previewReRate(parkId, [], n, effectiveOn);
      if (!res.ok || !res.preview) { toast(res.error ?? "Couldn't work that out."); return; }
      setPlan(res.preview.plan);
    });
  }

  function schedule() {
    start(async () => {
      const n = Number(amount.replace(/[$,\s]/g, ""));
      const res = await scheduleReRate(parkId, [], n, effectiveOn);
      if (!res.ok) { toast(res.error ?? "Couldn't schedule that."); return; }
      toast(res.signal ?? "Scheduled.");
      setOpen(false); setPlan(null); setAmount(""); setEffectiveOn("");
      router.refresh();
    });
  }

  return (
    <section style={{ marginBottom: 22 }}>
      {/* ---- anything already scheduled, and whether it has been served ---- */}
      {pending.map((p) => (
        <div key={p.effectiveOn} className="ll-card ll-card-pad" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <strong>
                {p.count} {p.count === 1 ? "rent goes" : "rents go"} to {money(p.toAmount)} on {p.effectiveOn}
              </strong>
              <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
                {money(p.monthlyDelta)} more a month
              </div>
            </div>
            <span className={`ll-pill ${p.noticeGivenOn ? "" : "warn"}`}>
              {p.noticeGivenOn ? `Noticed ${p.noticeGivenOn}` : "Nobody told yet"}
            </span>
          </div>

          {!p.noticeGivenOn && (
            <>
              <p className="mut" style={{ fontSize: 13, margin: "10px 0", lineHeight: 1.5 }}>
                This can&apos;t take effect until you&apos;ve given notice and told us
                when. Your notice period is <strong>{p.noticeDaysRequired} days</strong>.
              </p>
              <NoticeForm
                parkId={parkId}
                effectiveOn={p.effectiveOn}
                todayISO={todayISO}
                onDone={() => router.refresh()}
              />
            </>
          )}

          <button
            className="ll-btn ghost"
            style={{ marginTop: 10 }}
            disabled={busy}
            onClick={() =>
              start(async () => {
                const res = await cancelReRate(parkId, p.effectiveOn);
                toast(res.ok ? (res.signal ?? "Called off.") : (res.error ?? "Couldn't cancel."));
                router.refresh();
              })
            }
          >
            Call it off
          </button>
        </div>
      ))}

      {!open ? (
        <button className="ll-btn ghost" onClick={() => setOpen(true)}>
          Change the rent on everyone
        </button>
      ) : (
        <div className="ll-card ll-card-pad">
          <h3 style={{ fontSize: 17, margin: "0 0 4px" }}>Change the rent on everyone</h3>
          <p className="mut" style={{ fontSize: 13, margin: "0 0 14px", lineHeight: 1.5 }}>
            This changes what people already living here pay. Nobody&apos;s rent
            moves today — you pick when it starts, and it can&apos;t start inside
            your {noticeDays}-day notice period.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">New rent, monthly</span>
              <input value={amount} inputMode="decimal" placeholder="400"
                onChange={(e) => { setAmount(e.target.value); setPlan(null); }}
                style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Starts on</span>
              <input type="date" value={effectiveOn}
                onChange={(e) => { setEffectiveOn(e.target.value); setPlan(null); }}
                style={{ marginTop: 4 }} />
            </label>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button className="ll-btn ghost" onClick={preview} disabled={busy || !amount || !effectiveOn}>
              {busy ? "Working…" : "Show me what changes"}
            </button>
            <button className="ll-btn ghost" onClick={() => { setOpen(false); setPlan(null); }}>
              Cancel
            </button>
          </div>

          {plan && (
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              {plan.tooSoon ? (
                <p style={{ margin: 0, lineHeight: 1.5 }}>
                  <strong>That&apos;s too soon.</strong>{" "}
                  <span className="mut">
                    Your notice period is {noticeDays} days, so the earliest this
                    can start is <strong>{plan.earliestEffective}</strong>.
                  </span>
                </p>
              ) : (
                <>
                  {/* The households and the worst jump, ABOVE the money. */}
                  <p style={{ margin: "0 0 10px", fontSize: 16 }}>{reRateSummary(plan)}</p>
                  {plan.biggestIncreasePct != null && plan.biggestIncreasePct >= 25 && (
                    <p className="mut" style={{ margin: "0 0 10px", lineHeight: 1.5 }}>
                      An increase that size lands differently on a household than
                      it does on a spreadsheet. If you&apos;d rather do it in two
                      steps, schedule a smaller one now and another later.
                    </p>
                  )}
                  <div style={{ display: "grid", gap: 2, fontVariantNumeric: "tabular-nums", marginBottom: 12 }}>
                    <Row label="they pay now" value={money(plan.monthlyBefore)} />
                    <Row label="they'd pay" value={money(plan.monthlyAfter)} strong />
                  </div>

                  {plan.changing.length > 0 && (
                    <div className="ll-card" style={{ marginBottom: 12 }}>
                      {plan.changing.map((l) => (
                        <div key={l.reservationId}
                          style={{ padding: "8px 12px", borderTop: "1px solid rgba(0,0,0,.06)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <strong style={{ minWidth: 62 }}>Lot {l.lotLabel}</strong>
                          <span className="mut" style={{ flex: 1 }}>
                            {l.from == null ? "no rent set" : money(l.from)} → {money(l.to)}
                          </span>
                          {l.from != null && l.from > 0 && (
                            <span className="mut">+{Math.round(((l.to - l.from) / l.from) * 100)}%</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {plan.skipped.length > 0 && (
                    <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
                      {plan.skipped.length} left alone — already at that rent, not
                      monthly, or nobody on the lot.
                    </p>
                  )}

                  <p className="mut" style={{ fontSize: 13, lineHeight: 1.5 }}>
                    Scheduling this tells nobody. You serve notice yourself, then
                    record when and how you did it.
                  </p>

                  <button className="ll-btn" onClick={schedule} disabled={busy || plan.changing.length === 0}>
                    Schedule it for {effectiveOn}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function NoticeForm({
  parkId, effectiveOn, todayISO, onDone,
}: {
  parkId: string; effectiveOn: string; todayISO: string; onDone: () => void;
}) {
  const [givenOn, setGivenOn] = useState(todayISO);
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("letter");
  const [busy, start] = useTransition();

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
        <span className="mut">Notice went out</span>
        <input type="date" value={givenOn} onChange={(e) => setGivenOn(e.target.value)} style={{ marginTop: 4 }} />
      </label>
      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
        <span className="mut">How</span>
        <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} style={{ marginTop: 4 }}>
          {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <button
          className="ll-btn"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await recordNotice(parkId, effectiveOn, givenOn, method);
              toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't record that."));
              if (res.ok) onDone();
            })
          }
        >
          Record it
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ minWidth: 96, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{value}</span>
      <span className="mut">{label}</span>
    </div>
  );
}
