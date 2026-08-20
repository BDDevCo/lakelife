"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { rescheduleUnworkedVisit, type RescheduleView } from "@/app/requests/actions";

/**
 * "PICK ANOTHER DAY" — the half of the rule that comes FIRST.
 *
 * Brendon's rule is "reschedule if both parties agree or they get charged",
 * and until this existed only the second half could actually happen. The email
 * said pick another day, the link went to a page with no such control, and
 * seven days later a fee was proposed against somebody who had never been
 * given a way to act. Both halves were written; one had no door.
 *
 * WHAT THIS SAYS, AND WHY IT SAYS IT IN THIS ORDER:
 *
 *   The ask first, because it is the point.
 *   Then the deadline, because a window nobody mentioned is a trap.
 *   Then what happens if they do nothing — INCLUDING the case where the answer
 *   is "nothing at all", which is a stand-down. Our record was wrong there, and
 *   a screen that implies a charge is coming would be lying to make them hurry.
 *
 * The date box refuses today. A crew's day is planned the night before, and
 * offering a slot we cannot fill is a second broken promise on top of the one
 * that got us here.
 */
export function RescheduleVisit({ jobId, view }: { jobId: string; view: RescheduleView }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [date, setDate] = useState("");

  // WE COULDN'T READ THE VISIT. `needed` is false on a failed read for exactly
  // the same reason it is false on a healthy job that needs nothing — so
  // returning null here would hide the door on the one card whose absence is
  // what this component was built to fix. Say it, and leave the page alone.
  if (view.unavailable) {
    return (
      <p className="mut" style={{ fontSize: 13, marginBottom: 16 }}>
        We couldn&apos;t load this visit&apos;s details just now. Refresh in a moment — or message dispatch from your portal and we&apos;ll sort it out.
      </p>
    );
  }
  if (!view.needed) return null;

  const earliest = tomorrow();

  return (
    <div
      className="ll-card ll-card-pad"
      style={{ marginBottom: 16, borderColor: "var(--teal)" }}
    >
      <span className={`ll-pill ${view.feeEligible ? "warn" : "slate"}`}>
        {view.outcome === "stood_down" ? "We couldn't do it" : "We couldn't get in"}
      </span>

      <h3 style={{ fontSize: 18, margin: "10px 0 6px" }}>{view.ask}</h3>

      <p className="mut" style={{ fontSize: 13, marginTop: 0, lineHeight: 1.55 }}>
        {view.ifNothingHappens}
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="ll-field" style={{ margin: 0, maxWidth: 200 }}>
          <label>Which day suits?</label>
          <input
            type="date"
            value={date}
            min={earliest}
            onChange={(e) => setDate(e.target.value)}
            style={{ fontSize: 16 }}
          />
        </div>
        <button
          className="ll-btn gold"
          style={{ minHeight: 44 }}
          disabled={busy || !date}
          onClick={() =>
            start(async () => {
              const res = await rescheduleUnworkedVisit(jobId, date);
              toast(res.ok ? (res.signal ?? "Booked in.") : (res.error ?? "Couldn't move it."));
              if (res.ok) router.refresh();
            })
          }
        >
          {busy ? "Booking…" : "Book it in"}
        </button>
      </div>

      <p className="mut" style={{ fontSize: 11.5, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
        {view.feeEligible
          ? "Nothing has been charged, and picking a day keeps it that way."
          : "Nothing is charged for this one either way — the details we had were ours to get right."}
      </p>
    </div>
  );
}

/** Tomorrow, in the lake's calendar. A crew's day is planned the night before. */
function tomorrow(): string {
  const now = new Date();
  const lake = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [y, m, d] = lake.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
