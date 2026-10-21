# How a crew gets paid — and why a crew is never a merchant

**Written 20 October 2026.** Every claim here is either checked against this
repo, proven against the production database on that date, or carries a web
citation. Where I could not establish something, it says so. Same rule as
`go-live-definition.md` §9: dated and proven, or marked unverified.

Brendon, 20 October 2026:

> *"I dont want a crew to have to register for an additional merchant account,
> it needs to be seemless and have to not credit check or whatever that a
> typical merchant account needs"*

**He is right, and the way to get it is not the way I would have guessed.**
This document is the decision, the reasoning, the honest floor, and what it
changes about who we have to ask what.

---

## 1. The answer in one paragraph

A crew is never a merchant, and the way to guarantee that is **not to put the
crew on the payment processor at all.** LakeLife is the merchant of record for
service work: the homeowner buys from LakeLife at one all-in price, and the
crew is LakeLife's subcontractor, paid about 70%. So paying a crew is accounts
payable — the same act as paying any 1099 contractor — and it happens by ACH
credit from LakeLife's own business bank account against a W-9 the crew has
already given us. **No processor, no merchant account, no underwriting, no
credit check, no account anywhere, no approval to wait for.** The floor is a
W-9 and where the money lands, and we already collect the first one.

---

## 2. Why the instinct was right — the distinction that does the work

Two different things get called "onboarding" and only one of them is heavy.

| | A MERCHANT | A PAYOUT RECIPIENT |
|---|---|---|
| What it does | **accepts** payments from customers | only **receives** money |
| Who carries risk | the processor advances funds before settlement and absorbs chargebacks | nobody — no funds advanced, no chargeback possible |
| So it needs | credit pull, underwriting questionnaire, processing history, merchant agreement, possible reserve, days of waiting | identity and sanctions screening |

A LakeLife crew is in the right-hand column and always was. The crew never
takes a card, never sees the customer price (hard rule 1), and never has a
customer who could dispute a charge against it. There is no credit risk to
underwrite, so there is nothing a credit check would be for.

**One correction to my own first reasoning, because it matters.** I assumed
"ask the processor for their recipient product instead of their merchant
product" would settle it. It does not. Finix's own documentation says a payout
recipient's information **is sent to their underwriting systems**, that the
account sits in `PROVISIONING` and then becomes `APPROVED` or `REJECTED` after
underwriting, that they run global sanctions screening, and — with payout links
— that they "will review and conduct standard underwriting checks." Their
payouts pricing also lists a **per-payee onboarding fee**. So a crew put on
Finix Payouts *does* get onboarded, *can* be rejected, and costs us money per
head.

What is genuinely true is narrower and still useful: a processor's underwriting
**is a risk assessment, not a credit check in the lending sense**. So his
specific fear is not quite the same as the friction. But the friction is real
either way — a crew who gets `REJECTED` by a processor cannot be paid, and that
is a phone call nobody wants to make to the person who just mowed twenty lots.

**So the fix is structural, not a matter of shopping for a gentler processor.**
The industry's own framing: *under a marketplace-of-record model the
underwriting stays on the platform side; under a connected-account model the
sellers are onboarded and underwritten as sub-merchants.* We are the first one.
Pick the model and the question disappears instead of getting easier.

---

## 3. The second argument, which is the one that would have bitten us

Under a sub-merchant or split-settlement model, **the crew receives a 1099-K,
and a 1099-K reports GROSS.**

Gross is the full customer price. So every crew would be handed, by the IRS, a
document stating exactly what LakeLife charged the homeowner for their work —
and therefore our margin, to the dollar, for every job they did all year.

**That is hard rule 1 in CLAUDE.md, broken by a tax form.** "Vendors NEVER see
customer prices" is supposed to be enforced at the API and RLS level, and no
amount of RLS stops a 1099-K arriving in January. It would also simply be
*wrong* — a 70% subcontractor's income is not the gross sale.

Under merchant-of-record, LakeLife pays the crew directly and files a
**1099-NEC** for what it actually paid them. The right number, and no leak.
The user agreement already promises exactly this: crews "receive a 1099 as
required by law" (`docs/user-agreement-draft.md:214`), and the counsel draft
already defines *"Payment Processor"* as **LakeLife's** provider rather than
the crew's (`docs/user-agreement-counsel-draft-v2.txt:29`).

**The legal drafts were already right. It was my engineering docs that drifted.**

---

## 4. The floor — what a crew must give us no matter what

He is entitled to the honest version of this, because "seamless" has a floor
and it is better to know where it is.

| What | Why it is unavoidable | Do we already have it? |
|---|---|---|
| **A W-9** (name, address, TIN — EIN *or* SSN) | IRS. Without one, backup withholding at 24% applies to every payment. | **YES.** `vendors.w9_url`, and `activationGaps()` refuses to activate a crew without it. The agreement accepts **SSN or EIN**, so a sole proprietor needs no company. |
| **Where the money lands** — routing + account, or a debit card | Money has to go somewhere. | Collected on the "Get paid" screen, once. **Zero crews have given us one** (verified on production, 20 Oct). |
| **Identity / sanctions screening** | Federal law for anyone paying anyone. It is a name-and-address check, takes seconds, is invisible, and is **not a credit-bureau inquiry.** | Already contemplated in the agreement's grounds for withholding (`counsel-draft-v2.txt:108`). |

**And that is the whole list.** Everything else a merchant account asks for —
processing volume, average ticket, chargeback history, a website, a merchant
agreement, a credit pull, a reserve, an approval wait — a crew is never asked
for, because none of it is about receiving money.

What a crew is asked for *by LakeLife* beyond the floor is the COI and its
named insured, the services and lakes they work, their days and daily
capacity. Those are ours, they are about dispatching work safely, and they are
not a payment thing at all.

**Unverified and for the CPA, not for me:** the 1099-NEC filing threshold.
Sources conflict on whether the One Big Beautiful Bill Act moved it from $600
to $2,000 and from which tax year. Do not let anybody — including me — write a
number into the software until an accountant confirms it.

---

## 5. What this changes about who we have to ask

This is the part that is genuinely good news for the schedule.

### It REMOVES a blocker from the processor

`go-live-definition.md` §4 question 3 was:

> *"Can a crew be onboarded as its own merchant and receive its share as a
> split at settlement?"*

**Delete it.** It asks for the thing we have now decided against, and a "yes"
would have been the bad outcome. Crew pay is no longer waiting on the processor
conversation at all. Two questions remain worth asking, but neither blocks:

- Out of interest only: what does your recipient onboarding actually require,
  and is a consumer credit report pulled? *(Get it in writing. It is the
  fallback if LakeLife's own bank cannot originate credits.)*
- Push-to-card as a crew option: Visa Direct / Mastercard Send land money in
  minutes and need only a card. **But CLAUDE.md hard rule 4 forbids card data
  in our database**, so this only exists if their hosted fields tokenize a
  payout card. Worth knowing; not worth waiting for.

### It MOVES a blocker to the bank, where it is much easier

`banking-questions.md` §B4 already asks the right question and it is now the
one that matters:

> *"ACH origination — can we originate credits (paying crews)...? What are the
> per-transaction and daily limits, and how long until limits lift on a new
> account?"*

That is an ordinary question for a community banker, and it is the whole
dependency for crew pay. Ask it about **credits** specifically — paying crews
is outbound and has none of the complexity of the inbound rent debits.

### And it promotes `BANK_ENCRYPTION_KEY` from hygiene to a blocker

If LakeLife originates the ACH credit, **LakeLife holds the crew's routing and
account number** — sealed with `BANK_ENCRYPTION_KEY`, which is **absent from
Vercel in every environment** (verified 20 Oct). Today that is honest rather
than broken: `bankKeyConfigured()` is false, so three crew screens say "bank
payouts aren't switched on yet" instead of taking details they cannot keep.

But under this decision that key is not a nicety any more. **It is the thing
standing between a crew and being paid at all.** It is one command and it is
his:

```bash
openssl rand -hex 32
```

→ Vercel Production, marked Sensitive → and into the password manager.

**The one real cost of this decision, stated plainly.** We hold bank numbers
that, under the rejected sub-merchant model, the processor would have held for
us. That is the trade: the crew gives their details to us, once, and never
registers anywhere — or the crew registers with a processor and we never hold
anything. He has chosen the first, and it is the right choice for a crew, but
it does mean the custody is ours and the key is not optional.

---

## 6. What the money does, step by step

Flow C and D from `go-live-definition.md`, written out under this decision:

1. A homeowner books. **LakeLife** charges them one all-in price — LakeLife's
   own merchant account, LakeLife's own descriptor.
2. The job completes and clears the photo gate. A `payouts` row records the
   crew's take-home; the margin is LakeLife's and never appears to the crew.
3. Month-end (free) or on an early pull (the 2% dial), a `payout_batches` row
   claims those payouts and queues.
4. LakeLife originates one ACH credit per crew **from its own operating
   account** — today a CSV handed to the bank, which is the thing that should
   become an API call.
5. In January, LakeLife files a **1099-NEC** per crew for what it paid them.

Nowhere in that chain does a crew touch a processor. Steps 1–3 are built and
tested; step 4 is built as the CSV and blocked on the key and the bank; step 5
is the accountant's.

**Rent is a different animal and is unaffected.** A park owner **does** accept
money, so a park owner **is** a merchant, and `processor_accounts` exists for
exactly that. Nothing in this document touches Flow A or Flow B.

---

## 7. The guard, so this cannot drift back

Decisions in this repo become things the database refuses, not things a
document hopes for.

**Proven against production before the fix (20 Oct, rolled back):** a draft
crew row with `can_accept_card = true` was **accepted**, and so was a fully
active crew merchant carrying card *and* ACH with payouts switched off. The
registry would have recorded a crew as a live card-accepting merchant and
nothing would have objected — not through malice, but because 0196 wrote one
table for two kinds of recipient and gave both the same capabilities.

**Migration `0200_a_crew_is_paid_it_is_never_a_merchant.sql` closes it.**

```sql
check (
  vendor_id is null
  or (can_accept_ach is false and can_accept_card is false)
)
```

Plus a trigger clause that says it in words, because whoever trips this is a
developer months from now who needs to know it was a decision. **Proven after:**
crew+card refused, crew+ACH refused, crew live-merchant refused, crew payout
recipient accepted, **park card+ACH accepted, park live merchant accepted** —
that last pair being the assertion that matters most, since a constraint that
protected crews by breaking rent would be the worse bug.

Zero rows existed in the table, and zero crews have ever given us a bank
account. **There was nothing to backfill, which is the only cheap moment this
was ever going to have.**

`src/lib/a-crew-is-never-a-merchant.test.ts` pins it, including that 0200's
`create or replace` did not eat any of 0196's nine clauses — the mistake a
draft of 0198 already made once in this repo. Seven mutations turn it red.

---

## 8. What is deliberately NOT built, and why

**A payout is not gated on `can_receive_payout`.** It should be, eventually —
you must not originate to a recipient the processor has not accepted. It is not
built because it would be **a gate that can never open**: no application code
writes a vendor row in `processor_accounts` at all. Every door in
`src/app/parks/processor-actions.ts` is park-scoped — `assertParkOwner(parkId)`,
`.insert({ park_id: parkId, provider })`, and a queue selecting
`park_id, parks(name)`.

So `processor_accounts.vendor_id` is **a column with no writer**, and
`can_receive_payout` has no reader that decides anything — this repo's own
dominant bug class, in the very table built to end it. That is recorded here
rather than quietly fixed, because under this decision a crew may not even need
a row there. If LakeLife's bank originates the credits, a crew never appears in
the processor's world at all and `vendor_id` should arguably be dropped.

**That is a decision for after the banker answers**, and it is cheap to leave
alone: the column is empty, the constraint now makes the only rows it could ever
hold the right shape, and nothing reads it.

---

## 8a. The two handover PDFs were asking for the wrong thing

**This was the most consequential correction, because these are the documents
that actually get handed over** — not the ones in this repo.

`doc_processor.py` and `doc_banker.py` (one folder up, outside this public repo
because they carry entity details) generate
`LakeLife - Payment Processor Roadmap.pdf` and
`LakeLife - Banking Roadmap.pdf`. Both inherited the reversed decision and had
turned it into an explicit request:

- The processor brief's Step 7 said *"the right answer is that **a crew is its
  own merchant too**"* and asked *"Can a crew be onboarded as a merchant and
  receive its share **as a split at settlement**?"* — so the document going to
  the processor was asking them to underwrite every crew.
- The banker brief said the payout file would stop existing because *"each crew
  becomes its own merchant"*, and its money table said crew payables are *"not
  commingled with ours"*, which the code has never done.

**Both corrected and both PDFs regenerated on 20 October 2026**, and the new
text verified by extracting it back out of the PDFs rather than trusting the
generator. Step 7 is now titled *"Paying crews — and why we are NOT asking you
to onboard them"* and asks only the fallback question: is there an API to
originate credits, and if so, is a credit report pulled. The banker brief now
points at its own §B4.

The documents' own revision date moved to 20 October. **The dated statements of
record inside them did not** — "Until 17 October nothing in the application
could write…" is history and stays as written, and the processor brief now says
plainly which claims were checked on which date rather than re-dating a
verification that did not happen.

The originals are backed up in this session's scratch directory. These files
cannot be reached from the test suite, so this section is the record.

---

## 9. So what is actually left

| # | Thing | Owner | Blocked on |
|---|---|---|---|
| 1 | A crew can never be recorded as a merchant | me | **DONE** (0200) |
| 2 | `BANK_ENCRYPTION_KEY` in Vercel | **you** | one `openssl` command |
| 3 | "Can you originate ACH **credits**, and what are the limits?" | **you** | the banker's calendar |
| 4 | Bank-API origination replacing the CSV download | me | 2 and 3 |
| 5 | 1099-NEC threshold and filing mechanics | **you** | the CPA |
| 6 | Whether `processor_accounts.vendor_id` should exist at all | me | 3 |
| 7 | Tell a crew, in words, that we never credit-check them | me | nothing |

**Nothing on that list is the payment processor.** That is the whole point of
this document: crew pay was the one flow the go-live definition called "the
weakest link" and had waiting on a processor answer, and this decision takes it
off that critical path entirely and puts it on a community banker and a
`openssl rand -hex 32`.

---

Related: `docs/go-live-definition.md` (the definition of done),
`docs/processor-questions.md` (Architecture A and the processor's side),
`docs/banking-questions.md` (§B4 is now the question that matters),
migration `0200`, `src/lib/a-crew-is-never-a-merchant.test.ts`.

**Sources** for the external claims in §2–§4, all read 20 October 2026:
[Finix — Recipient Verification Process](https://docs.finix.com/guides/payouts/recipient-verification-process) ·
[Finix — Payout Links](https://docs.finix.com/guides/payouts/payout-links) ·
[Finix — Payouts pricing](https://finix.com/pricing/payouts-pricing) ·
[Merchant account underwriting — what providers check](https://www.merchantadviceservice.co.uk/merchant-accounts/merchant-account-underwriting-what-payment-providers-check-before-approval) ·
[Marketplace payments: splits, risk & compliance](https://chosepayments.com/insights/marketplace-payments-guide) ·
[1099-K vs 1099-NEC](https://www.taxbandits.com/1099-forms/1099-k-vs-nec-vs-misc/) ·
[IRS Form 1099-K and online marketplaces](https://trolley.com/learning-center/irs-1099-k-payment-card-third-party-network-transactions/) ·
[How to pay 1099 contractors](https://brocoders.com/blog/how-to-pay-1099-contractors/)
