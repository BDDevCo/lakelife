-- ============================================================
--  LakeLife — storage S3: the agreement stamp. WHAT the customer
--  accepted and WHEN, versioned, on the season envelope — the rail
--  the attorney-blessed storage terms slot into (swap the version
--  string, old envelopes keep the version they accepted).
--  Run once. Safe to re-run.
-- ============================================================

alter table public.job_groups
  add column if not exists agreement_version text,
  add column if not exists agreement_accepted_at timestamptz;
