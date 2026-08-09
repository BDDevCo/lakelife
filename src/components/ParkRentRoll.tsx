"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { decideApplication, endTenancy, setParkLive, addTenant } from "@/app/park/actions";
import type { TenantInput } from "@/app/park/park-helpers";

/**
 * The park owner's home screen: every lot, who is on it, and who is asking.
 * This replaces a spiral notebook, so it has to be readable at a glance and
 * honest about what it does not know.
 *
 * Money note: the amounts here are the PARK OWNER'S OWN rate card, echoed back.
 * LakeLife collects nothing in this phase — no invoice, no charge, no payout.
 */

export interface RollRowView {
  lotId: string;
  lotNumber: string;
  siteType: string;
  state: "inactive" | "occupied" | "reserved" | "vacant";
  active: boolean;
  currentRenter: string | null;
  currentUnit: string | null;
  currentUntil: string | null;
  currentReservationId: string | null;
  nightsLeft: number | null;
  /** A month-to-month tenancy: no real end date, so no countdown. */
  rolling?: boolean;
  nextRenter: string | null;
  nextFrom: string | null;
  pending: {
    id: string;
    renter: string;
    unit: string | null;
    from: string;
    to: string;
    term: string;
    amount: number | null;
    fitWarnings: string[];
  }[];
}

export interface RollSummaryView {
  lots: number;
  occupied: number;
  reserved: number;
  vacant: number;
  inactive: number;
  pending: number;
  occupancyPct: number | null;
}

const SITE_LABEL: Record<string, string> = {
  rv_site: "RV site", mh_single: "Single-wide pad", mh_double: "Double-wide pad",
  tent: "Tent site", slip: "Boat slip",
};

const STATE_STYLE: Record<RollRowView["state"], { pill: string; label: string }> = {
  occupied: { pill: "", label: "Occupied" },
  reserved: { pill: "warn", label: "Reserved" },
  vacant: { pill: "slate", label: "Vacant" },
  inactive: { pill: "slate", label: "Off" },
};

function pretty(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

export function ParkRentRoll({
  parkId,
  isOwner,
  live,
  slug,
  rows,
  summary,
}: {
  parkId: string;
  isOwner: boolean;
  live: boolean;
  slug: string | null;
  rows: RollRowView[];
  summary: RollSummaryView;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  function decide(id: string, decision: "approve" | "decline") {
    setBusyId(id);
    startTransition(async () => {
      const res = await decideApplication(id, decision);
      setBusyId(null);
      if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Done.");
      router.refresh();
    });
  }

  function close(id: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await endTenancy(id, "ended");
      setBusyId(null);
      if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Done.");
      router.refresh();
    });
  }

  function publish(next: boolean) {
    startTransition(async () => {
      const res = await setParkLive(parkId, next);
      if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Done.");
      router.refresh();
    });
  }

  const applications = rows.flatMap((r) =>
    r.pending.map((p) => ({ ...p, lotNumber: r.lotNumber, lotId: r.lotId })),
  );

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      {/* ---- the numbers a park owner actually wants ---- */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Stat label="Occupied" value={`${summary.occupied}`} sub={`of ${summary.lots} lots`} />
        <Stat
          label="Occupancy"
          // A brand-new park is not "0% full" — it has nothing to be full of.
          value={summary.occupancyPct == null ? "—" : `${summary.occupancyPct}%`}
          sub={summary.occupancyPct == null ? "no lots yet" : ""}
        />
        <Stat label="Vacant" value={`${summary.vacant}`} sub={summary.reserved ? `${summary.reserved} reserved` : ""} />
        <Stat label="Waiting on you" value={`${summary.pending}`} sub={summary.pending === 1 ? "application" : "applications"} />
      </div>

      {!live && (
        <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
          <span className="ll-pill slate">Not published</span>
          <h3 style={{ fontSize: 17, margin: "10px 0 6px" }}>Your park is private right now</h3>
          <p className="mut" style={{ fontSize: 14, marginBottom: 12 }}>
            Only you can see it. Publish it when your lots and rates look right — that
            puts your park on its own page where people can see what&apos;s open and apply.
          </p>
          {isOwner ? (
            <button className="ll-btn" onClick={() => publish(true)} disabled={pending}>
              Publish my park
            </button>
          ) : (
            <p className="mut" style={{ fontSize: 13 }}>The park owner publishes the park.</p>
          )}
        </div>
      )}

      {live && slug && (
        <p className="mut" style={{ fontSize: 13, marginBottom: 16 }}>
          Your public page: <Link href={`/parks/${slug}`}>lakelife.ai/parks/{slug}</Link>
          {isOwner && (
            <>
              {" · "}
              <button
                onClick={() => publish(false)}
                disabled={pending}
                style={{ background: "none", border: "none", padding: 0, color: "var(--sub)", textDecoration: "underline", cursor: "pointer", font: "inherit" }}
              >
                unpublish
              </button>
            </>
          )}
        </p>
      )}

      {/* ---- applications first: this is the only thing that needs a human ---- */}
      {applications.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <h2 style={{ fontSize: 18, marginBottom: 10 }}>Applications</h2>
          <div style={{ display: "grid", gap: 10 }}>
            {applications.map((a) => (
              <div key={a.id} className="ll-card ll-card-pad">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <strong style={{ fontSize: 15 }}>{a.renter}</strong>
                    <span className="mut" style={{ fontSize: 13 }}> · Lot {a.lotNumber}</span>
                    <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
                      {pretty(a.from)} – {pretty(a.to)} · {a.term}
                      {a.amount != null && ` · $${a.amount.toLocaleString()}`}
                    </div>
                    {a.unit && <div className="mut" style={{ fontSize: 13 }}>{a.unit}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <button
                      className="ll-btn"
                      onClick={() => decide(a.id, "approve")}
                      disabled={pending && busyId === a.id}
                    >
                      Approve
                    </button>
                    <button
                      className="ll-btn ghost"
                      onClick={() => decide(a.id, "decline")}
                      disabled={pending && busyId === a.id}
                    >
                      Decline
                    </button>
                  </div>
                </div>
                {/* Fit is ADVICE, never a veto — it is the owner's lot. */}
                {a.fitWarnings.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: 13, color: "var(--sub)" }}>
                    <span className="ll-pill warn">Heads up</span>{" "}
                    {a.fitWarnings.join(" ")}{" "}You can still approve it.
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- the roll ---- */}
      <h2 style={{ fontSize: 18, marginBottom: 10 }}>Lots</h2>
      {rows.length === 0 ? (
        <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
          <h3 style={{ fontSize: 17, margin: "0 0 6px" }}>No lots yet</h3>
          <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
            Add your lots and what you charge, and this becomes your rent roll.
          </p>
          <Link className="ll-btn" href="/park/lots">Add lots</Link>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r) => {
            const s = STATE_STYLE[r.state];
            return (
              <div key={r.lotId} className="ll-card ll-card-pad" style={{ opacity: r.state === "inactive" ? 0.6 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <strong style={{ fontSize: 15 }}>Lot {r.lotNumber}</strong>
                    <span className="mut" style={{ fontSize: 13 }}> · {SITE_LABEL[r.siteType] ?? r.siteType}</span>
                    <div style={{ fontSize: 13, marginTop: 3 }}>
                      {r.state === "occupied" && (
                        <>
                          {r.currentRenter}
                          {r.currentUnit && <span className="mut"> · {r.currentUnit}</span>}
                          <span className="mut">
                            {r.rolling
                              ? " · month-to-month"
                              : ` · through ${pretty(r.currentUntil)}`}
                            {r.nightsLeft != null && ` (${r.nightsLeft} night${r.nightsLeft === 1 ? "" : "s"} left)`}
                          </span>
                        </>
                      )}
                      {r.state === "reserved" && (
                        <span className="mut">{r.nextRenter} arrives {pretty(r.nextFrom)}</span>
                      )}
                      {r.state === "vacant" && <span className="mut">Open</span>}
                      {r.state === "inactive" && <span className="mut">Not in service</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span className={`ll-pill ${s.pill}`}>{s.label}</span>
                    {r.currentReservationId && (
                      <button
                        className="ll-btn ghost"
                        onClick={() => close(r.currentReservationId!)}
                        disabled={pending && busyId === r.currentReservationId}
                      >
                        Move out
                      </button>
                    )}
                    {r.state === "vacant" && (
                      <button className="ll-btn ghost"
                        onClick={() => setAddingTo(addingTo === r.lotId ? null : r.lotId)}>
                        {addingTo === r.lotId ? "Cancel" : "Someone lives here"}
                      </button>
                    )}
                  </div>
                </div>

                {addingTo === r.lotId && (
                  <AddTenant
                    parkId={parkId}
                    lotId={r.lotId}
                    lotNumber={r.lotNumber}
                    onDone={() => setAddingTo(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The tenant who was ALREADY LIVING THERE when he bought the park.
 *
 * The most-used screen in year one, and the one that decides whether any of
 * this gets used at all: until the rent roll is right he keeps the notebook.
 *
 * A NAME IS THE ONLY REQUIRED FIELD, and there is deliberately no move-out
 * date — he does not have one and neither does she. Asking is how a 79-lot
 * park turns into a three-hour data-entry session that gets abandoned at lot 9.
 */
function AddTenant({
  parkId, lotId, lotNumber, onDone,
}: {
  parkId: string; lotId: string; lotNumber: string; onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<TenantInput>({
    displayName: "", mobile: "", email: "",
    movedInOn: "", term: "monthly", rent: "", source: "seller_roll",
  });
  const set = <K extends keyof TenantInput>(k: K, v: TenantInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  function save() {
    startTransition(async () => {
      const res = await addTenant(parkId, lotId, form);
      if (!res.ok) { toast(res.error ?? "Couldn't save."); return; }
      toast(res.signal ?? "Added.");
      onDone();
      router.refresh();
    });
  }

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <p className="mut" style={{ fontSize: 13, marginTop: 0, marginBottom: 12 }}>
        Who&apos;s on lot {lotNumber}? A name is enough — you can fill in the rest
        whenever you get it.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Name</span>
          <input value={form.displayName} placeholder="Donna Reyes"
            onChange={(e) => set("displayName", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Best number (optional)</span>
          <input type="tel" inputMode="tel" value={form.mobile} placeholder="(260) 555-0142"
            onChange={(e) => set("mobile", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Rent (optional)</span>
          <input inputMode="decimal" value={form.rent} placeholder="340"
            onChange={(e) => set("rent", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Paid</span>
          <select value={form.term} onChange={(e) => set("term", e.target.value)} style={{ marginTop: 4 }}>
            <option value="monthly">monthly</option>
            <option value="weekly">weekly</option>
            <option value="seasonal">seasonally</option>
            <option value="annual">yearly</option>
          </select>
        </label>
      </div>

      <p className="mut" style={{ fontSize: 12.5, marginTop: 10 }}>
        Give us a number and they get rent receipts and freeze warnings by text —
        no app, no password, nothing to install.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="ll-btn" onClick={save} disabled={pending || !form.displayName.trim()}>
          Add to lot {lotNumber}
        </button>
        <button className="ll-btn ghost" onClick={onDone} disabled={pending}>Cancel</button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ll-card ll-card-pad" style={{ padding: 14 }}>
      <div className="mut" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1, marginTop: 2 }}>{value}</div>
      {sub && <div className="mut" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}
