# The Park Experience Blueprint

**Status:** design, resolved. Written 2026-08-08 after ten parallel research and
design passes and two red-team passes. Extends `park-module-design.md` (phase 1,
shipped, dark) and `park-module-phase2-design.md` (phase 2, designed). Where this
document contradicts either, this one wins and says why.

**What this is.** One document that answers a single question: *what does every
person actually see, tap and feel when LakeLife runs a mobile-home and RV park —
and what do we build first so that the man who just bought Pretty Lake is still
using it in year three?* It settles the five journeys with real screen copy, the
automation ladder, the AI fences, the integration picks, the 90-day conversion
plan, and the build order. It also resolves twenty-six red-team findings, twelve
of which are live defects in shipped code and six of which would have shipped a
privacy leak, a data-loss bug, or a burst pipe.

**The one-line version.** The park module's commercial case is not a consumer
marketplace of eighty renters. It is one enterprise sale to one man, once a year,
executed by crews — and the software's job in season one is to replace his
notebook so convincingly that he says yes to it.

---

# 1. What the competition gets wrong

Two markets were researched: RV/campground reservation platforms (Campspot,
Firefly, CampLife, Newbook, RoverPass, ResNexus, Bonfire) and mobile-home back
offices (ManageAmerica, Yardi MH, Rent Manager, plus the multifamily tools that
claim MH support). Findings are marked `[confirmed]` where read on the vendor's
own page, `[review]` where from a named reviewer, and `[unverified]` where the
research could not confirm it. **Nothing below is invented.**

### The four structural failures

**1. Everybody treats "a resident" and "a user account" as the same object.**
Every platform in both markets onboards a tenant by inviting them to a portal.
There is no primitive anywhere for *a person the park knows about who will never
log in*. That is why every MH operator runs a parallel spreadsheet next to their
software, and it is the single reason the market's own tools cannot represent
the park our owner is buying. Our `park_renters` table is, as far as the research
could find, unique — **and it is also our biggest current gap** (§3).

**2. Long-term tenancy is a bolt-on, and it breaks at the seam.** Campspot's own
users report that monthly billing anchored to an arrival date "doesn't quite
handle that properly" `[review, Devin S., GM]`; that meter reads land on the
wrong invoice and get "doubled" `[review]`; that you cannot roll a seasonal
booking to the following year `[review, Noreen M.]`; and that you cannot check a
guest out early, so you cannot re-rent the site `[review, Wendy B.]`. Newbook's
own marketing gives the game away — its long-term feature is that you can "lock
specific sites for long-termers without losing visibility" `[confirmed]`. That is
not modelling a tenancy. That is excusing it from the model.

**3. Nobody dispatches an outside crew.** This was checked specifically.
campersAPP texts firewood and maintenance requests **to park staff**
`[confirmed]`. Every housekeeping and maintenance module in both markets assigns
work **to employees**. Rent Manager and Yardi have work orders and vendor lists;
neither sells the labour. **Not one platform in either market can put a licensed
third-party crew on a lot, gate completion on photos, hold the payout, and keep
the customer price away from the crew.** We already have all four. That is the
wedge, and it is the only part of this a Storable or a Campspot cannot copy in a
quarter, because they have no crew network, no photo gate, and no payout rail.

**4. The dashboard is a reporting surface, not a decision surface.** Occupancy,
arrivals, departures, revenue. Nobody shows the owner *"3 lots out of service ·
214 days · about $18,000 to get them back."* Worse, most occupancy math — **ours
included today** — drops out-of-service lots from the denominator, so the number
gets better as the problem gets worse.

### What is genuinely worth stealing

- **Firefly's colour-as-a-mode grid.** The operator switches what colour *means*
  — check-in status, balance due, reservation type `[confirmed]`. We add a fourth
  lens nobody has: **paperwork**.
- **Firefly's refusal to conflate no-show with cancellation.** "When selecting
  'No Show', this will not cancel a reservation" `[confirmed]`. A no-show is an
  observation; cancellation is a financial decision. **This is the same class of
  error as our own freeze-cancel bug** (§3.1).
- **CampLife's 7-day invoice maintenance window** `[confirmed]` — the invoice
  generates but stays open so staff can attach meter reads and adjustments
  before it sends. It eliminates the doubled-meter-read complaint by design.
- **Campspot's Lock Site economics.** Their published figures: parks forwent
  $2.5M of occupancy revenue to honour locks but collected $15.46M in lock fees
  `[confirmed, their numbers]`. We get the guest's half of that free, because our
  exclusion constraint assigns a real lot and never shuffles it.

### The pricing arbitrage

Firefly charges **$3.50/month per active long-term reservation** `[confirmed]`.
On an 80-lot park with 76 sitting tenants that is ~$266/month for tenancies that
generate no bookings, no marketplace traffic and almost no support load. A
per-occupied-lot or flat-park price undercuts the whole category on exactly the
population our owner has most of. AppFolio's floor is $280/month `[unverified,
secondary]`; a 60–100-lot park pays $200–450/month plus four figures of setup for
MH-capable software `[unverified, secondary]`. **We do not need to win on price.
We need to not lose on it, and then win on the crews.**

### Our sentence to park owner #2

> *"Your monthly tenants are billed from the day they arrived. Your rent roll
> shows which numbers your tenants confirmed and which came from the seller. When
> somebody leaves early the lot is re-rentable before the door closes. And when
> something breaks that you can't fix in-house, one tap sends a licensed,
> insured crew — and you see the photos before you see the invoice."*

Every clause but the last is a documented failure of the market leader. The last
one is a thing nobody in either market can do at all.

---

# 2. The owner's decisions

Six. Each has a recommendation and what happens if he goes the other way.

---

### Decision 1 — Season-one scope: the cut, or the whole phase 2

**The finding that forces this.** The adoption red team costed the full phase 2
against his actual first week. He is closing on real estate, adding four park
homes, clearing an RV row, and is the product owner of a platform that is itself
at launch. The full phase 2 asks him for **over 200 discrete decisions in week
one** and roughly 8–12 hours of data entry before anything pays him back. And I
verified the reward is not there: today `saveLot` and `saveLotRates` are two
separate server actions, each with its own refresh — **79 lots is 158 form
submissions**, at the end of which the rent roll is still empty, because
`lot_reservations.renter_user_id` is `not null … on delete cascade` and none of
his tenants has an account.

**The cut.** Season one ships six things:

1. `park_renters` with a nullable account link (the gate — §3)
2. Lot generator + bulk rate apply + a paste importer with a reconcile screen
3. **The window** — record a payment, show the balance, print or text a receipt
4. A one-screen rent roll with honest provenance
5. **One service** — mobile-home winterization — sold to the park owner as a
   portfolio, with crews contracted before the offer renders
6. The maintenance request queue with the QR sticker (it is the service
   discovery mechanism, and it is cheap)

**Cut from season one:** applications and screening (he has three empty lots — a
phone call handles three), the public page and reservation grid, deposits and
their statutory clocks, all of phase 3 (ACH, autopay, remittance), lease
templates and the e-sign flow, and the renter-facing app.

**Recommendation: take the cut.** It is 1 L + 3 M + 2 S — roughly **eight to ten
weeks** — and it delivers close to all of the realistic season-one margin with
about 15% of the build.

**If you don't:** the full phase 2 is six to nine months, and the risk is not
that it comes in late. The risk is that he opens it in week two, finds his rent
roll empty and his Saturday money orders unrecordable, and the notebook wins
permanently. **Once the notebook is the real ledger, no feature we ship later
takes it back.**

**The design rule that comes out of this, and it should govern every future
argument:**

> **If the renter never opens the app, does this still work?**
> All six pass. Nothing that fails it gets built until season one asks for it by
> name.

---

### Decision 2 — The renter app: build it, or defer it a year

This is the emotional one, because "give the renter the ability to have the
services and crews available to manage their LakeLife" is in your own words.

**The arithmetic.** Honest monthly-active app usage for a rural northern-Indiana
MH park's renter portal at month 12 is **10–20%**. Multifamily's own adoption
data ranks the resident portal *below* both text and email in stated preference
`[confirmed, Buildium 2025]`, and this cohort is older and more rural than
multifamily. Run `park_model.py`'s menu at 15% engagement and the renter rail
delivers roughly **$3,200 of margin** against the modelled $18,424.

The park-owner-funded protective portfolio — 76 winterizations at $300, one
order, one man, one decision — is **~$4,600 of margin from a single tap**, plus
the spring pass, plus turnovers on his four park homes. Call it **$9–10k**.
**Three times the entire renter rail, from one customer, with no app adoption
risk at all.**

**Recommendation: defer the renter portal. Keep exactly two renter-facing
things** — the QR sticker on the lot pedestal that opens a pre-filled maintenance
request with no login, and a verified mobile number captured at the office window
that lets us text receipts and freeze warnings without an account. Both work for
a 74-year-old with a flip phone. Neither needs a portal.

**If you build it anyway:** you spend most of a quarter on claim codes, invite
tokens, helper relationships, permission pills and consent screens, to chase
$3,200 — and every hour of it is an hour not spent recruiting the crews that the
$9,000 depends on.

---

### Decision 3 — Who eats the ACH fee when rent goes electronic

**The number that decides it.** Multifamily portfolios of 1,000–5,000 units that
**absorbed** the processing fee averaged **84.71%** digital utilisation; those
that **passed it to residents** averaged **47%** `[confirmed, Zego data reported
by Multifamily Dive]`. Zego's own framing elsewhere is 70–90% versus 20–30%.

And the cost is roughly a wash. A paper check costs **$1–2** to process
`[confirmed, 2022 AFP survey]`. Helcim publishes ACH at **0.5% + 25¢, capped at
$6** `[confirmed]` — about **$2.50** on a $450 lot rent. He is at parity with the
paper it replaces and buys about 35 points of adoption.

**Recommendation: the park absorbs it, and that is the default for every park we
ever onboard.** Frame any incentive as a **credit**, never a fee — a "$5/month
paperless credit" and a "$5/month paper-check fee" are economically identical and
legally very different. New York expressly bans charging a tenant for declining
electronic payment `[confirmed, RPL §235-g]`; California requires at least one
non-electronic method `[confirmed, Civ. Code §1947.3]`. Since you intend to sell
this to other park owners, ship "must offer a non-electronic method" and "may not
fee it" as **per-park compliance dials defaulting to ON**, not as hardcode.

**If you pass the fee:** you cap tenant conversion around 45% and you spend the
next two seasons wondering why the reminders aren't working. They are working.
The fee is the wall.

---

### Decision 4 — Flip the payer on protective work

**Recommendation: sell the freeze portfolio to the park owner, not to the
tenants — and gate it on committed crew capacity.**

A $395 winterization in one bite, in October, on a fixed income, will
under-convert no matter how good the checkout is. But a burst pipe at lot 34 is
*his* water bill, *his* road cut, *his* liability, *his* vacancy. He is the
motivated buyer. One order, 41 lots, one dense route crews will fight over, and
the tenant's only job is to pick a morning and consent to entry.

It also sidesteps the entire regulatory surface. There is no mandate, no
compelled purchase, no fee on the lease, no recharacterisation as additional
rent. **He is simply the customer.** The FTC's fee rule (effective 12 May 2025,
civil penalties up to $51,744 per violation `[confirmed]`) and the April 2026
class action over a mandatory Resident Benefits Package `[secondary, plaintiffs'
firm]` both point the same direction: the market is moving toward this structure,
not away from it.

**The hard gate, and it is not negotiable.** The arithmetic: 56 winterizations at
75 minutes is **8 truck-days**, plus carts, ≈ **11–12 truck-days per park** — all
inside a window that collides exactly with `pull_deadline = hard_freeze_est − 8`
for every pier, lift and boat on three lakes.

> **No portfolio offer renders until the platform holds contracted, calendared
> capacity for at least 120% of the lots it is about to offer.** Not "a crew
> exists." Committed days, with `vendor_availability` blocks written.

Sell 20 homes with certainty, not 41 on hope.

**If you skip the gate:** he buys 41 in October, we cover 29, and three pipes
burst in a park he closed on eleven weeks ago, on work he prepaid us for. That
ends the reference customer and the sell-to-other-parks plan in one November.

---

### Decision 5 — When money enters the application flow

The settled long-term path is apply → commit (card authorised, 25% of first
month's rent) → screening → decide. The commit step is the problem.

**The wall.** Helcim states preauths are valid **7 days** `[confirmed]`; Visa
card-not-present holds are about the same `[secondary, consistent across
sources]`. A hold cannot outlive a week, and no dial fixes that.

**Recommendation: ship the application flow with no money in it at all.** Apply →
screening handoff → decide → adverse action. The requirements page reads *"$0 to
hold your spot"* until you turn the commit on, which is a **better** first message
anyway. Nothing else in that flow is blocked by the money question.

Then, when deposit custody is settled with counsel:
- **Short stays** (under the stacking threshold): Verify the card at booking (no
  charge), authorise at T−5, **capture on the morning of arrival**. Money captured
  on the day of service is payment for a service in progress, not custody of
  anyone's money. This ships clean today.
- **Long stays**: bound the hold to 7 days in product, with an automatic
  no-penalty release and an honest text to both sides. A re-auth on day 6 is
  available with consent, and a re-auth failure must read *"your hold lapsed,"*
  never *"you were rejected."*

**If you turn the commit on first:** you are holding money you might owe back
before anyone has told you which state statute governs it.

---

### Decision 6 — Processor: Helcim

**Recommendation: Helcim, pending five written answers.**

It is the only candidate that gives hosted fields (a genuine drop-in for our
existing `LakeLifePayments.tokenize()` mock), a **Verify** transaction that
tokenises a card without charging it, preauth/capture, a real ACH API with its own
pending/settled/returned state fields, and programmatic sub-merchant onboarding
where Helcim handles KYC and AML — all at published pricing with no monthly
minimum and no sales call to read it. All `[confirmed on Helcim's own docs]`.

**Braintree is out.** PayPal's own documentation says Braintree Marketplace "is
deprecated and may be removed in the future" `[confirmed]`. Building park #2's
money layer on that is precisely the rewrite we are trying to avoid.

**The five things to get in writing before signing.** These are one email and
they are worth more than a week of building:

1. Do connected (sub-merchant) accounts support **ACH**? If not, the sub-merchant
   escape hatch does not cover rent, which is the whole point.
2. Do connected-account funds settle **directly to the sub-merchant's bank**, or
   through ours? This single sentence is the difference between "no
   money-transmitter question" and "money-transmitter question."
3. Which **MCC** — 7033 (trailer parks and campgrounds) or 6513 (real-estate
   rentals)? It drives interchange *and* the preauth window.
4. Is **preauth** available on connected accounts?
5. Underwriting appetite for a mobile-home park owner as a sub-merchant.

**And one more, which nobody in the research checked and which could invalidate
the window screen's whole design:** is the Helcim **card-present terminal**
API-linked to a web point-of-sale, or is it a standalone device? If it is
standalone, he types the amount into two devices and reconciles by hand — a seam
we designed away and would be re-introducing. **Unverified. Ask before building
the card path into the window.**

---

# 3. The five things that must be true before anything else

These come out of the red team. Two are live defects with no park attached and
ship this week. Four are preconditions that no amount of good design survives
without.

### 3.1 An unfilled protective job may never be auto-cancelled

**Live, today.** `expireUnfilledJobs` (`src/lib/automation.ts:1338`) finds
past-dated unfilled jobs, flips them to `cancelled`, and texts: *"we couldn't
line up a crew in time for {service} at {where} — so we've cancelled it and you
were never charged."*

For a mobile home in Indiana in November that is not a churned customer. It is a
split water line, a habitability claim, a displaced elderly tenant, and the end
of the park-owner relationship.

**The carve-out template is eight lines above it, in the same function** — the
custody guard that refuses to expire a job whose boat is in the barn, because
"cancelling the envelope would silence the overstay meter and strand the boat."
Same shape, higher stakes.

Add `services.criticality ∈ {discretionary, seasonal, protective}` (a database
column, per rule 8, defaulting to `discretionary` so nothing existing changes),
and split the function in two: `observeUnfilled()` marks and escalates;
`cancelUnfilled()` handles discretionary work only.

**And put it in the database, not just the code**, following the precedent
`0050` already set by enforcing the photo gate and the season window as triggers
rather than trusting the app:

```sql
-- a protective job may not be cancelled by any automated path, ever
if new.status = 'cancelled'
   and (select criticality from services where id = new.service_id) = 'protective'
   and new.cancel_reason not in ('customer_request','ops_override')
then raise exception 'protective work cannot be auto-cancelled (job %)', new.id;
```

**After this, no future edit to the nightly can burst a pipe.** That is what
"structurally impossible" has to mean. One column, one `continue`, one trigger.

### 3.2 We promise a text we do not send

**Live, today.** Three surfaces promise *"we'll text you when a crew is on the
way"* — the booking confirmation (`src/app/book/actions.ts:274`), the phone
verification panel, and a declared notification type in `src/lib/notifications.ts`.
The only sender that fires is the night-before reminder, which says something
else. **There is no en-route path in the product.**

One button on the crew's job card, one timestamp (`jobs.en_route_at`), one
template. Highest ratio in the codebase, correct with or without parks.

### 3.3 A published park's private lot notes are world-readable

**Live, today, and this one is a genuine leak.** `ParkLots.tsx` renders the field
as *"Notes (only you see these)."* Migration `0052` grants `select on
public.park_lots` to **anon**, and the read policy passes for anon whenever the
parent park is active. I read both. Anyone with the publishable key can pull
every published park's private per-lot notes.

The grant is vestigial — `getPublicPark` uses the service role and no client
component reads the table — so the fix is one `revoke`. But phase 2 was about to
add `oos_reason` (values including `abandoned_unit` and `estate|title_dispute`),
pet notes, entry mode and crew rules to the same table.

Fix: `revoke select on public.park_lots, public.parks, public.lot_rates from
anon;`, add `and active` to the lot policy, and add an anon-grant assertion to
0052's post-condition block. **Phase 0. One migration.**

### 3.4 `properties.owner_id` must never be re-pointed — and every design was about to re-point it

This is the most serious design correction in this document. The architecture
design proposed minting a lot's `properties` row owned by the park owner while
the tenancy is unclaimed, then transferring ownership to the renter at claim, and
again at every turnover. It sized that as "one nullable column and one policy
change."

I read the policies. `properties.owner_id` is referenced **105 times across 30
files**, and six base-table RLS policies plus the customer job view plus the AI
context builder key on it directly. Re-pointing it on a turnover hands the new
occupant, through the ordinary homeowner screens:

- every job ever done at that lot, **with the customer price**
- every invoice
- **the interior photos** from the previous occupant's winterization
- the previous occupant's entire message thread with LakeLife, verbatim
- their boats, toys, profile photos and property profile
- signed URLs to all of it

And the previous occupant's own screens go empty — she loses her receipts and her
dispute evidence. The "purpose-built five-field park view" is irrelevant to this;
the leak is on the customer surfaces, not the park ones.

There is a second edge. `properties.owner_id` cascades on delete. If the park
owner is `owner_id` for 79 lots, **one tap on his own Delete Account destroys the
entire service history of the park** — every job, invoice, photo row and message
across 79 lots — and leaves payouts pointing at nothing, which is the exact shape
`0050` refuses to allow to be created.

**The resolution:**

1. A lot's `properties.owner_id` is set once at mint and **never changes.** It
   stays the park owner. He is, factually, the only person who can transact on
   that lot when it is unclaimed, and the column's documented meaning ("the
   person we charge and text") stays intact.
2. Add **two** snapshotted columns on `jobs`: `billed_to_user_id` (who we charge)
   and `occupant_user_id` (who we text, whose photos these are, who owns the
   proof). Both written at insert, neither ever re-pointed.
3. Re-key the leaking reads for lot properties off those two columns instead of
   `properties.owner_id`. The occupant's branch **omits the price** when
   `billed_to <> occupant` — which is exactly the park-funded portfolio case: she
   sees the work and the photos, not what her landlord paid.
4. `deleteAccount` refuses while the user holds a `park_members` row or is
   `billed_to` on an unsettled job.

**Size this as L, not S**, and do it before the first lot property is minted, not
after. It is one nullable column *plus* a policy rewrite across six base tables.

### 3.5 The offline path is greenfield, and three features assume it exists

I grepped the whole of `src/` for `serviceWorker`, `navigator.onLine`,
`IndexedDB` and `localStorage`. **Zero hits.** There is no offline anything.

Three designs assume it: the window's "optimistic save that survives a reload,"
the crew's photo queue with background sync, and the paste importer's
resumability. Rural office wifi is marginal, and a page that silently fails while
a tenant stands there with cash is worse than paper. Under a mobile home, inside
metal skirting, in Steuben County, photo uploads *will* fail — and because
`started_at` stamps on the first photo, a failed upload also loses the crew's
clock-in.

**Size the local persistence layer as its own L and put it in Phase 0.** It is a
platform capability, not a detail of the window screen.

---

# 4. The five journeys

---

## 4.1 The park owner

**The frame.** He is not a user of software. He is a man with a notebook who
agreed to try something. Every screen is judged against one test: *does this
replace a page in the notebook, or add one?*

Three rules govern the whole design:

1. **The record is ours to make correct, not his.** He confirms; he does not
   enter.
2. **The hat is decided by the object, never a mode switch.** Tap a lot he owns
   the structure on → he is the customer, he sees a price, he books. Tap a
   renter's row → he is the landlord, there is no price and no Book button, only
   *Ask*.
3. **Nothing on his screen is a record. Everything on his screen is a
   consequence.** Records live behind tabs and never notify.

### Navigation

```
Pretty Lake Estates  ·  Live                    [ ⊕ Take a payment ]
Today   Renters   Money   On site   Lots & rates   Setup
```

`⊕ Take a payment` is a **persistent button, not a tab** — gold, on every park
screen. It must work in three taps while somebody is standing in front of him
with a money order. Anything you navigate to is not a point-of-sale terminal.

(The calendar/reservation grid designed in the research is real and good. It is
season two. He has three empty lots.)

### First run — and the honest number

**We tell him the truth about the time.** The research produced a 6× contradiction
— one document promised "under 90 minutes, of which 60 is walking the park," and
the phase 2 build plan says the same walk is "6–10 hours with a tape measure and
cannot be automated." He will be told 90 minutes, discover it is two days, and
then discount every other number we give him.

**Resolution: the walk is cut from season one entirely.** Site types, rig
lengths and amperage exist to fill transient RV lots. We are not filling
transient RV lots this year. The lot generator creates 79 pads with sensible
defaults and he never measures anything.

Honest season-one setup: **about 90 minutes of his time, plus whatever it takes
him to read 76 rows.** Say that.

```
┌──────────────────────────────────────────────────────────┐
│  Welcome to LakeLife 🌊                                   │
│                                                           │
│  Pretty Lake Estates                                      │
│  79 lots · 76 people living here                          │
│                                                           │
│  We already typed in your rent roll from the papers you   │
│  sent us. Nothing is published and nobody has been        │
│  contacted. It's sitting here waiting for you to say      │
│  it's right.                                              │
│                                                           │
│  Give it about an hour. You can stop anywhere and pick    │
│  it back up.                                              │
│                                                           │
│                              [ Let's look at it ]         │
└──────────────────────────────────────────────────────────┘
```

*"Nothing is published and nobody has been contacted"* is the most important
sentence on the screen. His actual fear is that the software will text 76 people
something he hasn't read.

**Confirming the roll.** One row per lot, in lot order, everything inline
editable, nothing a form:

```
  Lot 1    Donna Wexler          $465 / month    paid thru Aug 31   ✎
  Lot 2    Ray & Judy Kastner    $465 / month    paid thru Aug 31   ✎
  Lot 3    ⚠ nobody on this one                                     ✎
  Lot 4    Marilyn Boecker       $440 / month    paid thru Jul 31   ✎

  ─────────────────────────────────────────────────────────
  3 lots have nobody on them. That's normal — tell us what's
  going on and we'll keep them out of your occupancy number
  until they're fixed.
```

The five-tap picker behind that prompt:

```
  What's the story with lot 3?

  ○ It's ready to rent
  ○ Somebody's home is sitting on it and they're gone
  ○ It needs work before anyone can live there
  ○ It's tied up — estate, title, a lawyer
  ○ I'm keeping it
```

**Why this is worth his time.** `summarise()` in `park-helpers.ts` currently does
`if (r.state === "inactive") { s.inactive++; continue; }` — the `continue` skips
the lot-count increment, so out-of-service lots leave the denominator. **His
occupancy percentage improves as his problem gets worse.** An owner who catches
that once stops trusting every number on the screen. One branch fixes it, and it
buys the credibility of everything else.

### Today

Four tiles, then a consequence-ranked queue. Tiles carry numbers and never carry
buttons.

```
┌────────────────┬────────────────┬────────────────┬────────────────┐
│ COLLECTED      │ OCCUPANCY      │ NEEDS YOU      │ PAPERWORK      │
│ $28,400        │ 71%            │ 3              │ 74 of 79       │
│ of $31,050     │ 56 of 79 lots  │ two are new    │ 5 to chase     │
│ 3 late         │ 3 lots dark    │                │                │
│ $9,100 of that │                │                │                │
│ you wrote down │                │                │                │
└────────────────┴────────────────┴────────────────┴────────────────┘
```

*"$9,100 of that you wrote down"* is the most trust-generating line on the
screen. It renders only when the park has offline payers. He will trust the
number **more**, not less, because it matches the shoebox.

The queue is ranked by consequence, not date: money that will be lost, then a
person who will be harmed, then a decision with a clock, then a decision without
one. Real cards:

```
┌──────────────────────────────────────────────────────────┐
│  Marilyn on lot 4 — her bank sent the rent back          │
│  $440 · Aug 3 · not enough money in the account          │
│                                                           │
│  We haven't told her. Some people would rather hear it    │
│  from you.                                                │
│                                                           │
│  [ Text her about it ]  [ I'll call her ]  [ Not yet ]    │
└──────────────────────────────────────────────────────────┘
```

*"We haven't told her"* is the whole product. **The machine drafts everything; the
human releases anything that moves money or touches a person.**

```
┌──────────────────────────────────────────────────────────┐
│  Ray Kastner is leaving lot 2                            │
│  Gave notice Aug 5 · out by Sep 30 · 56 days             │
│                                                           │
│  $465 a month. Want us to line up the turnover now?       │
│                                                           │
│  [ Get it cleaned Oct 1 ]  [ Later ]                      │
└──────────────────────────────────────────────────────────┘
```

Notice is the highest-value alert in the module and also the cleanest
service-capture moment — a vacancy is a clean, a haul-off, a lot restoration and
a mow, sold to the person already looking at the card.

Empty state, which matters because a northern-Indiana park has nothing happening
for six weeks in February:

```
  Nothing needs you today. 🌊
  Everyone's paid up through February. Next thing on the
  calendar is Ray's renewal on March 1.
```

### The window — the most-used screen in the product

Saturday, 9:40am. Three people at the window with money orders. If he can't
record them, he uses the book, and **the book has won.**

Target: three taps and one number. Six seconds.

```
  ┌──────────────────────────────────────┐
  │  Who's paying?                       │
  │  ┌────────────────────────────────┐  │
  │  │ 🔍 lot number or name          │  │
  │  └────────────────────────────────┘  │
  │                                      │
  │  Lot 4   Marilyn Boecker    owes $440│
  │  Lot 12  Jane Prill         owes $465│
  │  Lot 27  Doug Amspaugh      owes $880│
  └──────────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │  Marilyn Boecker · Lot 4             │
  │  Owes $440 · August rent             │
  │                                      │
  │        $ 440.00                      │
  │                                      │
  │  Money order  ·  change              │
  │  Money order # (optional) [        ] │
  │                                      │
  │  ┌────────────────────────────────┐  │
  │  │          Save it               │  │
  │  └────────────────────────────────┘  │
  └──────────────────────────────────────┘
```

Amount pre-filled from the balance. **No date picker** — it's today. **No method
picker** unless he taps `change`, defaulting to what this person paid last time.
Bob always pays by money order; the screen should know.

Then:

```
  ┌──────────────────────────────────────┐
  │  ✓ $440 from Marilyn, lot 4          │
  │  She's paid up through August.        │
  │  Receipt PRTY-2026-0417               │
  │                                      │
  │  No number on file for Marilyn —      │
  │  want her to get receipts by text?    │
  │  Takes twenty seconds.                │
  │                                      │
  │  [ Set it up ]  [ Print ]  [ Next ]  │
  └──────────────────────────────────────┘
```

**That prompt is the entire conversion program.** Don't build a campaign. Build a
receipt, and offer the number at the moment of maximum cooperation, with the
receipt as the reason.

Ten properties that make this real rather than a form:

1. **Offline-tolerant save** with a client-generated idempotency key at tap time,
   an unsynced badge that survives a reload, and a "3 payments waiting to sync"
   banner. (§3.5 — this is new platform work.)
2. **One-hour undo**, then it becomes an append-only correction with a reason.
   Nothing is ever edited away.
3. **Partial payment is normal, not an error.** $200 against $385 shows "balance
   after: $185" *before* he saves. This is exactly what `invoices` cannot
   represent — the shipped constraint permits **one captured payment per invoice,
   forever** — and it is the clearest single reason the rent ledger is its own
   thing.
4. **Overpayment is a credit**, not a rejection.
5. **A payment can be recorded against a tenant with no user account.** Put that
   in a comment on the payer column, because someone will eventually "tidy" it to
   NOT NULL and silently break the product for the people it was built for.
6. **Never imply the collected number is complete** — the honesty line above.
7. **"Paid by" is one optional free-text field.** A son drops off mom's money
   order. That's a string on the receipt, which is what he'd write anyway.
8. **Golf-cart constraints**: one hand, standing, sunlight. 48px targets, no
   hover, no two-handed modals.
9. **A gapless per-park receipt number** (`PRTY-2026-0417`). A voided receipt
   keeps its number, marked void. This is what a bookkeeper and a small-claims
   court both expect from a cash business.
10. **An advisory lock per tenancy on insert**, so two managers on a Saturday
    serialise and the second sees the first's balance.

**Two things the red team found that no design had:**

**The double-post.** He takes a $440 money order at the window Saturday, then
runs it through a check scanner Monday. Two different rails, two different key
spaces, **$880 credited.** An idempotency key protects against retry, not against
two humans recording one dollar through two doors. Fix: an `instrument_ref`
column (check or money-order serial) with a partial unique index per park,
**required** for checks and money orders. It is the one field that exists on both
sides.

**Money leaving.** Corrections are negative allocation rows, which is right for
the ledger. But a **disbursement** — a $15 overpayment returned, a deposit
refund — is money physically leaving, and it cannot go through the refund engine
because that requires a captured payment on an invoice and a cash payment has
none. Nothing modelled it. In practice he writes a check and it never reaches the
ledger, which reopens the two-systems problem on the one class of transaction
that is legally clocked. Fix: `park_disbursements` as its own append-only table
with a required evidence field and a hard constraint that it can never carry an
invoice, job or payout reference.

### The Monday recap

```
  LakeLife: you took $4,155 from 11 tenants Saturday — all 11
  have receipts, 3 partial, 1 voided. Four people show as late
  but you were at the window. Anything you haven't written down?
```

The notebook's real feature was that it sat visibly on the desk. This replaces
that, and it is what keeps two systems from forming.

### What he never sees

| Never | Why |
|---|---|
| What a renter paid for any service | Rule 1's spirit |
| Any crew's rate, cost or payout | Rule 1 |
| LakeLife's margin, on anything | Rule 1 |
| A gate code that isn't for his own property | Rule 3 |
| Photos or messages from a renter's job | The proof is the customer's |
| Make-it-right revisit rows | Repeated corrections identify the complainer |
| A screening report, score, or pass/fail | We are never a Consumer Reporting Agency |
| Any recommendation on an application | Settled. No score, no rank, no colour |

What he **does** see on a renter's job is five fields: which lot (not the address
— 79 lots share one), when, a coarse category, the crew's company name, and a
derived state. **Site access is a legitimate interest; a purchase record is not.**

And the guarantee is structural — a purpose-built view with the forbidden columns
physically absent, mirroring how the crew view is built, so no future policy edit
leaks them.

**One honest correction to the phase-1 claim, and it is now a live rule-1 risk.**
Phase 1 said park owners "see no dollar amount, ever." True of the screens, false
at the data layer: `services_read` grants SELECT on the whole `services` table —
including `base`, `unit_rate` and `band_pricing` — to ops **or any user with
`role='owner'`**, and phase 2's own constraint requires a park owner to keep that
role. I read the policy.

That alone is not a breach: no crew cost, no margin. **But it becomes one for a
park owner who is also a crew** — and the ops journey explicitly designs for that
person, because a park owner who mows his own common ground is exactly who we'd
also invite as a crew. The fill-in board publishes a crew take-home computed as
menu × (1 − floor), rounded down to a $5 step, minus jitter. The code comment says
the rounding "breaks the ÷(1−floor) inversion so a crew can't back-solve the menu
price." That protects menu from someone who doesn't know menu. **A park-owner-crew
knows menu exactly, so he can invert for the floor** — pinned to about four
percentage points on one observation, and to a single value on two.

Fix: narrow `services_read` so a park owner reads a customer-facing menu view, not
the pricing table. **Before park #2, and before any park owner is also a crew.**

### The line that must be structurally impossible

We hold the encrypted gate code for every property. *"Lock them out until they
pay"* is technically trivial here and is an unlawful self-help eviction
essentially everywhere.

> **The gate-code rotation module does not import tenancy state or money state,
> and a migration post-condition asserts it.** Not unwired — impossible.

This is the one place I would spend a post-condition on something nobody has
requested, because the request will come, at 11pm, from a park owner who is
furious and right about the money.

---

## 4.2 The existing renter — onboarding without asking them for anything

**The frame, in three sentences.**

1. The rent roll must be right before a single tenant does anything.
2. **"Paperless" is an operator-side property, not a tenant-side property.** He
   can be 100% paperless in 30 days with zero cooperation from a 74-year-old with
   a flip phone. Tenant-digital is a separate, slower, permanently-incomplete
   number. **Ship two metrics and two promises.**
3. The failure mode is not "the tenant doesn't convert." It's "the tenant
   converts and the record was already wrong."

### The schema change, in one sentence

> **`park_renters` is a park's FILE on a person. `users` is a person. Many files,
> one person.**

Put that in the migration header, or someone will "simplify" it into a global
identity graph.

**What it fixes, and this is the sentence to say to him:** today, a tenant
tapping Delete Account on their own phone destroys your lease. After this, it
can't. The account link goes null; the tenancy, ledger, lease, deposit and
maintenance history all survive, because none of them ever pointed at `users`.

**Three red-team corrections to the design as originally drafted:**

**(a) Drop the one-file-per-person-per-park uniqueness.** The proposed unique
index would permanently lock a tenant out of her second file — a tenant on a lot
plus a storage lot, a couple imported as two rows, someone who moved lots
mid-year and appears twice on the seller's roll. There was no merge path and the
invariant made one impossible without a migration. A person may hold N files in a
park; that is reality. Add `merged_into` for genuine duplicates and never delete a
file.

**(b) The existing reservation guards break on a shadow tenancy.** The trigger
that checks a rig belongs to the renter compares against `renter_user_id`; with
that null the comparison is never true, so **it raises** — attaching a rig to a
sitting tenant becomes impossible. The trigger that stops a renter approving
their own tenancy compares two values, one of which is now null, so the whole
condition is NULL and **the guard silently stops guarding**. Both must be
rewritten to key on `park_renter_id` in the same migration.

**(c) `renter_user_id` is not a cache.** It is an authorisation key — it appears
in the read policy, in two guards, in an index, and in three loaders. Keeping it
as a hand-maintained duplicate guarantees a stale principal or a tenant locked out
of her own tenancy. **Delete it in the same migration** and rewrite the policy
through a definer helper on `park_renters`.

### The primitive that makes the whole conversion ladder work

`park_renters` carries **three** phone columns, and the distinction is
load-bearing:

- `phone_on_file_with_park` — from the seller's spreadsheet. **Never a send
  target**, enforced by a repo test.
- `mobile_e164` + `mobile_verified_at` — **a park-scoped verified mobile that
  requires no account.**

At the window: *"What's the best number for you? I'll text you the receipt."* →
verification code → done. Ten seconds. She now gets rent receipts, "your rent is
due Friday," "a crew is coming Thursday," and "hard freeze Thursday night, here's
where your shutoff is" — **and she never installs anything, never picks a
password, never sees a portal.** All the operational value of the app, zero app.

Without this column, the single biggest documented adoption lever (reminders lift
portfolio adoption 60%+ `[confirmed, Zego]`) is unreachable for exactly the
people who need it.

### The importer — paste, not upload

**Contrarian, and I'll defend it.** The seller's roll arrives as a PDF, a
printout, an emailed table from a paralegal, or a photograph of a notebook page.
A clean CSV is the exception. And a CSV importer that reports "79 rows imported
✓" **manufactures confidence in precisely the number the diligence literature
says runs 10–20% inflated.** A green success toast on a wrong rent roll is worse
than typing.

Four fields make a tenant useful: **lot, name, rent, due day.** State the rule and
enforce it in the form:

> **The importer never blocks on a field the owner does not have. A tenancy with
> no lease is a tenancy. A move-in date we don't know is null, not a guess.**

**The reconcile screen is what earns his trust**, and it has three columns:

```
  MATCHED (74)              LOT NOT FOUND (2)        NOBODY ON THESE (3)
  Lot 1  Donna Wexler       "34B" isn't a lot        Lot 7
  Lot 2  Ray Kastner        here. Create it?         Lot 19
  Lot 4  Marilyn Boecker    Map it? Skip?            Lot 44
  ...
                                                     Walk these three before
                                                     you trust the number.
                                                     A lot with no roll entry
                                                     is either empty or a cash
                                                     tenant the seller forgot.
```

**The third column is what nobody builds and it is the one that catches the
inflation.**

**Do not import balances as charges.** A delinquent balance on a seller's
spreadsheet is a diligence artifact, not a receivable we can substantiate, and it
will be the first number a tenant disputes. Import it as a **note**; let him
convert each one deliberately.

### Provenance — the best idea in the whole corpus

Every imported field carries its source: `seller_roll · owner_knowledge ·
tenant_confirmed · document`. When a tenant confirms, the source flips — **and
that is visible**:

```
  $27,200 expected
  $24,100 confirmed by tenants
  $3,100  from the seller's roll only
```

He will walk those three lots. That is the correct behaviour, it is the honest
version of a rent roll, and **no incumbent has it** — every platform in both
markets renders the seller's numbers as facts.

It is also the most persuasive thing we can put in front of park owner #2,
because it says: *we know your seller shaded it, and we'll show you exactly
where.*

### Grandfathering — three mechanisms, not a convention

A sitting tenant since 2019 was never approved by anybody. So:

- `origin = 'grandfathered'`, written by its own import path, never by the
  application path.
- **A check constraint**: a grandfathered tenancy cannot carry a decision. If
  someone later ships a "bulk approve all sitting tenants" button — and someone
  will, because it looks tidy — **the database refuses.**
- Screening renders as `not_applicable`, which renders as **nothing**. No colour,
  no dash, no grey pill. Absence is the design, and it is tested. A red badge here
  would push a park owner toward pulling a credit report on somebody already
  living in his park.

And the principle extends past screening to five more fields nobody had covered:
never imply a lease existed ("No written agreement on file," never "Missing");
**never synthesise a move-in date** we don't have; never show a deposit as a
liability until he confirms the cash actually transferred at closing; never impose
a new requirement retroactively (that's a modification with a notice period, not
a compliance gap).

### The rule that prevents the worst message this system could send

He takes money orders Saturday and enters them Monday. Nothing today stops the
renter's screen — or his own delinquency count — saying **"overdue"** on Sunday
for money already handed to a human.

> **`office_recording_lag_days`, default 3. No renter-facing "late," "overdue" or
> "past due" string may render inside the park's recording lag — and neither may
> his own delinquency tile.**

That message, sent once to a fifteen-year tenant, ends the relationship with the
app permanently. It is one clamp and it is cheap.

### Papering an unpapered tenancy

**The distinction the whole section rests on:** a document that RECORDS an
existing arrangement is not a document that CREATES one. Oral rental agreements
are valid in Indiana for terms under a year `[secondary — counsel question]`, so
an unsigned handshake tenant is a real tenant with real rights and **there is
nothing to fix.**

Three instruments, three signatures, **never bundled**:

1. **Tenancy confirmation.** *"This is what we believe is true. Correct anything
   that's wrong."* Tenant-editable on every field, and their edit is the record.
   In bold, wording to be blessed by counsel: *This confirms the agreement you
   already have. It does not create a new agreement, change your rent, or change
   your rights.*
2. **Community rules acknowledgment**, separate, with the statutory notice clock
   held by a **database check**, not a form.
3. **A new lease — offered at natural renewal, never imposed.** Framed as an
   upgrade with something in it for them: a fixed 12-month rent, the paperless
   credit.

**The trigger that makes it safe:** signing a confirmation may **not** write rent,
term, dates, or agreement class in the same transaction. A mismatch raises a
correction task:

```
  Sarah says her rent is $340. Your roll says $385. Which is right?
  [ She's right ]  [ My roll is right ]  [ I need to check ]
```

Because that gap is either a typo or **a promise the seller made** — and this
surfaces it in week three instead of in a deposition.

**Wet ink is a first-class path.** A tenant signing on paper at the window
produces the *same* signature row, scanned, with a wet-ink method. **Paper input,
electronic record.** That is this module's philosophy in four words.

**And attribution is the risk, not signing.** The park owner holding an iPad and
tapping through a tenant's signature is a forgery with a perfect audit trail. The
control is a fresh code to the **tenant's own phone** at the moment of signature —
non-optional specifically on the in-person path, which is counterintuitive but
correct. A tenant with no mobile gets wet ink only. *We do not sign for people.*

---

## 4.3 The prospective renter

Season one, this journey is a phone call — he has three empty lots. What follows
is the season-two design, settled now so nothing built in season one contradicts
it.

### One change makes both paths possible

Today `/parks/[slug]` is **lot → dates**. It needs to be **dates → path → lots**,
because the dates decide what's available, what it costs, and **which of two
products the person is about to use.**

Then the path declares itself in one sentence:

- **Short stay:** `You can book this right now. Nothing to apply for.`
- **Long stay:** `Stays this long go through Pretty Lake Estates. They review and
  decide — here's exactly what they ask for before you spend anything. →`

### The `openNow` fix — and the red-team correction to it

**Live bug.** `openNow` is computed against tonight only. A lot occupied tonight
and free for a traveller's Labor Day weekend renders `Taken` with no way to find
out otherwise. Every journey called this a five-line fix.

**It isn't, and the reason matters.** The file's own header says the absence of a
reason is deliberate — *"taken until the 14th" would leak another renter's
dates.* Replacing one bit with an arbitrary caller-supplied range turns it into an
**oracle**: an unauthenticated caller binary-searches ranges against one lot and
reconstructs that person's exact arrival and departure dates, and by differencing,
every turnover in the park.

**Resolution.** Beyond tonight, answer at **park** granularity — *"3 lots open
Sep 12–15, from $52"* — and reveal which lot only at authenticated booking. Where a
per-lot answer is genuinely needed for RV transients, publish a **precomputed set
of bookable start dates** over a fixed horizon rather than answering arbitrary
ranges, and rate-limit. Both keep the fill purpose. Neither is an oracle.

### Before they spend a dollar

A real, linkable, **versioned** requirements page. Every item is a criteria code
from a platform allowlist with a numeric parameter. **There is no free-text box
anywhere on it**, which is precisely why a park cannot publish "no families."

```
WHAT PRETTY LAKE ESTATES ASKS FOR
Last updated Jul 2, 2026

Every applicant here is asked for the same things. Read this
before you spend anything — we'd rather you walked away now
than after.

  Income          At least 3× the monthly rent, from any source.
                  Wages, benefits, retirement, disability, child
                  support — it all counts the same.
  Rental history  Two years, or a written explanation.
  Credit + background   Run by TransUnion SmartMove. About $45,
                  paid to them.
  Insurance       $100,000 liability, park named. Due before
                  move-in, not now.
  Occupants       Up to 4 people in this home.

WHAT IT COSTS TO APPLY
  LakeLife                      $0    We never charge to apply.
  Pretty Lake Estates           $0
  TransUnion                  ~$45    Paid straight to them.
  ─────────────────────────────────
  Most you can be out of pocket: $45

WHO DECIDES
  Pretty Lake Estates does. LakeLife runs the software and the
  service crews — we don't screen anyone and we don't get a
  vote. We never see your Social Security number, your credit
  report, or your score. Not a policy. We built it so we can't.
```

*"We built it so we can't"* is an architecture claim, and §5 makes it true.

### The screening handoff — the seam that must not show

Three screens. The middle one is the design.

```
NEXT: THE BACKGROUND CHECK

Pretty Lake Estates uses TransUnion SmartMove. You're about to
leave LakeLife and go to TransUnion's own site.

  TransUnion asks for your Social Security number. LakeLife
  does not see it. LakeLife does not see your credit report,
  your score, or anything in the check. They send it straight
  to Pretty Lake Estates. All we learn is that you finished.

  About $45, paid to TransUnion. LakeLife gets none of it —
  not a fee, not a cut, not a referral.

  About 15 minutes. If the tab closes, the link in your texts
  brings you right back to this spot.

           [  Go to TransUnion  ]
           [  I'll do this in a minute  ]
```

Three things are working here. The SSN warning is **pre-emptive** — the fear
arrives before the field does, so we answer it first. The architecture claim beats
a privacy promise. And *"the link in your texts brings you back"* removes the most
common way this flow dies.

Simultaneously, to the park owner — and the delivery address is the cheapest
possible misconfiguration detector:

```
  LakeLife: Jane Smith finished her screening with TransUnion
  for site 12. Their report goes to you directly, at
  rentals@prettylakeestates.com. We don't get a copy.
```

**Version one needs no integration at all.** Identical screens; he orders it in
his own account and taps *"I've ordered it."* The applicant cannot tell.

### The wait — the product's worst moment

Six fears, six mechanisms. The one to fight for is the third row.

| The fear | The mechanism |
|---|---|
| Did it go through? | A receipt with a timestamp and a lot number, inside 60 seconds |
| What happens next? | Three steps, each with a **named actor**. Never a spinner, never a percentage |
| When? | **A promise date, always** — and if we're going to miss it we say so *before* it passes |
| Silence | **Scheduled reassurance on days when nothing happened** |
| Should I be doing something? | If not, the page **says so in words** |
| Will asking hurt my chances? | A message affordance that says it's safe — and is structurally outside the decision record |

```
  ✓  You sent it            Mon Aug 5, 2:14pm
  ✓  Your screening         Mon Aug 5, 3:40pm — TransUnion
  ⋯  Pretty Lake Estates    with them since Monday afternoon

           You'll hear by Thursday, Aug 14.

  NOTHING NEEDED FROM YOU RIGHT NOW.

  [ Ask Pretty Lake Estates a question ]
  Asking has no effect on their decision. It goes to the park
  office, not into your application.

  [ Withdraw my application ]     No penalty.
```

And the message nobody in either market sends, at day 2 when nothing has
happened:

```
  LakeLife: quick check-in — your application is with Pretty
  Lake Estates and nothing's needed from you. Site 12 is still
  held. Still on track for Thursday. 🌊
```

It costs a fraction of a cent and it is the difference between a company that is
handling it and a form you fell into.

**At day 14 with no response** — and this is an opinion I'll defend:

> Pretty Lake Estates hasn't gotten back to you. We've asked three times.
> Fourteen days is longer than anyone should wait on somewhere to live, so we're
> closing this out and releasing your card hold in full.
>
> **This is not a decision about you.** Nobody said no. Nothing about your
> application was shared with us, and nothing goes on any record anywhere.

`decided_by` stays **null** — nobody decided. We do not leave a human being in
limbo indefinitely to protect a customer relationship.

### The decline — the most delicate screen in the product

Fixed text. Identical every time. No variables but names and the amount. Sent
9am–7pm lake time and within 24 hours. **No 🌊** — the wave is our warmth signal
and it does not belong on a housing decline, and that is enforced in the sender,
not left to habit.

```
Pretty Lake Estates has decided not to move forward with your
application for site 12.

Your $162 hold has been released. Nothing was charged and
nothing will be.

Pretty Lake Estates makes this decision. LakeLife runs their
software and our service crews — we don't screen anyone, we
weren't asked, and we don't have your screening report.

[ shown only when the park answered yes or unsure to
  "did a report play any part?" ]
TransUnion is sending you a separate notice about your rights,
including a free copy of the report they gave Pretty Lake
Estates and how to dispute anything in it that's wrong.
TransUnion did not make this decision.

Questions about the decision go to Pretty Lake Estates.
We're not able to answer them.
```

**What is deliberately absent, and why:** no reason, no hint, no category (the
decline checklist is a compliance artifact for the file, not a message). No "you
can reapply" — that implies a fixable thing and therefore implies a reason. No
"try a smaller lot" or "with a co-signer" — a co-signer *is* adverse action in its
own right, with its own notice obligation. No waitlist for this park — that
implies the "no" was about supply, and we don't know that. **And no sympathy
language** — *"we're sorry to hear"* from a party that didn't decide reads as
either fake or as agreement. Neutral is kinder than warm here.

**And the adverse-action notice sends as part of RECORDING the decision.** The
applicant is not told until it is queued. Not a task, not a nudge, not optional.

---

## 4.4 The crew

**The thesis.** The park run is the only place in this product where crew
experience *is* the business model. `park_model.py` bets the park case on
density — a crew day going from $1,058 to $2,629 because between-stop drive falls
from 12 minutes to 3. **Every one of those saved minutes is recoverable by the app
and losable by the app.** Six taps per stop keeps it. Twelve gives it back to the
phone.

### The field that prevents a serious incident

The crew's job view renders the property address. **Eighty lots share one street
address**, and there is no lot field anywhere in the crew's view. A crew at the
wrong trailer, with a torch, draining someone else's lines, is the failure this
card exists to prevent.

Ten fields, in this order:

1. **`LOT 34`** — the biggest element on the card, before the service name. **In
   a park, the lot number IS the address.**
2. **Structure line** — *"1998 Fleetwood single-wide · tan, brown skirting · shed
   on the north side."*
3. **A reference photo of the unit.** Look before you knock.
4. **Two pins** — park entrance (drive here) and lot (walk here).
5. **Park rules as six chips**, not a PDF. *5 mph · no parking on grass · don't
   block the loop · quiet after 9.*
6. **Office check-in**, when the park requires it, as the run's first step.
7. **Occupancy and entry** — *Occupied, knock first* / *Vacant, turnover*.
   Someone being home is normal here, not an exception.
8. **Pets** — renter-declared free text. *"Brown dog, chained, friendly."* This is
   the field crews will thank you for.
9. **Shutoff location.** For a winterization this is worth more than everything
   above it, and it doubles as the self-help text when we can't cover the job.
10. **Last visit's photos.** Never make anyone re-explain.

**And the inverse, stated structurally:** the crew card carries no rent status, no
balance, no lease state. **The crew is not a collections agent.** Build it as a
purpose-built view with those columns absent, so it cannot be joined back by a
later edit.

### A Run, not twelve jobs

**Twelve jobs**, because there are twelve renters, twelve prices, twelve photo
gates, twelve payouts. Rolling them into one breaks the per-service photo minimum
and — worst — one bad unit would hold pay on all twelve.

**One run**, because a crew must not tap through twelve job pages. A Run is
derived: `(crew × date × park)`. No new table.

Three levels: **Today** collapses the park to one row. **The Run** shows twelve
lots in walk order and carries the park-level material once — gate code, rules,
map, and **one "On my way" button for the whole run**. **The Stop** opens as a
bottom sheet over the run, camera already open, and marking it done **advances to
the next lot automatically.** The crew never goes back to a list.

Target: **≤6 taps per stop, 0 taps between stops.**

### The photo gate across twelve units, without misery

Make the camera the interface. Opening a stop opens a run-mode camera with a shot
counter and a caption chip naming what this shot is. **Four shutter taps completes
a winterization.**

Named photo slots are **guidance and captions, not a hard gate** — the minimum
count stays server-authoritative exactly as today. A crew must never be unable to
get paid because a slot picker broke.

**The first slot is always the lot marker.** That is not bureaucracy — it is the
wrong-trailer control, it costs one shutter tap, and it makes the photo set
self-proving in a dispute.

**The offline queue is the highest-risk item in the whole run** (§3.5). Capture to
local storage keyed by job and slot, upload via background sync, render *"3
waiting to upload"* as a calm chip, not an error. Let completion queue too. Without
it, the photo gate stops being a quality control and becomes a payout blocker
caused by cell coverage — which is the fastest way to lose the scarce side of the
marketplace.

### The run-closing step nobody would think to build

**Today, a stop the crew couldn't do sits scheduled and becomes a no-show at
midnight.** The nightly sweep flags any assigned past-dated job with zero photos,
strikes the crew's reliability, unassigns the job, and texts them that they missed
it. **One blocked stop in a run of twelve strikes a crew who did eleven
correctly** — and it can cost them Priority tier.

End the run with a reconcile:

```
  You marked 11 done. Lot 34 — what happened?

  ○ Nobody home / couldn't get in
  ○ Wasn't ready (skirting off, water already off at the riser)
  ○ Needs more than I could do today
```

Nobody home → back to the pool, renter texted, **no strike.** Wasn't ready →
routes to the park owner's queue. Needs more → becomes a flag: the crew proposes,
the homeowner approves, the price changes atomically. **A resolved-with-reason
stop is an observation, not a ghost.** Only genuine silence is a no-show.

### The engine fix, and the correction to how it was scoped

Every design said "fix the drive-overhead assumption in `buildCandidates`." I read
the code. **`buildCandidates` never calls the time-budget function.** The
admission gate does, and it takes no override. There are **five** production call
sites, and one of them (`book/dispatch.ts:430`) is a **post-write backstop** that
re-checks at the default and, on failure, silently writes the job back to
unassigned with no notification.

So if you lower the overhead in one place, a park job is admitted, written, and
then **silently un-assigned milliseconds later** — after the customer's
confirmation text has already gone out.

**Fix: add an explicit overhead parameter computed once by the loader and thread
it through all five call sites in one commit.** One number, one source, five
readers.

And the alternative the ops journey proposed — "export the projection function
from the fleet planner, size S" — doesn't work either: that function is a closure
over the planner's mutable partition state and cannot be exported without lifting
the whole thing. **Size it M, not S.**

### Routing

`park_lots` has no coordinates, and `parks.lat/lng` exist and are **written by
nothing** (verified: the only reference in the repo is the column definition). So
a minted lot property carries nulls, and:

- The distance function returns **0** for null coordinates, so a 12-stop park
  route computes as 0 km.
- The nearest-neighbour ordering appends unlocated stops **at the end in insertion
  order** — so twelve park stops sort after every lake home, in whatever order
  they were created.
- The map URL builder returns null with no located points, so **the crew's map
  link silently disappears** on a park-only day.

Fix: `park_lots.route_seq` — the owner drags his lots into drive order once during
setup, ninety seconds, and it beats any geocoding — plus an in-park ordering
branch, plus collapsing consecutive same-park stops to one waypoint in the map URL
only.

**And one product rule the engine does not have:** never split a park across two
crews on the same day. The fleet planner currently splits a cluster the moment
keeping it whole would bust hours. Right for a lake. Wrong for a private
residential community — two unfamiliar trucks in a park on one morning is a phone
call to the owner, possibly to the sheriff. **A park cluster is atomic per day. If
it doesn't fit, it spans days, not trucks.**

### Rule 3 in a park — the honest answer

**The uncomfortable truth first: rule 3's scope was always the perimeter, not the
door.** At a lake house the gate serves one property, so property-scoped and
perimeter-scoped coincide. In a park they diverge, and **no software can make a
shared physical code unshared.** Pretending otherwise is worse than saying it.

What rule 3 *can* still guarantee survives intact:

- **One park-level encrypted gate code**, not eighty copies (eighty ciphertexts
  means eighty rotation points and one stale copy that keeps working forever).
- **Visible to a crew only on a day they hold a job in that park** — the existing
  day-of guard, widened from job to park. Twelve jobs is the same disclosure as
  one. **The park run does not weaken rule 3 at all.**
- **Rotation**, which the lake side never needed: a dial defaulting to 90 days, a
  nudge in the digest, a forced prompt on any move-out, one tap to re-encrypt.
  You cannot un-share a shared code; you can make it short-lived.
- **An append-only disclosure log.** Four columns, and it is the log his insurer
  will eventually ask for.
- **Full force on park-owned homes** — per-structure door codes, day-of,
  live-assignment-gated.

Say this to him out loud: *"In a park, the gate code is a perimeter code. We can
promise a crew only sees it on a day they're actually working in your park, we log
every time we hand it out, and we'll nag you to rotate it. We cannot promise it
only opens one lot — no software can. Your door codes are different, and those we
can promise."*

---

## 4.5 Ops

### Ops cannot create a park today

I grepped for any write against `park_members` in `src/`. **Zero hits.**
Memberships are SQL-seeded. That is fine for park #1 and a hard blocker the day
he hires a manager or we sign park #2.

Parks copy the crew-invite pattern with two deliberate divergences: invites need
their own table (the membership table's primary key can't hold an unclaimed row),
and **the claim must not flip the user's role**, because a park owner must keep
`role='owner'` or his services menu renders empty with no error.

**And the ordering bug is real and blocking.** The portal router claims a crew
invite for anyone whose role isn't already vendor or ops, **on email match
alone**, and there is no park branch at all — so a park owner signing in today
lands on the booking page. A park owner who also mows his own common ground gets
flipped to `vendor`, which kills his services menu, and the role-change guard
makes it hard to undo. **The park claim must run first, and it must land before
any park is ever published.**

### What ops verifies, and the honest bar

Do not build a title check. Match the posture already settled for screening and
for the 55+ declaration: **the platform records what a human looked at and what
they decided, and never certifies the underlying fact.**

| What | The bar | Gates |
|---|---|---|
| They really own it | Assessor record, deed page, or closing statement. Ops eyeballs it and records a decision. | Publish |
| Signed platform agreement | E-signed envelope | Publish, enforced server-side |
| Park liability insurance | Certificate, expiry tracked on the existing crew-COI ladder | **Crew entry, not publish** |
| W-9 / EIN | Collected now, free; a fight in eighteen months | Remittance |

Insurance gating **crew entry rather than publication** matters: a park with a
lapsed certificate can still run its rent roll. It just can't receive a dispatched
crew.

Store the decision and the evidence pointer. **Never a derived "verified" boolean
on the park row** — that boolean is what a court reads as a certification.

### What ops watches

Reframe the board first. The current ops parks view returns lots, occupied,
vacant, pending, occupancy — **that is the park owner's dashboard rendered for the
wrong audience.** Occupancy is his number. Ops' number is **attach**: service jobs
per occupied lot per season, because attach is the only reason parks exist in this
business.

| Signal | Threshold | Action |
|---|---|---|
| No member | any | Resend, then phone |
| Invited, unclaimed | > 7 days | **Phone.** Email-credential invites die in spam and nobody reports it |
| Claimed, unpublished | > 21 days in season | Ops walks the setup with him on the phone. **Highest-ROI hour ops spends** |
| Applications aging | oldest > 72h | Nudge at 72h, ops calls at 7 days. **Ops never decides** |
| Owner gone quiet | no session in 14 days with a non-empty queue | Call; propose a manager |
| **Freeze exposure** | occupied MH lots with no protective job at T−21 | **This is the burst-pipe metric.** One tap creates the campaign |
| Attach rate | vs cohort median | Below cohort = the sales motion failed, not the software |
| Crew concentration | >60% of a park's jobs on one crew | Recruit a second before you need one |
| Insurance lapsed | expiry < today | Auto-hold new dispatch into the park |

**Two design rules for this board.** Nothing on it is green-good/red-bad **on a
person** — the queue mixes parks with tenancies with applications, and a shared
visual grammar is how a "helpful colour" leaks into a housing decision. And a
paper-preferring tenant paying on time renders exactly like everyone else, or the
churn model will flag the healthiest tenants in the portfolio.

### Support, and its limits

Ops holds the service role. **The constraint is not capability — it is discipline
plus a record. Build both.**

Ops must never be able to write a tenancy decision. Approving or declining is a
housing decision and the platform is not a party to it. Today ops *could*. Extend
the existing reservation guard to refuse a decision by anyone who is not a member
of that park — **structural, not a policy in a wiki.**

Ops must never tell the park owner what a renter paid for a service. He will ask;
it is a rule-1 question wearing a landlord's coat, and the answer is a scripted
no. Build the support view **on the same purpose-built visit view** the park
screens use, so it cannot drift when someone edits one and not the other.

**And log the looking.** There is no audit table anywhere in this codebase. Parks
is where one first earns its keep, and the first thing it should record is **an
ops user opening a support view.** The day a park owner asks *"who at LakeLife has
looked at my tenants' payment history,"* the only acceptable answer is a list.

### What breaks at twenty parks

Named now so nobody re-entrenches them. All verified by reading.

1. **The ops messages loader pulls every message ever written**, no limit, no date
   bound, grouped in JavaScript. First thing that kills the console.
2. **The lake-conditions loader does a full-table scan of `properties`** on every
   dashboard render. Parks mint a properties row per lot.
3. **The calendar loader caps at 3,000 rows and truncates silently** — no flag, no
   warning. Ops makes decisions from a calendar that quietly stopped in August.
4. **The parks loader recomputes every park's rent roll in the request**, on every
   ops page load, including ones where nobody opens the parks tab.
5. **The ops page is one all-or-nothing parallel load over 18 loaders.** Parks
   already got a defensive wrapper with the right comment — *"losing the jobs
   board over an empty parks table would be a self-inflicted outage."* **Generalise
   that precedent to all 18** and make loaders per-tab.
6. **The nightly cron is 26 sequential uncaught awaits with the digest last.** One
   park's data throwing kills route building, reminders, payouts and the digest
   **for the entire platform.** Park work gets its own cron with individually
   caught steps — and the nightly needs the same treatment first.
7. **Timezone is hardcoded in six places** and the "current day" helper has four
   independent copies. One park in Michigan's Eastern strip and every quiet-hour
   promise becomes four different claims.

---

# 5. The automation ladder and the AI fences

## 5.1 Six rungs

| | Rung | Meaning |
|---|---|---|
| **A0** | Silent | Machine acts, nobody is told. Ledger writes, derived state, audit rows |
| **A1** | Automatic + told | Machine acts and sends. Appears in a digest as a count |
| **A2** | Automatic + retractable | Machine sends; a human can pull it back inside 60 minutes |
| **A3** | Drafted, one-tap release | Machine computes and **holds** the whole consequence. One tap executes |
| **A4** | Human decides, machine executes | The human's decision is the only input; everything downstream is administration |
| **A5** | Human only, AI structurally excluded | No draft, no suggestion, no ranking, no ordering hint. Fixed templates only |

> **The rung is set by what the message DOES, not by how confident we are.**
> Confidence moves a message between *send* and *don't send*. It never moves a
> message between rungs.

Three consequence classes force a gate — and they are exactly the owner's three
words: **pricing**, **process exception**, **approval**. Any of them is **A3
minimum**, or A5 if it touches the fence.

## 5.2 The ladder, by event

**Rent and money**

| Event | Rung | Note |
|---|---|---|
| Rent due, T−3 | A1 | 9am, not 7am. 7am is a nag |
| Payment received → receipt | **A1, locked on** | A receipt is how *"I paid you"* stops becoming small claims. Never optional |
| Cash at the window | A1 | Fires off the save. The receipt card is the conversion instrument |
| Overdue, day 1..N | A2 | Five clamps, below |
| **>20% of a park's debits fail in one run** | **A5 — SEND NOTHING** | Forty of forty failing is a config error, not forty broke tenants. Hard-coded breaker, no dial |
| One payment returned (NSF) | A3 | Money, and it's embarrassing |
| Late fee assessed | A3, per assessment | Money out of a tenant's pocket per a lease term we didn't write |
| Rent increase notice | **A5** | Statutory floor from a state-rules table. AI never drafts it and never suggests a number |
| Deposit return + itemisation | A4 | The deduction is on the fence; the clock and the arithmetic are A1 |

**The five clamps on the overdue ladder** — in the send path, not in judgment:
per-tenancy grace (Larry has paid on the 12th for nine years and is fine); a
payment plan as an object that suppresses the ladder; an `estate` state that kills
every automated send for that tenancy; `office_recording_lag_days`; and a
mandatory sentence appended by the renderer, not the author: *"Reminder from
[Park] sent through LakeLife — not a legal notice."*

**Tenancy and applications**

| Event | Rung |
|---|---|
| Lease expiring T−90/60/30 | A1 |
| **Auto-renewal would cross the licence→tenancy line** | **A3** — the machine declines to take the automatic step and asks. A non-action gate is the safest kind |
| Notice to vacate received | A1 ack to renter, push to owner |
| Insurance certificate expiring | A1 chase. **Chase documents. Never chase screening** |
| Non-renewal, anything eviction-adjacent | **A5 — fence, and there is no button.** Record, notify, stop |
| Application received → ack | A1, ≤60s |
| Applicant reassurance at +2 | A1 — the message nobody sends |
| **The decision itself** | **A5 — fence, absolute** |
| Decline message | **A5 — fixed text** |
| Adverse-action notice | **A5 — sends as part of recording the decision** |

**Service and crew**

| Event | Rung |
|---|---|
| Booking confirmed, crew assigned | A1 (exists) |
| **Crew dispatched / en route** | A1 — the missing send path |
| Job complete + photos | A1. **Push the after-photos as the deliverable, not as evidence** |
| Park-funded job complete | A1 to each renter; **digest to the park owner.** Twelve texts to one man is spam |
| `approval`-tier park work | A3, **dispatch pre-solved** |
| `notice`-tier park work | A1 FYI — never blocks |
| Emergency maintenance | A1, **bypasses quiet hours**, re-push at 2h, **ops paged at 4h** |
| Protective job unfilled, each rung | A1; the T−24 rung is **a page to a human with a phone number** |
| **Auto-cancel a protective job** | **Forbidden, enforced by database trigger** |
| Any price change | A3. The machine may **offer** within the cap. It may never charge |

## 5.3 The one-tap card contract

Six lines, in this order, always:

```
WHO + WHERE      LOT 34 · Sarah K.
WHAT             Skirting repair — south and west panels
WHO'S DOING IT   Miller's Grounds & Docks · Thu Oct 9, morning
THE MONEY        Sarah pays. Nothing due from the park.
THE VERBS        [ Approve ]   [ Not this ]   [ Ask a question ]
WHAT HAPPENS     Approving books it and tells everyone. Nothing else changes.
```

**Line 4 is non-negotiable. Every card names who pays, even when the answer is
nobody.** It is the first question a landlord asks, and answering it before he
asks is most of what "seamless" means.

**Line 6 is the one everyone skips.** A tap whose consequence isn't stated is a
tap people don't make.

**The three verbs never change, anywhere.** *Ask a question* is why people trust
the other two — and it opens a **drafted** message, never a blank box. A blank box
is where a park owner writes something his attorney wishes he hadn't.

**And the rule that makes it seconds rather than minutes:**

> **Never render an approve button whose consequence you have not already computed
> and held.**

Run the dispatch decision and hold the winner **before** drawing the card. The tap
is one guarded transaction, not the start of one. If the held crew went stale, the
action re-solves inside the same transaction and lands on the next best — **the
button never fails**, and the confirmation names whoever it actually is. If
nothing wins at draft time, **the Approve button is never drawn**; the card offers
the first date we can genuinely cover, or says we don't have coverage yet.

**Expiry is never an implied yes.** A landlord's permission cannot be inferred
from silence. The hold releases, both sides are told honestly, the item returns to
the queue.

**Batching:** cards debounce per approver per park per day into a stack. One push
— *"3 things need you"* — then swipe. **A one-tap card that arrives twelve times
is a form.**

**The health metric for this whole surface is median tap latency.** Target under
five minutes. If it climbs, **the cards got harder, not the owner slower.**

## 5.4 The AI fence — what it must hold, and where it currently doesn't

The AI must never touch: a housing application decision or its reasoning, an
adverse-action notice, a decline, a legal notice, anything eviction-adjacent, or a
deposit-deduction justification.

**What is genuinely good today.** The context builders carry a header saying rule
1 is enforced structurally, not by prompt — and it's true: the customer context
selects the customer price and never the crew cost or margin; the crew context
selects the crew's own payouts and never a customer price. A pure keyword risk
screen runs with **no model call** before anything else. The auto-send path has
five real gates. And the model chokepoint is imported by exactly **two** modules,
so an allowlist test is cheap and would work.

**Two holes, both verified, both serious.**

**Hole 1 — the raw thread defeats the column-selection layer.** The draft function
interpolates the last six messages of **verbatim user text** straight into the
prompt, alongside the sanitised context. The proposed "AI never reads a housing
record" layer governs the *structured* half only. If the renter typed *"I'm 45
days behind and my landlord says I have to be out by the 1st,"* the model reads
it. **Column selection cannot fence content the customer supplies.**

Fix: the thread passes the same risk screen the inbound message does,
message-by-message, before it enters the prompt.

**Hole 2 — the risk screen has no housing vocabulary at all.** I read it. Twenty
substrings: refund, money, charge, angry, terrible, lawyer, attorney, sue, damage,
broke, cancel, complaint, dispute, waive, free, credit, promise, discount, owed,
bill.

**Absent:** evict, lease, rent, deposit, notice, quit, landlord, tenant, lockout,
disability, wheelchair, accommodation, service animal, discriminate, familial,
Section 8, voucher, HUD, fair housing, habitability, mold, heat, retaliate,
harass, died, passed away, funeral.

**The concrete failure.** A renter texts *"Can I get a ramp put in? I use a
wheelchair."* No substring matches. The screen passes it. It classifies as a
schedule question with high confidence. All five auto-send gates pass. A reply is
inserted **in LakeLife's voice, under an ops user id, timestamped.** That is a
reasonable-accommodation request under the Fair Housing Act, answered by a model,
with a record.

**And the screen fails in the wrong direction for a park.** `"free"` matches
`"freeze"` — the code comment already acknowledges it. So in a mobile-home park
the screen **blocks** the winterization questions (the safe, high-value ones) and
**passes** the housing ones.

Fix, and it is small: extend the list in the same commit that ships the first park
renter, and change `"free"` to `"free "` so `"freeze"` stops tripping it.

**Hole 3 — the auto-reply dial has no audience.** It is one global boolean,
**defaulting to on.** The moment an API key lands in the environment, auto-reply
is live for park renters and lake homeowners simultaneously, with no way to enable
one and not the other. Split it, and **default the park one to off.**

## 5.5 The five fence layers, ranked by what they actually buy

| Layer | What it is | Verdict |
|---|---|---|
| **1** | Every model call takes a `purpose` from a short list defined in the chokepoint file, plus a repo test asserting only sanctioned modules call it | **Good, cheap, ship it.** Doesn't stop holes 1 or 2 — both are legitimately-purposed calls |
| **2** | Legal notices live in a **pure module that cannot import the model**, checked transitively — and **the renderers take no free text at all** | **The strongest idea in the set.** There is no `reason` parameter and no `note` parameter. A field that does not exist cannot be filled by a model, by a park owner, or by a future ops feature |
| **3** | A **database trigger** refusing AI authorship on fenced message kinds, plus a constraint that a housing decision's reason must be a human-chosen code with no column that can hold prose | **The only layer that survives a rewrite in another language.** Worth the migration |
| **4** | The extended risk vocabulary, running on raw text **before** any context is built | **The load-bearing one, and every design sized it as an afterthought.** A risky message never becomes a model call at all — there is no prompt to jailbreak, because there is no prompt |
| **5** | Park renter context, column-selected, structurally blind to application status, screening state, delinquency, balance, lease state and the grandfathered marker | **Necessary but insufficient** on its own (hole 1) |

**Why layer 5's specific column list.** A drafting model that can see *"declined
last year"* or *"45 days behind"* will **inflect** — warmer to one, cooler to the
other. That inflection is a housing decision, made by a model, delivered in tone,
**with no record and no way to detect it.** The fix is the same as rule 1's: don't
give it the column.

**The fence in one sentence, for the migration header:**

> **The model may draft a SERVICE conversation with a person. It may never draft a
> HOUSING one.** The line is held by which function you can call, which module may
> import which, which columns the context builder selects, and what the database
> will accept — in that order, four times, so that breaking one still leaves
> three.

## 5.6 Measurement — and the counter-metric for each

**The trap: measuring automation by volume automated. That number goes up when the
machine is annoying people.**

| Is it working? | Is it quietly annoying people? |
|---|---|
| Auto-resolution rate — handled with no human touch **and no follow-up in 72h** | **Messages per person per week, p95** (not the mean — the mean hides the person getting fourteen). Alarm above 6/week |
| Median one-tap latency, target <5 min | **Opt-out rate per message KIND.** Any kind above 2% lifetime gets pulled |
| **Dispatch-solved-before-ask rate, target 95%+** | Reply-with-a-question rate after an automated message |
| | **Read-but-no-action on one-tap cards** — the token pattern gives this free |
| | **Dead threads** — no message either way for >48h. Silence is the only real failure mode |

**Fence telemetry:** any database-refused authorship is a **P1, not a metric** —
it means code exists that tried. Adverse-action notices queued must equal
decisions recorded, always, by construction; a gap is an incident. And ops reads
**ten random auto-sent replies a week** as a ritual, plus a quarterly audit where
a human reads fifty messages the screen let through and marks any that should have
stopped. **That number is the only honest measure of the screen.**

**The truest metric of "we take care of you":** the **"did you have to ask?"
rate** — the share of jobs where the customer sent a status question *before* we
told them. Target under 5%. It counts the times the customer had to hold the
uncertainty themselves, which is the exact definition of *ordered* rather than
*taken care of*.

**The one line he sees weekly:**

```
This week: 412 messages sent · 3 people asked us something we should
have told them first · 1 opt-out · 11 cards needed you, median tap
2m 40s · 0 fence trips
```

---

# 6. The integration map

Ranked by how much cannot proceed until it exists. **Every one goes behind a port
we own, and every port ships a mock as the default implementation** — which is not
new discipline, it is exactly what the existing payments module already does, and
it is the only reason this module can be built to completion before a single key
arrives.

**Three ports carry policy in their type signature, not in a comment.** The
screening port **has no method that returns a result.** The money port **has no
balance and no stored-value hold** — that is what turns a payment processor into a
money transmitter, and it gets built by accident because it is convenient. The
metering port **has no set-rate method** — the rate is derived from the master
bill, which makes markup structurally impossible.

| # | Capability | Vendor | Build/Buy | Effort | Blocks |
|---|---|---|---|---|---|
| 1 | Document custody + erase | none | **build** | 1–2 wks | **the tenant import**, every upload |
| 2 | Card + preauth/capture | **Helcim** | buy behind port | 3–4 wks | short-stay booking, the commit hold |
| 3 | E-signature | none now, BoldSign later | **build** | 1–2 wks | agreements |
| 4 | Screening | **TransUnion SmartMove** | deep link | days | applications |
| 5 | ACH | **Helcim** | buy behind port | 6+ wks (days for the shape) | all of phase 3 |
| 6 | A2P campaign | Twilio | register | days + **10–15 day wait** | every park SMS |
| 7 | Weather alerts | api.weather.gov | **build** | days | the protective ladder's event rail |
| 8 | Insurance certificates | none | **build** | days | crew entry |
| 9 | Accounting | QuickBooks | **export only** | days | the tax report |
| 10 | Cash at retail | PayNearMe | **hook now, defer** | days now / weeks later | nothing |
| 11 | Bank verification | Plaid | defer | — | nothing |
| 12 | Identity verification | — | **never, this phase** | — | — |
| 13 | Utility submetering | — | **never buy** | — | phase 3+ |

### The reasoning that matters

**Document erasure is first because it is a legal precondition, not a feature.** I
grepped for any storage-delete call in `src/`. **Zero hits.** The tenant import is
the first time this platform collects personal data about people who have never
agreed to anything with us, and today there is no path to delete it.

**Screening is a deep link, not an API, and that is the cheap answer *and* the
correct one.** With SmartMove the **landlord** is the account holder; the applicant
identity-authenticates with TransUnion and pushes the report to the landlord they
permissioned `[confirmed]`. That is not a limitation we work around — **it is
precisely the architecture already chosen.** Integrate a screening API instead and
the consumer report lands on *our* servers, and we have FCRA data in our
infrastructure, permissible-purpose obligations, retention rules and dispute
handling — a very short walk to being treated as a Consumer Reporting Agency.
RentPrep publishes exactly such an API and resells TransUnion reports through it
`[secondary]`. **Do not.** Findigs markets automatic yes/no rental decisioning
`[secondary]` — worth knowing it exists so nobody mistakes it for a shortcut.

**E-signature: build the signer, buy a certificate later.** We already have to
build a per-record signer. With an evidence ledger, a timestamp, IP capture, an
SMS-verified identity and an immutable text-plus-hash snapshot, we have a valid
execution of an agreement on our own paper. **Buy a vendor when a *third party*
must trust the audit trail** — a lender, an insurer, an acquirer's diligence team.
BoldSign on cost, Anvil for merge-heavy leases, DocuSign purely for the name an
attorney recognises `[all pricing unverified, secondary sources]`.

**Cash at retail: build the hook now, defer the rail.** One park with maybe 15–20
non-digital payers and $6–8k/month of paper volume is a rounding error to
PayNearMe or Zego, and **nobody could confirm any of them will onboard a
single-park operator** `[unverified]`. Meanwhile the window screen captures 100%
of those tenants on day one with zero integration.

Three things to build now because they cost nothing and prevent a re-architecture:

1. **A permanent, human-readable, check-digited `pay_code`** — `PRTY-7K3M-4`. It
   identifies **the file, not the lot** (a tenant who moves lots mid-year must not
   split her payment history at a retail counter). The check digit is two lines
   and prevents a mistyped code crediting a *different tenant's* rent. Five
   surfaces — statement, mailed letter, spoken at the window, a money order's memo
   line, and later a barcode — **zero migrations.**
2. **`source` as an adapter dimension**, distinct from `method`, so a rail is a new
   value rather than a schema change.
3. **Three timestamps** — received, posted, settled. Every retail rail lags. With
   one timestamp you either lie to the tenant ("paid!") or lie to the owner
   ("collected!"). **And the overdue ladder reads `received_at`** — the single line
   that prevents a "you're overdue" text to someone who paid cash at Dollar
   General yesterday.

**The cheaper interim that ships immediately: a check and money-order scanner with
remote deposit capture at the office**, about $300. Scan, post, text the receipt,
deposit reaches the bank without a trip. That makes the *office* paperless
regardless of any tenant behaviour. **Confirm with his bank that its RDC product
accepts money orders** — policies vary.

**Twilio A2P is a launch gate, not a config step.** Campaign reviews were running
**10–15 days** `[confirmed, Twilio changelog]`, and API-registered campaigns now
require privacy-policy and terms URLs. **The terms rewrite that phase 3 is already
blocked on is therefore also blocking SMS registration. Two blockers, one artifact
— register the week the terms work starts.** And separately: an overdue-rent text
is arguably a debt-collection communication. Those templates go to counsel with
the terms; they are not written by whoever builds the cron.

---

# 7. Onboarding Pretty Lake: the 90-day plan

Each phase says what **he** does, what the **product** must already do, and what
done looks like. The plan is only real if the software exists when he needs it.

### T−30 → T−0 · Before closing

**He:** pulls the rent roll, all agreements, the deposit schedule and **12 months
of bank deposits**, and reconciles roll against deposits (assume 10–20% inflation
until proven). Walks every lot and photographs every home, noting homes with no
roll entry and roll entries with no home. Gets the tenancy-confirmation packet to
counsel **now** — it is 1–3 weeks of elapsed time and it blocks weeks 3–5. Orders
a card reader and a check scanner. Nails down three closing-day cash questions:
rent the seller collected for the closing month, whether deposit cash actually
transfers, and the 60–90 days of rent that will keep arriving at the seller's
address.

**Product:** park created, dark. Lots generated by range. Rates bulk-applied with
exceptions — because what he will actually say is *"they're all $385, except 12,
34 and 51, who have been here forever."* Rent roll imported from the seller's
paperwork. **Zero tenant involvement.**

**Done:** he opens the app on closing morning and sees his park, with provenance
on every number.

**Cutover is the 1st of a month. Non-negotiable.** Mid-month doubles the
reconciliation and destroys his trust in the numbers in week one.

### Week 1 · Trust, and only trust

**Day 1: a mailed paper letter, USPS, before any text or email.** This is not
sentiment. **A text message telling people to send rent somewhere new is
indistinguishable from the most common rental scam in America**, and his most
cautious tenants are right to ignore it. Paper first, always.

Contents: his photo, a local phone number, *"nothing about your arrangement is
changing,"* exactly where and how to pay this month, **"cash and money orders are
still accepted at the office"** said loudly, office hours, and an invitation to
come say hello. Quietly at the bottom: the claim code and the pay code.

**Do not announce** rent increases, new rules, insurance requirements or a payment
mandate in this letter. One message: nothing bad is happening.

**Saturday: the window is open and he is physically there.** Every payment gets a
printed and texted receipt.

**Watch:** how many people show up. That is his real engagement number, and it
predicts everything after.

### Week 2 · Take the money the way they already pay it

The 1st is the volume spike. Card reader arrives — anyone with a money order hears
*"card's fine too, if it's easier."* Verified-mobile capture runs off the back of
every receipt.

**Watch: operator-paperless should hit 100% this week.** If anything is still in
the notebook, find out why now, not in month three.

### Weeks 3–5 · Tenancy confirmation appointments

Fifteen minutes each, at the window or at their door, iPad in hand. About 20/week
is comfortable; 79 tenants is four weeks.

Four jobs at once: papers the tenancy, corrects the data, captures **written
consent to text** (the TCPA evidence), and ends with *"want me to set up autopay
while I've got you?"*

**And four questions asked every single time**, because they replace guesses with
facts: has a smartphone (y/n) · reads email (y/n) · current payment method · has a
family member who helps with bills. **By day 30 he knows the real numbers for his
park, and we know them for the pitch to park #2.**

**Expect 10–20% of rents to come back wrong.** That is the point of the exercise,
not a failure of the import.

**Day-30 targets:** 100% of lots carry a renter row with a rent and a due day ·
100% of money received is on the ledger with a receipt · 60%+ signed confirmations
· ~45% verified mobile.

### Weeks 6–8 · Make digital the easy path

Reminders on — escalating, gentle, informational, every one carrying *"This is a
reminder from [Park] sent through LakeLife. It is not a legal notice."*

**Launch the paperless credit: $5/month off lot rent for autopay.** A credit, never
a fee, announced with the statutory notice period observed. **He absorbs the ACH
fee** (Decision 3).

**And the helper conversation for the over-75s** — *"does your daughter help with
your bills? I can set her up to see the balance and pay."* Scoped, revocable,
evidenced, never a shared password. **This will convert more elderly tenants than
any incentive**, and nobody in either market builds it.

**Watch: autopay enrolments.** Not "paid online." A one-off card payment is a
transaction; autopay is a conversion.

### Weeks 9–10 · The first service — and this is the actual business

The first cross-sell lands **here**, not earlier. A tenant's first experience of
*"LakeLife takes care of you"* must be **someone showing up and doing work**, not a
payment portal.

And the right first service is not a mow. It is **the fall protective portfolio,
sold to him** (Decision 4).

**Build gate, and it is hard:** mobile-home winterization must exist as a real
service row with a unit-type pricing field. It doesn't today — verified, `services`
has no unit-type dimension at all. And **the crews must be contracted before the
offer renders.**

### Weeks 11–13 · Consolidate, then stop pushing

Report **two metrics separately**: operator-paperless (100%) and tenant-digital
(expect 45–65%). Build the permanent paper lane properly — a monthly printable
notice sheet, mailed statements with the pay code, published office hours.

**Then stop. Hard cap of three conversion nudges per tenant, ever.** Non-response
is an answer. A conversion campaign that never stops is how a new park owner
becomes the villain, and those people talk at the mailboxes.

**Now — and only now — count the tenants who genuinely need a retail cash rail.**
You will finally know the number instead of guessing, and that number is what you
take to a PayNearMe rep.

**Week 13, hand him two documents:**

The **aged collections report** (0–30 / 31–60 / 61–90 by lot) with a benchmark
line — chronic delinquency above 8–10% is the industry's bad-management flag
`[unverified, secondary]`. It is the report his lender and his eventual buyer will
both ask for, and handing it to him unprompted is how he starts thinking of us as
his operating system rather than his rent app.

And the **dark-lot tile**: *"3 lots out of service · 214 days · about $18,000 to
get them back."* That is the number that finally makes him spend $6,000 on a
demolition, and the number every competitor's occupancy math hides.

**The sentence that sells park #2:**

> **79 sitting tenants, on a rent roll he'd bet money on, in 90 days — and not one
> of them had to download anything.**

### The honest conversion curve

Every adoption figure in the research is multifamily, which skews younger, more
urban and more banked. **There is no MHC-specific study in public.** Discounted for
a rural northern-Indiana park with a long-tenured elderly base:

| | Day 30 | Day 90 | Month 12 |
|---|---|---|---|
| **Operator-paperless** | **100%** | 100% | 100% |
| Verified mobile, no account | 45% | 70% | 80% |
| Claimed app account | 15% | 30% | 40% |
| **Monthly active app users** | — | — | **10–20%** |
| Any electronic payment | 20% | 45% | 60% |
| **Autopay** | 5% | 25% | **40%** |
| **Permanent paper lane** | — | — | **25–35%** |

**Label these as assumptions in every document.** The week 3–5 appointments are
the instrument that replaces them with facts.

---

# 8. What we deliberately do not build

Each is a thing somebody will propose, with the reason it is refused.

| Not built | Why |
|---|---|
| **A treasury or bank rail** (Increase, Column, Modern Treasury, Dwolla, Moov) | Every one exists to let you hold and move other people's money. The agent-of-payee exemption is real but is a legal opinion you buy per state. **Sub-merchant settlement makes the question moot instead of arguable. Take the moot.** |
| **A screening API that delivers a report to our servers** | The FCRA tripwire. The handoff is days; the API is weeks plus a compliance programme |
| **A COI compliance platform** (Jones, myCOI) | We wrote it once for crews. Buying it again is a five-figure annual line item replacing forty lines of code. The one thing they do that we can't — phone the carrier to verify the certificate is real — **we note as a known gap and accept. Nobody at this scale verifies** |
| **A utility-billing service** (Conservice, Livable, Zego Utility) | None publishes an API. They are service businesses with a portal. Bill-back is a charge line with an allocation method and a photo of a meter |
| **RUBS (ratio utility billing)** | Submetering is the safe harbour; RUBS is the liability. Regulatory direction of travel is unambiguous `[all citations secondary and individually unverified]`. Ship submetered and flat only |
| **OTA / marketplace listing integration** | Rent is a zero-margin pass-through. **An OTA commission is a commission on money we already decided not to earn**, paid to a competitor forever, for the guest relationship that is why we're in the park. Do structured data, a Google Business Profile field, manual free listings, and the lake pages instead |
| **Identity verification** (Persona, Veriff) | At 80 lots with a park owner who knows every tenant by name, **the office window is the identity verification** |
| **Crew GPS tracking** | Crews are the scarce side. A deliberate one-tap "on my way" buys the customer-facing 90% with none of the labour-relations cost |
| **A review system** | Two questions: a thumb and an optional box. Thumbs-down goes to the park owner privately with the lot number — **a bad-site report is operational information, not content.** Thumbs-up gets one ask for a Google review. That is our whole OTA strategy and it costs one SMS |
| **A report builder** | He will never build a report. Four artifacts exist because somebody *outside* the park asks for them: the rent roll, aged collections, occupancy with dark lots **in the denominator**, and the rent/service tax split |
| **A general ledger, or a two-way accounting sync** | An accountant's decision, not a developer's. Getting deposits-as-liability wrong overstates his taxable income — a phone call from his CPA and a permanent trust loss. Export first |
| **OCR of a notebook page into the database** | Not because AI is forbidden — a rent roll is not a housing decision — but because the failure mode is **a silently mistyped rent amount that looks authoritative.** Build "attach the page" instead: the photo pins beside the form while he types |
| **A clubhouse payment kiosk** | Hardware, PCI scope, jams, support, at 60 lots. **His phone with a card reader is the kiosk, and it walks to them** |
| **Auto-shuffling reservations to close gaps** | We never move anybody automatically. Steal the *mechanism* — a nightly gap query ranked by length × rate × urgency — and surface three suggestions with one tap. Never a lot with a structure, a lease, or one the tenant chose |
| **Dragging a lease on a calendar** | A lease is not a drag gesture. Moving a tenant with a signed agreement closes one charge schedule and opens another, atomically |
| **Eighty copies of the gate code** | Eighty ciphertexts, eighty rotation points, one stale copy that keeps working forever |
| **Any path from tenancy or money state to a gate code** | Unlawful self-help eviction, essentially everywhere. Asserted by post-condition |
| **Crew visibility into rent, balance or lease state** | The crew is not a collections agent |
| **Auto-ending a lease at its end date** | A licence hitting its end date writes *awaiting departure*, not *ended*. A human confirms the person and their property are physically gone before a lot is vacant or listable. **Auto-ending records a termination with no notice and then advertises their home** |
| **Conflating no-show with cancellation** | Firefly refuses to and so do we. A no-show is an observation; cancellation is a financial decision. Same class of error as the freeze cancel |
| **Credit-bureau furnishing** | It makes us a *furnisher* with FCRA duties. **But put the promise in the design now** — *"pay your lot rent on autopay and it builds your credit, free"* is the most persuasive sentence available to an eleven-year money-order payer — so the ledger already captures what a partner would need. Partner, opt-in, positive-only, counsel first |
| **A second implementation of anything, for any park** | Configuration on the same code path behind a per-park dial. **Never a branch** |

---

# 9. The build sequence

Sizes are honest. **S** = days. **M** = one to two weeks. **L** = three to six
weeks. **XL** = its own risk. **★** = a hard external gate.

## Phase 0 — this week, blocked on nobody

Correct with or without parks. Three of these are live defects.

| | Size |
|---|---|
| `services.criticality` + the protective-cancel database trigger (§3.1) | S |
| The en-route text three surfaces already promise (§3.2) | S |
| `revoke select on park_lots/parks/lot_rates from anon` + `and active` (§3.3) | S |
| The park branch in the portal router, **before** the crew claim | S |
| `.select("id")` and fail-closed on every guarded park status flip; role gate on ending a tenancy | S |
| Extend the risk vocabulary; fix `"free"` → `"free "`; split the auto-reply dial and default park off (§5.4) | S |
| One exported timezone-aware "today" and "current hour"; delete the four copies | S |
| A per-message-kind notification gate. **Every operational message on this platform sends unconditionally today. Do not add a ninth ungated sender** | M |
| The `summarise()` denominator (§4.1) | S |
| Correct the hardcoded "30% platform margin" pill on the ops header — it renders on the screen you demo to a prospective park owner, and the actual floor is 20% | S |
| **Local persistence layer** — offline queue, background sync (§3.5) | L |

**Unlocks:** nothing commercially. **Prevents:** a burst pipe, a public data leak,
a park owner locked out of his own services menu, a fair-housing reply written by
a model, and a window screen that silently fails while a tenant stands there with
cash.

## Phase 2a — THE RECORD. Nothing required of a single tenant.

**This is the week-one win and the phase he should judge us on.** Roughly **six to
eight weeks** after Phase 0.

**Ships:** document custody + erase · `park_renters` with the pointer swap, the
guard rewrites and provenance · **the `properties.owner_id` resolution** (§3.4) ·
lot generator + bulk rates + the paste importer with the three-column reconcile ·
**the window** with receipts, one-hour void, `instrument_ref` dedupe and
disbursements · the rebuilt Today screen · per-tenancy grace, payment plans, the
one-tap pause, the `estate` state, the recording-lag clamp · maintenance requests
with the QR pedestal sticker and the pre-solved one-tap escalation · park invites,
verifications, the audit table, the four publish locks · a **separate parks cron**
with individually caught steps.

**Unlocks:** a rent roll he would bet on, on closing morning. A delinquency list
that is **complete because it accepts cash.** A maintenance queue that is also the
service-discovery mechanism.

**Blocked on him:** the seller's rent roll. His bank confirming RDC accepts money
orders. A card reader and a check scanner.
**Blocked on counsel:** the privacy sentence on the import screen; the
tenancy-confirmation instrument (start it in week one — it gates 2c).

## Phase 2b — THE WORK

**Roughly four to six weeks.** This is where the revenue is.

**Ships:** mobile-home winterization and the other park service rows, plus the
four unit-type profile fields · `park_campaigns` — sell the block, don't book the
lot · the crew Run with lot-as-address, walk order, run-mode camera and the
run-closing reconcile · the drive-overhead threading and the routing fixes ·
**the protective escalation ladder** · run-aware no-show carve-out · the
capability gate on ops manual dispatch · Helcim card behind the money port.

**Unlocks:** the portfolio sale. 41 homes, one order, one dense route, tenant pays
nothing and taps once.

**Blocked on him:** ★ the Helcim merchant application and the six written answers
(Decision 6). Everything else in 2b builds against the mock.
**Blocked on us:** ★ **contracted crew capacity for 120% of the offered lots.**
This is the gate, and it is a recruiting problem, not a software one.
**Blocked on Twilio:** ★ A2P campaign registration, 10–15 days.

## Phase 2c — AGREEMENTS

**Roughly four weeks, but the attorney is the critical path.**

**Ships:** lease and confirmation templates with the counsel-attestation gate · the
signing flow · **the wet-ink path producing the identical record** · the three
separate instruments with their notice clocks in database checks · the correction
queue · renter documents and the insurance ladder.

**Blocked on him:** ★ **his attorney producing lease text — 1 to 3 weeks of
elapsed time that blocks all compliance value. This is the single longest lead
item in the plan and it must start in phase 2a week one.**

## Season two — everything cut from Decision 1

Applications and screening. The public page, the reservation grid and the gap
texts. Deposits and their clocks. The renter portal and the conversion ladder.
ACH, autopay and remittance. The scale fixes before park #3.

**Each earns entry by evidence, not by plan:**
- He used the window twelve Saturdays running → build the charge ledger and
  autopay.
- Tenants asked for texted receipts unprompted → build the conversion ladder.
- Maintenance calls to his cell annoyed him → the requests queue already shipped;
  now build the renter side of it.
- He asked to fill a lot → build applications.
- **Park #2 signed** → build the invite writer, the park switcher, and the ops
  lifecycle board.

## Before the switch is ever flipped

Run a **simulated season**, not just unit tests. The storage product was built,
switched off, and had four real bugs waiting in it when the simulation finally ran.

The park simulation must cover: a renter-owned home on an auto-renewing lease · a
park-owned home on weekly stays with no lease · a document expiring mid-season ·
**a renter who deletes their account** · a tenancy stacking past the threshold · an
abandoned home · **a protective job that reaches its date unfilled** · **a park run
where the crew loses signal at stop 7** · and **a tenant who pays cash at the
window on Saturday and is not entered until Monday.**

The last three are new, and they are the three that decide whether he is still
using this in year three.

---

# Appendix A — Schema changes, in dependency order

*Technical section. Each migration follows the shipped discipline: revoke client
writes including TRUNCATE, explicit anon revokes, definer helpers rather than
cross-table policy subqueries, guards that fire on the transition, and a closing
post-condition block that **asserts what was built** rather than trusting the
absence of an error.*

| # | Migration | Contents | Destructive | Gates publish |
|---|---|---|---|---|
| **0053** | Platform safety | `services.criticality`, `season_anchor`, `season_offset_days`; `jobs.cancel_reason`, `dispatched_at`, `en_route_at`; the protective-cancel trigger; **the anon revokes on `park_lots`/`parks`/`lot_rates` and the `active` filter** | No | No — ship immediately |
| **0054** | Documents & evidence | envelopes, signatures, access log, erasure log; envelope kind allowlist | No | **Yes** |
| **0055** | `park_renters` + pointer swap | the renter file (identity, **three phone columns**, split operational/marketing consent, `pay_code`, conversion state, claim credentials); append-only claim log; helper relationships; `park_renter_id NOT NULL` on reservations and units; **rewrite both existing reservation guards to key on `park_renter_id`**; **drop `renter_user_id` and rewrite the read policy through a definer helper** | **Yes** — drops a NOT NULL and removes a column | **Yes** |
| **0056** | Job attribution | **`jobs.billed_to_user_id` + `jobs.occupant_user_id`**, both snapshotted at insert; re-key the six `owner_id` base-table policies, the customer job view and the AI context builder for lot properties; `deleteAccount` refusal | No | **Yes** |
| **0057** | Park inventory truth | structures + the second exclusion constraint; lot service state, out-of-service reason, `route_seq`, coordinates; park timezone, state, freeze date, quiet hours, crew rules, `office_recording_lag_days`, park-level gate code + rotation | No | **Yes** |
| **0058** | Import & provenance | import sessions and rows; **`source` provenance columns on every grandfathered field**; reservation `origin` + the check constraint that a grandfathered tenancy cannot carry a decision | No | **Yes** |
| **0059** | Park money ledger | charges, charge-type allowlist, payments (`method` × **`source`** × `external_ref` × **three timestamps** × **`instrument_ref` with a partial unique index**), append-only allocations, gapless per-park receipt sequence, **`park_disbursements`**, deposits with unknown custody by default | No | **Yes** |
| **0060** | Requests & approvals | maintenance requests; job approvals with a held vendor, rate and expiry; entry consents; standing permissions; `services.park_permission`, `entry_required`, `park_visit_category`, `photo_slots`; `job_photos.slot` | No | No |
| **0061** | Ops onboarding & audit | park invites (unique partial index on lowercased email where unclaimed); verifications storing **a decision and an evidence pointer, never a derived boolean**; **`park_audit`**; gate-code disclosure log | No | **Yes** |
| **0062** | Park agreements | confirmation and rules-acknowledgment envelope kinds; papered state; **the trigger forbidding a confirmation signature from writing rate, term or date columns in the same transaction**; requirement `applies_from` + grandfathered exemption; the notice-period database check | No | No |
| **0063** | Applications | published criteria codes + version snapshot; screening orders **with no result column of any kind**; the adverse-action queue | No | No |
| **0064** | Rent rails | ACH mandates as immutable authorisation artifacts (the exact text shown, timestamp and IP — **never a boolean**); autopay schedules; remittances; the mass-failure breaker | No | No |

### Three post-conditions worth naming separately

**1. The person-anchor assertion — and the correction to how it was written.** The
proposed version scanned `information_schema` for tables matching `park_%`. **The
two tables carrying `renter_user_id` are `lot_reservations` and `renter_units` —
neither matches that pattern.** The assertion would have passed on a database that
violates the invariant, in exactly the case it was written for. **Match on the
column name, not the table name**: any table with a `renter_user_id`,
`payer_user_id` or `occupant_user_id` must also carry a `NOT NULL park_renter_id`.
That predicate catches `park_inspections` in six months *and* the two tables that
exist today.

**2. The wall assertion.** Zero foreign keys from any `park_*` table into invoices,
jobs or payouts — plus a repo test that no module importing the refund engine
imports a rent module. Rent must never acquire an invoice shape, and the reason is
stronger than any design stated: the shipped uniqueness constraint permits
**exactly one captured payment per invoice, forever**, so a partial rent payment is
structurally unrepresentable in that model.

**3. The gate-code isolation assertion.** The rotation module does not import
tenancy state or money state.

### The sequencing trap that will bite

`park_renter_id NOT NULL` landing while the application server action still inserts
without it means **every application 500s** the moment the migration reaches
production ahead of the deploy. Ship it **nullable**, backfill, flip to NOT NULL in
a later migration after the code is live. And guard every `drop constraint` with
`if exists` — every drop in the shipped set already is, and the header of `0002`
explains why the hard way.

---

# Appendix B — New service rows

*Technical section. All pricing lives in the database, per rule 8.*

**Three prerequisites first.** `property_profile` gains `unit_kind`,
`unit_length_ft`, `golf_carts` and `skirting_panels`, populated from the park
structure when a lot's property row is minted. **This requires zero change to the
pricing engine**, because the per-section model already reads a count field from
the profile. Plus `services.park_permission`, `services.criticality`, and
`services.photo_slots`.

| # | Name | Model | Price | Photos | Min | Permission | Criticality |
|---|---|---|---|---|---|---|---|
| 1 | **Mobile home winterization** | flat | 395 | **4** | 75 | none | **protective** |
| 2 | **Spring de-winterize & water-on** | flat | 295 | 3 | 60 | none | seasonal |
| 3 | **Golf cart winterize (on lot)** | per_section | 285/cart | 3 | 40 | none | discretionary |
| 4 | **Skirting repair (panels)** | per_section | 95 + 55/panel | 3 | 60 | **notice** | **protective** |
| 5 | **Skirting replacement (perimeter)** | per_foot | 150 + 18/ft | 4 | 240 | **approval** | discretionary |
| 6 | **Heat tape install / test / replace** | flat | 185 | 3 | 45 | none | **protective** |
| 7 | **Tie-down / anchor inspection** | flat | 145 | **4** | 45 | notice | seasonal |
| 8 | **Park-home turnover clean** | sqft_band | 135/175/215 | **6** | 150 | **park_only** | discretionary |
| 9 | **Lot mowing (park)** | band | 45/55/70 | 1 | 20 | notice | discretionary |

**Notes that matter more than the numbers.**

**#1 needs a variant, not a second service.** Use the existing frequency slot:
*"Vacant — drain down"* and *"Occupied — freeze-proofing."* These are different
jobs. A vacant home gets lines blown and the shutoff tagged; an occupied home gets
heat tape, skirting closed, and the tenant coached. Required photo slots: lot
marker · shutoff off and tagged · lines open with the heat-tape indicator lit ·
exterior after.

**#1 and #2 are one relationship, sold as a pair**, using the existing job-group
machinery that already handles multi-leg storage packages. **Do not invent a second
bundling concept.**

**#3 is on-lot only in season one.** The moment a cart *leaves*, it is custody —
garagekeepers insurance, storage stays, the whole bailee gate. Do not drag that in
for a $285 job.

**#4 versus #5 is the permission line drawn correctly.** Repairing panels keeps
water lines from freezing — protective, notice tier. Replacing a perimeter changes
the home's appearance and is governed by park rules on material and colour —
approval tier.

**#6 is the highest-conscience row in the catalogue.** Overlapped heat tape causes
fires. Two required photo slots: the full run, unoverlapped; and the plugged
indicator, lit. Gate it by capability — only crews carrying an electrical service
tag hold the rate card. **This needs no new mechanism**; capability is already a
service-type match.

**#7's output is a finding, not a repair.** Route it through the existing flag
mechanism: the crew proposes, nothing bills until the homeowner approves, and
approval reprices atomically. **Do not build an inspection module.**

**The four permission tiers**, on `services.park_permission`:

| Value | Meaning | What the renter sees |
|---|---|---|
| `none` | inside their home, or their own chattel | **nothing.** No badge. A badge on every card teaches people not to read badges |
| `notice` | on the lot, reversible, no ground disturbance | *"We'll let Pretty Lake Estates know."* **Never blocks** |
| `approval` | ground disturbance, anything attached, anything on park infrastructure | *"Pretty Lake Estates approves this one first"* |
| `park_only` | not the renter's asset at all — sewer riser, road, common trees | *"Your park handles this — we'll pass it along."* Becomes a maintenance request |

**Permission legibility goes above the price, always.** Discovering a landlord veto
at checkout is the worst possible moment, and it is the failure mode every
resident-services product in the research has.

**And a separate axis nobody separates: `entry_required`.** Permission answers
*whose ground is this?* It does not answer *is a stranger going inside my home?*
Those are different questions, and a park makes the second one dangerous because
the park owner may hold a key. When entry is required, the booking flow adds an
explicit, per-job, time-boxed, revocable consent:

```
SOMEONE HAS TO GO INSIDE

Winterizing means shutting off and draining your water lines,
so the crew needs to be in the home.

  [ I'll be there ]
  [ Let them in — Tue Oct 14, 8am–12pm only ]

Either way: Pretty Lake Estates is not given a key or a code
for this. Nobody goes in outside that window. You can cancel
right up until they pull in.
```

**"Compliance cure" is not a service.** A violation notice creates a maintenance
request pre-filled with the cure and the deadline, one tap from the renter, and
**the photo gate closes the violation automatically because the photo already
exists.** The compliance loop and the commerce loop are the same loop. Nothing else
in either market sits on both ends of it.

---

# Appendix C — Counsel questions this document adds

Numbered so they can join the existing list. All Indiana unless noted.

1. Does a tenancy confirmation / estoppel **novate or modify** an oral
   month-to-month tenancy? *The entire "record, don't create" posture depends on
   no.*
2. Does a **rules acknowledgment** count as a modification of the rental agreement
   for notice purposes? Does a change of owner alone trigger anything?
3. Is there an Indiana **MH-specific rent-increase notice period**? Reported at 60
   days by a secondary source; unverified.
4. **Indiana has no dedicated Mobile Home Park Landlord-Tenant Act** — the health
   statute is sanitation and safety, and general landlord-tenant law fills in. What
   does a park owner therefore *not* get to do unilaterally? This is materially
   different from the states whose park rules the research sampled.
5. **The mobile home community register requirement.** Statute text could not be
   retrieved. What fields does it require — and **can LakeLife BE the register?**
   If the fields line up, *"this satisfies your state register obligation"* is free
   and is a real selling point to park #2.
6. Security deposits: amount held per tenant **and whether the cash actually
   transferred at closing.** A deposit liability with no cash behind it, plus a
   45-day itemised-return clock, is the ugliest surprise available in this deal.
7. Are oral tenancies valid and enforceable for terms under a year? *Assumed yes;
   the whole design leans on it.*
8. The privacy sentence on the import screen — what may we say about holding data
   on people who have never agreed to anything with us, given the settled
   third-party-administrator posture?
9. **Are the overdue-reminder templates debt-collection communications?**
10. Does the FTC fee rule reach RV sites or campgrounds? Unconfirmed — the FTC's own
    FAQ blocked retrieval. **Assume it does**: show one all-in price from the first
    pixel, which matches our existing convention and therefore costs nothing.

---

**Files read and verified while writing this:** `CLAUDE.md` ·
`docs/park-module-design.md` · `docs/park-module-phase2-design.md` ·
`docs/park_model.py` · migrations `0001`, `0002`, `0010`, `0014`, `0024`, `0042`,
`0047`, `0048`, `0050`, `0052` · `src/lib/{dispatch,fleet,router,automation,
comms-classify,comms-context,comms-draft,settings,payments,gate}.ts` ·
`src/app/park/{data,actions,park-helpers}.ts` · `src/app/parks/{public-data,
apply-actions}.ts` · `src/app/{book,vendor,ops,messages,portal,profile}/*` ·
`src/components/{ParkLots,ParkSetup}.tsx`.

**Claims verified this session, not taken on trust:** the anon SELECT grant on
`park_lots` alongside its `notes` column · five production call sites of the
time-budget gate, none taking an override, one of them a post-write backstop · the
risk-word list in full, with no housing vocabulary and the acknowledged
`free`/`freeze` collision · the auto-reply dial defaulting to on with no audience
dimension · **zero** occurrences of `serviceWorker`, `navigator.onLine`,
`IndexedDB` or `localStorage` anywhere in `src/` · `saveLot` and `saveLotRates` as
two separate actions with two refreshes · the six `owner_id` base-table policies
plus the customer job view · `services_read` granting the full pricing table to
any user with `role='owner'` · the take-home formula and its own comment claiming
non-invertibility · the tenancy-ending action asserting membership without a role
check and without a row-count check · `summarise()` dropping inactive lots from
the denominator · the unfilled-job sweep's cancel-and-text, and the storage custody
guard eight lines above it that is the template for the fix.
