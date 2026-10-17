"use client";

import { useState } from "react";
import { LakeLifePayments } from "@/lib/payments";
import {
  savePaymentMethod,
  saveBankAccount,
  removePaymentMethod,
  listPaymentMethods,
  type SavedCard,
} from "@/app/profile/payment-actions";
import { toast } from "@/components/Toast";

/**
 * TWO RAILS, ONE WALLET (0197).
 *
 * A bank account was not addable at all until 0197: this table was
 * card-shaped — brand, expiry, funding — so the ACH half of the ledger, which
 * the database and five screens have modelled since 0155, had no way to
 * begin. Paying rent from a bank account costs the park about $230 a year at
 * The Haven against roughly $1,860 on cards, and that saving is the owner's
 * because rent settles to their own merchant account.
 *
 * A BANK ROW RENDERS DIFFERENTLY BECAUSE IT IS DIFFERENT. It has no brand and
 * no expiry, so the card row's `exp {exp_month}/{exp_year}` line would read
 * "exp NaN/ed" on one — the shape of bug this codebase calls a number nobody
 * set. It gets the institution and which of two kinds instead.
 */
export function PaymentMethods({ initial }: { initial: SavedCard[] }) {
  const [cards, setCards] = useState<SavedCard[]>(initial);
  const [adding, setAdding] = useState(false);
  const [addingBank, setAddingBank] = useState(false);
  const [busy, setBusy] = useState(false);
  const [number, setNumber] = useState("");
  const [exp, setExp] = useState("");
  const [cvc, setCvc] = useState("");
  const [name, setName] = useState("");
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [accountKind, setAccountKind] = useState<"checking" | "savings">("checking");
  const [bankName, setBankName] = useState("");

  async function refresh() {
    // listPaymentMethods THROWS on a failed read rather than handing back an
    // empty wallet. A rejection here would be unhandled inside a click handler
    // and would leave this list silently stale, so catch it, say so, and KEEP
    // the cards we already have — clearing them would claim they have none on
    // file. (Nothing narrower is possible: a server action's rejection reaches
    // the browser as an opaque error, so ReadFailed cannot be told apart here.)
    try {
      setCards(await listPaymentMethods());
    } catch {
      toast("We couldn't refresh your saved cards just now — reload the page to see the latest.");
    }
  }

  async function addCard() {
    setBusy(true);
    // Tokenize in the browser — the card number never reaches our server.
    const res = await LakeLifePayments.tokenize({ number, exp, cvc, name });
    if (!res.ok || !res.token) {
      setBusy(false);
      toast.err(res.error ?? "Couldn't add that card.");
      return;
    }
    const saved = await savePaymentMethod(res.token);
    setBusy(false);
    if (!saved.ok) {
      toast.err(saved.error ?? "Couldn't save that card.");
      return;
    }
    setNumber(""); setExp(""); setCvc(""); setName("");
    setAdding(false);
    toast("Card saved — you'll only be charged after a service is completed.");
    refresh();
  }

  /**
   * THE ROUTING AND ACCOUNT NUMBERS NEVER LEAVE THIS FUNCTION, exactly as the
   * card number never leaves `addCard`. `tokenizeBank` validates the pair —
   * including the ABA checksum, which catches the transposed digit that would
   * otherwise come back days later as an R04 return with a fee attached — and
   * returns a token, four digits and which kind. Nothing else is kept.
   */
  async function addBank() {
    setBusy(true);
    const res = await LakeLifePayments.tokenizeBank({ routing, account, accountKind, bankName });
    if (!res.ok || !res.token) {
      setBusy(false);
      toast.err(res.error ?? "Couldn't add that account.");
      return;
    }
    const saved = await saveBankAccount(res.token);
    setBusy(false);
    if (!saved.ok) {
      toast.err(saved.error ?? "Couldn't save that account.");
      return;
    }
    setRouting(""); setAccount(""); setBankName(""); setAccountKind("checking");
    setAddingBank(false);
    toast("Bank account saved. A bank payment takes a few working days to land.");
    refresh();
  }

  async function remove(id: string) {
    const res = await removePaymentMethod(id);
    if (!res.ok) {
      toast.err(res.error ?? "Couldn't remove that card.");
      return;
    }
    toast("Removed.");
    refresh();
  }

  return (
    <div className="ll-card ll-card-pad">
      <h3 style={{ fontSize: 16, marginBottom: 4 }}>Payment methods</h3>
      <p className="mut" style={{ fontSize: 13, marginBottom: 14 }}>
        Autopay charges your card or bank account <b>only after a service is
        completed</b> and its photos are uploaded — never before. A bank
        payment has no card fee and takes a few working days to land.
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
                  {c.kind === "bank" ? (c.bank_name ?? "Bank") : (c.brand ?? "Card")}
                </span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>•••• {c.last4}</div>
                  <div className="mut" style={{ fontSize: 12 }}>
                    {/* NO EXPIRY ON A BANK ROW. It has none, and the card
                        line's padStart/slice on a null renders "exp NaN/ed". */}
                    {c.kind === "bank"
                      ? (c.account_kind === "savings" ? "savings account" : "checking account")
                      : `exp ${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}`}
                    {c.is_default ? " · autopay on completion" : ""}
                  </div>
                </div>
              </div>
              <button className="ll-btn ghost sm" onClick={() => remove(c.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {!adding && !addingBank && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button className="ll-btn ghost" onClick={() => setAdding(true)}>+ Add a card</button>
          <button className="ll-btn ghost" onClick={() => setAddingBank(true)}>+ Add a bank account</button>
        </div>
      )}

      {addingBank && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
          <div className="ll-field">
            <label>Routing number</label>
            <input inputMode="numeric" placeholder="074000010" value={routing}
                   onChange={(e) => setRouting(e.target.value)} />
          </div>
          <div className="ll-field">
            <label>Account number</label>
            <input inputMode="numeric" placeholder="000123456789" value={account}
                   onChange={(e) => setAccount(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Checking or savings</label>
              <select value={accountKind}
                      onChange={(e) => setAccountKind(e.target.value === "savings" ? "savings" : "checking")}>
                <option value="checking">Checking</option>
                <option value="savings">Savings</option>
              </select>
            </div>
            <div className="ll-field" style={{ flex: 1 }}>
              <label>Your bank (optional)</label>
              <input value={bankName} onChange={(e) => setBankName(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="ll-btn" onClick={addBank} disabled={busy}>
              {busy ? "Saving…" : "Save bank account"}
            </button>
            <button className="ll-btn ghost" onClick={() => setAddingBank(false)} disabled={busy}>Cancel</button>
          </div>
          {/* WHAT A BANK PAYMENT IS ACTUALLY LIKE, said before they pick it.
              It is cheaper and slower, and "slower" is the part that causes a
              phone call if nobody mentions it. */}
          <p className="mut" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.5 }}>
            🔒 We never see or store your account number — only a secure token.
            A bank payment has no card fee, and takes a few working days to
            land; your ledger shows it as on its way until it does, and nobody
            will chase you for it in the meantime. (Test mode: this uses a mock
            processor, so try routing <b>074000010</b> and any account number.)
          </p>
        </div>
      )}

      {adding && (
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
