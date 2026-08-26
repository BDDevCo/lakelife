"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { commitOnboarding, type OnboardSeed } from "@/app/park/onboard-actions";
import {
  planOnboarding, onboardSummary, signingExplainer,
  type OnboardRow,
} from "@/app/park/onboard-helpers";

/**
 * NINETEEN HOUSEHOLDS IN ONE SITTING.
 *
 * One row per empty lot, rent already filled in from whatever is on the lot, so
 * he is mostly typing names. Tab moves along the row and down the list, because
 * this is a keyboard job done once with a piece of paper next to the laptop.
 *
 * Nothing here demands completeness. He will not know every name on the first
 * afternoon, and a blank row is left for later rather than blocking the save.
 */
export function ParkOnboard({
  parkId, seeds, today, capMonths, rentsFromImport, feePerSignedLot = 0,
}: {
  parkId: string;
  seeds: OnboardSeed[];
  today: string;
  /** The park's own agreement cap, or null when it has not set one. */
  capMonths: number | null;
  /** Did a roll actually get pasted in? The rent hint is a lie otherwise. */
  rentsFromImport: boolean;
  /**
   * Monthly fees a SIGNED household will also be charged. The summary totalled
   * rent alone while the run charges rent plus fees, so the number he checked
   * against his own roll was not the number that billed.
   */
  feePerSignedLot?: number;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  /** Lots that came back with a reason, so a partial failure names them. */
  const [failed, setFailed] = useState<{ lotNumber: string; why: string }[]>([]);
  const [rows, setRows] = useState<OnboardRow[]>(
    seeds.map((s) => ({
      lotId: s.lotId,
      lotNumber: s.lotNumber,
      displayName: "",
      rent: s.suggestedRent,
      movedInOn: "",
      // NOBODY HAS SIGNED ANYTHING YET. This defaulted to true, on the theory
      // that everyone signs at takeover — so an owner who read the instruction
      // ("tick anyone who has signed"), ticked nobody because nobody had, and
      // pressed File wrote a fresh signed agreement for every household in the
      // park. Nineteen records asserting a lease that does not exist on paper,
      // created by a default, with the summary line calling it "all on the new
      // lease" as though it were describing his own work.
      //
      // The tick is a claim about a piece of paper. It starts false and only
      // the person holding the paper may make it true.
      signedNewLease: false,
    })),
  );

  const set = (i: number, k: keyof OnboardRow, v: string | boolean) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const plan = planOnboarding(rows, today);

  if (seeds.length === 0) {
    return (
      <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
        <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>Who lives here</h1>
        <p className="mut" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Every live lot already has somebody on it. Nothing left to file.
        </p>
      </div>
    );
  }

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Who lives here</h1>
      <p className="mut" style={{ fontSize: 14, marginTop: 0, lineHeight: 1.5 }}>
        {seeds.length === 1
          ? "One lot has nobody on it yet."
          : `${seeds.length} lots have nobody on them yet.`}{" "}
        {/* ONLY CLAIM AN IMPORT THAT HAPPENED. This said "the rents came off
            the sheet you imported" to every park, including one that never
            pasted a roll — so the first thing the screen told them about their
            own data was wrong. */}
        {rentsFromImport
          ? "The rents came off the roll you pasted in — check them as you go."
          : "Any rent already on the lot is filled in for you — check them as you go."}{" "}
        Leave a row blank if you don&apos;t know yet.
      </p>

      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 15 }}>The new lease</strong>
        <p className="mut" style={{ fontSize: 13, marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
          {signingExplainer(capMonths)}
        </p>
      </div>

      {/* ---- the grid ------------------------------------------------------ */}
      <div className="ll-card" style={{ marginTop: 16 }}>
        {rows.map((r, i) => {
          const problem = plan.problems.find((p) => p.lotNumber === r.lotNumber);
          return (
            <div key={r.lotId} style={{
              padding: "9px 12px", borderTop: "1px solid rgba(0,0,0,.06)",
              display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
              background: problem ? "rgba(200,60,40,.06)" : undefined,
            }}>
              <strong style={{ minWidth: 58, fontSize: 14 }}>Lot {r.lotNumber}</strong>
              <input
                value={r.displayName}
                onChange={(e) => set(i, "displayName", e.target.value)}
                placeholder="Who lives here"
                style={{ flex: "2 1 180px", minWidth: 0 }}
              />
              <input
                value={r.rent}
                inputMode="decimal"
                onChange={(e) => set(i, "rent", e.target.value)}
                placeholder="rent"
                style={{ flex: "0 1 90px", minWidth: 0 }}
              />
              <input
                type="date"
                value={r.movedInOn}
                max={today}
                onChange={(e) => set(i, "movedInOn", e.target.value)}
                title="When they moved in, if you know it"
                style={{ flex: "0 1 150px", minWidth: 0 }}
              />
              {/* One tick per household, because on the first morning some
                  have signed and some have not. */}
              <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={r.signedNewLease}
                  onChange={(e) => set(i, "signedNewLease", e.target.checked)} />
                <span className="mut">signed</span>
              </label>
              {problem && (
                <span className="mut" style={{ fontSize: 12, flexBasis: "100%" }}>
                  {problem.why}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- what is about to happen -------------------------------------- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
        <strong style={{ fontSize: 15 }}>{onboardSummary(plan, capMonths, feePerSignedLot)}</strong>
        <p className="mut" style={{ fontSize: 12, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
          Nobody is told anything by this. It puts them on the roll so you can
          bill them — the rents are recorded as YOUR figures, not as anything
          they&apos;ve confirmed.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="ll-btn" disabled={busy || plan.toFile.length === 0}
            onClick={() =>
              start(async () => {
                const res = await commitOnboarding(parkId, rows);
                toast(res.ok ? (res.signal ?? "Filed.") : (res.error ?? "Couldn't file those."));
                // THE NAMES, NOT THE COUNT. The action already returns a lot
                // number and a reason for every household that did not file,
                // and the toast threw all of it away — so "18 filed, 3
                // couldn't be" sent him hunting three households across
                // twenty-one rows, where an unfiled one and an empty lot look
                // identical.
                setFailed(res.failed ?? []);
                if (res.ok) router.refresh();
              })
            }>
            {busy ? "Filing…" : `File ${plan.toFile.length}`}
          </button>
        </div>

        {failed.length > 0 && (
          <div style={{ marginTop: 12, borderTop: "1px solid rgba(0,0,0,.08)", paddingTop: 10 }}>
            <strong style={{ fontSize: 13.5, color: "var(--warn)" }}>
              {failed.length === 1 ? "One didn't file" : `${failed.length} didn't file`} — the rest did.
            </strong>
            {failed.map((f) => (
              <p key={f.lotNumber} style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.5 }}>
                <strong>Lot {f.lotNumber}</strong> — {f.why}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
