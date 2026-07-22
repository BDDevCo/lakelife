-- ============================================================
--  LakeLife — money-integrity uniqueness (adversarial review B1).
--  Application code guards every payout/charge with check-then-insert,
--  but two writers racing (a customer cancel vs the nightly fee
--  reconciler, or a manually-triggered nightly) could each pass the
--  check. The DATABASE is the last line: one payout per job, one
--  captured payment per invoice — ever.
--  Run once. Safe to re-run.
-- ============================================================

create unique index if not exists payouts_one_per_job
  on public.payouts (job_id)
  where job_id is not null;

create unique index if not exists payments_one_capture_per_invoice
  on public.payments (invoice_id)
  where status = 'captured';
