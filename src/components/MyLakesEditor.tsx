"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ToggleChips } from "@/components/wizard-controls";
import { toast } from "@/components/Toast";
import { setServiceLakes, addLakeAndServe } from "@/app/vendor/onboarding-actions";

/**
 * Active crews edit which lakes they service, right from the availability
 * page. Names <-> ids mapping mirrors VendorOnboarding's LakeStep. The server
 * action (setServiceLakes) whitelists ids and enforces the Phase-E lake
 * cooldown — any refusal surfaces here via toast.
 *
 * Below the chips, a compact "Add a lake +" affordance lets a crew type a
 * lake that isn't listed yet — demand-born lakes (owner directive
 * 2026-07-23): the crew creates it, ops gets an FYI, never a bottleneck.
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

  const [addingOpen, setAddingOpen] = useState(false);
  const [newLakeName, setNewLakeName] = useState("");
  const [addPending, startAddTransition] = useTransition();

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

  function addLake() {
    const name = newLakeName.trim();
    if (!name) {
      toast("Type the lake's name.");
      return;
    }
    startAddTransition(async () => {
      const res = await addLakeAndServe(name);
      if (!res.ok) {
        toast(res.error ?? "Couldn't add that lake.");
        return;
      }
      toast(`${res.lakeName ?? name} added — jobs there route to you starting tomorrow. 🌊`);
      setNewLakeName("");
      setAddingOpen(false);
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

      {!addingOpen ? (
        <button
          type="button"
          onClick={() => setAddingOpen(true)}
          style={{
            display: "block", background: "none", border: "none", padding: 0, marginTop: 10,
            minHeight: 44, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700,
            color: "var(--teal-dark)",
          }}
        >
          + Add a lake we serve
        </button>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); addLake(); }}
          style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10 }}
        >
          <input
            value={newLakeName}
            onChange={(e) => setNewLakeName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Adams Lake"
            autoFocus
            aria-label="Lake name"
            style={{
              padding: "9px 12px", border: "1.5px solid var(--line)", borderRadius: 10,
              fontSize: 15, fontWeight: 700, fontFamily: "inherit", color: "var(--text)",
              background: "#fff", minHeight: 44, width: 200, maxWidth: "100%",
            }}
          />
          <button type="submit" className="ll-btn sm" disabled={addPending} style={{ minHeight: 44 }}>
            {addPending ? "Adding…" : "We serve it — add"}
          </button>
          <button
            type="button"
            className="ll-btn ghost sm"
            onClick={() => { setAddingOpen(false); setNewLakeName(""); }}
            disabled={addPending}
            style={{ minHeight: 44 }}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
