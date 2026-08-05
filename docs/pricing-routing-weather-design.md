# Three things the audit didn't cover — pricing, cross-lake days, weather

**Status:** design, nothing built. Written 2026-07-27 in response to the owner's
three concerns after the two-season audit.

These arrived together and they belong together: weather and cross-lake routing
are the same problem wearing different hats (re-sequencing a day that reality
changed), and pricing is the one where the audit's suggested fix was wrong.

---

## 1. Pricing — the auto-raise idea should be dropped

**The owner's objection:** *"I don't know how that's going to fly when a
customer is already used to a price and all of a sudden we are charging more
just for the use of the platform."*

That objection is correct and it kills the proposal. Writing down why, because
the reasoning matters more than the conclusion.

### What "below floor" actually is

The audit found 348 jobs per 1,000 customers per season where no crew clears the
30% margin floor. It is tempting to read that as "our prices are too low." It
isn't. Margin is the spread between the menu price and the crew's rate card, so
a below-floor job means **one specific thing: on this lake, for this service,
the cheapest available crew is expensive relative to the menu.**

That is a *supply* fact. Raising the customer's price to fix a supply problem
sends the bill for a thin crew market to the homeowner, who did nothing and
sees nothing except a number that went up.

### Why it would land badly here specifically

- These are **lake communities**. Neighbours compare prices across the fence. A
  raise that can't be explained becomes a story that travels.
- Much of the book is **recurring** (weekly mow). A recurring customer has a
  price they consider *theirs*. Changing it silently is the single fastest way
  to make a subscription feel like a trap.
- The cause is invisible and unflattering. "We charge more because we couldn't
  find a cheaper crew" is not a sentence anyone wants to send.
- It compounds. The audit already found the auto-apply loop could raise a
  service ~3×/year at 10% a step, because a crew's rate hike pulls the menu up
  behind it.

### The model I'd propose instead

**A price a customer has been quoted is theirs for the season.**

1. **Menu changes apply to new bookings from new relationships only.** A
   customer already receiving a service keeps their rate until the season
   boundary — the same idea as Autopilot's existing `locked_price`, generalised
   from one feature to a platform rule.
2. **Existing customers change at a season boundary, with notice, once a year.**
   Announced, not discovered. This is how every service business does it and
   nobody churns over it.
3. **Turn the nightly auto-apply off by default.** Keep it as a one-tap
   suggestion with the reason attached ("no crew clears the floor on Pretty Lake
   for pier work — 14 jobs affected this season").
4. **Fix below-floor on the supply side**, in this order:
   - the fill-in board, which already exists and lets a crew take a specific job
     at a floor-clearing rate without touching their card or the menu;
   - a **recruiting signal** — "this lake+service has demand and no crew that
     clears the floor" is the single most useful number for growth;
   - a **per-lake, per-service floor dial**. A hard 30% everywhere is a blunt
     instrument on a thin lake where 25% and a served customer beats 30% and no
     service. Rule 8 says the dials live in the database; this one should too.

### The floor: "30% or $X, whichever is greater" — adopted

A percentage floor behaves badly at the bottom of the menu. A $65 mow at 30% is
$19.50 of margin, and that has to carry a booking, a dispatch, a photo review, a
charge, a payout, and any support that follows. A $2,550 storage package at 30%
is $765. Those are not the same business and one number should not govern both.

Decision: the floor becomes **the greater of a percentage and an absolute
dollar amount**, both dials in the database (rule 8), and both overridable per
lake and per service. Cheap recurring work then has to carry its own transaction
cost, and thin lakes can be tuned rather than abandoned.

---

## 1c. A customer-side management fee — modelled, and the answer changed

**The owner's proposal:** *"I think we should have the customer take some of the
burden for providing a LakeLife management for all the services they need."*

**And the constraint that decides it:** *"I don't want to turn off some lady
that just wants her lawn mowed 2x a month because that could add up."*

That constraint is right, and modelling it changed my recommendation. The
working model is committed alongside this doc (`docs/membership_model.py`,
`docs/membership_model2.py`) so the numbers can be re-run with real inputs.
Prices are production's real menu; the customer mix is an estimate of a lake
community and is the assumption most worth arguing with.

### Where the money actually is

| Archetype | Customers | Season spend | Share of book |
|---|---|---|---|
| Just the lawn, 2×/month | 260 | $650 | 4.7% |
| Lawn weekly, small lot | 140 | $1,300 | 5.0% |
| Lawn + clean before visits | 120 | $2,460 | 8.2% |
| Open/close + lawn | 160 | $2,615 | 11.6% |
| Pier family | 160 | $4,621 | 20.5% |
| Whole house + boat storage | 110 | $10,413 | 31.7% |
| Estate, everything | 50 | $13,307 | 18.4% |

**The top 16% of customers are half the book. The lawn-only quarter is 4.7%.**

### Why a flat fee is out

A $250 flat membership is **38% of the lawn-only customer's entire annual
spend**. At $250, 40% of customers would be paying more than 15% of everything
they spend just for the privilege. The owner's instinct wasn't cautious, it was
correct — a flat fee taxes the customers who receive the least coordination,
because a single recurring service has almost nothing to coordinate.

### Why a DISCOUNT membership is also out — adverse selection

This is the finding that changed my mind, and it invalidates the optimistic
table I showed in the previous round.

A membership that buys cheaper prices is **only ever bought by the customers it
loses money on.** Nobody joins unless their discount exceeds the fee — so by
construction every joiner costs more in discount than they pay in fee, and the
fee just claws part of it back.

| Design | Who joins | Margin change |
|---|---|---|
| $250 fee, 8% off | 320 | **+1.7%** |
| $400 fee, 8% off | 160 | **+1.9%** |
| $250 fee, 5% off | 160 | **+1.2%** |

One to two percent, in exchange for a subscription product, auto-renewal law,
and a new billing surface. **Not worth building.**

The rule, if it's ever revisited: a discounting membership only pays when
`fee > discount % × that customer's season spend`. At 8% off, a $250 fee stops
paying for itself above $3,125 of spend — which is precisely the customer most
motivated to join.

### What does work: sell ACCESS, not a discount

Keep every menu price exactly as it is. The membership buys things that cost
LakeLife little and are worth a lot to someone who isn't at the house:

- priority on the calendar,
- a guaranteed preferred crew,
- no same-day rush surcharge,
- **off-season checks — a drive-by after a storm, photos in the app.** This is
  the genuinely membership-shaped service: it cannot be sold per-transaction and
  it is exactly what an absentee owner lies awake about.

Because no prices move, **every dollar of fee is margin**:

| Fee | Take-up among the 600 higher-spend customers | Margin change |
|---|---|---|
| $250 | 20% (120 members) | +2.8% |
| $250 | 35% (210 members) | **+4.8%** |
| $250 | 50% (300 members) | **+6.9%** |
| $400 | 35% (210 members) | **+7.7%** |

And unlike the discount design, this revenue is recurring, predictable, and the
kind a buyer pays a real multiple for.

### The answer to the owner's actual question

**Per-service stays the default, for everybody.** The lawn-only customer is
never shown a fee and nothing about her experience changes. She is 4.7% of
revenue but a large share of the neighbourhood conversation on a small lake, and
the referral engine runs on exactly that.

**One optional membership, not tiers.** Tiering by services requested creates a
mid-season upgrade conversation ("you've added a pier, you owe us more"), which
is an ops touchpoint we are trying to delete, and it punishes the one behaviour
we most want to encourage. A single opt-in membership self-selects to the right
customers with none of that machinery — and the app can show each customer their
own break-even honestly.

**Add season-pass bundles as the middle product.** "Opening + closing + 20 mows,
one price, booked once" reuses the `service_packages` machinery that already
exists for storage, locks in volume, gives the mid-market customer one decision
instead of twenty, and carries **no subscription or auto-renewal law at all**.
For the $2,600 open/close+lawn customer this is a better fit than a membership
in every respect.

So: three products, matched to three real segments — à la carte for the small
customer, a season pass for the middle, a membership for the top third who are
half the revenue.

### "We grow with you" — modelled, and it beats charging a fee

**The owner's refinement:** *"we grow with you so not a lot of upfront cost, but
we take a cut each service provided."*

That instinct is right, and the arithmetic says take it further: **charge no fee
at all.** Model in `docs/grow_model.py`.

**First, the thing already true:** the per-service cut *is* "we grow with you."
It is proportional by construction — LakeLife earns only when the customer
actually uses something. Adding an upfront fee makes the model *less* aligned,
not more.

**An upfront fee is a bad trade at any size**, because it lands at signup, the
single highest drop-off moment in the funnel:

| Upfront | Collects | Cost of losing just 5% of signups |
|---|---|---|
| $25 | $25,000 | **$54,221** |
| $50 | $50,000 | $54,221 |
| $100 | $100,000 | $54,221 |

At $25 nobody is priced out but it collects less than half of what a 5% signup
loss costs. At $50 the lawn-only customer feels it. At $100 a quarter of the
book is priced out before they book anything.

**And the number that decides the whole question:**

> Moving ONE "pier family" customer up to "whole house" is worth **$1,738** of
> margin. A $250 membership is worth **$250**. The upsell is worth **7×** the
> fee.

So the effort belongs in growing the relationship, not collecting a toll on it.

| Design | Margin impact | Friction | Subscription law |
|---|---|---|---|
| Paid membership, $250 @ 35% take-up | +4.8% | signup + billing | yes |
| **Free tiers earned on spend, 10% move up one level** | **+5.3%** | **none** | **none** |
| Free tiers, 15% move up | **+8.0%** | none | none |

### The recommendation: tiers you *earn*, not tiers you *buy*

Same tiers the owner asked about — unlocked by season spend rather than paid for:

| Tier | Unlocks at | What opens up |
|---|---|---|
| **Standard** | anyone, from job one | full service, photos, guaranteed pay-on-completion |
| **Priority** | moderate season spend | first pick of dates, no same-day rush surcharge |
| **Concierge** | whole-house spend | guaranteed preferred crew, off-season storm checks, one thread that knows the house |

Why this is strictly better than a paid membership here:

- **Zero upfront cost** — the owner's stated goal, taken literally.
- **Literally "we grow with you"** — what they get grows as they grow, with no
  invoice in between.
- **No adverse selection.** Nobody self-selects into a discount that loses money;
  perks are rewards for spend already captured.
- **No subscription or auto-renewal law**, no second billing surface, no
  cancellation flow, nothing new for the attorney.
- **The lawn-only customer is never charged and never rejected.** She is
  Standard, she is served exactly as well, and if she ever adds a pier the app
  can show her what opens up. That is an upsell prompt, not a toll booth.
- **It costs almost nothing to deliver.** Priority is queue position. A
  guaranteed crew is a flag that already exists (`preferred_vendor`). Only the
  off-season storm check has real cost — and it is reserved for the customers
  who are half the revenue.

### What this means for the three products

The earlier recommendation stands with one correction: **drop the paid
membership.**

1. **À la carte per-service, for everyone** — with the cut embedded, exactly as
   today. This is the "we grow with you" engine and it already works.
2. **Season-pass bundles** for the middle — one decision instead of twenty,
   locks in volume, no subscription law.
3. **Earned tiers** replacing the paid membership — the retention and upsell
   mechanism, free to the customer and nearly free to run.

If a paid tier is ever wanted, the honest place for it is a genuinely new
service with real cost behind it (year-round property watch, say), sold as a
service and not as access to the platform.

## 1b. Should crews just dispatch themselves? — partly yes, and the ToS says so

**The owner's question:** *"maybe we let the crew figure out their own dispatch?
I did like the feature to help the business owner/contractor with logistics and
more hands-off management, but it might be more complicated than what it's
worth."*

### The distinction that resolves this

"Dispatch" is two different jobs wearing one word:

- **(A) Assignment** — *which crew does this job?* This is the marketplace
  itself. It is where rule 1 lives (the crew never sees the customer price), and
  where the margin floor is enforced. Remove it and there is no platform, just a
  directory. **This must stay automated.**
- **(B) Sequencing** — *in what order, in which truck, on which route?* This is
  the logistics layer, and it is the part that is questionable.

Everything below is about (B) only.

### The algorithm is playing with worse cards than the crew

Route optimisation earns its keep when the optimiser knows more than the driver
— 200 stops, unfamiliar city. That is the opposite of this business. A crew
running six stops on water they have worked for fifteen years knows which
driveway floods, whose dog is out, which customer is never up before nine, which
ramp is closed, and where the wind actually is. The router knows coordinates and
an estimated duration.

When a crew gets a route they disagree with, they ignore it — and then the
platform's model of the day is wrong, which quietly corrupts the capacity maths
that other decisions depend on. **An ignored plan is worse than no plan**,
because the system believes it.

### The contract already decided this

This is the part that settles it. The counsel draft the owner is having reviewed
says, in §11.1, that crews independently select *"lakes, service areas, days,
hours, capacity, equipment, methods, **routes**, and staffing"* and that
*"LakeLife does not control the manner and means of performance."* Section 3
goes further: platform rules *"do not give LakeLife the right or responsibility
to control the manner, means, **sequence**, tools, staffing, judgment, or
physical performance of a Crew's work."*

Today's product computes a route, assigns specific trucks, and texts it to the
crew each night in a form that reads like instructions. That is drifting from
the agreement, and route/sequence control is exactly the kind of factor that
gets weighed in worker-classification disputes. **Not legal advice — a question
for the attorney who wrote §11.1 — but the product and the contract should not
disagree, and right now they do.**

### The recommendation

**Keep assignment automated. Demote sequencing from commander to advisor.**

| Stays | Becomes advisory | Goes away |
|---|---|---|
| Which crew gets the job | Suggested order for the day | Hard lake-cluster partitioning |
| Daily **hours** capacity (a promise to the customer, not a directive to the crew) | Suggested split across a contractor's trucks | Strict truck assignment |
| Trucks as a capacity concept | One-tap multi-stop directions in the suggested order | Treating the computed route as the truth |

The crew's Today page shows the suggested order and lets them reorder it in
seconds, or ignore it. The platform does not police the order and does not
treat deviation as an exception. It keeps learning real durations from what
actually happens — which gets *more* accurate once the crew isn't fighting a
plan.

This is **less machinery than today**, not more. It also preserves the thing the
owner actually liked: a contractor with three trucks still opens the app to a
sensible proposed split and a route they can accept with one tap. The difference
is that it is an offer, not an order.

**When to revisit:** if LakeLife ever runs its own W2 crews, or a crew routinely
exceeds ~15 stops a day across a wide area, the optimiser starts knowing more
than the driver and mandatory routing earns its keep again.

### This also collapses the weather problem

Section 3 below describes auto-rescheduling with directional wind exposure. Most
of that complexity exists to let the machine *re-sequence a day correctly*. If
the crew owns the order, the machine no longer has to:

- **Within a day** — the machine flags *"these three look wind-exposed today"*
  and the crew decides. No exposure model needs to be right, only useful.
- **Across days** — a job that genuinely cannot happen still has to move, because
  that is a promise to a customer. The crew taps **"can't do these today —
  weather"**, and the machine re-books, backfills the freed capacity, and tells
  the affected customers.

The ToS already contemplates exactly this: §59 lets a crew cancel or suspend for
*"unsafe conditions… weather or water conditions."* The feature is the button
and the customer comms, not the meteorology. That is a fraction of the work for
most of the value, and it is honest about who actually knows the conditions.

---

---

## 1d. The crew side — don't tax them, feed them

**The owner's question:** *"ok so how do we do this for the crew side?"*

Model committed as `docs/crew_model.py`. The short answer is that the crew side
is not a pricing problem at all — it is a supply problem wearing a pricing
costume, and the two obvious monetisation moves are both blocked.

### Blocker 1: a percentage fee on crews breaks rule 1 by arithmetic

If a crew is ever shown "LakeLife takes 20%," they immediately know the customer
paid `their rate ÷ 0.8`. Rule 1 — vendors never see customer prices or margin —
is defeated by division, on every job, forever. **Any percentage take-rate
disclosed to crews is architecturally incompatible with the platform's first
non-negotiable.** Only a flat fee reveals nothing.

### Blocker 2: crews are price-setters, so a fee comes straight back

Customers accept a menu price. **Crews set their own rate cards.** Charge a crew
$99/month and the rational response is to raise their card enough to cover it —
which lands as a higher `vendor_cost`, which pushes more jobs *below* the margin
floor, which is already the single largest source of ops work. A crew fee is
substantially self-financing in the wrong direction.

The spread already is the fee. It is invisible, it is rule-1 safe, and it does
not invite a counter-move.

### What LakeLife actually sells a crew: a full, MIXED day

| Stops (mows only) | Crew net | Net/hour |
|---|---|---|
| 1 | $10 | **$7** |
| 2 | $57 | $22 |
| 4 | $150 | $34 |
| 8 | $335 | **$41** |

A crew driving 25 minutes each way for one $85 mow nets **$7/hour**. That is the
thing a lone contractor cannot fix for themselves, and it is exactly what a
platform can.

But note the ceiling: **even eight mows in a day only reaches ~$41/hour.** Cheap
recurring work does not make a crew's living no matter how much of it you stack.
A *mixed* day does:

> Spring opening + 3 mows + a boat-lift set = 5 stops, 7.4 hours,
> **$709 net to the crew — $96/hour.** Four days a week for a 22-week season is
> **~$62,000**.

This matters strategically: the cheap recurring services are simultaneously the
hardest to clear the margin floor on *and* the least valuable to the crew. The
platform's job is not to hand crews volume — it is to hand them **water work
with mows filled in around it.**

### The real crew-side crisis: 14 of 34 crews did nothing

The audit found the top 4 crews carried 37% of 10,184 jobs while **14 crews
completed zero.** That is not a power law, it is a bug.

Dispatch ranks on score → density → margin → **fairness last**. A new crew has
no score, so it loses every comparison to an established crew, so it never
completes a job, so it never earns a score. **A cold-start trap that starves new
supply**, and starved crews quit. Every crew that quits shrinks supply, and thin
supply is precisely what generates the 348 below-floor jobs per 1,000 customers.

**The minimal fix:** a new crew should start at the **median** score, not zero,
and move on evidence. One change, and the trap opens. Optionally reserve a small
share of each week's jobs for crews under a volume threshold — a proving period
rather than a subsidy.

Fixing this is worth far more than any crew fee, because it attacks the root of
the biggest ops workload rather than collecting a toll on the way past.

### Three crew segments, matching the three customer ones

| Crew | Wants | What we sell them |
|---|---|---|
| **Solo operator** | a few dense days, fast money, no admin | a full day on one lake; 2% early payout; photo records that win disputes |
| **Multi-truck contractor** | predictable volume, efficient days | suggested truck split, season-ahead visibility, block booking |
| **Marina / shop** | capacity utilisation on high-value work | the storage and winterisation pipeline, custody-qualified routing |

### How to monetise the crew side without taxing it

1. **Keep the spread as the only charge on their work.** No subscription, no
   commission line, nothing that invites a rate-card counter-move.
2. **The 2% early payout already exists and is already crew-side revenue** —
   optional, valued, and it reveals nothing about customer pricing. That is the
   correct shape for anything added later.
3. **Sell things LakeLife's volume makes cheaper than a one-truck operator can
   buy alone**: group-rate liability and garagekeepers insurance, equipment or
   vehicle financing, a year-end tax package with mileage and 1099s already
   assembled. These earn partner or referral revenue and make the crew *better
   off*, so nobody prices against them.

The asymmetry is the point. On the customer side we are looking for revenue. On
the crew side we are looking for **retention**, because supply is the binding
constraint on the whole business.

### Still to decide

- Whether new crews start at the median score (recommended) or a reserved share
  of jobs.
- Whether to pursue group insurance — it is the highest-value crew perk and the
  most work to arrange.

---

## 2. Cross-lake days — the router's "one lake per truck" rule is wrong here

**The owner's question:** *"what if they do some jobs at multiple lakes
throughout the day?"*

Today `planFleetDay` clusters jobs by lake and hands whole lake-clusters to
trucks, explicitly "so nobody criss-crosses lakes." That heuristic is only
correct when lakes are far apart. **Big Long, Pretty and Big Turkey are within a
short drive of each other**, so a cross-lake day isn't an edge case — it's a
normal Tuesday. The rule is actively costing efficiency, and it is the direct
cause of the audit's HIGH finding: one truck busts its hours while a sibling
truck of the same fleet gets nothing, because a whole cluster can't be split.

### The change

**Route by geography and minutes, not by lake label.**

- Treat a crew's whole day as one set of stops with coordinates.
- Cluster by **proximity and drive time**, letting a cluster span lakes when
  that genuinely is the shortest day.
- Balance trucks on **minutes** (work + drive + the 15% overhead already
  modelled), not on job counts — that alone fixes the over-hours bug.
- Keep lake grouping as a **soft preference, not a hard partition**: a small
  bonus for staying on one body of water, because it means one set of access
  quirks and less context switching, but never at the cost of an over-hours day.

### The part that isn't the algorithm

A cross-lake day is harder to *communicate* than a single-lake day, and right
now the crew gets a text with map links. What a multi-stop day actually needs:

- **A "Today" route page per truck**: ordered stops, drive time between each,
  what the job is, photo minimum, access notes, and the gate code revealed only
  on the day (rule 3 already does this).
- **One multi-stop directions link** rather than N single links — Google Maps
  takes waypoints, so the whole day is one tap.
- **Live re-sequencing.** If the day changes at 9am, the page changes. This is
  the hook the weather work below plugs into.

---

## 3. Weather — the most interesting problem on this list

**The owner's framing, which is the right one:** rain stops lawn care; wind
stops pier work; **but wind can stop pier work on one shore of a lake while the
opposite shore is perfectly workable** — so weather should *reshuffle* a day,
not cancel it.

That last observation is the whole design. A per-lake "bad weather today" flag
would be simple and wrong: it would cancel work that was perfectly doable 400
yards away.

### The model

**a) Weather sensitivity is a per-service dial (rule 8).** A `weather_rules`
field on `services`, tuned from Ops, not code:

- Lawn mowing: blocked by recent/active rainfall above a threshold (wet grass
  cuts badly and heavy equipment ruts soft ground).
- Pier and lift work: blocked above a wind threshold, **and marked
  wave-exposure-sensitive**, which turns on the directional logic below.
- Housekeeping, winterization, shop work: largely weather-independent.

**b) A forecast source.** Hourly wind speed, wind *direction*, and precipitation
per location. The US National Weather Service API is free and covers Indiana;
paid options exist if we want better granularity. Cached per lake per hour, so
one call covers every job on that water.

**c) Directional exposure — the part that makes it worth doing.** What matters
for waves is **fetch**: how far the wind travels over open water before reaching
that shore. A property on the north shore is sheltered in a north wind and
exposed in a south wind.

A usable first version needs only the bearing from the lake's centre to the
property, compared against the wind direction: wind blowing *across the lake
toward* a property means exposure; wind blowing *off the land behind* it means
shelter. That is simple trigonometry on data we mostly have.

**The gap:** `lakes` currently has **no coordinates at all** — no centroid, no
shoreline. Properties do carry lat/lng from the address wizard. So this needs,
at minimum, a lake centroid (trivial to add), and ideally a rough shoreline
outline later to compute true fetch distance rather than just direction.

**d) What the machine does with it**, per job and not per lake:

1. Nightly, and again on the intraday sweep, score each upcoming job:
   **workable / marginal / blocked**.
2. Blocked jobs move to the next workable day automatically; the freed capacity
   backfills from the waitlist and claim board.
3. The affected trucks get a re-sequenced route.
4. The customer gets told *before they wonder*: "Wind's up on your side of the
   lake tomorrow — your pier install moved to Thursday. Nothing to do, no
   charge." That message is the difference between weather being an ops
   phone-call generator and weather being invisible.

**e) The crew has the final word.** They are standing on the shore and the
forecast isn't. A one-tap **weather hold** on the Today page re-triggers routing
for that truck. Forecast pre-empts; crew overrides.

**f) A consequence that must not be missed:** a weather move must never count as
a crew no-show, and must never trigger a cancellation fee for the customer. The
existing standing system (`vendor_no_shows`, lake demotions) and the
cancellation policy both need an explicit weather exemption, or the platform
will start punishing crews for the weather. Missing this would be worse than
having no weather feature at all.

---

## How this sequences against the audit's bug list

The audit's ten bugs are mostly mechanical and independent. These are design
work. Suggested order:

1. **The nine unambiguous defect fixes** — no decisions needed, they're just
   wrong today.
2. **Sequencing becomes advisory** (1b). This is mostly *deletion*, it aligns
   the product with §11.1 and §3 of the agreement, and it is the precondition
   that makes weather cheap.
3. **Pricing policy** (1) — lock a quoted price to the customer for the season,
   turn nightly auto-apply off, add the "percentage or dollars, whichever is
   greater" floor with per-lake overrides.
4. **Weather, the small version** (3) — the crew's "can't today — weather"
   button plus customer comms and backfill. No meteorology model required.
5. **The membership** (1c) — the biggest change, and the one that needs the
   owner's real numbers and the attorney's involvement before a line is written.
6. **Weather, the clever version** — directional exposure, lake geometry, an
   hourly forecast feed. Only worth building once 4 is live and the flags are
   proving useful. It may never be worth it, and that is a fine outcome.

The season year-roll bug belongs with weather: both are "the calendar changed
and nobody told anyone."

## Decisions still open

1. **Membership shape** — optional-with-higher-non-member-pricing, or included
   for everyone? What does it contain? What does it cost, and how much embedded
   margin does it buy down?
2. **The floor's dollar figure** — what is the minimum margin a visit must carry
   to be worth doing?
3. **Weather** — confirm the small version first, and that crew judgement
   outranks any forecast.
4. **Lake geometry** — only needed if we ever build the clever version. Defer.

## Settled in this round

- Auto-raising an existing customer's price: **dropped**.
- A quoted price is the customer's for the season: **adopted**.
- Floor becomes "percentage or dollars, whichever is greater," per-lake
  overridable: **adopted**.
- Job assignment stays automated; **route and sequence belong to the crew** —
  which is also what the agreement already says: **adopted**.
- Weather starts as a crew-triggered flag plus customer comms, not an
  auto-rescheduler: **adopted**.

---

## 1e. Launch strategy — simple now, monetise later. Mostly right, with two edits.

**The owner's plan:** *"Start super simple knowing we can add on features later
(but build the features now)… get people hooked then pop something in like
'ready for next season exclusive offering'… something to keep increasing
billing revenue after we get them using the platform."*

Land-and-expand is the correct playbook for a two-sided marketplace with no
liquidity. Two things in the phrasing need changing, and one number should
probably change the launch plan itself. Model: `docs/launch_model.py`.

### Edit 1: "build the features now" — build the DATA now, not the machinery

This is the one to push back on, because the audit just demonstrated the cost.
The storage product is fully built and switched off, and the simulation found
phantom pricing, an impossible calendar date that grants a free year of storage,
and booking rules keyed to a display name — all in code that has never carried a
real customer. **Dormant code doesn't stay correct. It drifts from reality while
nobody is watching, and it is broken on the day you switch it on.**

A membership billing system built now and turned on in eighteen months will be
wrong in exactly the same way, except the failure mode is mischarging customers.

The distinction that matters:

| Build NOW (cheap, and impossible to retrofit) | Build LATER (expensive, and safe to defer) |
|---|---|
| **Per-customer, per-season spend history** — tier eligibility is meaningless without it, and you cannot recreate last season's data | Subscription billing, auto-renewal, dunning, cancellation flows |
| **Crew volume and reliability history** — same reason, for crew-side offers | Paid-tier gating and entitlement checks |
| **ToS language that contemplates future paid tiers** — otherwise you re-paper every customer | Exclusivity contracts and capacity commitments |
| **A read-only "here's what you'd unlock" surface** — free, and it teaches the upsell | Anything that takes payment |

The rule: **anything that RECORDS is cheap and must happen now. Anything that
CHARGES can wait, and is safer waiting.**

### Edit 2: "get people hooked then pop something in" — only ever ADD

There is a version of this that builds trust and a version that burns it, and
they look identical on a roadmap.

- **Fine:** a genuinely new capability arrives and is paid. "Year-round property
  watch is new this season — here's what it costs."
- **Not fine:** something a customer already has quietly moves behind a paywall.
  "Priority scheduling now requires membership."

The second is churn, complaints on a lake where everyone talks, and in several
states a material-change-of-terms problem. **Grandfather everything.** Whatever
a customer has on day one, they keep for as long as they stay. New money comes
from new value only. This costs nothing and removes the entire risk.

### The number that should change the launch plan

**Platform costs are not the constraint.** All-in infrastructure is roughly
**$135/month — $1,620/year**. That is covered by *eight* lawn-only customers, or
**one** whole-house customer. Ramping "to cover costs" is a bar you clear almost
immediately.

The real constraint is giving a **crew** a reason to show up:

| Lawn customers on ONE lake | Full crew-days per week |
|---|---|
| 8 | 0.5 |
| **16** | **1.0** |
| 32 | 2.0 |
| 64 | 4.0 (a crew's whole week) |

And the same customers, deployed two ways:

| | Stops per day | Crew nets |
|---|---|---|
| 24 customers spread over 3 lakes | 4 | $34/hr |
| **24 customers concentrated on 1 lake** | **8** | **$41/hr** |

Identical customer count. One is a business for a crew; the other is a favour
they will stop doing.

**So the launch strategy is not "sign up as many customers as possible."** It is
**"reach ~16 customers on ONE lake before opening the second."** Density is what
retains crews, crew retention is what fills jobs, and filled jobs are the only
thing customers actually experience. Spreading thin across three lakes to look
bigger is the fastest way to lose the crews who make it work — and the audit
already showed where that ends: 14 of 34 crews idle, 20% of demand unserved.

### What "exclusivity" should mean on each side

- **Customer exclusivity** is a capacity promise. Sell too much of it and you
  cannot honour it. Cap it per lake per service against actual crew hours.
- **Crew exclusivity** — first refusal on a lake — is genuinely valuable to a
  crew and genuinely dangerous to the marketplace: it is the concentration
  problem as a product. If offered, bound it: exclusive only while they serve
  the demand, with automatic release when they can't.

### The launch shape

1. **One lake. À la carte. One price. No fees, no tiers, no membership UI.**
   The customer-facing product is already this simple — the complexity is all
   internal, where it belongs.
2. **Record everything** — spend by season, crew volume, reliability.
3. **Reach ~16-20 customers there**, so a crew gets a real day, before opening
   lake two.
4. **Then** switch on earned tiers (free, already-earned, no billing).
5. **Later still**, and only when there is a genuinely new service worth paying
   for, introduce the first paid thing — added, never taken away.

---

## 1f. The margin floor: 20% at launch — and probably never back to 30%

**The owner:** *"lower the 30% to 20% (maybe even lower) to start and ratchet up
after the marketplace becomes frothy. I think we might price ourselves out at
30%."*

Modelled (`docs/floor_model.py`, 4,000 simulated bookings against the real
menu). The instinct is right, and the model says something stronger than the
proposal.

### At launch, 30% doesn't price out customers — it prices out the WORK

| Floor | Bookings that fill | Total margin |
|---|---|---|
| **30%** | **24%** | $133,204 |
| 25% | 40% | $193,765 |
| **20%** | **59%** | **$251,799** |
| 15% | 74% | $296,817 |

At 30%, in a thin crew market, **three of every four bookings never get
served.** Dropping to 20% nearly doubles total margin — not by taking more per
job, but by filling work that otherwise sits. An unfilled booking is $0 margin,
a churned customer, a crew with an empty day, and a story on a small lake.

This is the same finding the audit produced from the other direction: 348
below-floor jobs per 1,000 customers was never a pricing problem, it was the
floor set above what a young market could clear.

### The floor is a circuit breaker, not a target — so don't plan to ratchet it

The important second result:

| Floor | Fill (frothy market) | Total margin | Margin per filled job |
|---|---|---|---|
| 30% | 69% | $402,767 | $147 |
| 25% | 81% | $456,923 | $141 |
| **20% or $25** | **81%** | **$504,755** | **$157** |
| 20% | 92% | $489,455 | $134 |

**Even in a liquid market, a flat 30% earns less than 20%.** And note the
margin-per-filled-job at the *same* 20% dial rises from $108 at launch to $134
once crews compete — the market ratchets realized margin on its own, because
more bidders means a cheaper cheapest bid.

So the plan isn't "20% now, 30% later." It's **set the floor low enough that
work gets done, and let competition raise what you actually earn.** Raising the
dial later only helps if crew rates haven't fallen — and if they have fallen,
you don't need to.

### The dollar floor is a maturity tool, not a launch tool

This corrects the earlier "percentage or dollars, whichever is greater"
decision. The dollar floor is right *eventually* and wrong *now*:

- At launch it **costs fill**: "20% or $25" drops from 59% to 40% fill and
  $252k to $237k, because it blocks exactly the cheap recurring jobs that build
  the density crews need.
- Once liquid it is **the best design on the board**: $504,755, the highest
  total in the model.

Build the dial now; set it to **$0 at launch** and turn it on when fill rates
are healthy.

### Where the real bottom is

Card processing is the floor under the floor — roughly 2.9% + $0.30:

| Service | Price | 20% margin | Processing | Net |
|---|---|---|---|---|
| Mow | $85 | $17.00 | $2.77 | **$14.23** |
| Open/close | $457 | $91.40 | $13.55 | $77.85 |
| Storage package | $2,550 | $510.00 | $74.25 | $435.75 |

At 20% even the cheapest job on the menu nets **$14.23** — comfortably
positive. At 15% it is $9.98. At 10% it is $5.73, before a single support
message or partial refund.

**So: 20% is the right launch number, and I would not go below 15%.** Between
15% and 20% you are buying fill rate with the cushion that absorbs refunds,
goodwill and support. At launch, with few customers and every experience
visible on a small lake, that cushion is worth keeping.

### Applied

`margin_floor` is now **0.20** in production, and `DEFAULT_SETTINGS.marginFloor`
matches so a rebuilt database starts in the same place. It is one dial — a
single statement changes it, per rule 8 — and the per-lake override remains the
right way to run a tighter floor where crews genuinely compete.
