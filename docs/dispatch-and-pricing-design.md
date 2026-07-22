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


## I. ZERO-HUMAN-OPS STRESS TEST — geographic dispatch at N-lakes scale (54-agent adversarial run, 2026-07-22)
// Result: 45 failure modes, ALL 45 hid a human on skeptic re-check; all drained into 3 gates:
// (1) human crew-approval, (2) ops-SMS fallback, (3) no machine price lever. Build gated on owner GO.

# Zero-Human-Ops Geographic Dispatch at N-Lakes Scale

## 1. Verdict

The proposed geo design (adding `service_lakes[]` + `base_lat/lng`, a lake predicate in `isEligible`, distance in `rankCrews`, and a distance-ranked claim board) **does not survive a hard zero-human-ops constraint** — not because the geo logic is wrong, but because every dead-end it creates drains into the **same single human gate the design never touches**: `approveCrew()` in `crews-actions.ts:44`, which is `assertOps()`-gated and requires a human to flip `vendors.status → 'active'` and hand-type `daily_capacity`. The geo predicate actually makes cold-start **worse** (a crew that does the service but didn't tick this lake's box is now filtered out), so on every one of the 20–40 new lakes the first job dead-ends at `reasonNoFit: 'no_crew_for_service'`, sits `requested`, and escalates via the nightly ops SMS (`automation.ts` ~303). **The design breaks in exactly three places today:** (a) crew activation is human — so no supply-side rung of any ladder can ever close on a cold lake; (b) the terminal fallback is an ops SMS + `getNeedsAttention` bucket, not a customer/crew self-service state; (c) pricing has no machine lever (`MARGIN_FLOOR = 0.25` is a hardcoded constant, `book/dispatch.ts:10`), so `below_floor` — the dominant terminal state on thin/far lakes — is a human "adjust" decision. Fix those three and the ladder below is genuinely ops-free down to a small, honest, self-service floor.

---

## 2. The Escalation Ladder (machine-only, deterministic)

One decision tree the machine runs for **every** job at booking, then re-runs on an intraday clock. No rung notifies ops. `reasonNoFit` values map 1:1 to the existing engine.

| # | Trigger (engine state) | Automated action | Time / threshold | Machine notifies |
|---|---|---|---|---|
| 0 | `decideDispatch` → `ok` | Assign winner, `status='scheduled'`, write vendor_cost/margin | Synchronous at booking | **Customer**: "Crew confirmed for `<date>`" |
| 1 | `all_full_or_blocked` **at submit** (race) | Return nearest open in-lake dates for 1-tap rebook; offer date-waitlist | Synchronous | **Customer**: open-date picker |
| 2 | `below_floor` **and** a nearby date has a floor-clearing crew | Auto-offer nearest floor-clearing dates (dry-run `decideDispatch` per date) | Synchronous | **Customer**: "Your day is tight — these days are open now" |
| 3 | `below_floor` rate-structural (no date clears) | Compute min customer-price uplift to clear floor for nearest crew; present as Rule-1-safe scarcity surcharge (customer sees only the higher all-in price) | Synchronous; uplift bounded by global surge ceiling (§5) | **Customer**: accept/decline premium |
| 4 | `no_qualifying_rate` (crew opted in, no positive rate) | Do **not** count as capacity; fire self-serve rate prompt to that crew | Synchronous | **Crew**: "Set your rate for `<service>` on `<lake>` to receive jobs" |
| 5 | `no_crew_for_service` **but** ≥1 active crew serves an adjacent lake within radius | Post to **distance-ranked claim board** as a claimable invite (never a forced push); widen radius each cycle | Every 30 min; radius +R per cycle to `MAX_RADIUS` | **Crews** (nearest first): claimable offer |
| 6 | Claim board unclaimed at cutoff, non-water-work | Customer self-service fork: date-flex / invite-your-own-contractor / join per-lake waitlist | 24 h after rung 5 opens | **Customer**: 3-way self-serve fork |
| 7 | Water-work inside lake pull-deadline window, any `reasonNoFit` | **Skip nightly cadence entirely**: jump straight to widest-radius claim board + step-wise rate sweeten (within surge ceiling) + immediate customer prompt | Fires at booking, compressed cadence keyed to `pull_deadline` countdown (Rule 7: never sit) | **Crews** (wide) + **Customer** (urgent options) |
| 8 | All rungs exhausted / customer non-response by SLA | Auto-cancel with automated refund (tokenized reversal), honest message; leave standing per-lake recruit signal | SLA expiry (per-service; compressed for Rule 7) | **Customer**: "We couldn't crew `<lake>` yet — no charge" |

**Concurrency backstop** (existing `book/dispatch.ts:229`): on capacity-race rollback, **re-invoke the ladder synchronously** for the released job (rung 5+), never wait for nightly. **Recovery notify**: any `requested → scheduled` transition on a previously-stalled job fires a "crew confirmed" text (currently missing).

---

## 3. New-Lake Cold Start (automated supply bootstrap)

A lake begins with zero crews. Sequence, all machine-driven:

1. **Demand is always capturable.** `getServiceAvailability` must stop returning an all-full calendar for a supplyless lake. A booking on an uncrewed lake creates a `requested` job in a customer-visible **"Finding a crew"** state (not a dead grid, not a false "booked"). That job row *is* the waitlist row and the recruit signal.
2. **Two-sided acquisition fires immediately** (no ops SMS): 
   - *Demand→supply*: surface `inviteMyContractor` (existing `book/contractor-actions.ts`) with a bounty ("invite a crew, we auto-book the day they onboard").
   - *Supply pull*: per-lake-per-service **automated recruit broadcast** (templated email/SMS to contractors whose `base_lat/lng` is within an expanding radius) + public self-onboard link.
3. **Crew self-onboards** (existing `vendor/onboarding-actions.ts`): claim invite → upload COI/W-9 → self-declare `service_types`, `work_days`, **`daily_capacity`** (new self-serve field, clamped 1–20 by the existing `validCapacity`), self-set rate.
4. **Activation is automated** — this is the load-bearing change. On the onboarding-complete write, a service-role path re-runs the **already-fully-mechanical** `assertRoutable()` (COI present + W-9 present + `coi_expiry` in the future — `crews-actions.ts:24-37`) and, on pass, flips `status='active'` under a **probation flag**. No `assertOps()` on this path. `approveCrew` survives only as a manual suspend/override tool, never the default.
5. **Waitlist auto-converts**: crew activation (or a new `service_lakes` opt-in) triggers a re-waterfall over **all future `requested` jobs** on that crew's lakes (not just tomorrow's date), auto-assigns, and texts the waiting customers.

**The one honest gate that cannot be a bare file-presence check: document authenticity.** `assertRoutable` only proves a file exists and a *self-typed* expiry is future — it cannot tell a real insurer certificate from a doctored PDF. Two defensible options, in order of preference:

- **Preferred (truly zero-LakeLife-human):** auto-activation gates on a **third-party verification callback** (COI/ACORD verification API + IRS TIN-match on the W-9). The "human" is the external verifier's, not ops. A failed/unreadable doc puts the crew in a crew-facing "fix your docs" self-serve state — never an ops queue.
- **Interim (defensible, bounded):** auto-activate on file-presence + future expiry into **machine-only probation**: rank-throttled, gate-payout-held (§5), and **auto-demotable** by machine signals (no-shows, photo-gate failures, homeowner post-job confirmation). Payout is withheld, not just reputation — so a bad actor carries no unbacked liability. Document explicitly that this accepts fraud risk until the verification API lands; do **not** substitute a human photo-audit (that re-creates per-job ops review and scales worse than the gate it replaced).

---

## 4. Hidden-Human Kill List

| Current touchpoint | File / location | Replacement |
|---|---|---|
| **Ops approves crew** (`approveCrew`, `assertOps`-gated, human types capacity) | `crews-actions.ts:44-62` | Auto-activation on machine `assertRoutable` pass (+ verification callback, §3), probation flag, crew-self-declared `daily_capacity`. `approveCrew` demoted to manual override only. |
| **Ops sets/raises capacity** (`setCrewCapacity`) | `crews-actions.ts:95` | Crew self-service `daily_capacity` in onboarding + vendor UI (same pattern as rates/work_days). Retire the ops action. |
| **Nightly "N jobs need a crew" SMS to all ops** | `automation.ts` ~303-308 (`revalidateAssignments`) | **Delete the branch.** Replace with: unfilled `requested` job auto-posts to the distance-ranked claim board + per-lake recruit broadcast (crews) and the customer self-serve fork (§2 rungs 5–8). |
| **Ops "needs attention" queue** | `dispatch-data.ts:49` (`getNeedsAttention`) | Remove the recruit/below-floor buckets. State lives on the customer's request page ("Finding a crew" / "No crew yet — auto-refund on `<date>` unless claimed") and the crew claim board. |
| **Ops Reassign / Retry** (human re-runs same engine, adds no info) | `ops/dispatch-actions.ts` (`retryAssign`, `setPreferredCrew`) | Intraday clock re-runs the ladder automatically; preferred-crew steering becomes the homeowner's own `inviteMyContractor` self-service. |
| **Ops "adjust price"** (the "or adjust" half of the SMS) | implied by `below_floor` → SMS | Machine surcharge within a global surge ceiling (§5), presented to the **customer** as accept/decline; no human repricing. |
| **Human COI eyeball** (authenticity ride-along inside `approveCrew`) | `crews-actions.ts` + `onboarding-actions.ts` | Third-party COI/TIN verification callback (§3), or bounded machine probation with payout-hold. |

---

## 5. Honest Floor (self-service, not ops-service) + one-time owner guardrails

**What genuinely cannot be fully automated — and how each becomes self-service:**

- **Document authenticity / business legitimacy.** Not a scheduling problem. → Outsourced to a verification API (external vendor's human, not LakeLife ops); failures route to the **crew's** self-serve "fix your docs" flow.
- **A price the customer must consent to.** You cannot silently raise a booked all-in price. → The scarcity surcharge (§2 rung 3) is a **customer** accept/decline, never an ops call. Rule 1 holds (customer sees only the higher all-in number; crew sees only its own rate).
- **Genuinely uneconomic / supply-dead job.** The machine can price-flex, widen radius, and recruit, but cannot conjure a crew before a hard freeze. → Terminal is **machine auto-cancel + auto-refund + honest customer message** and a standing recruit signal — never a human scrambling a substitute. The owner must accept "later or nowhere" as the honest zero-ops answer.
- **Lateness / work-quality signal.** Today only a zero-photo ghost is machine-detected. → Add crew arrival timestamp + **homeowner post-job confirmation** (demand-side self-service auditor) feeding per-(vendor, lake) demotion. The customer is the auditor, not ops.

**One-time owner guardrails (set once, machine decides forever):**

1. **`MARGIN_FLOOR`** → move to DB (Rule 8), single global value (default 0.25).
2. **Global surge ceiling** as a *formula*, not a per-lake number: `ceiling = f(crew_drive_distance)` capped by one global max-surge constant, so lakes 4–40 auto-configure on creation. No per-lake pricing entry.
3. **Radius params**: initial claim-board radius `R`, per-cycle widening step, `MAX_RADIUS`, cycle interval (e.g. 30 min) — all global constants; per-lake centroid is **derived** (§6), never hand-entered.
4. **Auto-approve rule**: the verification-pass predicate + default probation `daily_capacity` + probation graduation threshold (N clean photo-gated jobs).
5. **SLA timers**: claim-board cutoff, customer-response window, auto-cancel deadline; compressed multiplier for Rule-7 water-work.
6. **Per-(vendor,lake) demotion threshold** `K` strikes and re-add cooldown.

---

## 6. Build Delta (dependency order)

**Phase A — kill the activation human (unblocks everything; highest severity).**
1. Migration: `vendors.service_lakes text[]`, `vendors.base_lat double precision`, `vendors.base_lng double precision`. Default invite inserts `daily_capacity` → **1** (not 0) (`crews-invite.ts:63`, `contractor-actions.ts:73`). Add `vendors.probation boolean`, `vendors.verified_at timestamptz`.
2. `onboarding-actions.ts`: let crew self-set `daily_capacity` (reuse `validCapacity` clamp) and `service_lakes` (whitelisted against `lakes`); **keep RLS barring the crew from writing its own `status`**.
3. New service-role auto-activation path (edge function or onboarding hook): run `assertRoutable` programmatically; on pass (+ verification callback when available) set `status='active'`, `probation=true`. Gate the coordinate write with a validator (reject 0,0 / out-of-region; edge-of-region lowers confidence, not rejected).
4. Delete `automation.ts` ops-SMS branch (~303-308); retire ops recruit/below-floor buckets in `getNeedsAttention`. `approveCrew`/`setCrewCapacity` → manual override only.

**Phase B — geo predicate + ranking (only meaningful once supply can self-activate).**
5. `dispatch.ts` `isEligible`: add `property.lake_id ∈ crew.service_lakes` (thread `lakeId` through `DispatchInput`/`CrewCandidate`).
6. `rankCrews`: add a **drive-time** key (Directions API, cached per `base × lake-centroid`) ranked **above** route-density for claim-board/widened offers so local idle beats far routed. Derive lake centroid automatically as the geo-median of that lake's geocoded properties — no ops-entered geometry.
7. `getServiceAvailability`: make lake-aware (only in-lake crews contribute capacity) so a full-lake date is never offered; and never render an all-full grid for a supplyless lake — return the "Finding a crew" bookable state instead.

**Phase C — pricing lever (kills `below_floor` human).**
8. Move `MARGIN_FLOOR` to DB (Rule 8). Add distance-derived surge ceiling formula (global constants only). Set `customer_price` once at booking; **never mutate a booked price** — resolve `below_floor` via the customer surcharge accept/decline (rung 3) and the crew-side claim board at `customer_price × (1 − margin_floor_min)`.

**Phase D — the ladder + intraday clock (turns dead-ends into self-service).**
9. New `offers`/claim table with per-rung `due_at`; a **claim server action** mirroring `autoAssignJob`'s guarded write (`UPDATE … WHERE status='requested' AND vendor_id IS NULL`) + post-write capacity re-count + claim-time `isEligible` re-check. First valid claim wins; losers get "already taken."
10. New frequent cron (15–30 min) advancing rungs: `offer_created → widen_radius → sweeten → customer_prompt → auto_cancel`; Rule-7 jobs get compressed intervals and skip nightly. Dead-man's-switch is infra uptime alerting, not an ops work-queue.
11. Customer-facing states + notifications: "Finding a crew," waitlist auto-convert on activation, `requested→scheduled` recovery text, auto-cancel-with-refund terminal.

**Phase E — self-healing data + demotion.**
12. Per-(vendor, lake) strike counter (extend `vendor_no_shows` with `lake_id`); auto-revoke a `service_lakes` entry after `K` strikes-without-offsetting-completion, inside nightly automation — a cold-start hoarder self-evicts with no `suspendCrew`.
13. Self-heal the base coordinate from photo-gated job-completion GPS (rolling median) so a bad onboarding pin auto-corrects; add homeowner post-job confirmation as the quality auditor.

**Critical dependency:** Phase A must land first. Phases B–E are inert or actively harmful (silent auto-cancels a human would have saved) until crew activation is machine-only. Ship the ladder's SMS-deletion (#4) only after auto-activation (#3) exists.
