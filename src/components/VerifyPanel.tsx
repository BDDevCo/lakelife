"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { CodeBoxes } from "@/components/CodeBoxes";
import { safeNext } from "@/lib/safe-next";

export function VerifyPanel({
  initialPhone,
  next,
}: {
  initialPhone?: string;
  /** Where they were headed before the account existed. Same-origin only. */
  next?: string;
}) {
  const router = useRouter();
  const [phone, setPhone] = useState(initialPhone ?? "");
  // ONE STRING, NOT SIX SLOTS. CodeBoxes owns the boxes and the focus; this
  // only ever holds what gets sent.
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsPhone, setNeedsPhone] = useState(!initialPhone);

  // Pull the number saved during email signup, if any.
  //
  // THIS ONE STAYS AN EFFECT, and the rule is wrong about it. sessionStorage
  // does not exist on the server, so this cannot move into initial state or
  // into render without either crashing the server render or producing markup
  // that disagrees with the browser's. Reading browser storage after mount is
  // what an effect is for.
  //
  // Nor is useSyncExternalStore the answer here, as it was for the map button:
  // this read decides TWO pieces of state and only when `initialPhone` is
  // absent, which is a conditional side effect rather than an external value
  // to subscribe to.
  //
  // A one-render delay costs nothing visible: the field is empty either way,
  // and the customer is reading the sentence above it.
  useEffect(() => {
    if (!initialPhone) {
      try {
        const saved = sessionStorage.getItem("ll_pending_phone");
        if (saved) {
          // The disable sits HERE, on the call the rule actually reports,
          // rather than on the useEffect above it. Put it on the effect and it
          // silences nothing — which looks like a fix until the next lint run.
          // eslint-disable-next-line react-hooks/set-state-in-effect
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


  // TAKES THE CODE, RATHER THAN READING IT.
  // CodeBoxes fires onComplete in the same tick it calls onChange, so `code`
  // in this closure is still the five digits from before the last keystroke.
  // Auto-submit would have sent a short code and reported it as wrong.
  async function verify(submitted?: string) {
    const entered = submitted ?? code;
    if (entered.length !== 6) {
      toast("Enter all 6 digits.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/verify/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code: entered }),
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
    router.push(safeNext(next) ?? "/welcome");
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
            <CodeBoxes
              value={code}
              onChange={setCode}
              onComplete={(c) => verify(c)}
              label="The six digits we just texted"
              disabled={busy}
            />
            <button
              className="ll-btn"
              style={{ width: "100%" }}
              onClick={() => verify()}
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
                  setCode("");
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
