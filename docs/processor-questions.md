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

---

## Five more, from the go-live audit (5 Sep 2026)

Written after auditing every money path **as if the switch were already
flipped** — six lenses, 46 findings, 22 upheld by three independent skeptics
each. The four original questions above still stand. These are the ones the
audit added, and each one changes code rather than just settling a policy.

### 5. Idempotency — the key, and how long they honour it

The audit's single largest finding: **five of our six charge paths send no
idempotency key**, and every one charges the card *before* writing the row that
records it. A timeout between the two leaves money taken and nothing saying so,
and the nightly then charges again. We are fixing our half. Theirs:

- What do they call the field, and is it on the request or a header?
- **How long is a key honoured?** Ours is a nightly retry, so a 24-hour window
  is the exact boundary: too short and a crash is re-charged, too long and a
  genuinely declined card replays yesterday's decline instead of trying again.
- **Does a replayed key with a DIFFERENT amount replay, or error?** A customer's
  referral credit can change between attempts, so the amount can legitimately
  differ. We need to know which of the two happens.
- Does a key protect refunds as well as charges? Our refund door has no key at
  all today.

### 6. The webhook — names, signature, and redelivery

We have built the door (`POST /api/processor/webhook`, migration 0157) and it
records events verbatim without acting on them, because the state machine
cannot be designed until these answers exist.

- **Which header carries the signature, and what exactly is signed** — the bare
  body, or a timestamped string? Ours is HMAC-SHA256 over the raw body; the one
  function that changes is `signatureMatches`.
- **The exact event names** for: capture settled, refund completed, ACH return,
  dispute opened, dispute lost. We file events under whatever they send; the
  handler that drains them needs the real names.
- What id do they put on a delivery, and do they redeliver on a non-200?
- How long do they retry before giving up?

### 7. Funding type, before the charge — now a blocker, not a nicety

Question 2 above asked this. The audit makes it a **hard blocker**: The Haven
has `card_fee_pct = 3.00` and `accepts_online_rent = true` in production, and
the code applies that surcharge to every card. The day the switch flips, every
rent payment on a debit card is a network-rule violation.

Our fix surcharges **only** when funding is known to be `credit` — debit,
prepaid and unknown all surcharge zero, because unknown has to fail safe. So:

- Does `tokenize()` return the funding type, at save time, before any charge?
- If not, is it on the charge response — and if it is only there, we cannot
  surcharge at all and the dial stays at 0.

### 8. Settlement, so the two ledgers can be compared

There is no place today to sit what they say they settled beside what our
ledger says we collected, and with a real processor the two *will* diverge.

- Is there a settlement/payout report per day, with our `processor_ref` on each
  line, that we can pull by API?
- When does a card capture actually settle, and an ACH debit clear?
- What return codes should we expect on an ACH return, and do they map to
  anything we should show a resident?

### 9. The payout side — the bank, not the processor

Crews are paid by a CSV we hand a bank (`/api/ops/payout-export`), which
decrypts every crew's routing and account number into one download.

- Is there an API to originate these instead, so the file stops existing?
- **What comes back when a payout is returned** (wrong account, closed
  account), in what form, and how fast? Today a returned payout has nowhere to
  land: the batch stays `paid` and the crew's rows stay batched forever.
- Do they support a debit against a crew who owes us money after a clawback, or
  is netting against future earnings the only rail? (Today it is the only one,
  and a crew who ends up net-negative silently drops out of every run.)

---

## What is already fixed, so it is not re-asked

Branches from the 5 Sep audit, not yet merged: idempotency keys on every charge
and refund path; a charge that succeeded with a row that failed now always
alerts; the tip is claimed before the card is charged; a fixture crew can never
be paid; the webhook door and `processor_events`; the debit-surcharge fail-safe;
a database-level shape guard on `payment_methods.token`; the ACH-return column
on `park_payments` with `recompute_charge_paid` excluding returned rows.

**Still not built, deliberately**, because it is policy and not mechanism: what
an ACH return *does* — to the resident's receipt, their late fees, their
standing, and to a crew who has already been paid out of that money. That is
the first thing to decide once questions 6 and 8 are answered.
