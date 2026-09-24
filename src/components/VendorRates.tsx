"use client";

/**
 * "Your rates" — a crew sets their PRIVATE per-service rate in their own units.
 * One card per service, inputs shaped to the service's pricing model.
 *
 * WHAT THE NUMBER MEANS DEPENDS ON THE SERVICE, and that is new (0174).
 *  - Ordinary (menu-priced) service: the number IS the take-home. A crew types
 *    $100 and $100 lands. That is every service today.
 *  - crew_priced service: the number is their QUOTE. LakeLife adds a published
 *    percentage for the customer and takes a published percentage out of the
 *    quote, so $100 typed is $88 paid. Same column, same screen, opposite
 *    meaning — so on those cards the label says "quote", the standing rule is
 *    printed above the inputs, and every saved number carries a sentence naming
 *    BOTH figures. All of that arrives already computed on the RateForm
 *    (rates-helpers.ts); this component only decides where it sits.
 *
 * CLAUDE.md rule 1 still holds here in the half that survives a published
 * percentage: there is NO customer price, NO menu anchor and NO margin on this
 * screen. A crew's own quote and their own payout are their numbers.
 * Big tap targets for wet gloves.
 */

import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { setMyRate } from "@/app/vendor/rates-actions";
import type { MyRate } from "@/app/vendor/rates-data";
import { initialRateValues, payloadFromValues, type RatePayload } from "@/app/vendor/rates-helpers";

export function VendorRates({ rates, notLiveYet = false }: { rates: MyRate[]; notLiveYet?: boolean }) {
  if (rates.length === 0) {
    return (
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 560 }}>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Your rates</h1>
        <div className="ll-card ll-card-pad" style={{ marginTop: 12, textAlign: "center" }}>
          <p className="mut" style={{ fontSize: 14, margin: 0 }}>
            No work types yet — pick the kinds of work your crew does on the Today
            tab first, then set a rate here. No rate, no routing.
          </p>
        </div>
      </div>
    );
  }

  const anyCrewPriced = rates.some((r) => r.form.crewPriced);
  const standard = rates.filter((r) => r.kind === "standalone");
  const legs = rates.filter((r) => r.kind !== "standalone");

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 620 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Your rates</h1>
      {/* "Your take-home" IS the number on every menu-priced service, and is
          FALSE on a crew-priced one — there the number is the quote and the
          payout is smaller. Copy that lies is this codebase's most expensive
          bug class, so the sentence follows the rates actually on this page.
          anyCrewPriced is false for every crew today, so this reads exactly as
          it always has. */}
      <p className="mut" style={{ fontSize: 14, marginBottom: 6, maxWidth: 540 }}>
        {anyCrewPriced
          ? "Set your rate for each kind of work — in your own units. On the services you price yourself, what you type is your quote and the card says what it pays you; on the rest it's your take-home. Either way it's your private number."
          : "Set your take-home for each kind of work — in your own units. This is your private number; LakeLife adds its own on top."}
      </p>
      {/* NECESSARY, NOT SUFFICIENT. "No rate, no routing" is the whole story
          for a live crew. For a crew still onboarding it is the smaller half:
          dispatch drops them for not being active before a rate is read at
          all, so promising that a rate is what stands between them and work
          would be false. The page above says the rest. */}
      <p style={{ fontSize: 13, fontWeight: 700, color: "var(--warn)", marginBottom: 18 }}>
        {notLiveYet
          ? "Set a rate now so it's on file — no rate, no routing once you're live."
          : "Set a rate to be matched to jobs — no rate, no routing."}
      </p>

      {standard.length > 0 && (
        <div style={{ display: "grid", gap: 12 }}>
          {standard.map((r) => (
            <RateCard key={r.service_id} rate={r} />
          ))}
        </div>
      )}

      {legs.length > 0 && (
        <section style={{ marginTop: standard.length > 0 ? 28 : 0 }}>
          <h2 style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Winter & storage legs 🧊</h2>
          <p className="mut" style={{ fontSize: 13, marginBottom: 12, maxWidth: 540 }}>
            Set your rate for each leg you can actually do — no rate means the machine
            never sends you that work.
          </p>
          <div style={{ display: "grid", gap: 12 }}>
            {legs.map((r) => (
              <RateCard key={r.service_id} rate={r} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function RateCard({ rate }: { rate: MyRate }) {
  const [values, setValues] = useState<Record<string, string>>(() => initialRateValues(rate.form.fields));
  const [saved, setSaved] = useState(rate.hasRate);
  const [pending, startTransition] = useTransition();

  function set(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    setSaved(false);
  }

  function save() {
    // Build the payload the action expects: base / unitRate / band-by-key.
    // SHARED with the ops setup form and the crew's confirmation card — three
    // hand-copies of this split is how a band price ends up saved as a base.
    const payload: RatePayload = payloadFromValues(rate.form.fields, values);

    startTransition(async () => {
      const res = await setMyRate(rate.service_id, payload);
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't save that rate.");
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

      {/* THE STANDING RULE, ABOVE THE BOX THEY ARE ABOUT TO TYPE IN.
          The rates page prints the same thing in a summary card at the top,
          which a crew scrolling straight to their service never reads. This is
          the copy that is next to the control. Null on every ordinary service,
          so nothing new appears on an ordinary card. */}
      {rate.form.feeNote && (
        <p className="mut" style={{ fontSize: 12.5, margin: "0 0 10px", lineHeight: 1.5 }}>
          {rate.form.feeNote}
        </p>
      )}

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
            {/* BOTH NUMBERS, for the value that is actually SAVED. It is
                deliberately not recomputed from what they are typing: a
                half-typed "5" would flash a payout for a quote nobody has
                saved. It updates when the server does. */}
            {f.feeSentence && (
              <span className="mut" style={{ display: "block", fontSize: 12, marginTop: 5 }}>
                {f.feeSentence}
              </span>
            )}
          </label>
        ))}
      </div>

      {/* THE MULTIPLIER, SAID OUT LOUD.
          A label alone still lets somebody read "per lot" and type the number
          they quote for the whole job — mowing is quoted per visit everywhere
          in the trade. At The Haven that turns $100 into $2,100, the margin
          floor drops them silently, and the screen says "Saved."
          The count is genuinely per-park — one rate card serves every park a
          crew works, each with its own lot count — so this says what happens
          rather than quoting a figure it cannot know here. */}
      {rate.form.unitNoun === "lot" && (
        <p className="mut" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>
          This one is charged for <b>every lot in the park</b>, so it&apos;s multiplied
          by however many lots that park has — a 21-lot park pays your per-lot rate
          twenty-one times. Put a whole-visit price in the base charge instead.
        </p>
      )}

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
