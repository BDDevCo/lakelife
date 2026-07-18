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

const BOAT_TYPES = [
  "Pontoon", "Tritoon", "Wake boat", "Ski boat", "Fishing boat", "Runabout / bowrider", "Sailboat", "Other",
];
const TOY_OPTIONS = ["Kayak", "Paddleboard", "Tube", "Water trampoline", "Canoe", "Floating mat", "Water slide"];
const LAWN_DESC: Record<Lawn, string> = {
  small: "under ¼ acre mowable",
  medium: "¼–½ acre mowable",
  large: "over ½ acre mowable",
};

// Service catalog, grouped. Everyone picks what fits their place — a home near
// the lake can choose only mowing + housekeeping and never see dock questions.
const SERVICE_GROUPS: Array<{ title: string; note: string; items: Array<{ name: string; desc: string; icon: string }> }> = [
  {
    title: "Home & seasonal",
    note: "For any lake-area home",
    items: [
      { name: "Spring opening", desc: "Get the house awake for the season", icon: "🌷" },
      { name: "Fall winterization", desc: "Button it up before the freeze", icon: "❄️" },
      { name: "Housekeeping", desc: "Cleaned & ready before you arrive", icon: "🧹" },
      { name: "Lawn mowing & trim", desc: "Weekly mow & blow", icon: "🌱" },
    ],
  },
  {
    title: "Dock & lift",
    note: "If you have shoreline or lake access",
    items: [
      { name: "Pier install / removal", desc: "In each spring, out each fall", icon: "🛠️" },
      { name: "Boat lift set / pull", desc: "Set and pulled with the season", icon: "⚓" },
      { name: "PWC lift set / pull", desc: "Jet-ski lifts, set & pulled", icon: "🌊" },
    ],
  },
  {
    title: "Storage & winterizing",
    note: "Boats & toys, waterfront or trailered",
    items: [
      { name: "Boat storage & winterize", desc: "Winterized, wrapped & stored", icon: "🛥️" },
      { name: "Jet ski winterize & store", desc: "Jet skis prepped & stored", icon: "🏍️" },
      { name: "Water toy prep & storage", desc: "Kayaks, tubes & toys stored", icon: "🛶" },
    ],
  },
];

interface Draft {
  lake: string;
  address: string;
  lat: number | null;
  lng: number | null;
  wanted: string[];
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
    wanted: initial.wanted ?? [],
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
  const wants = (name: string) => draft.wanted.includes(name);

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

  // The steps shown adapt to the services chosen.
  const homeEntry = wants("Spring opening") || wants("Fall winterization") || wants("Housekeeping");
  const stepKeys: string[] = ["place", "services"];
  if (homeEntry) stepKeys.push("access");
  if (wants("Lawn mowing & trim")) stepKeys.push("lawn");
  if (wants("Pier install / removal")) stepKeys.push("pier");
  if (wants("Boat lift set / pull")) stepKeys.push("lifts");
  if (wants("Boat storage & winterize")) stepKeys.push("boats");
  if (wants("Jet ski winterize & store") || wants("PWC lift set / pull")) stepKeys.push("jetskis");
  if (wants("Water toy prep & storage")) stepKeys.push("toys");

  const current = Math.min(step, stepKeys.length - 1);
  const key = stepKeys[current];
  const last = current === stepKeys.length - 1;
  const titleFor: Record<string, string> = {
    place: "Your place", services: "What can we do for you?", access: "Home access",
    lawn: "Your lawn", pier: "Your pier", lifts: "Your lifts", boats: "Your boats",
    jetskis: "Jet skis / PWC", toys: "Water toys",
  };

  function next() {
    if (key === "services" && draft.wanted.length === 0) {
      toast("Pick at least one service to continue.");
      return;
    }
    setStep(current + 1);
  }

  async function finish() {
    setBusy(true);
    const payload: WizardInput = {
      lake: draft.lake, address: draft.address, lat: draft.lat, lng: draft.lng,
      sqft: draft.sqft, gate: draft.gate, beds: draft.beds, baths: draft.baths,
      pier_sections: draft.pier_sections, ladder: draft.ladder, bumpers: draft.bumpers,
      boat_lifts: draft.boat_lifts, toy_lifts: 0, jet_skis: draft.jet_skis, pwc_lifts: draft.pwc_lifts,
      canopy: draft.canopy, lawn_band: draft.lawn_band, boats: draft.boats,
      toys: draft.toys.map((name) => ({ name })), wanted_services: draft.wanted,
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

  function toggleService(name: string) {
    // Functional update so fast successive taps never overwrite each other.
    setDraft((d) => ({
      ...d,
      wanted: d.wanted.includes(name) ? d.wanted.filter((s) => s !== name) : [...d.wanted, name],
    }));
  }

  if (done) return <Recap draft={draft} priceOf={priceOf} onGo={() => router.push("/profile")} />;

  return (
    <div className="ll-card ll-card-pad" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span className="ll-pill teal">Step {current + 1} of {stepKeys.length}</span>
        <span className="mut" style={{ fontSize: 12.5 }}>{titleFor[key]}</span>
      </div>
      <div style={{ height: 6, background: "var(--line)", borderRadius: 99, marginBottom: 20 }}>
        <div style={{ width: `${((current + 1) / stepKeys.length) * 100}%`, height: "100%", background: "var(--teal)", borderRadius: 99, transition: "width .25s" }} />
      </div>
      <h2 style={{ fontSize: 22, marginBottom: 6 }}>{titleFor[key]}</h2>

      {/* PLACE */}
      {key === "place" && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Which lake are you on or near? This sets your service area and season windows.
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

      {/* SERVICES */}
      {key === "services" && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Tap the services you&apos;d like. Only pick what fits your place — you can
            change these anytime, and we&apos;ll only ask about what you choose.
          </p>
          {SERVICE_GROUPS.map((group) => (
            <div key={group.title} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <div style={{ fontWeight: 800, fontSize: 13.5 }}>{group.title}</div>
                <div className="mut" style={{ fontSize: 11.5 }}>{group.note}</div>
              </div>
              {group.items.map((svc) => {
                const on = wants(svc.name);
                return (
                  <button
                    key={svc.name}
                    type="button"
                    onClick={() => toggleService(svc.name)}
                    aria-pressed={on}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
                      padding: "11px 13px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
                      border: `1.5px solid ${on ? "var(--teal)" : "var(--line)"}`,
                      background: on ? "#F2F9FA" : "#fff",
                    }}
                  >
                    <span style={{ fontSize: 20 }}>{svc.icon}</span>
                    <span style={{ flex: 1 }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{svc.name}</span>
                      <span className="mut" style={{ display: "block", fontSize: 12 }}>{svc.desc}</span>
                    </span>
                    <span
                      style={{
                        width: 22, height: 22, borderRadius: 7, flexShrink: 0,
                        border: `1.5px solid ${on ? "var(--teal)" : "#c4d2d6"}`,
                        background: on ? "var(--teal)" : "#fff", color: "#fff",
                        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800,
                      }}
                    >
                      {on ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </>
      )}

      {/* ACCESS (home entry) */}
      {key === "access" && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            {wants("Housekeeping")
              ? "We price housekeeping by square footage, and crews need a way in."
              : "Our crews may need a way into the house or gate."}
          </p>
          {wants("Housekeeping") && (
            <>
              <div className="ll-field">
                <label>Square footage</label>
                <input type="number" value={draft.sqft || ""} onChange={(e) => set({ sqft: +e.target.value })} />
              </div>
              <Stepper label="Bedrooms" value={draft.beds} onChange={(beds) => set({ beds })} min={0} max={20} />
              <Stepper label="Bathrooms" value={draft.baths} onChange={(baths) => set({ baths })} min={0} max={20} />
            </>
          )}
          <div className="ll-field">
            <label>Gate / door code (optional)</label>
            <input value={draft.gate} placeholder="e.g. 2214" onChange={(e) => set({ gate: e.target.value })} />
          </div>
          <p className="mut" style={{ fontSize: 12.5 }}>
            🔒 Encrypted, and only shown to a crew on the day of a job.
          </p>
        </>
      )}

      {/* LAWN */}
      {key === "lawn" && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Just the mowable area — beds, seawall, and woods don&apos;t count.
          </p>
          {(["small", "medium", "large"] as Lawn[]).map((k) => (
            <button
              key={k} type="button" onClick={() => set({ lawn_band: k })}
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

      {/* PIER */}
      {key === "pier" && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Count every 8–10 ft section from shore to the end — L-sections and platforms count.
          </p>
          <Stepper label="Pier sections" value={draft.pier_sections} onChange={(pier_sections) => set({ pier_sections })} min={0} max={40} />
          <Toggle label="Swim ladder" checked={draft.ladder} onChange={(ladder) => set({ ladder })} />
          <Toggle label="Bumpers / cleats" checked={draft.bumpers} onChange={(bumpers) => set({ bumpers })} />
          <PriceHint text={`Pier install / removal: ${formatPrice(priceOf("Pier install / removal"))} per trip`} />
        </>
      )}

      {/* LIFTS */}
      {key === "lifts" && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>How many boat lifts on the property?</p>
          <Stepper label="Boat lifts" value={draft.boat_lifts} onChange={(boat_lifts) => set({ boat_lifts })} min={0} max={10} />
          <Toggle label="Lift canopy" checked={draft.canopy} onChange={(canopy) => set({ canopy })} />
          {draft.boat_lifts > 0 && <PriceHint text={`Boat lift set / pull: ${formatPrice(priceOf("Boat lift set / pull"))} per trip`} />}
        </>
      )}

      {/* BOATS */}
      {key === "boats" && (
        <>
          <p className="mut" style={{ marginBottom: 14, fontSize: 14 }}>
            Winterized &amp; stored by the foot. Tap the type, set the length.
          </p>
          {draft.boats.map((b, i) => (
            <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>Boat {i + 1}</div>
                <button className="ll-x" onClick={() => removeBoat(i)} aria-label="Remove boat">✕</button>
              </div>
              <ChoiceChips options={BOAT_TYPES} value={b.type} onChange={(type) => updateBoat(i, { type })} />
              <div className="ll-field" style={{ marginTop: 10, marginBottom: 0, maxWidth: 160 }}>
                <label>Length (ft)</label>
                <input type="number" value={b.length_ft || ""} onChange={(e) => updateBoat(i, { length_ft: +e.target.value })} />
              </div>
            </div>
          ))}
          <button className="ll-btn ghost sm" onClick={addBoat}>+ Add a boat</button>
          <PriceHint text={`Boat storage: ${formatPrice(priceOf("Boat storage & winterize"))}/season`} />
        </>
      )}

      {/* JET SKIS */}
      {key === "jetskis" && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>
            Winterized &amp; stored, and set/pulled on their lifts each season.
          </p>
          <Stepper label="Jet skis" value={draft.jet_skis} onChange={(jet_skis) => set({ jet_skis })} min={0} max={12} />
          <Stepper label="PWC lifts" value={draft.pwc_lifts} onChange={(pwc_lifts) => set({ pwc_lifts })} min={0} max={12} />
          <PriceHint text={jetHint(draft, priceOf)} />
        </>
      )}

      {/* TOYS */}
      {key === "toys" && (
        <>
          <p className="mut" style={{ marginBottom: 16, fontSize: 14 }}>Tap everything we&apos;ll store for you each fall.</p>
          <ToggleChips
            options={TOY_OPTIONS}
            selected={draft.toys}
            onToggle={(t) =>
              setDraft((d) => ({
                ...d,
                toys: d.toys.includes(t) ? d.toys.filter((x) => x !== t) : [...d.toys, t],
              }))
            }
          />
          <p className="mut" style={{ fontSize: 12.5, marginTop: 12 }}>
            {draft.toys.length ? `${draft.toys.length} selected.` : "None yet — that's fine too."}
          </p>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
        <button className="ll-btn ghost" onClick={() => setStep(Math.max(0, current - 1))} style={{ visibility: current === 0 ? "hidden" : "visible" }}>Back</button>
        {!last ? (
          <button className="ll-btn" onClick={next}>Next</button>
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

function jetHint(draft: Draft, priceOf: (n: string) => number): string {
  const parts: string[] = [];
  if (draft.jet_skis > 0) parts.push(`Jet skis ${formatPrice(priceOf("Jet ski winterize & store"))}/season`);
  if (draft.pwc_lifts > 0) parts.push(`PWC lifts ${formatPrice(priceOf("PWC lift set / pull"))}/trip`);
  return parts.length ? parts.join(" · ") : "Set the counts to see pricing";
}

// ---------- recap ----------
function Recap({ draft, priceOf, onGo }: { draft: Draft; priceOf: (name: string) => number; onGo: () => void }) {
  const ft = boatFeet({ boats: draft.boats });
  const lines: Array<[string, string, string]> = draft.wanted.map((name) => {
    const price = priceOf(name);
    const per = perLabel(name);
    let detail = "";
    if (name === "Housekeeping") detail = `${draft.sqft.toLocaleString()} sq ft`;
    else if (name === "Pier install / removal") detail = `${draft.pier_sections} sections`;
    else if (name === "Boat storage & winterize") detail = `${ft} ft total`;
    else if (name === "Jet ski winterize & store") detail = `${draft.jet_skis} jet ski${draft.jet_skis === 1 ? "" : "s"}`;
    else if (name === "Lawn mowing & trim") detail = `${draft.lawn_band} lawn`;
    return [name, `${formatPrice(price)} ${per}`, detail];
  });

  return (
    <div className="ll-card ll-card-pad" style={{ maxWidth: 560, margin: "0 auto" }}>
      <span className="ll-pill gold">All set</span>
      <h2 style={{ fontSize: 24, margin: "10px 0 4px" }}>You&apos;re set up, {draft.address || "welcome"}.</h2>
      <p className="mut" style={{ fontSize: 14, marginBottom: 12 }}>
        Here are the services you chose, priced exactly to your place. We&apos;ve emailed you this too.
      </p>
      <div>
        {lines.map((r, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px dashed var(--line)" }}>
            <div>
              <b style={{ fontSize: 14 }}>{r[0]}</b>
              {r[2] && <div className="mut" style={{ fontSize: 12.5 }}>{r[2]}</div>}
            </div>
            <b style={{ color: "var(--teal-dark)", whiteSpace: "nowrap" }}>{r[1]}</b>
          </div>
        ))}
      </div>
      <button className="ll-btn" style={{ width: "100%", marginTop: 20 }} onClick={onGo}>Go to my property profile →</button>
    </div>
  );
}

function perLabel(name: string): string {
  if (name === "Housekeeping" || name === "Lawn mowing & trim") return "/ visit";
  if (name === "Boat storage & winterize" || name === "Jet ski winterize & store") return "/ season";
  if (name.includes("Pier") || name.includes("lift")) return "/ trip";
  return "";
}

function PriceHint({ text }: { text: string }) {
  return (
    <div style={{ marginTop: 14, padding: "10px 12px", background: "#F2F9FA", borderRadius: 10, fontSize: 13, fontWeight: 700, color: "var(--teal-dark)" }}>
      {text}
    </div>
  );
}
