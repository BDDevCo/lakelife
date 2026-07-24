# Refunds — the last money-loop gap

Owner directive (2026-07-23): "make the platform sing." The sim report, two
review panels, and ToS §7.6 all point at the same missing piece: money can
flow IN and OUT to crews, but never BACK to a customer. Every real service
business needs that in week one.

## Shape (v1, mock-processor — same seam as charge)

- **refunds ledger** (0043): one row per refund — invoice, job, amount,
  crew_clawback, reason, ops author, processor ref. Ops-only at RLS,
  written only by the server action. The ledger IS the audit trail; invoice
  status flips to `refunded` only when cumulative refunds reach the full
  cash captured (partial refunds leave `paid` + ledger rows).
- **Cash only, capped.** Refundable = cash actually captured on the
  invoice's payment minus refunds already issued. Credits a customer spent
  on the bill stay spent in v1 (ops can re-grant manually; auto-regrant is
  v1.1) — this keeps the credits ledger append-only and the refund math
  un-gameable.
- **Crew clawback (ToS §7.6):** default = the refund's proportional share
  of the crew's cut — round2(refund × vendor_cost / customer_price),
  clamped to what the crew was actually owed. Ops can override the number
  (crew-fault refunds may claw more, goodwill refunds zero). Mechanics:
  - payout still unbatched (`released`) → reduce it in place (to zero =
    status `clawed`).
  - payout already batched/paid → insert a NEGATIVE `adjustment` payout
    row that nets against the crew's next batch — exactly the "recovery by
    deduction from future payouts" the terms promise. Month-end and
    early-pay batch builders must sum adjustments (they claim
    `status='released'` rows; adjustments are created `released` with
    negative amount so they're claimed automatically — verified against
    both batch builders).
- **Referral unwind:** accrued (un-matured) referral earnings sourced from
  the refunded job flip to `void` proportionally-simple v1: full void when
  the refund is full, untouched when partial (partial-proration is v1.1 —
  documented, not silent). Matured/spent earnings are left alone (clawing
  spent credits creates negative-balance chaos; the trigger guard would
  reject it anyway).
- **Processor seam:** `LakeLifePayments.refund(processorRef, amount)` mock
  with the same result shape a real adapter will have (`{ok, ref}` /
  deterministic failure when the ref starts `rf_fail`). The real-processor
  swap later touches ONLY lib/payments.ts, same as charge.
- **Notifications:** customer gets an SMS + receipt email ("$X is on its
  way back to your card"); crew gets an SMS only when clawed ("$Y adjusted
  per the service terms — reply here with questions").
- **Never**: refund > captured cash, refund a non-paid invoice, double
  refund via concurrent taps (guarded update on a running total), crew
  clawback > what the crew was owed on the job. Margin/price never leaks
  crew-side (the crew sees THEIR adjustment, never the customer refund
  amount — rule 1 applies in reverse).

## Also in this phase (polish)

- Vendor Today list shows the truck name on each job (route join) so a
  multi-truck contractor's list finally reads by truck.
- Truck-down self-heal: deactivating a truck rebuilds that vendor's routes
  for today + tomorrow automatically — zero-ops mid-day recovery.
- storage_stays.boat_label populated at booking (sim-report item).
- Season-gate defense-in-depth on the ops manual-assign path (sim-report
  item: gate was booking-time-only by design; ops override now re-checks).
