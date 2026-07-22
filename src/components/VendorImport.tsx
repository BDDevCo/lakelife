"use client";

/**
 * "Bring your customers over" — a crew pastes their existing book of business and
 * LakeLife emails each one a warm invite to claim their account, with this crew
 * pre-set as their preferred. The parsing is a PURE import (parseCustomers), so
 * we run it client-side on every keystroke for a live "N ready · M skipped"
 * count — no server round-trip until they tap Send invites.
 */

import { useMemo, useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { parseCustomers } from "@/app/vendor/import-helpers";
import { importMyCustomers, type ImportResult } from "@/app/vendor/import-actions";

const PLACEHOLDER = `Jane Smith, jane@email.com, 123 Lakeshore Dr, 260-555-0142
Tom Portage, tom@email.com, 456 Pier Rd
mary@email.com`;

export function VendorImport() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [pending, startTransition] = useTransition();

  // Pure parse on every keystroke — safe in the client, no network.
  const preview = useMemo(() => parseCustomers(text), [text]);
  const ready = preview.valid.length;
  const skipped = preview.invalid.length;

  function send() {
    startTransition(async () => {
      const res = await importMyCustomers(text);
      if (!res.ok) {
        toast(res.error ?? "Couldn't send those invites.");
        return;
      }
      setResult(res);
      setShowSkipped(false);
    });
  }

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 620 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Bring your customers over</h1>
      <p className="mut" style={{ fontSize: 14, marginBottom: 18, maxWidth: 560 }}>
        Paste your customer list below — one per line: <b>Name, Email, Address, Phone</b>{" "}
        (email is the only must-have). We&apos;ll email each of them an invite to claim
        their account, and you stay their preferred crew — first on their jobs. 🌊
      </p>

      <div className="ll-card ll-card-pad">
        <label className="ll-field" style={{ display: "block", marginBottom: 6 }}>
          <span style={{
            display: "block", fontSize: 12.5, fontWeight: 700,
            color: "var(--sub)", marginBottom: 6,
          }}>
            Your customers — one per line
          </span>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null); }}
            placeholder={PLACEHOLDER}
            rows={9}
            disabled={pending}
            style={{
              width: "100%", padding: "11px 13px", border: "1.5px solid var(--line)",
              borderRadius: 10, fontSize: 16, fontFamily: "inherit", color: "var(--text)",
              background: "#fff", resize: "vertical", lineHeight: 1.5, minHeight: 160,
            }}
          />
        </label>

        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 8, marginTop: 2, marginBottom: 14, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--sub)" }}>
            {ready > 0 || skipped > 0 ? (
              <>
                <span style={{ color: "var(--teal-dark)" }}>{ready} ready</span>
                {skipped > 0 && <span className="mut"> · {skipped} skipped</span>}
              </>
            ) : (
              <span className="mut">Nothing to send yet</span>
            )}
          </span>
        </div>

        <button
          className="ll-btn gold"
          onClick={send}
          disabled={pending || ready === 0}
          style={{ width: "100%", minHeight: 48 }}
        >
          {pending ? "Sending…" : ready > 0 ? `Send ${ready} invite${ready === 1 ? "" : "s"}` : "Send invites"}
        </button>

        {result && result.ok && (
          <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <p style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--teal-dark)" }}>
              ✓ Invited {result.invited ?? 0} customer{(result.invited ?? 0) === 1 ? "" : "s"}
            </p>
            {(result.skipped ?? 0) > 0 && (
              <>
                <button
                  onClick={() => setShowSkipped((s) => !s)}
                  className="mut"
                  style={{
                    background: "none", border: "none", padding: "8px 0 0", cursor: "pointer",
                    fontSize: 13, fontWeight: 700, color: "var(--sub)", textDecoration: "underline",
                  }}
                >
                  {showSkipped ? "Hide" : "Show"} {result.skipped} skipped
                </button>
                {showSkipped && (
                  <ul className="mut" style={{ fontSize: 13, margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
                    {(result.skippedReasons ?? []).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
