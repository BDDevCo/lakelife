"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";

export function VerifyPanel({ initialPhone }: { initialPhone?: string }) {
  const router = useRouter();
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsPhone, setNeedsPhone] = useState(!initialPhone);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);

  // Pull the number saved during email signup, if any.
  useEffect(() => {
    if (!initialPhone) {
      try {
        const saved = sessionStorage.getItem("ll_pending_phone");
        if (saved) {
          setPhone(saved);
          setNeedsPhone(false);
        }
      } catch {}
    }
  }, [initialPhone]);

  // If we already know the number, text the code automatically — the customer
  // shouldn't have to ask for something they clearly came here to get.
  // (Session-flagged so refreshes/re-mounts don't burn extra texts.)
  const autoSent = useRef(false);
  useEffect(() => {
    if (autoSent.current || sent) return;
    const number = initialPhone || (() => { try { return sessionStorage.getItem("ll_pending_phone") ?? ""; } catch { return ""; } })();
    if (!number) return;
    let alreadySent = false;
    try { alreadySent = sessionStorage.getItem("ll_code_autosent") === "1"; } catch {}
    if (alreadySent) return;
    autoSent.current = true;
    try { sessionStorage.setItem("ll_code_autosent", "1"); } catch {}
    void sendCode(number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPhone, sent]);

  async function sendCode(toNumber: string) {
    if (!toNumber.trim()) {
      setNeedsPhone(true);
      toast("Enter your mobile number first.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/verify/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: toNumber }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast(body.error ?? "Could not send the code.");
      return;
    }
    setSent(true);
    setNeedsPhone(false);
    toast("Code texted. Enter the 6 digits below.");
  }

  function onDigit(i: number, val: string) {
    const cleaned = val.replace(/\D/g, "");
    // iOS SMS auto-fill (or a paste) can drop the whole code into one box —
    // spread it across all six instead of losing it.
    if (cleaned.length > 1) {
      fillCode(cleaned);
      return;
    }
    const next = [...digits];
    next[i] = cleaned;
    setDigits(next);
    if (cleaned && i < 5) boxes.current[i + 1]?.focus();
  }

  function fillCode(codeDigits: string) {
    const six = codeDigits.slice(0, 6).split("");
    const next = ["", "", "", "", "", ""].map((_, i) => six[i] ?? "");
    setDigits(next);
    boxes.current[Math.min(six.length, 5)]?.focus();
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
    if (pasted.length >= 2) {
      e.preventDefault();
      fillCode(pasted);
    }
  }

  function onKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
  }

  async function verify() {
    const code = digits.join("");
    if (code.length !== 6) {
      toast("Enter all 6 digits.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/verify/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast(body.error ?? "Verification failed.");
      return;
    }
    try {
      sessionStorage.removeItem("ll_pending_phone");
    } catch {}
    toast("Mobile verified — you're all set!");
    router.push("/welcome");
  }

  return (
    <div className="ll-modal" style={{ margin: "0 auto" }}>
      <div className="ll-modal-head">
        <div>
          <span className="ll-pill teal">Verify your mobile</span>
          <h3 style={{ fontSize: 22, marginTop: 8 }}>
            {sent ? "Enter the code we texted" : "Confirm your mobile number"}
          </h3>
          <div className="mut" style={{ marginTop: 4, fontSize: 13 }}>
            {sent
              ? `Sent to ${phone} — this is the number we'll text when a crew is on the way and when work is complete.`
              : "We text you a code. This is the number we'll use when a crew is on the way and when work is complete."}
          </div>
        </div>
      </div>

      <div className="ll-modal-body">
        {needsPhone && !sent && (
          <div className="ll-field">
            <label>Mobile number</label>
            <input
              inputMode="tel"
              placeholder="(260) 555-0100"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        )}

        {!sent ? (
          <button
            className="ll-btn"
            style={{ width: "100%" }}
            onClick={() => sendCode(phone)}
            disabled={busy}
          >
            {busy ? "Texting…" : "Text me a code"}
          </button>
        ) : (
          <>
            <div className="ll-code-row">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  className="ll-code-box"
                  inputMode="numeric"
                  maxLength={i === 0 ? 6 : 1}
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  value={d}
                  onChange={(e) => onDigit(i, e.target.value)}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  onPaste={onPaste}
                  aria-label={`Digit ${i + 1}`}
                />
              ))}
            </div>
            <button
              className="ll-btn"
              style={{ width: "100%" }}
              onClick={verify}
              disabled={busy}
            >
              {busy ? "Verifying…" : "Verify & continue"}
            </button>
            <div style={{ textAlign: "center", marginTop: 12, display: "flex", gap: 8, justifyContent: "center" }}>
              <button
                className="ll-btn ghost sm"
                onClick={() => sendCode(phone)}
                disabled={busy}
              >
                Resend code
              </button>
              <button
                className="ll-btn ghost sm"
                onClick={() => {
                  setSent(false);
                  setNeedsPhone(true);
                  setDigits(["", "", "", "", "", ""]);
                }}
                disabled={busy}
              >
                Wrong number?
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
