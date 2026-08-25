"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { saveFee, setFeeActive, type FeesPage } from "@/app/park/fee-actions";
import {
  COVER_LABEL, CADENCE_LABEL, APPLIES_LABEL, coverageSummary,
  FEE_COVERS, FEE_EXTRA_COVERS,
  type FeeCadence, type FeeAppliesTo,
} from "@/app/park/fee-helpers";

/**
 * FEES, AND WHETHER THEY COVER WHAT THEY CLAIM TO.
 *
 * The grounds fee is the one that matters: a single flat charge — an averaged
 * prorated share — covering water, sewer, trash, park lighting and
 * maintenance. The resident pays a number they can predict.
 *
 * Their own electricity is not in it: the utility meters each lot and bills
 * them directly, so it never passes through the park at all.
 *
 * Which leaves one question, and it sits at the top of this screen because it
 * is the only one worth asking: IS IT SET RIGHT? A park charging $50 against
 * $71 of real cost is losing $5,000 a year on twenty lots and will not notice
 * for a year unless something puts the two numbers side by side.
 */

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ALL_COVERS = [...FEE_COVERS, ...FEE_EXTRA_COVERS];
/**
 * ONLY WHAT THE BILLER WILL ACTUALLY BILL.
 *
 * The form offered four cadences and four audiences; the charge run honours
 * one of each. `buildStatement` skips every non-monthly cadence, and `feesFor`
 * keeps only `all_lots` and `long_term` — so a fee saved as annual, per-stay,
 * one-off, short-term or opt-in appeared in the list, was counted as income on
 * the coverage panel, and was never charged to anybody.
 *
 * A setting the software cannot honour is worse than no setting: he chooses it
 * in December, sets his rent against the number it shows him, and finds out in
 * March. The schema still allows all of them — this only stops the form
 * offering what nothing downstream can deliver, and these lines come back the
 * day a biller does.
 */
const CADENCES: FeeCadence[] = ["monthly"];
const APPLIES: FeeAppliesTo[] = ["long_term", "all_lots"];

export function ParkFees({ parkId, page }: { parkId: string; page: FeesPage }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  /**
   * WHICH FEE IS BEING CHANGED, or null when adding a new one.
   *
   * `saveFee` has always taken an optional `id` and branched to an UPDATE on
   * it — and nothing in the app ever passed one, so that branch was dead and a
   * fee could not be corrected at all. The only way to fix a wrong amount was
   * to add the fee again, which (with no uniqueness on the label) charged the
   * resident twice on two identically named lines.
   */
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("Grounds fee");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<FeeCadence>("monthly");
  const [appliesTo, setAppliesTo] = useState<FeeAppliesTo>("long_term");
  /**
   * NOTHING IS TICKED UNTIL HE TICKS IT.
   *
   * These five arrived pre-ticked, and a tick here is not a label — it is a
   * money decision. `recordCost` reads the ticked categories and absorbs EVERY
   * future bill in one of them entirely into `park_absorbed`, marked
   * `fee_covered`, never splitting it across the lots again. So a box he never
   * looked at silently converts his water and sewer bills into a permanent
   * park expense he is no longer recovering.
   *
   * A default is a claim about what is true on day one, and on day one nobody
   * has decided what this fee covers.
   */
  const [covers, setCovers] = useState<Set<string>>(new Set());

  function save() {
    start(async () => {
      const res = await saveFee(parkId, {
        id: editing ?? undefined,
        label,
        amount: Number(amount.replace(/[$,\s]/g, "")),
        cadence,
        appliesTo,
        covers: [...covers],
      });
      if (!res.ok) { toast(res.error ?? "Couldn't save."); return; }
      toast(res.signal ?? "Saved.");
      setOpen(false); setAmount(""); setEditing(null);
      router.refresh();
    });
  }

  const c = page.coverage;
  const short = c.margin < 0 && c.actualCost > 0;

  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Fees</h2>
      <p className="mut" style={{ margin: "0 0 14px", lineHeight: 1.5, maxWidth: 640 }}>
        A flat charge on top of rent. Most parks run one grounds fee covering
        water, sewer, trash, park lighting and maintenance — the resident pays a
        number they can predict.
      </p>
      <p className="mut" style={{ margin: "0 0 14px", lineHeight: 1.5, maxWidth: 640, fontSize: 13 }}>
        A resident&apos;s own electricity isn&apos;t in here. The electric company
        meters each lot and bills them directly, so it never passes through you —
        the only power you pay for is on homes you own.
      </p>

      {/* WHO THIS WILL NOT REACH, said before he types an amount.
          A fee is never charged to a tenancy the park INHERITED — they signed
          nothing with him and there is no way to serve notice yet. Without
          this sentence the only symptom is a payer count quietly lower than
          his household count, which reads as a fault rather than a rule. */}
      {page.inheritedTenancies > 0 && (
        <p className="mut" style={{ margin: "0 0 14px", lineHeight: 1.5, maxWidth: 640, fontSize: 13 }}>
          This won&apos;t be charged to the {page.inheritedTenancies}{" "}
          {page.inheritedTenancies === 1 ? "household you inherited" : "households you inherited"} —
          they agreed to their rent with the previous owner, not to a fee with
          you. It starts for each of them when they sign a new agreement.
        </p>
      )}

      {/* ---- IS IT SET RIGHT. The only question worth asking. ------------- */}
      {page.fees.length > 0 && (
        <div className="ll-card ll-card-pad"
          style={{ marginBottom: 14, background: short ? "rgba(200,60,40,.07)" : undefined }}>
          <strong style={{ fontSize: 15 }}>{coverageSummary(c, page.coveragePayers, page.fees.length)}</strong>
          {page.monthsObserved > 1 && (
            <div className="mut" style={{ fontSize: 13, marginTop: 6 }}>
              Averaged over {page.monthsObserved} months of bills.
            </div>
          )}
          {c.uncovered.length > 0 && (
            <div className="mut" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
              You pay for {c.uncovered.map((x) => COVER_LABEL[x] ?? x).join(", ")} and no
              fee covers it — deliberate, or a gap?
            </div>
          )}
          {c.unverified.length > 0 && (
            <div className="mut" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
              Your fee covers {c.unverified.map((x) => COVER_LABEL[x] ?? x).join(", ")} but
              you haven&apos;t entered a bill for it, so that part isn&apos;t checked.
            </div>
          )}
        </div>
      )}

      {page.fees.length > 0 && (
        <div className="ll-card" style={{ marginBottom: 14 }}>
          {page.fees.map((f) => (
            <div key={f.id}
              style={{ padding: "10px 14px", borderTop: "1px solid rgba(0,0,0,.06)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline", opacity: f.active ? 1 : 0.55 }}>
              <strong style={{ minWidth: 150 }}>{f.label}</strong>
              <span style={{ minWidth: 130 }}>
                {money(f.amount)} {CADENCE_LABEL[f.cadence]}
              </span>
              <span className="mut" style={{ flex: 1 }}>
                {APPLIES_LABEL[f.appliesTo]} ·{" "}
                {/* "0 paying" is true and reads as a fault. Until the roll is
                    named there is nobody to bill, which is a different thing. */}
                {f.payers === 0 ? "nobody on a lot yet" : `${f.payers} paying`}
                {f.covers.length > 0 && ` · covers ${f.covers.map((x) => COVER_LABEL[x] ?? x).join(", ")}`}
              </span>
              <span style={{ minWidth: 90, textAlign: "right", fontWeight: 700 }}>
                {money(f.monthly)}/mo
              </span>
              <button className="ll-btn ghost" disabled={busy}
                onClick={() => {
                  // Pre-filled from the row, so correcting an amount is one tap
                  // and cannot become a second fee with the same name.
                  setEditing(f.id);
                  setLabel(f.label);
                  setAmount(String(f.amount));
                  setCadence(f.cadence);
                  setAppliesTo(f.appliesTo);
                  setCovers(new Set(f.covers));
                  setOpen(true);
                }}>
                Edit
              </button>
              <button className="ll-btn ghost" disabled={busy}
                onClick={() =>
                  start(async () => {
                    const res = await setFeeActive(parkId, f.id, !f.active);
                    toast(res.ok ? (res.signal ?? "Done.") : (res.error ?? "Couldn't do that."));
                    router.refresh();
                  })
                }>
                {f.active ? "Switch off" : "Switch on"}
              </button>
            </div>
          ))}
        </div>
      )}

      {!open ? (
        <button className="ll-btn ghost" onClick={() => {
          // A fresh add must never inherit the fee last edited.
          setEditing(null); setLabel("Grounds fee"); setAmount("");
          setCadence("monthly"); setAppliesTo("long_term"); setCovers(new Set());
          setOpen(true);
        }}>Add a fee</button>
      ) : (
        <div className="ll-card ll-card-pad">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">What residents see it called</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Amount</span>
              <input value={amount} inputMode="decimal" placeholder="55"
                onChange={(e) => setAmount(e.target.value)} style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">How often</span>
              <select value={cadence} onChange={(e) => setCadence(e.target.value as FeeCadence)} style={{ marginTop: 4 }}>
                {CADENCES.map((x) => <option key={x} value={x}>{CADENCE_LABEL[x]}</option>)}
              </select>
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Who pays it</span>
              <select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as FeeAppliesTo)} style={{ marginTop: 4 }}>
                {APPLIES.map((x) => <option key={x} value={x}>{APPLIES_LABEL[x]}</option>)}
              </select>
            </label>
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="mut" style={{ fontSize: 13, marginBottom: 6 }}>
              What it covers — this is what you tell residents, and what we check
              your bills against
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {ALL_COVERS.map((x) => (
                <label key={x} className="ll-chip"
                  style={{ cursor: "pointer", opacity: covers.has(x) ? 1 : 0.5 }}>
                  <input type="checkbox" checked={covers.has(x)} style={{ marginRight: 6 }}
                    onChange={() => setCovers((prev) => {
                      const n = new Set(prev);
                      if (n.has(x)) n.delete(x); else n.add(x);
                      return n;
                    })} />
                  {COVER_LABEL[x] ?? x}
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            {/* `!amount` blocked an empty box and let the string "0" through,
                which saved a fee that puts a $0.00 line on every bill. */}
            <button className="ll-btn" onClick={save}
              disabled={busy || !(Number(amount.replace(/[$,\s]/g, "")) > 0)}>
              {busy ? "Saving…" : editing ? "Save the change" : "Save the fee"}
            </button>
            <button className="ll-btn ghost" onClick={() => { setOpen(false); setEditing(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
