# The money architecture, as decided — 29 October 2026

**This supersedes the provider recommendation in `processor-questions.md` and
reverses one conclusion in `banking-questions.md`.** Every claim about our own
code was checked against the repo or production on 29 Oct; every claim about a
third party carries a citation or is marked as unestablished.

Brendon met **US Card Solutions** on 28 October and **Mercury** is the chosen
bank for paying crews. In his words:

> *"...set up the park owners as a merchant with them, where renters would pay
> rent through credit card or ACH ... directly into and deposit into current
> existing bank accounts of the park owners ... a one-click touch approval
> application and API into US Card Solutions backend ... And that is just for
> the rent for the park. So we aren't touching the actual money for any
> renters, but then for any of the services, ancillary service or anything
> else, we would then be the only merchant, and it would come into us and then
> back out to either park owners for the ancillary services or the crew members
> ... the crew members or any subcontractors would not be merchants."*

---

## 1. The three flows, settled

| | Who is the merchant | Where the money lands | Does it touch LakeLife? |
|---|---|---|---|
| **Rent** (card or ACH) | **the park owner** | the owner's existing bank account | **never** |
| **Services** (homeowner or park buys work) | **LakeLife, and only LakeLife** | our account, then out | yes — it is our revenue |
| **Paying it out** (crew, or a park's share of an ancillary service) | **nobody — they are payees** | their own bank, by ACH from Mercury | yes, as accounts payable |

**Nobody becomes a merchant except a park owner, and only for rent.** That is
the whole shape, and it is the one we had already built toward.

---

## 2. What this confirms — already built, do not re-open

- **A park owner is a merchant settling to their own bank.** Migration
  **0196** built that registry, including a per-rail capability each doorway
  checks and a deliberate refusal to store any bank credentials.
- **A crew is never a merchant.** Migration **0200**, decided on 20 October for
  our own reasons — a crew accepts no customer payment, and a sub-merchant
  would receive a 1099-K at GROSS, handing every crew our margin by IRS mail.
  **The processor conversation independently arrived at the same answer**,
  which is the strongest evidence yet that it was right.
- **LakeLife is merchant of record for services.** Verified in code, not
  assumed: `src/lib/charge-gate.ts` performs no per-recipient merchant lookup
  at all, so a service charge already settles to us while rent looks up the
  park's.

---

## 3. What was missing, and is now built — migration 0201

Both gaps were proven against production *before* the migration.

### A park's own share of service money could not be recorded at all

```
payout_batches.kind allowed : 'early', 'monthly', 'referral'
a park_services batch       : REFUSED by payout_batches_kind_check
```

His model has money arriving at LakeLife for an ancillary service and going
back out to **either a crew or the park owner**. The second had no `kind`, so
the database refused it outright — a missing *state*, not a missing screen.

Meanwhile `payout_accounts` has been keyed by `user_id` since **0039**, whose
own comment says *"crew users AND HOA users"*. The destination side was built
for this on day one and the batch side never caught up. `park_services` now
exists, and a constraint refuses one that names a vendor, because a park
owner's share is not a crew's money.

**The column comment says, in the database, that this is never rent** — rent
never reaches a LakeLife account, so a park payout can only ever be the park's
share of something we sold. Getting that wrong is the one way this feature
could launder rent through us.

### "One-click application" had nothing to submit

`processor_accounts` held provider, merchant id, status, capabilities and
`settlement_last4` — every one a record of what the *processor* said, and not
one field an underwriter needs. `startProcessorSetup` inserts
`{ park_id, provider }`, so a one-click submit would have posted an empty
envelope.

0201 adds the sixteen fields a boarding application actually asks for, and
**refuses to store a full tax id**: four digits for a screen, with the full
EIN or SSN going from the form straight to the processor and never persisted —
the posture `0197` took for a resident's bank account. A post-condition **fails
the migration** if a column here is even *named* like a full credential,
including the subtle case of a column called plain `tax_id`.

And because "one-click" means the click is the only ceremony, the weight falls
on the state being right before it:

- a submitted application must have been complete (`submitted_at` requires
  `application_ready_at`);
- editing a ready application makes it **un-ready**, or `application_ready_at`
  would be a column that is true once and then lies;
- editing after it has gone is **refused in words**, because the change would
  reach nobody.

---

## 4. US Card Solutions — the one thing to pin down first

**Researched 29 Oct 2026, and this is not a doubt about the conversation; it
is the question that decides what gets built.**

[US Card Solutions](https://uscardsolutions.com/) describes itself as an
**ISO/agent**, a registered ISO/FSP/MSP of a sponsor bank, working through
third-party processing relationships. A [review
site](https://paymentpop.com/merchant-accounts/us-card-solutions-reviews/)
reports it resells processing through **Fiserv, TSYS and North American
Bancard**.

If that is right, then **"their backend API" is really one of those platforms'
APIs**, and which one decides nearly everything we have been unable to settle:

- the tokenization shape (`tokenize()` must fit it — CLAUDE.md rule 4);
- the **boarding API** — whether one-click submission exists at all, and what
  fields it wants, which is what 0201's sixteen columns are a first guess at;
- the webhook event names, which is the only thing blocking the drain;
- ACH return codes and their delivery.

**Also: their public site describes card processing, POS and faster funding —
I found no ACH offering for this company.** Renter ACH would then come from a
partner, and we need to know whose.

**And there is a name-collision risk worth thirty seconds of checking.** At
least three similarly-named firms exist: **US Card Systems** (Brainerd, MN, a
Worldpay reseller — this one *does* publish ACH processing), **Usio** (a
separate public company doing ACH and payment facilitation), and **Card
Solutions International**. Worth confirming the exact legal entity on the
agreement before any of this is built against assumptions.

### The five questions, in order

1. **Whose platform are we actually on** — Fiserv, TSYS, North American
   Bancard, or something else? Everything else follows from the answer.
2. **Is there a boarding/underwriting API**, and what fields does it take? We
   will send the application from our own screen; we need the spec.
3. **Who provides the renter ACH**, and what return codes come back, in what
   form, how fast?
4. **Does a park owner's approval genuinely come back in one touch**, or is
   underwriting asynchronous with a decision later? *Both are fine — they are
   different screens. A park owner told "you're approved" who then isn't is
   the thing to avoid.*
5. **Statement descriptor per transaction** — rent must read **THE HAVEN**, not
   LakeLife. `rentDescriptor()` already composes it.

> **One honest note about "one-click".** A park owner becoming a merchant is
> being underwritten, and underwriting can decline. One click is the right
> target for the *effort*; it cannot promise the *outcome*. 0196 already
> models that correctly — `rejected` is a real status and a rejected merchant
> is re-submitted as a new account rather than edited — so the software is
> ready for a no. The screen's wording just has to be.

---

## 5. Mercury — and a reversal

Mercury is now the bank for paying crews and contractors by ACH. **This
reverses what `banking-questions.md` says**, and the reversal is sound rather
than convenient.

That document ruled Mercury out in these words: *"Mercury and Relay are good
operating accounts but are **not** the answer for holding other people's
money."* That was correct **when we expected to hold other people's money**.
Under the architecture above **we never do**: rent goes owner-direct and never
touches us, and a crew's share is our own accounts payable as merchant of
record. The objection no longer applies, and no FBO or custodial account is
needed.

### The engineering answer, which is better than it looks

Mercury's API can originate ACH, and [their
docs](https://docs.mercury.com/docs/send-money) are explicit about a
constraint that would otherwise have bitten us:

- `createTransaction` — the direct send — **requires an IP allowlist**.
- `POST /account/{id}/request-send-money` — **does not**, and the docs say it
  *"may be useful in situations where a static IP is not available"*. Its scope
  is *Send Money with Approval*.

**Vercel serverless has no static egress IP**, so the direct path is closed to
us without a paid static-IP add-on or a proxy. We use a **custom token with the
`RequestSendMoney` scope**, which queues the payout and waits for approval in
Mercury.

**That approval step is a feature here, not a limitation.** It is exactly the
standing rule this product already runs on — *unattended only if the worst case
is a sentence on screen*, and *nothing goes out until he says*. A payout run
that assembles itself, queues in Mercury and waits for one tap is the shape we
would have chosen.

### What is unconfirmed, and must be checked in the dashboard

- **Limits.** Mercury assigns per-account ACH limits and only admins can
  request an increase. A third-party guide claims $500k/day; that is not an
  official source. Check the real number against the first month's payout run.
- **Cost.** The developer page says 100 free ACH transfers a month; the
  pricing page appears to list *"making mass payments on our API"* among
  charged items. Those conflict and the pricing page is old. **Confirm before
  the first run.**
- ~~**CHECKING OR SAVINGS — we have never asked.**~~ **DONE 29 Oct (0203).**
  Asked on both forms that write a payout account, `NOT NULL` at the database
  with no default, and Mercury now sends the crew's own answer. The paragraph
  below is kept because it is why the column exists. `payout_accounts` has no such
  column: the CSV never needed one because the bank matched on the routing
  number, and **Mercury does need it.** The first run assumes `checking`,
  which is overwhelmingly right for a business payee and is the first thing to
  check if a credit comes back. The real fix is one more field on the crew's
  own bank screen — a question for a crew, not a guess by us — and it is cheap
  to add before anyone has banked with us, which today is still true: zero
  crews have given us details.

---

## 6. What is left

| # | Thing | Owner | Blocked on |
|---|---|---|---|
| 1 | `park_services` payout kind + the application schema | me | **DONE** (0201) |
| 2 | Which platform US Card Solutions puts us on (§4.1) | **you** | one question to them |
| 3 | The application screen + one-click submit | me | 2, for the field spec |
| 4 | Mercury ACH origination replacing the CSV | me | **BUILT 29 Oct (0202)** — needs the account + `BANK_ENCRYPTION_KEY` to run |
| 5 | `BANK_ENCRYPTION_KEY` in Vercel | **you** | one `openssl rand -hex 32` |
| 6 | Mercury limits and API fees confirmed | **you** | the dashboard |
| 7 | Paying a park owner their ancillary share, end to end | me | 1 is the state; the run is next |

**Nothing here is waiting on a decision any more.** The architecture is
settled, the two schema gaps are closed, and what remains is one question to
the processor, one command from you, and build.

Related: `docs/how-a-crew-gets-paid.md` (why a crew is never a merchant),
`docs/go-live-definition.md` (the definition of done),
`docs/processor-questions.md` (the questions themselves — its Finix
recommendation is superseded by §4 above),
`docs/banking-questions.md` (§5 reverses its Mercury conclusion),
migrations `0196`, `0200`, `0201`.
