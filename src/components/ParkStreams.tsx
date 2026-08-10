"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { saveRevenueStreams } from "@/app/park/stream-actions";
import {
  REVENUE_STREAMS, STREAM_SPEC, setupSummary,
  type RevenueStream, type StreamStatus,
} from "@/app/park/revenue-streams";

/**
 * WHAT THIS PARK EARNS FROM.
 *
 * A menu, not an assumption. Every park runs a different mix, and the ones it
 * does not run should be invisible rather than empty — an owner with no dock
 * should never see a boat-slip section sitting at zero forever.
 *
 * The honest part is the readiness line under each chosen stream. Ticking
 * "boat slips" does not make a slip exist, and the screen says so with the
 * next step rather than letting him believe it is handled.
 */

const WHERE_TO_GO: Partial<Record<RevenueStream, { href: string; label: string }>> = {
  long_term_lots:     { href: "/park/lots",  label: "Lots & rates" },
  park_owned_rentals: { href: "/park/lots",  label: "Lots & rates" },
  short_term_homes:   { href: "/park/lots",  label: "Lots & rates" },
  boat_slips:         { href: "/park/lots",  label: "Lots & rates" },
  storage:            { href: "/park/lots",  label: "Lots & rates" },
  cost_recovery:      { href: "/park/costs", label: "Costs" },
};

export function ParkStreams({
  parkId, statuses,
}: {
  parkId: string;
  statuses: StreamStatus[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [chosen, setChosen] = useState<Set<RevenueStream>>(
    new Set(statuses.filter((s) => s.on).map((s) => s.stream)),
  );
  const [dirty, setDirty] = useState(false);

  function toggle(s: RevenueStream) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
    setDirty(true);
  }

  function save() {
    start(async () => {
      const res = await saveRevenueStreams(parkId, [...chosen]);
      if (!res.ok) { toast(res.error ?? "Couldn't save that."); return; }
      toast(res.signal ?? "Saved.");
      setDirty(false);
      router.refresh();
    });
  }

  const byStream = new Map(statuses.map((s) => [s.stream, s]));

  return (
    <section style={{ marginBottom: 26 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>What your park earns from</h2>
      <p className="mut" style={{ margin: "0 0 14px", lineHeight: 1.5, maxWidth: 620 }}>
        {setupSummary(statuses)} Turn on what you run — the rest stays out of
        your way.
      </p>

      <div style={{ display: "grid", gap: 10 }}>
        {REVENUE_STREAMS.map((s) => {
          const spec = STREAM_SPEC[s];
          const status = byStream.get(s);
          const on = chosen.has(s);
          const go = WHERE_TO_GO[s];

          return (
            <div key={s} className="ll-card ll-card-pad"
              style={{ opacity: on ? 1 : 0.72 }}>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                <input type="checkbox" checked={on} onChange={() => toggle(s)} style={{ marginTop: 4 }} />
                <span style={{ flex: 1 }}>
                  <strong style={{ fontSize: 15 }}>{spec.label}</strong>
                  {on && status && status.count > 0 && (
                    <span className="mut" style={{ fontSize: 13 }}> · {status.count} set up</span>
                  )}
                  {on && status && status.coming > 0 && (
                    <span className="ll-pill slate" style={{ marginLeft: 8 }}>
                      {status.coming} coming
                    </span>
                  )}
                  {on && status?.ready && (
                    <span className="ll-pill" style={{ marginLeft: 8 }}>Ready</span>
                  )}
                  <div className="mut" style={{ fontSize: 13, marginTop: 3, lineHeight: 1.5 }}>
                    {spec.what}
                  </div>
                  <div className="mut" style={{ fontSize: 12, marginTop: 3, fontStyle: "italic" }}>
                    e.g. {spec.example}
                  </div>
                </span>
              </label>

              {/* THE HONEST BIT: ticking a box does not make a slip exist. */}
              {on && status && status.missing.length > 0 && (
                <div style={{ marginTop: 10, paddingLeft: 26 }}>
                  {status.missing.map((m) => (
                    <div key={m} style={{ fontSize: 14, lineHeight: 1.5 }}>
                      <span className="ll-pill warn" style={{ marginRight: 8 }}>Next</span>
                      {m}
                      {go && (
                        <>
                          {" — "}
                          <Link href={go.href}>{go.label}</Link>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {dirty && (
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
          <button className="ll-btn" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save what I run"}
          </button>
          <span className="mut" style={{ fontSize: 13 }}>
            Turning one off hides it — it doesn&apos;t delete anything.
          </span>
        </div>
      )}
    </section>
  );
}
