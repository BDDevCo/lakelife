"use client";

/**
 * HOW MANY JOBS A DAY — FOR A CREW WHO IS ALREADY LIVE.
 *
 * `setDailyCapacity` had exactly one calling screen: the onboarding wizard.
 * Every page that renders that wizard does so only while `status !== "active"`,
 * so the day a crew went live the only control over the hardest ceiling in
 * routing vanished. `isEligible` refuses at `assignedThatDay >= cap` and
 * `canClaim` answers "Your day is full" — and no crew-facing sentence anywhere
 * said where the number lived or who could change it. The only cure was a phone
 * call to ops that nobody knew to make.
 *
 * The rule this closes is the one the service-types editor already closed:
 * anything activation can refuse you for must stay changeable afterwards.
 * Otherwise the gate is a trapdoor.
 *
 * IT MUST NOT CONTRADICT THE TRUCKS. `fleetJobCap` DISCARDS vendors.daily_capacity
 * the moment one active truck exists — the fleet sum wins outright, it does not
 * add. A stepper offering a number dispatch would never read is a fresh copy of
 * the lie this component was written to remove, so a crew with trucks is told
 * plainly that their trucks set it and shown the sum dispatch is actually using.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Stepper } from "@/components/wizard-controls";
import { toast } from "@/components/Toast";
import { setDailyCapacity } from "@/app/vendor/onboarding-actions";

export function MyCapacity({
  capacity,
  truckCount,
  fleetCap,
}: {
  /** vendors.daily_capacity as stored — 0 when the crew has never answered. */
  capacity: number;
  /** Active trucks only: the same set dispatch sums. */
  truckCount: number;
  /** What dispatch will actually use today (fleetJobCap of the two above). */
  fleetCap: number;
}) {
  const router = useRouter();
  const [n, setN] = useState<number>(capacity >= 1 ? capacity : 1);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await setDailyCapacity(n);
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't save.");
        return;
      }
      toast("Daily capacity saved.");
      router.refresh();
    });
  }

  if (truckCount > 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>How many jobs a day</h2>
        <p className="mut" style={{ fontSize: 13, margin: 0 }}>
          Your trucks set this. We&apos;ll route up to <b>{fleetCap}</b> {fleetCap === 1 ? "job" : "jobs"} a
          day across your {truckCount} {truckCount === 1 ? "truck" : "trucks"} — change a truck&apos;s
          capacity and this changes with it.
        </p>
        <Link
          href="/vendor/availability"
          className="ll-btn"
          style={{ marginTop: 12, display: "inline-block", textDecoration: "none" }}
        >
          My trucks →
        </Link>
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 12 }}>
      <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>How many jobs a day</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        {capacity >= 1
          ? "The most stops we'll route to your crew in one day. Change it whenever your season does."
          // NOT "Set it and jobs start reaching you" — the last survivor of the
          // phrase this package went looking for. A daily number is one of
          // several gates: work you've ticked, lakes you've ticked, a rate
          // with a real number on it, and the Go live button. Naming one of
          // them as the unblock is how a crew ends up live, correct in their
          // own eyes, and offered nothing.
          : "You haven't told us yet, so nothing is being routed to you. Set it — it's one of the things we check before sending you work."}
      </p>

      <Stepper
        label="Jobs per day"
        value={n}
        onChange={setN}
        min={1}
        max={20}
        hint="The most stops we'll route to your crew in one day."
      />

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 4, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
