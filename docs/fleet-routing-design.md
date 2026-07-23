# Fleet Routing — crew units, per-truck routes, time-budget capacity

Owner directive (2026-07-23): contractors scale by adding crews (employees).
One company can run N trucks a day across N lakes. Routing, capacity, and
the morning texts must see trucks; money, liability, and standing must keep
seeing ONE business.

## The split

**Business layer — `vendors` (unchanged, one per contractor):** rate card,
COI + EIN, ToS acceptance, payout account, score/standing, lake standing,
claim-board identity, 1099 relationship. No per-truck rates, ever — rates
per truck would fragment pricing and invite rule-1 adjacent leakage.

**Operational layer — `crew_units` (N per vendor):** name ("Truck 2 —
Mike"), its own phone (route text goes straight to the crew lead; no new
logins/accounts), jobs-per-day capacity, working hours (lake-time, whole
hours), optional own start point (falls back to the vendor base). Vendor
manages their trucks self-serve in the portal — zero ops involvement.

## Backward-compat invariant (the load-bearing rule)

A vendor with ZERO crew_units rows behaves EXACTLY as today: legacy
`daily_capacity` count, one route, one SMS to the vendor phone, no time
budget. Every fleet feature activates only when units exist. Existing
contractors notice nothing until they add a truck.

## Routing (lib/fleet.ts — pure, tested)

1. Cluster the vendor's day by lake.
2. Assign whole clusters to trucks greedily (largest cluster → truck with
   most remaining capacity); clusters bigger than any single truck split
   along their drive order. Nobody criss-crosses lakes needlessly.
3. Per truck: start at the truck's base (→ vendor base → northernmost
   stop), nearest-neighbor order, drive estimate INCLUDES the base→first
   and last→base legs (v1 ignored both). Same 1.6 min/km + 2 min/hop
   heuristic as v1; Google Directions API is a deliberate deferral (needs
   billing enabled on the key — owner action) and slots in behind the same
   function.
4. `workMinutes` = Σ per-service durations + drive; `fitsHours` flags a
   truck whose day busts its window. Never silently dropped: overflow and
   hours-bust surface to the vendor and ops.

## Time-budget capacity (dispatch)

Per-service durations live in `services.est_minutes` (rule 8 — tune in the
DB, no deploy). With units: vendor job cap = Σ active units' capacity, and
a minute budget = Σ units' (end − start) × 60. A day is `day_full` when
EITHER the job count busts the cap OR assigned minutes + the new job's
minutes + a drive overhead allowance bust the minute budget. Nine
20-minute mows fit where nine 3-hour pier installs never could. Without
units: count-based, exactly as today (budget = null → check disabled).

## Money/ops surfaces

- routes rows gain `crew_unit_id`, `unit_name`, `drive_km`; ops Routes view
  shows per-truck rows + est miles + est fuel (miles × `fuel_cost_per_mile`
  dial — display-only economics, helps the recruiting/menu conversation).
- Morning SMS goes per truck to the unit phone (fallback: vendor phone).

## Dials (rule 8)

`services.est_minutes` per service · `fuel_cost_per_mile` 0.65 ·
drive overhead allowance 15% (constant in code, param in the pure fn).

## Deferred deliberately

- Google Directions API drive times (env-gated swap; needs owner billing).
- Truck-phone Twilio Verify (review finding, 2026-07-23): route texts carry
  the day's stop map, and a truck phone is free-typed. v1 mitigation: the
  number gets an enrollment SMS the moment it's saved, so a typo surfaces
  on day one instead of silently receiving itineraries. Full Verify
  code-entry lands when crew volume justifies the friction.
- Per-truck skill tags (pier team vs mow team) — until a real contractor
  needs it; today capability is vendor-level via rate cards.
- Crew-member logins (photos still upload via the vendor login).
- Day-of truck-down reshuffle UI (vendor deactivates the unit; next
  nightly rebuild reroutes; mid-day rebuild is one button later).
- Per-unit strike attribution — standing stays at the business.
