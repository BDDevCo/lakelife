-- ============================================================
--  LakeLife — Phase A: zero-ops crew self-activation + geography.
--  Crews go live WITHOUT an ops approval: they self-declare their
--  daily capacity, the lakes they service, and (optionally) a home
--  base, and a SERVER path flips status→active once their documents
--  pass the mechanical gate (COI + W-9 + a future COI expiry).
--  Ops `approveCrew` survives only as a manual override.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- 1) Geography + a verification timestamp on the crew row.
--    service_lakes = which lakes this crew works (the hard opt-in used by the
--    Phase-B eligibility filter). base_lat/lng = home base for distance ranking
--    (optional; self-heals later from photo-verified job GPS). verified_at =
--    when the docs last cleared the mechanical gate (drives annual re-validation).
alter table public.vendors
  add column if not exists service_lakes uuid[] not null default '{}',
  add column if not exists base_lat double precision,
  add column if not exists base_lng double precision,
  add column if not exists verified_at timestamptz;

-- 2) New invited crews start with a routable default capacity (1), never 0,
--    so a self-activation is never stranded at zero capacity. They set their
--    real number during onboarding.
alter table public.vendors alter column daily_capacity set default 1;

-- 3) Backfill: existing ACTIVE crews implicitly serve every current lake —
--    seed their service_lakes so the Phase-B lake filter won't strand them
--    the day it turns on.
update public.vendors
   set service_lakes = coalesce((select array_agg(id) from public.lakes), '{}')
 where status = 'active'
   and (service_lakes is null or cardinality(service_lakes) = 0);

-- 4) Belt & braces: signed-in clients may still write ONLY work_days directly.
--    The new columns are service-role-only (crews change them through server
--    actions that verify identity — same lock as 0010/0013). Re-assert the
--    revoke after the column adds so no default UPDATE grant leaks in.
revoke update on public.vendors from authenticated, anon;
grant update (work_days) on public.vendors to authenticated;
