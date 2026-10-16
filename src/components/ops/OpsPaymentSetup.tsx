"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  activateProcessorAccount, disableProcessorAccount, recordProcessorSubmission,
  type ProcessorAccountView,
} from "@/app/parks/processor-actions";

/**
 * GETTING A PARK PAID — the ops half.
 *
 * A park owner asks to be set up from his own setup screen; this is where
 * somebody acts on it. Without this panel the owner's request was a row
 * nobody looked at and the three actions behind it had no caller at all —
 * which the repo's own stranded-action scan refuses to let happen.
 *
 * TWO STEPS, BECAUSE THAT IS WHAT HAPPENS. A merchant id exists once an
 * application has been sent; the capabilities exist once it is approved. 0196
 * refuses an id before submission and refuses a live account without an id, a
 * day and a destination, so neither half can be filled in by guesswork.
 *
 * NOTHING HERE TALKS TO A PROCESSOR. Creating the merchant is one HTTP call
 * whose shape nobody has answered yet — it is Step 1 of the processor
 * roadmap. So this records what a person did with the processor's own
 * dashboard, which is the honest shape of a pilot and is exactly how the
 * first park will go live.
 */
export function OpsPaymentSetup({ queue }: { queue: ProcessorAccountView[] | null }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [merchantIds, setMerchantIds] = useState<Record<string, string>>({});
  const [last4s, setLast4s] = useState<Record<string, string>>({});
  const [rails, setRails] = useState<Record<string, { ach: boolean; card: boolean; payout: boolean }>>({});

  // A FAILED READ IS NOT AN EMPTY QUEUE. "No park is waiting" is the
  // reassuring way to be wrong about whether anybody can collect rent.
  if (queue === null) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill slate">Getting parks paid</span>
        <p style={{ fontSize: 14, margin: "10px 0 0", lineHeight: 1.55 }}>
          We couldn&apos;t read the payment setup queue. This panel is blank
          because the question went unanswered, not because nobody is waiting.
        </p>
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill slate">Getting parks paid</span>
        <p className="mut" style={{ fontSize: 13.5, margin: "10px 0 0", lineHeight: 1.55 }}>
          No park has asked to be set up to collect rent yet. When an owner
          asks from their own setup screen, they appear here.
        </p>
      </div>
    );
  }

  const waiting = queue.filter((a) => a.status !== "active");

  function act(key: string, run: () => Promise<{ ok: boolean; error?: string; signal?: string }>) {
    setBusy(key);
    start(async () => {
      const res = await run();
      setBusy(null);
      if (!res.ok) { toast.err(res.error ?? "That didn't work."); return; }
      toast(res.signal ?? "Done.");
      router.refresh();
    });
  }

  const rail = (id: string) => rails[id] ?? { ach: false, card: false, payout: false };

  return (
    <div
      className="ll-card ll-card-pad"
      style={{
        marginTop: 18,
        borderLeft: waiting.length > 0 ? "4px solid var(--gold)" : undefined,
      }}
    >
      <span className={`ll-pill ${waiting.length > 0 ? "gold" : "ok"}`}>
        Getting parks paid
      </span>
      <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>
        {waiting.length === 0
          ? `${queue.length} ${queue.length === 1 ? "park is" : "parks are"} collecting rent`
          : waiting.length === 1
            ? "1 park is waiting to collect rent"
            : `${waiting.length} parks are waiting to collect rent`}
      </h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.55 }}>
        Until a park&apos;s merchant is live its residents cannot pay in the
        app — the pay button stays hidden and every card would be refused.
        Rent settles to the park&apos;s own bank account, never to ours.
      </p>

      <div style={{ display: "grid", gap: 10 }}>
        {queue.map((a) => (
          <div
            key={a.id}
            style={{
              padding: "11px 13px", borderRadius: 10,
              background: a.status === "active" ? "transparent" : "var(--sand-light)",
              border: a.status === "active" ? "1px solid var(--line)" : "none",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
              <strong style={{ fontSize: 14, flex: "1 1 200px", minWidth: 0 }}>
                {a.parkName ?? "A park"}
              </strong>
              <span className="mut" style={{ fontSize: 12.5 }}>
                {a.provider}
                {a.merchantId ? ` · ${a.merchantId}` : ""}
                {a.status === "active" && a.settlementLast4
                  ? ` · settles to ••••${a.settlementLast4}`
                  : ""}
              </span>
            </div>

            {a.status === "draft" && (
              <div style={{ marginTop: 9 }}>
                <div className="mut" style={{ fontSize: 12.5, marginBottom: 6 }}>
                  They&apos;ve asked. Create the merchant with the processor,
                  then record the id it gave you.
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <input
                    value={merchantIds[a.id] ?? ""}
                    onChange={(e) => setMerchantIds((m) => ({ ...m, [a.id]: e.target.value }))}
                    placeholder="Merchant id from the processor"
                    style={{ flex: "1 1 220px", minWidth: 0 }}
                  />
                  <button
                    className="ll-btn"
                    style={{ flex: "0 0 auto", fontSize: 13, padding: "7px 12px" }}
                    disabled={busy === a.id || !(merchantIds[a.id] ?? "").trim()}
                    onClick={() => act(a.id, () =>
                      recordProcessorSubmission(a.id, merchantIds[a.id] ?? ""))}
                  >
                    {busy === a.id ? "Recording…" : "Record it"}
                  </button>
                </div>
              </div>
            )}

            {a.status === "submitted" && (
              <div style={{ marginTop: 9 }}>
                <div className="mut" style={{ fontSize: 12.5, marginBottom: 6 }}>
                  With the processor. Once they approve it, record what they
                  actually approved — not what we asked for.
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                  {([
                    ["ach", "Bank transfer in"],
                    ["card", "Card in"],
                    ["payout", "Payouts out"],
                  ] as const).map(([k, label]) => (
                    <label key={k} style={{ fontSize: 13, display: "flex", gap: 5, alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={rail(a.id)[k]}
                        onChange={(e) =>
                          setRails((r) => ({ ...r, [a.id]: { ...rail(a.id), [k]: e.target.checked } }))}
                      />
                      {label}
                    </label>
                  ))}
                  <input
                    value={last4s[a.id] ?? ""}
                    onChange={(e) => setLast4s((m) => ({ ...m, [a.id]: e.target.value }))}
                    placeholder="Settles to ••••"
                    inputMode="numeric"
                    maxLength={4}
                    style={{ width: 110 }}
                  />
                  <button
                    className="ll-btn"
                    style={{ fontSize: 13, padding: "7px 12px" }}
                    disabled={busy === a.id}
                    onClick={() => act(a.id, () => activateProcessorAccount(a.id, {
                      canAcceptAch: rail(a.id).ach,
                      canAcceptCard: rail(a.id).card,
                      canReceivePayout: rail(a.id).payout,
                      settlementLast4: last4s[a.id] ?? "",
                    }))}
                  >
                    {busy === a.id ? "Going live…" : "Mark it live"}
                  </button>
                </div>
              </div>
            )}

            {a.status === "active" && (
              <div className="mut" style={{ fontSize: 12.5, marginTop: 6 }}>
                Live ·{" "}
                {[a.canAcceptAch && "bank transfer in", a.canAcceptCard && "card in",
                  a.canReceivePayout && "payouts out"].filter(Boolean).join(" · ")}
              </div>
            )}

            {a.status !== "active" && (
              <button
                className="ll-btn ghost"
                style={{ fontSize: 12.5, padding: "5px 10px", marginTop: 8 }}
                disabled={busy === `off:${a.id}`}
                onClick={() => act(`off:${a.id}`, () =>
                  disableProcessorAccount(a.id, "closed from the ops console"))}
              >
                {busy === `off:${a.id}` ? "Closing…" : "Close this setup"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
