# The end goal, defined: what "plug in the processor and go" actually means

**Written 20 October 2026. Every claim below was checked against the code and
against the production database on that date, not asserted from memory.**

Brendon, 20 October 2026: *"we need to get to a point where we just plug in the
processor, bank for the platform and we can get rolling."*

This document is the definition of done for that sentence. It exists because
"nearly ready" is not a state anybody can act on, and because the difference
between *a thing we have not built* and *a thing we cannot build until somebody
answers a question* is the only distinction that decides what to do next.

---

## 1. The one-paragraph version

**The money rails are built, proven against production, and switched off behind
one environment variable.** Turning them on requires six secrets, one adapter
file rewritten against a real SDK, and one handler written against real event
names. Nothing else in the application has to change. Three things are
genuinely blocked on the processor's answers and must not be guessed; two more
are commercial decisions that are yours, not the software's.

On the day it all arrives, the sequence is: set the secrets → swap the adapter →
write the drain → run one park for one month → flip the flag in production.

---

## 2. What "rolling" means, precisely

Four money flows have to work. They are not equally far along, and they are not
equally urgent.

| Flow | Direction | Needed by | State |
|---|---|---|---|
| **A. Rent, hand-keyed** | resident → park owner, cash/cheque, recorded by the office | **1 Jan 2027** | **DONE and proven.** Needs no processor at all. |
| **B. Rent, online** | resident → park owner's own merchant (card or bank) | when a park wants it | Built end to end. Switched off. Needs the processor. |
| **C. Service work** | homeowner → LakeLife, crew paid from it | spring 2027 | Charge path built and reachable. Switched off. Needs the processor. |
| **D. Crew payouts** | LakeLife → crew's own bank | with C | **The weakest link.** A bank-file CSV today; should be split settlement. |

**Flow A is the January deadline and it does not depend on any of this.** Every
household at The Haven signs on 1 January and pays the office; the ledger
records it, the bills settle, and the chain has been walked against production
repeatedly. If the processor conversation went silent tomorrow, January still
works. That is deliberate, and it is the single most important fact in this
document.

---

## 3. The plug-in points — the complete list

### 3a. Six secrets (yours)

| Secret | What it gates | State |
|---|---|---|
| `LAKELIFE_PAYMENTS_LIVE` | **The master switch.** `charge()` and `refund()` decline every call while this is not `"true"` — and a preview deployment declines regardless. | absent from Vercel — verified 20 Oct, correct |
| processor API key(s) | the real charge/refund calls | not yet issued |
| `PROCESSOR_WEBHOOK_SECRET` | the webhook refuses every delivery without it | absent from Vercel — verified 20 Oct |
| `PROCESSOR_WEBHOOK_SIGNATURE_HEADER` | which header carries their signature | defaults to `x-processor-signature` |
| `PROCESSOR_NAME` | files events under a provider name | defaults to `"unknown"` |
| `BANK_ENCRYPTION_KEY` | seals crew bank numbers; **three crew screens now say so instead of taking details they cannot keep** | **absent from Vercel entirely — verified 20 Oct** |

Also owed and unrelated to the processor: **`CRON_SECRET` was last written on
23 July 2026** (read off Vercel), and rotating it means changing Vercel *and*
the pg_cron command together.

### 3b. One adapter file (mine, ~a day once keys exist)

`src/lib/payments-server.ts` holds the mock. Two functions, and the contract
the whole application already speaks:

```
charge({ token, amountCents, description?, idempotencyKey? })
  → { ok, error?, ref?, amountCents?, reason? }

refund({ chargeRef, amountCents, idempotencyKey? })
  → { ok, error?, ref?, amountCents?, reason? }
```

Every money path in the application goes through `charge-gate.ts`, which is the
only module permitted to call these. Nothing else needs touching: the ledger,
the idempotency keys, the receipts, the surcharge rules, the refund ledger and
the arrears maths are all written against this shape and tested against the
mock.

`src/lib/payments.ts` holds the browser half — `tokenize()` for a card and
`tokenizeBank()` for a bank account. Hosted fields replace both. **Card and
bank numbers have never touched the database and there is no column for
either**; a migration post-condition fails the deployment if a column on
`payment_methods` is even *named* like a bank credential.

### 3c. One handler that does not exist (mine, blocked)

`POST /api/processor/webhook` is live: it verifies an HMAC, refuses when no
secret is set, records every delivery verbatim in `processor_events` with
`processed_at` null, and **acts on none of them, on purpose.**

**The drain — the thing that turns an event into a ledger write — cannot be
written until we know their event names.** Guessing would be an integration
written against a contract that does not exist, in the one direction where
being wrong marks money as landed when it has not.

In the meantime the ops console counts unread deliveries, so the first event
they ever send is noticed rather than piling up in a table nothing reads.

---

## 4. The three things genuinely blocked on them

These are in `docs/processor-questions.md` and in the PDF handed over. They are
not nice-to-knows; each one decides what gets built.

1. **Can rent settle directly into each park owner's own bank account, with
   LakeLife as integrator and the owner as merchant?** If the answer is no, Flow
   B does not launch on that structure — we will not have rent touching a
   LakeLife balance. Everything about Architecture A follows from this answer.
2. **Their ACH return codes, their meanings, and the delivery mechanism.** We
   classify a return into three different next actions and one of them is *do
   not debit that account again* — the codes where the account holder denied or
   withdrew authorisation, which it is a rule violation to re-present. If their
   codes are not the NACHA codes we need the mapping in writing.
3. **Can a crew be onboarded as its own merchant and receive its share as a
   split at settlement?** This is Flow D's real answer and the reason the bank
   file should stop existing.

Two more that shape the build but do not block it: whether their hosted fields
tokenize a **bank account** as well as a card, and whether a merchant's
approved rails are readable per merchant through the API.

---

## 5. The two decisions that are yours, not the software's

1. **Does a bounced crew payout email the crew?** Their own screen now tells
   them, in words that lead with "the money is still yours". Nothing sends.
   The channel exists — the referral run already emails statements — so this is
   a choice about tone and timing, not a missing capability.
2. **What a return costs the resident.** Built: the payment keeps its receipt,
   stops counting, the bill reopens, a refund against it is refused, and the
   office is told whether that account may be debited again. Deliberately *not*
   decided: whether a return costs them a fee, withdraws their receipt, makes
   the reopened bill late from its original due date, or affects their standing.

---

## 6. What is already true, so nobody re-does it

Each of these was proven against the production database inside a transaction
that rolled back, on the date given.

- **The January chain.** Pre-cutover refused; January open at 0.00; a cheque
  settling to paid/542.53 on arrival; a double idempotency key refused; delete
  and amount-rewrite refused; an online payment without a processor reference
  refused; a future-dated receipt refused. 15 guards.
- **The bank rail, end to end.** A bank method saved unsurchargeable; an ACH
  debit recorded provisional with the bill staying open; a surcharge on it
  refused; cleared → paid/542.53; returned → open/0.00 with the receipt intact;
  and a cheque still settling on arrival beside it.
- **A refund against money that has not landed is refused** — at the database
  and in words, since the day the bank rail gained an inlet made that state
  reachable.
- **Who the money settles to**, per park, per rail: a registry holding four
  digits and no credentials, with a per-rail capability each doorway checks.
- **A live merchant can be stopped and its settlement account corrected**, and
  the screen says the correction changes *our record*, not the destination.
- **Card data and bank numbers have never been in the database.** Verified
  live: no card column exists, and anon has no read on `payment_methods`.

---

## 7. The order of operations on go-live day

1. **Secrets in**, Vercel Production, marked Sensitive, and into the password
   manager. `LAKELIFE_PAYMENTS_LIVE` stays `false`.
2. **Adapter swapped** against their sandbox. The flag goes `true` in a
   *staging* environment only — which is itself blocked on the staging split
   below.
3. **The drain written** against their real event names, with a sandbox account
   that returns an ACH debit on demand. The return path is the half we cannot
   currently exercise at all.
4. **One park, one month, both rails**, with the return path tested before any
   resident touches it. Reconcile their settlement report against our ledger
   line by line.
5. **Then, and only then,** the flag flips in production.

**Step 2 has a prerequisite nobody has done yet: there is no staging.**
Verified on Vercel, 20 October 2026 — not remembered:

```
SUPABASE_SERVICE_ROLE_KEY   target: ["production", "preview"]
NEXT_PUBLIC_SUPABASE_URL    target: ["production", "preview"]
CRON_SECRET                 target: ["production", "preview"]
GATE_ENCRYPTION_KEY         target: ["production", "preview"]
TWILIO_*, RESEND_API_KEY    target: ["production", "preview"]
```

Every pull-request preview deployment runs against the live database with the
live service-role key, holding the live cron secret and live Twilio and Resend
credentials. Turning the payments flag on in a "staging" environment today
would turn it on against production data.

**A code guard now stops the worst of it.** A preview deployment refuses to
send, to charge, or to run the nightly — one predicate, four doors, each
asking before it asks anything else. So a branch cannot email a homeowner,
cannot ring a verified mobile, cannot run the payout batch, and cannot debit a
card even if the flag is set on a scope it inherits.

**That is a seatbelt, not the fix.** The real fix is a second Supabase project
so preview has its own database — and that is a cost and a decision that are
yours, not something I should spend on your behalf. Until then preview is
blocked, which costs a developer a sentence on screen where the alternative
costs a homeowner a wrongly charged card.

I had this listed as "mine, nothing blocking" in an earlier draft of this
file. That was wrong: the guard was mine and is done; the staging database
needs you.

---

## 8. So what is left, honestly

| # | Thing | Owner | Blocked on |
|---|---|---|---|
| 1 | A preview deploy cannot send, charge or run the nightly | me | **DONE** |
| 1b | A staging Supabase project, so preview stops sharing the live DB | **you** | a cost decision |
| 2 | `BANK_ENCRYPTION_KEY`, `CRON_SECRET` rotation | you | nothing |
| 3 | The processor call (§4) | you | their calendar |
| 4 | The adapter | me | their keys |
| 5 | The drain | me | their event names |
| 6 | Crew merchants / split settlement | me | their answer to §4.3 |
| 7 | The two product decisions (§5) | you | nothing |
| 8 | A2P resubmission so texts send at all | you | pasting the message flow |

**Nothing on that list is "finish building the payment system."** That is the
answer to the question. The system is built; what remains is six secrets, a
sandbox, three answers, and one piece of infrastructure hygiene that should
have been done months ago.

---

## 9. How to keep this honest

This file goes stale the moment something ships. The rule: **a claim here is
either dated and proven against production, or it is marked as unverified.**
If a row in §6 cannot be re-proven by a rolled-back `DO` block today, it does
not belong in §6.

Related: `docs/processor-questions.md` (the questions themselves),
`docs/platform-readiness-2026-10-06.md` (the 6 October audit findings),
`docs/banking-questions.md` (the bank's side).
