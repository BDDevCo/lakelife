-- ============================================================
--  LakeLife — storage S2: persist the SPRING selection on the season
--  envelope instead of creating a dateless spring job now. The spring
--  job is born at ice-out (S4) from this recipe — so the waitlist,
--  expiry and rush machinery never see a phantom far-future job.
--  spring_quote is the price PROMISED at booking (quoted now, billed
--  at splash; per-diem overage rides on top per the dials).
--  Run once. Safe to re-run.
-- ============================================================

alter table public.job_groups
  add column if not exists spring_service_ids uuid[] not null default '{}',
  add column if not exists spring_quote numeric not null default 0,
  add column if not exists fall_job_id uuid references public.jobs(id) on delete set null;
