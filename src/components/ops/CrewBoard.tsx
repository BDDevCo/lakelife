"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { approveCrew, suspendCrew, reactivateCrew, setCrewCapacity, setCrewCompany, confirmCoiExpiry } from "@/app/ops/crews-actions";
import { inviteCrew, resendCrewInvite } from "@/app/ops/crews-invite";
import type { OpsCrew, SetupService } from "@/app/ops/crews-data";
import { SimilarCrewList } from "@/components/SimilarCrewList";
import type { SimilarCrew } from "@/lib/invite-guard";
import { initialRateValues, payloadFromValues, valuesCarryMoney } from "@/app/vendor/rates-helpers";
import { MAX_DAILY_CAPACITY, MIN_DAILY_CAPACITY, WORK_DAYS_IN_READING_ORDER } from "@/lib/crew-setup";

const GROUPS: Array<{ key: OpsCrew["status"]; label: string; tone: string; blurb: string }> = [
  // NOT "approval" — there isn't one. finishOnboarding's own header calls this
  // "ZERO-OPS SELF-ACTIVATION (Phase A) ... no ops approval", and the invite
  // card eighty lines below says the same thing back to ops: "they go live
  // THEMSELVES — zero touch from you. This board is visibility, not a queue."
  // Two contradictory sentences on one screen, and the one he would have acted
  // on is the one sitting next to the crew who appears to be stuck.
  { key: "invited", label: "Onboarding", tone: "warn", blurb: "Invited — setting themselves up. Nothing here is waiting on you." },
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

/** A timestamp a person reads — "3 Sep, 2:14pm". Dates in words, never ISO. */
function prettyDateTime(ts: string | null): string {
  if (!ts) return "at an unknown time";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "at an unknown time";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function prettyDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function CrewBoard({
  crews,
  setupServices,
  lakes,
}: {
  crews: OpsCrew[];
  setupServices: SetupService[];
  lakes: { id: string; name: string }[];
}) {
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <InviteCard services={setupServices} lakes={lakes} />

      {GROUPS.map((g) => {
        const rows = crews.filter((c) => c.status === g.key);
        // THE COUNT STAYS THE NUMBER OF CARDS BELOW IT. Subtracting the test
        // accounts would print "Active crews 0" above three visible cards and
        // rebuild the same contradiction on one card instead of two. So the
        // head names both halves instead: three crews, none of them routable.
        const fixtures = rows.filter((c) => c.isFixture).length;
        return (
          <div key={g.key}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span className={`ll-pill ${g.tone}`}>{g.label}</span>
              <span className="mut" style={{ fontSize: 13 }}>
                {rows.length}
                {fixtures > 0 && (
                  fixtures === rows.length
                    ? ` · all test accounts — nothing routes to ${rows.length === 1 ? "it" : "them"}`
                    : ` · ${fixtures} test ${fixtures === 1 ? "account" : "accounts"} — nothing routes to ${fixtures === 1 ? "it" : "them"}`
                )}
              </span>
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

/**
 * ADD A CREW WHILE YOU ARE ON THE PHONE WITH THEM.
 *
 * Brendon, 24 September 2026: "me add them directly and answer most of the
 * questions in some ops portal, then they get sent a confirmation email or text
 * where all they have to do is upload or input a few small items".
 *
 * Everything under "What they told you on the phone" is OPTIONAL and none of it
 * is live. It is written to a proposal (0181) that the crew confirms — edited or
 * not — and their tap is what puts it on their account. Ops typing a crew's rate
 * and having it go live would be LakeLife setting a crew's price with extra
 * steps, which is the thing the whole marketplace posture rests on not doing.
 *
 * FOUR FIELDS ARE ABSENT AND MUST STAY ABSENT: bank details, the terms, the COI
 * and a verified mobile. Not masked, not optional — absent, because a field
 * that cannot honestly be somebody else's act does not belong on this form.
 */
function InviteCard({ services, lakes }: { services: SetupService[]; lakes: { id: string; name: string }[] }) {
  const router = useRouter();
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // ---- what they said on the phone. Nothing seeded: an empty box asks a
  // question, a filled one answers it, and this form answers none of them.
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [lakeIds, setLakeIds] = useState<string[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [cap, setCap] = useState("");
  const [note, setNote] = useState("");
  const [rateValues, setRateValues] = useState<Record<string, Record<string, string>>>({});

  // The near-match list, which this door has always been able to produce and
  // has never been able to draw.
  const [similar, setSimilar] = useState<SimilarCrew[] | null>(null);

  const serviceNames = services.map((s) => s.name);
  const picked = services.filter((s) => types.includes(s.name));

  function toggle(name: string) {
    setTypes((t) => (t.includes(name) ? t.filter((x) => x !== name) : [...t, name]));
  }
  function toggleLake(id: string) {
    setLakeIds((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  }
  function toggleDay(d: string) {
    setDays((v) => (v.includes(d) ? v.filter((x) => x !== d) : [...v, d]));
  }
  function setRate(serviceId: string, key: string, value: string) {
    setRateValues((prev) => ({ ...prev, [serviceId]: { ...(prev[serviceId] ?? {}), [key]: value } }));
  }

  /** What was typed, in the shape the action takes. Only services with a real
   *  number travel — a blank card counts as unpriced here as everywhere. */
  function buildSetup() {
    const rates = picked
      .filter((svc) => valuesCarryMoney(rateValues[svc.id] ?? {}))
      .map((svc) => ({
        serviceId: svc.id,
        payload: payloadFromValues(svc.form.fields, rateValues[svc.id] ?? initialRateValues(svc.form.fields)),
      }));
    return {
      phone: phone.trim() || null,
      lakeIds,
      workDays: days,
      dailyCapacity: cap.trim() || null,
      rates,
      note: note.trim() || null,
    };
  }

  function clear() {
    setCompany(""); setEmail(""); setTypes([]); setSimilar(null);
    setPhone(""); setLakeIds([]); setDays([]); setCap(""); setNote(""); setRateValues({});
    setOpen(false);
  }

  async function send(inviteAnyway = false) {
    if (busy) return;
    if (!company.trim()) return toast("Give the crew a company name.");
    if (!email.trim()) return toast("Enter the crew's email.");
    setBusy(true);
    const res = await inviteCrew({
      company: company.trim(),
      email: email.trim(),
      serviceTypes: types,
      inviteAnyway,
      setup: buildSetup(),
    });
    setBusy(false);

    // NOT AN ERROR, AND `error` IS DELIBERATELY UNSET BY THE ACTION. Toasting
    // `res.error ?? "Couldn't send that invite."` was this card's whole
    // handling of it: a bare refusal, no reason, no list, and a company name
    // ops had to retype to try again. The other two invite doors have drawn
    // this list since it shipped.
    if (!res.ok && res.needsConfirm && res.similar?.length) {
      setSimilar(res.similar);
      return;
    }
    if (!res.ok) return toast.err(res.error ?? "Couldn't send that invite.");

    // "Invite sent" must not be said when it wasn't. The crew row exists either
    // way, and a second attempt is refused as a duplicate, so this toast is
    // ops' only chance to learn the email never left.
    toast(res.warning ?? "Invite sent — they'll get a join email. 🌊");
    clear();
    router.refresh();
  }

  if (similar) {
    return (
      <div className="ll-card ll-card-pad">
        <SimilarCrewList
          typed={company.trim()}
          crews={similar}
          busy={busy}
          audience="ops"
          onMine={() => { clear(); toast("Nothing sent — they're already on LakeLife."); }}
          onNotMine={() => void send(true)}
        />
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className="ll-pill teal">Add a crew</span>
      </div>
      {/* THE OLD BLURB SAID "zero touch from you", WHICH IS NOW HALF TRUE. A
          crew ops sets up on the phone is very much touched by ops — what has
          not changed is that nobody at LakeLife approves them, and that is the
          sentence worth keeping. */}
      <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
        We&apos;ll email them a join link. Nobody here approves them — they upload their
        insurance and W-9, add a bank account, agree to the terms and go live THEMSELVES.
        This board is visibility, not a queue.
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

      {/* FOLDED AWAY BY DEFAULT. Adding a crew from an email address is still
          the two-field job it was; this opens only when somebody is actually on
          the phone with the details in front of them. */}
      <button
        type="button"
        className="ll-btn ghost sm"
        style={{ marginTop: 14 }}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide what they told you" : "On the phone with them? Fill it in for them"}
      </button>

      {open && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
            All optional, and <b>none of it goes live</b>. They see it on their first screen
            with your name on it, change anything that&apos;s wrong, and confirm — their
            tap is what makes it theirs. You can&apos;t enter their bank details, accept
            the terms, upload their insurance or verify their mobile: only they can.
          </p>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            <div className="ll-field">
              <label>Their mobile</label>
              <input
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(260) 555-0134"
              />
            </div>
            <div className="ll-field">
              <label>Jobs a day they can take</label>
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
          </div>

          {lakes.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 6 }}>
                Which water do they work?
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
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 6 }}>
              Days they work
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

          {picked.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 2 }}>
                What they charge
              </label>
              {/* THE LINE THAT KEEPS THIS A MARKETPLACE. His words, 24 Sep:
                  "Im wouldnt be building a quote around $50, its whatever his
                  pricing is or another contractor pricing is. we are not
                  setting anypricing." Nothing downstream reads this number —
                  it is not a quote, a floor or a default — and the moment the
                  crew confirms it, it is simply their own card. */}
              <p className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
                Their numbers, as they say them. Read them back before you send —
                we set no prices, so whatever they confirm is what they charge.
              </p>
              <div style={{ display: "grid", gap: 10 }}>
                {picked.map((svc) => (
                  <div key={svc.id} style={{ background: "var(--slate-soft)", padding: 12, borderRadius: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{svc.name}</div>
                    {svc.form.feeNote && (
                      <p className="mut" style={{ fontSize: 12, marginBottom: 8 }}>{svc.form.feeNote}</p>
                    )}
                    {/* A HEADING WITH NO BOXES IS A CONTROL THE SCREEN DOES NOT
                        DRAW. `buildRateForm` returns no fields for a service
                        whose pricing shape carries no bands or tiers — nothing
                        on production is in that state today, but this form
                        renders whatever the catalogue hands it, and silently
                        offering a service nobody can price is how a crew ends
                        up ticked for work that is never offered to them. */}
                    {svc.form.fields.length === 0 ? (
                      <p className="mut" style={{ fontSize: 12 }}>
                        We can&apos;t take a price for this one here — they&apos;ll set it on
                        their own rates screen.
                      </p>
                    ) : (
                    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
                      {svc.form.fields.map((f) => (
                        <div className="ll-field" key={f.key}>
                          <label>{f.label}</label>
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0"
                            value={rateValues[svc.id]?.[f.key] ?? ""}
                            onChange={(e) => setRate(svc.id, f.key, e.target.value)}
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

          <div className="ll-field" style={{ marginTop: 12 }}>
            <label>Anything else from the call (they&apos;ll read this)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. does the Haven pier every spring"
            />
          </div>
        </div>
      )}

      <button className="ll-btn gold" style={{ marginTop: 14 }} onClick={() => void send()} disabled={busy}>
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
  const docsComplete =
    crew.hasCoiDoc && crew.hasW9Doc &&
    crew.coiState !== "missing" && crew.coiState !== "expired" &&
    // 0152 — the certificate has to be THEIRS. This is the owner's rule and
    // it blocks approval, exactly as the expiry does.
    !crew.namedInsuredMismatch;
  const approveHint = !crew.hasCoiDoc
    ? "Waiting on the insurance certificate (COI)."
    : !crew.hasW9Doc
      ? "Waiting on the W-9."
      : crew.coiState === "expired"
        ? "The COI on file has expired — need a current one."
        : crew.coiState === "missing"
          ? "The COI has no expiry date — can't verify it."
          : crew.namedInsuredMismatch
            ? `The certificate names “${crew.coi_named_insured ?? ""}” but this crew is “${crew.company ?? ""}” — check which is wrong before approving.`
            : "";

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    if (busy) return;
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) return toast.err(res.error ?? "That didn't go through.");
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
            {/* Exactly what 0124 already does for a scratch lake
                (LakeConditions.tsx). The status pill beside this one says
                "active", the score line says on-time 100%, and every doorway
                that could send this crew work refuses it by name — so without
                this the card reads as a live business on the board ops uses to
                decide whether anyone can take the work. */}
            {crew.isFixture && (
              <span
                className="ll-pill slate"
                title="A test account we created ourselves. Dispatch, the assign dropdown and the payout run all skip it."
                style={{ textTransform: "none", letterSpacing: "normal" }}
              >
                Test account — nothing will route to it
              </span>
            )}
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
        {/* 0152 — THE EXPIRY IS A DATE THE CREW TYPED. Until somebody here has
            opened the file and agreed it, say so plainly rather than letting
            the COI chip imply we checked. One tap records who confirmed it. */}
        {crew.coiConfirm === "unconfirmed" && (
          <button
            className="ll-pill gold"
            disabled={busy}
            title="Open the certificate, check the expiry printed on it, then confirm."
            onClick={() => run(() => confirmCoiExpiry(crew.id), "Expiry confirmed.")}
            style={{ border: 0, cursor: busy ? "default" : "pointer", textTransform: "none", letterSpacing: "normal" }}
          >
            expiry unconfirmed — confirm it
          </button>
        )}
        {crew.namedInsuredMismatch && (
          <span
            className="ll-pill red"
            title={`Certificate: ${crew.coi_named_insured ?? "—"} · Account: ${crew.company ?? "—"}`}
            style={{ textTransform: "none", letterSpacing: "normal" }}
          >
            certificate names a different business
          </span>
        )}
        <span style={{ width: 1, height: 18, background: "var(--line)" }} />
        {crew.service_types.length === 0 ? (
          /* NOT "generalist (all work)". THE ROUTER DISAGREES: dispatch pools
             only crews whose service_types INCLUDES the job's service name, so
             an empty list is offered NOTHING — ever. This pill told ops the
             exact opposite of the truth about a crew who cannot be dispatched
             at all, in slate, as if it were a neutral fact. It is live on a
             crew in production today.
             Warn, not slate: this is a crew who will never get a job. */
          <span className="ll-pill warn">no work types — cannot be dispatched</span>
        ) : (
          crew.service_types.map((t) => <span key={t} className="ll-pill slate">{t}</span>)
        )}
      </div>

      {/* WHERE THEY WORK, AND WHAT HAS BEEN TAKEN AWAY.
          "No crew serves Pretty Lake yet" is a sentence ops reads on the
          dispatch side with nothing here to check it against. A crew who never
          ticked Pretty and a crew auto-demoted off it last night look identical
          from this board and need opposite responses — ring them and ask, or
          go and look at what went wrong. */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 12, fontSize: 13 }}>
        <span className="mut">Lakes:</span>
        {crew.lakes.length === 0 ? (
          <span className="ll-pill warn">no lakes ticked — dispatch can&apos;t route them</span>
        ) : (
          crew.lakes.map((l) => <span key={l} className="ll-pill teal">{l}</span>)
        )}
        {crew.pausedLakes.map((p) => (
          <span key={p.name} className="ll-pill warn" title={`Auto-demoted. Lifts ${p.liftsOn}.`}>
            {p.name} paused until {new Date(p.liftsOn + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        ))}
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

        {/* ON EVERY CARD, BECAUSE THE INPUT IS ON EVERY CARD. This button used
            to render only for an active crew, so on a suspended card ops could
            type a new daily capacity, press Reactivate — whose whole body is
            `update({ status: "active" })` — and be told "Crew reactivated —
            back on the board" while the number they just typed was thrown
            away. The over-dispatched crew they dropped to 3 before suspending
            came back at the old number and the router kept routing at it.
            setCrewCapacity has no status precondition; it clamps 1–20 and is
            ops-gated. Widened rather than special-cased: the invited card had
            the same hole in quieter form, where the number committed only as a
            side effect of pressing Force-activate. */}
        <button
          className="ll-btn sm"
          disabled={busy}
          onClick={() => run(() => setCrewCapacity(crew.id, cap), "Capacity saved.")}
        >
          Save capacity
        </button>

        <div style={{ flex: 1 }} />

        {crew.status !== "active" ? (
          <button
            className={`ll-btn ${crew.status === "suspended" ? "gold" : "ghost"} sm`}
            disabled={busy || !docsComplete}
            title={docsComplete ? undefined : approveHint}
            onClick={() =>
              run(
                () => (crew.status === "suspended" ? reactivateCrew(crew.id) : approveCrew(crew.id, cap)),
                crew.status === "suspended" ? "Crew reactivated — back on the board." : "Force-activated (override) — crews normally go live themselves. 🌊",
              )
            }
          >
            {crew.status === "suspended" ? "Reactivate" : "Force-activate (override)"}
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

      {/* The mismatch has its own line below, with the control attached — two
          paragraphs saying the same thing is how the one with no button gets
          read first. */}
      {crew.status !== "active" && !docsComplete && !crew.namedInsuredMismatch && (
        <p style={{ color: "var(--warn)", fontSize: 12, margin: 0 }}>{approveHint}</p>
      )}

      {/* THE FIX SITS ON THE SENTENCE THAT REPORTS THE PROBLEM.
          "check which is wrong before approving" was the only guidance, and
          vendors.company appeared in no UPDATE anywhere — so the answer "the
          account is wrong" had nowhere to go. Shown for an ACTIVE crew too:
          a renewal is when a mismatch most often appears, and it drops them
          out of dispatch and the claim board with no other trace. */}
      {/* DID THEY EVER HEAR FROM US? Three states that used to render as one.
          Only for an invite still waiting to be claimed — a crew who has signed
          up is past all of this. */}
      {crew.status === "invited" && crew.contact.unclaimed && (
        <InviteState
          vendorId={crew.id}
          email={crew.invite_email}
          sentAt={crew.inviteSentAt}
          error={crew.inviteError}
        />
      )}

      {crew.namedInsuredMismatch && (
        <CompanyFix
          vendorId={crew.id}
          company={crew.company}
          namedInsured={crew.coi_named_insured}
          active={crew.status === "active"}
        />
      )}
    </div>
  );
}

/**
 * WHETHER THE INVITATION ACTUALLY LEFT, and the way to send it again.
 *
 * The only place a failed send was ever reported is a toast, and Toast.tsx
 * clears it after 3800ms. After that a bounced invite, a spam-foldered invite
 * and one somebody simply hasn't opened all rendered as the same card. There
 * was no resend, and `inviteCrew` refuses a duplicate open invite — so the only
 * recovery was a database edit.
 */
function InviteState({
  vendorId,
  email,
  sentAt,
  error,
}: {
  vendorId: string;
  email: string | null;
  sentAt: string | null;
  error: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function resend() {
    if (busy) return;
    setBusy(true);
    const res = await resendCrewInvite(vendorId);
    setBusy(false);
    if (!res.ok) return toast.err(res.error ?? "That didn't go through.");
    toast(`Invitation sent again to ${res.email ?? email ?? "them"}. 🌊`);
    router.refresh();
  }

  // A REFUSAL OUTRANKS A DATE. If the last attempt failed, that is the fact
  // that decides what ops does next, whatever happened before it.
  const line = error
    ? `The invitation didn't send — ${error}`
    : sentAt
      ? `Invitation sent ${prettyDateTime(sentAt)} — nothing back yet.`
      : // Both the never-sent case and every row that predates 0154. Saying
        // "we can't tell" beats inventing a date, and the button is the same.
        "We have no record this invitation was ever sent.";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <p
        style={{
          fontSize: 12, margin: 0, flex: 1, minWidth: 200,
          color: error || !sentAt ? "var(--ink-warn)" : "var(--sub)",
        }}
      >
        {line}
      </p>
      <button className="ll-btn ghost sm" onClick={resend} disabled={busy} style={{ minHeight: 44 }}>
        {busy ? "Sending…" : "Resend invite"}
      </button>
    </div>
  );
}

/**
 * Correct the business name on the account when the certificate disagrees
 * with it. Ops-only by construction — this action lives in crews-actions.ts
 * behind assertOps, and a crew who could edit their own name would make the
 * insurance gate self-certifying.
 */
function CompanyFix({
  vendorId,
  company,
  namedInsured,
  active,
}: {
  vendorId: string;
  company: string | null;
  namedInsured: string | null;
  active: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(company ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    const res = await setCrewCompany(vendorId, name);
    setBusy(false);
    if (!res.ok) return toast.err(res.error ?? "That didn't go through.");
    toast("Business name updated.");
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <p style={{ color: "var(--ink-warn)", fontSize: 12, margin: 0, flex: 1, minWidth: 200 }}>
          {active
            ? `The certificate names “${namedInsured ?? ""}” but this crew is “${company ?? ""}” — they're not being routed until these agree.`
            : `The certificate names “${namedInsured ?? ""}” but this crew is “${company ?? ""}”.`}
        </p>
        <button className="ll-btn ghost sm" onClick={() => setOpen(true)} style={{ minHeight: 44 }}>
          Fix the name
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save(); }}
      style={{ display: "grid", gap: 8 }}
    >
      <p className="mut" style={{ fontSize: 12, margin: 0 }}>
        If the policy is right and the account is wrong, put the legal name here.
        If the account is right, the crew needs a certificate in that name — this
        box won&apos;t fix that.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          autoFocus
          aria-label="Business name on the account"
          placeholder={namedInsured ?? "Legal business name"}
          style={{
            padding: "9px 12px", border: "1.5px solid var(--line)", borderRadius: 10,
            fontWeight: 700, fontFamily: "inherit", color: "var(--text)",
            background: "#fff", minHeight: 44, flex: 1, minWidth: 200,
          }}
        />
        <button type="submit" className="ll-btn sm" disabled={busy} style={{ minHeight: 44 }}>
          {busy ? "Saving…" : "Save name"}
        </button>
        <button
          type="button"
          className="ll-btn ghost sm"
          onClick={() => { setOpen(false); setName(company ?? ""); }}
          disabled={busy}
          style={{ minHeight: 44 }}
        >
          Cancel
        </button>
      </div>
    </form>
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
