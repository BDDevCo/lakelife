# Park module — Phase 2 design

**Status:** design. Nothing built. Written 2026-08-07 by synthesising five
lane designs (inventory, money, compliance, screening, the owner's operating
picture) against three adversarial reviews (engine, legal, operator) and
against the code as shipped in `0052_parks_phase1.sql`.

**Supersedes nothing.** `park-module-design.md` remains the phase 1 record and
its four header constraints still bind. Where a lane design and a red-team
review disagreed, this document picks one and says why. Where a review was
itself wrong about the code, this document says that too, with the line I read.

---

## What this phase is

Phase 1 gave a park owner a lot map, a rent roll he can read, and a public page
that fills vacancies. It moves no money, holds no documents, and knows nothing
about the people already living in his park. **Phase 2 turns that into a system
he could actually run the park from:** the sitting tenants he inherited at
closing exist in it, including the ones with no email address; he can record the
money order somebody handed him at the office window; a tenant can report a
sewer backup somewhere other than his personal cell phone; short stays book
themselves and long stays apply; leases get signed and insurance certificates
get chased; and — last, because it is the hardest and the most regulated — rent
comes in by bank debit and goes out to him automatically. It also opens the one
window that makes the whole services thesis work: he can see that a crew is
coming to lot 12 on Tuesday, without seeing what his renter bought or paid.

---

## THE OWNER'S DECISIONS

Six questions. Everything else in this document is our call, not his.

### 1. Who holds a security deposit — us, or you?

**Recommendation: we hold it for your park. Everyone else's park defaults to
"you hold it," and unlocking our version requires your attorney's sign-off per
park.**

If we hold it, the money is in our settlement account and the renter's refund is
a mechanical operation on move-out day. If the park owner holds it, the refund
depends on his bank balance twelve months later — which is the normal way small
landlords fail their tenants, and the tenant blames the app.

The reason the *default* is the other way: several states require a security
deposit to sit in a segregated account, in a bank in that state, sometimes
earning interest, with a receipt naming the institution. A commingled platform
account cannot satisfy that by contract, and the penalties in those states are
frequently double or triple the deposit plus the tenant's legal fees — a defect
that is identical across all 80 tenancies, which is the definition of a class
action. **You own park #1 and Indiana appears not to require segregation, so
holding your own tenants' deposits with better bookkeeping is fine. What must
not happen is park #2 in Massachusetts silently inheriting a checkbox.**

*Consequence of choosing the other way:* we still build the ledger, still run
the 45-day clock, still produce the itemisation. We just hand you the cash with
the rent and you carry it. Slightly worse for the renter, meaningfully less
exposure for us.

### 2. Your payment processor must support sub-merchant onboarding. Check before you sign.

**Recommendation: pick Helcim or Braintree only after confirming they support
marketplace / sub-merchant accounts. Both advertise it. Verify it in writing.**

This is the sharpest recommendation in the document and it is a purchase
decision with a deadline, not a legal one. Three separate unresolved legal
questions — money transmission, property-management licensing, debt-collection
licensing — all have the same escape hatch: if each park can be onboarded as its
own sub-merchant, rent settles straight into *their* account and we orchestrate
without ever holding it. **Choose a processor that supports it and every one of
those answers becomes a configuration flip instead of a rewrite.** Choose one
that doesn't and park #2 may require rebuilding the money layer.

*Consequence:* none today. Park #1 runs as merchant-of-record either way.

### 3. Do park owners get a cut of the service revenue?

**Recommendation: no. Not a percentage of anything, ever.**

The arithmetic is decisive. At our 20% margin floor we net about 17 cents of
every service dollar after card fees. A "10% rev share" quoted the way a park
owner will quote it — ten percent of what the tenant pays — takes **59% of
everything we have.** At 17% we net exactly zero. And a share of *margin* cannot
be paid without disclosing margin: he knows his percentage and receives the
dollars, so one division tells him our margin and a subtraction tells him what
we pay the crew. That is rule 1 broken by arithmetic, permanently.

Modelled against your park: a mandate that all paid contractors register through
the platform is worth about **$9,400 a season** of extra service margin. Buying
that mandate with a 10% cut leaves us **worse off than having no mandate at
all** ($10,386 vs $15,696), while importing the entire regulatory surface of a
compelled tenant purchase.

*If a future park owner won't sign without cash:* a flat, capped, one-time
bounty per activated renter ($25–50, so $1,200–2,400 on an 80-lot park, then
zero forever), disclosed on the tenancy agreement and printed on every receipt
as `Park partner fee on this order: $0.00`. **The test: if you can't put the
number on the receipt, don't take the money.** A percentage fails that on sight.

### 4. One sentence in the renter's terms about what you can see.

**Recommendation: say it explicitly rather than implying it.**

> *"Your park manager can see that a LakeLife crew is scheduled at your lot —
> the date, roughly what kind of work, and which company. They cannot see what
> you booked, what you paid, your photos, or your messages."*

You have a legitimate reason to know a truck and trailer are coming through your
gate. You have no business knowing your tenant bought the premium heated boat
storage. The renter is being asked to accept a watcher that a lake homeowner
does not have. **It costs one sentence now and is very expensive to add once 80
renters are on the platform.**

### 5. ~~Criminal background checks~~ — SETTLED BY THE OWNER, 2026-08-08

**The park owner picks their screening package; we never ask about criminal
history; the handoff is ours to make smooth.** Owner, verbatim:

> *"let the park owner pick how they want it set up, not our call. also allow
> the park owner to pick the hold period for a person going through
> qualification..... but we need to provide the soft transition to the future
> renter applicant to what the park owner decides and give them the information
> needed of the park owner to properly recieve the final credit or background
> check from the reporting agencies. that way we dont fumble the hand
> off......but we need to get them CC authorized prior to getting that spot,
> committed early. no asking criminal history."*

What this settles, and what it overrides elsewhere in this document:

1. **The package is a PARK DIAL, applied uniformly.** `credit_only` or
   `credit_and_background`, set once in the park portal, applied to *every*
   long-term applicant at that park. Not per-applicant, not conditional.
   Uniformity is the strongest fair-housing defence there is: everyone got the
   same process.
2. **No criminal-history question on the application. Ever.** The owner
   initially proposed a *"have you ever been convicted"* question that would
   trigger a background check on a *yes*. Rejected, and he agreed. It punishes
   the honest applicant, creates the exact disparate-treatment record a
   plaintiff wants, is unlawful to ask at all in a growing list of
   jurisdictions (Seattle, Newark, Cook County, NJ statewide), and — decisively
   — a rule that reads criminal data and changes treatment IS decision logic,
   which is the thing he forbade us from doing.
3. **The hold period is a PARK DIAL too**, not a number we compute. Guidance to
   show him when he sets it: credit and eviction return in minutes; county
   criminal searches run same-day where digitised and 1–3 business days where a
   runner must pull court records; the real delay is the applicant sitting on
   the email and the owner not reading the report until Monday. **7 days** is
   the sensible default and matches the natural expiry of a card
   authorisation. A `credit_only` park can comfortably run 3–4.
4. **The handoff must not fumble.** Two obligations we take on: tell the
   *applicant*, in advance and in plain words, exactly what this park requires
   and what happens next; and give the *provider* whatever the park owner's
   delivery details are — the landlord identity the report gets sent to — so
   the report actually lands. §4c below is superseded on this point: a purely
   manual "he orders it himself" v1 is the fallback, not the goal.
5. **Card authorised BEFORE the spot is held.** Commitment comes first, then
   the hold, then the screening. See §1f-bis.

*Consequence:* we still never see a report, never store a result, never rank,
never recommend. What changed is that the park owner configures the process and
we make the seam invisible — not that we participate in the decision.

### 6. The record first. The money last. Can you live with one more season the old way?

**Recommendation: yes, and it is the fastest path to something you'd actually
use.**

Bank-debit rent is the biggest single build in this phase and it is gated on
your attorney rewriting the terms, on the processor decision above, and on
building a whole payment state machine we don't have. **Meanwhile 25–40% of your
tenants pay by cash or money order and will still be doing so in two years.**

So: the rent roll, the payment you type in at the window, the maintenance queue,
the leases and the insurance chasing all ship first and need nothing from your
tenants at all. Automatic rent comes after. Realistically you run two systems
for a season, and the app is the one that's right — because it accepts the money
order.

*Consequence of choosing the other way:* we chase ACH first, you get automatic
rent from maybe half your tenants six months later, and the rent roll is wrong
for the other half the whole time. That is how park software loses.

---

## 1. The model

### 1a. Three classes, two questions

The owner names three things. The data model must not have three shapes — three
shapes means three calendars, three availability queries, and a double-booking
guard that only covers one of them.

Two questions decide everything:

**What is on the pad?**

| | | today |
|---|---|---|
| nothing — bare RV site, tent, slip | — | `site_type` covers it |
| a **structure** that stays: mobile home, park model | **new `park_structures`** | missing |
| a **rig** that arrives and leaves: travel trailer, fifth wheel, motorhome | `renter_units` | built |

**How long is the stay?** — this drives book-vs-apply, licence-vs-lease,
renewal, and what happens at the end.

The owner's class (a) — a long lot tenancy — and class (c) — a two-night RV site
— differ only on the second question. They are the same object. Class (b), the
park-owned home, differs only on the first.

### 1b. A structure belongs to the LOT. A rig belongs to the PERSON.

This is the single most important modelling decision in the phase and it is
new — no lane design had it, and two red-team findings plus one legal finding
all resolve into it.

A mobile home that has sat on pad 14 since 2009 is a fact about pad 14. It
outlives the tenancy, it outlives the tenant's LakeLife account, it may be sold
to a new occupant without ever moving, and when it is abandoned it becomes a
liability attached to that pad and nothing else. A fifth wheel that arrives on
Friday is a fact about the person driving it.

So:

- **`park_structures`** — keyed to `park_lot_id`. Make, model, year, serial,
  length. `owned_by ∈ {park, renter, unknown, disputed}`. `title_status ∈
  {clear, missing, lien, estate, unknown}`. `rentable boolean` — true only for
  homes the park owns and rents out. Survives every tenancy.
- **`renter_units`** — unchanged in meaning: the rig a renter brings. Personal
  property, and its privacy posture in 0052 is correct *because* it is.

What this fixes, in one table:

| Problem | How it resolves |
|---|---|
| Park-owned homes have nowhere to live (`renter_units.user_id` is NOT NULL, and `guard_lot_reservation` rule 1 raises on every park-home booking) | park homes are `park_structures` with `rentable=true`, `owned_by='park'` |
| A renter deletes their account and the record of the 1998 Fleetwood on lot 14 dies with it (`renter_units.user_id ... on delete cascade`, `0052:142`) | the structure was never keyed to the user |
| Donna sells her single-wide in place to a new occupant — the most common turnover event in an MH park — and the home's identity dies between tenancies | the structure never moves; only the occupancy pointer changes |
| An abandoned home has no representation, so the lot reads *vacant* and the software tells him to list it | `owned_by='unknown'` + the lot goes out of service (§1e) |
| The park owner's insurer, lender and attorney all ask for a structure inventory and there isn't one | it is now the same table |

**Guard rules, in the database, not in comments:**

1. A reservation targeting a lot whose active structure is `rentable=true` MUST
   carry that `park_structure_id`.
2. A reservation targeting a lot whose active structure is `rentable=false`
   (someone's mobile home is sitting there) is only reachable through the
   transfer flow — you cannot sell an RV site out from under a house.
3. `renter_unit_id` and `park_structure_id` are mutually exclusive.
4. A structure may not be moved to another lot while any holding reservation
   references it with a future end date.

### 1c. The double-booking constraint — the engine review was right and the inventory design was wrong

The inventory design claimed that pinning a park home to a lot meant
`lot_no_double_booking` kept working unchanged, "no second exclusion
constraint." In the same section it allowed park models to be moved between
lots. **Those two statements are incompatible and the failure is two families
arriving at the same trailer.**

Verified against `0052:192-197`, the constraint keys on `park_lot_id` only:

```sql
exclude using gist (park_lot_id with =, during with &&)
where (status in ('approved', 'active'));
```

Move the structure from lot 3 to lot 7 and a second booking of the *same home*
compares `7 ≠ 3` and sails through. **Fixed: a second exclusion constraint on
`park_structure_id`, plus guard rule 4 above.** `btree_gist` is already
installed, so this costs one statement.

**A second, subtler fix.** 0052 is deliberately re-runnable — a disaster-recovery
replay, a `db reset`, a branch rebase. It does `drop constraint if exists
lot_no_double_booking` and recreates the two-status version. If 0053 redefines
the *same name* to add the `held` status, a replay silently reverts it and
0052's own post-condition — which only checks that a constraint by that name
exists — passes. **Fixed: 0053 adds `lot_no_double_booking_v2` under a new name.
A 0052 replay then re-adds the weaker constraint alongside the stronger one,
which is harmless.**

### 1d. Sitting tenants who are not app users

`lot_reservations.renter_user_id` is `not null references public.users(id)`
(`0052:161`). Every long-term tenant the owner inherits — the handshake ones,
the ones with a flip phone, the ones who pay by money order — is
**unrepresentable on day one.** This is the hard stop, and nothing else in
Phase 2 works until it moves.

Realistic numbers for a rural northern-Indiana park with an older long-term
base: roughly 70% have a smartphone but only 40–50% of the over-70s do; about
55% have an email address they actually read; 25–40% pay cash or money order
today; and bank-debit enrolment plateaus at 50–65% in year one.

**The fix: `park_renters`.** A person the park knows about, who may or may not
ever have a LakeLife account.

```
park_renters(id, park_id, display_name, email, phone_on_file_with_park,
             contact_pref, user_id, claimed_at, invite_token, notes)
```

`park_renters.id` becomes the NOT NULL renter pointer on `lot_reservations`;
`renter_user_id` becomes a nullable *claimed* link. Three things follow:

1. The rent roll is real on day one without a single tenant signing up.
2. It is the sales demo for park #2 — a park with 200 sitting tenants onboards
   in an afternoon.
3. **It fixes a privacy shape.** Today the rent roll reaches into `users` with a
   hand-narrowed select whose own comment says *"this file is service-role so
   nothing but this narrow select stops us."* With `display_name` on the renter
   row, the park owner's roll never touches `users` at all — structural, not
   conventional.

**`contact_pref ∈ {app, sms, email, paper, in_person}` is a first-class field,
not a derived one.** A `paper` renter is excluded from every automated send and
appears instead on a printable notice sheet the owner runs monthly, which is
genuinely what these parks do. **Never require an email.** And a 74-year-old who
has paid on time for fifteen years must never render amber on his board because
she doesn't have the app.

**The column is deliberately named `phone_on_file_with_park`, not `phone`.**
See §2f — that name is a safety device.

### 1e. Lots that are not inventory

`park_lots.active` today means two different things — *"this lot exists"* and
*"show it publicly."* Phase 2 needs three states, and the third one is the
defining problem of the industry.

An abandoned mobile home has **negative** value: $4,000–8,000 to demolish, no
title, can't be moved, can't be sold, and the lot is dark for 3–18 months while
the statutory abandonment process runs. He probably inherited one at closing.

Today the only tool is `active = false`, and `summarise()` (`park-helpers.ts:160`)
does `if (r.state === "inactive") { s.inactive++; continue; }` — it leaves the
denominator. **His occupancy percentage improves as his problem gets worse.**
That is the worst property a dashboard number can have, and an owner who catches
it once stops trusting every number on the screen.

**Fixed:**

```sql
park_lots
  active        boolean  -- unchanged: this lot is real inventory
  listed        boolean  -- NEW: show it on the public page
  service_state text     -- NEW: in_service | out_of_service
  oos_reason    text     -- abandoned_unit | demo_pending | title_dispute
                         -- | estate | pad_failed | utility_failed | flood
                         -- | renovation | held_by_owner
  oos_since     date
  oos_est_cost  numeric(10,2)
```

Out-of-service lots stay in the occupancy denominator, get their own tile —
**"3 lots out of service · 214 days · est. $18,000 to recover"** — and are
suppressed from every fill suggestion unconditionally. That number is what
finally makes him spend the $6,000 on demolition, and no competitor shows it to
him.

**Also fixed in the same migration:** `park_lots_read` and `lot_rates_read`
(`0052:316-331`) do not filter on `park_lots.active`, so in a published park
anyone can read the inactive lots and their rates directly. Verified. Today that
exposes the RV row he is clearing; after this phase it would expose unlisted
park homes and their prices. The public arm of both policies gains `and listed`.

### 1f. Book now vs. apply

**The dial is nights, not term name.** A "monthly" term booked six times and an
"annual" term are the same tenancy and the same risk.

```
parks.instant_book_max_nights   smallint  -- default 31, null = nobody instant-books
park_lots.instant_book          boolean   -- null = inherit, true/false = override
```

31 covers exactly the owner's own list — *"overnight, weekly, short term rentals,
maybe even monthly"* — including a 31-day calendar month, and excludes every
~3-month stay. The per-lot override earns its keep immediately: his mobile-home
pads set `instant_book=false` so a stranger's rig never lands on a pad reserved
for MH; the four park homes and the future RV row inherit the park default.

`parks.approval_required` finally does something. It is read in two files today
and enforced nowhere — `applyForLot` writes `status:"applied"` unconditionally.
Resolved rule:

```
nights <= threshold                            -> instant book
nights >  threshold AND approval_required      -> application
nights >  threshold AND NOT approval_required  -> instant book
```

**The stacking loophole, and it is the important part.** Four sequential 30-night
instant bookings produce a four-month tenancy with no application ever. So the
threshold is evaluated on **total contiguous occupancy by the same renter in the
same park**, not on the increment — summed across lots (moving a guest from site
7 to site 12 does not reset the clock in any conversion analysis) with a
`gap_tolerance_days` default of 7.

When a renewal would cross the line, the software **stops one renewal in
advance** and hands the park owner a plain-English task:

> *"Renewing Jane on lot 12 again takes her past 90 days total. In Indiana
> that's a tenancy, not a camping stay. Approve and send a lease?"*

It never silently converts a camping guest into a tenant.

**And the office window.** There is no owner-side booking path at all today —
every reservation must originate from a renter's phone (`applyForLot` requires
`auth.getUser()`). Walk-ins are 20–40% of transient business, heavily Friday
evening, and extensions are negotiated verbally at 9am on checkout day. Phase 2
adds `bookAtTheOffice(...)` — pick a lot, name, phone, dates, take the money,
sixty seconds — plus one-tap no-show and one-tap early departure. A 2-night
extension must never go behind a workflow.

### 1f-bis. Commitment: authorise the card, then hold the spot

Owner decision, 2026-08-08. The order matters and it is deliberate:

```
apply -> COMMIT (card AUTHORISED, spot held) -> screening handoff
      -> park owner decides -> arrival
```

**Authorise, do not capture.** The renter sees a pending amount, which is what
makes it feel committed; the money never moves. This is the whole reason the
mechanism is safe:

| Outcome | What happens |
|---|---|
| Declined by the park owner | auth voided — nothing was ever charged |
| Applicant walks away | auth voided — **no penalty, total release** |
| Approved | captured, and **credited to their deposit**, never an extra charge |

Owner, verbatim: *"its a total release if they walk or not approved. no
penalties."* There is no forfeiture path. That is not a simplification we chose
for convenience — it deletes the entire chargeback-and-dispute surface, and it
means we never hold money we might owe back, which is the thing that drags a
holding deposit into security-deposit statutes.

**Amount: 25% of the first month's rent**, park-overridable. Tied to the money,
not the term — a month on a premium lakefront site is not a month on a back lot,
so *"3 months = $X"* is wrong in both directions. A $650 lot holds at ~$160; a
$1,400 park home at ~$350. Large enough to mean something, small enough that no
regulator reads it as a security deposit.

**The hold window and the authorisation window are the same window.** Card
auths lapse naturally in about 5–7 days, which is why the park owner's hold
dial defaults to 7. If a screening drags, we *re-authorise* (one tap, renter
notified) rather than extend — there is never a live lot hold sitting behind a
dead authorisation.

Two nudges keep a held lot from going dead: day 2 to the applicant if they have
not started, day 5 to the park owner if a completed screening is sitting
unreviewed.

### 1g. Licence vs. tenancy — three dials, not one

Getting this wrong is how a park owner ends up unable to remove someone, or
worse, removing someone unlawfully.

**The regime is snapshotted on the reservation, never derived on read.**
`agreement_class ∈ {license, lease}`, plus the reason and — critically —
`agreement_class_set_by`. Null means the software proposed it from the park's
dial; a user id means a human overrode it. When the attorney asks *"on what
basis did you treat this as a camping licence,"* the answer is a row, not a
re-computation against dials that have since changed.

**Default is `lease`** — it fails toward the heavier regime. Treating a real
tenancy as a licence costs an eviction; the reverse costs paperwork.

**Three separate dials, because they answer three different questions:**

| Dial | Question | Who sets it |
|---|---|---|
| `instant_book_max_nights` (31) | how long a stay will I sell without meeting the person? | the owner — business |
| `license_max_nights` (29) | how long before Indiana calls this a tenancy? | **counsel** |
| `lodging_tax_max_nights` (30) | how long before lodging tax stops applying? | **the accountant** |

The lane design conflated the last two. They are frequently different numbers in
the same state, and one is a tax rule while the other is a property rule.

**Duration is not the only test, and the design used only duration.** Courts also
look at exclusive possession, periodic rent, receipt of mail, and — most
decisively — **whether the occupant has another home.** So on any stay over the
threshold we ask one question: *"Is this your only home right now?"* If yes,
propose `lease` regardless of nights. One field, and it is the one most likely
to decide an actual case.

**A licence reaching its end date does NOT write `ended`.** The lane design had
it auto-end and the Fill tab then offered a one-tap "show it on my page." If the
occupant was actually a tenant, the software has recorded a termination with no
notice and no process, and then advertised their home. **Fixed:** it writes
`expired_awaiting_departure`. `ended` requires a human confirming the person and
their property are physically gone. A lot is never vacant, never listed, and
never re-bookable until then.

**And the hardest line in the phase.** We hold the encrypted gate code for every
property. A "lock them out until they pay" feature is technically trivial here
and is an unlawful self-help eviction essentially everywhere. **The gate-code
rotation function lives in a module that does not import tenancy state or money
state, and a migration post-condition asserts it.** It must be structurally
impossible, not merely unwired.

### 1h. Open-ended tenancies, and why we forbid them

`parseDaterange` (`parks.ts:139-149`) requires two dates and returns null on
`[2019-05-01,)`. Null range → `coversDay` false → **the rent roll reports the
lot vacant while someone is living on it.** His park is full of exactly this
shape.

We forbid unbounded ranges with a CHECK, and model month-to-month as a rolling
finite range that a cron extends. Four reasons: an unbounded row blocks that lot
forever under the exclusion constraint, including for the renter's own next
term; five separate functions assume finite; *"who is about to leave"* is
undefined for an unbounded range and it is an explicit owner requirement; and
renewal-by-extension is an UPDATE the exclusion constraint re-validates for
free — so if the park has booked someone into that future window, the extension
raises and lands in the owner's queue with a real reason.

The importer writes the finite range **silently**. Never ask him for an end date
he does not have.

### 1i. Seasons are a property of the lot, not the park

`parks.season_open/close` is one window for the whole park, checked on every
night of a stay. In a mixed park in Steuben County that is wrong in both
directions: **mobile-home residents live there all winter** — water, sewer,
trash and plowing continue — while **RV site water is shut off** at the frost
line and the bathhouse closes. Set a season and a February application from a
mobile-home tenant is refused because "the park is closed." Set none and the RV
sites cheerfully sell January nights with no water.

**Fixed:** season override per lot (nullable, inheriting the park), plus a dated
`utilities_off` state per lot or loop which is surfaced to the renter **and on
the crew's job card** — a crew arriving to winterize needs to know, and *"why
doesn't my water work"* is the number one spring call.

Winter rig storage is then a rate, not a term: a `lot_rate_rules` row with a
season window. That only works if rent resolves the rate per period rather than
from the whole-stay quote — see §2c.

---

## 2. Money

### 2a. The wall holds — verified, not asserted

The engine review traced all 25 calls in the nightly cron. Every one starts from
`jobs`, `payouts`, `referral_earnings`, `storage_stays`, `vendors`, `lakes`,
`autopilot_enrollments` or `user_credits`. A rent ledger with no foreign key and
no query into any of them genuinely cannot be reached by `expireUnfilledJobs`,
`recordNoShows`, `settleJob`, `reconcileCancelledFees` or the dispute
auto-refund. **The six breakages in the 0052 header all require a `jobs` row and
none is reintroduced.**

A migration post-condition asserts it mechanically: **zero foreign keys from any
`park_*` money table to `jobs`, `invoices`, `payments`, `payouts`,
`user_credits` or `referral_earnings`**, plus a repo test that greps the park
money modules for those names. "No error is not proof" — 0050's lesson.

Two things do cross, and both are handled: `payout_batches`, which is reused
deliberately (§2e), and the `properties` row we mint for a lot (§2g).

Independently, one structural fact ends the "could rent reuse `invoices`?"
question before any of the six breakages are reached: `payments_one_capture_per_invoice`
(`0024:15-17`) permits **one captured payment per invoice, forever.** A renter
who pays $300 of $450 is unrepresentable.

### 2b. The screen that decides whether he trusts us

Saturday, 9:40am, three people at the office window with money orders. He takes
them and writes receipts in a book. Monday the app says he collected $19,200 of
$27,200 and eleven tenants are overdue. **He now has two systems and ours is the
wrong one.**

The schema for this is easy — `park_payments.method` already includes `cash` and
`check`, with `recorded_by`. The lane designs buried it as a Phase 2a bullet.
**It is the most-used screen in the product and it ships in the first phase,
built like a point-of-sale terminal and not like a form.**

- **Three taps, standing up, one hand, in a golf cart.** Lot number → amount
  pre-filled from the balance → Save. No date picker. No method picker unless he
  taps to change it.
- **A receipt**, by text or printable. Cash tenants want one, and *"I paid you"*
  is how small parks end up in small claims.
- **A "recorded today" list** with one-tap void inside the hour. Two people take
  money on a Saturday; idempotency keys do not help when it's two humans.
- **Honest connectivity.** Rural office wifi is marginal. A page that silently
  fails while a tenant stands there with cash is worse than paper. Minimum: a
  visible unsaved state that survives a reload.
- **Never imply the collected number is complete when a park has offline
  payers.** Show *"collected $28,400 — $9,100 of that recorded by you."* He'll
  trust it more, not less.

### 2c. The rent ledger

Rent needs four things `invoices` cannot do: partial payment, multiple open
periods, one payment spanning periods, and owner-issued credits. Standard
accounts-receivable triple:

- **`park_charges`** — what is owed. Immutable once issued; corrections are new
  negative rows.
- **`park_payments`** — money received or attempted, carrying the bank-debit
  state machine.
- **`park_allocations`** — which dollars paid which charge. Every conservation
  rule lives here.

**Charge types are defined by the park owner**, not hardcoded. Rent, submetered
water, pet rent, second vehicle, slip fee, storage lot — the same object with
different rows. This is the escape valve `park-module-design.md §1i` named, and
it is what prevents the first custom-build request.

**One correction to that, from the legal review:** mobile-home-community statutes
commonly enumerate the charges a community may impose and prohibit the rest. A
free-text charge code is precisely the mechanism that lets a park invent a
prohibited fee — and we would bill it. **So the code comes from an allowlist
with a per-state disabled set, the label stays free text, and every charge type
carries a required `disclosed_in_agreement` boolean. An undisclosed charge
cannot be billed.**

**Period arithmetic gets exactly one home.** Three lane designs proposed three
different modules and they disagree by 2×. Verified: `quoteStay` uses
`TERM_NIGHTS.monthly = 30` with `ceil(nights/30)`, and `parks.test.ts:151-157`
*asserts* that 364 nights is 13 monthly periods. So a July 1 → August 1 monthly
lot quotes **$1,800** into `quoted_amount` — the column whose own comment says
it is snapshotted so a later change never rewrites what the renter agreed to —
while a prorating rent engine bills **$900**. The renter has a screenshot of one
number and the ledger says the other, and the dispute is unanswerable because
both are "correct."

**Fixed:** `src/lib/rent.ts` owns all period math, with calendar months and
calendar years. `quoteStay` becomes a thin wrapper over it. The existing
13-period test becomes the `round_up` case rather than being deleted, because it
is right for a seasonal campground and wrong for a residential monthly rental —
so it is a dial (`partial_period_policy ∈ {prorate, round_up}`), not a bug fix.
An invariant test asserts the two agree for any reservation under the same
policy.

*One correction to the reviews:* the "3-year lease bills 4 years" bug is real
arithmetic but unreachable today — a park with no annual rate row gets `null`
from `quoteStay` and the application is refused. It will bite the first park
that sells annual terms. Present it as latent, not live.

### 2d. Overdue — and the tenant who is always late and always pays

The hard line from phase 1 governs: **the platform records the failure, notifies
both parties, and stops.** It never generates a legal notice and never
escalates.

Larry has paid on the 12th every month for nine years. He is fine. In a real
park, 10–20% of tenants are chronically 5–15 days late and always pay, and
another 5–10% pay in two chunks around paydays. A park-wide `grace_days` dial
texts Larry four times a month forever, and by month three he hates the app, the
new owner, and tells everyone at the mailboxes.

**Four controls the lane designs did not have:**

1. **Per-tenancy grace override**, defaulting to the park value, audited. This
   is not a hack; every real park system has it.
2. **A payment plan is an object**, not a verbal arrangement. It suppresses the
   ladder, keeps the balance visible, and fires **once** if broken.
3. **One-tap "pause all automated messages for this tenancy."** No reason
   required, no expiry, reachable from every delinquency row.
4. **An `estate` tenancy state.** In an 80-lot park with an older population,
   someone dies one to three times a year. An SMS reading *"Your rent of $340 is
   7 days overdue"* to a widow's phone three days after the funeral is the worst
   thing this product could do, and today nothing prevents it. The state kills
   all automation, does **not** free the lot (the home is still there — this is
   often an abandonment in slow motion), and surfaces as a human task with no
   clock on it. The same switch covers hospice, a house fire, and a tenant who
   just called crying.

**A mass-failure circuit breaker.** If more than 20% of a park's bank debits fail
in one run, halt, send nothing to renters, and alert the owner. Forty of forty
failing is a configuration error, not forty broke tenants, and texting forty
people that their rent payment failed is unrecoverable.

**And one sentence on every automated reminder:** *"This is a reminder from
[Park] sent through LakeLife. It is not a legal notice."* Cheapest protection in
the document, because a park owner **will** treat our reminders as if they were
the statutory notice.

**Rent-increase notice periods are band-clamped by statute, not typed freely.**
The lane design gave no default on principle ("we never suggest a number"). That
is the wrong application of a good rule: mobile-home statutes commonly set a
minimum notice for a lot-rent increase, and a park owner who guesses 30 where the
law says 60 gets an unenforceable increase — delivered by our cron. The floor
comes from a counsel-populated state table (§6a); he may go longer, never
shorter.

### 2e. Deposits, and paying the park owner

**Deposits are a separate ledger with four things kept distinct** — a refundable
security deposit, a non-refundable fee, prepaid rent, and an incidental
authorisation hold. `park_deposits` has **no `refundable` column, on purpose**: a
deposit is refundable by definition, and a non-refundable cleaning fee is a
charge. Several states read "non-refundable deposit" against the landlord.

**Transient stays get an authorisation hold, not a captured deposit.** A $300
hold that expires on its own creates zero custody, zero return path and zero
statutory clock. Captured deposits are for long tenancies only — and those
collect and return by **bank debit**, not card, because a card refund window
closes long before a twelve-month tenancy ends and there would then be no return
path at all.

The invariants copy the refund engine, which is the best-tested money code in
the repo: insert the claim first, re-check, call the processor only for a claim
that survived; a database trigger with an advisory lock enforcing `returned +
forfeited <= collected`; and **no itemisation, no forfeiture** — which is rule 2's
logic (no evidence, no money) applied to deposits. **The uncontested remainder is
returned immediately.** Freezing $500 over a $75 disagreement is the behaviour
that makes tenants hate landlords, and we can simply not do it.

**Paying the park owner reuses the rail, never the table.** `payout_accounts` is
already keyed on `user_id` and its own header says it serves crew *and* HOA
users; the ACH export already falls back to `users.name` when there is no
vendor. So `park_remittances` is its own ledger that populates `payout_batches`
directly. It must not be a `payouts` row — `guard_payout_anchor` raises on a
null `job_id` anyway, and `runMonthlyPayoutBatches` would sweep it into a crew
batch and **text a crew that it is their payout.**

**Three fixes ship with it, and the reviews found one the lane design missed:**

- `.eq("kind","earning")` at `automation.ts:1943` — verified still absent.
- The same filter at `src/app/vendor/bank-data.ts:32`, which renders a user's
  batches on the crew Money page with no kind filter. **A park owner who is also
  a crew — entirely plausible here — would see his rent remittance presented as
  a crew payout.**
- `payout_batches.paid_at` and `status='paid'` are written by nothing. Verified.
  Survivable sloppiness for crew credits; it destroys the only answer to *"did
  the park owner actually receive March?"*

**And the bank-change controls**, because this is a $36,000/month redirect and a
textbook business-email-compromise target: a text-message code at the moment of
change (the verification routes already exist), a 3-banking-day cooling-off
before a new account can receive anything, and an append-only
`payout_account_history` — today `payout_accounts` is a single mutable row with
no history whatsoever.

### 2f. Deposit custody and tax: two places where the default matters more than the feature

**Custody** is decision 1 above. Mechanically: `deposit_custody ∈ {park_holds,
platform_holds}`, **defaulting to `park_holds`**, and `platform_holds` requires a
per-park counsel-clearance record (actor, date, note) that a trigger enforces and
that is cleared automatically if the park's state or address changes. Park #1 is
the only cleared instance at launch. This reverses the money lane's default and
keeps its recommendation for the park that matters.

**Lodging tax is not a bookkeeping choice, and the timing of finding that out
matters.** A growing number of states make the platform that lists the inventory
and takes the guest's money the statutorily required collector of sales and
lodging tax, regardless of what the parties agree. We are merchant of record.
These lakes sit across **Steuben and LaGrange**, which are separate innkeeper's-tax
jurisdictions. **So the facilitator analysis is a gate on the first transient
booking, not on park #2** — that is a sequencing change from every lane design.
Regardless of the answer, the `taxable` / `tax_amount` / jurisdiction columns
ship in Phase 2 even if every rate is zero: retrofitting tax onto a ledger with
a paid history is a genuinely painful migration.

### 2g. The one place the wall is thin

The rent ledger cannot reach the job engine. **The `properties` row we mint for a
lot can, and it does — by design, because that is how a renter books services.**
Two paths bite:

**Autopilot outlives the tenancy.** `generateAutopilotProposals` reads
enrolments joined to properties, checks nothing about tenancy state, and the
property row survives `endTenancy` — which only flips a reservation status. A
renter who moved out in September gets an Autopilot text in April, and the
one-tap confirm route **inserts a real job at a lot now occupied by someone
else.** A crew is dispatched to a stranger's trailer. **Fixed:** `markMovedOut`
deactivates autopilot enrolments for that property in the same transaction.

**Coordinate-less lots silently kill the density thesis.** `parks.lat` and
`parks.lng` are declared in 0052 and written by nothing. A minted lot property
inherits null coordinates, drops out of proximity ranking and out of
nearest-neighbour routing, and the single biggest operational selling point —
80 stops at one pin, a crew day going from $1,058 to $2,629 — evaporates with no
error anywhere. **Fixed:** `markMovedIn` copies the park's coordinates, and
`setParkLive` refuses to publish a park with no `lake_id` and no coordinates, in
the same block where it already refuses a park with no lots.

`lake_id` matters for a second reason: `dispatch.ts` reads `if (input.lakeId &&
!c.serviceLakes.includes(lakeId)) return false`, so **a null lake silently
disables the geographic crew gate entirely.**

---

## 3. Compliance

### 3a. Two things that must exist before the first upload

0052's header deferred documents because *"the per-record signer and the
storage-erase path must exist before the first upload; neither does."* Verified
still true: `grep -rn "\.remove(" src/` returns **zero hits**, and the ops crew
page mints one-hour signed URLs for every crew's insurance certificate and W-9
on every render.

`src/lib/docs.ts` — the only module that touches document bytes — with three
functions: `signOneDoc` (one record, one viewer, an access-log row, per-class
TTL, **no bulk variant exists in the module on purpose**), `eraseDoc`
(idempotent, always writes an erasure row even when the object is already gone),
and `eraseAllDocsForUser` / `...ForProperty` which **enumerate before the
cascade**, because `deleteAccount` cascades before you can list paths.

Three new private buckets, split by retention clock and legal basis:
`park-agreements` (retained; the erase sweeper cannot see this bucket),
`renter-docs` (expiry + 2 years), `renter-identity` (hard maximum 7 days, and
default-empty).

**`document_erasures` is permanent and is never itself erased.** It is the proof
erasure happened.

**The erase path must land before the `park_renters` import, not just before the
first file upload** — the import is the first collection of personal data about
people who are not users.

### 3b. Agreements and the evidence ledger

The current acceptance record is two columns on `users` — a version string and a
timestamp — written by a scroll-box with **no checkbox**, no hash of what was
shown, no IP, one row per user rather than per instrument, and living on a table
that **cascades away when the account is deleted.** A renter's Delete button
would destroy proof they signed a twelve-month lease.

`document_envelopes` + `document_signatures`, append-only, with:

- **the exact rendered text and its SHA-256**, computed at render and re-checked
  at signature — a mismatch aborts;
- **`signer_user_id ... on delete set null`**, with name, email and phone
  denormalised onto the row *at signing*, so the record still names a person
  after deletion;
- checkbox state, typed legal name, IP, user agent, and **a fresh text-message
  code at the moment of signing** — which reuses the existing verification
  routes unchanged and produces better attribution than a provider's default
  emailed link;
- the park name, lot number and term dates denormalised too, so an executed
  lease still says what it was for after the tenancy row is gone.

**Build in-house for v1, don't buy.** Not on cost ($600–2,400/yr per park is not
decisive) but because there is **zero webhook infrastructure in this codebase**
and a provider means a second state machine that can drift out of sync with the
tenancy. `method ∈ {in_app_clickwrap, provider_esign, wet_signature_scan}` ships
from day one so adding a provider later is a new value, not a migration. Buy when
a park's attorney requires a third-party certificate, or the first time a
signature is genuinely contested.

**The canonical artifact is the exact text plus its hash, not a PDF.** There is
no PDF library in the project and the hash covers the bytes actually displayed,
which is stronger. Emailed inline to both parties as their retained copy.

**We never write the lease.** The park pastes their attorney's text; we fill the
blanks from a closed allowlist of merge tokens; a render with any unresolved or
unknown token cannot become an envelope, because a lease that goes out with a
literal `{{rent.amount}}` in it is worse than no lease. No loops, no conditionals
— a templating language is a code-injection surface and an invitation to
per-park logic.

### 3c. The trap that would have made half our guards do nothing

The compliance design proposed that only a park **owner** may mark a lease
template as counsel-approved, enforced by a trigger. **Every park write in this
codebase goes through the service role, and under the service role `auth.uid()`
is NULL.** Written the obvious way that trigger either always raises — blocking
every legitimate save — or, guarded against null, always passes.

0052 got this right and the lane designs did not notice why: `guard_lot_reservation`
rule 2 tests `new.decided_by`, **a column the caller must write**, never
`auth.uid()`.

**Rule for every new guard in this phase: validate a caller-written actor column
against `park_members`. Never call `auth.uid()` in a trigger.**

The same trap has a second face — silent empty screens. A view carrying its own
`ll_manages_park(...)` predicate returns **zero rows with no error** when read
with the service role. So:

> **A view that crosses a privacy boundary carries its own WHERE and is read
> with the session client. A view that does not is read service-role and
> hand-scoped like everything else in the module.**

`park_jobs` (§5b) is the first kind. `park_inventory` is the second, and drops
the predicate the lane design gave it.

### 3d. Insurance — the renter version of the crew certificate

Four things port cleanly from the crew flow: expiry validated before any bytes
are stored, the MIME whitelist and size cap, private bucket plus server-minted
signed URL, and the pure state classifier.

Four things must change:

1. **The lapse has no backstop.** An expired crew certificate silently drops that
   crew from every candidate pool, so a missed email costs them money and
   self-corrects. **For a renter nothing stops** — the boat stays in the slip and
   the park is uncovered. So the one-shot exact-boundary reminder is wrong here;
   use an escalating ladder on a sent-ledger (−45, −30, −14, −7, day 0, then
   weekly to a cap), notifying **the park owner too** from day 0.
2. **Row per upload, never overwrite.** The crew flow patches a column, so there
   is no history. A park owner arguing whether coverage existed on the date of a
   loss needs the version that was on file that day.
3. **Capture the limits.** Today we store presence and expiry only. A park
   requiring *"$300,000 minimum, park named additional insured"* has nowhere to
   put it.
4. **Verification is a human decision.** Software can read a date; it cannot tell
   whether the endorsement really names the park. No OCR, no adequacy check. It
   *can* compare the renter's typed number to the required number and say *"they
   typed $100,000, you require $300,000"* — that is arithmetic on two declared
   values, not a judgment about a document.

### 3e. Auto-renewal

**Ships off, per park, and cannot be turned on until the park owner records that
their counsel approved the renewal clause and the notice window.** Automatic
renewals in residential tenancies are regulated and the rules vary — notice
windows, conspicuousness, sometimes prohibition outright.

Two design calls worth defending:

- **A rent increase is a new offer, not a renewal.** Non-zero escalation forces a
  fresh envelope and a fresh signature. Silently extending a tenancy at a higher
  price on a clause signed a year ago is the exact pattern these statutes exist
  to punish. Enforced by a database check, not a code path.
- **`renew_on_no_action` never defaults to `lapse`.** Silently ending a tenancy
  where a family lives and a mobile home physically sits is the dangerous
  terminal. Default `renew`; `holdover_monthly` is the honest middle. And even
  `lapse` produces **no notice to quit, no filing, no fee** — the status changes
  and both sides are told.

Non-renewal by the park is not a free choice either. Mobile-home statutes commonly
restrict the *grounds*, so it requires selecting from a park-configured,
counsel-approved list, it is never one tap, and our message to the renter says
only *"the park has told us they are not renewing"* — no characterisation, no
date computed by us.

**Renewal extends `during` on the same row** rather than creating a second one,
which gives us the exclusion constraint's re-validation for free.

### 3f. What "red" actually means

The compliance view is a pure function returning **checks with reasons**, never a
score. Roll-up is green / amber / red / **unknown** — and `unknown` exists
specifically so a park with rent turned off, or a tenancy created before the
module shipped, does not render red. A false red is worse than a blank: he learns
to ignore the colour, and then the real red is invisible.

**Permitted consequences of a red tenancy:** it shows red on his board with
reasons; reminders go out; a park-controlled optional privilege directly related
to the missing document may be withheld as a one-tap owner decision; and
**auto-renewal does not silently advance** — the cycle lands in his queue. That
last one is a *non-action*: the software declines to take an automatic step and
asks a human.

**Forbidden, in code comments and in the design:** never blocks portal access;
never blocks a service booking (that is our revenue and unrelated to his
paperwork — a red tenancy that can still book a winterization is the right
outcome for everyone); never blocks paying rent; never assesses a fee; never
generates a document with legal effect; never auto-ends anything. And the colour
is always attached to a named document with a date, never to a person.

---

## 4. Screening — how we stay out of the credit-reporting business

### 4a. The three switches

The Fair Credit Reporting Act does not care about intent. A consumer reporting
agency is anyone who **(1) for a fee, (2) regularly assembles or evaluates**
consumer information, **(3) to furnish reports to third parties.** All three must
be present. Our job is to keep at least two of them off, permanently:

| Switch | What trips it | Our posture |
|---|---|---|
| Fee | charging, marking up, or taking a per-report referral cut | **off** — we take zero dollars per report |
| Assemble / evaluate | merging sources, computing a score, applying criteria, even normalising two providers' output into one shape | **off** — we never receive report content |
| Furnish to third parties | transmitting anything report-derived to the park owner | **off** — the provider delivers to him directly |

Two adjacent traps. A "reseller" who procures reports for resale is **still a
CRA** — *"we just pass it along"* is the reseller definition, not an exemption.
And the fastest way to become an obvious one is a feature that sounds helpful:
*"this applicant applied at three other parks on the platform."* That is
assembling information on a consumer from our own database and furnishing it for
a subscription fee. **It must never be built.**

### 4b. Stricter than the minimum: we do not store a pass/fail

The lane brief left this open. **Recommendation: don't.** A pass/fail derived
from a consumer report *is* consumer report information, and relaying it from
provider to park owner is arguably furnishing a report to a third party — the
third switch, satisfied for free, by a boolean. The value is a nicer dashboard.

We store: that an order exists, its status, who ordered it, and afterwards the
decision a named human recorded. Nothing else. **No Social Security number, no
date of birth, no score, no report, no verdict** — and a migration
post-condition fails the build if anyone adds a column matching those names.

*One correction to the design's own claim:* we do store `based_on_consumer_report`
— the fact that a report caused a denial, about an identified consumer. That is
derived-from-report information. It is necessary and I think it is fine, but say
it to counsel rather than letting them discover it.

**The post-condition itself was broken as drafted.** Its regex literal spanned
lines, and SQL string literals preserve newlines, so every alternative after the
first break became unmatchable — leaving `result`, `payload`, `criminal`, `dob`
and about twenty others silently unchecked. `result` and `payload` are the two
most likely columns a future engineer adds. Fixed: one line, or an array loop.

### 4c. The handoff — "that way we dont fumble the hand off"

*Revised 2026-08-08 by owner decision — see Decision 5. The manual flow below is
the v1 FALLBACK, not the target. The seam has to be invisible.*

**What the park owner configures once:** their provider, their package
(`credit_only` / `credit_and_background`), their hold-period days, and — the
piece that stops the fumble — **their delivery identity**: the landlord name,
account or email the provider sends the completed report to. Without that, the
report goes nowhere and everyone blames the app.

**What the applicant sees, before they spend a dollar:** exactly what this park
requires, who runs it, roughly what it costs, roughly how long it takes, and
that LakeLife will never see it. Then one button into the provider's own flow,
carrying whatever the provider allows us to pass. They come back to us when
they are done; we know only that they finished.

**What the park owner gets:** a notification the moment the applicant completes
the handoff — *"Jane Smith submitted her screening with [Provider]; the report
comes to you from them, at [his configured delivery address]."* Naming the
delivery address in the alert is deliberate: it is the cheapest possible
detection of a misconfigured account, and it fires before anyone is waiting.

That message is also the anti-phishing framing that makes the provider's real
email trusted when it lands.

**Version 1, if no adapter exists yet:** the same screens, but the park owner
orders it in his own provider account and presses *"I've ordered it."* The
applicant experience and every downstream guard are identical. The integration
is a convenience; the compliance machinery is the product.

Everything downstream — adverse action, the fair-housing guardrails, the decision
ledger — is identical whether or not there is an API. **The compliance machinery
is the product; the integration is a convenience.**

When an adapter does come, the policy lives in its type signature: there is
deliberately **no method that returns a result**. Only `invite`, `status` and
`cancel`.

### 4d. The published-criteria guardrail

A park owner must publish their rental standards before accepting applications,
chosen from a **platform allowlist of criteria codes with numeric parameters** —
never typed free text.

This is the highest-leverage choice in the section. A park owner **cannot publish
"no families"** because there is no code for it and no box to type it in. The
applicant sees the standard before spending money. The decline checklist draws
from the *same* codes, so every decline traces to a pre-published, uniform
standard. And the version in force is snapshotted onto each application at
submission.

**There is no free-text field anywhere in the decision path.** Not on decline,
not on approve. *"Nice young couple"* is as dangerous as *"too many kids"* — it is
a protected-class observation in the file either way. The applicant-facing
decline message is fixed and neutral. Notes about the *site* are fine after
move-in; notes about the person are not, and the safest number of free-text boxes
on a housing decision is zero.

### 4e. Adverse action — we reversed the lane design here

When a park owner declines someone based even partly on a consumer report,
federal law requires a specific notice naming the reporting agency, stating the
agency did not make the decision, and explaining the right to a free copy and to
dispute it. "Adverse action" is broader than "declined" — requiring a bigger
deposit or a co-signer counts.

The lane design recorded the decision and then *offered* to send the notice, with
an open task that *"reminds at +1, +3, +7 days and then stays permanently open.
Never auto-sends."*

**That produces a permanent, timestamped, machine-generated list of every
consumer who was owed a statutory notice and never got one** — each row annotated
with the park owner's identity and his own answer that a report played a part.
Willful non-compliance carries statutory plus punitive damages plus fees, and is
class-actionable. That table is the plaintiff's exhibit list, and it is our own
query.

**Fixed. The notice sends as part of recording the decision.** The only legal
judgment in the flow is the park owner's answer to *"did a report play any part?"*
— and he has already given it. Sending the notice he said was owed is
administration, exactly like sending a receipt. *"I'll send it myself"* becomes
the opt-out, requires evidence, and auto-sends after a disclosed interval if none
arrives. **And the applicant is not told the decision until the notice is
queued** — today the design showed the decline first.

"I'm not sure" is treated as yes, with a notice variant that discloses the agency
and the consumer's rights **without asserting** that a report was the basis.

Non-renewal based on a report is also adverse action and must run the same two
questions and mint the same notice. The lane designs did not wire it.

### 4f. The renters who were already there

His existing tenants were never screened, by anyone, and were accepted by a
previous owner. Getting this wrong in either direction is bad: implying they
*were* screened creates a false record, and forcing a fake application creates a
fake housing decision.

**They import as `origin='grandfathered'` through a separate write path**, never
`applyForLot`, never `decideApplication`, with **`decided_by` deliberately null —
no decision record, because no decision happened.** Every surface renders them as
**"On file — began 2019-05-01."** Never "Approved."

**And screening on a grandfathered tenancy is `not_applicable`, permanently — not
"missing," not amber, no nudge, no badge.** This is the sharpest rule in the
section: a red badge would push a park owner toward pulling a credit report on
someone already living there, which may or may not be permissible on the facts
and is a decision that belongs to him and his counsel, not to a dashboard.

**Chase documents. Never chase screening.** A lease, an insurance certificate, a
signed rules acknowledgment are genuinely missing contract artifacts and chasing
them is the product. A credit report is not a missing document.

The import screen carries one unmissable line: *do not upload prior screening
reports, credit reports, or anything showing a Social Security number* — backed
by structure, because the document-kind allowlist has no slot for one.

---

## 5. The park owner's operating picture

### 5a. Today, and the four tiles

`/park` today is a lot-major register: four stat tiles and one row per lot, all
80, in lot order. That is the right object and the wrong screen for a glance. At
80 lots, the four things he actually needs — who owes money, whose certificate
lapsed, who is leaving, what is empty — are each one row buried among 76 boring
ones, and Phase 2 adds four more fact-families to every row.

> **The home screen carries only things that are true today and things that will
> be untrue if he ignores them. Everything that is a record rather than an event
> goes behind a tab. And empty sections do not render — a quiet park shows a
> quiet screen.**

Four tiles: **Collected** ($28,400 of $31,050 · 3 late · 1 returned) ·
**Occupancy** (71% · 56 of 79 · 4 leaving in 45 days) · **Needs you** (3) ·
**Paperwork** (74 of 79). Money leads, because an owner with coffee wants the
number that pays his mortgage. Tiles never carry buttons.

Then the **action queue** — applications, failed payments, renewal decisions,
certificate reviews, deposit dispositions, unsigned leases, move-outs to confirm,
maintenance, vacant lots not listed — ranked by consequence, each ≤2 taps, each
carrying who / which lot / the deadline. **No score, no rank badge, no colour
implying a recommendation**, because this queue mixes applicants with everyone
else and a shared visual grammar is how a "helpful colour" leaks into a housing
decision. Zero items renders one card: *"Nothing needs you today."*

Tabs: **Today · Renters · Money · Fill · On site · Lots & rates · Setup.**
Compliance is deliberately **not** a tab — it is a property of a renter, and a
separate tab means checking two lists for the same person. Instead the Renters
tab has three column-sets over the same rows in the same order: Tenancy, Money,
Paperwork. One list of people, three lenses.

### 5b. The on-site schedule, and the privacy design

The cross-boundary read: the park owner seeing jobs on properties owned by his
*renters*. Nothing in phase 1 permits it and rule 1 constrains it.

**Five fields, and that is the whole list:** which lot (not the address — 80 lots
share one), when, a coarse **category** of work, the crew's company name, and a
derived state.

On the last one: verified across all of `src/`, **`jobs.status = 'in_progress'`
is never written by any code path, and neither is `'paid'`.** The real "crew is
on site" signal is `started_at`, stamped on the first photo upload. So his
question — *"is there a truck in my park right now?"* — is one that raw status
cannot answer. The park-facing state derives from `started_at` / `completed_at`:
**coming · on site · done.**

On the category: `services.park_visit_category` on the services row (rule 8),
read as `coalesce(..., 'other')` so an unclassified service is coarse by default.
The full menu name — *"indoor heated storage, premium tier"* — tells him that
renter has an expensive boat. Site access is a legitimate interest; a purchase
record is not.

**The guarantee is structural: a purpose-built view with the forbidden columns
simply absent**, mirroring `vendor_jobs`, so no future policy edit can leak them.
No price of any kind, no margin, no renter name, no contact details, no gate
code, no photos, no messages, no invoices, no disputes, no `frequency` (weekly
housekeeping is a lifestyle fact about a tenant), no `is_rush`, and
`correction_of` rows **filtered out entirely** — a lot showing repeated
make-it-right visits identifies the complainer. Absence is information.

**Read with the session client, not the service role** (§3c), and say so in a
header comment, because it contradicts the module's own convention and the next
reader will otherwise "correct" it into the base tables.

**His own bookings are the other half of the union** — common areas and
park-owned homes, where he is the customer and sees the price. One list on
screen, his rows tagged `yours` and carrying a price, renter rows carrying
neither. **That visual asymmetry is the privacy line, made visible.**

**One honest correction to the lane design.** It claimed park owners "see no
dollar amount, ever." True of the screens; false at the data layer. Verified:
`services_read` (`0002:132-136`) grants SELECT on `services` — including
`price_base`, `price_per_unit` and `band_pricing` — to ops **or any user with
`role='owner'`**, and constraint 2 requires park owners to keep that role. So
every park owner holds a live read on the whole public menu. That is not a rule 1
breach (no crew cost, no margin) and it is not new. **But the true sentence is:
*we never show a park owner a renter's price; we cannot stop them estimating one
from the public menu.*** Coarsening the service name is worth keeping precisely
because it degrades that estimate.

*A related correction:* the crew's job card already carries the customer's name
(`vendor_jobs` exposes `owner_name`). So crews already see renter names, and the
lot-numbering convention is not the only disambiguator available.

### 5c. Maintenance — the module nobody designed

Grepped `src/` for `maintenance`, `work_order`, `repair`, `ticket`: **zero hits.**
None of the five lane designs mentions it.

In an 80-lot park that is **10–25 contacts a month, several times the volume of
rent questions**, arriving today by phone call, text to his personal cell, and a
knock on the door. A park management system without a maintenance queue is not a
park management system.

`park_requests` — lot, renter, **category from a fixed list** (water, sewer,
electric, road, trash, pest, tree, park structure, other — fixed means reportable,
so he can see *"sewer, six times this year, all on the north loop"*, which is how
you find a real problem), a photo from the renter (halves the diagnostic calls),
and urgency where **emergency bypasses quiet hours** — no heat in a mobile home
in January is a habitability emergency, and queueing it into a 7am digest is a
liability.

The renter sees status. *"Seen — we'll be out Tuesday"* eliminates most follow-up
contacts, which is where the actual time saving lives.

**And the commercial hook nobody spotted:** a request the park can't handle
in-house becomes a LakeLife job in one tap, from the request. Tree down → grounds
crew. **That is the cleanest service-capture path in the whole product, and it
arrives unprompted, from the tenant, at the moment of need.**

### 5d. Owner vs. manager, and multiple parks

Today the split is one line: publishing the park is owner-only. The principle:
**a manager runs the park; an owner owns the business.** Manager-allowed: the
roll, applications (a dial, since some owners keep housing decisions), move-ins,
lots, listing an individual lot, certificate reviews, gate-code rotation,
maintenance. Owner-only: rates, publishing, park profile, the 55+ declaration
(*a legal claim — "the park owner's, and their counsel's"*), lease templates,
deposit dispositions, non-renewal, **the bank account**, rev-share and remittance
detail, and adding members.

Three live gaps close here: `endTenancy` asserts membership but **not role**, so a
manager can end anyone's tenancy today; **`park_members` has no write path
anywhere in `src/`**, so memberships are SQL-seeded — fine for park #1, a hard
blocker the moment he hires someone or sells to park #2; and `ll_my_park_ids()`
is defined, asserted in the post-conditions, and referenced nowhere — it is what
the multi-park switcher was reserved for.

**`park_audit`** — actor, action, subject, timestamp. There is **no audit table
anywhere in this codebase** today. Parks is where one first earns its keep,
because two people now share authority over other people's housing and money.

### 5e. Notifications

**There are zero notifications in the entire park module today** — grepped, and it
directly contradicts *"I want to have everything automated on my side."* He
learns an application arrived by loading a web page.

Before any of them ship, two platform gaps close:

- **`shouldNotify(userId, type, channel)` does not exist.** `mergeNotifPrefs` is
  imported by UI and tests only; the only two send paths that consult preferences
  check a synthetic `type='growth'` key that is not one of the six declared
  types. Every operational message on the platform sends unconditionally today.
  Do not add a ninth ungated sender.
- **Quiet hours: `lakeHour()` has four independent copies** — in `book/actions.ts`,
  `vendor/open-actions.ts`, `vendor/open-data.ts` and `automation.ts`. Verified.
  Three lane designs said "one private function, one call site." **This changes
  the fix:** promoting one copy leaves four definitions of what time it is at the
  lake, and the per-park timezone dial would be honoured by exactly one of them.
  Export one `lakeHour(tz)` next to `todayLakeDate()` and delete four copies in
  the same commit.

The rule: **push only what has a deadline he can miss today; digest everything
else; never notify about what he cannot act on.** Push: a new application (first
one immediate, rest batched — six on a holiday Friday must not be six texts), a
failed or returned payment, a renter giving notice (the highest-value single
alert in the module), an expired certificate. Digest: everything else, **7am,
morning not night** — the park digest's job is *"here's your day."*

**Its own cron**, `/api/cron/parks`, each step individually caught, its own
digest. The nightly is 25 sequential un-caught awaits whose only alarm is last,
so a throw anywhere fails everything after it silently.

---

## 6. Rev share

**Recommendation: no percentage of anything, to anyone, ever.** Decision 3 has
the arithmetic. Three additions:

**The legal risk is not primarily kickback — it is recharacterisation.** A
mandatory service charge in a mobile-home community with a cut flowing to the
landlord is likely to be characterised either as a prohibited fee or as
**additional rent** — and if it is additional rent it enters the rent-increase
notice regime and any statutory restrictions on charges. That makes the
arrangement *unenforceable* rather than merely actionable, which is worse.

**"Requiring" has three meanings and only two are safe.** Requiring tenants to
*buy* a service and taking a cut: don't build it, and note it isn't even worth
the money. Requiring that *if* they hire a paid contractor, that contractor must
be registered and insured through the platform: legitimate, articulable, and it
is the same site-safety interest the compliance module already exists to serve —
**and it is enormously safer with no cut**, because the moment a per-purchase cut
exists a regulator gets to argue the safety rationale is pretext. Simply
*offering* the app as the default in a portal tenants already use monthly gets
most of the conversion with none of the risk; the modelled attach rates assume no
mandate at all.

**Choosing the cut is choosing to weaken the mandate. They are one decision.**

**Strategically, a rev share is not revenue — it is contra-revenue.** It adds
nothing to the top line and permanently subtracts gross margin from the fastest-
growing segment, which is the inverse of operating leverage and the fastest way
to lose a valuation multiple. The honest counter-argument is that a rev share is
the easiest thing to sell to park #2. **The answer to that is a free tier, not a
rebate:** land free with the whole back office (which costs us nothing
incremental), expand paid on the money features at $3–6/lot/month. One number to
end on: 10% of price on an 80-lot park pays the owner **$9.60 per lot per
month**, and real park software costs him **$2–5**. The proposal is to pay a
customer roughly three times what he would otherwise pay us.

---

## 7. What we deliberately do not build in this phase

The most valuable list in the phase 1 doc, kept.

| Not built | Why |
|---|---|
| **Any score, rank, colour or recommendation about a person** | Not even a helpful colour on a row. A screening score used in a housing decision is the clearest available illustration of disparate-impact exposure. |
| **A pass/fail from a screening provider** | Stricter than the minimum, on purpose — §4b. |
| **Criminal-history screening** | §4a / decision 5. Lift only after counsel, and only with an individualised-assessment workflow. |
| **Social Security number, date of birth, government-ID image by default, or even an ID number's last four** | Breach-notification statutes are triggered by name plus SSN or driver's-licence number in a way they are not by an email address. An identity *attestation* — type, state, expiry, who checked, when — answers the park's real question without us holding anything. A `sight_and_erase` mode exists, off by default, with a 3-day destruction clock. |
| **Cross-park or cross-application views of a person** | The single clearest credit-reporting-agency behaviour available to a platform. |
| **Stored value of any kind** — no renter balance, no park wallet, no "leave it on account," no transferring a deposit between tenancies | This is what turns a payment processor into a money transmitter, and it gets built by accident because it is convenient. Overpayment is allocated to a real charge or refunded. |
| **Credit-bureau reporting of rent history**, in either direction | Furnishing makes us a furnisher with investigation and accuracy duties — the same family of trap as the CRA problem. "Your rent builds credit" is how it gets built by accident. |
| **Any automated notice to quit, termination, eviction filing, cure notice, or anything with legal effect** | Phase 1's hard line. We record, notify, and stop. |
| **Any tenancy-or-payment-status path that can touch a gate code, a utility, portal access, or a service booking** | We hold the codes. That is precisely why the capability must not exist, not merely be unwired. Enforced by module isolation and a post-condition. |
| **Lien or abandoned-property machinery** | The storage product has carefully drafted lien provisions. A future engineer will find them and think they apply to an abandoned RV. They do not. Stated in the migration header. |
| **A free-text notes box anywhere in the housing-decision path**, and no free text published on a public page | §4d, and §8's publisher exposure. |
| **A percentage rev share** | §6. |
| **A PDF of the signed lease** | Text plus hash is legally sufficient and stronger; a PDF costs a dependency. Add it when a park asks. |
| **Automatic remittance without a W-9 on file** | It blocks, loudly, with an explanation. The crew month-end batch *silently skips* — a silently withheld rent remittance would be a support catastrophe. |
| **Any AI access to applications, answers, screening records or decisions** | Enforced at database grants, not a TypeScript deny-list a refactor can drop. One AI-drafted decline reason is a worse artifact than anything else in this document. |
| **Rent inside the nightly cron; rent inside `jobs`/`invoices`/`payouts`** | §2a, and the six breakages in the 0052 header. |
| **A second implementation of anything, for any park** | Configuration on the same code path, behind a per-park flag. Never a branch. |

---

## 8. Questions for counsel

Numbered so it can be handed over as-is. Items marked ★ gate a shipping
decision.

**Contracts and terms**
1. ★ We have no agreement with a renter and none with a park owner. Today a
   person can apply for housing in the app having accepted nothing. One
   instrument or several, and what must the Park Owner Agreement contain
   (agent-of-payee appointment, deposit-custody recital, screening-user
   certification chain, anti-tying representation, fair-housing representation
   with a takedown right, data-sharing representation, express disclaimer that
   the park owner is not our sales agent, W-9 delivery)?
2. ★ Our current terms §7.1 say we accept funds *"only as an integral part of
   settling bona fide Service Agreements"* and §7.4 say funds are *"not held in
   escrow or trust… and may be commingled."* Both must be amended before the
   first dollar of rent. What carve-in language?
3. ★ §16.5 caps our liability at the greater of retained fees or $100. Rent has
   no retained fees, so the cap collapses to $100 for a lost $500 deposit. Is
   that enforceable, and what park-money cap is defensible?
4. Should tenancy and park-money disputes be carved out of the arbitration clause
   and class waiver?

**Deposits and money**
5. ★ Does *"we withhold release of a payable owed to the park owner; we do not
   hold funds in trust for the renter"* hold for a refundable deposit where the
   renter retains a claim — in Indiana, and where the landlord is a third party?
6. ★ Indiana deposit rules: segregation, interest, itemisation, deadline — and
   does the mobile-home-community chapter modify any of them?
7. ★ In states that require segregation, can a platform-held deposit ever be
   compliant, or is "park holds" the only lawful configuration there?
8. ★ Money transmission: does the agent-of-payee exemption cover third-party rent
   in our target states, and does sub-merchant settlement moot the question?
9. ★ Property-management or real-estate licensing for collecting third-party
   rent in Indiana — and does it change if funds never touch our account?
10. ★ Does collecting rent for a third-party park owner make us a debt collector
    under the FDCPA, and which state collection-agency licensing statutes are
    triggered by the activity regardless?
11. Late-fee caps, grace-period minimums, and whether mobile-home-community rules
    differ from general landlord-tenant law.
12. Does accepting partial rent affect an eviction in Indiana?
13. Whether security deposits held by the prior owner transferred at closing.
    **Ask this one this week** — if they did not, there is a liability with no
    cash behind it and the ledger must record the liability without inventing the
    money.

**Tax**
14. ★ Are we a marketplace facilitator for transient lodging in Indiana as
    designed, and at what thresholds elsewhere?
15. Steuben and LaGrange innkeeper's tax: who registers, what rate, what filing?
16. When a short stay extends past the exemption threshold, is tax already
    collected refunded to the guest?
17. 1099-MISC box 1 and backup withholding for park-owner remittances.
18. Are any *existing* LakeLife services — boat storage, winterization,
    installation — subject to Indiana sales tax today?

**Screening and fair housing**
19. ★ Does the conduit architecture keep us outside the CRA definition and
    outside reseller status, and what must the provider agreement say?
20. ★ May we store the *fact* that a report caused a denial? May we display an
    order's status?
21. ★ May a park *manager* initiate and read a screening, given the provider's
    permissible-purpose certification runs to the owner?
22. Adverse action: is our template adequate; does "approved with conditions"
    trigger it; does our sending it on the park's behalf create any obligation
    for us; retention period; does non-renewal trigger it?
23. ★ We publish park-authored house rules verbatim on a LakeLife page. What
    review, contractual and takedown mechanism does publisher exposure require?
24. ★ 55+: what records and cadence does the exemption require, is an
    attestation-plus-park-held-documentation model sufficient, and what is the
    exposure if a park drops below the 80% threshold between surveys while still
    enforcing the age restriction?
25. Occupancy standards on RV and mobile-home sites — what basis must be
    recorded? (An RV site has no bedrooms, so a bare number is hard to defend.)
26. Is source of income protected in Indiana or any local ordinance covering
    these parks?
27. What structural separation is required between an accommodation request and
    the pet-fee model?

**Mobile-home-park specific**
28. ★ Lot-rent increase: notice period, frequency limits, required content.
29. ★ Permitted grounds for termination and non-renewal of a lot tenancy;
    notice-and-cure minimums.
30. ★ Permitted charges: what may a community bill, what is prohibited, and what
    must be disclosed in the rental agreement?
31. Submetered utility billing: rate caps, markup prohibition, required bill
    content, registration.
32. ★ Abandonment of a home left on a lot: the notice sequence, waiting period,
    and lien/title path.
33. Sale of a home in place: right to sell, buyer-approval criteria, entry fees,
    removal requirements, right of first refusal on a park sale.
34. Deceased-tenant and estate handling for a home on a rented lot.
35. Community licensing or registration requirements.

**Licence vs. tenancy**
36. ★ At what point does an RV or campground occupancy become a tenancy in
    Indiana, and what facts besides duration matter? Does a park model change the
    answer?
37. What is the correct process for an occupant who will not leave at the end of
    a stated term?

**Documents, data and messaging**
38. ★ Does a claim/activation text message to a phone number obtained from a
    landlord require consent, and can the park's own paperwork supply it?
39. E-signature sufficiency for a mobile-home lot lease; any required statutory
    form; retention period.
40. What must be retained after a deletion request, and what is the correct
    disclosure at the moment of deletion?
41. Notice-at-collection duties for renter contact data obtained from a park
    owner.

**Rev share**
42. May a landlord receive a fee tied to a tenant's purchase from a designated
    vendor, and what disclosure is required?
43. Can a required service charge in a mobile-home community be recharacterised
    as rent?
44. May a park require that paid contractors register and insure through a
    designated platform, and what carve-outs must residents keep?
45. Does any payment from us to a park owner change our third-party-administrator
    posture?

---

## 9. The phased build plan

Sizes are honest. **S** = days. **M** = a week or two. **L** = a month or more.
**XL** = a major build with its own risk.

### Phase 0 — worth doing anyway, and everything else waits on it

These are platform fixes, not park features. Several are live bugs today.

| Item | Size | Why now |
|---|---|---|
| `.select("id")` on every guarded status flip; fail closed on zero rows | S | `decideApplication` returns *"Approved. The lot is held for those dates"* on a zero-row update, verified. Phase 2 puts a card charge behind that same shape. |
| The `/portal` park branch before `claimCrewInvite` | S | A park owner, manager or renter whose email matches an open crew invite is flipped to `vendor` on first sign-in — killing their services menu — and `guard_role_change` makes it hard to undo. **Must land before `parks.active` is ever true.** |
| `src/lib/docs.ts`: per-record signer + erase path + access log + erasure log; retrofit the three existing call sites; orphan sweep | M | 0052's stated precondition. Zero deletion code exists today. |
| `document_envelopes` + `document_signatures`; migrate the current terms click onto it | M | The acceptance record cascades away on account deletion. |
| One exported `lakeHour(tz)`; delete four copies | S | Four definitions of what time it is at the lake. |
| `shouldNotify(userId, type, channel)` + `NOTIF_DEFS.audience` | S | Every operational message sends unconditionally today. |
| `.eq("kind","earning")` at three sites; write `payout_batches.paid_at` | S | One line each; prevents park money being texted to a crew as their payout. |
| `payout_account_history` + bank-change cooling-off + code re-auth | M | Improves crew payouts today; mandatory before a $36k/month redirect exists. |
| **Mobile-home winterization and golf-cart winterize as real `services` rows**, plus one unit-type field on the pricing profile | M | Verified: neither exists in the seed, and the pricing profile has pier sections and lawn bands but no unit fields. **These two products are ~60% of the modelled park margin and currently cannot be booked or priced.** This is a rule-8 data change, not a new engine. |
| Exempt mobile-home winterization from the unfilled-job expiry sweep | S | Today that sweep cancels the job and texts *"we couldn't line up a crew in time — you were never charged."* For a mobile home before a hard freeze that is a burst pipe and a destroyed home. Same guard shape as the storage-custody skip. |

**Blocked on nobody.** Do this first.

### Phase 2a — the record. Nothing required of a single tenant.

**This is the week-one win, and it is the phase the owner should judge us on.**

1. `park_renters` + nullable `renter_user_id` + denormalised identity on the
   tenancy (**L** — the largest schema change in the phase, and every other item
   depends on it)
2. The paste-in importer: lots (with a generator for the RV row), **bulk rate
   apply** across a selection then per-lot exceptions, sitting tenants, park
   structures (**M**) — today rates are one form per lot, so 80 lots is 80
   submissions
3. **Record-a-payment at the window** + receipt + today's-list + void (**M**)
4. `park_requests` — maintenance, with the one-tap escalation to a LakeLife job
   (**M**)
5. `park_lots.service_state` / `listed` / the RLS `active` filter, and fixing the
   occupancy denominator (**S**)
6. `park_structures` + the second exclusion constraint + the widened reservation
   guard (**M**)
7. The rebuilt home screen: tiles, action queue, filtered roll (**M**)
8. Move-in / move-out as real events, minting the lot's `properties` row with
   coordinates and lake, and deactivating autopilot on move-out (**M**)
9. Per-tenancy grace, payment plans, one-tap pause, the `estate` state (**S**)
10. `/api/cron/parks` + the 7am digest + park notification types (**M**)

**Unlocks:** a rent roll he trusts, a delinquency list that is *complete because
it accepts cash*, a maintenance queue, and — via item 8 — renters booking
services against their lot, which is the entire commercial case.

**Blocked on:** his park's actual data (the seller's rent roll, and a physical
walk of the park for site types and hookups — that is 6–10 hours with a tape
measure and cannot be automated).

### Phase 2b — book now, on the card rail that already exists

1. The `held` status, the hold TTL sweeper, idempotency keys, and
   `lot_no_double_booking_v2` with the three-status predicate (**M**)
2. `instant_book_max_nights` + contiguous-occupancy evaluation + the per-lot
   override + the escalation task (**M**)
3. Instant booking with an **authorisation hold**, not a captured deposit (**M**)
4. `bookAtTheOffice`, no-show, early departure, extend-from-my-side (**S**)
5. `lot_rate_rules` (seasons, weekends, minimum stays) + `lot_fees` + `rent.ts`
   as the single period-math authority (**M**)
6. Season and `utilities_off` per lot; the crew job card carries it (**S**)
7. Checkout on a park-owned home auto-creates the turnover cleaning job (**S**) —
   **this should be the flagship demo**: he books cleaning, gets photo-verified
   completion, one all-in price, on machinery that already works
8. Per-stay door codes for park-owned homes (**S**)

**Blocked on:** ★ the lodging-tax facilitator analysis (question 14) — this now
gates transient booking, not park #2. And ★ the Park Renter Terms (question 1),
because an instant booking is a booking and rule 5 applies.

### Phase 2c — agreements and compliance

1. Park lease templates with the counsel-attestation gate (validated against a
   caller-written actor column, never `auth.uid()`) + the merge-token renderer
   (**M**)
2. The signing flow: render → envelope → text-message code → sign → artifact →
   email both parties (**L**)
3. `park_requirements` / `renter_assets` / `renter_documents` + the escalating
   reminder ladder + human review (**L**)
4. `tenancyCompliance` + the compliance lenses on the Renters tab (**M**)
5. Auto-renewal: cycles, dials, both-sides notices, the counsel gate, the state
   rules table (**M**)
6. The 55+ occupancy survey **with the ratio computed and stored**, plus the
   banner making clear we do not hold the age documents and do not certify the
   park qualifies (**S**)

**Blocked on:** ★ his attorney producing lease text (1–3 weeks of elapsed time
that blocks all compliance value — start it now), and ★ counsel answers to
questions 28, 29, 30, 39.

### Phase 2d — applications and screening

1. Published criteria + the criteria page (**M**) — this ships *before* the
   application, because it is both the fair-housing guardrail and the decline
   vocabulary
2. The long application, the rule-5 gate, co-applicants, the ladder dials (**L**)
3. The decision flow **and the adverse-action rail, in the same release, never
   after** (**M**)
4. Version-1 manual screening handoff (**S**)

**Blocked on:** ★ questions 19–22 and the Screening & Fair Housing Addendum.

### Phase 3 — rent and deposits, on bank debit

**XL. This is the biggest build in the plan and it should be sized as one.**

1. The bank-debit rail itself: `debitAch`, `creditAch`, settlement callbacks, the
   `pending / settled / returned` state machine, and an idempotency key on the
   existing card charge (**XL** — none of it exists; the card code treats a
   charge as synchronously authoritative and cannot be retrofitted)
2. `park_charges` / `park_payments` / `park_allocations` + the generation cron +
   the overdue ladder + the mass-failure breaker (**L**)
3. `park_deposits` + disposition + the statutory clock + the custody dial (**L**)
4. `park_remittances` → `payout_batches` → export, with the W-9 gate (**M**)
5. Autopay with a real, hashed, revocable authorisation document (**M**)

**Blocked on:** ★ the terms rewrite (questions 2, 3) — this is a *prerequisite*,
not a parallel workstream; ★ processor keys and the sub-merchant confirmation
(decision 2); ★ deposit custody (decision 1 and questions 5–7).

### Phase 4 — park #2

Sub-merchant onboarding or whatever the licensing answers require; `park_members`
invites; the park switcher; the paid tier. **Blocked on** ★ questions 8–10.

### Before the switch is ever flipped

**Run a simulated season, not just unit tests.** The precedent is in the phase 1
doc: *"the storage product was built, switched off, and had four real bugs
waiting in it when the simulation finally ran."* This module has three inventory
classes, five terms, two custody modes and a cross-module read. The simulation
must cover: a renter-owned home on a long lease that auto-renews; a park-owned
home on weekly stays with no lease; a transient RV lot with a camping agreement
and no insurance requirement; a document that expires mid-season; a renter who
deletes their account; a tenancy that stacks past the threshold; a home sold in
place; an abandoned home; and a bank debit that returns three days after
reporting success.

---

# Appendix A — DDL sketch

Illustrative, not final. Every table follows the 0052 grant discipline —
`revoke insert, update, delete, truncate ... from authenticated, anon` (TRUNCATE
included, because it ignores row-level security), explicit `revoke select ...
from anon` on anything personal, definer helpers rather than cross-table policy
subqueries, and a post-condition `do $$ ... $$` block that asserts what was built
rather than trusting the absence of an error.

```sql
-- ===========================================================================
-- 0053 — PARK PHASE 2, PART 1: people, structures, inventory state.
--
-- THE WALL: nothing in the park money files (0055) references jobs, invoices,
-- payments, payouts, user_credits or referral_earnings. Not by FK, not by name.
--
-- PROHIBITED BY DESIGN, stated so nobody builds it later:
--   * no stored value — no renter balance, no park wallet, no deposit
--     transferred between tenancies;
--   * no credit-bureau furnishing;
--   * no automated notice, termination, utility shutoff or gate-code change
--     for nonpayment. WE HOLD THE GATE CODES. That is precisely why this must
--     be impossible, not merely unwired;
--   * the storage module's lien and unclaimed-property machinery DOES NOT
--     apply to a home on a rented lot. Do not reuse it.
-- ===========================================================================

-- A person the park knows about, who may never have a LakeLife account.
create table public.park_renters (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,
  display_name  text not null,
  email         text,
  -- DELIBERATE NAME. This number came from a spreadsheet, not from the person.
  -- It is for the park owner's reference. NOTHING may use it as a send target;
  -- a renter's textable number is public.users.phone after they verify it.
  phone_on_file_with_park text,
  contact_pref  text not null default 'email'
                  check (contact_pref in ('app','sms','email','paper','in_person')),
  user_id       uuid references public.users(id) on delete set null,
  claimed_at    timestamptz,
  invite_token  text unique,
  notes         text,
  created_at    timestamptz not null default now()
);

-- A structure is a fact about the PAD. A rig is a fact about the PERSON.
-- This table survives every tenancy, every account deletion, and every sale
-- of a home in place.
create table public.park_structures (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,
  park_lot_id   uuid not null references public.park_lots(id) on delete restrict,
  kind          text not null check (kind in ('mobile_home','park_model','cabin','other')),
  owned_by      text not null default 'unknown'
                  check (owned_by in ('park','renter','unknown','disputed')),
  title_status  text not null default 'unknown'
                  check (title_status in ('clear','missing','lien','estate','unknown')),
  rentable      boolean not null default false,   -- true only when the PARK rents it out
  make text, model text, year smallint, serial_last6 text, length_ft smallint,
  beds smallint, baths numeric(3,1), sleeps smallint, pets_allowed boolean,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create unique index park_structures_one_active_per_lot
  on public.park_structures (park_lot_id) where active;

alter table public.park_lots
  add column listed        boolean not null default false,
  add column service_state text not null default 'in_service'
       check (service_state in ('in_service','out_of_service')),
  add column oos_reason    text check (oos_reason in
       ('abandoned_unit','demo_pending','title_dispute','estate','pad_failed',
        'utility_failed','flood','renovation','held_by_owner')),
  add column oos_since     date,
  add column oos_est_cost  numeric(10,2),
  add column occupancy_class text not null default 'residential'
       check (occupancy_class in ('residential','recreational')),
  add column instant_book  boolean,          -- null = inherit the park
  add column min_nights    smallint,
  add column season_open_month smallint, add column season_open_day smallint,
  add column season_close_month smallint, add column season_close_day smallint,
  add column utilities_off_from date, add column utilities_off_to date;

alter table public.lot_reservations
  add column park_renter_id   uuid references public.park_renters(id) on delete restrict,
  add column park_structure_id uuid references public.park_structures(id) on delete restrict,
  add column origin           text not null default 'application'
       check (origin in ('application','instant_book','office','grandfathered','transfer')),
  add column agreement_class  text not null default 'lease'
       check (agreement_class in ('license','lease')),
  add column agreement_class_reason text,
  add column agreement_class_set_by uuid references public.users(id) on delete set null,
  add column sole_residence   boolean,       -- "is this your only home right now?"
  add column renew_every_months smallint, add column renew_notice_days smallint not null default 30,
  add column grace_days_override smallint,
  add column moved_in_at date, add column moved_out_at date,
  add column hold_expires_at timestamptz,
  add column idempotency_key text,
  add column rate_snapshot jsonb, add column period_amount numeric(10,2),
  -- identity denormalised so the record survives an account deletion
  add column renter_name_at_tenancy text,
  add column renter_email_at_tenancy text,
  add constraint lot_res_bounded
    check (lower_inf(during) = false and upper_inf(during) = false),
  add constraint lot_res_one_occupant_kind
    check (num_nonnulls(renter_unit_id, park_structure_id) <= 1);

-- A3 / T0-5: the ledger must not die with the account, and the account must
-- not become undeletable. park_renter_id is the durable pointer.
alter table public.lot_reservations
  alter column renter_user_id drop not null;
alter table public.lot_reservations
  drop constraint lot_reservations_renter_user_id_fkey,
  add  constraint lot_reservations_renter_user_id_fkey
       foreign key (renter_user_id) references public.users(id) on delete set null;
-- same treatment on renter_units.user_id, plus a park_renter_id column there.

-- A1: the park home is a second bookable thing. One calendar per lot is not
-- enough once a structure can be moved between lots.
-- A2: NEW NAME. 0052 is re-runnable and recreates the two-status version of
-- lot_no_double_booking on every replay; redefining the same name would let a
-- disaster-recovery replay silently drop the 'held' status.
alter table public.lot_reservations
  add constraint lot_no_double_booking_v2
  exclude using gist (park_lot_id with =, during with &&)
  where (status in ('held','approved','active'));

alter table public.lot_reservations
  add constraint structure_no_double_booking
  exclude using gist (park_structure_id with =, during with &&)
  where (park_structure_id is not null and status in ('held','approved','active'));

-- B3: rule 1 widened WITHOUT the null-propagation hole. `u.user_id =
-- new.renter_user_id` is NULL = NULL for an imported tenancy, so `not exists`
-- is true and the trigger raises on every legitimate import. The is-not-null
-- guards on both sides are load-bearing.
-- A6: this trigger, and every trigger in this phase, authorises against a
-- CALLER-WRITTEN column. auth.uid() is NULL under the service role, which is
-- how every park write reaches the database.
create or replace function public.guard_lot_reservation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.renter_unit_id is not null and not exists (
      select 1 from public.renter_units u
       where u.id = new.renter_unit_id
         and ( (new.renter_user_id is not null and u.user_id        = new.renter_user_id)
            or (new.park_renter_id is not null and u.park_renter_id = new.park_renter_id) ))
  then raise exception 'lot_reservations: that unit does not belong to that renter'; end if;
  -- rule 2 (unchanged): a renter cannot approve their own tenancy
  -- rule 3: a rentable structure on the lot MUST be the one being booked
  -- rule 4: a non-rentable structure on the lot blocks all but a transfer
  -- rule 5: park_structure_id's lot must equal park_lot_id
  -- rule 6: a 'license' may not exceed parks.license_max_nights
  return new;
end $$;
```

```sql
-- ===========================================================================
-- 0055 — PARK MONEY. RENT IS A ZERO-MARGIN PASS-THROUGH.
-- ===========================================================================

create table public.park_charge_types (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete cascade,
  -- ALLOWLIST, not free text: MH statutes enumerate permitted charges, and a
  -- free-text code is how a park invents a prohibited one that we then bill.
  code text not null check (code in ('lot_rent','utility_submeter','pet_rent',
        'extra_occupant','extra_vehicle','slip_fee','storage','cleaning',
        'late_fee','nsf_fee','prepaid_rent','tax','other')),
  label text not null,                      -- the park's own words, free
  is_rent boolean not null default false,
  recurrence text not null check (recurrence in ('once','nightly','weekly','monthly','annual')),
  amount_source text not null default 'lot_rate'
    check (amount_source in ('lot_rate','flat','manual')),
  flat_amount numeric(10,2), prorated boolean not null default true,
  taxable boolean not null default false, late_feeable boolean not null default true,
  disclosed_in_agreement boolean not null default false,   -- undisclosed cannot bill
  active boolean not null default true,
  unique (park_id, code, label)
);

create table public.park_charges (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete restrict,
  reservation_id uuid not null references public.lot_reservations(id) on delete restrict,
  renter_user_id uuid references public.users(id) on delete set null,
  renter_label text not null,               -- name at time of issue; survives deletion
  -- A5: NOT NULL + RESTRICT. Nullable + SET NULL punched a hole in the
  -- exactly-once index below (NULLs are never equal in a unique index), so
  -- deleting a charge type would let the rent cron bill a month twice.
  -- Retire a type with active=false, never by deleting it.
  charge_type_id uuid not null references public.park_charge_types(id) on delete restrict,
  kind text not null check (kind in ('rent','fee','late_fee','nsf_fee','utility',
        'prepaid_rent','credit_memo','tax')),
  period_start date, period_end date, due_date date not null,
  amount numeric(10,2) not null,            -- signed; a credit memo is negative
  tax_amount numeric(10,2) not null default 0,
  tax_jurisdiction text,                    -- innkeeper's tax is county-level
  description text not null,
  parent_charge_id uuid references public.park_charges(id) on delete set null,
  corrects_charge_id uuid references public.park_charges(id) on delete set null,
  status text not null default 'issued'
    check (status in ('draft','issued','paid','void','written_off')),
  issued_at timestamptz not null default now()
);
create unique index park_charges_one_per_period
  on public.park_charges (reservation_id, charge_type_id, period_start)
  where (period_start is not null and status <> 'void');

create table public.park_payments (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete restrict,
  reservation_id uuid not null references public.lot_reservations(id) on delete restrict,
  payer_user_id uuid references public.users(id) on delete set null,
  method text not null check (method in ('ach_debit','card','check','cash','money_order','other')),
  instrument_token text,                    -- rule 4: a vault token or nothing
  amount numeric(10,2) not null check (amount > 0),
  -- THE STATE MACHINE THE CARD RAIL DOES NOT HAVE. settleJob treats charge()
  -- as synchronously authoritative everywhere. A bank debit is not.
  status text not null default 'pending'
    check (status in ('pending','settled','failed','returned','voided')),
  return_code text, processor_ref text, idempotency_key text,
  autopay_id uuid,
  -- A4: `date_trunc('month', initiated_at)` is STABLE, not IMMUTABLE, so an
  -- index expression over it is REJECTED and the whole migration rolls back.
  -- The cron writes the period explicitly, which is also readable in a query.
  period_key text,
  initiated_at timestamptz not null default now(),
  settled_at timestamptz, returned_at timestamptz,
  recorded_by uuid references public.users(id) on delete set null   -- the office window
);
create unique index park_payments_idem
  on public.park_payments (idempotency_key) where idempotency_key is not null;
create unique index park_payments_one_per_autopay_period
  on public.park_payments (autopay_id, reservation_id, period_key)
  where autopay_id is not null and status <> 'voided';

create table public.park_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.park_payments(id) on delete restrict,
  charge_id  uuid not null references public.park_charges(id)  on delete restrict,
  amount numeric(10,2) not null,            -- negative rows reverse a return
  reason text not null default 'payment',
  created_at timestamptz not null default now()
);

-- No `refundable` column, on purpose. A deposit is refundable by definition;
-- a non-refundable cleaning fee is a park_charges row of kind 'fee'.
create table public.park_deposits (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete restrict,
  reservation_id uuid not null unique references public.lot_reservations(id) on delete restrict,
  renter_user_id uuid references public.users(id) on delete set null,
  renter_label text not null,
  method text not null check (method in ('ach_capture','card_capture','auth_hold','offline')),
  collected_amount numeric(10,2) not null default 0,
  authorized_amount numeric(10,2) not null default 0,
  payment_id uuid references public.park_payments(id) on delete set null,
  status text not null default 'held'
    check (status in ('pending','held','disposing','contested','closed','expired')),
  disposition_due date, collected_at timestamptz, closed_at timestamptz
);
-- + park_deposit_events (collect|itemize|contest|forfeit|return|expire|release_hold)
-- + park_deposit_items  (no itemisation, no forfeiture — rule 2's logic, for money)

create table public.park_remittances (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete restrict,
  payee_user_id uuid not null references public.users(id) on delete restrict,
  period_key text not null,
  kind text not null check (kind in ('rent','fee','tax','deposit_forfeit',
        'reserve_release','adjustment')),
  amount numeric(10,2) not null,            -- negative = netting a clawback
  deposit_event_id uuid references public.park_deposit_events(id) on delete restrict,
  batch_id uuid references public.payout_batches(id) on delete set null,
  status text not null default 'accrued'
    check (status in ('accrued','held','released','batched','paid','reversed')),
  created_at timestamptz not null default now()
);
create unique index park_remit_one_per_period
  on public.park_remittances (park_id, period_key, kind)
  where kind in ('rent','fee','tax') and status <> 'reversed';

alter table public.payout_batches drop constraint payout_batches_kind_check;
alter table public.payout_batches add constraint payout_batches_kind_check
  check (kind in ('early','monthly','referral','park_rent','park_deposit_return'));

-- B5: NO unique index on kind. An escalating overdue ladder capped by a
-- globally-unique kind fires ONCE and then goes permanently silent on an
-- unpaid balance — exactly the failure the design diagnosed elsewhere. Cap it
-- with a cooldown predicate, the way nudge_log already does, and write the row
-- only AFTER a successful send.
create table public.park_notice_log (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  kind text not null,                        -- 'rent_overdue:<charge_id>'
  sent_at timestamptz not null default now()
);
create index park_notice_log_lookup on public.park_notice_log (kind, sent_at desc);
```

```sql
-- ===========================================================================
-- Maintenance, and the state table that keeps park dials inside the law.
-- ===========================================================================

create table public.park_requests (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete cascade,
  park_lot_id uuid references public.park_lots(id) on delete set null,
  reservation_id uuid references public.lot_reservations(id) on delete set null,
  park_renter_id uuid references public.park_renters(id) on delete set null,
  category text not null check (category in ('water','sewer','electric','road',
        'trash','pest','tree','park_structure','other')),
  urgency text not null default 'routine'
    check (urgency in ('routine','urgent','emergency')),   -- emergency bypasses quiet hours
  description text not null, photo_path text,
  status text not null default 'new'
    check (status in ('new','seen','scheduled','done','wont_fix')),
  job_id uuid,                              -- set when escalated to a LakeLife job
  assigned_to text, promised_by date,
  created_at timestamptz not null default now(), resolved_at timestamptz
);

-- Rule 8 applied to LAW. Counsel-populated rows, not code. Every park dial is
-- band-clamped against this the way parseSetting clamps platform dials: a park
-- owner may be stricter, never looser.
create table public.state_rules (
  state text primary key,
  deposit_max_multiple numeric(4,2), deposit_segregation_required boolean,
  deposit_interest_required boolean, deposit_itemize_days smallint,
  rent_increase_notice_days_min smallint, termination_notice_days_min smallint,
  license_max_nights smallint, lodging_tax_max_nights smallint,
  prohibited_charge_codes text[], submeter_markup_allowed boolean,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
```

```sql
-- ===========================================================================
-- The cross-boundary view. The guarantee is that the columns ARE NOT HERE.
-- Read with the SESSION client, never the service role: security_invoker is
-- off, so ll_manages_lot() evaluates auth.uid(), which is NULL under the
-- service role and returns ZERO ROWS WITH NO ERROR.
-- ===========================================================================
create view public.park_jobs with (security_invoker = off) as
  select jb.id, pl.id as park_lot_id, pl.lot_number, pk.id as park_id,
         jb.date, jb.slot,
         jb.started_at, jb.completed_at,          -- the derived 3-state, NOT jb.status
         coalesce(s.park_visit_category, 'other') as visit_category,
         v.company as crew_company
    from public.jobs jb
    join public.properties p  on p.id  = jb.property_id
    join public.park_lots  pl on pl.id = p.park_lot_id
    join public.parks      pk on pk.id = pl.park_id
    left join public.services s on s.id = jb.service_id
    left join public.vendors  v on v.id = jb.vendor_id
   where public.ll_manages_lot(pl.id)
     and jb.status in ('scheduled','in_progress','complete','paid')
     and jb.correction_of is null;            -- absence is information

-- Post-condition, in 0052's style: "no error" is not proof.
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_name = 'park_jobs'
                and column_name in ('customer_price','vendor_cost','margin',
                                    'gate_code_encrypted','owner_id','frequency','owner_name'))
  then raise exception 'park_jobs leaks a forbidden column'; end if;

  if position('held' in (select pg_get_constraintdef(oid) from pg_constraint
                          where conname = 'lot_no_double_booking_v2')) = 0
  then raise exception 'the hold status is not in the no-double-booking constraint — an abandoned checkout could be sold twice'; end if;

  if exists (select 1 from information_schema.table_constraints tc
              join information_schema.constraint_column_usage ccu
                on ccu.constraint_name = tc.constraint_name
             where tc.constraint_type = 'FOREIGN KEY'
               and tc.table_name like 'park\_%'
               and ccu.table_name in ('jobs','invoices','payments','payouts',
                                      'user_credits','referral_earnings'))
  then raise exception 'THE WALL IS BREACHED: a park money table references the service money pipeline'; end if;
end $$;
```

**The screening post-condition, corrected.** As drafted its regex literal spanned
lines, and SQL preserves the newlines, so only the first line's alternatives ever
matched — leaving `result`, `payload`, `criminal`, `dob` and ~20 others
unchecked. Use one line, or:

```sql
do $$
declare pat text; bad text;
begin
  foreach pat in array array['ssn','social','tax_?id','itin','score','report',
    'tradeline','dob','birth','age','race','ethnic','disab','religio','gender',
    'sex','orient','marital','children','kids','famil','nationality','citizen',
    'immigra','criminal','conviction','verdict','result','payload','passed'] loop
    select string_agg(table_name||'.'||column_name, ', ') into bad
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('park_applications','application_applicants',
             'park_application_answers','screening_orders','application_decisions',
             'adverse_action_notices','park_screening_policy','park_screening_criteria')
       and (column_name ~* pat or data_type in ('json','jsonb'));
    if bad is not null then
      raise exception 'FORBIDDEN COLUMN(S) matching "%": %. This module may not hold consumer report content, an SSN, or a protected-class attribute.', pat, bad;
    end if;
  end loop;
end $$;
```

---

# Appendix B — pure-function specs

House convention throughout: no I/O, no `Date.now()`, `today` passed in,
deterministic and totally ordered, unit-tested at the density of
`parks.test.ts` (40 cases with a 4,000-pair symmetry fuzz) and
`park-helpers.test.ts` (50 cases).

**`src/lib/rent.ts` — the single authority on period arithmetic.** Everything
that answers "what does a month cost" goes through here. `quoteStay` becomes a
wrapper over it, and an invariant test asserts they agree.

```ts
export function periodsFor(
  lease: { start: string; end: string; term: Term; amount: number;
           dueMode: "fixed_day" | "anniversary"; dueDay?: number;
           partialPolicy: "prorate" | "round_up";
           prorationMethod: "daily_actual" | "daily_30" | "none" },
  from: string, to: string,
): { periodStart: string; periodEnd: string; dueDate: string;
     amount: number; prorated: boolean }[];

/** Monthly-equivalent value of a lot, for the vacancy-exposure number.
 *  Calendar arithmetic — never quoteStay, which rounds UP to whole periods. */
export function monthlyEquivalent(rate: number, term: Term): number;

export function allocate(
  payment: number,
  open: { chargeId: string; kind: string; dueDate: string; balance: number }[],
  order: "rent_first" | "fees_first",
): { chargeId: string; amount: number }[];
```

**`src/lib/parks.ts` additions — the stacking rule.**

```ts
/** Total contiguous occupancy by one renter in one PARK (not one lot — moving
 *  a guest between sites does not reset the clock), tolerating short gaps. */
export function contiguousNights(
  parkId: string, renterKey: string, want: DateRange,
  held: { parkId: string; renterKey: string; range: DateRange }[],
  gapToleranceDays: number,
): number;
```

**`src/lib/park-regime.ts` — proposes, never decides.**

```ts
export function proposeAgreementClass(a: {
  occupancyClass: "residential" | "recreational";
  nights: number; licenseMaxNights: number | null;
  soleResidence: boolean | null;      // "is this your only home right now?"
}): "license" | "lease";
// residential -> lease. soleResidence === true -> lease, whatever the nights.
// no dial configured -> lease. Otherwise nights <= max -> license.
```

**`src/lib/parks-departures.ts` — who is about to leave.**

```ts
export type DepartureReason =
  "checkout" | "term_end" | "notice_given" | "non_renewal" | "owner_ended";

export interface Departure {
  reservationId: string; lotId: string; renterKey: string;
  lastNight: string; vacantFrom: string; daysOut: number;
  term: Term; reason: DepartureReason; certain: boolean;
}
```
An auto-renewing tenancy with no notice and no decision is **not** a departure —
it is a renewal decision, and it belongs in the action queue. Telling an owner
"Jane is leaving" when the truth is "you haven't decided yet" is how a lot gets
listed while a good renter is still in it.

**`src/lib/doc-state.ts` — one predicate, replacing the same test open-coded in
eight-plus places.**

```ts
export type DocState =
  "missing" | "expired" | "expiring" | "pending_review" | "rejected" | "ok";
export function docState(a: {
  hasFile: boolean; expiry: string | null;
  review: "pending" | "accepted" | "rejected" | null;
  today: string; soonDays: number;
}): DocState;
```

**`src/lib/compliance.ts` — reasons, never a score.**

```ts
export type CheckStatus = "ok" | "due_soon" | "action_needed" | "overdue"
  | "pending" | "waived" | "not_required" | "not_applicable" | "unknown";

export interface ComplianceCheck {
  key: string; label: string; status: CheckStatus;
  reason: string;                 // one plain sentence he can read aloud
  since: string | null; expiresOn: string | null;
  renterAction: { label: string; href: string } | null;
  ownerAction:  { label: string; href: string } | null;
  blocksAutoRenewal: boolean;     // the ONLY thing red is allowed to stop
}
export function tenancyCompliance(f: ComplianceFacts, today: string): {
  roll: "green" | "amber" | "red" | "unknown";
  checks: ComplianceCheck[]; summary: string;
  counts: Record<CheckStatus, number>;
};
```
`not_applicable` is what a grandfathered tenancy's screening check returns —
permanently, with no nudge and no badge. `unknown` exists so a park with rent
turned off never renders red.

**`src/lib/doc-template.ts` — merge, don't program.**

```ts
export const MERGE_TOKENS = [ /* closed allowlist */ ] as const;
export function renderTemplate(body: string, vars: Record<string, string | null>): {
  ok: boolean; text: string; missing: string[]; unknown: string[];
};
// ok is false if anything is missing OR unknown, and an envelope cannot be
// created from a non-ok render. A lease that goes out with a literal
// {{rent.amount}} in it is worse than no lease.
```

**`src/lib/screening.ts` — the policy lives in the type signature.**

```ts
// There is deliberately NO method that returns a score, a verdict, or any
// report content. If a provider adapter ever needs one, that is not an adapter
// change — it is a decision about what LakeLife is, and it goes to counsel
// before it goes into a type.
export const LakeLifeScreening = {
  invite(i: ScreeningInvite): Promise<{ ok: boolean; error?: string; ref?: string }>,
  status(ref: string): Promise<ScreeningStatus>,   // state machine only
  cancel(ref: string): Promise<{ ok: boolean; error?: string }>,
};
```
