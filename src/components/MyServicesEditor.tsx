"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ToggleChips } from "@/components/wizard-controls";
import { toast } from "@/components/Toast";
import { setServiceTypes } from "@/app/vendor/onboarding-actions";

/**
 * THE WORK A LIVE CREW DOES — the one activation requirement that had no way back.
 *
 * `setServiceTypes` had exactly one caller, inside VendorOnboarding, and every
 * page that renders VendorOnboarding does so only while the crew is NOT active.
 * Ops had no writer either. So going live froze the list, and changing it took
 * a database edit. This is the same screen `MyLakesEditor` sits on, calling the
 * same hardened action — which whitelists every name against the active
 * services table and refuses a paused crew.
 *
 * ---------------------------------------------------------------------------
 * PARK WORK IS SPLIT OUT, because two of these differ by one word.
 *
 * The catalogue carries "Lawn mowing & trim" (somebody's lake house) and "Park
 * grounds mowing & trim" (a park's common ground, priced per lot from that
 * park's own rate). Onboarding drew them as adjacent chips in one flat list.
 * `isEligible` and `canClaim` both match on exact membership, so a crew
 * recruited to mow The Haven who taps the lake-house chip is invisible to every
 * park mow — with no error, on either side.
 *
 * The heading is the whole fix: a crew who does parks knows they do parks.
 */
export function MyServicesEditor({
  services,
  selected,
}: {
  /** Every ACTIVE service, with whether it is a park's grounds work. */
  services: { name: string; parkOnly: boolean }[];
  selected: string[];
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>(selected);
  const [pending, startTransition] = useTransition();

  function toggle(name: string) {
    setPicked((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  function save() {
    if (picked.length === 0) {
      // The server refuses this too (activationGaps), but a crew who clears
      // every chip and taps save should be told before anything is written —
      // an empty list is how a live crew silently stops being offered work.
      toast("Tap at least one kind of work — an empty list takes you off every job.");
      return;
    }
    startTransition(async () => {
      const res = await setServiceTypes(picked);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save.");
        return;
      }
      toast("Work types updated. 🌊");
      router.refresh();
    });
  }

  if (services.length === 0) {
    return <p className="mut" style={{ fontSize: 14 }}>No services set up yet — email hello@lakelife.ai.</p>;
  }

  const lakeHome = services.filter((s) => !s.parkOnly).map((s) => s.name);
  const park = services.filter((s) => s.parkOnly).map((s) => s.name);

  return (
    <div>
      {lakeHome.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, fontWeight: 800, margin: "0 0 8px", color: "var(--sub)" }}>
            At a lake home
          </h3>
          <ToggleChips options={lakeHome} selected={picked} onToggle={toggle} />
        </>
      )}

      {park.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, fontWeight: 800, margin: "18px 0 4px", color: "var(--sub)" }}>
            At a mobile-home park
          </h3>
          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
            Whole-park work on common ground — roads, verges and shared areas, not
            anyone&rsquo;s lot. The park is the customer.
          </p>
          <ToggleChips options={park} selected={picked} onToggle={toggle} />
        </>
      )}

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 14, minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save work types"}
      </button>

      <p className="mut" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
        Set what you charge for each of these on your{" "}
        <a href="/vendor/rates" style={{ color: "var(--teal-dark)", fontWeight: 700 }}>rates page</a>{" "}
        — work with no rate never gets offered to you.
      </p>
    </div>
  );
}
