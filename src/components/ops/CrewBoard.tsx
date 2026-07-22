"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { approveCrew, suspendCrew, reactivateCrew, setCrewCapacity } from "@/app/ops/crews-actions";
import { inviteCrew } from "@/app/ops/crews-invite";
import type { OpsCrew } from "@/app/ops/crews-data";

const GROUPS: Array<{ key: OpsCrew["status"]; label: string; tone: string; blurb: string }> = [
  { key: "invited", label: "Onboarding", tone: "warn", blurb: "Invited — waiting on documents and approval." },
  { key: "active", label: "Active crews", tone: "ok", blurb: "Routable now (valid insurance on file)." },
  { key: "suspended", label: "Suspended", tone: "slate", blurb: "Off the board — not being routed." },
];

const STATUS_PILL: Record<OpsCrew["status"], { tone: string; label: string }> = {
  invited: { tone: "warn", label: "onboarding" },
  active: { tone: "ok", label: "active" },
  suspended: { tone: "slate", label: "suspended" },
};

const TIER_PILL: Record<OpsCrew["tier"], { tone: string; label: string }> = {
  priority: { tone: "gold", label: "Priority ⭐" },
  building: { tone: "teal", label: "Building" },
  new: { tone: "slate", label: "New" },
};

function prettyDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function CrewBoard({ crews, activeServiceNames }: { crews: OpsCrew[]; activeServiceNames: string[] }) {
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <InviteCard serviceNames={activeServiceNames} />

      {GROUPS.map((g) => {
        const rows = crews.filter((c) => c.status === g.key);
        return (
          <div key={g.key}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span className={`ll-pill ${g.tone}`}>{g.label}</span>
              <span className="mut" style={{ fontSize: 13 }}>{rows.length}</span>
            </div>
            {rows.length === 0 ? (
              <div className="mut" style={{ fontSize: 13, padding: "4px 2px" }}>{g.blurb} None right now.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {rows.map((c) => <CrewCard key={c.id} crew={c} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- Invite a crew ---------------------------------------------------------

function InviteCard({ serviceNames }: { serviceNames: string[] }) {
  const router = useRouter();
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function toggle(name: string) {
    setTypes((t) => (t.includes(name) ? t.filter((x) => x !== name) : [...t, name]));
  }

  async function send() {
    if (busy) return;
    if (!company.trim()) return toast("Give the crew a company name.");
    if (!email.trim()) return toast("Enter the crew's email.");
    setBusy(true);
    const res = await inviteCrew({ company: company.trim(), email: email.trim(), serviceTypes: types });
    setBusy(false);
    if (!res.ok) return toast(res.error ?? "Couldn't send that invite.");
    toast("Invite sent — they'll get a join email. 🌊");
    setCompany("");
    setEmail("");
    setTypes([]);
    router.refresh();
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className="ll-pill teal">Invite a crew</span>
      </div>
      <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
        We&apos;ll email them a join link. They set up their account, upload insurance &amp; W-9, then you approve.
      </p>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div className="ll-field">
          <label>Company / crew name</label>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Northshore Docks" />
        </div>
        <div className="ll-field">
          <label>Email</label>
          <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="crew@example.com" />
        </div>
      </div>

      {serviceNames.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 6 }}>What work do they do?</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {serviceNames.map((name) => {
              const on = types.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggle(name)}
                  className={`ll-pill ${on ? "teal" : "slate"}`}
                  style={{ cursor: "pointer", border: "none", padding: "8px 12px", fontSize: 13 }}
                  aria-pressed={on}
                >
                  {on ? "✓ " : ""}{name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <button className="ll-btn gold" style={{ marginTop: 14 }} onClick={send} disabled={busy}>
        {busy ? "Sending…" : "Send invite"}
      </button>
    </div>
  );
}

// ---- One crew card ---------------------------------------------------------

function CrewCard({ crew }: { crew: OpsCrew }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState<number>(crew.daily_capacity > 0 ? crew.daily_capacity : 5);

  const pill = STATUS_PILL[crew.status];
  const tierPill = TIER_PILL[crew.tier];
  const showTier = crew.status === "active" || crew.completedCount > 0;
  const docsComplete = crew.hasCoiDoc && crew.hasW9Doc && crew.coiState !== "missing" && crew.coiState !== "expired";
  const approveHint = !crew.hasCoiDoc
    ? "Waiting on the insurance certificate (COI)."
    : !crew.hasW9Doc
      ? "Waiting on the W-9."
      : crew.coiState === "expired"
        ? "The COI on file has expired — need a current one."
        : crew.coiState === "missing"
          ? "The COI has no expiry date — can't verify it."
          : "";

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    if (busy) return;
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) return toast(res.error ?? "That didn't go through.");
    toast(okMsg);
    router.refresh();
  }

  const contactLine = [
    crew.contact.name,
    crew.contact.email,
    crew.contact.phone,
    crew.contact.unclaimed ? "hasn't signed up yet" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="ll-card ll-card-pad" style={{ display: "grid", gap: 12 }}>
      {/* Header */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 800, fontSize: 16 }}>{crew.company ?? "Unnamed crew"}</span>
            <span className={`ll-pill ${pill.tone}`}>{pill.label}</span>
            {showTier && <span className={`ll-pill ${tierPill.tone}`}>{tierPill.label}</span>}
          </div>
          {crew.status === "active" && (
            <div className="mut" style={{ fontSize: 12.5, marginTop: 3 }}>
              Score {crew.score} · On-time {Math.round(crew.onTimeRate * 100)}% · {crew.completedCount} {crew.completedCount === 1 ? "job" : "jobs"} · 👍{crew.thumbsUp}
              {crew.thumbsDown > 0 ? ` 👎${crew.thumbsDown}` : ""}
            </div>
          )}
          <div className="mut" style={{ fontSize: 12.5, marginTop: 3 }}>{contactLine || "No contact on file"}</div>
        </div>
      </div>

      {/* Documents + service types */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <DocChip
          kind="COI"
          state={crew.coiState}
          expiry={crew.coi_expiry}
          url={crew.coiSignedUrl}
        />
        <W9Chip has={crew.hasW9Doc} url={crew.w9SignedUrl} />
        <span style={{ width: 1, height: 18, background: "var(--line)" }} />
        {crew.service_types.length === 0 ? (
          <span className="ll-pill slate">generalist (all work)</span>
        ) : (
          crew.service_types.map((t) => <span key={t} className="ll-pill slate">{t}</span>)
        )}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="ll-field" style={{ marginBottom: 0, width: 130 }}>
          <label style={{ fontSize: 12 }}>Daily capacity</label>
          <input
            type="number"
            min={1}
            max={20}
            value={cap}
            onChange={(e) => setCap(Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 0))))}
          />
        </div>

        {crew.status === "active" && (
          <button
            className="ll-btn ghost sm"
            disabled={busy}
            onClick={() => run(() => setCrewCapacity(crew.id, cap), "Capacity saved.")}
          >
            Save capacity
          </button>
        )}

        <div style={{ flex: 1 }} />

        {crew.status !== "active" ? (
          <button
            className="ll-btn gold sm"
            disabled={busy || !docsComplete}
            title={docsComplete ? undefined : approveHint}
            onClick={() =>
              run(
                () => (crew.status === "suspended" ? reactivateCrew(crew.id) : approveCrew(crew.id, cap)),
                crew.status === "suspended" ? "Crew reactivated — back on the board." : "Approved — crew is live. 🌊",
              )
            }
          >
            {crew.status === "suspended" ? "Reactivate" : "Approve"}
          </button>
        ) : null}

        {crew.status === "active" ? (
          <button
            className="ll-btn ghost sm"
            disabled={busy}
            onClick={() => run(() => suspendCrew(crew.id), "Crew suspended.")}
          >
            Suspend
          </button>
        ) : null}
      </div>

      {crew.status !== "active" && !docsComplete && (
        <p style={{ color: "var(--warn)", fontSize: 12, margin: 0 }}>{approveHint}</p>
      )}
    </div>
  );
}

function DocChip({
  kind,
  state,
  expiry,
  url,
}: {
  kind: "COI";
  state: OpsCrew["coiState"];
  expiry: string | null;
  url: string | null;
}) {
  let tone = "slate";
  let label = "";
  if (state === "missing") {
    tone = "warn";
    label = `${kind} missing — cannot route`;
  } else if (state === "expired") {
    tone = "warn";
    label = `${kind} expired ${prettyDate(expiry)} — cannot route`;
  } else if (state === "expiring") {
    tone = "warn";
    label = `${kind} renews ${prettyDate(expiry)}`;
  } else {
    tone = "ok";
    label = `${kind} thru ${prettyDate(expiry)}`;
  }
  return <Chip tone={tone} label={label} url={url} />;
}

function W9Chip({ has, url }: { has: boolean; url: string | null }) {
  return <Chip tone={has ? "ok" : "warn"} label={has ? "W-9 on file" : "W-9 missing"} url={has ? url : null} />;
}

function Chip({ tone, label, url }: { tone: string; label: string; url: string | null }) {
  if (url) {
    return (
      <a className={`ll-pill ${tone}`} href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
        {label} ↗
      </a>
    );
  }
  return <span className={`ll-pill ${tone}`}>{label}</span>;
}
