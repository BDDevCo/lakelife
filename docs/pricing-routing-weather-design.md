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

### One thing worth reconsidering separately

The floor is a **percentage**, and percentages behave badly at the bottom of the
menu. A $65 mow at 30% is $19.50 of margin for a booking, a dispatch, a photo
review, a charge, a payout and any support that follows. A $2,550 storage
package at 30% is $765. Those are not the same business.

Worth considering a floor of **"30% or $X, whichever is greater"**, and
possibly a small per-visit floor so that cheap recurring work carries its own
transaction cost. This is a real pricing decision, not a bug, and it should be
made deliberately rather than discovered at volume.

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

The audit's ten bugs are mostly mechanical and independent. These three are
design work. My suggested order:

1. **The unambiguous defect fixes** (9 of the 10 audit bugs) — no decisions
   needed, they're just wrong today.
2. **Pricing policy** — mostly *removing* behaviour (turn off auto-raise, lock
   existing customers to their rate). Cheap, and it protects trust before there
   are enough customers for it to matter.
3. **Routing by geography** — fixes an existing HIGH bug and is the
   precondition for weather re-sequencing.
4. **Weather** — the biggest piece, and the one that needs new data (lake
   geometry, a forecast feed) and a new dial set.

The season year-roll bug from the audit belongs in the same conversation as
weather, since both are "the calendar changed and nobody told anyone."

## Decisions needed before any of this is built

1. **Price locking**: confirm existing customers keep their rate for the season,
   with changes only at a season boundary and announced.
2. **The floor**: stay at a flat 30%, or move to "30% or $X whichever is
   greater," and allow a per-lake override?
3. **Weather authority**: forecast auto-moves jobs with the crew able to
   override, or forecast only *suggests* and a human confirms every move?
4. **Lake geometry**: is it acceptable to hand-place a centre point per lake
   (minutes of work, three lakes today), or do we want real shorelines?
