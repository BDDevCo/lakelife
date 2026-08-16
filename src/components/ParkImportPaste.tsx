"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { readPaste } from "@/app/park/import-actions";

/**
 * Screen 1 — the paste box.
 *
 * He is on his phone, at a closing table, and it is loud. One box, one date,
 * one button, and a promise we can keep: we will read what we can and be
 * straight about the rest.
 */

/** The next twelve months, plus the last three — he may be importing late. */
function monthOptions(todayISO: string): { value: string; label: string }[] {
  const [y, m] = todayISO.split("-").map(Number);
  const out: { value: string; label: string }[] = [];
  for (let i = -3; i <= 12; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push({
      value: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    });
  }
  return out;
}

export function ParkImportPaste({ parkId, todayISO }: { parkId: string; todayISO: string }) {
  const months = monthOptions(todayISO);
  const thisMonth = months[3].value;

  const [text, setText] = useState("");
  const [cutover, setCutover] = useState(thisMonth);
  const [dup, setDup] = useState<{ id: string; when: string; committed: boolean } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function submit(force: boolean) {
    start(async () => {
      const res = await readPaste(parkId, text, cutover, { force });
      if (res.duplicateOf && !force) { setDup(res.duplicateOf); return; }
      if (!res.ok || !res.batchId) { toast(res.error ?? "Couldn't read that."); return; }
      router.push(`/park/import/${res.batchId}`);
    });
  }

  const lineCount = text.trim() ? text.trim().split("\n").length : 0;

  return (
    <div className="wrap" style={{ paddingTop: 24, paddingBottom: 60, maxWidth: 720 }}>
      <Link className="mut" href="/park" style={{ fontSize: 14 }}>← Back to the rent roll</Link>

      <h1 style={{ fontSize: 26, margin: "14px 0 8px" }}>Your rent roll starts here</h1>
      <p className="mut" style={{ marginTop: 0, lineHeight: 1.5 }}>
        Paste whatever you&apos;ve got — a spreadsheet, the page from the
        lawyer, the list you keep in your phone. We&apos;ll read what we can and
        be straight with you about the rest.
      </p>

      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <label className="ll-field">
          <span>Paste here</span>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setDup(null); }}
            rows={12}
            placeholder={"Lot\tTenant\tRent\n1\tWexler, Donna\t385\n2\tKastner, Ray\t385"}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}
          />
        </label>
        {lineCount > 0 && (
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0" }}>
            {lineCount} {lineCount === 1 ? "line" : "lines"}. Nothing is saved until you say so.
          </p>
        )}

        <label className="ll-field" style={{ marginTop: 16 }}>
          <span>Which month do you take over?</span>
          <select value={cutover} onChange={(e) => setCutover(e.target.value)}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <p className="mut" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
          Rent starts counting from the 1st. This isn&apos;t anybody&apos;s
          move-in date — nobody&apos;s history gets rewritten.
        </p>

        {dup && (
          <div
            className="ll-card ll-card-pad"
            style={{ marginTop: 16, background: "rgba(180,140,20,.08)" }}
          >
            <strong style={{ display: "block", marginBottom: 6 }}>
              You&apos;ve read this exact list before.
            </strong>
            <p className="mut" style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.5 }}>
              Same list, {dup.when}
              {dup.committed ? ", and you put it in." : ", though you never put it in."}{" "}
              Reading it again makes a second file for every person on it.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link className="ll-btn ghost" href={`/park/import/${dup.id}`}>
                Open the one from {dup.when}
              </Link>
              <button className="ll-btn ghost" onClick={() => submit(true)} disabled={pending}>
                Read it again anyway
              </button>
            </div>
          </div>
        )}

        <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="ll-btn"
            onClick={() => submit(false)}
            disabled={pending || !text.trim()}
          >
            {pending ? "Reading…" : "Read it"}
          </button>
          <span className="mut" style={{ fontSize: 13 }}>Nothing is saved until you say so.</span>
        </div>
      </div>

      {/* Required by the phase-2 design, and backed by structure: the
          document-kind allowlist has no slot for any of these. */}
      <p className="mut" style={{ fontSize: 13, marginTop: 20, lineHeight: 1.5 }}>
        Please don&apos;t paste credit reports, background checks, or anything
        with a Social Security number on it. We have nowhere to put those and no
        reason to.
      </p>
    </div>
  );
}
