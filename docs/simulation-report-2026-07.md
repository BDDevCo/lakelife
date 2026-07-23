# Two-Season Simulation Report — 2026-07-23

**Scope:** 51 simulated people (40 homeowners, 10 crew archetypes, 1 HOA), 3 lakes,
56 crew rate cards, ~150 jobs, 15 storage envelopes, 2 compressed seasons —
grunt agents driving the REAL engine through a gated driver, a manager agent
auditing invariants after every wave, fixes applied between waves. Production
DB with hard guardrails (null phones = zero SMS; zz-sim scoping; baseline
checksums). Fully torn down: final counts match the pre-sim baseline exactly.

## Bugs found and FIXED (all pushed: 669f1dd, f9e88f3)
1. **$0 zero-unit bookings** — profile wants a per-unit service, owns 0 units →
   $0 unassignable job pollutes waitlist demand. createBooking now refuses
   with the honest "update your profile" message.
2. **Self-heal was one day wide** — a COI-lapsed crew kept far-future jobs
   until each eve. Nightly now sweeps the 60-day forward book.
3. **Referral "payouts" moved no money** — flipped paid with no bank and no
   batch artifact. Now: bank required; real payout_batches row; full unwind
   on failure.
4. **HOA earned spendable credits** instead of month-end donations. Maturation
   now recognizes lakes.hoa_user_id.
5. **Double-pay guard** — an earning credited as credits can never also ride a
   bank batch (user_credits.earning_id linkage checked at batch time).
6. **Misleading refusal** — partial-coverage lake now says
   no_full_coverage_crew, not "no crew serves this lake."

## What held under fire (no fixes needed)
- Dispatch legality: 0 violations across ~100 assignments; margins 29–45%,
  never below floor; below-floor crew and $0-rate crew got zero jobs ever.
- Capacity: no crew over daily cap on any date, including a concurrent
  double-book race (loser honestly requeued, crew ended exactly at cap).
- Custody: the 60-ft barn NEVER overcommitted under an overflow storm; feet
  freed on release; two-season histories intact per property.
- Money: every invoice = job price; paid ⇔ captured (minus credits); payout =
  crew cost; batch sums exact; credits never negative; single-level referrals
  held (zero second-level accruals); declined cards → invoices due, crews
  still paid for photo-verified work, reconcile retried idempotently.
- Storage seasons: births exactly-once (unique index), sticky to the barn,
  per-diem penny-exact ($530 = 53 days × $10 as its own bill line), terminal
  cascades orphan-free.
- Standing: strikes lake-stamped, completions offset misses, demotion emptied
  the crew's lake and stuck; ToS gate held at the real door (browser-proven).
- Payout rails end-to-end in the browser: 2% early pull exact; POST-only ACH
  export (GET correctly refused); 8 batches exported, $22,104.83.

## Open items for the owner / backlog
- **Season gate is booking-time only** (by design). Consider defense-in-depth
  on ops-side write paths (manual reschedule, future bulk tools).
- **Otter-pier-class capability gaps**: post-demotion a lake can silently
  strand a service (only remaining crew below floor) — Margin Health shows it;
  consider an ops alert when a service×lake hits 0 profitable crews.
- **Recruiting signal**: no_full_coverage_crew and no_custody_crew rows are
  recruiting gold — surface counts on ops dashboard (backlog).
- storage_stays.boat_label never populated (cosmetic, S5).
- Payout-before-collection is BY DESIGN (photo gate releases payout) —
  flagged twice by agents; owner has confirmed the posture previously.
- **Rotate CRON_SECRET** (leaked into sim agent transcripts): update Vercel
  env + pg_cron job together.
