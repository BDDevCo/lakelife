"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimMyFile } from "@/app/parks/claim-actions";

/**
 * THE SCREEN SOMEBODY READS IN THEIR KITCHEN.
 *
 * She is 78, she has lived on lot 14 for eleven years, she pays by cheque, and
 * the park owner is standing beside her. Everything here is shaped by that:
 *
 *   * THREE FIELDS, NO ACCOUNT-BUILDING. Park, lot, code. Nothing is asked
 *     that she would have to go and find — she knows her lot number, and the
 *     other two are printed on the slip in her hand.
 *   * THE PARK IS PRE-FILLED when we can tell which one she means, so in the
 *     normal case it is two fields.
 *   * NO COUNTDOWN, NO ATTEMPT COUNTER ON SCREEN. The database locks after
 *     five tries; showing "2 of 5" turns a form into a test she can fail.
 *   * A WAY OUT THAT IS NOT FAILURE. "I'd rather not do this" is a real
 *     answer, on the screen, in the same size type as the button. 0055 is
 *     explicit that paper is permanent and respectable, and a quarter to a
 *     third of a park never converts. That must not read as her falling at a
 *     hurdle.
 */
export function ClaimMyLot({
  parkSlug, parkName, presetCode,
}: {
  parkSlug?: string;
  parkName?: string;
  /** Carried by the QR square on the slip, so only the lot number is left. */
  presetCode?: string;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState(parkSlug ?? "");
  const [lot, setLot] = useState("");
  const [code, setCode] = useState(presetCode ?? "");
  const [said, setSaid] = useState<{ ok: boolean; message: string; reprintable?: boolean } | null>(null);
  const [busy, start] = useTransition();
  const [optedOut, setOptedOut] = useState(false);

  function submit() {
    start(async () => {
      const res = await claimMyFile({ parkSlug: slug, lotNumber: lot, code });
      setSaid(res);
      if (res.ok) {
        // Straight to their own screen. No "success!" interstitial — the proof
        // that it worked is their lot and their rent being there.
        router.push("/parks/my");
        router.refresh();
      }
    });
  }

  if (optedOut) {
    return (
      <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
        <h2 style={{ fontSize: 20, margin: "0 0 8px" }}>That&apos;s absolutely fine 🌊</h2>
        <p style={{ fontSize: 15, lineHeight: 1.6, margin: 0 }}>
          Nothing changes. You pay the way you always have, and the office has
          your details exactly as before. If you ever want to look at your rent
          on a phone, ask them for a new slip — there&apos;s no rush and no
          deadline.
        </p>
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
      <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>
        See your lot{parkName ? ` at ${parkName}` : ""}
      </h2>
      <p className="mut" style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 18px" }}>
        The office will have given you a slip with a code on it. Enter it here
        and your lot, your rent and your receipts appear on this phone. It
        doesn&apos;t change how you pay.
      </p>

      {!parkSlug && (
        <label className="ll-field" style={{ marginBottom: 12 }}>
          <span>Park</span>
          <input
            value={slug}
            placeholder="the-haven"
            autoCapitalize="none"
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
      )}

      <label className="ll-field" style={{ marginBottom: 12 }}>
        <span>Your lot number</span>
        <input
          value={lot}
          placeholder="14"
          inputMode="numeric"
          onChange={(e) => setLot(e.target.value)}
        />
      </label>

      <label className="ll-field" style={{ marginBottom: 6 }}>
        <span>The code on your slip</span>
        <input
          value={code}
          placeholder="K7QM-3XR9"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          // Big and spaced: this is read off paper and typed with a thumb.
          style={{ fontSize: 22, letterSpacing: "0.12em", fontVariantNumeric: "tabular-nums" }}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
      </label>
      <p className="mut" style={{ fontSize: 12.5, margin: "0 0 16px" }}>
        {presetCode
          ? "That came from the square you scanned — just your lot number to go."
          : "Upper or lower case is fine, and the dash is optional."}
      </p>

      {said && (
        <div
          role="status"
          style={{
            margin: "0 0 14px", padding: "12px 14px", borderRadius: 10,
            background: said.ok ? "var(--mint, #eaf7f0)" : "var(--sand, #fdf6ec)",
            fontSize: 15, lineHeight: 1.55,
          }}
        >
          {said.message}
          {said.reprintable && (
            <div className="mut" style={{ fontSize: 13, marginTop: 6 }}>
              Nothing is wrong at your end — a new slip takes them a moment.
            </div>
          )}
        </div>
      )}

      <button
        className="ll-btn"
        style={{ width: "100%", minHeight: 52, fontSize: 17 }}
        disabled={busy || !lot.trim() || !code.trim() || (!parkSlug && !slug.trim())}
        onClick={submit}
      >
        {busy ? "Checking…" : "See my lot"}
      </button>

      {/* THE WAY OUT, IN THE SAME TYPE SIZE AS EVERYTHING ELSE. Not a footnote
          and not greyed out — declining is a first-class answer, and a screen
          that hides it is a screen that pressures somebody's landlord's
          tenant. */}
      <button
        onClick={() => setOptedOut(true)}
        style={{
          display: "block", width: "100%", marginTop: 14, padding: "10px 0",
          background: "none", border: "none", cursor: "pointer",
          fontSize: 15, color: "var(--sub)", textDecoration: "underline",
        }}
      >
        I&apos;d rather not do this
      </button>
    </div>
  );
}
