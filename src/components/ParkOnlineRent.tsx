"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { saveOnlineRent } from "@/app/park/actions";
import { onlineRentCautions } from "@/app/park/park-helpers";

/**
 * HOW RENT COMES IN.
 *
 * This switch and this percentage have been read by `payRent` and by every
 * resident's portal since migrations 0108 and 0109, and nothing has ever
 * written either one. The switch defaults OFF and `payRent` refuses when it is
 * off, so online rent was off for every park, permanently. The scratch fixture
 * only worked because the flag got set in SQL by hand — which is how a column
 * with no writer hides: the demo looks right.
 *
 * It gets its own card rather than a slot in "How this park runs" because it is
 * the only setting on that page that moves money off somebody else's card, and
 * because it carries a hazard the owner is personally liable for. The cautions
 * are not a disclaimer to scroll past — they are the reason the fee should sit
 * at zero today.
 */
export function ParkOnlineRent({
  parkId, initialAccepting, initialFeePct, ceiling, canChange, households, unclaimed,
}: {
  parkId: string;
  initialAccepting: boolean;
  initialFeePct: string;
  ceiling: number;
  canChange: boolean;
  /** Households with a CLAIMED portal account — the only ones who can pay. */
  households: number;
  /** On the roll, no account yet. The switch does nothing for these. */
  unclaimed: number;
}) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(initialAccepting);
  const [feePct, setFeePct] = useState(initialFeePct);
  const [pending, start] = useTransition();

  const raw = feePct.trim().replace(/[%\s]/g, "");
  const pct = raw === "" ? 0 : Number(raw);
  const badFee = !Number.isFinite(pct) || pct < 0 || pct > ceiling;

  // Recomputed as he types, from the same helper the server uses, so the
  // warning about debit cards appears the moment the fee stops being zero.
  const cautions = onlineRentCautions(badFee ? 0 : pct);

  // $400 is the flat lot rent after close — a concrete number beats "a fee".
  const example = 400;
  const exampleFee = badFee ? 0 : Math.round(example * pct) / 100;

  // COMPARE THE NUMBERS, NOT THE STRINGS.
  //
  // `getOnlineRent` normalises a stored 0 to "", so typing the 0 this card's
  // own copy recommends left `raw === "0"` against `initialFeePct === ""`.
  // router.refresh() re-renders without remounting, so the typed state
  // survives while the prop changes and the button read "Save how rent comes
  // in" forever — after a save that had already worked. Same for "3.0" or
  // "03" against a stored 3.
  const initialPct = initialFeePct.trim() === "" ? 0 : Number(initialFeePct);
  const dirty =
    accepting !== initialAccepting ||
    (!badFee && Math.abs(pct - initialPct) > 0.0001);

  function save() {
    start(async () => {
      const res = await saveOnlineRent(parkId, { accepting, cardFeePct: feePct });
      toast(res.ok ? (res.signal ?? "Saved.") : (res.error ?? "Couldn't save that."));
      if (res.ok) router.refresh();
    });
  }

  return (
    <section className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>How rent comes in</h2>
      <p className="mut" style={{ fontSize: 13, marginTop: 0, lineHeight: 1.5 }}>
        Whether residents can pay you through the app, and what a card costs
        them. Rent is the park&apos;s money — it never mixes with what LakeLife
        bills you for service work, in either direction.
      </p>

      {/* THE STATE, FIRST AND IN WORDS. A toggle alone makes you guess which
          way is on. */}
      <div style={{
        marginTop: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      }}>
        <button
          type="button"
          role="switch"
          aria-checked={accepting}
          disabled={!canChange || pending}
          onClick={() => setAccepting((v) => !v)}
          style={{
            minHeight: 44, minWidth: 84, borderRadius: 999, cursor: canChange ? "pointer" : "not-allowed",
            border: "1.5px solid var(--line)", fontWeight: 800, fontSize: 13,
            background: accepting ? "var(--teal)" : "#fff",
            color: accepting ? "#fff" : "var(--sub)",
          }}
        >
          {accepting ? "On" : "Off"}
        </button>
        <div style={{ fontSize: 13.5, lineHeight: 1.5, flex: 1, minWidth: 220 }}>
          {accepting ? (
            <>
              <b>Residents can pay rent in the app.</b>{" "}
              {/* THE COUNT IS OF ACCOUNTS, NOT TENANCIES. Every tenancy the
                  office keys in starts unclaimed, and paying online needs a
                  claimed file — so "19 households can use it" was true of the
                  roll and false of every single one of them. */}
              {households === 0 && unclaimed === 0
                ? "Nobody is on the roll yet, so nothing will happen until there is."
                : households === 0
                  ? `Nobody can use it yet — all ${unclaimed} ${unclaimed === 1 ? "household has" : "households have"} a file but no account. They each need to claim theirs before they can pay.`
                  : `${households} of ${households + unclaimed} ${households + unclaimed === 1 ? "household" : "households"} have claimed an account and can use it.`}
            </>
          ) : (
            <>
              <b>Residents cannot pay in the app.</b> The pay button is refused
              server-side, not just hidden — they pay you the way they do now.
            </>
          )}
        </div>
      </div>

      {/* THE FEE. Editable, capped by 0116 at the database as well as here. */}
      <div style={{ marginTop: 16, maxWidth: 330 }}>
        <label className="ll-field" style={{ fontSize: 13, display: "block", margin: 0 }}>
          <span style={{ fontWeight: 700 }}>Card fee</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <input
              inputMode="decimal"
              value={feePct}
              disabled={!canChange || pending}
              onChange={(e) => setFeePct(e.target.value)}
              placeholder="0"
              style={{ flex: 1, minWidth: 0 }}
            />
            <span className="mut">%</span>
          </span>
          <span className="mut" style={{ display: "block", marginTop: 5, fontSize: 12, lineHeight: 1.45 }}>
            Added to a card payment only, never to a bank transfer and never to
            the rent itself. Blank or 0 means you absorb it. Capped at {ceiling}%.
          </span>
        </label>

        {badFee ? (
          <p style={{ fontSize: 12.5, marginTop: 8, marginBottom: 0, color: "var(--warn, #b23)", lineHeight: 1.45 }}>
            That has to be a number between 0 and {ceiling}.
          </p>
        ) : (
          <p style={{ fontSize: 12.5, marginTop: 8, marginBottom: 0, lineHeight: 1.45 }}>
            {/* The arithmetic on a real rent, not an abstraction. */}
            {pct === 0
              ? `A $${example} rent is charged as $${example}.00 — no fee.`
              : `A $${example} rent is charged as $${(example + exampleFee).toFixed(2)} — $${exampleFee.toFixed(2)} of that is the card fee, and it is not yours.`}
          </p>
        )}
      </div>

      <ul style={{ margin: "14px 0 0", paddingLeft: 18 }}>
        {cautions.map((c) => (
          <li key={c} className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 5 }}>
            {c}
          </li>
        ))}
      </ul>

      {!canChange ? (
        <p className="mut" style={{ fontSize: 12.5, marginTop: 14, marginBottom: 0 }}>
          Only the park&apos;s owner can change this — you&apos;re listed as a manager.
        </p>
      ) : (
        <button
          className="ll-btn"
          onClick={save}
          disabled={pending || badFee || !dirty}
          style={{ marginTop: 16, minHeight: 44 }}
        >
          {pending ? "Saving…" : dirty ? "Save how rent comes in" : "Saved"}
        </button>
      )}
    </section>
  );
}
