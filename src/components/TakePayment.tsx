"use client";

import { useEffect, useState, useTransition, type TransitionStartFunction } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { paymentTargets, type PaymentTarget, type PaymentTargetsResult } from "@/app/park/pos-actions";
import { recordPayment } from "@/app/park/ledger-actions";
import { recordOnAccount } from "@/app/park/money-actions";
import { ReceiptPanel } from "@/components/ParkReceipt";
import type { ReceiptLines } from "@/app/park/receipt-helpers";
import { money, currentPeriod, paymentAmountRefusal, type HandKeyedMethod } from "@/app/park/ledger-helpers";
import {
  FILTER_FROM, owedWords, prefillAmount, parseAmount, amountNote, noteNamesHeldDoor, disputedNote,
  receivedOnProblem, filterTargets, recordedWords, outcomeFromBill, outcomeFromAccount,
  rememberedMethod, rememberMethod, mintKey,
  type Outcome, type RecordedOutcome,
} from "@/components/take-payment-helpers";

/**
 * ⊕ TAKE A PAYMENT — THREE TAPS WHILE SOMEBODY IS STANDING THERE.
 *
 * His blueprint's rule: "It must work in three taps while somebody is
 * standing in front of him with a money order. Anything you navigate to is
 * not a point-of-sale terminal." So this is a button in the park-name row of
 * every park screen, and a card over that screen — the app's own overlay
 * (AuthModal, AccountControls), nothing new. Tap one is the gold button; tap
 * two is the household, on a list that already shows their oldest open bill
 * and what is owed; tap three is Record, on a form whose amount, method and
 * date are already filled. On a keyboard, Enter on the focused Record button
 * is tap three.
 *
 * LakeLife handles no cash. This RECORDS what the office collected, through
 * the two doors that already exist: recordPayment against the household's
 * oldest open bill (which splits any excess onto account itself), or
 * recordOnAccount when nothing is owed. No card, no ACH, no deposit, no drop
 * slip — those are other doors, and the drop box is money that arrived when
 * nobody was there; this window is somebody standing there.
 *
 * NO TOASTS FROM THIS FILE. Success is the Recorded step and a refusal is the
 * notice under the buttons — beside the figures, in the reading order on the
 * card — not a transient pill at the bottom of the viewport that a phone
 * keyboard covers. (The receipt panel it mounts toasts for its own email and
 * print buttons; that is its business and stays visible.)
 */

const METHODS = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
] as const;

type Step = "pick" | "record" | "done";

const UNREACHABLE_READ =
  "We couldn't reach the office ledger just now — nothing has been changed. Try again in a moment.";

export function TakePayment({ parkId }: { parkId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("pick");
  const [loaded, setLoaded] = useState<PaymentTargetsResult | null>(null);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<PaymentTarget | null>(null);
  const [method, setMethod] = useState<HandKeyedMethod>("check");
  const [idemKey, setIdemKey] = useState("");
  const [done, setDone] = useState<RecordedOutcome | null>(null);
  // ONE `busy` for the whole window: it gates the Record button, ✕, the
  // backdrop and Escape together, so nothing can close the card between the
  // tap and the door's answer.
  const [busy, start] = useTransition();

  async function load() {
    setLoaded(null);
    try {
      setLoaded(await paymentTargets(parkId));
    } catch {
      // A rejected action (the connection dropped) is a read that failed,
      // never an empty roll.
      setLoaded({ ok: false, error: UNREACHABLE_READ, retryable: true });
    }
  }

  function openWindow() {
    setMethod(rememberedMethod());
    setFilter("");
    setTarget(null);
    setDone(null);
    setStep("pick");
    setOpen(true);
    void load();
  }

  // THE KEY IS MINTED WHEN THE FORM OPENS FOR A HOUSEHOLD — tap two, not tap
  // one. recordPayment's own comment: a double-tapped submit, or a retry
  // after a flaky connection, collides on 0081's unique index instead of
  // recording the money twice. The index is on the key alone, so a key
  // shared across households would make household B's first payment read
  // "already recorded" after household A's landed with its answer lost. A
  // refused-then-corrected submit for the SAME household keeps its key:
  // nothing landed, so nothing collides.
  function pick(t: PaymentTarget) {
    setIdemKey(mintKey());
    setTarget(t);
    setStep("record");
  }

  function close() {
    if (busy) return;
    setOpen(false);
  }

  function another() {
    // A genuinely second payment is a new form and a new key — and a re-read
    // of the roll, because the balances just changed.
    setIdemKey(mintKey());
    setFilter("");
    setTarget(null);
    setDone(null);
    setStep("pick");
    void load();
  }

  function recorded(d: RecordedOutcome) {
    setDone(d);
    setStep("done");
    // The screen behind the card — the roll, Today's arrears, the ledger —
    // re-renders with the money on it; the open card survives the refresh
    // the way ParkRent's receipt panel does.
    router.refresh();
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  if (!open) {
    return (
      <button type="button" className="ll-btn gold sm" aria-haspopup="dialog" onClick={openWindow}>
        ⊕ Take a payment
      </button>
    );
  }

  const today = loaded?.ok ? loaded.today : "";
  const title = step === "pick"
    ? "Who's paying?"
    : step === "record" && target
      ? (target.lotNumber === "—" ? target.name : `Lot ${target.lotNumber} · ${target.name}`)
      : "Recorded";
  const sub = step === "pick"
    ? "Tap the household. Their oldest open bill is filled in for you."
    : step === "record" && target
      ? owedWords(target)
      : null;

  return (
    <div
      className="ll-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Take a payment"
      onClick={(e) => {
        // The backdrop closes the LIST only. A filled money form is not lost
        // to a thumb landing beside the card, and the receipt on the done
        // step is the only paper a cash household will ever get — nothing
        // reprints it. Those two leave by ✕, Back, Done or Escape.
        if (e.target === e.currentTarget && step === "pick" && !busy) close();
      }}
    >
      <div className="ll-modal">
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill gold">Take a payment</span>
            <h3 style={{ fontSize: 22, marginTop: 8 }}>{title}</h3>
            {sub && <div className="mut" style={{ marginTop: 4, fontSize: 13 }}>{sub}</div>}
          </div>
          <button className="ll-x" onClick={close} aria-label="Close" disabled={busy}>✕</button>
        </div>
        <div className="ll-modal-body">
          {step === "pick" && (
            <HouseholdList
              loaded={loaded}
              filter={filter}
              onFilter={setFilter}
              onPick={pick}
              onRetry={() => void load()}
            />
          )}
          {step === "record" && target && (
            <RecordForm
              parkId={parkId}
              target={target}
              today={today}
              method={method}
              onMethod={setMethod}
              idemKey={idemKey}
              busy={busy}
              start={start}
              onRecorded={recorded}
              // BACK RE-READS THE ROLL. The list was read before the tap, and
              // the reasons the office comes back through this button are
              // the door's refusals — "that bill was cancelled", "that
              // payment is already recorded" — after which the same row with
              // the same balance against the same dead bill is a stale read
              // offered as current, and a second tap mints a fresh key
              // against it. Every other way back to the list (✕, Escape, the
              // backdrop, Take another) reads; this one did not. Not
              // `another()`: that clears the filter, which on a 21-lot roll
              // is what found them the row.
              onBack={() => { setStep("pick"); void load(); }}
            />
          )}
          {step === "done" && done && (
            <Recorded
              parkId={parkId}
              outcome={done.outcome}
              signal={done.signal}
              receipt={done.receipt}
              renterEmail={done.renterEmail}
              onClose={close}
              onAnother={another}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ tap two ---

export function HouseholdList(p: {
  loaded: PaymentTargetsResult | null;
  filter: string;
  onFilter: (q: string) => void;
  onPick: (t: PaymentTarget) => void;
  onRetry: () => void;
}) {
  const { loaded } = p;
  if (loaded === null) {
    return <p className="mut" style={{ fontSize: 13 }}>Reading your roll…</p>;
  }
  if (!loaded.ok) {
    // A failed read is a sentence, never an empty list — and "Try again" is
    // honest here because it is a read, not a write. A denial cannot become
    // true by retrying, so it gets no button.
    return (
      <div>
        <div className="ll-notice" role="alert">{loaded.error}</div>
        {loaded.retryable && (
          <button type="button" className="ll-btn ghost sm" style={{ marginTop: 10 }} onClick={p.onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (loaded.targets.length === 0) {
    return (
      <div>
        <div className="ll-notice quiet">Nobody is on your roll yet, so there&apos;s nobody to take a payment from.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <Link className="ll-btn ghost sm" href="/park/import">Load the roll</Link>
          <Link className="ll-btn ghost sm" href="/park/onboard">Who lives here</Link>
        </div>
      </div>
    );
  }
  const rows = filterTargets(loaded.targets, p.filter);
  return (
    <div>
      {loaded.targets.length >= FILTER_FROM && (
        // No autoFocus: a keyboard sliding up over the list on a phone is the
        // opposite of three taps.
        <label className="ll-field" style={{ margin: "0 0 8px" }}>
          <span className="mut">Find them</span>
          <input
            value={p.filter}
            onChange={(e) => p.onFilter(e.target.value)}
            placeholder="Lot number or name"
            aria-label="Find a household"
            autoComplete="off"
          />
        </label>
      )}
      {rows.length === 0 && <p className="mut">Nobody matches &quot;{p.filter}&quot;.</p>}
      {rows.map((t, i) => (
        <button
          key={t.renterId}
          type="button"
          onClick={() => p.onPick(t)}
          autoFocus={i === 0}
          style={{
            display: "block", width: "100%", textAlign: "left", background: "none", border: "none",
            borderTop: "1px solid rgba(0,0,0,.06)", padding: "12px 4px", minHeight: 44,
            font: "inherit", color: "inherit",
          }}
        >
          <span style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
            <strong style={{ minWidth: 62 }}>{t.lotNumber === "—" ? "No lot" : `Lot ${t.lotNumber}`}</strong>
            <span style={{ flex: 1 }}>{t.name}</span>
          </span>
          <span className="mut" style={{ display: "block", fontSize: 13, marginTop: 2 }}>{owedWords(t)}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------- tap three ---

const UNREACHABLE_WRITE =
  "We couldn't reach the office ledger — check the rent screen before recording it again.";

export function RecordForm(p: {
  parkId: string;
  target: PaymentTarget;
  today: string;
  method: HandKeyedMethod;
  onMethod: (m: HandKeyedMethod) => void;
  idemKey: string;
  busy: boolean;
  start: TransitionStartFunction;
  onRecorded: (d: RecordedOutcome) => void;
  onBack: () => void;
}) {
  const { parkId, target, today, method, idemKey, busy, start } = p;
  const [amount, setAmount] = useState(prefillAmount(target));
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(today);
  const [refusal, setRefusal] = useState<string | null>(null);

  const prefilled = prefillAmount(target) !== "";
  const note = amountNote(amount, target);
  const noteIsRefusal = note != null && paymentAmountRefusal(parseAmount(amount)) != null;
  const dateProblem = receivedOnProblem(receivedOn, today);
  const claimNote = disputedNote(target);
  const ready = amount.trim() !== ""
    && paymentAmountRefusal(parseAmount(amount)) == null
    && dateProblem == null
    && receivedOn !== "";

  function submit() {
    start(async () => {
      setRefusal(null);
      const amt = parseAmount(amount);
      try {
        if (target.oldestOpen) {
          const res = await recordPayment(parkId, target.oldestOpen.chargeId, amt, method, reference, receivedOn, undefined, idemKey);
          if (!res.ok) { setRefusal(res.error ?? "Couldn't record that."); return; }
          rememberMethod(method);
          p.onRecorded(outcomeFromBill(res, target, amt));
        } else {
          const res = await recordOnAccount(parkId, target.renterId, amt, method, reference, receivedOn, undefined, idemKey);
          if (!res.ok) { setRefusal(res.error ?? "Couldn't record that."); return; }
          rememberMethod(method);
          p.onRecorded(outcomeFromAccount(res, target, amt));
        }
      } catch {
        // The key protects a retry, but this sentence must not say "try
        // again" about money that may already have landed: a second tap
        // then reads the door's own "already recorded — check the ledger".
        setRefusal(UNREACHABLE_WRITE);
      }
    });
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How much</span>
          <input
            value={amount}
            inputMode="decimal"
            autoComplete="off"
            autoFocus={!prefilled}
            onChange={(e) => setAmount(e.target.value)}
            style={{ marginTop: 4 }}
          />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How</span>
          <select value={method} onChange={(e) => p.onMethod(e.target.value as HandKeyedMethod)} style={{ marginTop: 4 }}>
            {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">{method === "check" ? "Check number" : "Reference"}</span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={method === "check" ? "1042" : ""}
            style={{ marginTop: 4 }}
          />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">When it came in</span>
          <input
            type="date"
            value={receivedOn}
            max={today}
            onChange={(e) => setReceivedOn(e.target.value)}
            style={{ marginTop: 4 }}
          />
        </label>
      </div>

      {note && (
        <p className="mut" role={noteIsRefusal ? "alert" : undefined} style={{ fontSize: 12.5, margin: "8px 0 0", lineHeight: 1.5 }}>
          {note}
        </p>
      )}
      {noteNamesHeldDoor(note) && (
        // The note names the door that puts their held money on this bill,
        // or hands it back — so the door is here, the way the refusal
        // notice below shows it when the door's own sentence names it.
        <Link className="ll-btn ghost sm" href="/park/rent" style={{ marginTop: 8 }}>Money not against a bill</Link>
      )}
      {claimNote && (
        <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>
          {claimNote}{" "}
          <Link href={`/park/rent?month=${currentPeriod(today)}`}>Open the rent screen</Link>
        </p>
      )}
      {dateProblem && (
        <p className="mut" role="alert" style={{ fontSize: 12.5, margin: "8px 0 0", lineHeight: 1.5 }}>
          {dateProblem}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button
          type="button"
          className="ll-btn gold"
          style={{ minHeight: 44, flex: "1 1 200px" }}
          disabled={busy || !ready}
          autoFocus={prefilled}
          onClick={submit}
        >
          {busy ? "Recording…" : ready ? `Record ${money(parseAmount(amount))}` : "Record"}
        </button>
        <button type="button" className="ll-btn ghost" onClick={p.onBack} disabled={busy}>Back</button>
      </div>

      {refusal && (
        <div>
          <div className="ll-notice" role="alert" style={{ marginTop: 10 }}>{refusal}</div>
          {refusal.includes("Money not against a bill") && (
            <Link className="ll-btn ghost sm" href="/park/rent" style={{ marginTop: 8 }}>Money not against a bill</Link>
          )}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------- after tap three ---

export function Recorded(p: {
  parkId: string;
  outcome: Outcome;
  signal: string;
  receipt: ReceiptLines | null;
  renterEmail: string | null;
  onClose: () => void;
  onAnother: () => void;
}) {
  const { headline, detail } = recordedWords(p.outcome, p.signal);
  const namesHeldMoney = p.outcome.onAccount > 0 || p.outcome.path === "account";
  return (
    <div>
      <p style={{ fontSize: 16, fontWeight: 800, margin: 0, lineHeight: 1.4 }}>{headline}</p>
      {detail && (
        <p className="mut" style={{ fontSize: 13, marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>{detail}</p>
      )}
      {namesHeldMoney && (
        <Link className="ll-btn ghost sm" href="/park/rent" style={{ marginTop: 8 }}>Money not against a bill</Link>
      )}
      {p.receipt && (
        <ReceiptPanel parkId={p.parkId} receipt={p.receipt} renterEmail={p.renterEmail} onClose={p.onClose} />
      )}
      <button type="button" className="ll-btn ghost" onClick={p.onAnother} style={{ marginTop: 10 }}>
        Take another payment
      </button>
    </div>
  );
}
