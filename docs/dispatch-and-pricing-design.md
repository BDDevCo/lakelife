# LakeLife — Auto-Dispatch & Crew Pricing Design (agreed 2026-07-19, build after token reset Tue 7am)

Owner intent: ZERO manual dispatch. Owner never assigns jobs, never negotiates rates
with crews or customers. Machine matches; owner only gets growth/exception signals.

## A. Capacity-aware booking calendar (kills date-waterfall)
- Booking calendar only OFFERS dates with real capacity: for the service + lake +
  date, sum eligible crews' remaining slots (daily_capacity − assigned that day),
  eligibility = active + valid COI + service_types match + work_days includes the
  weekday + no vendor_availability block. Zero capacity ⇒ date not selectable.
- Customer self-selects into open capacity ⇒ no post-booking date rolling, ever.
- Ops signal (SMS/email + ops banner) when a service+lake runs >85% booked over the
  next 14 days: "time to onboard another crew." (Computed nightly in the cron.)

## B. Auto-assign at booking + self-healing waterfall
- At booking: pick crew among eligible by (1) performance tier, (2) route density —
  already has jobs that day on that lake, (3) margin (customer price − crew rate),
  (4) load balance / least-recently-fed. Stamp vendor_id, vendor_cost (locked at
  assignment from crew's CURRENT rate), margin, status=scheduled.
- No accept/decline. Jobs are pushed; nightly route text is the notification.
- Nightly sweep (before route build): re-validate every next-day assignment
  (suspension, COI lapse, new availability block, capacity cut) → silently
  re-waterfall to next eligible crew. Only if NO crew eligible → "needs attention"
  bucket + one SMS to ops. Pull-deadline-window jobs escalate immediately, never sit.
- Ops Jobs tab keeps Reassign as manual override; adds "auto" badge + needs-attention bucket.

## C. Crew-set PRIVATE rates; fixed customer menu price (the synthesis)
- Customer ALWAYS sees one LakeLife all-in price (services table, owner-tunable). No
  crew choice pre-booking; crew NAME revealed only after booking (trust).
- Crews set their own rates during onboarding + editable later, in their units:
  per pier section, per boat foot, per lawn band, per sqft band, flat — mirroring
  services.pricing_model. UI shows anchor: "crews around here typically take home
  ~$X" (≈70% of menu price). No negotiation anywhere.
- Engine = private auction: high-priced crews silently get fewer jobs. Nudge copy:
  "Your rate is above the area's booking level — you may see fewer jobs."
- MARGIN FLOOR: crew ineligible for a service where menu price − their rate < floor
  (default 25%; target 30%). If no crew fits under a price ⇒ ops signal: "price
  pressure on <service> — raise menu price or recruit."
- Rate changes apply to FUTURE assignments only (vendor_cost locked at assign time).
- Note: self-set rates strengthen 1099 independent-contractor posture (§2 agreement).

## D. Private scoring (no public leaderboard — info is owner's asset)
- Crew sees ONLY own card: tier (e.g. Priority ⭐), on-time %, photo compliance,
  jobs/month + "what gets you to the next tier." Never other crews' anything.
- Ops sees full ranked table (ops-only).
- Inputs (all already generated or 1 small migration): completed-on-scheduled-day
  (needs jobs.completed_at — migration 0014), photo-gate compliance, flag accuracy,
  volume. Tier drives first-dibs in assignment ranking.

## E. Transparency ledger
- Customer: one price; crew name post-booking only. Never rates/margin/comparisons.
- Crew: own rates/jobs/score only. Never customer prices (rule 1), margin, or peers.
- Owner: everything.

## F. Open decisions (owner to confirm before build)
1. Margin floor 25% / target 30%?
2. Show crew name to customer after booking? (recommended yes)
3. Rate changes future-only? (recommended yes)
4. Peak/surge customer pricing in crunch weeks — park for year two? (recommended park)

## G. Build order (Tuesday, post-reset)
1. Migration 0014: jobs.completed_at; vendor_rates table (vendor_id, service_id,
   unit_rate/base per pricing_model, updated_at); availability slot capacity math.
2. src/lib/dispatch.ts: pure eligibility + ranking + margin-floor engine + tests.
3. Booking: capacity-aware calendar (available-dates endpoint) + auto-assign on create.
4. Nightly cron: re-validate sweep + capacity alert (>85%/14d) + needs-attention SMS.
5. Crew onboarding step 4: "set your rates" (+ rates editor in vendor portal).
6. Crew "My standing" private card; ops ranked table + needs-attention bucket.
7. Retire manual assign as the default path (Reassign stays as override).

## H. Rate-card vs bidding — RESOLVED (owner, 2026-07-22)
CONFIRMED: there is NO per-job bid model and never was. Crews set STANDING
per-unit rates by service in the Rates tab (vendor_rates: $/pier section, lawn
band, sqft tier, per-foot, flat). The engine computes crew cost from that card
at assignment. Keep this — it's zero-negotiation, quality-safe, 1099-clean.
Two SEPARATE questions:
  (1) how is PRICE set? → rate-card. Locked. Do not change.
  (2) how is a JOB awarded? → today: silent auto-assign (score+preferred+margin).
NEXT (planned): add a CLAIM BOARD for jobs the engine can't auto-place (no
preferred / tie / overflow / "needs a crew" bucket). All ELIGIBLE crews see them;
first qualified crew to CLAIM wins; they're paid THEIR OWN rate-card price — crews
compete on speed/hunger, NOT on price (no underbidding, no margin erosion). Margin
floor still gates eligibility. This is the "crews fight over new jobs" energy
without a price auction. Engine already supports it — the needs-attention bucket
IS the board's job set.
PARKED (year 2, scale only): true $-bid ONLY on overflow jobs no rate-card crew
takes, bids capped AT/BELOW menu price so a bid can only widen margin, never move
the customer price. Needs deep crew liquidity per lake; not for beta.
