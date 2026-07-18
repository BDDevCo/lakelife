"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { priceService, boatFeet, formatPrice, type ServiceRule } from "@/lib/pricing";
import { saveProfile, type WizardInput } from "@/app/profile/actions";
import { sendWelcomeEmail } from "@/app/profile/email-actions";
import { toast } from "@/components/Toast";

type Lawn = "small" | "medium" | "large";

interface Draft {
  lake: string;
  address: string;
  sqft: number;
  gate: string;
  beds: number;
  baths: number;
  pier_sections: number;
  ladder: boolean;
  bumpers: boolean;
  boat_lifts: number;
  toy_lifts: number;
  canopy: boolean;
  lawn_band: Lawn;
  boats: Array<{ type: string; length_ft: number }>;
  toys: Array<{ name: string }>;
  photo_count: number;
}

const LAWN_DESC: Record<Lawn, string> = {
  small: "under ¼ acre mowable",
  medium: "¼–½ acre mowable",
  large: "over ½ acre mowable",
};

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
  const fileRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<Draft>({
    lake: initial.lake ?? lakes[0] ?? "",
    address: initial.address ?? "",
    sqft: initial.sqft ?? 2400,
    gate: initial.gate ?? "",
    beds: initial.beds ?? 4,
    baths: initial.baths ?? 3,
    pier_sections: initial.pier_sections ?? 10,
    ladder: initial.ladder ?? true,
    bumpers: initial.bumpers ?? true,
    boat_lifts: initial.boat_lifts ?? 1,
    toy_lifts: initial.toy_lifts ?? 1,
    canopy: initial.canopy ?? true,
    lawn_band: initial.lawn_band ?? "medium",
    boats: initial.boats?.length ? initial.boats : [{ type: "Pontoon", length_ft: 24 }],
    toys: initial.toys?.length ? initial.toys : [{ name: "Kayak" }],
    photo_count: 0,
  });

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const rule = (name: string) => services.find((s) => s.name === name);
  const priceOf = (name: string) => {
    const r = rule(name);
    return r ? priceService(r, draftToPricing(draft)) : 0;
  };
  const lawnPrice = (band: Lawn) => {
    const r = rule("Lawn mowing & trim");
    return r ? priceService(r, { ...draftToPricing(draft), lawn_band: band }) : 0;
  };

  const steps = [
    "Your place",
    "Your house",
    "Your pier",
    "Waterfront photos",
    "Your lifts",
    "Boats & water toys",
    "Your lawn",
  ];
  const last = steps.length - 1;

  async function finish() {
    setBusy(true);
    const payload: WizardInput = { ...draft };
    const res = await saveProfile(payload);
    setBusy(false);
    if (!res.ok) {
      toast(res.error ?? "Could not save your profile.");
      return;
    }
    setDone(true);
    // Fire the welcome email in the background — never block the recap on it.
    sendWelcomeEmail().catch(() => {});
  }

  if (done) {
    return <Recap draft={draft} priceOf={priceOf} onGo={() => router.push("/profile")} />;
  }

  return (
    <div className="ll-card ll-card-pad" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span className="ll-pill teal">
          Step {step + 1} of {steps.length}
        </span>
        <span className="mut" style={{ fontSize: 12.5 }}>{steps[step]}</span>
      </div>

      {/* progress bar */}
      <div style={{ height: 6, background: "var(--line)", borderRadius: 99, marginBottom: 20 }}>
        <div
          style={{
            width: `${((step + 1) / steps.length) * 100}%`,
            height: "100%",
            background: "var(--teal)",
            borderRadius: 99,
            transition: "width .25s",
          }}
        />
      </div>

      <h2 style={{ fontSize: 22, marginBottom: 6 }}>{steps[step]}</h2>

      {/* ---- STEP 0: place ---- */}
      {step === 0 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Which lake are we taking care of, and where is it? This sets your season
            windows — water work opens after ice-out and closes before the freeze.
          </p>
          <div className="ll-field">
            <label>Lake</label>
            <select
              value={draft.lake}
              onChange={(e) => set({ lake: e.target.value })}
              style={selectStyle}
            >
              {lakes.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
          <div className="ll-field">
            <label>Property address</label>
            <input
              placeholder="4521 Lakeview Drive, South Milford, IN"
              value={draft.address}
              onChange={(e) => set({ address: e.target.value })}
            />
          </div>
        </>
      )}

      {/* ---- STEP 1: house ---- */}
      {step === 1 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            We price housekeeping by square footage — answer once and every clean is
            priced right, forever.
          </p>
          <div style={twoCol}>
            <NumField label="Square footage" value={draft.sqft} onChange={(v) => set({ sqft: v })} />
            <TextField label="Gate / door code" value={draft.gate} onChange={(v) => set({ gate: v })} placeholder="e.g. 2214" />
          </div>
          <div style={twoCol}>
            <NumField label="Bedrooms" value={draft.beds} onChange={(v) => set({ beds: v })} />
            <NumField label="Bathrooms" value={draft.baths} onChange={(v) => set({ baths: v })} />
          </div>
          <p className="mut" style={{ fontSize: 12.5, marginTop: 4 }}>
            🔒 Your gate code is encrypted and only shown to a crew on the day of a job.
          </p>
        </>
      )}

      {/* ---- STEP 2: pier ---- */}
      {step === 2 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Walk it once and count every 8–10 ft section from shore to the end —
            L-sections and platforms count. Install and removal are priced per section,
            so this number is the whole ballgame.
          </p>
          <NumField
            label="Number of pier sections"
            value={draft.pier_sections}
            onChange={(v) => set({ pier_sections: v })}
          />
          <Check label="Swim ladder" checked={draft.ladder} onChange={(v) => set({ ladder: v })} />
          <Check label="Bumpers / cleats" checked={draft.bumpers} onChange={(v) => set({ bumpers: v })} />
          <PriceHint text={`Pier install / removal: ${formatPrice(priceOf("Pier install / removal"))} per trip`} />
        </>
      )}

      {/* ---- STEP 3: photos ---- */}
      {step === 3 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Snap 2–4 photos: the full pier from shore, your lift(s), and the shoreline.
            We verify your section count against these before the first crew rolls. You
            can skip this and a crew will verify on the first visit instead.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => set({ photo_count: e.target.files?.length ?? 0 })}
          />
          <button className="ll-btn ghost" onClick={() => fileRef.current?.click()}>
            📷 Add photos
          </button>
          <p className="mut" style={{ fontSize: 12.5, marginTop: 10 }}>
            {draft.photo_count
              ? `${draft.photo_count} photo${draft.photo_count === 1 ? "" : "s"} selected — thanks, this saves a site visit.`
              : "None yet — optional. A crew will verify on the first visit."}
          </p>
        </>
      )}

      {/* ---- STEP 4: lifts ---- */}
      {step === 4 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Every lift on the property — boat lifts, PWC lifts, toy lifts. If it comes
            out of the water in fall, we need to know it exists.
          </p>
          <div style={twoCol}>
            <NumField label="Boat lifts" value={draft.boat_lifts} onChange={(v) => set({ boat_lifts: v })} />
            <NumField label="Toy / PWC lifts" value={draft.toy_lifts} onChange={(v) => set({ toy_lifts: v })} />
          </div>
          <Check label="Lift canopy" checked={draft.canopy} onChange={(v) => set({ canopy: v })} />
          <PriceHint text={`Boat lift set / pull: ${formatPrice(priceOf("Boat lift set / pull"))} per trip`} />
        </>
      )}

      {/* ---- STEP 5: boats + toys ---- */}
      {step === 5 && (
        <>
          <p className="mut" style={{ marginBottom: 14, fontSize: 14 }}>
            Winterization and storage price by the foot — measure bow to stern and round
            up. Add every boat and every toy we&apos;ll store. (We store and winterize; we
            don&apos;t service or repair.)
          </p>
          <div className="mut" style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
            Boats · $50/ft to winterize &amp; store
          </div>
          {draft.boats.map((b, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 8 }}>
              <div className="ll-field" style={{ flex: 1.5, marginBottom: 0 }}>
                <label>Boat type</label>
                <input
                  value={b.type}
                  placeholder="Pontoon, ski boat, fishing…"
                  onChange={(e) => updateBoat(i, { type: e.target.value })}
                />
              </div>
              <div className="ll-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Length (ft)</label>
                <input
                  type="number"
                  value={b.length_ft || ""}
                  onChange={(e) => updateBoat(i, { length_ft: +e.target.value })}
                />
              </div>
              <button className="ll-x" onClick={() => removeBoat(i)} aria-label="Remove boat">✕</button>
            </div>
          ))}
          <button className="ll-btn ghost sm" onClick={addBoat}>+ Add a boat</button>

          <div className="mut" style={{ fontWeight: 700, fontSize: 12.5, margin: "18px 0 8px" }}>
            Water toys we&apos;ll store each fall
          </div>
          {draft.toys.map((t, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input
                value={t.name}
                placeholder="Kayak, SUP, tube, trampoline…"
                onChange={(e) => updateToy(i, e.target.value)}
                style={{ flex: 1, padding: "10px 13px", border: "1.5px solid var(--line)", borderRadius: 10, fontFamily: "inherit", fontSize: 14 }}
              />
              <button className="ll-x" onClick={() => removeToy(i)} aria-label="Remove toy">✕</button>
            </div>
          ))}
          <button className="ll-btn ghost sm" onClick={addToy}>+ Add a toy</button>
          <PriceHint
            text={`Boat storage: ${formatPrice(priceOf("Boat storage & winterize"))}/season · Toy prep: ${formatPrice(priceOf("Water toy prep & storage"))}/season`}
          />
        </>
      )}

      {/* ---- STEP 6: lawn ---- */}
      {step === 6 && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Just the mowable area — beds, seawall, and woods don&apos;t count. This sets
            your weekly mow &amp; blow price.
          </p>
          {(["small", "medium", "large"] as Lawn[]).map((k) => (
            <label
              key={k}
              style={{
                display: "flex", gap: 9, alignItems: "center", padding: "10px 12px",
                border: `1.5px solid ${draft.lawn_band === k ? "var(--teal)" : "var(--line)"}`,
                borderRadius: 10, marginBottom: 8, fontSize: 14,
                background: draft.lawn_band === k ? "#F2F9FA" : "#fff", cursor: "pointer",
              }}
            >
              <input type="radio" name="lawn" checked={draft.lawn_band === k} onChange={() => set({ lawn_band: k })} />
              <b style={{ minWidth: 70, textTransform: "capitalize" }}>{k}</b>
              <span className="mut">{LAWN_DESC[k]} — {formatPrice(lawnPrice(k))}/visit</span>
            </label>
          ))}
        </>
      )}

      {/* ---- nav ---- */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
        <button
          className="ll-btn ghost"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          style={{ visibility: step === 0 ? "hidden" : "visible" }}
        >
          Back
        </button>
        {step < last ? (
          <button className="ll-btn" onClick={() => setStep((s) => s + 1)}>Next</button>
        ) : (
          <button className="ll-btn gold" onClick={finish} disabled={busy}>
            {busy ? "Saving…" : "Save profile"}
          </button>
        )}
      </div>
    </div>
  );

  // ---- dynamic list helpers ----
  function updateBoat(i: number, patch: Partial<{ type: string; length_ft: number }>) {
    setDraft((d) => ({ ...d, boats: d.boats.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
  }
  function addBoat() {
    setDraft((d) => ({ ...d, boats: [...d.boats, { type: "", length_ft: 0 }] }));
  }
  function removeBoat(i: number) {
    setDraft((d) => ({ ...d, boats: d.boats.filter((_, j) => j !== i) }));
  }
  function updateToy(i: number, name: string) {
    setDraft((d) => ({ ...d, toys: d.toys.map((t, j) => (j === i ? { name } : t)) }));
  }
  function addToy() {
    setDraft((d) => ({ ...d, toys: [...d.toys, { name: "" }] }));
  }
  function removeToy(i: number) {
    setDraft((d) => ({ ...d, toys: d.toys.filter((_, j) => j !== i) }));
  }
}

// ---------- recap ----------
function Recap({
  draft,
  priceOf,
  onGo,
}: {
  draft: Draft;
  priceOf: (name: string) => number;
  onGo: () => void;
}) {
  const ft = boatFeet(draft);
  const rows: Array<[string, string, string]> = [
    ["🏠", "Your house", `${draft.sqft.toLocaleString()} sq ft, ${draft.beds} bd / ${draft.baths} ba — housekeeping lands at ${formatPrice(priceOf("Housekeeping"))} a visit, timed to your arrivals`],
    ["🛠️", "Your pier", `${draft.pier_sections} sections — in every spring, out every fall, ${formatPrice(priceOf("Pier install / removal"))} a trip, leveled and laddered`],
    ["⚓", "Your lifts", `${draft.boat_lifts} boat lift${draft.boat_lifts > 1 ? "s" : ""}${draft.canopy ? " with canopy" : ""} and ${draft.toy_lifts} toy/PWC lift — set and pulled right alongside the pier`],
    ["🛥️", "Your fleet", draft.boats.filter((b) => b.length_ft > 0).length
      ? `${draft.boats.filter((b) => b.length_ft > 0).map((b) => `${b.length_ft}' ${b.type || "boat"}`).join(", ")} — winterized, wrapped & stored for ${formatPrice(priceOf("Boat storage & winterize"))} a season ($50/ft, ${ft} ft total)`
      : "No boats on file yet — add one anytime and we'll have a storage bay waiting"],
    ["🛶", "The toys", draft.toys.filter((t) => t.name.trim()).length
      ? `${draft.toys.filter((t) => t.name.trim()).map((t) => t.name).join(", ")} — cleaned up every fall, back out every spring`
      : "None yet — the trampoline can always come later"],
    ["🌱", "The lawn", `${draft.lawn_band[0].toUpperCase()}${draft.lawn_band.slice(1)} — ${formatPrice(priceOf("Lawn mowing & trim"))} mow & blow, same crew, same day, every week`],
  ];

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
      <button className="ll-btn" style={{ width: "100%", marginTop: 20 }} onClick={onGo}>
        Go to my property profile →
      </button>
    </div>
  );
}

// ---------- small field helpers ----------
const selectStyle: React.CSSProperties = {
  width: "100%", padding: "11px 13px", border: "1.5px solid var(--line)",
  borderRadius: 10, fontSize: 15, fontFamily: "inherit", background: "#fff", color: "var(--text)",
};
const twoCol: React.CSSProperties = { display: "flex", gap: 12 };

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="ll-field" style={{ flex: 1 }}>
      <label>{label}</label>
      <input type="number" value={value || ""} onChange={(e) => onChange(+e.target.value)} />
    </div>
  );
}
function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="ll-field" style={{ flex: 1 }}>
      <label>{label}</label>
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", gap: 8, fontSize: 14, marginBottom: 8, alignItems: "center", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}
function PriceHint({ text }: { text: string }) {
  return (
    <div style={{ marginTop: 14, padding: "10px 12px", background: "#F2F9FA", borderRadius: 10, fontSize: 13, fontWeight: 700, color: "var(--teal-dark)" }}>
      {text}
    </div>
  );
}

// draft -> pricing profile shape
function draftToPricing(d: Draft) {
  return {
    sqft: d.sqft, beds: d.beds, baths: d.baths,
    pier_sections: d.pier_sections, boat_lifts: d.boat_lifts, toy_lifts: d.toy_lifts,
    lawn_band: d.lawn_band, boats: d.boats, toys: d.toys,
  };
}
