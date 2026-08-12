"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { commitOnboarding, type OnboardSeed } from "@/app/park/onboard-actions";
import {
  planOnboarding, onboardSummary,
  GRANDFATHERED_EXPLAINER, NEW_AGREEMENT_EXPLAINER,
  type OnboardRow,
} from "@/app/park/onboard-helpers";

/**
 * NINETEEN HOUSEHOLDS IN ONE SITTING.
 *
 * One row per empty lot, rent already filled in off the seller's roll, so he is
 * mostly typing names. Tab moves along the row and down the list, because this
 * is a keyboard job done once with a piece of paper next to the laptop.
 *
 * Nothing here demands completeness. He will not know every name on the first
 * afternoon, and a blank row is left for later rather than blocking the save.
 */
export function ParkOnboard({
  parkId, seeds, today,
}: { parkId: string; seeds: OnboardSeed[]; today: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [grandfathered, setGrandfathered] = useState(true);
  const [rows, setRows] = useState<OnboardRow[]>(
    seeds.map((s) => ({
      lotId: s.lotId,
      lotNumber: s.lotNumber,
      displayName: "",
      rent: s.suggestedRent,
      movedInOn: "",
    })),
  );

  const set = (i: number, k: keyof OnboardRow, v: string) =>
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
        The rents came off the sheet you imported — check them as you go. Leave
        a row blank if you don&apos;t know yet.
      </p>

      {/* ---- the choice, asked ONCE ---------------------------------------- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 15 }}>How are you filing these?</strong>
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5 }}>
            <input type="radio" checked={grandfathered} style={{ marginTop: 3 }}
              onChange={() => setGrandfathered(true)} />
            <span>
              <strong>They were already living here</strong>
              <span className="mut" style={{ display: "block", marginTop: 3 }}>
                {GRANDFATHERED_EXPLAINER}
              </span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5 }}>
            <input type="radio" checked={!grandfathered} style={{ marginTop: 3 }}
              onChange={() => setGrandfathered(false)} />
            <span>
              <strong>Write everyone a new agreement</strong>
              <span className="mut" style={{ display: "block", marginTop: 3 }}>
                {NEW_AGREEMENT_EXPLAINER}
              </span>
            </span>
          </label>
        </div>
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
        <strong style={{ fontSize: 15 }}>{onboardSummary(plan, grandfathered)}</strong>
        <p className="mut" style={{ fontSize: 12, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
          Nobody is told anything by this. It puts them on the roll so you can
          bill them — the rents are recorded as YOUR figures off the sheet, not
          as anything they&apos;ve confirmed.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="ll-btn" disabled={busy || plan.toFile.length === 0}
            onClick={() =>
              start(async () => {
                const res = await commitOnboarding(parkId, rows, grandfathered);
                toast(res.ok ? (res.signal ?? "Filed.") : (res.error ?? "Couldn't file those."));
                if (res.ok) router.refresh();
              })
            }>
            {busy ? "Filing…" : `File ${plan.toFile.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
