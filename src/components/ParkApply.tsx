"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { applyForLot, type ApplyInput } from "@/app/parks/apply-actions";

/**
 * The renter's side: pick a lot, pick dates, tell the park what you're
 * bringing. Sending this creates an APPLICATION — it holds nothing, charges
 * nothing, and commits nobody. The park owner decides, and the copy says so at
 * every step, because "apply" and "book" feel identical until the money shows
 * up on a card.
 */

export interface ApplyLotView {
  id: string;
  lotNumber: string;
  siteType: string;
  maxLengthFt: number | null;
  amperage: number | null;
  openNow: boolean;
  rates: { term: string; amount: number }[];
}

const UNIT_TYPES = [
  { value: "travel_trailer", label: "Travel trailer" },
  { value: "fifth_wheel", label: "Fifth wheel" },
  { value: "motorhome", label: "Motorhome" },
  { value: "rv", label: "Other RV" },
  { value: "park_model", label: "Park model" },
  { value: "mobile_home", label: "Mobile home" },
];

const SITE_LABEL: Record<string, string> = {
  rv_site: "RV site", mh_single: "Single-wide pad", mh_double: "Double-wide pad",
  tent: "Tent site", slip: "Boat slip",
};

const blank = (lotId: string): ApplyInput => ({
  lotId, from: "", to: "", term: "",
  unitType: "travel_trailer", unitLengthFt: "", unitMake: "", unitModel: "", unitYear: "",
});

export function ParkApply({
  parkName,
  approvalRequired,
  lots,
  signedIn,
}: {
  parkName: string;
  approvalRequired: boolean;
  lots: ApplyLotView[];
  signedIn: boolean;
}) {
  const router = useRouter();
  const [openLot, setOpenLot] = useState<string | null>(null);
  const [form, setForm] = useState<ApplyInput>(blank(""));
  const [pending, startTransition] = useTransition();

  function open(lot: ApplyLotView) {
    setForm(blank(lot.id));
    setOpenLot(lot.id);
  }

  function submit() {
    startTransition(async () => {
      const res = await applyForLot(form);
      if (!res.ok) { toast(res.error ?? "Couldn't send that."); return; }
      toast(res.signal ?? "Sent.");
      setOpenLot(null);
      router.refresh();
    });
  }

  if (lots.length === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
        <h3 style={{ fontSize: 17, margin: "0 0 6px" }}>Nothing listed right now</h3>
        <p className="mut" style={{ fontSize: 14, margin: 0 }}>
          {parkName}{" "}hasn&apos;t posted any open sites yet. Check back.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {lots.map((lot) => {
        const priced = lot.rates.filter((r) => r.amount > 0);
        return (
          <div key={lot.id} className="ll-card ll-card-pad">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <strong style={{ fontSize: 15 }}>Site {lot.lotNumber}</strong>
                <span className={`ll-pill ${lot.openNow ? "" : "slate"}`} style={{ marginLeft: 8 }}>
                  {/* Never "taken until the 14th" — that is another renter's business. */}
                  {lot.openNow ? "Open" : "Taken"}
                </span>
                <div className="mut" style={{ fontSize: 13, marginTop: 3 }}>
                  {SITE_LABEL[lot.siteType] ?? lot.siteType}
                  {lot.maxLengthFt && ` · fits up to ${lot.maxLengthFt} ft`}
                  {lot.amperage && ` · ${lot.amperage} amp`}
                </div>
                <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
                  {priced.length === 0
                    ? "Ask the park about rates."
                    : priced.map((r) => `$${r.amount.toLocaleString()}/${r.term.replace("ly", "")}`).join(" · ")}
                </div>
              </div>
              {priced.length > 0 && (
                <button className="ll-btn" onClick={() => (openLot === lot.id ? setOpenLot(null) : open(lot))}>
                  {openLot === lot.id ? "Close" : "Ask about this site"}
                </button>
              )}
            </div>

            {openLot === lot.id && (
              <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                {!signedIn ? (
                  <p className="mut" style={{ fontSize: 14, margin: 0 }}>
                    Sign in first and we&apos;ll send this to {parkName} for you.
                  </p>
                ) : (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                        <span className="mut">Arriving</span>
                        <input type="date" value={form.from}
                          onChange={(e) => setForm({ ...form, from: e.target.value })}
                          style={{ marginTop: 4 }} />
                      </label>
                      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                        <span className="mut">Leaving</span>
                        <input type="date" value={form.to}
                          onChange={(e) => setForm({ ...form, to: e.target.value })}
                          style={{ marginTop: 4 }} />
                      </label>
                      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                        <span className="mut">Renting by the</span>
                        <select value={form.term}
                          onChange={(e) => setForm({ ...form, term: e.target.value })}
                          style={{ marginTop: 4 }}>
                          <option value="">Choose…</option>
                          {priced.map((r) => (
                            <option key={r.term} value={r.term}>
                              {r.term} — ${r.amount.toLocaleString()}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginTop: 12 }}>
                      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                        <span className="mut">What are you bringing?</span>
                        <select value={form.unitType}
                          onChange={(e) => setForm({ ...form, unitType: e.target.value })}
                          style={{ marginTop: 4 }}>
                          {UNIT_TYPES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </select>
                      </label>
                      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                        <span className="mut">Length (ft)</span>
                        <input inputMode="numeric" value={form.unitLengthFt}
                          onChange={(e) => setForm({ ...form, unitLengthFt: e.target.value })}
                          placeholder="34" style={{ marginTop: 4 }} />
                      </label>
                      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                        <span className="mut">Make</span>
                        <input value={form.unitMake}
                          onChange={(e) => setForm({ ...form, unitMake: e.target.value })}
                          placeholder="Jayco" style={{ marginTop: 4 }} />
                      </label>
                      <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                        <span className="mut">Year</span>
                        <input inputMode="numeric" value={form.unitYear}
                          onChange={(e) => setForm({ ...form, unitYear: e.target.value })}
                          placeholder="2019" style={{ marginTop: 4 }} />
                      </label>
                    </div>

                    <p className="mut" style={{ fontSize: 13, marginTop: 12 }}>
                      {approvalRequired
                        ? `${parkName} reviews every request. Nothing is held and nothing is charged until they say yes.`
                        : `This goes straight to ${parkName}. Nothing is charged here.`}
                    </p>

                    <button className="ll-btn" onClick={submit} disabled={pending} style={{ marginTop: 10 }}>
                      Send to {parkName}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
