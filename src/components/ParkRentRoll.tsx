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
import { recordSigning } from "@/app/park/sign-actions";
import {
  defaultSigningDay, firstMonthBills, agreementAlreadyOver, signingSeedFor, blankDayWords,
  ranOutLeadWords, SIGNED_LEASE_LABEL, newLeaseWords, type SigningInput,
} from "@/app/park/sign-helpers";
import type { TenantInput, TenantEditInput } from "@/app/park/park-helpers";
import {
  agreementStartFor, latestAgreementStart, dayInWords, EDITABLE_TERMS, TERM_EACH,
} from "@/app/park/park-helpers";
import { offeredAgreementLengths, lengthInWords } from "@/app/park/agreement-helpers";
import { prettyMonth } from "@/app/park/ledger-helpers";
import { prettyPhone } from "@/lib/phone";

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
  state: "inactive" | "occupied" | "lapsed" | "reserved" | "vacant";
  active: boolean;
  currentRenter: string | null;
  currentUnit: string | null;
  currentUntil: string | null;
  currentReservationId: string | null;
  /** The FILE, not the tenancy — a slip is issued against the household. */
  currentRenterId: string | null;
  /**
   * THE HOUSEHOLD WHOSE PAPERWORK RAN OUT — state `lapsed`: a held agreement
   * ended with nothing written after it, and nobody moved out. Who they
   * are, the day it ran out, the row itself (Edit and the close-out are
   * keyed on it, as they are on the current link — a household who could be
   * renewed but not edited, closed out or sent a slip is the bug), and the
   * last day that row covers, which is the latest last-day a close-out can
   * take. All null on every other state.
   */
  lapsedRenter: string | null;
  lapsedOn: string | null;
  lapsedReservationId: string | null;
  lapsedLastDay: string | null;
  /**
   * The household a claim slip should go to, whether they have arrived yet or
   * not. Distinct from currentRenterId, which is who is on the lot TODAY —
   * after importing a roll dated from a future takeover, that is nobody.
   */
  slipRenterId: string | null;
  slipRenterName: string | null;
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
  /** How they pay — 'monthly', 'annual', … — for the Edit panel's select. */
  currentTerm: string | null;
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
  /**
   * The link the notice stands on — the one "They're staying" must clear.
   * Not always the current link: a notice given in January for a February
   * day stays on the January link after the February successor takes over.
   */
  noticeReservationId: string | null;
  nightsLeft: number | null;
  /** A month-to-month tenancy: no real end date, so no countdown. */
  rolling?: boolean;
  /**
   * "3-month lease to April 1, 2027" — the current agreement's own length
   * and end, when it has one. Every fixed-length lease used to read
   * "month-to-month" here (`rolling` meant "paid monthly", not "no end
   * date") while the Today card said its agreement ends in twelve days.
   */
  agreementWords?: string | null;
  /**
   * A FIRST AGREEMENT THE OFFICE FILED AHEAD OF ITS DAY — a signed lease
   * filed on 20 December for 1 January — and the household's only record.
   * Until it starts the row has no current link, so Edit is offered for
   * this one instead, and "Filed by mistake — take them off" withdraws it.
   * Never an approved applicant (decided_at set), never a successor.
   */
  filedByHandId: string | null;
  filedByHandRenter: string | null;
  nextRenter: string | null;
  nextFrom: string | null;
  /**
   * The next agreement's row, when it can be withdrawn from here: this same
   * household's own successor standing behind their current link, or a
   * SUCCESSOR (origin 'office') still to start on a lot with no current
   * link at all — the state a move-out leaves when its cascade fails after
   * the trim. Written early by the renewal screen and, until now, impossible
   * to withdraw from any screen once it existed. Never a household's ONLY
   * record wearing that silhouette: not an imported holdover waiting for
   * go-live, and not an approved applicant (or a lease 'Who lives here'
   * filed ahead of its day) still to arrive — a first agreement is not a
   * 'next' one, and un-approving an applicant is not this control's to do.
   */
  nextReservationId: string | null;
  /**
   * WHAT WITHDRAWING THE NEXT AGREEMENT LEAVES BEHIND, when that agreement
   * is a signing recorded ahead of its day: the holdover was trimmed to end
   * the day the lease begins, and nothing puts its horizon back. The day
   * the household's record then ends, for the confirm to say — null on
   * every other shape.
   */
  withdrawUncoversFrom?: string | null;
  /**
   * THEY SIGNED THE NEW LEASE — set when the stay this row is about is a
   * holdover on the arrangement they already had. Carries what the form
   * starts from: the lot's rate card (the number the lease was written from)
   * or what they paid before, and whatever the file already holds for
   * reaching them.
   */
  signing: {
    reservationId: string;
    renterName: string;
    /**
     * A MONTHLY figure or nothing: the lot's rate card, else what they paid
     * before only when that was filed monthly. A yearly holdover's number in
     * a box the sentence reads as a month quoted "$3,442.53" for January.
     */
    rent: number | null;
    rentFromRateCard: boolean;
    /** How the holdover was filed as paid — so a blank rent box can say why. */
    holdoverTerm: string | null;
    email: string | null;
    phone: string | null;
    /** The holdover's own first day — the form's default when the ledger covers it. */
    holdoverFrom: string | null;
    /**
     * The holdover's END. On or before today, the arrangement has RUN OUT:
     * the successor is written from this day whatever later day is on the
     * paper (planSigning, decision 3), so the form seeds it and says so.
     */
    holdoverTo: string | null;
    /**
     * The park's house style under its cap — the length the form's choice
     * STARTS on, never what the successor must run for; the household picks
     * from the lengths the park offers. Null on a park with neither dial.
     */
    termMonths: number | null;
    /** What a signed agreement on this lot is charged each month, by the biller's rule. */
    feePerMonth: number;
  } | null;
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
  /** Lived on, paperwork run out — never counted in `vacant`. */
  lapsed: number;
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

/** The "Paid" select's words — the filing form's, so the two doors agree. */
const TERM_OPTION: Record<string, string> = {
  monthly: "monthly", weekly: "weekly", seasonal: "seasonally", annual: "yearly", nightly: "nightly",
};

const STATE_STYLE: Record<RollRowView["state"], { pill: string; label: string }> = {
  occupied: { pill: "", label: "Occupied" },
  // Somebody lives here and the paperwork ran out. Read "Vacant / Open"
  // before, on the one screen he looks at most.
  lapsed: { pill: "warn", label: "Ran out" },
  reserved: { pill: "warn", label: "Reserved" },
  vacant: { pill: "slate", label: "Vacant" },
  inactive: { pill: "slate", label: "Off" },
};

/**
 * A SHORT day for the two ends of an application's range ("Jan 5 – Jan 12 ·
 * nightly") — a compact pair inside a card. Every single day a person reads
 * on this screen is dayInWords, with its year: a 'through Apr 1' beside a
 * roll dated in December was a day with no year on it.
 */
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
  cutoverDate = null,
  capMonths,
  termMonths,
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
  /**
   * The park's cutover date, or null. A signed lease filed from this screen
   * may not start before it, and one filed before go-live starts on it.
   */
  cutoverDate?: string | null;
  /**
   * THE PARK'S TWO DIALS, for the length choice on every door here that
   * writes a signed agreement — "Someone lives here" and "They signed the new
   * lease". The cap (`max_agreement_months`) filters the lengths on offer;
   * the term (`agreementMonthsFor(default, max)`) is the one the choice
   * starts on. REQUIRED, not defaulted: a prop nothing passes would offer no
   * choice and the server would refuse every signed row for having none.
   */
  capMonths: number | null;
  termMonths: number | null;
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
  // The signing panel: which holdover just signed the new lease.
  const [signingId, setSigningId] = useState<string | null>(null);
  // The withdrawal: which successor he is about to take back.
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  // Filed by mistake: which not-yet-started first agreement he is about to take off.
  const [removingId, setRemovingId] = useState<string | null>(null);

  function decide(id: string, decision: "approve" | "decline") {
    setBusyId(id);
    startTransition(async () => {
      const res = await decideApplication(id, decision);
      setBusyId(null);
      if (!res.ok) { toast.err(res.error ?? "Couldn't do that."); return; }
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
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't do that.");
        // THE CLOSE-OUT MAY HAVE SAVED. When the cascade fails after the trim
        // the sentence begins "Closed out" and the row must stop offering Move
        // out for the link that has ended — and show whichever control the
        // sentence points at: 'Withdraw the next agreement' when the standing
        // successor is still to start, or Move out on the successor itself
        // when it already covers today (a late close-out). A successor that
        // has already lapsed reads "Ran out" on the row, and Move out is
        // keyed on it too — the sentence still says the record stands, since
        // closing it at a day inside its range is not the day they left.
        // Without a refresh a second tap only gets "That one is already
        // closed."
        if (/^Closed out/.test(res.error ?? "")) {
          setClosingId(null);
          setLastDay("");
          router.refresh();
        }
        return;
      }
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
      if (!res.ok) { toast.err(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Noted.");
      setNoticeId(null);
      setLeavingOn("");
      router.refresh();
    });
  }

  // WITHDRAW THE NEXT AGREEMENT — the `cancelled` branch nothing called.
  //
  // The renewal screen writes a successor up to 45 days early. When the
  // household then leaves, or simply will not renew, that row still held the
  // lot until its end, still billed, and could be reached from no screen:
  // Move out and Gave notice were offered only for the row covering today.
  // Cancelled, not ended — nobody lived in it, so there is nothing to bill.
  //
  // THE SENTENCE IS THE SERVER'S. This toasted "nothing bills for it" from
  // the client, while the successor's February bill — raised on the 1st,
  // $57.47 of the household's money already spent on it — stood open on a
  // cancelled agreement. endTenancy now cancels that bill (money on account
  // goes back) and says so, or refuses when money was taken against it.
  function withdraw(nextId: string) {
    setBusyId(nextId);
    startTransition(async () => {
      const res = await endTenancy(nextId, "cancelled");
      setBusyId(null);
      setWithdrawingId(null);
      if (!res.ok) { toast.err(res.error ?? "Couldn't do that."); return; }
      toast.ok(res.signal ?? "Their next agreement is withdrawn.");
      router.refresh();
    });
  }

  // FILED BY MISTAKE — a first agreement the office filed ahead of its day,
  // taken off before it starts. The same `cancelled` branch (nobody lived
  // there, nothing to prorate), its own words: this is not "the next
  // agreement", it is the household's only record, and once it is gone the
  // lot is open again on Who lives here (getOnboardSeeds re-offers it).
  //
  // THE FIRST SENTENCE IS THE SERVER'S. A row filed ahead can already be
  // billed (a typed ?month= raises January in December), and the cancelled
  // branch voids that bill and says so — a toast written here dropped that
  // sentence, the way withdraw() once did.
  function takeOff(id: string, lotNumber: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await endTenancy(id, "cancelled");
      setBusyId(null);
      setRemovingId(null);
      if (!res.ok) { toast.err(res.error ?? "Couldn't do that."); return; }
      toast.ok(`${res.signal ?? "Taken off."} Lot ${lotNumber} is open again on Who lives here.`);
      router.refresh();
    });
  }

  /** People change their minds, and a stale notice shows a lot as leaving. */
  function unnotice(id: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await clearNotice(id);
      setBusyId(null);
      if (!res.ok) { toast.err(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Cleared.");
      router.refresh();
    });
  }

  function publish(next: boolean) {
    startTransition(async () => {
      const res = await setParkLive(parkId, next);
      if (!res.ok) { toast.err(res.error ?? "Couldn't do that."); return; }
      toast(res.signal ?? "Done.");
      router.refresh();
    });
  }

  const applications = rows.flatMap((r) =>
    r.pending.map((p) => ({ ...p, lotNumber: r.lotNumber, lotId: r.lotId })),
  );

  // Households are on the roll, but none of their tenancies has started yet —
  // the shape of a park imported before its closing date. A lapsed tenancy
  // HAS started: its household lives there on paper that ran out.
  const notYetStarted = summary.occupied === 0 && summary.lapsed === 0 && summary.reserved > 0;

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      {/* The page title every other park tab has — this one opened straight
          on the numbers grid. */}
      <h1 style={{ fontSize: 26, margin: "0 0 12px" }}>Rent roll</h1>
      {/* ---- the numbers a park owner actually wants ---- */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 16 }}>
        {/* BEFORE IT IS HIS, THIS PARK IS NOT EMPTY — IT IS NOT YET HIS.
            Imported tenancies begin at cutover, so between the import and
            closing day every one of them is `reserved` and none is `occupied`.
            This read "Occupied 0 · 0% · Owed $0" for the four months leading up
            to December 15th — on the default landing screen, about a fully let
            park. A measured-looking zero is worse than no number. */}
        {/* LIVED ON, whether or not the paperwork is in date — the same count
            the percentage beside it is built from. "Occupied 0 · 100%" is
            what these two tiles said the morning every lease lapsed. */}
        <Stat
          label={notYetStarted ? "Spoken for" : "Occupied"}
          value={notYetStarted ? `${summary.reserved}` : `${summary.occupied + summary.lapsed}`}
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
        {/* RAN OUT IS NOT VACANT. A household whose agreement expired with
            nothing written after it still lives there; the morning eighteen
            one-month leases lapsed this tile read "18" about a full park.
            They are counted in the percentage above and named here. */}
        <Stat
          label="Vacant"
          value={`${summary.vacant}`}
          sub={summary.lapsed ? `${summary.lapsed} ran out` : summary.reserved ? `${summary.reserved} reserved` : ""}
        />
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
          <Stat label="Owed this month" value="—" sub="not billed yet · anything paid goes on account" />
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
            // THE HOUSEHOLD ON THE LOT: the link covering today, else the
            // one that ran out with them still there. Edit, Move out and the
            // close-out panel are keyed on it — keyed on the current link
            // alone, a lapsed row offered nothing but a renewal.
            const onLot = r.currentReservationId ?? r.lapsedReservationId;
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
                              : r.agreementWords
                                ? ` · ${r.agreementWords}`
                                : ` · through ${r.currentUntil ? dayInWords(r.currentUntil) : "—"}`}
                            {r.nightsLeft != null && ` (${r.nightsLeft} night${r.nightsLeft === 1 ? "" : "s"} left)`}
                          </span>
                        </>
                      )}
                      {r.state === "reserved" && (
                        <span className="mut">{r.nextRenter} arrives {r.nextFrom ? dayInWords(r.nextFrom) : "—"}</span>
                      )}
                      {/* RAN OUT, NOT VACANT. Nobody moved out; the paperwork
                          ended, and nothing has billed since (the run skips
                          an expired row). The door is the household's own
                          signing control when the arrangement was the
                          seller's, else Today's Agreements-to-write list —
                          the same door the rent screen's expired line names. */}
                      {r.state === "lapsed" && (
                        <>
                          {r.lapsedRenter}
                          <span className="mut">
                            {" — "}agreement ran out {r.lapsedOn ? dayInWords(r.lapsedOn) : "—"}; nothing billed since.
                            {!r.signing && (
                              <> Renew it under <Link href="/park/today">Agreements to write on Today</Link>.</>
                            )}
                          </span>
                        </>
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
                    {/* EDIT: the link on the lot (current, else the one that
                        ran out), else the agreement the office filed ahead
                        of its day. A wrong rent typed on 20 December for
                        1 January had no door until the 1st, the morning
                        January bills. */}
                    {(onLot ?? r.filedByHandId) && (
                      <button
                        className="ll-btn ghost"
                        onClick={() => {
                          const id = onLot ?? r.filedByHandId!;
                          setEditingId(editingId === id ? null : id);
                        }}
                      >
                        {editingId === (onLot ?? r.filedByHandId) ? "Cancel" : "Edit"}
                      </button>
                    )}
                    {/* FILED BY MISTAKE — take a not-yet-started first
                        agreement off the roll. Its own words, never the
                        withdraw control's: this is not a "next" agreement. */}
                    {r.filedByHandId && !r.currentReservationId && (
                      removingId === r.filedByHandId ? (
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="mut" style={{ fontSize: 13 }}>
                            Take {r.filedByHandRenter ?? "them"} off lot {r.lotNumber}? If it&apos;s already billed, that bill is cancelled; the lot opens again on Who lives here.
                          </span>
                          <button className="ll-btn sm" style={{ minHeight: 36 }}
                            disabled={pending && busyId === r.filedByHandId}
                            onClick={() => takeOff(r.filedByHandId!, r.lotNumber)}>
                            {pending && busyId === r.filedByHandId ? "Taking off…" : "Yes"}
                          </button>
                          <button className="ll-btn ghost sm" style={{ minHeight: 36 }}
                            onClick={() => setRemovingId(null)}>
                            No
                          </button>
                        </span>
                      ) : (
                        <button
                          className="ll-btn ghost"
                          onClick={() => setRemovingId(r.filedByHandId)}
                          disabled={pending && busyId === r.filedByHandId}
                        >
                          Filed by mistake — take them off
                        </button>
                      )
                    )}
                    {/* MOVE OUT, for the link on the lot. On a row that ran
                        out the last day starts on — and cannot pass — the
                        last day that row covers (planMoveOut refuses a day
                        none of their agreements covers); seeded with today
                        it opened on a day the server would refuse. */}
                    {onLot && (
                      <button
                        className="ll-btn ghost"
                        onClick={() => {
                          setClosingId(closingId === onLot ? null : onLot);
                          setLastDay(r.currentReservationId ? today : r.lapsedLastDay ?? today);
                        }}
                        disabled={pending && busyId === onLot}
                      >
                        {closingId === onLot ? "Cancel" : "Move out"}
                      </button>
                    )}
                    {/* THE READER. `expected_move_out` was written by an action
                        nothing called and shown on no screen; this pill and
                        the Today card are the whole of its readership. */}
                    {r.expectedMoveOut && (
                      <span className="ll-pill warn">Leaving {dayInWords(r.expectedMoveOut)}</span>
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
                    {/* CLEARED ON THE LINK THAT HOLDS IT. Notice given in
                        January for a February day stands on the January
                        link; on the 1st the February successor is `current`
                        and clearing it there would clear nothing. */}
                    {(r.noticeReservationId ?? r.currentReservationId) && r.expectedMoveOut && (
                      <button
                        className="ll-btn ghost"
                        onClick={() => unnotice((r.noticeReservationId ?? r.currentReservationId)!)}
                        disabled={pending && busyId === (r.noticeReservationId ?? r.currentReservationId)}
                      >
                        They&apos;re staying
                      </button>
                    )}
                    {/* THE SIGNATURE, RECORDED WHERE TODAY SENDS HIM. The
                        "N households haven't signed" card points at this
                        row, and until now the row had nothing to record it
                        with. Shown for a holdover whether or not they have
                        arrived yet, because before go-live that is everybody
                        on an imported roll. */}
                    {r.signing && (
                      <button
                        className="ll-btn ghost"
                        onClick={() => {
                          setSigningId(signingId === r.signing!.reservationId ? null : r.signing!.reservationId);
                        }}
                        disabled={pending && busyId === r.signing.reservationId}
                      >
                        {signingId === r.signing.reservationId ? "Cancel" : SIGNED_LEASE_LABEL}
                      </button>
                    )}
                    {r.nextReservationId && (
                      withdrawingId === r.nextReservationId ? (
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="mut" style={{ fontSize: 13 }}>
                            Withdraw their {r.nextFrom ? prettyMonth(r.nextFrom.slice(0, 7)) : "next"} agreement? If it&apos;s already billed, that bill is cancelled and money on account for it goes back.
                            {r.withdrawUncoversFrom && (
                              // A signing recorded ahead: the arrangement
                              // before it was trimmed to end on the lease
                              // day, and withdrawing the lease does not put
                              // that back — the lot reads open from then.
                              <> The arrangement they had still ends on {dayInWords(r.withdrawUncoversFrom)} — record the signing again from this row, or the lot reads open from that day.</>
                            )}
                          </span>
                          <button className="ll-btn sm" style={{ minHeight: 36 }}
                            disabled={pending && busyId === r.nextReservationId}
                            onClick={() => withdraw(r.nextReservationId!)}>
                            {pending && busyId === r.nextReservationId ? "Withdrawing…" : "Yes"}
                          </button>
                          <button className="ll-btn ghost sm" style={{ minHeight: 36 }}
                            onClick={() => setWithdrawingId(null)}>
                            No
                          </button>
                        </span>
                      ) : (
                        <button
                          className="ll-btn ghost"
                          onClick={() => setWithdrawingId(r.nextReservationId)}
                          disabled={pending && busyId === r.nextReservationId}
                        >
                          Withdraw the next agreement
                        </button>
                      )
                    )}
                    {r.signing && signingId === r.signing.reservationId && (
                      <SignedNewLease
                        parkId={parkId}
                        seed={r.signing}
                        today={today}
                        cutoverDate={cutoverDate}
                        capMonths={capMonths}
                        onDone={() => setSigningId(null)}
                      />
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
                    {closingId && closingId === onLot && (
                      <div className="ll-field" style={{ width: "100%", marginTop: 8 }}>
                        <label>Last day they lived here</label>
                        <input
                          type="date"
                          value={lastDay}
                          max={r.currentReservationId ? today : r.lapsedLastDay ?? today}
                          onChange={(e) => setLastDay(e.target.value)}
                        />
                        <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
                          {/* A ROW THAT RAN OUT covers nothing after its end.
                              A later last day is refused by the server, so
                              the box stops there and the reason is said. */}
                          {!r.currentReservationId && r.lapsedLastDay && (
                            <>Their record here runs to {dayInWords(r.lapsedLastDay)} — the last day can&apos;t be after that. </>
                          )}
                          Their final month bills for the days they were here —
                          not the whole month. If that month is already billed,
                          the close-out re-does the bill for those days where it
                          can and says what happened to any money on it. Get this
                          right now: it is what the last bill is calculated from.
                        </p>
                        <button
                          className="ll-btn gold"
                          style={{ marginTop: 8, minHeight: 44 }}
                          disabled={!lastDay || (pending && busyId === onLot)}
                          onClick={() => close(onLot, lastDay)}
                        >
                          {pending && busyId === onLot ? "Closing…" : "Close it out"}
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

                {editingId && editingId === (onLot ?? r.filedByHandId) && (
                  <EditTenant
                    reservationId={editingId}
                    name={r.currentRenter ?? r.lapsedRenter ?? r.filedByHandRenter ?? ""}
                    rent={r.currentRent}
                    dueDay={r.currentDueDay}
                    source={r.currentSource}
                    term={r.currentTerm}
                    onDone={() => setEditingId(null)}
                  />
                )}

                {addingTo === r.lotId && (
                  <AddTenant
                    parkId={parkId}
                    lotId={r.lotId}
                    lotNumber={r.lotNumber}
                    today={today}
                    cutoverDate={cutoverDate}
                    capMonths={capMonths}
                    termMonths={termMonths}
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
  parkId, lotId, lotNumber, today, cutoverDate, capMonths, termMonths, onDone,
}: {
  parkId: string; lotId: string; lotNumber: string;
  today: string; cutoverDate: string | null;
  /** The park's cap and house style — the lengths on offer, and the one the choice starts on. */
  capMonths: number | null; termMonths: number | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<TenantInput>({
    displayName: "", mobile: "", email: "",
    movedInOn: "", term: "monthly", rent: "", source: "prior_roll",
    // NOBODY HAS SIGNED ANYTHING until he says so. This door had no tick at
    // all and wrote no origin, so the column default filed every household
    // typed here as having agreed to the fee. The tick is a claim about a
    // piece of paper; it starts clear and only the person holding the paper
    // may set it.
    signedNewLease: false,
    agreementStartsOn: "",
    agreementMonths: null,
  });
  const set = <K extends keyof TenantInput>(k: K, v: TenantInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // THE LENGTHS THE PARK OFFERS, for the choice a signed lease carries. The
  // same list the server judges the choice against (chooseAgreementLength).
  const lengths = offeredAgreementLengths(termMonths, capMonths);

  // THE DAY A SIGNED LEASE RUNS FROM, seeded when the tick is set: the
  // cutover before go-live (the one date true of a lease collected early),
  // BLANK after it — seeded with today it filed a lease that says the 1st
  // from the day it was typed, under a hint reading "the day on the paper,
  // not today". agreementStartFor refuses a blank after go-live, so the box
  // starts empty and he types the date. Cleared with the tick — a holdover
  // has no agreement start. THE LENGTH likewise: seeded with the park's
  // house style, his to change, cleared with the tick.
  const defaultStart = agreementStartFor("", today, cutoverDate);
  const tick = (signed: boolean) =>
    setForm((f) => ({
      ...f,
      signedNewLease: signed,
      agreementStartsOn: signed && defaultStart.ok ? defaultStart.start : "",
      agreementMonths: signed ? termMonths : null,
    }));
  const latestStart = latestAgreementStart(today);

  function save() {
    startTransition(async () => {
      const res = await addTenant(parkId, lotId, form);
      if (!res.ok) { toast.err(res.error ?? "Couldn't save."); return; }
      toast.ok(res.signal ?? "Added.");
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
          <span className="mut">{form.signedNewLease ? "Best number" : "Best number (optional)"}</span>
          <input type="tel" inputMode="tel" value={form.mobile} placeholder="(260) 555-0142"
            onChange={(e) => set("mobile", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        {/* THE EMAIL THAT COULD NOT BE TYPED. This form hard-coded email to
            "" — so no household filed from the roll could ever be emailed a
            slip, and a signed lease (which needs both) could not be filed
            here at all. */}
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">{form.signedNewLease ? "Email" : "Email (optional)"}</span>
          <input type="email" inputMode="email" autoCapitalize="off" autoCorrect="off"
            value={form.email} placeholder="donna@example.com"
            onChange={(e) => set("email", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Rent (optional)</span>
          <input inputMode="decimal" value={form.rent} placeholder="340"
            onChange={(e) => set("rent", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        {/* WHEN THEY ARRIVED — the field the filing screen already had and
            this door did not. Kept apart from the agreement window: a
            household of eleven years filed on the arrangement they had is
            billed from where the ledger's claim on them starts, and their
            arrival is recorded as what it was. Blank means unknown, and
            stays unknown. */}
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Moved in on (optional)</span>
          <input type="date" value={form.movedInOn} max={today}
            onChange={(e) => set("movedInOn", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Paid</span>
          {/* The same four ways, in the same words, as the Edit panel's select. */}
          <select value={form.term} onChange={(e) => set("term", e.target.value)} style={{ marginTop: 4 }}>
            {EDITABLE_TERMS.map((t) => (
              <option key={t} value={t}>{TERM_OPTION[t]}</option>
            ))}
          </select>
        </label>
      </div>

      {/* THE TICK THE FILING SCREEN HAS AND THIS DOOR DID NOT. Clear writes a
          holdover on the arrangement they already had — no fee, no cap — from
          where the ledger's claim on them starts (the cutover once it has
          passed, else today). Ticked writes a real agreement, from the day
          the lease says, and needs both ways to reach them. */}
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, fontSize: 14 }}>
        <input type="checkbox" checked={!!form.signedNewLease} style={{ marginTop: 3 }}
          onChange={(e) => tick(e.target.checked)} />
        <span>
          They&apos;ve signed the new lease.
          <span className="mut"> Leave it clear if they&apos;re still on the arrangement they
          already had — that carries on as it is, and no fee bills until they sign.</span>
        </span>
      </label>
      {form.signedNewLease && (
        <div className="ll-field" style={{ fontSize: 13, marginTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">The lease runs from</span>
              <input
                type="date"
                value={form.agreementStartsOn ?? ""}
                min={cutoverDate ?? undefined}
                max={latestStart}
                onChange={(e) => set("agreementStartsOn", e.target.value)}
                style={{ marginTop: 4 }}
              />
            </label>
            {/* HOW LONG IT RUNS — the household's choice from the lengths
                the park offers, starting on the house style. The server
                refuses any other length, so only these are offered. */}
            {lengths.length > 0 && (
              <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                <span className="mut">For</span>
                <select value={form.agreementMonths ?? ""} style={{ marginTop: 4 }}
                  onChange={(e) => set("agreementMonths", e.target.value ? Number(e.target.value) : null)}>
                  {lengths.map((m) => (
                    <option key={m} value={m}>{lengthInWords(m)}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
            The day on the paper, not today — the first month bills from this
            day{form.agreementStartsOn ? ` (${dayInWords(form.agreementStartsOn)})` : ", so type it"}.
            {lengths.length > 1 ? " The length is theirs to pick at every renewal too." : ""}
            {" "}Email and phone are a condition of the new lease, so both are needed.
          </p>
        </div>
      )}

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

/**
 * THEY SIGNED THE NEW LEASE — the form.
 *
 * Five things and no more: THE DAY THE NEW LEASE RUNS FROM (the day on the
 * paper — never today, which is the day the office got round to it), HOW
 * LONG IT RUNS (the household's pick from the lengths the park offers,
 * starting on the house style — the owner's one-three-or-six decision), the
 * rent on the paper (started from the lot's rate card, the number the lease
 * was written from), and the two ways to reach them that are a condition of
 * the lease. The arrangement they had ends the day the new lease starts and
 * the new agreement runs from it — see sign-helpers.ts for what that means
 * for the bill, which this form says BEFORE the write.
 *
 * The date starts from the holdover's own first day when the ledger already
 * covers it (an imported row's 1 January) and is otherwise blank. Seeded with
 * today, eighteen leases for 1 January recorded on the 4th billed January
 * three days of the seller's rent plus 28/31 of the lease, and ran every
 * later link 4th-to-4th. And it is left blank — with the reason — when an
 * agreement from that day would already be over AT THE LENGTH PICKED
 * (1 January at one month, opened on 15 February): the planner refuses that
 * day, so seeding it and saying "keep the day on the paper" offered the one
 * date that cannot be recorded. Judged at the pick, every render, and
 * re-seeded when the pick changes — at three months 1 January is still
 * running, and the box fills. Which link to write for a lease recorded a
 * month late is the owner's call; the form does not guess.
 *
 * AN ARRANGEMENT THAT RAN OUT (seed.holdoverTo on or before today) seeds its
 * own END instead — decision 3, 16 Sep: the successor is written from the
 * day the arrangement ended, so the days since are on the lease's rent, not
 * free and not a fresh start from the next 1st. The box stays typeable: a
 * day INSIDE the old arrangement is the trim case the server accepts (the
 * paper ran from 15 December; the arrangement ran out 1 January; the row is
 * written from the 15th), and a later day is written from the end whatever
 * it says — so the lead line (ranOutLeadWords) says both. The box is never
 * emptied for that shape (signingSeedFor): the rule that blanks a day whose
 * agreement is over at the length picked would leave an empty box under
 * "Pick the day the new lease runs from" — an instruction with no control,
 * since the end is the day whatever he types. When the pick is over from
 * the end, the lead line names the lengths that reach (or that none does)
 * and the button is withheld, rather than refusing after the tap.
 *
 * The rent box holds a MONTHLY figure or nothing (signingRentSeed); the
 * phone is shown back the way a person writes it.
 */
function SignedNewLease({
  parkId, seed, today, cutoverDate, capMonths, onDone,
}: {
  parkId: string;
  seed: NonNullable<RollRowView["signing"]>;
  today: string;
  cutoverDate: string | null;
  /** The park's cap — with the seed's term, the lengths on offer. */
  capMonths: number | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // THE LENGTHS THE PARK OFFERS — the household's choice, starting on the
  // park's house style (seed.termMonths). The server judges the pick against
  // the same list, so nothing is offered here that it would refuse.
  const lengths = offeredAgreementLengths(seed.termMonths, capMonths);
  // THE ARRANGEMENT HAS RUN OUT: its end is on or before today. The
  // successor is written from that end (planSigning), so the end is the
  // seed and the judge of 'already over' — never re-run through
  // signingDayForLength, which would empty the box.
  const ranOut = !!seed.holdoverTo && seed.holdoverTo <= today;
  // THE DAY THE BOX WOULD START FROM, AND WHETHER IT MAY. An imported row's
  // 1 January under a one-month term, recorded on 15 February, is an
  // agreement already over — the planner refuses it, so the box is left
  // blank and the reason is said, rather than seeding the one day that
  // cannot be recorded and telling him to keep it. For an arrangement that
  // ran out, defaultSigningDay answers its END.
  const seededDay = defaultSigningDay(seed.holdoverFrom, cutoverDate, seed.holdoverTo, today);
  const [form, setForm] = useState<SigningInput>({
    // Seeded for the house style — blank when an agreement from that day
    // would already be over at it (signingSeedFor: signingDayForLength's
    // rule, the one the length select re-applies on every change — except
    // for an arrangement that ran out, which keeps its end in the box
    // whatever the length: the end IS the day).
    signedOn: signingSeedFor(seededDay, seededDay, seed.termMonths, today, ranOut),
    rent: seed.rent == null ? "" : String(seed.rent),
    email: seed.email ?? "",
    // Shown back the way a person writes it, never in the stored form.
    mobile: prettyPhone(seed.phone),
    // The house style, until he picks what the lease says.
    agreementMonths: seed.termMonths,
  });
  // JUDGED AT THE LENGTH PICKED, EVERY RENDER. 1 January on 15 February is
  // over at one month and running at three; judged at the house style once,
  // the blank-box sentence outlived his pick of '3 months' and told him the
  // one day the server would take could not be recorded. Not for an
  // arrangement that ran out — its box is never blanked; see below.
  const seededDayOver = !ranOut && !!seededDay && agreementAlreadyOver(seededDay, form.agreementMonths, today);
  // AN ARRANGEMENT THAT RAN OUT, AT THE LENGTH PICKED. The successor runs
  // from the end (or from a typed day inside the old arrangement, which is
  // earlier still and reaches less far), so the end is the furthest any
  // length reaches: over from it at the pick, nothing this form can send
  // is accepted. The lead line (ranOutLeadWords) names the lengths that do
  // reach, in the server's own words; the button is withheld rather than
  // refused after the tap.
  const ranOutOverAtPick = ranOut && agreementAlreadyOver(seededDay, form.agreementMonths, today);
  // THE DAY THE ROW IS WRITTEN FROM — what the sentence below is about. A
  // day typed after an arrangement that ran out is written from the end
  // (planSigning); one inside the arrangement is the trim case, from itself.
  const runsFrom = ranOut && form.signedOn > seededDay ? seededDay : form.signedOn;
  // WHAT THE FIRST MONTH BILLS, from the date and rent as typed — the same
  // sentence the toast will quote, so nothing is learned only after the
  // write. Nothing is quoted until both boxes hold something real.
  const rentTyped = Number(form.rent.trim().replace(/[$,\s]/g, ""));
  const firstMonth =
    /^\d{4}-\d{2}-\d{2}$/.test(runsFrom) && form.rent.trim() && Number.isFinite(rentTyped) && rentTyped >= 0
      ? firstMonthBills(runsFrom, Math.round(rentTyped * 100) / 100, seed.feePerMonth, seed.holdoverFrom)
      : null;
  const set = <K extends keyof SigningInput>(k: K, v: SigningInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  function save() {
    startTransition(async () => {
      const res = await recordSigning(parkId, seed.reservationId, form);
      if (!res.ok) { toast.err(res.error ?? "Couldn't record that."); return; }
      toast.ok(res.signal ?? "Recorded.");
      onDone();
      router.refresh();
    });
  }

  // A LEASE IN HIS HAND IS A FACT THE DAY IT IS IN HIS HAND. This screen
  // used to refuse a December signing until 1 January ("can be recorded
  // from … the day the ledger starts") while "Who lives here" filed the
  // same paper the same afternoon — and the wait put every on-time signing
  // AFTER January's bills. The box takes the same window the filing screen
  // does: from the cutover, up to two months ahead.
  const latestStart = latestAgreementStart(today);

  return (
    <div className="ll-field" style={{ width: "100%", marginTop: 8 }}>
      <p style={{ fontSize: 13, margin: "0 0 8px", lineHeight: 1.5 }}>
        <strong>{seed.renterName}</strong> signed the new lease.{" "}
        {ranOut
          // THE ARRANGEMENT RAN OUT. The row is written from its end whatever
          // later day is on the paper — the days since are on the lease's
          // rent (decision 3) — and a day inside the old arrangement is the
          // trim case the server accepts. Said whole, in the planner's own
          // words (ranOutLeadWords, which adds the lengths that reach when
          // the pick is over from that day), so the box he can type in is
          // not a promise the write will keep.
          ? ranOutLeadWords(seededDay, form.agreementMonths, lengths, today)
          : "The arrangement they had ends the day the new lease starts and the new agreement runs from it."}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">The new lease runs from</span>
          <input type="date" value={form.signedOn} min={cutoverDate ?? undefined} max={latestStart}
            onChange={(e) => set("signedOn", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        {/* HOW LONG THE LEASE RUNS — one of the lengths the park offers. */}
        {lengths.length > 0 && (
          <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut">For</span>
            <select value={form.agreementMonths ?? ""} style={{ marginTop: 4 }}
              onChange={(e) => {
                const months = e.target.value ? Number(e.target.value) : null;
                // The day box follows the pick: a blank box fills with the
                // seeded day once a length keeps it open, and empties again
                // when it does not. A day he typed is never touched. An
                // arrangement that ran out keeps its day: the end is the
                // day whatever the length, and emptying the box would leave
                // "Pick the day" about a day that is not his to pick.
                setForm((f) => ({
                  ...f,
                  agreementMonths: months,
                  signedOn: signingSeedFor(seededDay, f.signedOn, months, today, ranOut),
                }));
              }}>
              {lengths.map((m) => (
                <option key={m} value={m}>{lengthInWords(m)}</option>
              ))}
            </select>
          </label>
        )}
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Rent on the lease</span>
          <input inputMode="decimal" value={form.rent} placeholder="400"
            onChange={(e) => set("rent", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Email</span>
          <input type="email" inputMode="email" autoCapitalize="off" autoCorrect="off"
            value={form.email} placeholder="none on file yet"
            onChange={(e) => set("email", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Phone</span>
          <input type="tel" inputMode="tel" value={form.mobile} placeholder="(260) 555-0142"
            onChange={(e) => set("mobile", e.target.value)} style={{ marginTop: 4 }} />
        </label>
      </div>
      <p className="mut" style={{ fontSize: 12, margin: "8px 0 0", lineHeight: 1.5 }}>
        {seededDayOver ? (
          // WHY THE BOX IS BLANK AT THE LENGTH PICKED, and what to do only
          // when the screen can honour it (blankDayWords: 'pick a longer
          // length' only when one keeps the day open). Which link to write
          // for a lease recorded a month late is the owner's call.
          <>
            The day is left blank: {blankDayWords(seededDay, form.agreementMonths, lengths, today)}.
            The day you type is the day the new agreement runs from, and the first month
            bills from it.{" "}
          </>
        ) : ranOut ? (
          // The lead line above has already said where the row runs from
          // and, when the pick is over from that day, which lengths reach.
          <>The day on the paper only if it falls inside the old arrangement — otherwise the day it ran out.{" "}</>
        ) : (
          <>The day on the paper, not today — the first month bills from this day.{" "}</>
        )}
        {seed.rentFromRateCard
          ? "The rent starts from the lot's rate card — change it if the lease says otherwise. "
          : seed.rent != null
            ? "The rent starts from what they paid before — change it to what the lease says. "
            : seed.holdoverTerm && seed.holdoverTerm !== "monthly"
              // A yearly figure is not divided for him — the Edit panel holds
              // the same line. The lease is monthly; its number is the one.
              ? `They were filed as paid ${TERM_OPTION[seed.holdoverTerm] ?? seed.holdoverTerm} — type what the lease says each month. `
              : "No rent was on file for them — type what the lease says each month. "}
        Email and phone are a condition of the new lease, so both are needed.
      </p>
      {firstMonth && !ranOutOverAtPick && (
        // FROM THE DAY THE ROW IS WRITTEN FROM (runsFrom) — for an
        // arrangement that ran out, its end, not a later day in the box.
        <p style={{ fontSize: 13, margin: "8px 0 0", lineHeight: 1.5 }}>
          On the {newLeaseWords(form.agreementMonths)} from <strong>{dayInWords(runsFrom)}</strong> — {firstMonth}.
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="ll-btn gold" style={{ minHeight: 44 }} onClick={save}
          disabled={pending || !form.signedOn || !form.rent.trim() || ranOutOverAtPick}>
          {pending ? "Recording…" : "Record the new lease"}
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
  reservationId, name, rent, dueDay, source, term, onDone,
}: {
  reservationId: string;
  name: string;
  rent: number | null;
  dueDay: number | null;
  source: string | null;
  /** How they pay today — what the "Paid" select starts on. */
  term: string | null;
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
    // The select shows what they pay today; the same value is no change.
    term: term ?? "",
  });
  const set = <K extends keyof TenantEditInput>(k: K, v: TenantEditInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  // CHANGING HOW THEY PAY EMPTIES THE RENT BOX. The figure on the row is for
  // the old way of paying — $3,600 a year is not a monthly rent, and it is
  // not divided into one here either. He types what they pay each month.
  // Picking the original way back restores the original figure.
  const termChanged = !!form.term && form.term !== (term ?? "");
  const pickTerm = (next: string) =>
    setForm((f) => ({
      ...f,
      term: next,
      rent: next === (term ?? "") ? (rent == null ? "" : String(rent)) : "",
    }));

  function save() {
    startTransition(async () => {
      const res = await editTenancy(reservationId, form);
      if (!res.ok) { toast.err(res.error ?? "Couldn't save."); return; }
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
          <span className="mut">{termChanged ? `Rent (${TERM_EACH[form.term ?? ""] ?? "for the new way of paying"})` : "Rent"}</span>
          <input value={form.rent} inputMode="decimal" placeholder={termChanged ? "type it" : "Not set"}
            onChange={(e) => set("rent", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Due day</span>
          <input value={form.dueDay} inputMode="numeric" placeholder="1"
            onChange={(e) => set("dueDay", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        {/* HOW THEY PAY — the control the charge run sends him here for. The
            run bills months only and names a tenancy filed as paid yearly;
            this is the one door that moves it. Mirrors the filing form's
            select, plus the current value when it is one the form no longer
            offers. */}
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Paid</span>
          <select value={form.term ?? ""} onChange={(e) => pickTerm(e.target.value)} style={{ marginTop: 4 }}>
            {term && !EDITABLE_TERMS.includes(term as (typeof EDITABLE_TERMS)[number]) && (
              <option value={term}>{TERM_OPTION[term] ?? term}</option>
            )}
            {EDITABLE_TERMS.map((t) => (
              <option key={t} value={t}>{TERM_OPTION[t]}</option>
            ))}
          </select>
        </label>
      </div>
      {termChanged && (
        <p className="mut" style={{ fontSize: 12, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
          Paid {TERM_OPTION[form.term ?? ""] ?? form.term} from now on — type what they pay{" "}
          {TERM_EACH[form.term ?? ""] ?? "under the new way of paying"}. The old figure
          isn&apos;t divided for you.{" "}
          {form.term === "monthly"
            ? "The next run bills this number."
            : "The monthly run bills months only, so it won't bill a tenancy paid this way."}
        </p>
      )}

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
