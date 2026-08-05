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

## 1c. A customer-side management fee — the strongest idea on this list

**The owner's proposal:** *"I think we should have the customer take some of the
burden for providing a LakeLife management for all the services they need for
their house before, during and after lake season."*

This is worth taking seriously as a business-model change, not a feature.

### Why it fits this business unusually well

1. **It matches what customers are actually buying.** These are mostly second
   homes. The product is not "a mown lawn" — it is *not having to think about a
   house you are not at*. That is a membership, and it has been mispriced as a
   series of transactions.
2. **It unsticks the margin floor.** Margin is currently trapped inside each
   job's spread, which is precisely what creates the audit's largest ops
   workload: 348 jobs per 1,000 customers where no crew clears 30%. Move part of
   the margin into a membership and the per-job floor can come *down* — which
   means **more crews qualify, more jobs fill, and the biggest source of human
   work shrinks by construction.** The fee and the floor problem are the same
   conversation.
3. **It fixes the price-raise problem.** A membership renews annually, which is
   an expected, announced moment. Adjusting it is normal. Silently raising a
   recurring customer's mow price is not.
4. **It is worth more on exit.** A book of renewing memberships with retention
   data is an asset. A flow of jobs is a business. For a platform being built to
   sell, this is the single highest-leverage structural change available.

### The arithmetic, and an honest caveat about it

From the two-season simulation: ~$995 of service spend per customer per season
at 35.5% blended margin ≈ **$353 of margin per customer per season**.

Illustratively, a **$250/season membership plus a reduced ~20% embedded floor**:

| | Today | With membership |
|---|---|---|
| Membership | — | $250 |
| Embedded margin | $353 (35.5%) | ~$199 (20%) |
| **Total per customer/season** | **$353** | **~$449** |
| Predictable? | No | $250 of it, yes |
| Crews clearing the floor | fewer | **many more** |

**Caveat, stated plainly:** those per-customer numbers come from a simulation I
constructed, not from real customers. Treat the *shape* of the argument as
sound and every specific number as a placeholder awaiting the owner's real-world
judgement. The structural point — that moving margin out of the job spread
lowers the floor and fills more jobs — holds regardless of the numbers.

### What has to be decided, and the traps

- **Replace, don't stack.** If a customer pays a membership *and* the same
  marked-up job price, and ever learns what the crew was paid, it reads as two
  bites. The membership should buy down the embedded margin, not sit on top of
  it.
- **Cold start.** Nobody pays a fee to a platform they have never used. Either
  make it optional with non-member pricing higher (the Costco model), waive the
  first season, or have it auto-apply once spend crosses the point where it pays
  for itself.
- **It must contain something.** Priority dates, no rush surcharge, a guaranteed
  preferred crew, storage discount, one thread with someone who knows the house
  — and the genuinely membership-shaped one: **off-season checks**, a drive-by
  after a storm. That is a service that cannot be sold per-transaction.
- **Annual or per-season, not monthly.** These are seasonal homes; a monthly
  charge for a house nobody visits in January feels like a subscription trap.
- **A real legal item.** Auto-renewing consumer subscriptions carry specific
  disclosure and cancellation requirements in several states, and the current
  counsel draft does not cover a recurring membership at all. This must go to
  the attorney *with* the ToS, not after. On the positive side, charging an
  explicit administration fee **strengthens** the third-party-administrator
  posture in §3 rather than weakening it.

---

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
