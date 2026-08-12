"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { decideApplication, endTenancy, setParkLive, addTenant, editTenancy } from "@/app/park/actions";
import type { TenantInput, TenantEditInput } from "@/app/park/park-helpers";

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
  currentRent: number | null;
  currentDueDay: number | null;
  /** 'seller_roll' until a human confirms it — the rent roll shows its work. */
  currentSource: string | null;
  /** What this household owes this month — or why we can't say. */
  owedThisMonth: string | null;
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
  owedTotal,
  owedBlocked,
  owedMonth,
}: {
  parkId: string;
  isOwner: boolean;
  live: boolean;
  slug: string | null;
  rows: RollRowView[];
  summary: RollSummaryView;
  owedTotal?: number;
  owedBlocked?: number;
  owedMonth?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

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

  // Households are on the roll, but none of their tenancies has started yet —
  // the shape of a park imported before its closing date.
  const notYetStarted = summary.occupied === 0 && summary.reserved > 0;

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      {/* ---- the numbers a park owner actually wants ---- */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 16 }}>
        {/* BEFORE IT IS HIS, THIS PARK IS NOT EMPTY — IT IS NOT YET HIS.
            Imported tenancies begin at cutover, so between the import and
            closing day every one of them is `reserved` and none is `occupied`.
            This read "Occupied 0 · 0% · Owed $0" for the four months leading up
            to December 15th — on the default landing screen, about a fully let
            park. A measured-looking zero is worse than no number. */}
        <Stat
          label={notYetStarted ? "Spoken for" : "Occupied"}
          value={notYetStarted ? `${summary.reserved}` : `${summary.occupied}`}
          sub={`of ${summary.lots} lots`}
        />
        <Stat
          label="Occupancy"
          // A brand-new park is not "0% full" — it has nothing to be full of.
          // Neither is one whose households all start on a date in the future.
          value={
            notYetStarted ? "—"
              : summary.occupancyPct == null ? "—"
                : `${summary.occupancyPct}%`
          }
          sub={
            notYetStarted ? "starts at takeover"
              : summary.occupancyPct == null ? "no lots yet"
                : ""
          }
        />
        <Stat label="Vacant" value={`${summary.vacant}`} sub={summary.reserved ? `${summary.reserved} reserved` : ""} />
        <Stat label="Waiting on you" value={`${summary.pending}`} sub={summary.pending === 1 ? "application" : "applications"} />
        {owedTotal != null && notYetStarted ? (
          <Stat label="Owed this month" value="—" sub="nothing is collectable yet" />
        ) : owedTotal != null && (
          <Stat
            label="Owed this month"
            value={`$${owedTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            // A blocked row is a rent nobody set. Surfaced here rather than
            // quietly missing from the total.
            sub={owedBlocked ? `${owedBlocked} can't be totalled` : (owedMonth ?? "")}
          />
        )}
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
          <h3 style={{ fontSize: 17, margin: "0 0 6px" }}>Your rent roll starts here</h3>
          <p className="mut" style={{ fontSize: 14, marginBottom: 14, lineHeight: 1.5 }}>
            Paste whatever the seller gave you and we&apos;ll read what we can.
            Or add your lots one at a time.
          </p>
          {/* The paste is PRIMARY. On closing day he has a seller's rent roll
              and a notebook, and typing 79 lots by hand is the reason the
              notebook wins. */}
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <Link className="ll-btn" href="/park/import">Paste my rent roll</Link>
            <Link className="ll-btn ghost" href="/park/lots">Add lots one by one</Link>
          </div>
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
                      {r.owedThisMonth && (
                        <span className="mut"> · {r.owedThisMonth}</span>
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
                        onClick={() =>
                          setEditingId(editingId === r.currentReservationId ? null : r.currentReservationId)
                        }
                      >
                        {editingId === r.currentReservationId ? "Cancel" : "Edit"}
                      </button>
                    )}
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

                {editingId && editingId === r.currentReservationId && (
                  <EditTenant
                    reservationId={r.currentReservationId}
                    name={r.currentRenter ?? ""}
                    rent={r.currentRent}
                    dueDay={r.currentDueDay}
                    source={r.currentSource}
                    onDone={() => setEditingId(null)}
                  />
                )}

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

/**
 * Correcting somebody already on the roll.
 *
 * The tick at the bottom is the point of this form. The importer puts 79 names
 * in off a seller's spreadsheet and the receipt tells him, honestly, that $0 of
 * it is confirmed. This is the only thing in the product that can move that
 * number — and it only moves when he says he actually checked.
 */
function EditTenant({
  reservationId, name, rent, dueDay, source, onDone,
}: {
  reservationId: string;
  name: string;
  rent: number | null;
  dueDay: number | null;
  source: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<TenantEditInput>({
    displayName: name,
    rent: rent == null ? "" : String(rent),
    dueDay: dueDay == null ? "" : String(dueDay),
    confirmedWithTenant: false,
  });
  const set = <K extends keyof TenantEditInput>(k: K, v: TenantEditInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  function save() {
    startTransition(async () => {
      const res = await editTenancy(reservationId, form);
      if (!res.ok) { toast(res.error ?? "Couldn't save."); return; }
      toast(res.signal ?? "Saved.");
      onDone();
      router.refresh();
    });
  }

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Name</span>
          <input value={form.displayName} onChange={(e) => set("displayName", e.target.value)}
            style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Rent</span>
          <input value={form.rent} inputMode="decimal" placeholder="Not set"
            onChange={(e) => set("rent", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Due day</span>
          <input value={form.dueDay} inputMode="numeric" placeholder="1"
            onChange={(e) => set("dueDay", e.target.value)} style={{ marginTop: 4 }} />
        </label>
      </div>

      {source === "seller_roll" && (
        <p className="mut" style={{ fontSize: 13, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
          This number came off the seller&apos;s roll. It counts as unconfirmed on your
          rent roll until you&apos;ve checked it with them.
        </p>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, fontSize: 14 }}>
        <input type="checkbox" checked={form.confirmedWithTenant} style={{ marginTop: 3 }}
          onChange={(e) => set("confirmedWithTenant", e.target.checked)} />
        <span>
          I&apos;ve confirmed this with them.
          <span className="mut"> Tick this only if you&apos;ve actually asked — it&apos;s what moves
          this off the seller&apos;s numbers.</span>
        </span>
      </label>

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button className="ll-btn" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button className="ll-btn ghost" onClick={onDone} disabled={pending}>Cancel</button>
      </div>
    </div>
  );
}
