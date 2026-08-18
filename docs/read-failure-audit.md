# When a failed read becomes a confident sentence

**Written 17 Aug 2026, after one cosmetic symptom turned out to have a very
large family.**

---

## The symptom, and why it wasn't cosmetic

One load of `/parks/my` rendered "Lot 7 · your park" instead of the park's
name. The next load was correct. A transient — apparently harmless.

The cause is not harmless. Every database read in this app is written the same
way:

```ts
const { data: park } = await admin.from("parks").select(...)
```

The library returns `{ data: null, error }` when a read fails. Written like
that, **a dropped connection and an empty table are the same value.** The code
then takes its empty-case branch, which is almost always a calm sentence
written for the case where the row genuinely is missing.

Those sentences don't look like faults. They look like facts.

## It is happening now, not hypothetically

While testing the fix, three genuine **Cloudflare 502s in front of Supabase**
landed within a few minutes, on this database. The captured error page carries
digest `3948815474` — one of the real failures, not the one being simulated.

This has been invisible because every failure resolved into a plausible
sentence and nothing was written to a log.

---

## What a resident, a crew and an owner were being told

23 of these were confirmed by opening the render path and tracing a failed read
to the exact string on screen. A sample, worst first:

### Money that moves, or appears to

| What the screen said | What was true |
|---|---|
| "Paid — thank you. It's on your ledger straight away." | The card was charged on a bill the resident had **formally disputed**. The disputed-bill guard counted claims and read `(count ?? 0) > 0` — a failed count is `null`, so the guard **passed**. Migration 0074's trigger then marked the claim `matched`, closing the dispute as conceded and erasing the evidence. **FIXED** |
| One `$450.00` line with a "paid" pill | The card was charged **twice**. Billing history is built from invoices only, never from payments, so the second charge is invisible on screen while a second receipt email goes out. |
| "Charged: $450.00 to your Visa ending 4242." | The " (after $50.00 in referral credits)" clause is silently absent — while `/billing` still shows the customer a $50 credit balance. |
| "$790.00 — One all-in price. No add-ons, no surprises." | The breakdown beneath it totals `$450.00`. |
| "Book — $0" on an enabled confirm button | A winter storage package that is not free. |
| "You're all set! 🎉" with every service quoted at zero | Guided setup, at the moment the customer decides to trust the price. |

### Crews who cannot get paid

| What the crew saw | What was true |
|---|---|
| "Where should the money land? 🏦" with blank routing and account fields, and no Cancel button | Their bank details are already encrypted on file. This asks a contractor to re-key a bank account — the exact shape of a phishing screen. |
| "Add your bank details first — that's where the money lands." | Bank on file; the payout never queued. |
| "$0.00 this week · $0.00 this month · $0.00 year to date" | Real completed, photo-verified work. |
| The "$412.50 released and ready" card simply absent | Money was payable. |
| "No rate yet — no rate, no routing." | Rates were saved. |

### Owners and ops

| What the screen said | What was true |
|---|---|
| "Nothing billed yet this month." on `/park/rent` | 19 charges raised and open. The screen asserts a settled month. |
| "Owed this month · — · not billed yet · about $8,645" | Contradicts itself in one line. |
| Storage meter reading "⏱ $N" and climbing | The boat was already back in the water. |

### Identity — the ones that deny somebody exists

| What the screen said | Who saw it |
|---|---|
| "No lot on your account. We looked for a tenancy attached to this sign-in and didn't find one… ring them and they can join the two up." | A resident with a live tenancy. **FIXED** |
| "Nothing to pay right now. Your next bill hasn't been sent yet." | A resident who owes this month's rent. **FIXED** |
| "We can't find a lot on your account." | Same, on the booking path. |
| A published park's public page returning **404** | A live park. |

---

## Scale

- **129** read sites touching money or identity, across every area of the app.
- **30** examined adversarially; **24 confirmed**, 6 refuted.
- The remaining ~100 are **candidates, not confirmed** — the pattern is present,
  the user-visible consequence was not individually traced.

Concentrations: `src/lib/automation.ts` (the cron and money-close engine),
`src/lib/refund-core.ts`, `src/app/ops/refund-actions.ts`,
`src/app/park/ledger-actions.ts`, `src/app/vendor/*`.

## Fixed so far

| File | What changed |
|---|---|
| `src/app/parks/my-data.ts` | All 9 reads. Identity and money reads throw; the maintenance list degrades with a visible "we couldn't look". |
| `src/app/parks/pay-actions.ts` | All reads in `payRent` and `sayIPaid`, including the guard that failed open and charged a disputed bill. |
| `src/app/parks/my/error.tsx` | The app's **first error boundary**. There were none. |
| `src/lib/must-read.ts` | `mustRead` / `mustCount` / `softRead`. |

## The rule, for anything built from here

> On a screen where the answer is somebody's identity or somebody's money,
> every read either produces the truth or produces an error. It never produces
> a reassuring guess.

Two shapes, and the difference matters:

- **Fails closed** — the check refuses. Safe, but the message is a lie
  ("That isn't your bill"). Fix the message.
- **Fails open** — the check *passes* because it could not run. This is the one
  that moves money. `(count ?? 0) > 0` on a failed count is the signature.

## Suggested order

1. **Anything that charges a card or releases a payout** — `refund-core.ts`,
   `automation.ts`'s charge and payout paths, `ops/refund-actions.ts`. Look for
   fails-open guards first.
2. **The crew-facing bank and earnings screens.** A contractor asked to re-key
   their account number is a trust problem, not a bug report.
3. **The park owner's rent screens** before January billing.
4. The rest, as each area is touched.

## Still unknown

Why the 502s are happening — database tier, cold start, or genuine flakiness.
Now that these reads log by name, the rate is measurable. That number is worth
watching the way the SMS-health panel is.
