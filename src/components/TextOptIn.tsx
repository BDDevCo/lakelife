"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startTextOptIn, confirmTextOptIn, stopTexts } from "@/app/parks/consent-actions";
import { smsConsentText, SMS_OPT_IN_BLURB } from "@/lib/sms-consent";
import { CodeBoxes } from "@/components/CodeBoxes";
import { prettyPhone } from "@/lib/phone";

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
  /**
   * THE TICK. It starts unticked, and it gates the button.
   *
   * There wasn't one. The consent sentence was rendered at 12.5px in the muted
   * grey — the faintest thing on the card — under the phone field and above a
   * button labelled "Send me a code", and tapping that button was the whole of
   * the affirmative act. Meanwhile `docs/a2p-registration.md` tells The
   * Campaign Registry, in a filing we have to be able to defend, that
   * "residents additionally tick an explicit consent line". Nobody ticked
   * anything. Either the sentence in the filing had to go or the tick had to
   * exist, and the tick is the one that makes the consent unarguable.
   */
  const [agreed, setAgreed] = useState(false);
  const [step, setStep] = useState<"idle" | "code_sent">("idle");
  const [said, setSaid] = useState<string | null>(null);

  function send() {
    start(async () => {
      const r = await startTextOptIn(phone);
      setSaid(r.message);
      if (r.ok) setStep("code_sent");
    });
  }

  // Takes the code rather than reading it — see the same note in VerifyPanel.
  // onComplete fires in the tick that sets it, so the state here is one
  // keystroke behind.
  function confirm(submitted?: string) {
    start(async () => {
      const r = await confirmTextOptIn(phone, submitted ?? code);
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
          We&apos;ll text {number ? prettyPhone(number) : "your mobile"} about your lot and your rent.
        </p>
        {/* AS EASY TO STOP AS IT WAS TO START. One tap, no reason asked, no
            "are you sure" — a consent you have to argue your way out of was
            never really consent. */}
        <button className="ll-btn ghost sm" disabled={busy} onClick={off} style={{ minHeight: 40 }}>
          {busy ? "Stopping…" : "Stop texting me"}
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
          <label className="ll-field" style={{ display: "block", fontSize: 13, marginBottom: 10, maxWidth: 300 }}>
            <span className="mut">Your mobile number</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(260) 555-0142"
              inputMode="tel"
              autoComplete="tel"
              style={{ marginTop: 4 }}
              onKeyDown={(e) => { if (e.key === "Enter" && phone.trim()) send(); }}
            />
          </label>
          {/* THE SENTENCE THAT GETS RECORDED, SHOWN BEFORE THE TAP, WITH THE
              BOX THAT MAKES AGREEING TO IT AN ACT. Same string, from the same
              constant, so the record can never describe something she wasn't
              shown — and now at 14px in the body colour rather than 12.5px
              grey, because the legally operative sentence on the card should
              not be the hardest one on it to read. */}
          <label
            style={{
              display: "flex", gap: 10, alignItems: "flex-start",
              margin: "0 0 14px", maxWidth: 460, cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              // 22px, not the 13px default: this is the target a
              // seventy-year-old has to hit with a thumb.
              style={{ width: 22, height: 22, marginTop: 1, flexShrink: 0, accentColor: "var(--teal)" }}
            />
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>{smsConsentText(parkName)}</span>
          </label>
          <button
            className="ll-btn"
            disabled={busy || !phone.trim() || !agreed}
            onClick={send}
            style={{ minHeight: 44 }}
          >
            {busy ? "Sending…" : "Send me a code"}
          </button>
        </>
      ) : (
        <>
          {/* THE SAME SIX BOXES THE SIGN-UP CHECK USES.
              This was one plain input with a "123456" placeholder — the same
              person, doing the same thing two screens apart, got the worse
              version here: no spreading of an iOS auto-fill, no paste
              handling, and a caret to manage by thumb. */}
          <p className="mut" style={{ fontSize: 14, margin: "0 0 4px" }}>
            The six digits we just texted
          </p>
          <CodeBoxes
            value={code}
            onChange={setCode}
            onComplete={(c) => confirm(c)}
            label="The six digits we just texted"
            disabled={busy}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ll-btn" disabled={busy || code.length !== 6} onClick={() => confirm()} style={{ minHeight: 44 }}>
              {busy ? "Checking…" : "Turn texts on"}
            </button>
            <button className="ll-btn ghost" disabled={busy} onClick={send} style={{ minHeight: 44 }}>
              Resend code
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
