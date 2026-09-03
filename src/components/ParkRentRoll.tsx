"use client";

import { useState, useTransition } from "react";
import { ClaimSlip } from "@/components/ClaimSlip";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import {
  decideApplication, endTenancy, setParkLive, addTenant, editTenancy,
  giveNotice, clearNotice,
} from "@/app/park/actions";
import type { TenantInput, TenantEditInput } from "@/app/park/park-helpers";
import { prettyMonth } from "@/app/park/ledger-helpers";

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
  /** The FILE, not the tenancy — a slip is issued against the household. */
  currentRenterId: string | null;
  /**
   * The household a claim slip should go to, whether they have arrived yet or
   * not. Distinct from currentRenterId, which is who is on the lot TODAY —
   * after importing a roll dated from a future takeover, that is nobody.
   */
  slipRenterId: string | null;
  slipRenterName: string | null;
  /** Set when they have not moved in yet, so the slip can say so. */
  slipArrivesOn: string | null;
  /**
   * What the office may know about this household's slip: 'none' | 'open' |
   * 'used' | 'expired' | 'locked' | 'declined'.
   *
   * A fact about the CODE, never a fact about the person. The refusal log is
   * ops-only on purpose — a failed attempt must not become a durable record
   * about a resident rendered on their landlord's screen.
   */
  claimStatus: string | null;
  /** The address on file, and whether the one invite has gone. */
  renterEmail: string | null;
  invitedAt: string | null;
  currentRent: number | null;
  currentDueDay: number | null;
  /** 'prior_roll' until a human confirms it — the rent roll shows its work. */
  currentSource: string | null;
  /** What this household owes this month — or why we can't say. */
  owedThisMonth: string | null;
  /**
   * The day they say they are leaving, once notice has been given.
   *
   * They still live here and still owe rent until they actually go — this is
   * a warning, not an ending. It is also the row's only sign that the lot will
   * need showing, which is the entire reason notice is recorded.
   */
  expectedMoveOut: string | null;
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
  parkName,
  rows,
  summary,
  today,
  owedTotal,
  owedBlocked,
  owedMonth,
  billedThisMonth,
  disputedAmount,
  wouldBill,
  preGoLive,
}: {
  parkId: string;
  isOwner: boolean;
  live: boolean;
  slug: string | null;
  parkName: string;
  rows: RollRowView[];
  summary: RollSummaryView;
  /** Lake date from the server. A client component must never guess it. */
  today: string;
  owedTotal?: number;
  owedBlocked?: number;
  owedMonth?: string;
  /** How many bills exist for this month. Zero means nothing is owed YET. */
  billedThisMonth?: number;
  /** Outstanding on bills somebody is disputing — never counted as arrears. */
  disputedAmount?: number;
  /** What a full month here would come to, for the not-yet-billed case. */
  wouldBill?: number;
  /**
   * Set when TODAY'S month began before the park went live, carrying the first
   * month that is ours. Distinct from `notYetStarted`, which is about lots
   * being reserved rather than lived in — this is about the calendar.
   */
  preGoLive?: { firstMonth: string; label: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The move-out panel: which tenancy, and the last day they lived there.
  const [closingId, setClosingId] = useState<string | null>(null);
  const [lastDay, setLastDay] = useState("");
  // The notice panel: which tenancy, and the day they SAY they are going.
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [leavingOn, setLeavingOn] = useState("");

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

  // A MOVE-OUT IS A DATE, NOT A CLICK.
  //
  // This used to fire `endTenancy(id, "ended")` with no date at all, which
  // left the tenancy's range untrimmed — so the final month was either billed
  // whole with no way to correct it, or never billed for the days they were
  // actually here. The date is now required, and the panel says what it does
  // to the bill so nobody has to guess.
  function close(id: string, lastDayISO: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await endTenancy(id, "ended", lastDayISO);
      setBusyId(null);
      if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Done.");
      setClosingId(null);
      setLastDay("");
      router.refresh();
    });
  }

  // NOTICE TO VACATE — the warning, not the ending.
  //
  // `giveNotice` and `clearNotice` were written, validated and tested-looking,
  // and had NO CALLER: nothing in the product could reach them, and nothing
  // read the columns they wrote. So the answer to "who is leaving" was still
  // "whoever's stuff is gone this morning", which is what the feature existed
  // to prevent. This is that missing button.
  function notice(id: string, leavingISO: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await giveNotice(id, leavingISO);
      setBusyId(null);
      if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Noted.");
      setNoticeId(null);
      setLeavingOn("");
      router.refresh();
    });
  }

  /** People change their minds, and a stale notice shows a lot as leaving. */
  function unnotice(id: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await clearNotice(id);
      setBusyId(null);
      if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Cleared.");
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
            notYetStarted ? "starts at go-live"
              : summary.occupancyPct == null ? "no lots yet"
                : ""
          }
        />
        <Stat label="Vacant" value={`${summary.vacant}`} sub={summary.reserved ? `${summary.reserved} reserved` : ""} />
        <Stat label="Waiting on you" value={`${summary.pending}`} sub={summary.pending === 1 ? "application" : "applications"} />
        {/* OWED MEANS BILLED AND NOT PAID.
            This tile used to roll up what rent WOULD be for every current
            tenancy — it read neither charges nor payments — so on the 28th,
            with every household paid, it still said "$8,645 owed". A disputed
            bill is shown separately: "they say they paid and we haven't found
            it" is something to go and settle, not money to chase. */}
        {/* THIS MONTH IS NOT OURS. It began before the park went live, so
            whoever was collecting rent then keeps it — and projecting a total
            here would be inviting the owner to bill for it. */}
        {preGoLive ? (
          <Stat
            label="Owed this month"
            value="—"
            sub={`not ours to bill · LakeLife starts ${preGoLive.label}`}
          />
        ) : owedTotal != null && notYetStarted ? (
          <Stat label="Owed this month" value="—" sub="nothing is collectable yet" />
        ) : !billedThisMonth ? (
          <Stat
            label="Owed this month"
            value="—"
            sub={wouldBill ? `not billed yet · about $${wouldBill.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "not billed yet"}
          />
        ) : owedTotal != null && (
          <Stat
            label="Owed this month"
            value={`$${owedTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            // A blocked row is a rent nobody set. Surfaced here rather than
            // quietly missing from the total.
            sub={
              disputedAmount
                ? `plus $${disputedAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })} disputed`
                // HOUSE RULE: any month a person reads is "January 2027",
                // never "2027-01". This slot fell through to the raw period —
                // the ordinary state once January is billed and nothing is
                // disputed — so the tile read "Owed this month / $10,851 /
                // 2027-01". Every other month string on these screens already
                // goes through prettyMonth.
                : owedBlocked ? `${owedBlocked} can't be totalled` : (owedMonth ? prettyMonth(owedMonth) : "")
            }
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
            Pick the file the seller sent and we&apos;ll read what we can.
            Or add your lots one at a time.
          </p>
          {/* THE ROLL IS PRIMARY. On closing day he has a seller's rent roll
              and a notebook, and typing 79 lots by hand is the reason the
              notebook wins. The button said "Paste my rent roll" — telling him
              to do the one thing he has said he never wants to do — for a
              screen that takes a file now. */}
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <Link className="ll-btn" href="/park/import">Load the seller&apos;s roll</Link>
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
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <span className={`ll-pill ${s.pill}`}>{s.label}</span>
                    {/* CAN THIS HOUSEHOLD REACH THEIR OWN RECORDS?
                        Until 0128/0129 the honest answer was "no, and there is
                        no way to change that" — the file was created unclaimed
                        and nothing could ever claim it. This is the button
                        that ends that, and the states it shows are facts about
                        a CODE, never about the person. */}
                    {/* NOT GATED ON "occupied". A household arriving at the
                        takeover date is exactly who needs a slip in the months
                        before it — and after importing a roll dated from that
                        date, no lot is occupied, so this control vanished from
                        every row on the screen. `next` was already computed
                        and read by nothing but the word "reserved". */}
                    {r.slipRenterId && slug && (
                      <ClaimSlip
                        renterId={r.slipRenterId}
                        displayName={r.slipRenterName ?? "This household"}
                        lotNumber={r.lotNumber}
                        parkName={parkName}
                        parkSlug={slug}
                        status={r.claimStatus ?? "none"}
                        email={r.renterEmail}
                        invitedAt={r.invitedAt}
                      />
                    )}
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
                        onClick={() => {
                          setClosingId(closingId === r.currentReservationId ? null : r.currentReservationId);
                          setLastDay(today);
                        }}
                        disabled={pending && busyId === r.currentReservationId}
                      >
                        {closingId === r.currentReservationId ? "Cancel" : "Move out"}
                      </button>
                    )}
                    {/* THE READER. `expected_move_out` was written by an action
                        nothing called and shown on no screen; this pill and
                        the Today card are the whole of its readership. */}
                    {r.expectedMoveOut && (
                      <span className="ll-pill warn">Leaving {pretty(r.expectedMoveOut)}</span>
                    )}
                    {r.currentReservationId && !r.expectedMoveOut && (
                      <button
                        className="ll-btn ghost"
                        onClick={() => {
                          setNoticeId(noticeId === r.currentReservationId ? null : r.currentReservationId);
                          setLeavingOn("");
                        }}
                        disabled={pending && busyId === r.currentReservationId}
                      >
                        {noticeId === r.currentReservationId ? "Cancel" : "Gave notice"}
                      </button>
                    )}
                    {r.currentReservationId && r.expectedMoveOut && (
                      <button
                        className="ll-btn ghost"
                        onClick={() => unnotice(r.currentReservationId!)}
                        disabled={pending && busyId === r.currentReservationId}
                      >
                        They&apos;re staying
                      </button>
                    )}
                    {noticeId && noticeId === r.currentReservationId && (
                      <div className="ll-field" style={{ width: "100%", marginTop: 8 }}>
                        <label>Day they plan to leave</label>
                        <input
                          type="date"
                          value={leavingOn}
                          min={today}
                          onChange={(e) => setLeavingOn(e.target.value)}
                        />
                        <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
                          This changes nothing about the rent — they live here
                          and get billed until they actually go. It is so the
                          lot can be shown before it&apos;s empty, and you can
                          take it back if they change their mind.
                        </p>
                        <button
                          className="ll-btn gold"
                          style={{ marginTop: 8, minHeight: 44 }}
                          disabled={!leavingOn || (pending && busyId === r.currentReservationId)}
                          onClick={() => notice(r.currentReservationId!, leavingOn)}
                        >
                          {pending && busyId === r.currentReservationId ? "Saving…" : "Note it"}
                        </button>
                      </div>
                    )}
                    {closingId && closingId === r.currentReservationId && (
                      <div className="ll-field" style={{ width: "100%", marginTop: 8 }}>
                        <label>Last day they lived here</label>
                        <input
                          type="date"
                          value={lastDay}
                          max={today}
                          onChange={(e) => setLastDay(e.target.value)}
                        />
                        <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
                          Their final month bills for the days they were here —
                          not the whole month. Get this right now: it is what
                          the last bill is calculated from.
                        </p>
                        <button
                          className="ll-btn gold"
                          style={{ marginTop: 8, minHeight: 44 }}
                          disabled={!lastDay || (pending && busyId === r.currentReservationId)}
                          onClick={() => close(r.currentReservationId!, lastDay)}
                        >
                          {pending && busyId === r.currentReservationId ? "Closing…" : "Close it out"}
                        </button>
                      </div>
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
    movedInOn: "", term: "monthly", rent: "", source: "prior_roll",
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

      {/* WHAT A NUMBER HERE ACTUALLY BUYS.
          This promised "rent receipts and freeze warnings by text". Nothing
          sends them: no text this app has issued since 19 July has been
          delivered (error 30034, A2P registration outstanding), and
          `buildTenant` writes contact_pref "paper" unconditionally regardless.
          The Edit panel a hundred lines below says the true thing already —
          this is that sentence, so the same screen stops saying both. It
          matters because he repeats it out loud, at the window, to nineteen
          households, in his first month as their landlord. */}
      <p className="mut" style={{ fontSize: 12.5, marginTop: 10 }}>
        Texting isn&apos;t available yet, so a number here is one the office can
        ring. Nothing is sent to it.
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
    // Blank means "leave it alone" in the builder, so the form starts blank
    // rather than pre-filled — a pre-filled value that fails to load would
    // otherwise overwrite a real one with an empty string.
    email: "",
    mobile: "",
    contactPref: "",
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

      {/* HOW TO REACH THEM — the fields that did not exist.
          The importer files every household with no email and contact_pref
          'paper', and this panel could only change a name and a rent. So the
          emailed receipt was suppressed, the /paid confirmation link never
          left the office, and the overdue reminder degraded to paper for all
          nineteen — permanently, with no screen anywhere to fix it. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 12 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Email</span>
          <input value={form.email ?? ""} inputMode="email" placeholder="none on file"
            onChange={(e) => set("email", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Phone</span>
          <input value={form.mobile ?? ""} inputMode="tel" placeholder="none on file"
            onChange={(e) => set("mobile", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How they want to hear from us</span>
          <select value={form.contactPref ?? ""} onChange={(e) => set("contactPref", e.target.value)}
            style={{ marginTop: 4 }}>
            <option value="">Leave as it is</option>
            <option value="paper">Paper at the door</option>
            <option value="email">Email</option>
          </select>
        </label>
      </div>
      <p className="mut" style={{ fontSize: 12, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
        Leave a box empty to keep what&apos;s there; type a single <b>-</b> to clear it.
        Only set someone to email if <b>they</b> said so — an address off the
        seller&apos;s roll isn&apos;t them asking to be emailed. Texting isn&apos;t
        available yet, so a phone number here is one the office can ring.
      </p>

      {source === "prior_roll" && (
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
