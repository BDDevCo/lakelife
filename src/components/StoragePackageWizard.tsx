"use client";

/**
 * Storage-package wizard — the customer picks one of the three winter
 * storage/winterization packages (tow-it-in, we-haul-it, storage-only),
 * configures the components for THIS fall / next spring, and books it.
 *
 * Selection wire format: a component can appear in BOTH phases with the
 * SAME serviceId (e.g. "Boat return & splash" is one fall leg AND one
 * spring leg on the we_haul package), so a plain serviceId can't tell the
 * two rows apart. We track selection as `${serviceId}|${phase}` composite
 * keys — validateSelection documents this as its canonical key format
 * (bare serviceIds are only a legacy fallback that select every phase a
 * service appears in). This lets "book the fall return, skip storage" and
 * "store it, skip the fall return" be selected independently, which the
 * we_haul recipe requires. Every number on screen — including the "from"
 * price on a closed tile — comes straight out of validateSelection; this
 * component never computes or guesses a price itself.
 */

import { useMemo, useState } from "react";
import { validateSelection, type PackageView, type PackageComponentView } from "@/lib/packages";
import { createPackageBooking } from "@/app/book/storage/actions";
import { formatPrice } from "@/lib/pricing";
import { toast } from "@/components/Toast";
import { Toggle } from "@/components/wizard-controls";
import { TosAgreeModal } from "@/components/TosAgreeModal";

const ckey = (c: Pick<PackageComponentView, "serviceId" | "phase">) => `${c.serviceId}|${c.phase}`;

function defaultKeys(pkg: PackageView): string[] {
  return pkg.components.filter((c) => c.required || c.defaultOn).map(ckey);
}

function lakeTomorrowISO(): string {
  // The server rejects lake-today ("planned, not same-day") — floor the picker
  // at tomorrow IN LAKE TIME so a late-night booking can't pick a date the
  // action will refuse.
  const lakeNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Indiana/Indianapolis" }));
  lakeNow.setDate(lakeNow.getDate() + 1);
  const y = lakeNow.getFullYear(), mo = String(lakeNow.getMonth() + 1).padStart(2, "0"), d = String(lakeNow.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

export function StoragePackageWizard({ packages, boatLabel }: { packages: PackageView[]; boatLabel: string }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {packages.map((pkg) => (
        <PackageTile
          key={pkg.id}
          pkg={pkg}
          boatLabel={boatLabel}
          open={openId === pkg.id}
          onToggle={() => setOpenId((id) => (id === pkg.id ? null : pkg.id))}
        />
      ))}
      {packages.length === 0 && (
        <div className="ll-card ll-card-pad mut">No storage packages available yet — check back soon.</div>
      )}
    </div>
  );
}

function PackageTile({
  pkg,
  boatLabel,
  open,
  onToggle,
}: {
  pkg: PackageView;
  boatLabel: string;
  open: boolean;
  onToggle: () => void;
}) {
  const fromPrice = useMemo(() => validateSelection(pkg, defaultKeys(pkg)).total, [pkg]);

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 17, margin: "0 0 4px" }}>{pkg.name}</h3>
          {pkg.description && (
            <p className="mut" style={{ fontSize: 13.5, margin: 0, maxWidth: 460, lineHeight: 1.5 }}>
              {pkg.description}
            </p>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div className="mut" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            From
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 20, color: "var(--ink)" }}>
            {formatPrice(fromPrice)}
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`ll-btn ${open ? "ghost" : ""} sm`}
        style={{ width: "100%", marginTop: 14 }}
        onClick={onToggle}
      >
        {open ? "Close" : "Configure this package"}
      </button>

      {open && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <PackageConfigurator pkg={pkg} boatLabel={boatLabel} />
        </div>
      )}
    </div>
  );
}

function PackageConfigurator({ pkg, boatLabel }: { pkg: PackageView; boatLabel: string }) {
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => defaultKeys(pkg));
  const [fallDate, setFallDate] = useState("");
  const [agreement, setAgreement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{ findingCrew: boolean } | null>(null);
  const [tosOpen, setTosOpen] = useState(false);

  const validation = useMemo(() => validateSelection(pkg, selectedKeys), [pkg, selectedKeys]);

  const allTiers = useMemo(() => pkg.components.filter((c) => c.isStorageTier), [pkg]);
  const allowNoStorage = pkg.code !== "storage_only";
  const fallItems = useMemo(() => pkg.components.filter((c) => c.phase === "fall" && !c.isStorageTier), [pkg]);
  const springItems = useMemo(() => pkg.components.filter((c) => c.phase === "spring" && !c.isStorageTier), [pkg]);

  function toggleRow(c: PackageComponentView) {
    const k = ckey(c);
    setSelectedKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  }

  function pickTier(c: PackageComponentView | null) {
    const tierKeys = new Set(allTiers.map(ckey));
    setSelectedKeys((ks) => {
      const withoutTiers = ks.filter((k) => !tierKeys.has(k));
      return c ? [...withoutTiers, ckey(c)] : withoutTiers;
    });
  }

  const hasStorage = validation.storageTierId != null;
  const canBook = validation.ok && fallDate !== "" && (!hasStorage || agreement);

  async function book(tosAccepted?: boolean) {
    if (!canBook) return;
    setBusy(true);
    setSubmitError(null);
    const res = await createPackageBooking({
      packageId: pkg.id,
      selectedServiceIds: selectedKeys,
      fallDate,
      agreementAccepted: agreement,
      tosAccepted,
    });
    setBusy(false);
    if (res.needsTos) { setTosOpen(true); return; }
    if (!res.ok) {
      const msg = res.error ?? "Couldn't book that — try again.";
      setSubmitError(msg);
      toast(msg);
      return;
    }
    setTosOpen(false);
    setResult({ findingCrew: !!res.findingCrew });
  }

  if (result?.findingCrew) {
    return (
      <div
        style={{
          border: "1.5px solid var(--gold, #d9a441)", borderRadius: 12, padding: "14px 16px",
          fontSize: 13.5, lineHeight: 1.5,
        }}
      >
        <b>New water for us 🌊</b> — we&apos;re finding your crew, you pay nothing until it&apos;s done. We&apos;ll text you the moment it&apos;s locked in.
      </div>
    );
  }
  if (result) {
    return (
      <div style={{ background: "#F2F9FA", borderRadius: 12, padding: "14px 16px" }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: "var(--teal-dark)" }}>Booked — watch for a text 🌊</div>
        <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.5 }}>
          We&apos;ll be in touch with your crew details before the fall visit.
        </p>
      </div>
    );
  }

  return (
    <div>
      {boatLabel && (
        <div className="mut" style={{ fontSize: 12.5, marginBottom: 14 }}>
          For your <span style={{ color: "var(--text)", fontWeight: 700 }}>{boatLabel}</span>
        </div>
      )}

      <SectionHeading first>This fall</SectionHeading>
      {fallItems.map((c) => (
        <ComponentRow key={ckey(c)} c={c} selected={selectedKeys.includes(ckey(c))} onToggle={() => toggleRow(c)} />
      ))}
      {fallItems.length === 0 && <p className="mut" style={{ fontSize: 13 }}>Nothing scheduled this fall.</p>}

      {allTiers.length > 0 && (
        <>
          <SectionHeading>Storage</SectionHeading>
          <div role="radiogroup" aria-label="Storage option" style={{ display: "grid", gap: 8 }}>
            {allTiers.map((t) => (
              <RadioRow
                key={ckey(t)}
                label={`${t.name} — ${formatPrice(t.price)}`}
                checked={validation.storageTierId === t.serviceId}
                onSelect={() => pickTier(t)}
              />
            ))}
            {allowNoStorage && (
              <RadioRow
                label="No storage — take it home"
                checked={!hasStorage}
                onSelect={() => pickTier(null)}
              />
            )}
          </div>
        </>
      )}

      <SectionHeading>Next spring</SectionHeading>
      {springItems.map((c) => (
        <ComponentRow key={ckey(c)} c={c} selected={selectedKeys.includes(ckey(c))} onToggle={() => toggleRow(c)} />
      ))}
      {springItems.length === 0 && <p className="mut" style={{ fontSize: 13 }}>Nothing scheduled next spring.</p>}

      <div style={{ marginTop: 16, padding: "12px 14px", background: "#F2F9FA", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
          <span>This fall</span>
          <b>{formatPrice(validation.fallTotal)}</b>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, marginTop: 4 }}>
          <span>Next spring</span>
          <b>{formatPrice(validation.springTotal)}</b>
        </div>
        <p className="mut" style={{ fontSize: 11.5, margin: "2px 0 8px" }}>
          Spring line is quoted now, billed at splash.
        </p>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          <b>All-in</b>
          <b>{formatPrice(validation.total)}</b>
        </div>
        {hasStorage && (
          <p className="mut" style={{ fontSize: 11.5, margin: "8px 0 0", lineHeight: 1.5 }}>
            Season runs through May 31 — after that it&apos;s a small per-day charge until pickup.
          </p>
        )}
      </div>

      {!validation.ok && validation.error && (
        <div
          style={{
            marginTop: 10, padding: "9px 12px", borderRadius: 10,
            background: "#f6e5e1", color: "var(--danger)", fontSize: 13, fontWeight: 600,
          }}
        >
          {validation.error}
        </div>
      )}

      <div className="ll-field" style={{ marginTop: 16 }}>
        <label htmlFor={`fall-date-${pkg.id}`}>Fall visit date</label>
        <input
          id={`fall-date-${pkg.id}`}
          type="date"
          min={lakeTomorrowISO()}
          required
          value={fallDate}
          onChange={(e) => setFallDate(e.target.value)}
        />
      </div>

      {hasStorage && (
        <div style={{ margin: "4px 0 8px" }}>
          <Toggle
            label="I agree to the winter storage terms — condition photos at every hand-off, balance due before spring splash. Storage is performed by your crew under the LakeLife terms of service."
            checked={agreement}
            onChange={setAgreement}
          />
        </div>
      )}

      {submitError && (
        <p style={{ color: "var(--danger)", fontSize: 13, fontWeight: 600, margin: "8px 0 0" }}>{submitError}</p>
      )}

      <button className="ll-btn gold" style={{ width: "100%", marginTop: 14 }} disabled={!canBook || busy} onClick={() => book()}>
        {busy ? "Booking…" : `Book — ${formatPrice(validation.total)}`}
      </button>

      <TosAgreeModal
        open={tosOpen}
        busy={busy}
        onAgree={() => book(true)}
        onClose={() => setTosOpen(false)}
      />
    </div>
  );
}

function ComponentRow({ c, selected, onToggle }: { c: PackageComponentView; selected: boolean; onToggle: () => void }) {
  if (c.required) return <LockedRow c={c} />;
  const suffix = c.kind === "addon" ? " · add-on" : "";
  return <Toggle label={`${c.name} — ${formatPrice(c.price)}${suffix}`} checked={selected} onChange={onToggle} />;
}

function LockedRow({ c }: { c: PackageComponentView }) {
  return (
    <div
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "11px 13px", borderRadius: 12, marginBottom: 8,
        border: "1.5px solid var(--line)", background: "#f7fafb",
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</span>
      <b style={{ fontSize: 14 }}>{formatPrice(c.price)}</b>
    </div>
  );
}

function RadioRow({ label, checked, onSelect }: { label: string; checked: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
        padding: "11px 13px", borderRadius: 12, cursor: "pointer",
        border: `1.5px solid ${checked ? "var(--teal)" : "var(--line)"}`,
        background: checked ? "#F2F9FA" : "#fff", fontSize: 14, fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
          border: `1.5px solid ${checked ? "var(--teal)" : "#c4d2d6"}`,
          background: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {checked && <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--teal)" }} />}
      </span>
      {label}
    </button>
  );
}

function SectionHeading({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div
      style={{
        fontSize: 12, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase",
        color: "var(--teal-dark)", margin: first ? "0 0 8px" : "16px 0 8px",
      }}
    >
      {children}
    </div>
  );
}
