-- One EARNING per job stays ironclad; clawback ADJUSTMENTS may repeat
-- (one per partial refund) without tripping the money-uniqueness guard.
drop index if exists public.payouts_one_per_job;
create unique index if not exists payouts_one_earning_per_job
  on public.payouts (job_id) where (job_id is not null and kind = 'earning');
