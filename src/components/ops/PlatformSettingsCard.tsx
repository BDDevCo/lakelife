"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { updatePlatformSettings } from "@/app/ops/settings-actions";

/**
 * Ops pricing dials (Phase C, widened by 0174): the margin floor and surge cap
 * the dispatch engine enforces on every MENU-priced assignment, plus the two
 * platform-fee percentages that price CREW-priced work. Whole-percent inputs;
 * the server clamps and stores fractions.
 *
 * The two halves apply to different services and never to the same job. The
 * floor and cap do nothing on a crew-priced service (LakeLife's share there is
 * a constant, so a floor is a platform-wide on/off switch, not a test); the
 * fees do nothing on a menu-priced one. Both are on one card because they are
 * the same person's dials, and the copy under each says which work it moves.
 */
export function PlatformSettingsCard({
  settings,
}: {
  settings: { marginFloorPct: number; surgeCapPct: number; feeCustomerPct: number; feeCrewPct: number };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [floor, setFloor] = useState(String(settings.marginFloorPct));
  const [cap, setCap] = useState(String(settings.surgeCapPct));
  const [feeCustomer, setFeeCustomer] = useState(String(settings.feeCustomerPct));
  const [feeCrew, setFeeCrew] = useState(String(settings.feeCrewPct));

  function save() {
    startTransition(async () => {
      const res = await updatePlatformSettings(Number(floor), Number(cap), Number(feeCustomer), Number(feeCrew));
      if (res.ok) {
        toast("Dials saved.");
        router.refresh();
      } else {
        toast.err(res.error ?? "Couldn't save the dials.");
      }
    });
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 18, margin: "0 0 4px" }}>Pricing dials</h3>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        Set once — the machine enforces them on every assignment. Changes apply to future assignments only.
      </p>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <label style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 13 }}>Margin floor %</span>
          <input
            type="number"
            inputMode="numeric"
            min={5}
            max={60}
            step="1"
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
            style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 13 }}>Surge cap %</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step="1"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 13 }}>Customer fee %</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={50}
            step="1"
            value={feeCustomer}
            onChange={(e) => setFeeCustomer(e.target.value)}
            style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 13 }}>Crew fee %</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={50}
            step="1"
            value={feeCrew}
            onChange={(e) => setFeeCrew(e.target.value)}
            style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
          />
        </label>
      </div>

      {/* WHAT MOVES AND WHAT DOES NOT, said plainly — the two fees look like
          the two dials beside them and behave nothing like them. A job's fees
          are frozen onto it when it is sold, so nothing already booked
          reprices; what changes today is the next quote and what every crew's
          rates page tells them they will be paid. */}
      <p className="mut" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.55 }}>
        The floor and cap apply to menu-priced work. The two fees apply to work a crew
        prices itself: the customer fee is added on top of the crew&apos;s quote, the crew
        fee comes out of it. Both are locked onto a job when it&apos;s booked, so changing
        them never reprices anything already sold — but a crew&apos;s rates page will show
        the new crew fee the moment you save.
      </p>

      {/* Teal, not gold. Three adjacent ops tabs saved what you typed in three
          fills — gold here, small teal on Lake conditions, outlined on Crews.
          The prototype uses gold for a commit step (Confirm service, Send to
          owner) and plain .btn for a save. */}
      <button className="ll-btn" onClick={save} disabled={pending} style={{ marginTop: 14, minHeight: 44 }}>
        {pending ? "Saving…" : "Save dials"}
      </button>
    </div>
  );
}
