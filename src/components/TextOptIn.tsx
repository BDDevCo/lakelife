"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startTextOptIn, confirmTextOptIn, stopTexts } from "@/app/parks/consent-actions";
import { smsConsentText, SMS_OPT_IN_BLURB } from "@/lib/sms-consent";

/**
 * WHERE A RESIDENT GIVES US A NUMBER, ON PURPOSE.
 *
 * The park has had a phone number for this household all along — off whatever
 * records came with the place — and the software has never been allowed to
 * dial it, correctly. This is the only door that changes that, and only she
 * can open it.
 *
 * OFF IS THE RESTING STATE AND COSTS NOTHING. Everything already works by
 * email and on paper; this adds a channel, it does not unlock the product. So
 * the panel is quiet, sits below her rent, and never nags.
 */
export function TextOptIn({
  parkName, on, number,
}: {
  parkName: string;
  /** Consent recorded — the only thing the send path actually reads. */
  on: boolean;
  /** The number she gave us, when she has. */
  number: string | null;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"idle" | "code_sent">("idle");
  const [said, setSaid] = useState<string | null>(null);

  function send() {
    start(async () => {
      const r = await startTextOptIn(phone);
      setSaid(r.message);
      if (r.ok) setStep("code_sent");
    });
  }

  function confirm() {
    start(async () => {
      const r = await confirmTextOptIn(phone, code);
      setSaid(r.message);
      if (r.ok) { setStep("idle"); setCode(""); router.refresh(); }
    });
  }

  function off() {
    start(async () => {
      const r = await stopTexts();
      setSaid(r.message);
      if (r.ok) router.refresh();
    });
  }

  if (on) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
        <strong style={{ fontSize: 15 }}>Texts are on</strong>
        <p className="mut" style={{ fontSize: 14, margin: "6px 0 12px", lineHeight: 1.55 }}>
          We&apos;ll text {number ?? "your mobile"} about your lot and your rent.
        </p>
        {/* AS EASY TO STOP AS IT WAS TO START. One tap, no reason asked, no
            "are you sure" — a consent you have to argue your way out of was
            never really consent. */}
        <button className="ll-btn ghost sm" disabled={busy} onClick={off} style={{ minHeight: 40 }}>
          {busy ? "…" : "Stop texting me"}
        </button>
        {said && <p className="mut" role="status" style={{ fontSize: 13.5, marginTop: 10 }}>{said}</p>}
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <strong style={{ fontSize: 15 }}>Want a text when your rent&apos;s due?</strong>
      <p className="mut" style={{ fontSize: 14, margin: "6px 0 12px", lineHeight: 1.55 }}>
        {SMS_OPT_IN_BLURB}
      </p>

      {step === "idle" ? (
        <>
          <label className="ll-field" style={{ marginBottom: 10, maxWidth: 300 }}>
            <span>Your mobile number</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(260) 555-0142"
              inputMode="tel"
              autoComplete="tel"
              onKeyDown={(e) => { if (e.key === "Enter" && phone.trim()) send(); }}
            />
          </label>
          {/* THE SENTENCE THAT GETS RECORDED, SHOWN BEFORE THE TAP. Same
              string, from the same constant, so the record can never describe
              something she wasn't shown. */}
          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 12px", lineHeight: 1.5, maxWidth: 460 }}>
            {smsConsentText(parkName)}
          </p>
          <button className="ll-btn" disabled={busy || !phone.trim()} onClick={send} style={{ minHeight: 44 }}>
            {busy ? "Sending…" : "Send me a code"}
          </button>
        </>
      ) : (
        <>
          <label className="ll-field" style={{ marginBottom: 10, maxWidth: 220 }}>
            <span>The six digits we just texted</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              style={{ fontSize: 22, letterSpacing: "0.16em", fontVariantNumeric: "tabular-nums" }}
              onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) confirm(); }}
            />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ll-btn" disabled={busy || !code.trim()} onClick={confirm} style={{ minHeight: 44 }}>
              {busy ? "Checking…" : "Turn texts on"}
            </button>
            <button className="ll-btn ghost" disabled={busy} onClick={() => { setStep("idle"); setSaid(null); }} style={{ minHeight: 44 }}>
              Use a different number
            </button>
          </div>
        </>
      )}

      {said && (
        <p role="status" className="mut" style={{ fontSize: 13.5, marginTop: 12, lineHeight: 1.5 }}>
          {said}
        </p>
      )}
    </div>
  );
}
