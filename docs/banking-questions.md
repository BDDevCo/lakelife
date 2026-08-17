# Banker meeting — what to ask, and what disqualifies a bank

Written 17 August 2026, from the filed formation documents and the CP-575.

---

## The entity, as filed

| | |
|---|---|
| Legal name (State of Indiana) | **LAKELIFE AI, LLC** |
| Legal name (IRS, on the CP-575) | **LAKELIFE AI** — no designator, which is normal for an online EIN application |
| IRS name control | LAKE |
| Type | Domestic LLC, **single member**, member-managed |
| Indiana Business ID | 202608172029158 · Filing No 11480911 |
| Effective | 17 August 2026, perpetual duration |
| Principal office | 1506 Wall St, Fort Wayne, IN 46802 (Allen County) |
| IRS mailing address | PO Box 171, South Milford, IN 46786 |
| Registered agent | BD DevCo Asset Management, LLC, 5465 S 930 E, Wolcottville |
| Responsible party | Brendon Lochert, sole member |
| IRS business activity | "OTHER", principal product/service **"TECH AI"** |
| W-2 employees | None declared |

**The EIN is deliberately not written in this file.** This repository is public
on GitHub. Take the CP-575 itself to the meeting.

---

## Three things in those documents worth knowing

The first is normal and just needs care on forms. The other two are real.

### 1. Two correct names, and each form wants a specific one

The state registered **LAKELIFE AI, LLC**. The CP-575 says **LAKELIFE AI**.

**This is normal, not a mistake.** The online EIN application constrains the
name field — commas and periods are not accepted — so an entity designator
routinely does not survive into the IRS record. A CP-575 without "LLC" is the
ordinary result of applying online, and the verification services that check
these names are used to seeing it.

It still matters operationally, because two things ahead run a TIN match
against the IRS record rather than the state one:

- **A2P 10DLC** rejects more brands for a name mismatch than for anything else
  — the first warning in `a2p-registration.md`.
- **Processor underwriting** does the same check.

So: where a form asks for the name **as it appears with the IRS**, it is
**LAKELIFE AI**, copied off the CP-575. Where it asks for the name **as
registered with the state**, it is **LAKELIFE AI, LLC**. Read which one is
being asked for, and do not "helpfully" add the LLC to the first.

### 2. Every customer-facing thing says "LakeLife", and no entity is called that

The website, the hero, the emails, the printed slip and both user-agreement
drafts all say **LakeLife**. The company is **LakeLife AI, LLC**. Contracts,
invoices and the terms of service should either use the full legal name or the
business should file an **assumed business name certificate** in Indiana so
"LakeLife" is formally a name the LLC trades under.

Worth asking the attorney at the same time as the ToS. It costs very little now
and is awkward to fix after nineteen residents and a handful of crews have
signed things.

### 3. "TECH AI" will raise an eyebrow in underwriting

The EIN application describes the business as *OTHER / TECH AI*. What the bank
and the processor will actually see is a company collecting card and ACH
payments for lawn mowing, dock installation and rent. Those are not the same
story.

Nothing is wrong — it is an AI-built platform — but **be ready to describe the
business the same way to everyone**: the bank, the processor, and The Campaign
Registry. Inconsistency between what the IRS record says and what the merchant
application says is a common reason underwriting stalls. The description in the
thirty-second explainer below is the one to use everywhere.

### And one for the CPA, because it is time-sensitive

A single-member LLC is a **disregarded entity** by default — taxed on the
personal return. If an **S-corporation election** is wanted for the 2026 tax
year, Form 2553 generally has to be filed within roughly 75 days of the
formation date, which was 17 August. I am not a tax adviser and this is not
tax advice; it is a date worth putting in front of an accountant this month
rather than in January.

---

**I am not a lawyer and this is not legal advice.** One question below (money
transmission) is genuinely a counsel question, and it is marked. Everything
else is operational and a competent business banker can answer it.

---

## Explain it to him in thirty seconds

> LakeLife AI is a management platform. **We never own anything** — not a park,
> not a home, not a lot. Park owners and lake-house owners are our customers;
> crews are our contractors; residents are the people we serve on the owners'
> behalf.
>
> Two money flows. A lake-house owner books a service at one all-in price; we
> take roughly 30% and pay an independent crew the rest. And we collect rent
> from park residents and **pass it through to the park owner's own bank
> account** — the park owner banks wherever they bank; we never hold their
> property or their business.
>
> So money moves through this account that is not ours, and the structure has
> to say so from day one.

**This account is for LAKELIFE AI, LLC only.** No other entity's operating
account is being opened here.

If his eyes light up at "platform" and he starts talking about escrow schemes,
slow down — see *"Do not let the bank solve this"* below.

---

## The crux: four kinds of money, and only one is ours

This is the whole conversation. Get the structure right now and the rest is
paperwork.

| Money | Whose it is | Where it must live |
|---|---|---|
| Our margin (~30%) and card fees | **LakeLife's** | Operating account |
| Crew payables (~70% of every job) | The crew's, until paid | Not commingled |
| Tips | The crew's, entirely — never our revenue | Not commingled |
| Park rent collected online | **The park owner's**, from the moment it is paid | Held, then passed through |
| Residents' security deposits | **The resident's**, held in trust | Segregated, and see below |

Two things follow from that table:

**1. Rent is a PASS-THROUGH, and it is never ours for a second.** A resident
pays; the money belongs to that park's owner immediately; we move it to the
owner's own account at the owner's own bank. That is the whole relationship —
we are the administrator, not a party to the tenancy.

The first park is owned by BD DevCo Asset Management, LLC, which is Brendon's
other company. **That changes nothing here.** BD DevCo is customer number one
and banks wherever it banks; LakeLife treats it exactly as it will treat park
owner number two, who will be a stranger. If rent were ever to settle into
LakeLife's own operating balance, the administrator position the entire product
is built on would stop being true on the one document that would matter in a
dispute — the bank statement.

**2. Security deposits are not income and never were.** Indiana has specific
rules on holding and returning them, including a deadline and an itemised
statement. Ask the banker for the right vehicle and ask the attorney what
Indiana actually requires. The software already treats a deposit as held money
that can be returned or kept — the bank should agree with the software.

---

## What to ask

### A. Account structure — this is the whole meeting
1. We need an operating account for LakeLife AI, LLC, and **separately** a way
   to hold money that belongs to other people while it is in transit: rent on
   its way to a park owner, a crew's share of a job, a resident's deposit. What
   do you recommend — an **FBO ("for benefit of") account**, custodial, or
   trust? Which can you actually open here?
2. Can the FBO account carry **sub-ledgers per park owner**, or does that
   accounting live in our software with one pooled balance at the bank? Either
   can work; we need to know which, because it decides what we build.
3. If you cannot do FBO or custodial at all, say so plainly. That is not a
   criticism — it tells me where this has to go, and it is better said now than
   after the account is open.

### B. Moving money
4. **ACH origination** — can we originate credits (paying crews) and debits
   (rent, on the resident's authorisation)? What are the per-transaction and
   daily limits, and how long until limits lift on a new account?
5. Same-day ACH available? What is the cut-off?
6. What **reserve or rolling hold** would underwriting want on a platform like
   this? (Marketplaces routinely get one. Better to hear the number now.)
7. **Dual control** on ACH origination and **positive pay / ACH debit block** on
   the operating account. I want both on from day one.

### C. Cash and cheques — only if LakeLife handles them
8. Residents at the first park pay in **cash and cheques** — about nineteen
   households, monthly, in Wolcottville. **Decide first whether LakeLife ever
   touches that money.** Today the software only RECORDS a cash payment; the
   owner takes it. If it stays that way, skip this section entirely.
9. If LakeLife is going to take it in on the owner's behalf: what are the
   monthly cash deposit limits before fees, where is the nearest branch that
   takes business deposits, and is remote deposit capture included?

This is the one place the fintech-bank answer and the real-world answer pull
against each other, so make it a decision rather than something discovered in
January at a branch that turns out to be fifty minutes away.

### D. Underwriting, so nothing surprises us later
10. What will you need for estimated monthly volume, average ticket and largest
    single transaction? *(Have numbers ready: The Haven is about $5,200/month
    in rent; services are seasonal and spike at spring open and fall close.)*
11. Does the bank have any restriction on **marketplace or platform** business
    models, or on **property management / rent collection**?

### E. Plumbing
12. Can we get transactions programmatically — a real API, or at least clean
    Plaid connectivity? The accounting and the statements are automated and
    hand-keying defeats the point.
13. Fee schedule in writing: monthly maintenance, per-ACH, wire in/out, cash
    handling, returned item.

---

## THE COUNSEL QUESTIONS — ask the banker, but do not rely on his answer

### (a) Does collecting rent for owners we have no stake in need a licence?

**This is the one that got bigger, not smaller, when the model was clarified.**

LakeLife never owns a park, a lot or a home. It collects rent from residents
and passes it to the owner's account. In a lot of states, doing that for
somebody else's property — for a fee — is regulated activity: it can require a
**real estate broker or property manager licence**, and the usual exemptions
are written for employees of the owner, which we are not.

I do not know Indiana's specific rule and will not guess at it. What I can say
is that "we never own it, we just collect and pass through" is exactly the fact
pattern those rules are written about, so **it belongs at the top of the
attorney list — above the assumed-name question and above the ToS wording.**

It also cannot be answered once and forgotten: the answer is per state, and the
product is designed for park owner number two, three and ten. Ask what it takes
in Indiana now, and what changes at the state line.

### (b) Does taking a customer's money and paying an independent crew make us a
money transmitter?

It can. Money transmission is licensed state by state and the penalties are not
commercial. There are two standard structural answers:

- **Merchant of record.** LakeLife buys the service from the crew and resells it
  to the customer at one all-in price. The customer's contract is with
  LakeLife; the crew's contract is with LakeLife; we are not moving somebody
  else's money, we are buying and selling. **This is already exactly how the
  product behaves** — the customer sees one all-in price and the crew never
  sees what the customer paid.
- **Use a licensed processor's marketplace product** (Stripe Connect, Adyen for
  Platforms), where the processor is the regulated party and onboards the crews
  as sub-merchants.

Note the rent flow does **not** fit the merchant-of-record answer. We do not
buy rent and resell it — it is somebody else's money moving through, which is
the textbook description of the thing money-transmission rules govern. The
service flow and the rent flow may well need different answers, and that is
worth saying to the attorney explicitly rather than asking about "the
business" as one thing.

Ask the banker whether underwriting will flag either. Then ask the attorney
which structure each flow is actually in, and get it in writing. A banker's
reassurance is not a legal opinion.

---

## Do not let the bank solve the split-payment problem

The launch plan calls this the make-or-break question, and it is — but it is a
**processor** question, not a bank question. Customer pays $700 → crew gets
$490 → LakeLife keeps $210, automatically, on photo-verified completion.

Stripe Connect and Adyen for Platforms do that, and they also do the parts
nobody thinks about: KYC on each crew, sub-merchant onboarding, 1099-K issuance,
and the licensing. A bank trying to replicate it with an escrow account and
manual transfers is a worse version of a solved problem.

**So: the processor does splits and payouts. The bank does operating cash, the
park's rent account, deposits held in trust, and branch access for cash.** If
the banker starts designing the split mechanism, that is the moment to say the
processor is handling it.

---

## What to bring

- Articles of organisation, **state-stamped**
- **EIN letter (CP-575)** — and note the legal name must match IRS records
  character for character, the same requirement that governs the A2P texting
  registration
- Operating agreement
- Beneficial ownership details — anyone at 25%+ and a control person (FinCEN
  customer due diligence; the separate BOI filing regime has been in flux, so
  ask the attorney where that currently stands)
- Photo ID for every signer
- Business address and NAICS code
- The volume numbers from question 10

---

## If he cannot answer

Not a reflection on him — most community bankers have never underwritten a
marketplace, and honest "I don't know" beats a confident wrong answer.

LakeLife AI needs a bank that is **fintech-literate**, because the hard part is
holding other people's money properly. The park owners' own banking is their
problem, not ours — including the first one. Names worth calling, roughly in
order of how often they turn up behind products like this:
**Column** (a chartered bank with a real API and FBO capability), **Lead Bank**
and **Thread Bank** (the banks behind a lot of fintech FBO arrangements),
**Live Oak** and **Grasshopper**. **Mercury** and **Relay** are good operating
accounts but are **not** the answer for holding other people's money.

One practical note that survives the simplification: **the cash still has to go
somewhere.** Nineteen households at the first park pay in cash and cheques. If
LakeLife is the one taking that in on the owner's behalf, it needs a branch
within sensible distance of Wolcottville, and a fintech bank with no branches
cannot do it. If instead the owner keeps taking cash directly and LakeLife only
records it — which is what the software does today — then this does not apply,
and that is worth deciding on purpose rather than by accident.

The single question that sorts them: **"Can you open an FBO account for a
platform that holds funds for third parties, and what is your experience
underwriting marketplaces?"** If the answer is no or vague, thank them and keep
looking. Opening an ordinary business checking account and hoping to sort the
custodial side out later is how the rent ends up sitting in the operating
balance, which is the one outcome this whole document exists to prevent.
