"use client";

/**
 * The seven day chips (Mon..Sun) the vendor taps to say which days they work.
 * Reuses the wizard's ToggleChips for a consistent tap-first feel. Optimistic:
 * the chip flips instantly, then we save and let router.refresh() reconcile.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ToggleChips } from "@/components/wizard-controls";
import { toggleWorkDay } from "./actions";
import { toast } from "@/components/Toast";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WorkDayChips({ workDays }: { workDays: string[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(workDays);
  const [busy, setBusy] = useState(false);

  // Re-sync to server truth whenever fresh data arrives (after refresh),
  // adjusted during render rather than in an effect. An effect re-synced one
  // render late, so a failed toggle showed the crew their own rejected choice
  // for a frame before snapping back to what the server actually holds.
  const [prevWorkDays, setPrevWorkDays] = useState(workDays);
  if (workDays !== prevWorkDays) {
    setPrevWorkDays(workDays);
    setSelected(workDays);
  }

  async function onToggle(day: string) {
    if (busy) return;
    const previous = selected;
    const next = selected.includes(day) ? selected.filter((d) => d !== day) : [...selected, day];

    setSelected(next); // optimistic
    setBusy(true);
    const res = await toggleWorkDay(day);
    setBusy(false);

    if (!res.ok) {
      setSelected(previous); // roll back
      toast(res.error ?? "Couldn't update your work days.");
      return;
    }
    router.refresh();
  }

  return <ToggleChips options={DAYS} selected={selected} onToggle={onToggle} />;
}
