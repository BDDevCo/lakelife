"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { saveApplication, submitApplication } from "@/app/parks/processor-actions";
import {
  APPLICATION_FIELDS, applicationGaps, readyToSubmit, submitSentence,
  type ApplicationField, type Derived,
} from "@/lib/merchant-application";

/**
 * GETTING A PARK OWNER SET UP TO TAKE RENT.
 *
 * His directive, 29 Oct 2026: the application is part of setting the park up,
 * we extract what we can from what he has already given us, ask only for what
 * is outstanding, and then it is one tap.
 *
 * ===========================================================================
 * WHAT WE WORKED OUT IS LABELLED AS WORKED OUT
 * ===========================================================================
 *
 * This codebase has paid for the opposite: a pre-ticked "they signed" once
 * wrote nineteen leases nobody had signed. An underwriting application is a
 * document he is ASSERTING things in, and a prefilled box he never read is the
 * same bug wearing a different hat.
 *
 * So every value we derived carries a small label saying where it came from,
 * and the two computed numbers carry their arithmetic. He can change any of
 * them. Nothing here is submitted as though he typed it unless he has seen it.
 *
 * ===========================================================================
 * THE EIN IS NOT ON THIS FORM UNTIL THE MOMENT HE SENDS
 * ===========================================================================
 *
 * It is write-only: it goes to the processor and we keep four digits. So it
 * cannot be part of the saved draft, and asking for it early would mean either
 * storing it or losing it. It is asked for beside the send button, where it is
 * used — and the screen says plainly that we do not keep it.
 */

interface Props {
  parkId: string;
  parkName: string | null;
  provider: string;
  submittedAt: string | null;
  initial: Record<string, unknown>;
  derived: Record<string, Derived>;
  /** A read failed upstream, so nothing prefilled here can be trusted. */
  couldNotRead: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  park: "from your park",
  owner: "from your account",
  "rent-roll": "from your rent roll",
  default: "the usual for a park",
};

export function ParkMerchantApplication({
  parkId, parkName, provider, submittedAt, initial, derived, couldNotRead,
}: Props) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [taxId, setTaxId] = useState("");
  const [pending, start] = useTransition();

  // The EIN is not stored, so it is part of "is this complete?" only while it
  // sits in this form's own state.
  const gaps = useMemo(
    () => applicationGaps({ ...values, tax_id: taxId }),
    [values, taxId],
  );
  const ready = readyToSubmit({ ...values, tax_id: taxId }, submittedAt);

  function set(id: string, v: unknown) {
    setValues((prev) => ({ ...prev, [id]: v }));
  }

  function saveDraft() {
    start(async () => {
      const res = await saveApplication(parkId, values);
      if (!res.ok) { toast.err(res.error ?? "Couldn't save that."); return; }
      toast.ok("Saved. Nothing has gone to anyone yet. 🌊");
      router.refresh();
    });
  }

  function send() {
    start(async () => {
      const res = await submitApplication(parkId, values, taxId);
      if (!res.ok) { toast.err(res.error ?? "Couldn't send it."); return; }
      setTaxId("");                       // never keep it, not even in memory
      toast.ok(res.signal ?? "Sent.");
      router.refresh();
    });
  }

  // ALREADY GONE. 0196 makes a submitted account immutable and 0201 refuses an
  // edit after it has gone, so showing the form again would be offering an
  // action the database will refuse.
  if (submittedAt) {
    return (
      <section className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill teal">With {provider}</span>
        <h2 style={{ fontSize: 16, margin: "10px 0 4px" }}>Your application is in</h2>
        <p className="mut" style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
          It went to {provider} and they decide from here. We&apos;ll tell you
          either way. Nothing about how rent works changes until they approve
          it &mdash; residents carry on paying you exactly as they do now.
        </p>
      </section>
    );
  }

  return (
    <section className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>Getting you set up to take rent</h2>
      <p className="mut" style={{ fontSize: 13, marginTop: 0, lineHeight: 1.5 }}>
        {provider} needs to know who they&apos;re paying before residents can
        pay you by card or bank. Rent lands in <strong>your own bank
        account</strong> &mdash; it never passes through LakeLife.
      </p>

      {couldNotRead && (
        <p className="ll-notice" style={{ marginTop: 12 }}>
          We couldn&apos;t read some of your park&apos;s details just now, so
          there may be less filled in below than usual. Nothing is wrong with
          your park &mdash; check anything that looks empty before you send.
        </p>
      )}

      <p className="mut" style={{ fontSize: 13, marginTop: 14, lineHeight: 1.5 }}>
        We&apos;ve filled in what we already know. <strong>Check each one</strong>
        {" "}&mdash; you&apos;re the one telling them this, not us.
      </p>

      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {APPLICATION_FIELDS.filter((f) => !f.writeOnly).map((f) => (
          <Field
            key={f.id}
            field={f}
            value={values[f.id]}
            derived={derived[f.id]}
            onChange={(v) => set(f.id, v)}
            disabled={pending}
          />
        ))}
      </div>

      {/* THE EIN, where it is used and nowhere earlier. */}
      <div className="ll-field" style={{ display: "block", marginTop: 16 }}>
        <span className="mut" style={{ fontSize: 13 }}>EIN or SSN</span>
        <input
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="12-3456789"
          disabled={pending}
          style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
        />
        <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>
          Goes straight to {provider} when you send. <strong>We keep the last
          four digits and nothing else</strong> &mdash; it is never saved with
          the rest of this form, so you&apos;ll type it once, here.
        </p>
      </div>

      {gaps.length > 0 && (
        <div className="ll-notice" style={{ marginTop: 16 }}>
          <strong>
            {gaps.length === 1 ? "One thing left" : `${gaps.length} things left`}
            {" "}before you can send:
          </strong>
          <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 13, lineHeight: 1.6 }}>
            {gaps.map((g) => <li key={g}>{g}</li>)}
          </ul>
        </div>
      )}

      <p className="mut" style={{ fontSize: 13, marginTop: 16, lineHeight: 1.5 }}>
        {submitSentence(parkName, provider)}
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
        <button
          className="ll-btn gold"
          onClick={send}
          disabled={!ready || pending}
          style={{ minHeight: 48 }}
        >
          {pending ? "Sending…" : `Send it to ${provider}`}
        </button>
        <button className="ll-btn ghost" onClick={saveDraft} disabled={pending} style={{ minHeight: 48 }}>
          {pending ? "Saving…" : "Save for later"}
        </button>
      </div>
    </section>
  );
}

function Field({
  field, value, derived, onChange, disabled,
}: {
  field: ApplicationField;
  value: unknown;
  derived?: Derived;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const isMoney = field.kind === "money";
  // Money is stored in cents and typed in dollars. Doing that conversion in
  // the one place the value crosses the boundary keeps cents out of the rest
  // of the screen entirely.
  const shown = isMoney && typeof value === "number" ? (value / 100).toFixed(2) : (value ?? "");
  // Only call it "worked out" while it still IS what we worked out. Once he
  // edits the box, the little label would be describing a value that is no
  // longer there.
  const untouched = derived != null && derived.value !== null &&
    String(derived.value) === String(value ?? "");

  return (
    <label className="ll-field" style={{ display: "block" }}>
      <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span className="mut" style={{ fontSize: 13 }}>{field.label}</span>
        {untouched && derived?.source && (
          <span className="ll-pill slate" style={{ fontSize: 11 }}>
            {SOURCE_LABEL[derived.source] ?? "worked out"}
          </span>
        )}
      </span>

      {field.kind === "choice" ? (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled}
          style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
        >
          <option value="">Choose one…</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <input
          value={String(shown)}
          onChange={(e) => onChange(
            isMoney
              ? Math.round(Number(e.target.value.replace(/[^0-9.]/g, "") || 0) * 100)
              : e.target.value,
          )}
          inputMode={isMoney ? "decimal" : field.kind === "phone" ? "tel" : field.kind === "postal" ? "numeric" : undefined}
          type={field.kind === "email" ? "email" : "text"}
          disabled={disabled}
          style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
        />
      )}

      {/* THE ARITHMETIC, where we did any. The two volume questions are the
          ones applicants guess at and underwriters stall on, so the number is
          shown with how it was reached rather than as a fact. */}
      {untouched && derived?.workings && (
        <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>
          From {derived.workings}
        </p>
      )}
      {field.help && (
        <p className="mut" style={{ fontSize: 12.5, margin: "4px 0 0", lineHeight: 1.5 }}>
          {field.help}
        </p>
      )}
    </label>
  );
}
