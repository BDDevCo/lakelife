"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { confirmMySetup, declineMySetup } from "@/app/vendor/setup-actions";
import type { PendingSetup } from "@/app/vendor/setup-data";
import { initialRateValues, payloadFromValues } from "@/app/vendor/rates-helpers";
import { prettyPhone } from "@/lib/phone";
import {
  ONLY_THE_CREW_CAN,
  WORK_DAYS_IN_READING_ORDER,
  MAX_DAILY_CAPACITY,
  MIN_DAILY_CAPACITY,
} from "@/lib/crew-setup";

/**
 * "HERE'S WHAT WE TOOK DOWN ON THE PHONE. CHECK IT."
 *
 * The crew's half of the setup ops typed (0181). Every box on this card is
 * editable and NONE of it is live: `confirmMySetup` is what writes `vendors`
 * and `vendor_rates`, and it runs only when they tap.
 *
 * ============ WHY THE ATTRIBUTION IS THE FIRST LINE ON THE CARD ============
 *
 * An unattributed pre-fill is indistinguishable from a default, and a default
 * that asserts a fact is the shape that wrote nineteen leases in this product
 * that nobody had signed. Naming the person and the call turns every number
 * below from a setting the system arrived at into somebody's notes, which is
 * exactly what they are — and which is what makes reading them properly feel
 * like the point rather than a formality.
 *
 * ============ AND WHY THE FOUR THINGS ARE LISTED, NOT HIDDEN ============
 *
 * Bank, terms, insurance and their own mobile are not on this card and never
 * will be. Saying so — in the same breath as the things that WERE filled in —
 * is what stops "your setup is ready" reading as "you're done". A crew who
 * confirms this card and walks away is still not live, and the card says which
 * four doors are still shut rather than letting them find out from silence.
 */
export function CrewSetupConfirm({
  setup,
  lakes,
}: {
  setup: PendingSetup;
  lakes: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [lakeIds, setLakeIds] = useState<string[]>(setup.lakeIds);
  const [days, setDays] = useState<string[]>(setup.workDays);
  const [cap, setCap] = useState<string>(
    setup.dailyCapacity != null ? String(setup.dailyCapacity) : "",
  );
  const [rateValues, setRateValues] = useState<Record<string, Record<string, string>>>(() => {
    const out: Record<string, Record<string, string>> = {};
    for (const r of setup.rates) out[r.serviceId] = initialRateValues(r.form.fields);
    return out;
  });
  const [problems, setProblems] = useState<string[]>([]);

  function toggleLake(id: string) {
    setLakeIds((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  }
  function toggleDay(d: string) {
    setDays((v) => (v.includes(d) ? v.filter((x) => x !== d) : [...v, d]));
  }
  function setRate(serviceId: string, key: string, value: string) {
    setRateValues((prev) => ({ ...prev, [serviceId]: { ...prev[serviceId], [key]: value } }));
  }

  function confirm() {
    setProblems([]);
    startTransition(async () => {
      const res = await confirmMySetup({
        proposalId: setup.id,
        lakeIds,
        workDays: days,
        dailyCapacity: cap,
        // SAME SPLIT AS THE CREW'S OWN RATES SCREEN, from the same helper —
        // base / unit / band-by-key. A third hand-written copy of it is how a
        // band price gets saved as a base, which is not an error anywhere. It
        // is simply a different, wrong price, saved and confirmed.
        rates: setup.rates.map((r) => ({
          serviceId: r.serviceId,
          payload: payloadFromValues(r.form.fields, rateValues[r.serviceId] ?? {}),
        })),
      });
      if (!res.ok) {
        // A PARTIAL SAVE IS NOT A FAILURE AND MUST NOT READ AS ONE. The lines
        // that did not take are listed under the card and the card stays open
        // holding everything else, so a second tap finishes the job rather than
        // starting it again.
        setProblems(res.partial ?? []);
        toast.err(res.error ?? "Couldn't save that just yet.");
        router.refresh();
        return;
      }
      toast("That's yours now. 🌊");
      router.refresh();
    });
  }

  function decline() {
    startTransition(async () => {
      const res = await declineMySetup(setup.id);
      if (!res.ok) return toast.err(res.error ?? "Couldn't put that away.");
      toast("No problem — fill it in however you like.");
      router.refresh();
    });
  }

  const nothingPicked = lakeIds.length === 0 && days.length === 0 && !cap.trim();

  return (
    <div className="ll-card ll-card-pad" style={{ borderLeft: "4px solid var(--teal)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span className="ll-pill teal">Check this over</span>
      </div>
      <h3 style={{ fontSize: 18, margin: "0 0 4px" }}>{setup.attribution}</h3>
      <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
        Nothing here counts until you say so — no job is offered to you, and no price is
        shown to anybody, before you confirm. Change whatever isn&apos;t right.
      </p>

      {setup.note && (
        <p
          className="mut"
          style={{
            fontSize: 14, fontStyle: "italic", background: "var(--slate-soft)",
            padding: "10px 12px", borderRadius: 8, marginBottom: 14,
          }}
        >
          &ldquo;{setup.note}&rdquo;
        </p>
      )}

      {setup.phoneE164 && (
        /* SHOWN, NEVER SAVED FROM HERE. A number somebody else typed is not a
           number this crew has given us and verified, and `users.phone_verified`
           means both. It pre-fills the verify box and nothing may send to it
           until they hold the handset and prove it. */
        <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
          We have <b>{prettyPhone(setup.phoneE164)}</b> for you. You&apos;ll confirm it&apos;s
          yours when you verify your mobile — we can&apos;t text it until you do.
        </p>
      )}

      {lakes.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 6 }}>
            The water you work
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {lakes.map((l) => {
              const on = lakeIds.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => toggleLake(l.id)}
                  className={`ll-pill ${on ? "teal" : "slate"}`}
                  style={{ cursor: "pointer", border: "none", padding: "8px 12px", fontSize: 13 }}
                  aria-pressed={on}
                >
                  {on ? "✓ " : ""}{l.name}
                </button>
              );
            })}
          </div>
          {/* THE ONE CONSEQUENCE THAT IS OTHERWISE INVISIBLE. An unticked lake
              is not a smaller list — it is silence: the router never offers
              that work and nothing on any screen says why. */}
          <p className="mut" style={{ fontSize: 12, marginTop: 6 }}>
            A lake you leave off is one you never hear about — including the mobile-home
            and RV parks that sit on it.
          </p>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 6 }}>
          The days you work
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {WORK_DAYS_IN_READING_ORDER.map((d) => {
            const on = days.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={`ll-pill ${on ? "teal" : "slate"}`}
                style={{ cursor: "pointer", border: "none", padding: "8px 12px", fontSize: 13 }}
                aria-pressed={on}
              >
                {on ? "✓ " : ""}{d}
              </button>
            );
          })}
        </div>
      </div>

      <div className="ll-field" style={{ marginBottom: 14, maxWidth: 260 }}>
        <label>How many jobs a day you can take</label>
        <input
          type="number"
          inputMode="numeric"
          min={MIN_DAILY_CAPACITY}
          max={MAX_DAILY_CAPACITY}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          placeholder={`${MIN_DAILY_CAPACITY}–${MAX_DAILY_CAPACITY}`}
        />
      </div>

      {setup.rates.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 2 }}>
            What you charge
          </label>
          {/* THE SENTENCE THAT KEEPS THIS HONEST. LakeLife sets no price — the
              owner's line all week — so a number here is what the crew said on
              the phone, being read back. It is theirs to change and there is no
              record anywhere of what was typed versus what they set. */}
          <p className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
            These are your numbers as we took them down. They&apos;re yours to change —
            we never set a crew&apos;s prices.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            {setup.rates.map((r) => (
              <div key={r.serviceId} style={{ background: "var(--slate-soft)", padding: 12, borderRadius: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{r.name}</div>
                {r.form.feeNote && (
                  <p className="mut" style={{ fontSize: 12, marginBottom: 8 }}>{r.form.feeNote}</p>
                )}
                {/* Same honest gap as the ops form: a service whose pricing
                    shape carries no bands or tiers draws no boxes, and a
                    heading on its own reads as a price we are holding and will
                    not show them. */}
                {r.form.fields.length === 0 ? (
                  <p className="mut" style={{ fontSize: 12 }}>
                    Set this one on your Rates screen — we can&apos;t show it here.
                  </p>
                ) : (
                <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
                  {r.form.fields.map((f) => (
                    <div className="ll-field" key={f.key}>
                      <label>{f.label}</label>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        value={rateValues[r.serviceId]?.[f.key] ?? ""}
                        onChange={(e) => setRate(r.serviceId, f.key, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {problems.length > 0 && (
        <div className="ll-notice" style={{ marginBottom: 14 }}>
          <b>Saved what we could. Still to sort:</b>
          <ul style={{ margin: "6px 0 0 18px", fontSize: 14 }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      {/* NOT A FOOTNOTE. A crew who confirms this card is still not live, and
          the four doors below are the only reason. Saying it here, beside the
          button, is what stops "your setup is ready" being read as "you're
          done" — the steps underneath this card say the same thing, and a crew
          who taps confirm and closes the tab never scrolls to them. */}
      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginBottom: 14 }}>
        <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
          Four things only you can do — they&apos;re not on this card and we can&apos;t do
          them for you:
        </p>
        <ul className="mut" style={{ fontSize: 13, margin: "0 0 0 18px" }}>
          {ONLY_THE_CREW_CAN.map((t) => <li key={t}>{t}</li>)}
          <li>Verify your mobile from your own handset</li>
        </ul>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <button className="ll-btn gold" onClick={confirm} disabled={pending || nothingPicked}>
          {pending ? "Saving…" : "Yes, that's right"}
        </button>
        <button
          className="ll-btn ghost"
          onClick={decline}
          disabled={pending}
          style={{ fontSize: 14 }}
        >
          I&apos;ll fill it in myself
        </button>
      </div>
      {nothingPicked && (
        <p className="mut" style={{ fontSize: 12, marginTop: 8 }}>
          Pick at least one lake, one day or a number of jobs before confirming — or
          fill it in yourself below.
        </p>
      )}
    </div>
  );
}
