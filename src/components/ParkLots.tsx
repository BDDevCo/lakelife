"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { saveLot, saveLotRates, generateLots, setRatesForLots } from "@/app/park/actions";
import { SITE_DEFAULTS, type LotFormInput, type LotRangeInput } from "@/app/park/park-helpers";

/**
 * Lots and rates — the park's inventory and its rate card. The park owner
 * dictates the money here (rule 8: the numbers live in the database, never in
 * our code) and LakeLife never prices a lot.
 *
 * A blank rate means "we don't sell that term", and the engine treats it that
 * way: a stay quoted against a term with no rate comes back null rather than
 * silently falling through to another term.
 */

export interface LotView {
  id: string;
  lotNumber: string;
  siteType: string;
  maxLengthFt: number | null;
  amperage: number | null;
  hasWater: boolean;
  hasSewer: boolean;
  slipIncluded: boolean;
  notes: string | null;
  active: boolean;
  tier?: string;
  features?: string[];
  rates: { term: string; amount: number }[];
}

const SITE_TYPES = [
  { value: "rv_site", label: "RV site" },
  { value: "mh_single", label: "Single-wide pad" },
  { value: "mh_double", label: "Double-wide pad" },
  { value: "tent", label: "Tent site" },
  { value: "slip", label: "Boat slip" },
];
const TERMS = ["nightly", "weekly", "monthly", "seasonal", "annual"] as const;

/** WHY a lot is worth more. An allowlist, never a text box — a free-text field
 *  on a housing listing is where a fair-housing problem gets typed. */
const FEATURES = [
  { value: "waterfront", label: "Waterfront" },
  { value: "water_view", label: "Water view" },
  { value: "corner", label: "Corner" },
  { value: "shade", label: "Shade" },
  { value: "pull_through", label: "Pull-through" },
  { value: "extra_parking", label: "Extra parking" },
  { value: "concrete_pad", label: "Concrete pad" },
  { value: "fenced", label: "Fenced" },
  { value: "near_amenities", label: "Near amenities" },
  { value: "private", label: "Private" },
];

const blank = (): LotFormInput => ({
  lotNumber: "", siteType: "rv_site", maxLengthFt: "", amperage: "",
  hasWater: true, hasSewer: true, slipIncluded: false, notes: "", active: true,
  tier: "standard", features: [],
});

export function ParkLots({ parkId, lots }: { parkId: string; lots: LotView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | "new" | null>(lots.length === 0 ? "new" : null);
  const [form, setForm] = useState<LotFormInput>(blank());

  function openNew() {
    setForm(blank());
    setEditing("new");
  }

  function openEdit(lot: LotView) {
    setForm({
      lotNumber: lot.lotNumber,
      siteType: lot.siteType,
      maxLengthFt: lot.maxLengthFt?.toString() ?? "",
      amperage: lot.amperage?.toString() ?? "",
      hasWater: lot.hasWater,
      hasSewer: lot.hasSewer,
      slipIncluded: lot.slipIncluded,
      notes: lot.notes ?? "",
      active: lot.active,
      tier: lot.tier ?? "standard",
      features: lot.features ?? [],
    });
    setEditing(lot.id);
  }

  function submit() {
    startTransition(async () => {
      const res = await saveLot(parkId, editing === "new" ? null : editing, form);
      if (!res.ok) { toast(res.error ?? "Couldn't save."); return; }
      toast(res.signal ?? "Saved.");
      setEditing(null);
      router.refresh();
    });
  }

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Lots &amp; rates</h2>
        {editing !== "new" && <button className="ll-btn" onClick={openNew}>Add a lot</button>}
      </div>

      <BulkAdd
        parkId={parkId}
        hasLots={lots.length > 0}
        // A brand-new park opens with the single-lot form showing (there was
        // nothing else to do). After a bulk add there is plenty to do, and an
        // empty "New lot" form sitting above 79 fresh lots reads like the
        // work did not take.
        onAdded={() => setEditing(null)}
      />

      {lots.length > 1 && <BulkRates parkId={parkId} lotCount={lots.length} />}

      {editing === "new" && (
        <LotForm
          title="New lot"
          form={form}
          setForm={setForm}
          onSave={submit}
          onCancel={() => setEditing(null)}
          pending={pending}
        />
      )}

      {lots.length === 0 && editing !== "new" && (
        <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
          <h3 style={{ fontSize: 17, margin: "0 0 6px" }}>No lots yet</h3>
          <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
            Add each site you rent. You can put in what you charge now or later.
          </p>
          <button className="ll-btn" onClick={openNew}>Add my first lot</button>
        </div>
      )}

      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        {lots.map((lot) =>
          editing === lot.id ? (
            <LotForm
              key={lot.id}
              title={`Lot ${lot.lotNumber}`}
              form={form}
              setForm={setForm}
              onSave={submit}
              onCancel={() => setEditing(null)}
              pending={pending}
            />
          ) : (
            <LotCard key={lot.id} lot={lot} onEdit={() => openEdit(lot)} />
          ),
        )}
      </div>
    </div>
  );
}

function LotCard({ lot, onEdit }: { lot: LotView; onEdit: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [rates, setRates] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const t of TERMS) {
      seed[t] = lot.rates.find((r) => r.term === t)?.amount.toString() ?? "";
    }
    return seed;
  });

  function saveRates() {
    startTransition(async () => {
      const res = await saveLotRates(lot.id, rates);
      if (!res.ok) { toast(res.error ?? "Couldn't save."); return; }
      toast(res.signal ?? "Saved.");
      setOpen(false);
      router.refresh();
    });
  }

  const priced = lot.rates.filter((r) => r.amount > 0);
  const site = SITE_TYPES.find((s) => s.value === lot.siteType)?.label ?? lot.siteType;

  return (
    <div className="ll-card ll-card-pad" style={{ opacity: lot.active ? 1 : 0.6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <strong style={{ fontSize: 15 }}>Lot {lot.lotNumber}</strong>
          {!lot.active && <span className="ll-pill slate" style={{ marginLeft: 8 }}>Off</span>}
          <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
            {site}
            {lot.maxLengthFt && ` · up to ${lot.maxLengthFt} ft`}
            {lot.amperage && ` · ${lot.amperage} amp`}
            {lot.slipIncluded && " · slip included"}
          </div>
          <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
            {priced.length === 0
              ? "No rates set — this lot can't be quoted yet."
              : priced.map((r) => `$${r.amount.toLocaleString()}/${r.term.replace("ly", "")}`).join(" · ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <button className="ll-btn ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Rates"}
          </button>
          <button className="ll-btn ghost" onClick={onEdit}>Edit</button>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <p className="mut" style={{ fontSize: 13, marginBottom: 10 }}>
            What you charge. Leave a box empty if you don&apos;t rent by that term —
            we&apos;ll never quote a term you haven&apos;t priced.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
            {TERMS.map((t) => (
              <label key={t} className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                <span className="mut" style={{ textTransform: "capitalize" }}>{t}</span>
                <input
                                    inputMode="decimal"
                  placeholder="—"
                  value={rates[t] ?? ""}
                  onChange={(e) => setRates((prev) => ({ ...prev, [t]: e.target.value }))}
                  style={{ marginTop: 4 }}
                />
              </label>
            ))}
          </div>
          <button className="ll-btn" onClick={saveRates} disabled={pending} style={{ marginTop: 12 }}>
            Save rates
          </button>
        </div>
      )}
    </div>
  );
}

function LotForm({
  title, form, setForm, onSave, onCancel, pending,
}: {
  title: string;
  form: LotFormInput;
  setForm: (f: LotFormInput) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const set = <K extends keyof LotFormInput>(k: K, v: LotFormInput[K]) =>
    setForm({ ...form, [k]: v });

  return (
    <div className="ll-card ll-card-pad">
      <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>{title}</h3>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Lot number</span>
          <input
            value={form.lotNumber}
            onChange={(e) => set("lotNumber", e.target.value)}
            placeholder="12" style={{ marginTop: 4 }}
          />
        </label>

        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Site type</span>
          <select
            value={form.siteType}
            onChange={(e) => {
              // Picking a site type sets what that type COMES WITH. A pad has
              // sewer; a water-and-electric site does not, which is what the
              // name says. Before this a new lot started as "RV site, no
              // sewer", and buildLotRow REFUSES a mobile-home pad without
              // sewer — so setting up a park of pads meant fighting our own
              // default on every single lot.
              const d = SITE_DEFAULTS[e.target.value];
              setForm({
                ...form,
                siteType: e.target.value,
                ...(d ? { hasWater: d.hasWater, hasSewer: d.hasSewer } : {}),
              });
            }}
            style={{ marginTop: 4 }}
          >
            {SITE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>

        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Longest rig it fits (ft)</span>
          <input
            inputMode="numeric" value={form.maxLengthFt}
            onChange={(e) => set("maxLengthFt", e.target.value)}
            placeholder="leave blank if unsure" style={{ marginTop: 4 }}
          />
        </label>

        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Power</span>
          <select
            value={form.amperage}
            onChange={(e) => set("amperage", e.target.value)}
            style={{ marginTop: 4 }}
          >
            <option value="">Not sure / none</option>
            {[20, 30, 50, 100].map((a) => <option key={a} value={a}>{a} amp</option>)}
          </select>
        </label>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 14, fontSize: 14 }}>
        <Check label="Water" checked={form.hasWater} onChange={(v) => set("hasWater", v)} />
        <Check label="Sewer" checked={form.hasSewer} onChange={(v) => set("hasSewer", v)} />
        <Check label="Boat slip included" checked={form.slipIncluded} onChange={(v) => set("slipIncluded", v)} />
        <Check label="In service" checked={form.active} onChange={(v) => set("active", v)} />
      </div>

      <div style={{ marginTop: 16 }}>
        <span className="mut" style={{ fontSize: 13 }}>Is this a premium lot?</span>
        <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          {[{ v: "standard", l: "Standard" }, { v: "premium", l: "Premium" }].map((o) => (
            <Chip key={o.v} label={o.l} on={(form.tier ?? "standard") === o.v}
              onClick={() => set("tier", o.v)} />
          ))}
        </div>
      </div>

      {(form.tier ?? "standard") === "premium" && (
        <div style={{ marginTop: 14 }}>
          <span className="mut" style={{ fontSize: 13 }}>What makes it premium?</span>
          <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            {FEATURES.map((f) => {
              const on = (form.features ?? []).includes(f.value);
              return (
                <Chip key={f.value} label={f.label} on={on}
                  onClick={() => set("features", on
                    ? (form.features ?? []).filter((x) => x !== f.value)
                    : [...(form.features ?? []), f.value])} />
              );
            })}
          </div>
          <p className="mut" style={{ fontSize: 13, marginTop: 8 }}>
            These show on your public page, so a renter can see what they&apos;re paying
            more for.
          </p>
        </div>
      )}

      <label className="ll-field" style={{ fontSize: 13, display: "block", marginTop: 14 }}>
        <span className="mut">Notes (only you see these)</span>
        <textarea
          rows={2} value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Shady, close to the pier" style={{ marginTop: 4 }}
        />
      </label>

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button className="ll-btn" onClick={onSave} disabled={pending}>Save lot</button>
        <button className="ll-btn ghost" onClick={onCancel} disabled={pending}>Cancel</button>
      </div>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}


/**
 * ADD A WHOLE PARK AT ONCE.
 *
 * The first thing an owner does, and — before this existed — the reason they
 * never got to the second. park_lots is empty on closing morning, the rent-roll
 * importer joins on lot_number, and the one-at-a-time form below is five
 * interactions and a page refresh, seventy-nine times. Walked through by a real
 * park owner, that is where they quit: at lot 22, having never reached the part
 * that helps them.
 */
function BulkAdd({
  parkId, hasLots, onAdded,
}: {
  parkId: string;
  hasLots: boolean;
  onAdded: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!hasLots); // a brand-new park opens on this
  const [pending, startTransition] = useTransition();
  const [range, setRange] = useState<LotRangeInput>({
    prefix: "", from: "1", to: "", siteType: "mh_single", maxLengthFt: "", amperage: "",
  });

  function make() {
    startTransition(async () => {
      const res = await generateLots(parkId, range);
      if (!res.ok) { toast(res.error ?? "Couldn't add those."); return; }
      toast(res.signal ?? "Lots added.");
      setRange((r) => ({ ...r, from: "1", to: "" }));
      setOpen(false);
      onAdded();
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div style={{ marginBottom: 12 }}>
        <button className="ll-btn ghost" onClick={() => setOpen(true)}>Add a row of lots</button>
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Add your lots</h3>
      <p className="mut" style={{ fontSize: 13, marginBottom: 14 }}>
        Number them all at once — you can change any single one afterwards. Most
        parks do this once and never come back.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Letter in front (optional)</span>
          <input value={range.prefix} placeholder="A"
            onChange={(e) => setRange({ ...range, prefix: e.target.value })}
            style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">First lot</span>
          <input inputMode="numeric" value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
            style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Last lot</span>
          <input inputMode="numeric" value={range.to} placeholder="79"
            onChange={(e) => setRange({ ...range, to: e.target.value })}
            style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">These are</span>
          <select value={range.siteType}
            onChange={(e) => setRange({ ...range, siteType: e.target.value })}
            style={{ marginTop: 4 }}>
            {SITE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>

      <p className="mut" style={{ fontSize: 13, marginTop: 12 }}>
        {range.to.trim()
          ? `Makes ${range.prefix}${range.from} through ${range.prefix}${range.to}. Anything that already exists is left alone.`
          : "Tell us the last lot number and we'll make the whole row."}
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="ll-btn" onClick={make} disabled={pending || !range.to.trim()}>
          Add these lots
        </button>
        {hasLots && (
          <button className="ll-btn ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
        )}
      </div>
    </div>
  );
}


/**
 * PRICE THE WHOLE PARK AT ONCE.
 *
 * The generator solved "79 lots, one form". This is the same wall one step
 * later: without it, pricing a park means opening the Rates panel per lot,
 * seventy-nine times.
 *
 * It FILLS by default and never overwrites. There is no undo on a rate card,
 * and a wrong one stays invisible until a renter is quoted from it — so lots
 * the owner already priced by hand are left alone and counted, and replacing
 * them is a separate tick they have to reach for.
 */
function BulkRates({ parkId, lotCount }: { parkId: string; lotCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [rates, setRates] = useState<Record<string, string>>({});
  const [siteType, setSiteType] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);

  function apply() {
    startTransition(async () => {
      const res = await setRatesForLots(parkId, rates, {
        siteType: siteType || undefined,
        replaceExisting,
      });
      if (!res.ok) { toast(res.error ?? "Couldn't set those."); return; }
      toast(res.signal ?? "Rates set.");
      setOpen(false);
      setRates({});
      setReplaceExisting(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div style={{ marginBottom: 12 }}>
        <button className="ll-btn ghost" onClick={() => setOpen(true)}>
          Set rates on all {lotCount} lots
        </button>
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Set rates on many lots</h3>
      <p className="mut" style={{ fontSize: 13, marginBottom: 14 }}>
        Fill in what you charge and it goes on every lot that doesn&apos;t have its
        own price yet. Leave a box empty if you don&apos;t rent by that term.
      </p>

      <label className="ll-field" style={{ fontSize: 13, display: "block", marginBottom: 12, maxWidth: 280 }}>
        <span className="mut">Which lots</span>
        <select value={siteType} onChange={(e) => setSiteType(e.target.value)} style={{ marginTop: 4 }}>
          <option value="">All of them</option>
          {SITE_TYPES.map((s) => <option key={s.value} value={s.value}>Only {s.label.toLowerCase()}</option>)}
        </select>
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
        {TERMS.map((t) => (
          <label key={t} className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut" style={{ textTransform: "capitalize" }}>{t}</span>
            <input inputMode="decimal" placeholder="—" value={rates[t] ?? ""}
              onChange={(e) => setRates((p) => ({ ...p, [t]: e.target.value }))}
              style={{ marginTop: 4 }} />
          </label>
        ))}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: 14, cursor: "pointer" }}>
        <input type="checkbox" checked={replaceExisting}
          onChange={(e) => setReplaceExisting(e.target.checked)} />
        Replace rates on lots that already have their own
      </label>
      {replaceExisting && (
        <p className="mut" style={{ fontSize: 13, marginTop: 6 }}>
          This overwrites prices you set lot by lot, and there&apos;s no undo.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button className="ll-btn" onClick={apply} disabled={pending}>Set these rates</button>
        <button className="ll-btn ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
      </div>
    </div>
  );
}


/** Same chip as the park setup interview, so the two forms feel like one
 *  product rather than two people's work. */
function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "7px 13px", borderRadius: 999, fontSize: 13.5, fontWeight: 600, cursor: "pointer",
        border: `2px solid ${on ? "var(--teal)" : "var(--line)"}`,
        background: on ? "var(--teal-wash, #e6f5f4)" : "transparent",
        color: on ? "var(--teal-dark)" : "var(--sub)",
      }}
    >
      {label}
    </button>
  );
}
