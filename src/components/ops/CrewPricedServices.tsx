"use client";

/**
 * WHICH SERVICES THE CREWS PRICE — the control, and the look before the flip.
 *
 * Brendon, 23 September 2026: "Lake life doesnt set the pricing, crew does
 * still... crew prices 2 acre yard at $50, we add on 12% to the home owner and
 * take 12% from the Crew."
 *
 * `services.crew_priced` has existed since 0174 and nothing in the product
 * could write it. This is its writer, and it sits on the pricing-dials card
 * beside the two fee percentages it depends on, because it is the same
 * person's decision about the same money.
 *
 * NOTHING IS ON TODAY. Every service is menu-priced, and this card switches
 * nothing by itself — he does, one service at a time, after reading what the
 * flip would do.
 *
 * THE FOUR THINGS THIS PRINTS BEFORE ANY SWITCH IS TOUCHED, per service:
 *   · what the menu charges now, so the thing being turned off is named;
 *   · how many ACTIVE, NON-FIXTURE crews hold a real rate card for it — all
 *     three production vendors are fixtures, so an unfenced "3" would read as
 *     a stocked bench that does not exist;
 *   · whether work is already booked (it keeps its frozen price; nothing sold
 *     ever reprices);
 *   · which parks keep their own negotiated number, because a park's own rate
 *     beats a crew's card and The Haven's mow must not move.
 *
 * A REFUSAL IS NOT A MISSING BUTTON. Two live services cannot do this
 * arithmetic, and each one says so in its own words instead of being quietly
 * absent from the list.
 */

import { useEffect, useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import {
  getCrewPricedServices,
  setServiceCrewPriced,
  type CrewPricedState,
  type CrewPricedServiceRow,
} from "@/app/ops/crew-priced-actions";

export function CrewPricedServices() {
  const [state, setState] = useState<CrewPricedState | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    void (async () => setState(await getCrewPricedServices()))();
  }, []);

  function flip(row: CrewPricedServiceRow, on: boolean) {
    startTransition(async () => {
      const res = await setServiceCrewPriced(row.id, on);
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't change that.");
        return;
      }
      if (res.warning) toast.err(res.warning);
      else toast(on ? `${row.name} is now priced by the crews.` : `${row.name} is back on the menu price.`);
      setConfirming(null);
      setState(await getCrewPricedServices());
    });
  }

  const pct = (p: number) => `${Math.round(p * 10_000) / 100}%`;

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <h4 style={{ fontSize: 15, margin: "0 0 4px" }}>Who sets the price, service by service</h4>
      <p className="mut" style={{ fontSize: 12.5, margin: "0 0 10px", lineHeight: 1.55 }}>
        Every service is on the LakeLife menu price today. Move one across and there is no menu price
        for it at all: the customer sees each crew&rsquo;s own number, picks one, and pays that quote
        plus the customer fee while the crew is paid it less the crew fee. Work already booked never
        reprices &mdash; a job sold at a crew&rsquo;s quote keeps that quote and both percentages, and
        a job sold at the menu price keeps the figure its customer was shown even if a crew&rsquo;s own
        number differs.
      </p>

      {/* A FAILED READ IS NOT AN EMPTY LIST, and must not render as a card with
          nothing to worry about. */}
      {state && !state.ok && (
        <p className="ll-notice" style={{ margin: "0 0 10px" }}>
          {state.error} Until that reads there is no way to tell what moving a service across would do,
          so nothing here can be switched.
        </p>
      )}

      {/* THE CAUSE IS LIKELY, NOT CHECKED. All this knows is that the log
          table did not read; it has not asked whether 0179 was applied, and a
          transient failure would have printed a migration status as fact. The
          refusal is the same either way, so the sentence names the probable
          cause as probable and stops there. */}
      {state?.ok && state.logReady === false && (
        <p className="ll-notice" style={{ margin: "0 0 10px" }}>
          The pricing change log isn&rsquo;t readable, and every move across is recorded there &mdash;
          migration 0179 creates it, so it most likely hasn&rsquo;t been applied yet. Nothing can be
          switched until it reads; the list below still shows what each move would do.
        </p>
      )}

      {state?.ok && state.fee && (
        <p className="mut" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
          The fees in force right now: the customer pays the crew&rsquo;s quote plus {pct(state.fee.customerPct)},
          and the crew is paid it less {pct(state.fee.crewPct)}.
        </p>
      )}

      {state?.ok &&
        (state.rows ?? []).map((row) => {
          const canFlip = row.verdict.ok && state.logReady === true;
          const isConfirming = confirming === row.id;
          return (
            <div
              key={row.id}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: "10px 12px",
                marginBottom: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <b style={{ fontSize: 14 }}>{row.name}</b>
                <span className="mut" style={{ fontSize: 12.5 }}>
                  {row.crewPriced ? "Priced by the crews" : "On the LakeLife menu price"}
                </span>
              </div>

              {!row.verdict.ok && (
                <p className="ll-notice" style={{ margin: "8px 0 0" }}>
                  {row.verdict.reason}
                </p>
              )}

              {row.verdict.ok && (
                <ul className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, margin: "8px 0 0", paddingLeft: 18 }}>
                  {row.consequences.map((line) => (
                    <li key={line} style={{ marginBottom: 4 }}>
                      {line}
                    </li>
                  ))}
                </ul>
              )}

              {/* WHO PAYS FOR IT AT A PARK IS TRUE WHETHER OR NOT IT CAN BE
                  FLIPPED. This sat inside the `verdict.ok` branch, so a
                  refused service a park buys said nothing at all about park
                  work — and on this card silence about a park reads as "no
                  park is affected". Neither refused service is park work
                  today, so it costs nothing now and is right when a park
                  service is refused. */}
              {row.parkLine && (
                <p className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, margin: "8px 0 0" }}>
                  {row.parkLine}
                </p>
              )}

              {canFlip && !isConfirming && (
                <button
                  className="ll-btn"
                  disabled={pending}
                  onClick={() => setConfirming(row.id)}
                  style={{ marginTop: 10, minHeight: 44 }}
                >
                  {row.crewPriced ? "Put it back on the menu price" : "Let the crews price this one"}
                </button>
              )}

              {canFlip && isConfirming && (
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    className="ll-btn gold"
                    disabled={pending}
                    onClick={() => flip(row, !row.crewPriced)}
                    style={{ minHeight: 44 }}
                  >
                    {/* THE SERVICE NAME IS THE HEADING TWO LINES ABOVE. Putting
                        it inside the button too made a label that ran to three
                        lines on a phone for "Common-area fall cleanup & leaf
                        haul", and said nothing the card had not already said. */}
                    {pending ? "Saving…" : row.crewPriced ? "Yes — back on the menu" : "Yes — the crews price it"}
                  </button>
                  <button
                    className="ll-btn ghost"
                    disabled={pending}
                    onClick={() => setConfirming(null)}
                    style={{ minHeight: 44 }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}

      {!state && <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>Checking the service menu…</p>}
    </div>
  );
}
