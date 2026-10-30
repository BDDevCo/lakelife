# What we need from US Card Solutions

**Written 29 October 2026, after the 28 Oct meeting.** Ordered by what it
unblocks, not by how hard it is to ask. The first question is worth more than
the rest put together.

Everything in this product that touches rent is built and switched off behind
one environment variable. None of it can be finished against a contract we are
guessing at.

---

## 0. First, confirm who we are dealing with

**US Card Solutions describes itself as an ISO/agent** — a registered
ISO/MSP of a sponsor bank — and a review site reports it resells **Fiserv,
TSYS and North American Bancard**. That is completely normal and not a
problem. It is just the fact that decides everything below.

Also worth thirty seconds, because the names are confusable: **US Card
Systems** (a Worldpay reseller), **Usio** and **Card Solutions International**
are different companies. Confirm the legal entity on the agreement.

---

## 1. THE ONE THAT UNBLOCKS EVERYTHING

> **Whose platform are we on — Fiserv, TSYS, North American Bancard, or
> something else?**

Every technical answer below is really that platform's answer. Ask it first
and most of this document answers itself from their public documentation.

---

## 2. Boarding a park owner — "one-click"

The application screen is built. It fills **11 of 15 fields** from what the
park owner has already given us, including the two an underwriter usually
stalls on — expected monthly volume and average payment — computed from the
park's own rent roll. It asks for the four nothing could know: legal name,
business type, EIN, and the control person's title.

What we need to finish it:

1. **The actual application form.** You said you'd get this. We will diff it
   against our fifteen fields and move what differs. *Send it over and this
   is a half-day.*
2. **Is there a boarding API, or is it a portal/PDF?** Both are workable and
   they are different builds:
   - **API** → one tap submits and we store their merchant id.
   - **No API** → one tap produces a complete, validated application and a
     person submits it. Still worth doing; the owner's effort is identical.
3. **If there is an API:** endpoint, auth, field names, and whether the
   decision is **synchronous or asynchronous**. If async, how does the
   approval reach us — webhook, poll, or an email to a human?
4. **What does a decline look like**, and can it be re-submitted after a fix?
   *Our registry treats a rejection as final and re-applies as a new account,
   which is the safe reading — tell us if theirs is kinder.*
5. **The merchant id format**, so we store theirs rather than inventing one.

> **One honest note on "one-click".** A park owner becoming a merchant is being
> underwritten, and underwriting can decline. One click is the right target for
> the *effort* — it cannot promise the *outcome*. Our software already models
> that properly. The screen's wording just has to match whatever is true.

---

## 3. Taking the money — the four that change code

1. **Hosted fields / tokenization.** Card data never touches our database;
   that is a hard rule. We build against `tokenize()`. **Does their SDK fit
   that shape, and does it tokenize a BANK ACCOUNT as well as a card?**
2. **Does tokenize return the funding type — credit or debit — BEFORE the
   charge?** This one is a hard blocker, not a nicety. Surcharging a **debit**
   card is prohibited by network rules in every state, at any rate. The Haven
   is set to a 3% card fee. If we cannot tell credit from debit before
   charging, **the surcharge cannot be applied safely at all and the dial stays
   at zero.** Our code already fails safe — it surcharges only a card known to
   be credit — but the dial is money to the park owner.
3. **Statement descriptor, per transaction.** Rent must read **THE HAVEN**,
   not LakeLife. An unrecognised statement line is how a chargeback starts.
   `rentDescriptor()` already composes it; we need them to honour it.
4. **Idempotency.** What is the field called, is it a header or a body field,
   **how long is a key honoured**, and does a replay with a *different amount*
   replay or error? Ours is a nightly retry, so a 24-hour window is the exact
   boundary.

---

## 4. ACH — who actually provides it

Their public site describes card processing, POS and faster funding. **We
found no ACH offering for this company**, so renter ACH presumably comes
through a partner.

- **Who provides it, and is it the same platform as the cards?**
- **Bank verification: instant (Plaid-style) or micro-deposits?** Micro-deposits
  mean a 1–2 day wait before a resident can pay at all, which changes the
  sign-up flow.
- **The return codes, their meanings, and how they reach us.** This is the
  crux. A card declines while the customer is standing there; ACH *succeeds*
  and then reverses days later, long after we issued a receipt. We already
  classify returns into three different next actions, **and one of them is
  "do not debit that account again"** — the codes where authorisation was
  denied or withdrawn, which it is a rule violation to re-present. If their
  codes are not the NACHA codes, we need the mapping in writing.

---

## 5. The webhook — the only thing blocking the drain

Our webhook door is live. It verifies an HMAC, refuses without a secret,
records every delivery verbatim, and **acts on none of them on purpose**,
because the handler cannot be written against guessed event names.

- **Which header carries the signature, and what exactly is signed** — the raw
  body, or a timestamped string?
- **The exact event names** for: capture settled, refund completed, ACH
  return, dispute opened, dispute lost.
- **What id is on a delivery, do they redeliver on a non-200, and for how
  long?**

---

## 6. Settlement, so two ledgers can be compared

- **Is there a daily settlement report, by API, with our reference on each
  line?** With a real processor the two *will* diverge, and today there is
  nowhere to sit what they say they settled beside what we say we collected.
- **When does a card capture actually settle, and an ACH debit clear?**

---

## 7. Commercial, and the structural confirmations

- **Rates**: card, and ACH (rate and cap). The gap is the whole reason ACH
  goes first — roughly $1,860/year versus $230/year on The Haven's rent.
- **Any per-merchant monthly or statement fee a park owner would pay**, since
  that is a number we have to show them before they apply.
- **Reserves** — can one be required, and on what notice? *A reserve breaks
  the promise that nobody has to open an account or hold a balance, so we need
  to know the terms before we make that promise to a park owner.*
- **1099-K**: who issues it to the park owner, and at gross or net?
- **Confirm in writing, because the whole architecture rests on it:**
  - the **park owner** is the merchant of record for rent and settles into
    the account they already have;
  - **LakeLife is never in the flow of funds for rent**;
  - **crews need nothing at all** — no merchant account, no underwriting. They
    are paid by us as contractors, out of our own bank.

---

## What we do NOT need from them

Worth saying, because it shortens the call and it is the part that changed:

- **Nothing for crews.** No sub-merchant onboarding, no split settlement, no
  per-payee anything. Crews are our accounts payable, paid from Mercury. A
  sub-merchant crew would also receive a **1099-K at gross**, which would hand
  every crew our margin by IRS mail.
- **No pooling, no FBO, no balance held with them.** Rent settles
  owner-direct; service money is our own revenue.

---

## The three that matter most, if the call is short

1. **Whose platform are we on?**
2. **Is there a boarding API, and can we have the application form?**
3. **Does tokenize tell us credit or debit before the charge?**

Related: `docs/the-money-architecture-as-decided.md` (the decided structure),
`docs/processor-questions.md` (the longer history; its provider shortlist is
superseded), `docs/how-a-crew-gets-paid.md` (why crews need nothing from them).
