"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { saveParkDials } from "@/app/park/actions";
import { dialsWarning, noticeShape, type ParkDialsInput } from "@/app/park/park-helpers";

/**
 * HOW THIS PARK RUNS.
 *
 * Every field here is a number the rest of the module has been reading since
 * migration 0061 and that nothing could write. The agreement cap is the one
 * that matters most: a database trigger enforces it, and while the column sat
 * NULL the trigger read that as "no cap" and skipped. The owner's most
 * explicitly stated rule was enforced by nothing.
 *
 * Each field says what it CHANGES, not what it is. "Notice period" means
 * nothing to somebody who has never sent a rent-increase letter; "how much
 * warning before a rent increase can take effect" is the same fact and is
 * actually answerable.
 */
export function ParkDials({
  parkId, initial, longestStayDays, today,
}: {
  parkId: string;
  initial: ParkDialsInput;
  /** Longest tenancy currently on the roll, so a new cap can be explained. */
  longestStayDays: number | null;
  today: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<ParkDialsInput>(initial);
  const [pending, start] = useTransition();

  const set = <K extends keyof ParkDialsInput>(k: K, v: ParkDialsInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const capNum = /^\d+$/.test(form.maxAgreementMonths.trim())
    ? Number(form.maxAgreementMonths)
    : null;
  const warning = dialsWarning(capNum, longestStayDays);

  // A notice period is unarguable as a number and obvious as a pair of dates.
  const noticeNum = /^\d+$/.test(form.rentNoticeDays.trim())
    ? Number(form.rentNoticeDays)
    : null;
  const notice = noticeNum == null ? null : noticeShape(noticeNum, capNum, today);

  function save() {
    start(async () => {
      const res = await saveParkDials(parkId, form);
      toast(res.ok ? (res.signal ?? "Saved.") : (res.error ?? "Couldn't save that."));
      if (res.ok) router.refresh();
    });
  }

  return (
    <section className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>How this park runs</h2>
      <p className="mut" style={{ fontSize: 13, marginTop: 0, lineHeight: 1.5 }}>
        These drive the rent ledger, the reminders and what the app will and
        won&apos;t let you write. They were sitting on defaults until now.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 14 }}>
        <Field
          label="Longest one agreement can run"
          hint="Your rule is three months. Longer stays get a fresh agreement. Leave blank for no limit."
          suffix="months"
          value={form.maxAgreementMonths}
          onChange={(v) => set("maxAgreementMonths", v)}
        />
        <Field
          label="Deposit"
          hint="Taken once at the start of a chain. Consecutive agreements don't need another."
          prefix="$"
          value={form.depositAmount}
          onChange={(v) => set("depositAmount", v)}
        />
        <Field
          label="Rent is due on the"
          hint="Of the month. Capped at the 28th so every month has one."
          suffix="day"
          value={form.rentDueDay}
          onChange={(v) => set("rentDueDay", v)}
        />
        <Field
          label="Office catch-up window"
          hint="Nobody is called late until a bill is this many days past due — so a check in an envelope doesn't make somebody look delinquent."
          suffix="days"
          value={form.officeRecordingLagDays}
          onChange={(v) => set("officeRecordingLagDays", v)}
        />
        <Field
          label="Warning before a rent increase"
          hint="How much notice a household gets before a new rent can start. Check this one with your attorney."
          suffix="days"
          value={form.rentNoticeDays}
          onChange={(v) => set("rentNoticeDays", v)}
        />
        <Field
          label="The day you take over"
          hint="Leave blank until the contract says. Nothing is collectable before it."
          type="date"
          value={form.cutoverOn}
          onChange={(v) => set("cutoverOn", v)}
        />
      </div>

      {notice && (
        <p style={{ fontSize: 13, marginTop: 14, marginBottom: 0, lineHeight: 1.5,
                    color: notice.fitsInTerm ? undefined : "var(--warn)" }}>
          {notice.line}
        </p>
      )}

      {warning && (
        <p style={{ fontSize: 13, marginTop: 14, marginBottom: 0, lineHeight: 1.5 }}>
          {warning}
        </p>
      )}

      <button className="ll-btn" onClick={save} disabled={pending} style={{ marginTop: 16 }}>
        {pending ? "Saving…" : "Save how this park runs"}
      </button>
    </section>
  );
}

function Field({
  label, hint, value, onChange, prefix, suffix, type,
}: {
  label: string; hint: string; value: string; onChange: (v: string) => void;
  prefix?: string; suffix?: string; type?: string;
}) {
  return (
    <label className="ll-field" style={{ fontSize: 13, display: "block", margin: 0 }}>
      <span style={{ fontWeight: 700 }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        {prefix && <span className="mut">{prefix}</span>}
        <input
          type={type ?? "text"}
          inputMode={type ? undefined : "numeric"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        {suffix && <span className="mut">{suffix}</span>}
      </span>
      <span className="mut" style={{ display: "block", marginTop: 5, fontSize: 12, lineHeight: 1.45 }}>
        {hint}
      </span>
    </label>
  );
}
