"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { readPaste } from "@/app/park/import-actions";
import { firstBillablePeriod } from "@/lib/billing-start";
import { prettyMonth } from "@/app/park/ledger-helpers";

/**
 * Screen 1 — the paste box.
 *
 * He is on his phone, at a closing table, and it is loud. One box, one date,
 * one button, and a promise we can keep: we will read what we can and be
 * straight about the rest.
 */

/**
 * THIS ASKED FOR A MONTH, AND A MONTH CANNOT ANSWER IT.
 *
 * The old control offered "December 2026", "January 2027" and wrote the FIRST
 * of whichever he chose. Two things downstream read that value, and a
 * month-start is wrong for both:
 *
 *   - `rangeForTerm` dates every grandfathered tenancy from it, and its own
 *     comment calls it "the day the park changed hands, the one date that is
 *     actually true". A 1st is not that day.
 *   - `firstBillablePeriod` reads the DAY on purpose: a go-live on the 1st is
 *     the claim "this whole month is mine to bill", any later day means the
 *     month began before us and belongs to whoever was collecting then.
 *
 * So the honest answer to "which month do you take over?" — December, because
 * he closes on the 15th — wrote 2026-12-01 and made December billable. The
 * seller collected December on the 1st and was made whole for the back half at
 * the closing table. Nineteen households would have been billed $400 for a
 * month they had already paid ~$272 for, and the guard written to prevent
 * exactly that (see billing-start.ts) cannot fire, because the date it is
 * handed says the whole month is his.
 *
 * Ask for the day. It is the one he has in front of him at the closing table,
 * and it is the only value both readers can use.
 */
function firstBill(cutoverISO: string): string | null {
  const first = firstBillablePeriod(cutoverISO);
  return first == null ? null : prettyMonth(first);
}

export function ParkImportPaste({ parkId, todayISO }: { parkId: string; todayISO: string }) {
  const [text, setText] = useState("");
  // Today, because the common case is doing this the day it happens — and
  // never a value he did not choose that would silently claim a whole month.
  const [cutover, setCutover] = useState(todayISO);
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
        <label className="ll-field" style={{ fontSize: 13 }}>
          <span className="mut">Paste here</span>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setDup(null); }}
            rows={12}
            placeholder={"Lot\tTenant\tRent\n1\tWexler, Donna\t385\n2\tKastner, Ray\t385"}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />
        </label>
        {lineCount > 0 && (
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0" }}>
            {lineCount} {lineCount === 1 ? "line" : "lines"}. Nothing is saved until you say so.
          </p>
        )}

        <label className="ll-field" style={{ fontSize: 13, marginTop: 16 }}>
          <span className="mut">What day do you take over?</span>
          <input
            type="date"
            value={cutover}
            onChange={(e) => setCutover(e.target.value)}
          />
        </label>
        {/* The rule made visible, in his numbers, before he commits to it —
            rather than a sentence about the 1st that hides which month gets
            billed. */}
        {firstBill(cutover) && (
          <p className="mut" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
            {cutover.endsWith("-01")
              ? `You take over on the 1st, so ${firstBill(cutover)} is yours to bill in full.`
              : `Your month began before you, so whoever was collecting rent keeps it. ` +
                `Your first bill is ${firstBill(cutover)}.`}{" "}
            This isn&apos;t anybody&apos;s move-in date — nobody&apos;s history
            gets rewritten.
          </p>
        )}

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
            disabled={pending || !text.trim() || !cutover}
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
