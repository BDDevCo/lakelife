"use client";

import { useState } from "react";
import { LakeLifePayments } from "@/lib/payments";
import {
  savePaymentMethod,
  removePaymentMethod,
  listPaymentMethods,
  type SavedCard,
} from "@/app/profile/payment-actions";
import { toast } from "@/components/Toast";

export function PaymentMethods({ initial }: { initial: SavedCard[] }) {
  const [cards, setCards] = useState<SavedCard[]>(initial);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [number, setNumber] = useState("");
  const [exp, setExp] = useState("");
  const [cvc, setCvc] = useState("");
  const [name, setName] = useState("");

  async function refresh() {
    setCards(await listPaymentMethods());
  }

  async function addCard() {
    setBusy(true);
    // Tokenize in the browser — the card number never reaches our server.
    const res = await LakeLifePayments.tokenize({ number, exp, cvc, name });
    if (!res.ok || !res.token) {
      setBusy(false);
      toast(res.error ?? "Couldn't add that card.");
      return;
    }
    const saved = await savePaymentMethod(res.token);
    setBusy(false);
    if (!saved.ok) {
      toast(saved.error ?? "Couldn't save that card.");
      return;
    }
    setNumber(""); setExp(""); setCvc(""); setName("");
    setAdding(false);
    toast("Card saved — you'll only be charged after a service is completed.");
    refresh();
  }

  async function remove(id: string) {
    const res = await removePaymentMethod(id);
    if (!res.ok) {
      toast(res.error ?? "Couldn't remove that card.");
      return;
    }
    toast("Card removed.");
    refresh();
  }

  return (
    <div className="ll-card ll-card-pad">
      <h3 style={{ fontSize: 16, marginBottom: 4 }}>Payment methods</h3>
      <p className="mut" style={{ fontSize: 13, marginBottom: 14 }}>
        Autopay charges your card <b>only after a service is completed</b> and its
        photos are uploaded — never before.
      </p>

      {cards.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {cards.map((c) => (
            <div
              key={c.id}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 12, padding: "11px 13px", border: "1px solid var(--line)",
                borderRadius: 12, marginBottom: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span
                  style={{
                    fontWeight: 800, fontSize: 12, letterSpacing: ".04em", color: "var(--teal-dark)",
                    background: "#E0F0F3", padding: "4px 9px", borderRadius: 6, textTransform: "uppercase",
                  }}
                >
                  {c.brand ?? "Card"}
                </span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>•••• {c.last4}</div>
                  <div className="mut" style={{ fontSize: 12 }}>
                    exp {String(c.exp_month).padStart(2, "0")}/{String(c.exp_year).slice(-2)}
                    {c.is_default ? " · autopay on completion" : ""}
                  </div>
                </div>
              </div>
              <button className="ll-btn ghost sm" onClick={() => remove(c.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {!adding ? (
        <button className="ll-btn ghost" onClick={() => setAdding(true)}>+ Add a card</button>
      ) : (
        <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
          <div className="ll-field">
            <label>Card number</label>
            <input inputMode="numeric" placeholder="4242 4242 4242 4242" value={number} onChange={(e) => setNumber(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Expiry (MM/YY)</label>
              <input placeholder="12/28" value={exp} onChange={(e) => setExp(e.target.value)} />
            </div>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Security code</label>
              <input inputMode="numeric" placeholder="123" value={cvc} onChange={(e) => setCvc(e.target.value)} />
            </div>
          </div>
          <div className="ll-field">
            <label>Name on card (optional)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="ll-btn" onClick={addCard} disabled={busy}>{busy ? "Saving…" : "Save card"}</button>
            <button className="ll-btn ghost" onClick={() => setAdding(false)} disabled={busy}>Cancel</button>
          </div>
          <p className="mut" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.5 }}>
            🔒 We never see or store your card number — only a secure token. (Test mode:
            this uses a mock processor; try card <b>4242 4242 4242 4242</b>, any future
            expiry and any 3 digits. Real card processing gets wired in later.)
          </p>
        </div>
      )}
    </div>
  );
}
