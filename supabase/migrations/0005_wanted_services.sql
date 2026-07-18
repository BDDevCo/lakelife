-- ============================================================
--  LakeLife — remember which services each customer picked.
--  Service-first setup: a homeowner chooses the services that fit
--  their place (a near-the-lake home may want only mowing +
--  housekeeping and never see pier questions).
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

alter table public.property_profile
  add column if not exists wanted_services text[] default '{}';
