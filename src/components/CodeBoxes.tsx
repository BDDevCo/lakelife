"use client";

import { useRef } from "react";

/**
 * SIX BOXES FOR A SIX-DIGIT CODE, IN ONE PLACE.
 *
 * There were two six-digit code entries in the app and they were not the same
 * thing. `VerifyPanel` — the mobile check every account passes before its
 * first booking — had this: six boxes, focus advancing as you type, backspace
 * walking back, a paste or an iOS auto-fill spreading across all six, and
 * `one-time-code` so the keyboard offers the code from the message.
 * `TextOptIn` — the resident turning texts on for her lot — had ONE plain
 * input with a placeholder, so the same person doing the same thing two
 * screens apart got a worse version the second time: no auto-fill, no paste
 * handling, and a caret to manage by thumb.
 *
 * Extracting it rather than copying it is the whole point. A copy would have
 * given the app two implementations that drift; this gives it one, and the
 * next screen that needs a code gets the good one by default.
 *
 * CONTROLLED, AND THE CALLER OWNS THE VALUE. It hands back a plain string of
 * up to six digits — never an array, never the boxes — so a caller can hold it
 * in whatever shape it already uses and send it unchanged.
 */
export function CodeBoxes({
  value,
  onChange,
  onComplete,
  label = "Verification code",
  disabled = false,
}: {
  /** Up to six digits. Anything else is ignored on the way in. */
  value: string;
  onChange: (next: string) => void;
  /** Fired once six digits are present — lets a caller submit without a tap. */
  onComplete?: (code: string) => void;
  /** Names the GROUP for a screen reader; each box is "Digit n" under it. */
  label?: string;
  disabled?: boolean;
}) {
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");

  function push(next: string) {
    const clean = next.replace(/\D/g, "").slice(0, 6);
    onChange(clean);
    if (clean.length === 6) onComplete?.(clean);
    return clean;
  }

  function fill(raw: string) {
    const clean = push(raw);
    boxes.current[Math.min(clean.length, 5)]?.focus();
  }

  function onDigit(i: number, raw: string) {
    const cleaned = raw.replace(/\D/g, "");
    // iOS SMS auto-fill (or a paste) can drop the whole code into one box —
    // spread it across all six instead of losing it.
    if (cleaned.length > 1) {
      fill(cleaned);
      return;
    }
    const next = [...digits];
    next[i] = cleaned;
    push(next.join("").slice(0, 6));
    if (cleaned && i < 5) boxes.current[i + 1]?.focus();
  }

  return (
    <div className="ll-code-row" role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          className="ll-code-box"
          inputMode="numeric"
          disabled={disabled}
          // The first box accepts all six so a paste or an auto-fill lands
          // somewhere it can be spread from.
          maxLength={i === 0 ? 6 : 1}
          autoComplete={i === 0 ? "one-time-code" : "off"}
          value={d}
          onChange={(e) => onDigit(i, e.target.value)}
          onKeyDown={(e) => {
            // Backspace on an empty box walks back, which is what a thumb
            // expects and what a single input cannot offer.
            if (e.key === "Backspace" && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
            if (e.key === "ArrowLeft" && i > 0) boxes.current[i - 1]?.focus();
            if (e.key === "ArrowRight" && i < 5) boxes.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
            if (pasted.length >= 2) {
              e.preventDefault();
              fill(pasted);
            }
          }}
          aria-label={`Digit ${i + 1}`}
        />
      ))}
    </div>
  );
}
