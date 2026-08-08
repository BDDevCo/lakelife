# The Park module — MH/RV parks on the LakeLife engine

**Status:** design. Nothing built. Written 2026-08-07 after a four-lane
read-only mapping of the backend (identity/RLS, money, documents, application
surface).

**The trigger:** the owner is buying a mobile-home / RV park on Pretty Lake, and
wants park owners and renters on the platform — rent collection, leases,
document upload, asset declaration, and the existing lake services. More parks
follow if this works.

**The owner's clarification, which shapes everything below:** *"rent collection
would not have the 30%, it would just be collecting rent, we are trying to
capture more services through the platform. We will end up charging the park
owner for an annual usage but that's down the road."*

---

## 1. Why this is worth doing — it fixes the platform's worst problem

The launch model found that **~16 customers on one lake gives a crew one full
day a week**, and that thin, scattered demand is what starves crews and creates
the below-floor backlog.

**A park is 80 customers at one address.**

| | Stops/day | Crew's day |
|---|---|---|
| Golf-cart winterizations scattered round a lake | 6 | $1,058 |
| The same work inside one park | **14** | **$2,629** |

Inside a park, drive time between stops is two or three minutes instead of
twelve. The crew's *hourly* rises modestly (+16–34%); the real win is
**throughput** — the same crew clears more than twice the jobs in a day.

Modelled service capture for an 80-lot park (`docs/park_model.py`): roughly
**$92k of service revenue and $18k of margin per season**, at $1,152 of revenue
per lot — from golf-cart and mobile-home winterization, spring de-winterize,
boat storage and lot mowing. Rent contributes **$0 margin by design**.

So the park is not a rent business. **It is a customer-acquisition and density
engine that happens to also collect rent.**

---

## 2. The central rule: rent must never enter the job pipeline

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

## 2b. LakeLife as merchant of record — and the fee that decides the design

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

## 3. Do not model a lot as a `properties` row, and do not add a role

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

## 4. Documents: the driver's-licence problem is the sharpest edge

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

## 5. Where it attaches, and how it ships dark

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

## 6. What this means legally — questions, not conclusions

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

## 7. Suggested phasing

**Phase 0 — prerequisites that are worth doing anyway.** The document-erase
path; one shared `docCurrent(expiry, today)` predicate (the same test is
open-coded in eight-plus places today); the `tos_acceptances` evidence ledger
already on the checklist; `.eq('kind','earning')` guarding the payout batch.

**Phase 1 — the park as a services customer.** `parks` + `park_lots` +
`tenancies`, a park-owner portal that manages lots and renters, renters
onboarded as ordinary `role='owner'` customers who can book the existing lake
services. **No rent, no leases, no documents.** This alone captures the density
and the service revenue — the entire financial case — with almost no new risk.

**Phase 2 — documents and leases.** Renter DL/insurance with the per-record
signer and the erase path; the lease ledger with hashed rendered text; asset
declaration (golf cart alongside boat) feeding additional-insured tracking.

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

## 8. Build it on a branch

Everything above lands behind a feature flag, on a git branch, with the park
tables in their own migrations. The `parks.active` switch means it can be merged
to `main` dark and turned on for one park. Nothing in this design requires
modifying an existing table's semantics — which is the whole point.
