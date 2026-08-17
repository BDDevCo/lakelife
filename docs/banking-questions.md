# Banker meeting — what to ask, and what disqualifies a bank

Written 17 August 2026, for the meeting after the entity and EIN landed.

**I am not a lawyer and this is not legal advice.** One question below (money
transmission) is genuinely a counsel question, and it is marked. Everything
else is operational and a competent business banker can answer it.

---

## Explain it to him in thirty seconds

> LakeLife is a platform. A lake-house owner books a service at one all-in
> price; we take roughly 30% and pay an independent crew the rest. Separately,
> LakeLife administers rent for a mobile-home park that a **different** company
> of mine owns — I collect rent on that park's behalf, and I hold its residents'
> security deposits. So money flows through the business that is not the
> business's money, and I need the account structure to reflect that from day
> one.

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
| Park rent collected online | **BD DevCo Asset Management, LLC's** | That entity's account |
| Residents' security deposits | **The resident's**, held in trust | Segregated, and see below |

Two things follow from that table:

**1. LakeLife and BD DevCo Asset Management need separate banking.** The Haven
is owned by BD DevCo Asset Management, LLC; LakeLife is the administrator. Rent
belongs to the park-owning entity the moment a resident pays it. If it lands in
LakeLife's operating account, the two companies are commingled and the
third-party-administrator position we have built the whole product around stops
being true in the one place it matters most — the bank statement.

**2. Security deposits are not income and never were.** Indiana has specific
rules on holding and returning them, including a deadline and an itemised
statement. Ask the banker for the right vehicle and ask the attorney what
Indiana actually requires. The software already treats a deposit as held money
that can be returned or kept — the bank should agree with the software.

---

## What to ask

### A. Account structure
1. What do you recommend for a platform that collects money on behalf of third
   parties — a **FBO ("for benefit of") account**, a custodial account, or a
   trust account? Which of those can you actually open here?
2. Can BD DevCo Asset Management, LLC hold its own operating account here, with
   LakeLife having **view and deposit rights but not withdrawal rights**?
3. If you cannot do FBO or custodial, say so plainly — that is not a criticism,
   it just tells me where this has to go.

### B. Moving money
4. **ACH origination** — can we originate credits (paying crews) and debits
   (rent, on the resident's authorisation)? What are the per-transaction and
   daily limits, and how long until limits lift on a new account?
5. Same-day ACH available? What is the cut-off?
6. What **reserve or rolling hold** would underwriting want on a platform like
   this? (Marketplaces routinely get one. Better to hear the number now.)
7. **Dual control** on ACH origination and **positive pay / ACH debit block** on
   the operating account. I want both on from day one.

### C. Cash and cheques — do not skip this
8. The park collects rent in **cash and cheques** from about nineteen
   households, every month, in Wolcottville. What are the monthly cash deposit
   limits before fees kick in, and where is the nearest branch that takes
   business deposits?
9. Remote deposit capture for cheques — included, or extra?

This one is easy to forget and it is the part that touches real life every
month. A great platform bank with no branch within forty minutes of the park is
the wrong bank for the park entity.

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

## THE COUNSEL QUESTION — ask, but do not rely on his answer

**"Does taking a customer's money and paying an independent crew make us a
money transmitter?"**

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

Ask the banker whether underwriting will flag it. Then ask the attorney which
structure we are actually in, and get that in writing. A banker's reassurance
is not a legal opinion.

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

**Split it in two, which is what I would recommend regardless:**

- **The park entity** (BD DevCo Asset Management, LLC) belongs at a **local
  north-east Indiana bank or credit union with a branch near Wolcottville**.
  Its needs are unglamorous: take cash and cheques, pay contractors, keep
  deposits separate. Proximity beats features.
- **LakeLife the platform** belongs somewhere fintech-literate. Names worth
  calling, roughly in order of how often they turn up behind products like
  this: **Column** (a chartered bank with a real API and FBO capability),
  **Lead Bank** and **Thread Bank** (the banks behind a lot of fintech FBO
  arrangements), **Live Oak**, **Grasshopper**, and **Mercury** or **Relay** for
  a straightforward operating account — noting Mercury and Relay are good
  operating accounts but are **not** the answer for holding other people's
  money.

The single question that sorts them: **"Can you open an FBO account for a
platform that holds funds for third parties, and what is your experience
underwriting marketplaces?"** If the answer is no or vague, thank them, keep
them for the park, and go elsewhere for the platform.
