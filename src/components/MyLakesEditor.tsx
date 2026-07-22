"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ToggleChips } from "@/components/wizard-controls";
import { toast } from "@/components/Toast";
import { setServiceLakes } from "@/app/vendor/onboarding-actions";

/**
 * Active crews edit which lakes they service, right from the availability
 * page. Names <-> ids mapping mirrors VendorOnboarding's LakeStep. The server
 * action (setServiceLakes) whitelists ids and enforces the Phase-E lake
 * cooldown — any refusal surfaces here via toast.
 */
export function MyLakesEditor({
  lakes,
  selectedIds,
}: {
  lakes: { id: string; name: string }[];
  selectedIds: string[];
}) {
  const router = useRouter();
  const nameById = new Map(lakes.map((l) => [l.id, l.name]));
  const idByName = new Map(lakes.map((l) => [l.name, l.id]));
  const initialNames = selectedIds
    .map((id) => nameById.get(id))
    .filter((n): n is string => !!n);

  const [picked, setPicked] = useState<string[]>(initialNames);
  const [pending, startTransition] = useTransition();

  function toggle(name: string) {
    setPicked((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  function save() {
    if (picked.length === 0) {
      toast("Tap at least one lake you service.");
      return;
    }
    const ids = picked
      .map((n) => idByName.get(n))
      .filter((id): id is string => !!id);
    startTransition(async () => {
      const res = await setServiceLakes(ids);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save.");
        return;
      }
      toast("Lakes updated. 🌊");
      router.refresh();
    });
  }

  if (lakes.length === 0) {
    return <p className="mut" style={{ fontSize: 14 }}>No lakes set up yet — call dispatch.</p>;
  }

  return (
    <div>
      <ToggleChips options={lakes.map((l) => l.name)} selected={picked} onToggle={toggle} />
      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 12, minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save lakes"}
      </button>
    </div>
  );
}
