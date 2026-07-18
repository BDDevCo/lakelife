"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { priceService, boatFeet, formatPrice, type ServiceRule } from "@/lib/pricing";
import { saveProfile, type WizardInput } from "@/app/profile/actions";
import { sendWelcomeEmail } from "@/app/profile/email-actions";
import { toast } from "@/components/Toast";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { Stepper, ChoiceChips, ToggleChips, Toggle } from "@/components/wizard-controls";

type Lawn = "small" | "medium" | "large";

// Boat types for the tap-picker (jet skis handled in their own section).
const BOAT_TYPES = [
  "Pontoon",
  "Tritoon",
  "Wake boat",
  "Ski boat",
  "Fishing boat",
  "Runabout / bowrider",
  "Sailboat",
  "Other",
];

// Common water toys — tap to add.
const TOY_OPTIONS = ["Kayak", "Paddleboard", "Tube", "Water trampoline", "Canoe", "Floating mat", "Water slide"];

const LAWN_DESC: Record<Lawn, string> = {
  small: "under ¼ acre mowable",
  medium: "¼–½ acre mowable",
  large: "over ½ acre mowable",
};

interface Draft {
  lake: string;
  address: string;
  lat: number | null;
  lng: number | null;
  sqft: number;
  gate: string;
  beds: number;
  baths: number;
  pier_sections: number;
  ladder: boolean;
  bumpers: boolean;
  boat_lifts: number;
  canopy: boolean;
  jet_skis: number;
  pwc_lifts: number;
  lawn_band: Lawn;
  boats: Array<{ type: string; length_ft: number }>;
  toys: string[];
}

export function ProfileWizard({
  lakes,
  services,
  initial,
}: {
  lakes: string[];
  services: ServiceRule[];
  initial: Partial<Draft>;
}) {
  const router = useRouter();

  const [draft, setDraft] = useState<Draft>({
    lake: initial.lake ?? lakes[0] ?? "",
    address: initial.address ?? "",
    lat: initial.lat ?? null,
    lng: initial.lng ?? null,
    sqft: initial.sqft ?? 2400,
    gate: initial.gate ?? "",
    beds: initial.beds ?? 3,
    baths: initial.baths ?? 2,
    pier_sections: initial.pier_sections ?? 8,
    ladder: initial.ladder ?? true,
    bumpers: initial.bumpers ?? true,
    boat_lifts: initial.boat_lifts ?? 1,
    canopy: initial.canopy ?? true,
    jet_skis: initial.jet_skis ?? 0,
    pwc_lifts: initial.pwc_lifts ?? 0,
    lawn_band: initial.lawn_band ?? "medium",
    boats: initial.boats?.length ? initial.boats : [{ type: "Pontoon", length_ft: 24 }],
    toys: initial.toys ?? ["Kayak"],
  });

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const pp = () => ({
    sqft: draft.sqft, beds: draft.beds, baths: draft.baths,
    pier_sections: draft.pier_sections, boat_lifts: draft.boat_lifts, toy_lifts: 0,
    jet_skis: draft.jet_skis, pwc_lifts: draft.pwc_lifts,
    lawn_band: draft.lawn_band, boats: draft.boats,
    toys: draft.toys.map((name) => ({ name })),
  });
  const rule = (name: string) => services.find((s) => s.name === name);
  const priceOf = (name: string) => {
    const r = rule(name);
    return r ? priceService(r, pp()) : 0;
  };
  const lawnPrice = (band: Lawn) => {
    const r = rule("Lawn mowing & trim");
    return r ? priceService(r, { ...pp(), lawn_band: band }) : 0;
  };

  const steps = ["Your place", "Your house", "Your pier", "Your lifts", "Boats & jet skis", "Water toys", "Your lawn"];
  const last = steps.length - 1;

  async function finish() {
    setBusy(true);
    const payload: WizardInput = {
      lake: draft.lake,
      address: draft.address,
      lat: draft.lat,
      lng: draft.lng,
      sqft: draft.sqft,
      gate: draft.gate,
      beds: draft.beds,
      baths: draft.baths,
      pier_sections: draft.pier_sections,
      ladder: draft.ladder,
      bumpers: draft.bumpers,
      boat_lifts: draft.boat_lifts,
      toy_lifts: 0,
      jet_skis: draft.jet_skis,
      pwc_lifts: draft.pwc_lifts,
      canopy: draft.canopy,
      lawn_band: draft.lawn_band,
      boats: draft.boats,
      toys: draft.toys.map((name) => ({ name })),
    };
    const res = await saveProfile(payload);
    setBusy(false);
    if (!res.ok) {
      toast(res.error ?? "Could not save your profile.");
      return;
    }
    setDone(true);
    sendWelcomeEmail().catch(() => {});
  }

  if (done) {
    return <Recap draft={draft} priceOf={priceOf} onGo={() => router.push("/profile")} />;
  }

  return (
    <div className="ll-card ll-card-pad" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span className="ll-pill teal">Step {step + 1} of {steps.length}</span>
        <span className="mut" style={{ fontSize: 12.5 }}>{steps[step]}</span>
      </div>

      <div style={{ height: 6, background: "var(--line)", borderRadius: 99, marginBottom: 20 }}>
        <div style={{ width: `${((step + 1) / steps.length) * 100}%`, height: "100%", background: "var(--teal)", borderRadius: 99, transition: "width .25s" }} />
      </div>

      <h2 style={{ fontSize: 22, marginBottom: 6 }}>{steps[step]}</h2>

      {/* STEP 0 — place */}
      {step === 0 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Which lake are we taking care of? This sets your season windows.
          </p>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Lake</div>
            <ChoiceChips options={lakes} value={draft.lake} onChange={(lake) => set({ lake })} />
          </div>
          <AddressAutocomplete
            value={draft.address}
            onChange={(address) => set({ address })}
            onSelect={(s) => set({ address: s.address, lat: s.lat, lng: s.lng })}
          />
        </>
      )}

      {/* STEP 1 — house */}
      {step === 1 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            We price housekeeping by square footage — answer once and every clean is priced right.
          </p>
          <div style={{ display: "flex", gap: 12, marginBottom: 4 }}>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Square footage</label>
              <input type="number" value={draft.sqft || ""} onChange={(e) => set({ sqft: +e.target.value })} />
            </div>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Gate / door code</label>
              <input value={draft.gate} placeholder="e.g. 2214" onChange={(e) => set({ gate: e.target.value })} />
            </div>
          </div>
          <Stepper label="Bedrooms" value={draft.beds} onChange={(beds) => set({ beds })} min={0} max={20} />
          <Stepper label="Bathrooms" value={draft.baths} onChange={(baths) => set({ baths })} min={0} max={20} />
          <p className="mut" style={{ fontSize: 12.5, marginTop: 4 }}>
            🔒 Your gate code is encrypted and only shown to a crew on the day of a job.
          </p>
        </>
      )}

      {/* STEP 2 — pier */}
      {step === 2 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Count every 8–10 ft section from shore to the end — L-sections and platforms count.
            Install &amp; removal are priced per section.
          </p>
          <Stepper label="Pier sections" value={draft.pier_sections} onChange={(pier_sections) => set({ pier_sections })} min={0} max={40} />
          <Toggle label="Swim ladder" checked={draft.ladder} onChange={(ladder) => set({ ladder })} />
          <Toggle label="Bumpers / cleats" checked={draft.bumpers} onChange={(bumpers) => set({ bumpers })} />
          <PriceHint text={`Pier install / removal: ${formatPrice(priceOf("Pier install / removal"))} per trip`} />
        </>
      )}

      {/* STEP 3 — lifts */}
      {step === 3 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Boat lifts on the property. Jet-ski lifts come on the next screen.
          </p>
          <Stepper label="Boat lifts" value={draft.boat_lifts} onChange={(boat_lifts) => set({ boat_lifts })} min={0} max={10} />
          <Toggle label="Lift canopy" checked={draft.canopy} onChange={(canopy) => set({ canopy })} />
          {draft.boat_lifts > 0 && (
            <PriceHint text={`Boat lift set / pull: ${formatPrice(priceOf("Boat lift set / pull"))} per trip`} />
          )}
        </>
      )}

      {/* STEP 4 — boats & jet skis */}
      {step === 4 && (
        <>
          <p className="mut" style={{ marginBottom: 14, fontSize: 14 }}>
            Boats are winterized &amp; stored by the foot. Tap the type, set the length.
            (We store and winterize; we don&apos;t service or repair.)
          </p>

          {draft.boats.map((b, i) => (
            <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>Boat {i + 1}</div>
                {draft.boats.length > 0 && (
                  <button className="ll-x" onClick={() => removeBoat(i)} aria-label="Remove boat">✕</button>
                )}
              </div>
              <ChoiceChips
                options={BOAT_TYPES}
                value={b.type}
                onChange={(type) => updateBoat(i, { type })}
              />
              <div className="ll-field" style={{ marginTop: 10, marginBottom: 0, maxWidth: 160 }}>
                <label>Length (ft)</label>
                <input type="number" value={b.length_ft || ""} onChange={(e) => updateBoat(i, { length_ft: +e.target.value })} />
              </div>
            </div>
          ))}
          <button className="ll-btn ghost sm" onClick={addBoat}>+ Add a boat</button>

          <div style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>Jet skis / PWC</div>
            <p className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>
              Winterized &amp; stored, and set/pulled on their lifts each season.
            </p>
            <Stepper label="Jet skis" value={draft.jet_skis} onChange={(jet_skis) => set({ jet_skis })} min={0} max={12} />
            <Stepper label="PWC lifts" value={draft.pwc_lifts} onChange={(pwc_lifts) => set({ pwc_lifts })} min={0} max={12} />
          </div>

          <PriceHint text={hintFor(draft, priceOf)} />
        </>
      )}

      {/* STEP 5 — water toys */}
      {step === 5 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Tap everything we&apos;ll store for you each fall.
          </p>
          <ToggleChips
            options={TOY_OPTIONS}
            selected={draft.toys}
            onToggle={(t) => set({ toys: draft.toys.includes(t) ? draft.toys.filter((x) => x !== t) : [...draft.toys, t] })}
          />
          <p className="mut" style={{ fontSize: 12.5, marginTop: 12 }}>
            {draft.toys.length ? `${draft.toys.length} toy${draft.toys.length === 1 ? "" : "s"} selected.` : "None yet — that's fine too."}
          </p>
        </>
      )}

      {/* STEP 6 — lawn */}
      {step === 6 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Just the mowable area — beds, seawall, and woods don&apos;t count.
          </p>
          {(["small", "medium", "large"] as Lawn[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => set({ lawn_band: k })}
              style={{
                display: "flex", gap: 10, alignItems: "center", width: "100%", textAlign: "left",
                padding: "12px 14px", borderRadius: 12, marginBottom: 8, fontSize: 14, cursor: "pointer",
                border: `1.5px solid ${draft.lawn_band === k ? "var(--teal)" : "var(--line)"}`,
                background: draft.lawn_band === k ? "#F2F9FA" : "#fff",
              }}
            >
              <b style={{ minWidth: 66, textTransform: "capitalize" }}>{k}</b>
              <span className="mut">{LAWN_DESC[k]} — {formatPrice(lawnPrice(k))}/visit</span>
            </button>
          ))}
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
        <button className="ll-btn ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} style={{ visibility: step === 0 ? "hidden" : "visible" }}>Back</button>
        {step < last ? (
          <button className="ll-btn" onClick={() => setStep((s) => s + 1)}>Next</button>
        ) : (
          <button className="ll-btn gold" onClick={finish} disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
        )}
      </div>
    </div>
  );

  function updateBoat(i: number, patch: Partial<{ type: string; length_ft: number }>) {
    setDraft((d) => ({ ...d, boats: d.boats.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
  }
  function addBoat() {
    setDraft((d) => ({ ...d, boats: [...d.boats, { type: "Pontoon", length_ft: 20 }] }));
  }
  function removeBoat(i: number) {
    setDraft((d) => ({ ...d, boats: d.boats.filter((_, j) => j !== i) }));
  }
}

function hintFor(draft: Draft, priceOf: (n: string) => number): string {
  const parts: string[] = [];
  if (draft.boats.some((b) => b.length_ft > 0)) parts.push(`Boat storage ${formatPrice(priceOf("Boat storage & winterize"))}/season`);
  if (draft.jet_skis > 0) parts.push(`Jet skis ${formatPrice(priceOf("Jet ski winterize & store"))}/season`);
  if (draft.pwc_lifts > 0) parts.push(`PWC lifts ${formatPrice(priceOf("PWC lift set / pull"))}/trip`);
  return parts.length ? parts.join(" · ") : "Add a boat or jet ski to see pricing";
}

// ---------- recap ----------
function Recap({ draft, priceOf, onGo }: { draft: Draft; priceOf: (name: string) => number; onGo: () => void }) {
  const ft = boatFeet({ boats: draft.boats });
  const boats = draft.boats.filter((b) => b.length_ft > 0);
  const rows: Array<[string, string, string]> = [
    ["🏠", "Your house", `${draft.sqft.toLocaleString()} sq ft, ${draft.beds} bd / ${draft.baths} ba — housekeeping ${formatPrice(priceOf("Housekeeping"))} a visit`],
    ["🛠️", "Your pier", `${draft.pier_sections} sections — ${formatPrice(priceOf("Pier install / removal"))} a trip, in every spring, out every fall`],
    ["⚓", "Your lifts", `${draft.boat_lifts} boat lift${draft.boat_lifts === 1 ? "" : "s"}${draft.canopy ? " with canopy" : ""}${draft.pwc_lifts ? ` and ${draft.pwc_lifts} PWC lift${draft.pwc_lifts === 1 ? "" : "s"}` : ""}`],
    ["🛥️", "Your fleet", boats.length ? `${boats.map((b) => `${b.length_ft}' ${b.type}`).join(", ")} — stored for ${formatPrice(priceOf("Boat storage & winterize"))} a season ($50/ft, ${ft} ft total)` : "No boats on file yet"],
  ];
  if (draft.jet_skis > 0) {
    rows.push(["🌊", "Jet skis", `${draft.jet_skis} jet ski${draft.jet_skis === 1 ? "" : "s"} — winterized & stored for ${formatPrice(priceOf("Jet ski winterize & store"))} a season`]);
  }
  if (draft.toys.length) {
    rows.push(["🛶", "The toys", `${draft.toys.join(", ")} — tucked away every fall, back out every spring`]);
  }
  rows.push(["🌱", "The lawn", `${draft.lawn_band[0].toUpperCase()}${draft.lawn_band.slice(1)} — ${formatPrice(priceOf("Lawn mowing & trim"))} mow & blow, weekly`]);

  return (
    <div className="ll-card ll-card-pad" style={{ maxWidth: 560, margin: "0 auto" }}>
      <span className="ll-pill gold">All set</span>
      <h2 style={{ fontSize: 24, margin: "10px 0 4px" }}>Here&apos;s your place, {draft.address || "on the water"}.</h2>
      <p className="mut" style={{ fontSize: 14, marginBottom: 12 }}>
        Every price below is now exact to your property. We&apos;ve emailed you this recap too.
      </p>
      <div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 12, padding: "9px 0", borderBottom: "1px dashed var(--line)" }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>{r[0]}</span>
            <div>
              <b style={{ fontSize: 14 }}>{r[1]}</b>
              <div className="mut" style={{ fontSize: 13 }}>{r[2]}</div>
            </div>
          </div>
        ))}
      </div>
      <button className="ll-btn" style={{ width: "100%", marginTop: 20 }} onClick={onGo}>Go to my property profile →</button>
    </div>
  );
}

function PriceHint({ text }: { text: string }) {
  return (
    <div style={{ marginTop: 14, padding: "10px 12px", background: "#F2F9FA", borderRadius: 10, fontSize: 13, fontWeight: 700, color: "var(--teal-dark)" }}>
      {text}
    </div>
  );
}
