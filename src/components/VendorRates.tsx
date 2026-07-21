"use client";

/**
 * "Your rates" — a crew sets their PRIVATE per-service take-home rate in their
 * own units. One card per service, inputs shaped to the service's pricing model.
 *
 * CLAUDE.md rule 1 is the whole point of this screen: there is NO customer price,
 * NO menu anchor, NO margin, and NO "70% of X" anywhere. A crew types the number
 * THEY want to take home; whether that wins a job is decided later by dispatch.
 * Big tap targets for wet gloves.
 */

import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { setMyRate } from "@/app/vendor/rates-actions";
import type { MyRate } from "@/app/vendor/rates-data";
import type { RateField, RatePayload } from "@/app/vendor/rates-helpers";

export function VendorRates({ rates }: { rates: MyRate[] }) {
  if (rates.length === 0) {
    return (
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 560 }}>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Your rates</h1>
        <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
          <p style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>
            No work types yet.
          </p>
          <p className="mut" style={{ fontSize: 14, margin: 0 }}>
            Pick the kinds of work your crew does on the Today tab first — then set a
            rate here. No rate, no routing.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 620 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Your rates</h1>
      <p className="mut" style={{ fontSize: 14, marginBottom: 6, maxWidth: 540 }}>
        Set your take-home for each kind of work — in your own units. This is your
        private number; LakeLife adds its own on top.
      </p>
      <p style={{ fontSize: 13, fontWeight: 700, color: "var(--warn)", marginBottom: 18 }}>
        Set a rate to be matched to jobs — no rate, no routing.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        {rates.map((r) => (
          <RateCard key={r.service_id} rate={r} />
        ))}
      </div>
    </div>
  );
}

function initialValues(fields: RateField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.key] = f.value != null ? String(f.value) : "";
  return out;
}

function RateCard({ rate }: { rate: MyRate }) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(rate.form.fields));
  const [saved, setSaved] = useState(rate.hasRate);
  const [pending, startTransition] = useTransition();

  function set(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    setSaved(false);
  }

  function save() {
    // Build the payload the action expects: base / unitRate / band-by-key.
    const band: Record<string, string> = {};
    let base: string | undefined;
    let unitRate: string | undefined;
    for (const f of rate.form.fields) {
      const v = values[f.key] ?? "";
      if (f.kind === "base") base = v;
      else if (f.kind === "unit") unitRate = v;
      else band[f.key] = v; // "band" | "tier"
    }
    const payload: RatePayload = { base, unitRate, band };

    startTransition(async () => {
      const res = await setMyRate(rate.service_id, payload);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save that rate.");
        return;
      }
      setSaved(true);
      toast(res.signal ?? "Saved.");
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>{rate.name}</h3>
        {saved ? (
          <span className="ll-pill ok">Rate set ✓</span>
        ) : (
          <span className="ll-pill slate">No rate yet</span>
        )}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {rate.form.fields.map((f) => (
          <label key={f.key} className="ll-field" style={{ display: "block" }}>
            <span className="mut" style={{ fontSize: 13 }}>{f.label}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <span aria-hidden style={{ fontSize: 17, fontWeight: 800, color: "var(--sub)" }}>$</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="1"
                value={values[f.key] ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder="0"
                style={{ flex: 1, fontSize: 16, minHeight: 48, width: "100%" }}
              />
            </div>
          </label>
        ))}
      </div>

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 14, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : saved ? "Saved ✓ — tap to update" : "Save rate"}
      </button>
    </div>
  );
}
