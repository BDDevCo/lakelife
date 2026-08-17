"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { sayIPaid } from "@/app/parks/pay-actions";

/**
 * "I'VE ALREADY PAID THIS" — the resident saying it themselves.
 *
 * THE RULE THIS EXISTS TO SERVE: LakeLife handles no cash, ever. Rent paid in
 * cash or by cheque goes hand to hand from the resident to the park owner, and
 * no LakeLife account is anywhere near it. What the software owes both of them
 * is a record they AGREE on — so it takes two statements. This is the first.
 * The owner's confirmation is the second, and only that one moves money on the
 * ledger.
 *
 * `ClaimForm` is the office's version of this screen, and its long comment is
 * the reference for WHY the fields are what they are — no cheque photo, no
 * scan, every field optional. All of it applies here and is not repeated. Two
 * differences, both about who is holding the phone:
 *
 * 1. THE VOICE IS FIRST PERSON. The office writes down what somebody told them;
 *    the resident is telling us directly. "They say they paid" becomes "I paid".
 *
 * 2. THERE IS NO AMOUNT FIELD. The office may need to record a part payment or
 *    a figure that disagrees with the bill. A resident typing their own number
 *    into a rent dispute helps nobody: it invites a wrong figure typed in
 *    haste, and the balance is already on the screen directly above this. The
 *    server claims the outstanding balance and the owner can record whatever
 *    was really handed over.
 */

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "transfer", label: "Bank transfer" },
  { value: "other", label: "Some other way" },
] as const;

type Method = (typeof METHODS)[number]["value"];

export function IPaidForm({
  chargeId,
  monthLabel,
  today,
}: {
  chargeId: string;
  monthLabel: string;
  /** Lake-local, from the server — the date picker must not offer tomorrow. */
  today: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>("cash");
  const [paidOn, setPaidOn] = useState("");
  const [reference, setReference] = useState("");
  const [paidTo, setPaidTo] = useState("");
  const [note, setNote] = useState("");

  function submit() {
    start(async () => {
      const res = await sayIPaid(chargeId, {
        paidOn: paidOn || undefined,
        method,
        reference: reference || undefined,
        paidTo: paidTo || undefined,
        note: note || undefined,
      });
      if (!res.ok) {
        toast(res.error ?? "That didn't go through.");
        return;
      }
      toast(res.signal ?? "Told the office.");
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        className="ll-btn ghost"
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        I&apos;ve already paid this
      </button>
    );
  }

  return (
    <div
      style={{
        marginTop: 12,
        borderTop: "1px solid var(--line)",
        paddingTop: 12,
      }}
    >
      <strong style={{ fontSize: 14 }}>
        Tell the office you&apos;ve paid {monthLabel}
      </strong>
      <p className="mut" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
        This doesn&apos;t mark the bill paid &mdash; the office has to confirm
        they collected it first. What it does straight away is stop this bill
        being chased or counted as late while they check.{" "}
        <strong>Everything below is optional.</strong>
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
          marginTop: 12,
        }}
      >
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How you paid</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as Method)}
            style={{ marginTop: 4 }}
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">When you paid it</span>
          <input
            type="date"
            value={paidOn}
            max={today}
            onChange={(e) => setPaidOn(e.target.value)}
            style={{ marginTop: 4 }}
          />
        </label>

        {/* The field that actually settles it — see ClaimForm's comment. */}
        {method === "check" && (
          <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut">Check number, if you have it</span>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="1042"
              inputMode="numeric"
              style={{ marginTop: 4 }}
            />
          </label>
        )}

        {/* THE TAKEOVER QUESTION, asked of the person who wrote the cheque.
            A cheque made out to the previous owner is not late rent — it is
            rent that went somewhere else, which is a different problem with a
            different answer, and the resident is the only one who knows. */}
        {method !== "cash" && (
          <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut">Who you made it out to</span>
            <input
              value={paidTo}
              onChange={(e) => setPaidTo(e.target.value)}
              placeholder="The name you wrote"
              style={{ marginTop: 4 }}
            />
          </label>
        )}
      </div>

      <label
        className="ll-field"
        style={{ fontSize: 13, display: "block", marginTop: 10 }}
      >
        <span className="mut">Anything else worth saying</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Left it at the office on Tuesday"
          style={{ marginTop: 4 }}
        />
      </label>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="ll-btn" disabled={busy} onClick={() => submit()}>
          {busy ? "Sending…" : "Tell the office"}
        </button>
        <button
          className="ll-btn ghost"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
