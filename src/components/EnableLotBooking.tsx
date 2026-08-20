"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { enableBookingForMyLot } from "@/app/parks/booking-actions";

/**
 * ONE TAP INSTEAD OF A WIZARD.
 *
 * A lot resident should never be asked how many pier sections their mobile
 * home has. This mints their place and lands them on the ordinary booking
 * screen with the lot already selected — the same screen a lake homeowner
 * uses, which is the point: one portal, not two.
 *
 * IT SAYS WHAT IT DOES FIRST. Enabling this sets the flag that puts a visit on
 * the park owner's board. 0085's rule is that the flag is "self-declared,
 * never inferred — nobody is enrolled in being visible", so the sentence
 * below is not decoration; it is the consent.
 */
export function EnableLotBooking({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();

  return (
    <div className="ll-card ll-card-pad">
      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.55 }}>
        {ready
          ? "Your lot is set up. Pick a service and a day, the same as any lake home."
          : "Book a mow or a clean for your lot. Nothing to fill in — we already know where you live."}
      </p>
      <p className="mut" style={{ fontSize: 12, margin: "0 0 10px", lineHeight: 1.5 }}>
        {/* Same correction as RenterHome: the owner's visits screen shows the
            service name. This is the consent moment, so it is the one place
            that must not overstate the privacy. */}
        Your park office will see that a crew came to your lot, what they were
        there to do, and when. They never see what you paid.
      </p>
      <button
        className="ll-btn gold"
        style={{ minHeight: 44 }}
        disabled={busy}
        onClick={() =>
          start(async () => {
            const res = await enableBookingForMyLot();
            if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
            toast(res.signal ?? "Ready.");
            router.push("/book");
          })
        }
      >
        {busy ? "Setting up…" : ready ? "Book a service" : "Set up booking for my lot"}
      </button>
    </div>
  );
}
