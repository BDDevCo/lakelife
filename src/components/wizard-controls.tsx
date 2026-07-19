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

function chipStyle(on: boolean): React.CSSProperties {
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
