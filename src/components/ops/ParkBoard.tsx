"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { NewPark } from "./NewPark";
import { setParkActive } from "@/app/ops/parks-actions";
import type { OpsParkRow } from "@/app/ops/parks-data";

/**
 * Publish / unpublish a park's PUBLIC PAGE. Nothing else.
 *
 * Taking a park dark asks twice, because the thing it does is invisible from
 * here — the page stops resolving for everyone who is not signed in, and the
 * person clicking is signed in, so a mis-click looks like nothing happened.
 * Publishing does not ask: it is the reversible direction.
 */
function PublishSwitch({ park }: { park: OpsParkRow }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, start] = useTransition();

  function go(active: boolean) {
    start(async () => {
      const res = await setParkActive(park.id, active);
      toast(res.ok ? (res.signal ?? "Done.") : (res.error ?? "Couldn't change that."));
      setConfirming(false);
      if (res.ok) router.refresh();
    });
  }

  if (!park.active) {
    return (
      <button className="ll-btn ghost" disabled={busy} onClick={() => go(true)}>
        {busy ? "Publishing…" : "Publish page"}
      </button>
    );
  }
  if (!confirming) {
    return (
      <button className="ll-btn ghost" disabled={busy} onClick={() => setConfirming(true)}>
        Take page offline
      </button>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span className="mut" style={{ fontSize: 12 }}>Hide from the public?</span>
      <button className="ll-btn" disabled={busy} onClick={() => go(false)}>
        {busy ? "Hiding…" : "Take it offline"}
      </button>
      <button className="ll-btn ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Keep it up
      </button>
    </div>
  );
}

/**
 * Ops' view of the parks on the platform. Read-only on purpose: a park owner
 * runs their own park, and ops reaching in to approve a tenancy would make
 * LakeLife a party to a housing decision it has no business making.
 *
 * What ops is actually looking for here is SERVICE demand — a 60-lot park is
 * sixty potential lawn and winterization customers reachable on one drive.
 */
export function ParkBoard({
  parks,
  lakes,
}: {
  parks: OpsParkRow[];
  lakes: Array<{ id: string; name: string }>;
}) {
  if (parks.length === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 17, margin: "0 0 6px" }}>No parks yet</h3>
        <p className="mut" style={{ fontSize: 14, margin: 0 }}>
          When a mobile-home or RV park comes onto the platform, it shows here.
          Parks are created by ops and handed to the owner, who runs it themselves.
        </p>
        {/* That sentence described an action that did not exist: nothing in
            the product could insert a `parks` or `park_members` row, so every
            owner screen answered "park owners only" forever. */}
        <div style={{ marginTop: 12 }}>
          <NewPark lakes={lakes} />
        </div>
      </div>
    );
  }

  const totals = parks.reduce(
    (acc, p) => ({
      lots: acc.lots + p.lots,
      occupied: acc.occupied + p.occupied,
      pending: acc.pending + p.pending,
    }),
    { lots: 0, occupied: 0, pending: 0 },
  );

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
        <Kpi v={String(parks.length)} l="Parks" />
        <Kpi v={String(totals.lots)} l="Lots on platform" />
        <Kpi
          v={totals.lots ? `${Math.round((totals.occupied / totals.lots) * 100)}%` : "—"}
          l="Occupancy"
          d={`${totals.occupied} occupied`}
        />
        <Kpi v={String(totals.pending)} l="Applications waiting" />
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {parks.map((p) => (
          <div key={p.id} className="ll-card ll-card-pad">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <strong style={{ fontSize: 15 }}>{p.name}</strong>
                <span className={`ll-pill ${p.active ? "" : "slate"}`} style={{ marginLeft: 8 }}>
                  {p.active ? "Live" : "Dark"}
                </span>
                <div className="mut" style={{ fontSize: 13, marginTop: 3 }}>
                  {p.lakeName ?? "No lake set"} · {p.lots} lot{p.lots === 1 ? "" : "s"} ·{" "}
                  {p.members}{" "}manager{p.members === 1 ? "" : "s"}
                  {/* A park with no member is a park nobody can run — it will sit
                      dark forever and nobody will report it. */}
                  {p.members === 0 && " ⚠️"}
                </div>
                <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
                  {p.occupancyPct == null
                    ? "No lots set up yet"
                    : `${p.occupancyPct}% full · ${p.vacant} vacant`}
                  {p.pending > 0 && ` · ${p.pending} waiting on the owner`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                {p.slug && p.active && (
                  <Link className="ll-btn ghost" href={`/parks/${p.slug}`}>Public page</Link>
                )}
                <PublishSwitch park={p} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="mut" style={{ fontSize: 12, marginTop: 16 }}>
        Park owners approve their own renters — we run the software and the
        services, never the housing decision. The only thing switchable here is
        whether a park has a public page; taking one dark changes nothing for
        its owner, its renters or its rent.
      </p>
      <div style={{ marginTop: 14 }}><NewPark lakes={lakes} /></div>
    </div>
  );
}

function Kpi({ v, l, d }: { v: string; l: string; d?: string }) {
  return (
    <div className="ll-card ll-card-pad">
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "var(--font-display)" }}>{v}</div>
      <div className="mut" style={{ fontSize: 12.5 }}>{l}</div>
      {d && <div style={{ fontSize: 11.5, color: "var(--teal-dark)", fontWeight: 700, marginTop: 2 }}>{d}</div>}
    </div>
  );
}
