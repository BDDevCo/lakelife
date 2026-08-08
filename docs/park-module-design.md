# The Park module — LakeLife.ai as a park owner's management system

**Status:** design. Nothing built. Revised 2026-08-07 after the owner corrected
the framing; backed by a four-lane read-only mapping of the backend.

**What this actually is.** Not "a park is a big customer." A park owner adopts
**LakeLife.ai as their exclusive park management system**. Their renters become
platform customers *scoped to that park*. The park owner gets software that
fills lots and keeps them covered; LakeLife gets the services revenue from every
renter in the park.

> *"a park owner can use lakelife.ai as their own little exclusive tool to
> attract more people to the area, while we are capturing fees and services from
> all the park renters."*

**The strategic shape: the software is the channel, the services are the
business.** Park-management software is a crowded, unremarkable market. Nobody
in it bundles *"and your renters get a concierge for their boat, their golf cart
and their mobile home."* That bundle is the reason a park owner switches, and
their switching is how LakeLife acquires eighty service customers in one
conversation.

---

## 1. The three parties and what each one gets

**The park owner** — runs their park from one back end: lot inventory and a
map, reservations and availability, the rent roll and who's delinquent, which
renters have documents on file and whose insurance is about to lapse, executed
agreements, and their own service requests for common areas. Plus a public page
that fills vacancies.

**The renter** — books a lot for a term that suits them (a few weeks, a season,
a year), signs the rental agreement in their portal, uploads their driver's
licence and any insurance the park requires, declares a boat or a golf cart,
sets up autopay for the monthly bill, and books the services that make lake life
work: cleaning, mobile-home winterization and de-winterization, boat storage,
winterize/de-winterize, and the spring drop-in. They see the lake conditions
that already exist on the platform.

**LakeLife** — three revenue streams, only two of which carry margin:

| Stream | Margin | Notes |
|---|---|---|
| **Services to renters** | yes (the normal engine) | ~$18k/park/season modelled |
| **Park-owner software fee** | yes | deliberately small — see below |
| **Rent collection** | **none, by design** | pass-through; ACH only (§2b) |

### Price the software low on purpose

Park software runs roughly $1–3 per lot per month. Eighty lots at $2 is about
**$1,920 a year**. The services from the same park are worth **~$18,400**. If
charging for the software costs even 30% of park adoption, that trades $5,500 of
services for $1,920 of fees — a bad deal.

**So the software should be free or near-free at first.** It is customer
acquisition, not a product line. This is the same conclusion the launch strategy
reached for homeowners: no upfront fee, land and expand.

---

---

## 1b. Two property managers, one platform — and the park owner is the human

The owner's framing, which corrects the automation assumption running through
the rest of this platform:

> *"I don't think it's gonna be as automated as we think… There's still gonna be
> some type of human involvement on the park side as an owner, but I want them to
> be able to use this tool as the ability to cut down on their management. So
> it's basically like a little property manager for the park, and then it's also
> a mini property manager for the customers that are in the park."*

That is two managers stacked:

- **The park owner manages the park** — lots, tenancies, compliance, rent.
- **The renter manages their own unit** — their mobile home or RV, and the
  services that keep it running through a lake season.

And it inverts the platform's usual ideology on purpose. Everywhere else,
LakeLife automates the judgment. **Here the park owner keeps the judgment and
the platform removes the paperwork.** The design rule that follows:

> **The platform surfaces the queue, holds the record, moves the money and sends
> the reminders. The park owner decides. The platform never decides.**

### The routing rule that protects LakeLife

A corollary that matters more than it looks: **park exceptions route to the park
owner's queue, never to LakeLife's ops console.** The two-season audit showed
ops workload scaling linearly with customers — roughly one action per customer
per season. If every park's approvals, insurance chases and late rents landed in
`/ops`, each park added would grow LakeLife's burden by the size of the park,
and the whole zero-ops thesis would break at park #3.

Only genuine platform failures — a processor outage, a stuck remittance — reach
LakeLife.

---

## 1c. The park owner's setup interview *is* the product

Every park runs differently, so the platform cannot hardcode one. The park
owner's onboarding is a configuration interview whose answers drive everything a
renter later sees. What it has to capture:

**Inventory.** Lots with numbers/sections and *site type* — mobile-home pad, RV
full hookup, RV water-and-electric, seasonal slip. Crucially **fit
constraints**: max length, hookup amperage, whether a slip comes with it. A
40-foot RV cannot go on a 30-foot pad, so this is matching data, not decoration.

**Terms and rates.** What durations this park sells — a few weeks, monthly,
seasonal, annual — and the rate for each. The park owner dictates the money;
LakeLife never prices a lot. (This is `services`-style rule-8 configuration
pointed at lots.)

**What's included** — water, sewer, trash, wifi, a slip — because that is the
first question every renter asks and it belongs on the public park page.

**Documents.** Their lease, park rules, any addenda: uploaded by the park owner,
versioned, and served to renters for e-signature.

**Insurance requirements**, expressed as rules rather than prose: what triggers
each one (everyone / owns a boat / has a golf cart), what document, minimum
limits, and whether the park must be named additional insured.

**The approval switch.** Does an application need the park owner's approval, or
is booking instant? **Default to approval** — most park owners will want it, and
it is the safer default.

**House rules** — pets, guests, quiet hours — displayed to renters, never
enforced by software.

---

## 1d. The renter's path, and the fork at the top

At signup the customer portal asks one question: **"Do you rent in a park, or do
you own a lake property?"** Everything downstream branches there.

The park-renter branch:

1. **Pick the lake, then the park** (or the park directly — the lake is already
   modelled, and parks hang off it).
2. **Describe the unit they own** — make, model, year, length. They own the
   mobile home or RV; they rent the *lot*. That distinction drives both lot fit
   and which services apply (winterizing a park model is not winterizing a
   travel trailer).
3. **See lots that actually fit**, with availability and the park owner's price
   for the term they want.
4. **Apply** for that lot and duration.
5. **The park owner approves** (unless instant booking is on).
6. **Then** sign the agreement, upload insurance and photo ID, declare a boat or
   golf cart, and set up payment.

**Note step 6 deliberately follows step 5.** See below.

---

## 1e. The approval step is the biggest new legal exposure

The moment a park owner accepts or declines applicants inside LakeLife's
software, LakeLife is supplying a tool used to make a **housing decision**. That
is regulated ground — federal fair housing plus Indiana's mobile-home community
statute — and it is materially heavier than anything the platform does today.

Concrete design choices that reduce exposure, all of them cheap if made now and
expensive to retrofit:

- **Build no screening logic.** No scoring, no ranking, no recommendations, no
  "similar parks accept…" nudges. The platform records a decision; it must never
  produce or suggest one.
- **Collect nothing that touches a protected class.** No questions about family
  status, disability, national origin, religion. Watch out for innocent-looking
  fields — "how many children" is a classic trap.
- **Collect the photo ID *after* approval, not with the application.** Having a
  picture of an applicant's face in the file before the accept/decline decision
  looks bad in a way that is hard to explain later, whatever actually happened.
- **Keep the decision record factual and minimal**, and treat it as
  discoverable — because it is.
- **Do not automate denial**, and do not template a denial reason.

**For the attorney, alongside the ToS work:** what an application may ask, what
must be retained and for how long, and what notice a decline requires.

---

## 1f. What stays human on purpose

Not everything here should be automated even if it could be:

| Stays with the park owner | Why |
|---|---|
| Approving an applicant | A housing decision. Software must not make it. |
| Judging whether a certificate is *adequate* | The platform can read an expiry date; it cannot tell whether the endorsement really names the park. |
| Delinquency and eviction | Regulated, state-specific, and different for mobile-home parks. **Hard line: the platform records the failure, notifies both parties, and stops.** It must never auto-generate a legal notice or auto-escalate. |
| Disputes with a renter | Their tenancy, their relationship. |
| Odd lot assignments | They know their own park. |

What the platform *does* take off their plate: chasing signatures, chasing
documents, chasing expiries, collecting rent, reconciling it, remitting it,
publishing availability, and answering "when is my mobile home being
winterized."

That is the honest version of "cut down on management," and it is a better
promise than "eliminate it" because it is one the platform can actually keep.

---

## 1g. Two payment instruments, on purpose

A renter puts both on file:

- **Rent → ACH.** The fee model (§7) is decisive: card rent on an 80-lot park
  costs ~$12,800 a year against ~$18,400 of total park margin.
- **Services → card.** Small, occasional, and the fee is immaterial at that
  size; card is also what the existing engine already does well.

Same renter, two rails, chosen by what the money is for.

---

---

## 1h. Screening: integrate it, never build it

**The owner:** *"park owners will need to approve but you will need to design a
credit check/background check like a typical property owner needs to have."*

Park owners absolutely need this. But **LakeLife must not be the one performing
it**, and the reason is structural rather than squeamish.

### The trap

Running credit or background checks on rental applicants puts everyone involved
under the **Fair Credit Reporting Act**. The party that *assembles or evaluates*
consumer information to produce reports for third parties is a **Consumer
Reporting Agency**, and a CRA carries a heavy, permanent compliance load —
accuracy obligations, a dispute-and-reinvestigation process, verifying
permissible purpose for every pull, and liability when it gets any of that
wrong.

If LakeLife aggregates data, computes a score, or produces a
recommendation, **LakeLife plausibly becomes a CRA.** That is a different
company than the one being built here, and it is not a line to cross by
accident while shipping a park feature.

This also sharpens the earlier "build no screening logic" advice: the reason is
not only fair-housing optics. Building it changes what LakeLife legally *is*.

### The design: be the conduit, not the source

1. **The park owner configures what they require** — credit, eviction history,
   criminal history, income verification — as their own criteria. Their park,
   their standard, their decision.
2. **A licensed third-party screening provider does the work.** The applicant
   authorizes the provider and (usually) pays them directly; the report is
   delivered to the **park owner**. LakeLife initiates and tracks the request
   and nothing more. This is the standard integration shape for exactly this
   reason.
3. **Store as little as possible.** Ideally the report never enters LakeLife's
   database at all — only *requested / completed / decision recorded*, plus the
   provider's reference. Storing report contents would import FCRA retention and
   accuracy duties, plus breach exposure, for data LakeLife has no use for.
4. **Adverse action is the park owner's obligation, and the platform must
   prompt it.** When a denial rests wholly or partly on a consumer report, the
   applicant is owed a notice naming the reporting agency, stating the agency
   did not make the decision, and explaining their right to a free copy and to
   dispute it. The platform should surface that requirement and the provider's
   template at the moment of decline — and the park owner sends it.
5. **No scoring, no ranking, no "recommended" flag, ever.** Not even a helpful
   colour on a row.

### What still needs the attorney

- Whether this integration shape keeps LakeLife outside the CRA definition, and
  what the platform's contract with the screening provider must say.
- **Criminal history is the sharpest edge.** HUD guidance has long treated
  blanket criminal-history bans as potential Fair Housing Act violations through
  disparate impact, and a growing number of states and cities restrict what may
  be asked and when. Whether Indiana constrains this — and whether the platform
  should offer a criminal-history option *at all* — is a counsel question, not a
  product one.
- Application-fee limits, if Indiana sets any, and who may charge them.
- Retention: how long a decision record must be kept, and how long it may be.

---

## 1i. Configurability: model the dimensions, not the parks

**The owner:** *"our engine needs to have ability to accommodate all the
suggestions or pathways a park owner would use and if they want something custom
we can build it for them just for their park. but bill them for it… want to try
not to offer that to anyone."*

That instinct is right and worth stating as a rule: **per-park custom code is
how a software business dies.** Every bespoke build is permanent maintenance,
becomes a blocker on every future refactor, and cannot be sold to park #2. The
goal is a configuration space wide enough that "custom" almost never comes up.

The way to get there is to enumerate the **axes of variation** and make each one
a dial, rather than trying to anticipate parks.

**Park shape**
- MH-only, RV-only, or mixed
- Year-round or seasonal (does the park close in winter?)
- All-ages or 55+ *(a fair-housing exemption category with its own verification
  rules — flag for counsel)*
- Whether the park also rents park-owned homes, not just lots

**Tenancy**
- Terms offered: nightly, weekly, monthly, seasonal, annual
- Minimum stay; month-to-month rollover after a term ends
- Whether transient/nightly stays are sold at all

**Money — the richest axis, and the one most likely to drive "custom" requests**
- Due date: fixed day of month, or anniversary of move-in
- Proration on the first and last month
- Late fees: flat or percentage, grace period, cap
- Deposits: amount, refundable, and how held
- **Utilities: included, flat add-on, or submetered.** Many MH parks submeter
  water and electric and bill an amount that changes every month. This is a
  *variable recurring charge*, not rent, and a design that assumes flat rent
  will meet its first custom request here.
- Recurring extras: additional occupant, second vehicle, pet rent, storage lot,
  slip fee

**Compliance**
- Which documents, which insurance rules, which screening checks
- Approval required, or instant

### The escape valves that prevent most custom builds

Three generic mechanisms turn the majority of "can you build us X" into
configuration:

1. **A generic charge model.** Not hardcoded kinds like `rent` and `pet_fee`,
   but *charge types the park owner defines* — name, amount or rate, recurrence,
   taxable or not, prorated or not. Submetered water, a slip fee and a
   third-vehicle charge are then the same object with different rows.
2. **Custom fields the park owner defines** — on the application, on the lot, on
   the tenancy. Anything the platform did not anticipate becomes data the park
   owner captures without code.
3. **Custom document slots.** Any addendum, any local form, uploaded and
   e-signed through the same pipeline as the lease.

With those three, the remaining true custom requests are rare — which is exactly
what makes it reasonable to price them high and rarely offer them.

**The one thing to protect absolutely:** custom work must never fork the engine.
If a park genuinely needs different behaviour, it belongs behind a per-park
configuration flag on the *same* code path — never a branch, never a second
implementation. The two-season audit already showed what dormant, unexercised
code does: the storage product was built, switched off, and had four real bugs
waiting in it when the simulation finally ran.

---

## 2. The new core primitive: a lot is bookable inventory

This is the piece the previous draft under-scoped, and it is the heart of the
product. Everything the platform books today is a **service at a point in time**
against a property. A lot rental is **exclusive occupancy of a thing over a date
range**, priced by term.

The closest existing cousin is storage: `storage_stays` already models
intake → occupancy → release with custody. A reservation is that shape plus
pricing and an agreement.

**`lot_reservations`** — lot, renter, `during daterange`, term type
(nightly / weekly / monthly / seasonal / annual), rate, status
(held → agreement sent → executed → active → ended).

**Two lots can never be double-booked, and the database enforces it.**
`btree_gist` is available on the project (confirmed, not yet installed), so:

```sql
create extension if not exists btree_gist;

alter table public.lot_reservations
  add constraint lot_no_double_booking
  exclude using gist (
    park_lot_id with =,
    during      with &&
  ) where (status in ('held','executed','active'));
```

That is a real guarantee, not a convention — exactly the pattern the two-season
audit said the money tables were missing. An overlapping booking fails at the
database, whatever wrote it.

**Term pricing lives in the database (rule 8).** A lot carries a rate card —
nightly, weekly, monthly, seasonal, annual — and the park owner tunes it. This
mirrors how `services` already works and needs no new concept.

**Availability is a read over that same range**, which means the public park
page and the renter's booking calendar are the same query.

---

## 3. The compliance engine — "keep the park covered"

The previous draft treated documents as generic upload. That misses the actual
job. The park owner has a contract, and the contract has requirements: *a boat
at a slip needs watercraft liability naming the park as additionally insured; a
golf cart driven on property needs liability; everyone needs a licence on file.*

So the park owner **defines requirements**, and the platform tracks **coverage**:

- **`park_requirements`** — per park: what triggers it (all renters, or owning a
  boat, or a golf cart), what document is needed, any minimum coverage, and
  whether the park must be named additional insured.
- **`renter_assets`** — a boat or a golf cart declared by the renter. Declaring
  one *turns on* the matching requirement. (Note: `boats` already exists as a
  table for homeowners; a golf cart needs the generic version.)
- **`renter_documents`** — the uploaded file, its expiry, and a verification
  state, following the vendor-COI pattern that already gates crew eligibility.

The park owner's dashboard then answers the question they actually have: **who
is out of compliance, and whose certificate expires next month.** That is the
feature that makes the software worth having, and it is the same expiry
machinery that already runs `sendCoiRevalidations` for crews — with the
correction noted in §4 that a lapse notice needs a sent-ledger, because unlike a
crew COI there is no automatic backstop stopping anything.

---

## 4. "Encumbered just in the park area" — scoping a renter

A renter is a platform customer whose world is bounded to their park. This has a
precise technical meaning and it is mostly good news:

- They stay `role = 'owner'` in the database. **Do not add an enum value** — the
  `services_read` policy grants SELECT on `services` only to `role='owner'`, so
  a `role='renter'` user would get an **empty services menu with no error**,
  killing exactly the service capture this whole project exists for.
- Their identity as a renter comes from `tenancies` / `lot_reservations`, not
  from a role.
- Their bookable "property" is their lot, resolved through the tenancy — not
  through `properties.owner_id`, which must keep meaning *"the person we charge
  and text."*
- The park owner sees lots, tenancies, rent and compliance. They must **not**
  see a renter's personal service history or payment details, and they must
  never be given the ops role (`assertOps` is all-or-nothing and would hand them
  every homeowner's price, LakeLife's margin, and every crew's W-9).

---

## 5. Filling the park — reuse what already exists

The owner's phrase was *"attract more people to the area."* The platform already
has the machinery:

- **`/lakes/[slug]`** is a live, SEO-indexed public page built from real data
  (crew counts, honest from-prices, season dates, the HOA ticker). A
  **`/parks/[slug]`** page with live lot availability and "what's included" is
  the same pattern with a different query.
- **Lake conditions** — ice-out, pull deadlines — are already modelled and are
  genuinely useful to an RV or mobile-home renter deciding on a season.
- **Referrals** already exist; a park is a dense referral graph.

---

## 6. The central rule: rent must never enter the job pipeline

The money lane's finding is unambiguous — *"nothing in this codebase can bill
anything that is not a `jobs` row."* Rent is not a job. Forcing it through the
existing pipeline breaks six things at once:

| If rent were a `jobs` row… | What actually happens |
|---|---|
| `expireUnfilledJobs` | Rent has no crew, so the nightly **cancels it** and texts the renter *"we couldn't line up a crew in time… you were never charged."* `resolveRushFallbacks` goes further and **deletes the row**. |
| `getOpsSummary` | Rent has no `vendor_cost`, so every rent dollar inflates the revenue denominator and not the margin numerator. The headline blended-margin number on /ops drifts down with no visible cause. |
| `settleJob` credits | Growth **credits would be spent paying rent**, and `accrueReferralEarnings` would **pay referral commissions on rent dollars** — a budget leak and a 1099 exposure the credits design exists to avoid. |
| A second `invoices` row per job | `invoices` is read with `.maybeSingle()` on `job_id` in five places (`automation.ts`, `refund-core.ts`, `refund-actions.ts`, `disputes.ts` ×2). A second row makes that **throw**, silently disabling the refund button and the Make-It-Right auto-refund. |
| A park remittance as a `payouts` row | `runMonthlyPayoutBatches` filters on `status='released'`, unbatched, `vendor_id` not null — **with no `kind` filter** — so it would be swept into a crew batch and texted to a crew as their payout. |
| `/billing` | Renders date + status + amount with no discriminator, so **$850 of rent is indistinguishable from an $850 service**, under copy that says *"you're charged only after each is completed and photo-verified."* |

**Verified rather than assumed:** the missing `kind` filter in
`runMonthlyPayoutBatches` is *not* a bug today — `payouts.kind` is only
`earning` or `adjustment`, and negative adjustments are *meant* to net into the
batch. It becomes a bug the instant a third kind exists. Add
`.eq('kind','earning')` in the same commit that introduces any new payout kind.

**Design decision: rent gets its own ledger.** `leases` and `rent_charges`
tables, their own charge function, their own receipts. It reuses
`payment_methods`, the processor seam, and the notification engine — and touches
`jobs`, `invoices`, `payouts`, `user_credits` and `referral_earnings` **never**.

---

---

## 7. LakeLife as merchant of record — and the fee that decides the design

**The owner:** *"the app would be doing the processing as the 1 vendor on the CC
processing and pay the park owner if that makes it easier."*

Technically, yes — and it fits what already exists. LakeLife is already the only
party that onboards with the processor; crews are payees on an ACH rail against
ledger rows. A park owner is structurally another payee. The bank vault
(`payout_accounts`, AES-encrypted, ABA-checksummed), the batch builder and the
remittance mechanics are all built.

**But being merchant of record on a zero-margin product has a cost, and it is
larger than the product it is attached to.** Model: `docs/rent_rail_model.py`.

An 80-lot park at $450/month collects **$432,000 of rent a year**, of which
LakeLife keeps nothing:

| Rail | Per payment | Per year | Share of the park's service margin |
|---|---|---|---|
| **Card** (2.9% + $0.30) | $13.35 | **$12,816** | **70%** |
| **ACH** (flat ~$0.50) | $0.50 | **$480** | 3% |

The park earns the platform roughly **$18,400** of service margin a season.
Running rent on cards would consume **about two-thirds of it** — the entire
reason for doing the park — to move money LakeLife does not keep a cent of.

**So this is not an optimisation. It decides the rail.**

- **Rent runs on ACH.** Not "later," not "phase 3." It is the primary rail from
  the first rent charge, and the ACH `pending / settled / returned` state
  machine is therefore a **Phase 3 prerequisite, not a Phase 3 nicety.**
- **Card rent is either disallowed or fee-passed.** Breaking even on cards needs
  a $13.35 convenience fee per payment, or $160/lot/year from the park owner, or
  a $12,816 annual park fee covering nothing else. Note that card surcharging is
  restricted in several states and governed by card-network rules — an attorney
  question, not a product decision.
- **This reframes the annual park-owner fee.** The owner planned one "down the
  road." The model says a fee is not upside on top of rent collection; on cards
  it is what makes rent collection not lose money. On ACH the fee stays what it
  should be — margin.

### The remittance side

Do **not** write park remittances as `payouts` rows. `runMonthlyPayoutBatches`
selects released, unbatched payouts with a `vendor_id` and **no `kind` filter**,
so a remittance would be swept into a crew batch and texted to a crew as their
payout.

(Verified: that missing filter is *not* a bug today, because the only kinds are
`earning` and `adjustment` and negative adjustments are meant to net in. It
becomes one the moment a third kind exists.)

Instead: a separate `park_remittances` ledger that **reuses the rail, not the
table** — same `payout_accounts` vault, same ACH mechanics, its own batch query.
And add `.eq('kind','earning')` to the crew batch in the same commit, as a
guard.

### Where this concentrates the legal question

Being merchant of record makes park #2 harder, not easier. Collecting rent into
a LakeLife-controlled account and remitting it to a **third-party** landlord is
the structure that raises money-transmission, property-management licensing and
trust-account questions — and §7.4 of the counsel draft currently states that
collected funds are *"not held in escrow or trust… and may be commingled,"*
which is written for earned crew proceeds, not for someone else's rent.

For park #1, owner-operated, this is collecting your own rent and the question
largely does not arise. That asymmetry is the strongest argument for the phasing
below.

---

## 8. Do not model a lot as a `properties` row, and do not add a role

Two shortcuts look obvious and both are traps.

### Lots are not properties

- `properties_place_id_uidx` is a **global** partial unique index on
  `place_id`. Every lot in a park shares the park's one Google Place ID, so
  **lot 2 fails** with *"This property already has a LakeLife profile."*
- `listProperties()` returns every row where `owner_id = me`, and
  `OwnerHeader` renders them all in a `PropertySwitcher`. Eighty lots becomes an
  eighty-item dropdown, and `/billing`, `/messages` and `/book` all default to
  whichever lot sorts first — an arbitrary context.
- The `/api/ics/[token]` feed selects jobs by `properties.owner_id` with
  `.limit(200)`; a park owner's phone calendar would fill with every lot's visit
  and then silently truncate.

**Instead:** `parks`, `park_lots`, and `tenancies` as new tables. A lot acquires
a `properties` row only if and when someone actually books a lake service on it,
owned by the person whose card is charged. That keeps `properties.owner_id`
meaning exactly one thing — *"the person we charge and text"* — which is what
30+ call sites in `automation.ts` already assume.

### Renters and park owners stay `role = 'owner'`

The `services_read` RLS policy grants SELECT on `services` **only** to ops or
`role = 'owner'`. A renter with a new `role='renter'` gets zero rows, so
`/book` renders an **empty menu with no error** — killing the exact service
capture that justifies the whole project.

Worse, `user_role` is a Postgres enum: `ALTER TYPE … ADD VALUE` cannot be *used*
in the transaction that adds it, and Supabase runs a migration file as one
transaction, so a migration that adds the value and then references it dies
halfway.

**Instead:** park identity lives in side tables (`park_members`, `tenancies`).
No enum change, no RLS rewrite.

There is also a live hazard at the front door: `/portal` runs `claimCrewInvite`
for anyone not already vendor/ops, so **a park owner whose email matches an open
crew invite gets flipped to `vendor`** on first sign-in. The park branch must
come *before* the claim helpers.

### Never give a park owner the ops role

`assertOps` checks only `role === 'ops'`, and `ll_is_ops()` is a single
all-or-nothing predicate behind every ops policy. The ops page loads week
margin, margin by service, the payout queue, escalated disputes and every crew's
COI and W-9 signed URLs in one `Promise.all`. Handing a park owner that login
breaks **rule 1 platform-wide** — and `guard_role_change` makes it as hard to
take back as to grant.

Park owners get park-scoped readers with their own authorization.

---

## 9. Documents: the driver's-licence problem is the sharpest edge

Renter documents look like the crew COI flow. They are not, in two ways that
matter.

**(a) The bulk-signing pattern must not be copied.** `getCrews()` mints a
one-hour signed URL for *every* crew's COI and W-9 on *every* ops render.
`photos.ts` already warns a signed URL is a bearer token. Applied to driver's
licences, that is a page whose view-source is a working set of **every renter's
government ID**, valid for an hour, surviving a screenshot or a paste into
Slack. Identity documents need a per-record, on-click signer with a short TTL
and an audit row — in a module with no bulk variant at all.

**(b) There is no deletion path anywhere in the codebase.** Grepping `src/` for
`.remove(` on a storage bucket returns **nothing**. Superseded COIs accumulate
forever as orphans, and `deleteAccount` removes the auth user while the bucket
bytes survive. Import that pattern for driver's licences and the platform
accrues unerasable government IDs with no retention clock and no way to answer a
renter who asks for their ID back. **Build the erase path before the first
upload ships** — it is the item most likely to be deferred and least
recoverable once it has been.

**Leases need more than the ToS rail.** The storage-terms precedent stores a
browser-sent boolean and a hard-coded version string with no text and no hash —
a row asserting an instrument was executed with nothing behind it. And
`tos_accepted_at` lives on `public.users`, which **cascades on account
deletion**, so a self-service Delete button would destroy the only execution
evidence. A lease ledger must be its own table, with the user reference
nullable-on-delete, storing a hash of the exact rendered bytes.

---

## 10. Where it attaches, and how it ships dark

- **New route groups** `/park/*` (owner) and the renter surfaces, excluded from
  `sitemap.ts`.
- **A Parks tab on /ops**, following the Calendar/Crews precedent — but wrapped
  in try/catch returning an empty shape, because the ops page fetches 18
  datasets in one un-caught `Promise.all` and one rejecting park query takes the
  **entire console** down.
- **Rent runs on its own cron**, not inside the nightly. The nightly is ~25
  sequential awaits with no try/catch; a throw anywhere aborts everything after
  it, and since `sendNightlyDigest` is last and is the only alarm, the failure is
  silent. Gate the run on `todayLakeDate()` (the UTC-midnight schedule is the
  previous evening in lake time) and make the insert idempotent on
  `(lease_id, period_month)`.
- **ACH is not a drop-in.** `payments.ts` is card-only and every caller treats
  `charge()` as synchronously authoritative — `settleJob` writes `paid` the
  moment it returns true. ACH settles over days and can be **returned** after
  the fact. Rent needs `pending / settled / returned` states and a path that can
  walk a charge *back* from paid, before any ACH is enabled.
- **The feature switch** already has a precedent: `service_packages.active` is
  how the storage product ships built-but-dark. A `parks.active` flag plus a
  platform dial does the same here.

---

## 11. What this means legally — questions, not conclusions

The whole platform rests on LakeLife being a **third-party administrator** that
is not a party to the service relationship (§3 of the counsel draft) and acts
only as a crew's limited payment-collection agent (§7). Collecting rent and
holding leases is a different relationship.

**Park #1 is materially simpler than park #2, and that should drive sequencing.**
Collecting rent on a park *the owner owns* is not collecting rent for a third
party. The moment park #2 arrives, LakeLife is handling someone else's rental
income — which raises property-management licensing, trust/escrow handling, and
a much heavier compliance surface.

For the attorney, alongside the ToS work already queued:

1. Does collecting rent for a **third-party** park owner require a property
   management or real-estate licence in Indiana, and does that change if funds
   never touch a LakeLife-controlled account?
2. Indiana's mobile-home community statute, security-deposit handling, and
   notice requirements — which of these must the software enforce rather than
   merely record?
3. Fair-housing exposure: any screening, application or eligibility logic is
   regulated. **Recommendation: build no screening logic at all in phase 1.**
4. Retention and deletion obligations for driver's licences and insurance
   certificates.
5. E-signature sufficiency for a lease (ESIGN/UETA) — what the evidence record
   must contain.

---

## 12. Suggested phasing

**Phase 0 — prerequisites that are worth doing anyway.** The document-erase
path; one shared `docCurrent(expiry, today)` predicate (the same test is
open-coded in eight-plus places today); the `tos_acceptances` evidence ledger
already on the checklist; `.eq('kind','earning')` guarding the payout batch.

**Phase 1 — inventory, tenancy and services.** `parks` + `park_lots` +
`lot_reservations` (with the exclusion constraint) + `tenancies`; the park-owner
back end for lots, availability and the rent roll as a *record* (not yet
collecting); renters onboarded as ordinary `role='owner'` customers who can book
the existing lake services against their lot. A `/parks/[slug]` public page so
the park can fill vacancies. **No money movement, no documents yet** — and this
already delivers the park owner a working management system and LakeLife the
whole service-revenue case.

**Phase 2 — agreements and compliance.** The rental agreement signed in the
portal against a hashed document record; `park_requirements` +
`renter_assets` + `renter_documents`; the park owner's coverage dashboard. The
driver's-licence signer and the **erase path must land here or earlier** — never
after the first upload.

**Phase 3 — rent, on ACH.** Its own ledger, its own cron, its own remittance
batch. **ACH first, not card** — the fee model above makes that structural. The
`pending / settled / returned` state machine is a prerequisite of this phase,
not an enhancement to it, because an ACH debit can be returned days after it
reports success and `settleJob`'s synchronous `paid` assumption does not hold.

**Phase 4 — park #2 onward.** Third-party remittance, the annual park-owner
platform fee, and whatever the licensing answer requires.

The financial case is almost entirely in **Phase 1**. Phases 2–4 are what make
it a product other park owners would pay for — which is precisely why they can
wait until park #1 has proven the model on ground the owner controls.

---

## 13. Build it on a branch

Everything above lands behind a feature flag, on a git branch, with the park
tables in their own migrations. The `parks.active` switch means it can be merged
to `main` dark and turned on for one park. Nothing in this design requires
modifying an existing table's semantics — which is the whole point.
