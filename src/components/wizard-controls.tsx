"use client";

/**
 * Tap-first building blocks for the property wizard: a +/- stepper and
 * tap-to-pick chips. Big targets, minimal typing — phone-friendly.
 */

export function Stepper({
  label,
  value,
  onChange,
  min = 0,
  max = 99,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
          {hint && <div className="mut" style={{ fontSize: 12 }}>{hint}</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <StepBtn label="decrease" disabled={value <= min} onClick={() => onChange(clamp(value - 1))}>−</StepBtn>
          <div style={{ minWidth: 44, textAlign: "center", fontWeight: 800, fontSize: 20, fontFamily: "var(--font-display)" }}>
            {value}
          </div>
          <StepBtn label="increase" disabled={value >= max} onClick={() => onChange(clamp(value + 1))}>+</StepBtn>
        </div>
      </div>
    </div>
  );
}

function StepBtn({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 44, height: 44, borderRadius: 12, border: "1.5px solid var(--line)",
        background: disabled ? "#f0f3f4" : "#fff", color: disabled ? "#b7c3c7" : "var(--teal-dark)",
        fontSize: 22, fontWeight: 700, lineHeight: 1, cursor: disabled ? "not-allowed" : "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}

/** Single-select tap chips. */
export function ChoiceChips({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {options.map((opt) => {
        const on = value === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            style={chipStyle(on)}
            aria-pressed={on}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

/** Multi-select tap chips. */
export function ToggleChips({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {options.map((opt) => {
        const on = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onToggle(opt)}
            style={chipStyle(on)}
            aria-pressed={on}
          >
            {on ? "✓ " : ""}{opt}
          </button>
        );
      })}
    </div>
  );
}

/**
 * THE ONE CHIP. Radius 99, a 1.5px line, and a SOLID teal fill with white text
 * when selected — the prototype's `.daychip.on` (lakelife.html:240). Two park
 * screens drew their own chip with a pale teal-wash selected state instead,
 * so the same gesture read as "chosen" in two different ways depending on
 * which tab you were on. Exported so a screen with its own Chip wrapper can
 * still draw the shared one.
 */
export function chipStyle(on: boolean): React.CSSProperties {
  return {
    padding: "9px 14px",
    borderRadius: 99,
    border: `1.5px solid ${on ? "var(--teal)" : "var(--line)"}`,
    background: on ? "var(--teal)" : "#fff",
    color: on ? "#fff" : "var(--text)",
    fontWeight: 700,
    fontSize: 13.5,
    cursor: "pointer",
    transition: "all .12s",
  };
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
        padding: "11px 13px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
        border: `1.5px solid ${checked ? "var(--teal)" : "var(--line)"}`,
        background: checked ? "#F2F9FA" : "#fff", fontSize: 14, fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 22, height: 22, borderRadius: 7, flexShrink: 0,
          border: `1.5px solid ${checked ? "var(--teal)" : "#c4d2d6"}`,
          background: checked ? "var(--teal)" : "#fff", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800,
        }}
      >
        {checked ? "✓" : ""}
      </span>
      {label}
    </button>
  );
}

/**
 * CHOOSE A FILE — the one home for picking a file.
 *
 * `globals.css` DELIBERATELY excludes `[type="file"]` from the base input
 * rule, alongside checkbox, radio and range — `design-system-holds.test.ts`
 * asserts that exclusion, because a bordered, padded checkbox is worse than a
 * bare one. The consequence is that a raw file input is the one control on a
 * screen with no styling at all, and each surface has had to solve it itself.
 *
 * By 20 Oct 2026 they had solved it FOUR different ways: hidden with a styled
 * trigger (VendorJobPanel, VendorStopCard — matching the prototype, which
 * hides every file input at lakelife.html :1321 and :1375), styled-visible
 * with a filename echo (VendorDocs, deliberately, with its reasoning in a
 * comment), deliberately sized at 16px to stop Safari zooming (ParkImportPaste),
 * and simply raw (VendorStorage, ParkDocuments) — so a crew uploading job
 * photos got a styled control and the same crew uploading their insurance
 * certificate got "Choose File | No file chosen".
 *
 * This is the prototype's pattern, once, for whoever needs it next.
 *
 * A `<label htmlFor>` rather than a button with an onClick: it opens the
 * picker from the keyboard and reads correctly to a screen reader with no
 * handler at all. And it always says back what was picked, because hiding the
 * native control without replacing what it told you is the worse bug.
 *
 * `id` must be unique on the page — pass something derived from what is being
 * picked, since more than one of these can render at once.
 */
export function FilePicker({
  id,
  label,
  accept,
  fileName,
  onPick,
  inputRef,
  disabled,
}: {
  id: string;
  label: string;
  accept: string;
  /** What is currently picked, or null. Owned by the caller, like any input. */
  fileName: string | null;
  /**
   * THE FILE, not its name. The first version of this handed back only the
   * name, which is enough to render and useless to upload — ParkDocuments
   * keeps the File itself to enable its submit button. The caller derives the
   * name for `fileName`; a picker that cannot give you the thing you picked
   * is not a picker.
   */
  onPick: (file: File | null) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}) {
  return (
    <div className="ll-field" style={{ display: "block" }}>
      <span className="mut" style={{ fontSize: 13 }}>{label}</span>
      <input
        id={id}
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        style={{ display: "none" }}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
        <label
          htmlFor={id}
          className="ll-btn ghost sm"
          style={{ minHeight: 44, display: "inline-flex", alignItems: "center", cursor: disabled ? "not-allowed" : "pointer" }}
        >
          {fileName ? "Choose a different file" : "Choose a file"}
        </label>
        {/* `overflowWrap: anywhere` because a real certificate is called
            something like Certificate_of_Insurance_Northshore_2027.pdf, and at
            375px an unbroken filename is the classic sideways scroll. */}
        <span className="mut" style={{ fontSize: 13, flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
          {fileName ?? "No file chosen yet"}
        </span>
      </div>
    </div>
  );
}
