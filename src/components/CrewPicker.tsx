"use client";

/**
 * THE PICKER — every crew, on one screen, and the buyer decides.
 *
 * Brendon, 23 September 2026: "the owner needing the service should still see
 * all the options, if any, for the crews available and their pricing" and
 * "...what days and the crew rating....then they make the decision."
 *
 * "IF ANY" IS LOAD-BEARING. With no crews this screen says so honestly and
 * takes a dated request instead. It never says "that day just filled up"
 * unless that is what the engine actually said, never prints $0, never invents
 * a number, and never blames the buyer for an empty crew bench.
 *
 * WHAT IT DRAWS PER CREW is exactly what the server sends: name, the price
 * THIS customer pays, the days they work, whether it is the crew this property
 * brought — and standing only when the owner has switched it on. A crew's own
 * quote and the fee split never reach the browser.
 *
 * THE SORT IS SAID ON SCREEN: your own crew first, then cheapest first.
 * Standing never sorts, because sorting on it is how a newcomer quietly lands
 * at the bottom of every list.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { TosAgreeModal } from "@/components/TosAgreeModal";
import { loadCrewOffers, bookWithChosenCrew, askForItAnyway } from "@/app/book/crew-actions";
import type { CrewOffersResult } from "@/app/book/crew-offers";
import type { BookingResult } from "@/app/book/actions";

const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Mon–Fri" is a lie if they skip Wednesday, so this just lists them in order. */
function daysLine(days: string[]): string {
  const clean = DAY_ORDER.filter((d) => days.includes(d));
  if (clean.length === 0) return "No working days set yet";
  if (clean.length === 7) return "Works every day";
  return `Works ${clean.join(", ")}`;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function CrewPicker({
  propertyId,
  serviceId,
  serviceName,
  frequencyOptions,
  initialDate,
  earliestDate,
}: {
  propertyId: string;
  serviceId: string;
  serviceName: string;
  frequencyOptions: string[];
  initialDate: string;
  /**
   * THE FIRST DAY THIS SCREEN CAN ACTUALLY SELL, YYYY-MM-DD.
   *
   * Crew-priced work is refused same-day BY NAME (book/actions.ts: the rush
   * premium is a percentage of a menu price that does not exist here), so a
   * screen defaulting to today drew a list of crews, prices and live Choose
   * buttons where every single tap failed. It is also the `min` on the date
   * input, so a past date can't be typed into a list of live prices either.
   */
  earliestDate: string;
}) {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const [frequency, setFrequency] = useState(frequencyOptions[0] ?? "one-time");
  const [res, setRes] = useState<CrewOffersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [tosOpen, setTosOpen] = useState(false);
  /** THE BOOKING'S OWN ANSWER, never the offers list. Null until one lands. */
  const [outcome, setOutcome] = useState<BookingResult | null>(null);

  // BUMPED to ask again for the same day — after a refusal, and on "Try
  // again". The list is stale the moment a booking is refused, so it is re-read
  // rather than left showing a name that can no longer be chosen.
  const [reloadKey, setReloadKey] = useState(0);

  function reload() {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  useEffect(() => {
    // `alive` so a fast date change cannot let an older answer land last and
    // draw crews for a day nobody is looking at.
    let alive = true;
    void (async () => {
      const r = await loadCrewOffers(propertyId, serviceId, date);
      if (!alive) return;
      setRes(r);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [propertyId, serviceId, date, reloadKey]);

  async function confirm(vendorId: string | null, tosAccepted?: boolean) {
    setPicked(vendorId);
    setBusy(true);
    // NULL IS THE ASK-ANYWAY TAP, and it goes through its own door rather than
    // a booking with a missing argument.
    const r = vendorId
      ? await bookWithChosenCrew(serviceId, date, frequency, vendorId, tosAccepted)
      : await askForItAnyway(serviceId, date, frequency, tosAccepted);
    setBusy(false);
    if (r.needsTos) { setTosOpen(true); return; }
    if (!r.ok) {
      toast.err(r.error ?? "Couldn't book that.");
      // THE LIST IS NOW STALE BY DEFINITION. The likeliest refusal here is
      // that this crew's day filled while the screen was open, so re-read it
      // rather than leaving a name on screen that can no longer be chosen.
      reload();
      return;
    }
    setTosOpen(false);
    setOutcome(r);
    router.refresh();
  }

  if (outcome?.ok) {
    // ================= WHAT WE ARE ALLOWED TO SAY HAPPENED =================
    //
    // This card used to read the crew and the price OFF THE OFFERS LIST — the
    // thing the customer tapped, not the thing the server did. A tap is not an
    // assignment: every no-fit the booking flow does not back out of leaves
    // the row requested, with no crew and no price, and this card said
    // "✓ Booked with Josh — $56" over it. `assignedCrew` is the booking's own
    // answer and it is null when nobody was locked in.
    const crew = outcome.assignedCrew ?? null;
    const day = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    return (
      <div className="ll-card ll-card-pad">
        <h3 style={{ fontSize: 16, margin: "0 0 6px", color: "var(--teal-dark)" }}>
          {crew ? `✓ Booked with ${crew.company ?? "your crew"}` : "✓ We've got your request"}
        </h3>
        <p className="mut" style={{ fontSize: 14, margin: "0 0 12px" }}>
          {serviceName} on {day}
          {crew && crew.customerPrice != null ? ` — ${money(crew.customerPrice)}.` : "."}{" "}
          {crew
            ? "You're only charged after the work is done and the photos are up."
            : "No crew is locked in yet — we're lining one up and you'll hear the moment somebody takes it. Nothing is charged until the work is done."}
        </p>
        <Link className="ll-btn" href="/requests">See my visits</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 10px" }}>{serviceName}</h3>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <label style={{ display: "block" }}>
            <span className="mut" style={{ fontSize: 13 }}>Day</span>
            <input
              type="date"
              value={date}
              min={earliestDate}
              onChange={(e) => { setLoading(true); setDate(e.target.value); }}
              style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
            />
          </label>
          {frequencyOptions.length > 1 && (
            <label style={{ display: "block" }}>
              <span className="mut" style={{ fontSize: 13 }}>How often</span>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
                style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
              >
                {frequencyOptions.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      {loading && (
        <div className="ll-card ll-card-pad">
          <p className="mut" style={{ fontSize: 14, margin: 0 }}>Checking who&rsquo;s free that day…</p>
        </div>
      )}

      {/* A FAILED READ IS NOT AN EMPTY BENCH, and it must not render as one.
          `ok: false` means we could not look — it never becomes a sentence
          about which crews exist. */}
      {!loading && res && !res.ok && (
        <div className="ll-card ll-card-pad">
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>We couldn&rsquo;t check just now</h3>
          <p className="mut" style={{ fontSize: 14, margin: "0 0 12px" }}>{res.error}</p>
          <button className="ll-btn" onClick={reload}>Try again</button>
        </div>
      )}

      {/* MENU-PRICED WORK HAS NOTHING TO CHOOSE BETWEEN, and saying so is more
          honest than an empty list. That path is unchanged on purpose. */}
      {!loading && res?.ok && res.crewPriced === false && (
        <div className="ll-card ll-card-pad">
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>One price, whoever comes</h3>
          <p className="mut" style={{ fontSize: 14, margin: 0 }}>
            {serviceName} has a single LakeLife price — it doesn&rsquo;t change with the crew, so
            there&rsquo;s nothing to pick between. We line up the crew for you.{" "}
            <Link href="/book">Book it on the booking page</Link>.
          </p>
        </div>
      )}

      {!loading && res?.ok && res.crewPriced && (res.offers?.length ?? 0) === 0 && (
        <div className="ll-card ll-card-pad">
          {/* THE HEADING COMES FROM THE SAME VERDICT AS THE BODY. It was
              hardcoded to "No crew for that day yet" — which denied the
              paragraph under it on four of the nine reasons, and flatly
              contradicted it on the one where crews ARE free that day and the
              profile is what's missing. */}
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>{res.emptyHeading ?? "No crew for that day yet"}</h3>
          {/* EVERY SENTENCE HERE CAME FROM THE ENGINE'S OWN VERDICT. Nothing
              is guessed, and none of it blames the person reading it. */}
          <p className="mut" style={{ fontSize: 14, margin: "0 0 12px" }}>{res.emptyReason}</p>
          {/* AND THE ADVICE ONLY APPEARS WHEN A DATE COULD CHANGE THE ANSWER.
              Every gate behind no_crew_on_lake, no_routable_crew and their
              neighbours is date-independent: "pick another day" there is advice
              that can never come true, and each new day repeats the same false
              sentence (see dispatch.ts). */}
          {res.emptyDateHelps && (
            <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
              Pick another day above to see who&rsquo;s free then.
            </p>
          )}
          {/* A REAL DOOR, NOT A LINK TO THE VISITS LIST. Asking anyway books
              the day as a Finding-a-crew request — the honest answer and the
              recruiting signal both. */}
          <button className="ll-btn gold" disabled={busy} style={{ minHeight: 44 }} onClick={() => void confirm(null)}>
            {busy && picked === null ? "Asking…" : `Ask for it anyway on ${new Date(date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })}`}
          </button>
          <p className="mut" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
            We&rsquo;ll come back to you with a crew and a price. Nothing is charged until the work is
            done.
          </p>
        </div>
      )}

      {!loading && res?.ok && (res.offers?.length ?? 0) > 0 && (
        <>
          {/* SAY WHAT THE SORT IS. A list whose order is unexplained reads as a
              recommendation, and this one is not one. */}
          <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>
            {res.offers!.some((o) => o.yours)
              ? "Your own crew first, then cheapest first. "
              : "Cheapest first. "}
            {/* "the price is theirs, not ours" WAS FALSE ABOUT THESE NUMBERS.
                Every figure in this list is the crew's own quote with LakeLife's
                share already added (quote x (1 + fee), platform-fee.ts) — so the
                line sat directly above prices that are partly ours and said they
                were not. What IS true, and is the thing a buyer is weighing, is
                that the crew set the figure these differ by. Reworded with
                tos-v4-beta, whose fee section says the same thing. */}
            Every crew below can do {serviceName} at your place on this day. Each sets their own
            price; what you see is that price with our share already in it, and nothing is added
            after you book.
            {res.standingUnavailable && " (We couldn't read how much work these crews have finished for us, so nothing about that is shown.)"}
          </p>
          {/* WHERE THEIR OWN CREW WENT. The sort line above flips from "Your
              own crew first" to "Cheapest first" the moment the crew they
              brought can't take the day, and said nothing about it. Only ever
              their own crew: why anybody else is absent is not theirs to see. */}
          {res.yourCrewUnavailable && (
            <p className="mut" style={{ fontSize: 13, margin: "-4px 0 10px" }}>
              {res.yourCrewUnavailable} — the crew you brought — isn&rsquo;t available that day. Pick
              another day above to see if they are then.
            </p>
          )}
          <div style={{ display: "grid", gap: 10 }}>
            {res.offers!.map((o) => (
              <div key={o.vendorId} className="ll-card ll-card-pad">
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 16 }}>{o.company}</strong>
                      {/* THE BADGE, AND IT IS ONLY A BADGE (0178). The crew
                          this property brought is shown first and labelled as
                          theirs. It is never a filter and never a first
                          refusal — every other crew is on this same screen. */}
                      {o.yours && <span className="ll-pill teal">Your crew</span>}
                    </div>
                    <p className="mut" style={{ fontSize: 13, margin: "4px 0 0" }}>{daysLine(o.workDays)}</p>
                    {/* ONLY DRAWN WHEN THE SERVER SENT IT. With the dial off
                        there is no `standing` key at all, so nothing here
                        renders and nothing is implied. */}
                    {o.standing && (
                      <p className="mut" style={{ fontSize: 13, margin: "2px 0 0" }}>
                        {o.standing.label}{o.standing.detail ? ` ${o.standing.detail}` : ""}
                      </p>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{money(o.customerPrice)}</div>
                    <p className="mut" style={{ fontSize: 12, margin: "2px 0 8px" }}>all in</p>
                    <button
                      className="ll-btn gold"
                      disabled={busy}
                      onClick={() => void confirm(o.vendorId)}
                      style={{ minHeight: 44 }}
                    >
                      {busy && picked === o.vendorId ? "Booking…" : "Choose"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="mut" style={{ fontSize: 12.5, marginTop: 12, lineHeight: 1.55 }}>
            You&rsquo;re only charged after the visit is finished and its photos are uploaded.
          </p>
        </>
      )}

      {/* `picked` is null for the ask-anyway tap, and the old `picked && …`
          swallowed that retry: agreeing to the terms did nothing at all on the
          one control the empty state draws. */}
      <TosAgreeModal
        open={tosOpen}
        busy={busy}
        onAgree={() => void confirm(picked, true)}
        onClose={() => setTosOpen(false)}
      />
    </div>
  );
}
