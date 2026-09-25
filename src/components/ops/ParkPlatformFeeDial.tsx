"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import {
  getParkFeeDial,
  raiseParkPlatformInvoice,
  setParkFeeListPrice,
  setParkFeeTerms,
  voidParkPlatformInvoice,
  type ParkFeeDialState,
} from "@/app/ops/park-fee-actions";
import { feeMonthWords, money } from "@/lib/park-platform-fee";

/**
 * WHAT A PARK PAYS LAKELIFE — $ per lot, per month.
 *
 * His words, 24 September 2026: "I like the per lot amount. $8 per lot per
 * month? make it a ops toggle".
 *
 * ============ LABELLED BY WHO PAYS, NOT BY THE WORD "PLATFORM FEE" ============
 *
 * A few hundred pixels above this card, the same tab already says "platform fee
 * +12% onto the customer, −12% out of the crew's quote". That is a DIFFERENT
 * fee, on a different thing, paid by different people. The ops header's own
 * comment is titled "THREE DIFFERENT ANSWERS TO 'WHAT DOES LAKELIFE TAKE', IN
 * ONE VIEWPORT" and exists because this product has already shipped "30%
 * platform margin" and "the 30% platform fee" meaning two different numbers.
 *
 * So this one is named for its payer. Nobody reading the two together should be
 * able to carry one over to the other.
 *
 * ============ AND THE CARD SAYS WHAT DOES NOT EXIST ============
 *
 * Nothing invoices this, nothing is sent, no park can pay it, and no document
 * in force names it. Saying so on the card is not a disclaimer — it is the
 * difference between a figure and a bill, and the person setting it has to know
 * which one he is looking at.
 */
export function ParkPlatformFeeDial() {
  const [state, setState] = useState<ParkFeeDialState | null>(null);
  const [price, setPrice] = useState("");
  const [pending, startTransition] = useTransition();

  async function reload() {
    const s = await getParkFeeDial();
    setState(s);
    setPrice(String(s.listPriceDollars));
  }
  // The IIFE is not decoration: setState called synchronously in an effect body
  // trips react-hooks/set-state-in-effect. Same shape as CrewStandingDial above.
  useEffect(() => {
    void (async () => {
      const s = await getParkFeeDial();
      setState(s);
      setPrice(String(s.listPriceDollars));
    })();
  }, []);

  function savePrice() {
    startTransition(async () => {
      const res = await setParkFeeListPrice(Number(price));
      if (!res.ok) return toast.err(res.error ?? "Couldn't save that.");
      toast(res.sentence ?? "Saved.");
      await reload();
    });
  }

  function saveTerms(parkId: string, ownRate: string, startMonth: string) {
    startTransition(async () => {
      const res = await setParkFeeTerms({
        parkId,
        perLotDollars: ownRate.trim() === "" ? null : ownRate,
        startMonth: startMonth.trim() === "" ? null : startMonth.trim(),
      });
      if (!res.ok) return toast.err(res.error ?? "Couldn't save that.");
      toast(res.sentence ?? "Saved.");
      await reload();
    });
  }

  return (
    <div style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 16 }}>
      <h4 style={{ fontSize: 15, margin: "0 0 4px" }}>What a park pays LakeLife</h4>
      {/* THE CONDITIONAL, AND NAMING WHAT DOES NOT EXIST. Writing "LakeLife
          invoices the park" would describe a mechanism that is not built: the
          reader would go looking for the invoice the park received and find
          that nothing was ever sent, seen or payable. */}
      <p className="mut" style={{ fontSize: 12.5, margin: "0 0 12px", lineHeight: 1.55 }}>
        Per lot, per month, paid by the park owner. <b>No resident is billed any part of
        it.</b> This is a different fee from the customer and crew percentages above —
        those are per job. Nothing invoices this, nothing is sent, and there is no way
        for a park to pay it yet; raising a month only writes the figure down.
      </p>

      <label style={{ display: "block", maxWidth: 220 }}>
        <span className="mut" style={{ fontSize: 13 }}>List price — $ per lot, per month</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={100}
          step="0.5"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
        />
      </label>
      <button className="ll-btn" onClick={savePrice} disabled={pending} style={{ marginTop: 10, minHeight: 44 }}>
        {pending ? "Saving…" : "Save list price"}
      </button>

      {state?.problem && (
        <p className="ll-notice" style={{ marginTop: 12 }}>{state.problem}</p>
      )}

      {state && !state.problem && state.parks.length === 0 && (
        <p className="mut" style={{ fontSize: 13, marginTop: 12 }}>No parks on LakeLife yet.</p>
      )}

      {state && state.parks.length > 0 && (
        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>
            What each park would be invoiced for a month raised today. A park with no
            start month <b>is not being billed at all</b>.
          </p>
          {state.parks.map((p) => (
            <ParkRow key={p.parkId} row={p} pending={pending} onSave={saveTerms} onChanged={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function ParkRow({
  row,
  pending,
  onSave,
  onChanged,
}: {
  row: ParkFeeDialState["parks"][number];
  pending: boolean;
  onSave: (parkId: string, ownRate: string, startMonth: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [ownRate, setOwnRate] = useState(
    row.ownRateCents != null ? String(row.ownRateCents / 100) : "",
  );
  const [start, setStart] = useState(row.startMonth ?? "");
  // EMPTY ON PURPOSE. Defaulting to the current month would answer, on the
  // operator's behalf, the one question this control exists to ask — and a
  // default that asserts a fact has cost this product real money before.
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [moved, setMoved] = useState<{ added: string[]; gone: string[] } | null>(null);

  function raise() {
    if (busy) return;
    setBusy(true);
    void (async () => {
      const res = await raiseParkPlatformInvoice({ parkId: row.parkId, periodMonth: month.trim() });
      setBusy(false);
      if (!res.ok) return toast.err(res.error ?? "Couldn't write that month down.");
      setSaid(res.sentence ?? null);
      setMoved(res.moved ?? null);
      setMonth("");
      toast("Written down. Nothing has been sent.");
      await onChanged();
    })();
  }

  function takeBack(id: string) {
    if (busy) return;
    const why = typeof window === "undefined" ? "" : (window.prompt("Why is this month being taken back? The next raise may count different lots.") ?? "");
    if (!why.trim()) return;
    setBusy(true);
    void (async () => {
      const res = await voidParkPlatformInvoice(id, why);
      setBusy(false);
      if (!res.ok) return toast.err(res.error ?? "Couldn't take that back.");
      toast(res.sentence ?? "Taken back.");
      await onChanged();
    })();
  }

  return (
    <div style={{ background: "var(--slate-soft)", padding: 12, borderRadius: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{row.parkName}</span>
        {row.startMonth
          ? <span className="ll-pill teal">billing from {row.startMonth}</span>
          : <span className="ll-pill slate">not being billed</span>}
        <span style={{ marginLeft: "auto", fontWeight: 700, fontSize: 14 }}>{money(row.amountCents)}/mo</span>
      </div>
      {/* THE SENTENCE NAMES WHAT IT COUNTED AND WHAT IT DID NOT, because
          "20 lots" and a lots screen showing 21 ticked "In service" disagree by
          one lot and $8, and the bill is the one asserting money. */}
      <p className="mut" style={{ fontSize: 12.5, margin: "0 0 10px", lineHeight: 1.5 }}>{row.wouldSay}</p>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <label style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 12 }}>Their own rate (blank = list price)</span>
          <input
            type="number" inputMode="decimal" min={0} max={100} step="0.5"
            value={ownRate} onChange={(e) => setOwnRate(e.target.value)} placeholder="list price"
            style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 12 }}>Starts (YYYY-MM, blank = not billing)</span>
          <input
            value={start} onChange={(e) => setStart(e.target.value)} placeholder="2027-01"
            style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 4 }}
          />
        </label>
      </div>
      {/* PRINTED WHERE THE OBLIGATION IS CREATED, and REWRITTEN in the same
          commit as tos-v4-beta, which is what made the old wording false.
          It used to read "No agreement in force names this fee" — true until
          the park section began naming it.

          What is STILL true, and is the thing the operator needs: the terms
          name the fee as a mechanism and point at the park's own agreement for
          the RATE, deliberately carrying no figure (a tunable dial written into
          a hashed document is false the day it moves). The acceptance ledger
          still has no document kind for a fee schedule, so nothing here records
          that this park agreed to $8 — only that LakeLife believes it is owed. */}
      <p className="mut" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
        The terms name this fee, but they point at <b>this park&apos;s own agreement</b> for
        the rate — so a start month records what LakeLife believes it is owed, and is not
        itself evidence the park agreed the number.
      </p>
      <button
        className="ll-btn sm"
        disabled={pending || busy}
        onClick={() => onSave(row.parkId, ownRate, start)}
        style={{ marginTop: 8, minHeight: 44 }}
      >
        {pending ? "Saving…" : "Save"}
      </button>

      {/* WRITING A MONTH DOWN. Only reachable once the park has a start month:
          without one the action refuses, and so does the database. */}
      {row.startMonth && (
        <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ display: "block", flex: "1 1 150px" }}>
              <span className="mut" style={{ fontSize: 12 }}>Write down a month (YYYY-MM)</span>
              <input
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                placeholder={row.startMonth}
                style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 4 }}
              />
            </label>
            <button className="ll-btn sm" disabled={busy || !month.trim()} onClick={raise} style={{ minHeight: 44 }}>
              {busy ? "Working…" : "Write it down"}
            </button>
          </div>

          {said && <p className="ll-notice" style={{ marginTop: 10 }}>{said}</p>}
          {/* WHAT MOVED, NAMED. Every flag this fee counts is written from the
              PARK's own screens by any park manager, with no sentence there
              saying a tick changes what LakeLife invoices. Untick "In service"
              on six empty pads and the next month is $48 lighter — a different
              number with no explanation unless this says so. */}
          {moved && (moved.added.length > 0 || moved.gone.length > 0) && (
            <p className="ll-notice" style={{ marginTop: 8 }}>
              Since the last month written down:{" "}
              {moved.added.length > 0 && <>joined — {moved.added.map((l) => `Lot ${l}`).join(", ")}. </>}
              {moved.gone.length > 0 && <>no longer counted — {moved.gone.map((l) => `Lot ${l}`).join(", ")}.</>}
            </p>
          )}

          {row.raised === null && (
            <p className="ll-notice" style={{ marginTop: 10 }}>
              We couldn&apos;t read the months already written down for this park, so this
              list is not the whole story.
            </p>
          )}
          {row.raised && row.raised.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gap: 6 }}>
              {row.raised.map((m) => (
                <li key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
                  <span style={{ minWidth: 96 }}>{feeMonthWords(m.periodMonth)}</span>
                  <span className="mut">{m.lotCount} lots</span>
                  <b>{money(m.amountCents)}</b>
                  {m.status === "void"
                    ? <span className="ll-pill slate">taken back</span>
                    : (
                      <button className="ll-btn ghost sm" disabled={busy} onClick={() => takeBack(m.id)} style={{ marginLeft: "auto", minHeight: 40 }}>
                        Take it back
                      </button>
                    )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
