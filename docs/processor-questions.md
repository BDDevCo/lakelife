# Processor call — what to ask, and what to bring back

**Status: BLOCKED on this.** ACH is the preferred rail and it does not exist
yet. Online rent today runs on the card path with a mock processor. Nothing
should be sold to a resident until this call happens.

Written 2026-08-13. Brendon has a processor relationship; these are the
answers that decide what gets built.

---

## Why it matters, in money

The Haven is ~$5,200/month.

| Rail | Cost per month | Per year |
|---|---|---|
| Card at ~2.9% + 30¢ | ~$155 | **~$1,860** |
| ACH at ~0.8% capped ~$5 | ~$19 | **~$230** |

That gap is the whole reason ACH goes first. Cards suit the small, impulsive
service purchase; rent is large and recurring.

---

## The four that change what gets built

### 1. ACH returns — the one that actually matters
- Do they support **ACH debit** (pulling from a customer account)? Rate, cap?
- Bank verification: **instant** (Plaid / Financial Connections) or
  **micro-deposits**? Micro-deposits mean a 1–2 day wait before a resident can
  pay at all, which changes the sign-up flow.
- **Which webhook fires on a return, how fast, and with what codes?**

  This is the crux. A card declines while the customer is standing there. ACH
  *succeeds*, then reverses 3–5 business days later — insufficient funds,
  account closed — long after we issued receipt #7 and told the resident
  "Paid in full". Everything in the ledger today assumes a payment is final
  the moment it is recorded.

  So real ACH needs a **pending → cleared → (or returned)** state: a receipt
  that says "clearing", a webhook that confirms or bounces, and a bounce that
  reverses the payment and tells both parties. That is the actual build, it is
  ours and not the processor's, and it cannot be designed until we know what
  they send us.

### 2. Debit vs credit, before the charge
- Can they apply a card surcharge for us, or must we compute it?
- **Do they tell us the funding type (debit or credit) BEFORE we charge?**

  Surcharging a **debit** card is prohibited by network rules at any rate, in
  every state. `payment_methods` records a brand but no funding type. If the
  processor cannot distinguish them, the 4% cannot be applied safely at all
  and the dial has to stay at 0.
- Do they handle **network surcharge registration** (~30 days' notice to
  Visa/Mastercard), or is that ours to file?

### 3. Statement descriptor, per transaction
- Can we set it per charge? Rent must read **THE HAVEN**, not LakeLife — it is
  the park's money and an unrecognised statement line is how a chargeback
  starts. `rentDescriptor()` already composes this; we need the processor to
  honour it.

### 4. Hosted fields / tokenization
- Confirm card data never reaches our servers (hard rule 4 in CLAUDE.md).
  We build against `LakeLifePayments.tokenize()` / `.charge()`; their SDK has
  to fit that shape.

---

## Ask only if a second park is on the horizon

- **Connected / sub-merchant accounts.** The Haven is Brendon's own park, so
  collecting its rent is him collecting his own money — clean. The moment
  LakeLife collects rent for a park he does NOT own, we are holding other
  people's money, which is money-transmission and property-management
  licensing territory. That is a product decision, not a feature one.

---

## The one number to fix regardless

`parks.card_fee_pct` currently defaults to **4.00** (0109), because that is
what was asked for. **Visa caps a surcharge at 3%** (reduced from 4% in 2023);
Mastercard allows 4. A blanket 4% is over Visa's ceiling and risks card
acceptance. Set it to 3 before switching online rent on:

```sql
update public.parks set card_fee_pct = 3.00;
```

---

## Where the code is

| Thing | File |
|---|---|
| Taking a rent payment | `src/app/parks/pay-actions.ts` |
| The fee dial + fee column | migration `0109` |
| Statement descriptor | `src/lib/descriptor.ts` (`rentDescriptor`) |
| The mock rail | `src/lib/payments.ts` |
| Park's online-rent switch | `parks.accepts_online_rent` (0108) |
