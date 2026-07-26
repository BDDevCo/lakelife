-- ============================================================================
-- 0047 — SEEDS AS A MIGRATION: make a from-scratch rebuild actually WORK
--
-- Found by the two-season audit (2026-07-26): every migration replayed onto
-- an empty database without a single SQL error, and the result was still a
-- broken platform — no lakes, half the service menu missing, and three
-- backfills that silently matched zero rows because the data they were meant
-- to fix did not exist yet:
--
--   0008 daily_capacity  -> every service left at the default 5
--   0031 lakes.slug      -> NULL, so every /lakes/[slug] SEO page 404s
--   0042 est_minutes     -> NULL, so the router's time budgets have no basis
--
-- That is the dangerous kind of failure: a green run that yields a subtly
-- wrong database. The seeds lived in supabase/seed/*.sql, outside the
-- migration set, so they only ever ran because a human remembered to paste
-- them. This migration folds them in — seeds FIRST, then the three backfills
-- re-issued — so `migrate` alone produces a database the app can boot on.
--
-- Everything here is idempotent: the lakes upsert by name, the services
-- upsert by name (the unique index is created below, before it is relied on),
-- and each backfill only fills what is still empty.
--
-- The post-condition CHECK deliberately lives in 0048, NOT here. A guard in
-- this file runs inside this file's transaction, so a tripped check rolls back
-- the very seeds it was meant to protect — leaving the operator with an empty
-- menu AND an error, which is the exact bug this migration exists to fix.
-- (Caught by the rebuild verification, 2026-07-26.)
-- ============================================================================

-- ---------------------------------------------------------------- LAKES --
insert into public.lakes (name, ice_out_actual, hard_freeze_est, pull_deadline) values
  ('Big Long Lake',   date '2026-03-21', date '2026-11-22', date '2026-11-14'),
  ('Pretty Lake',     date '2026-03-24', date '2026-11-20', date '2026-11-12'),
  ('Big Turkey Lake', date '2026-03-19', date '2026-11-24', date '2026-11-16')
on conflict (name) do update
  set ice_out_actual  = excluded.ice_out_actual,
      hard_freeze_est = excluded.hard_freeze_est,
      pull_deadline   = excluded.pull_deadline;

-- Sanity check: pull deadline must equal freeze minus 8 days.
do $$
declare bad int;
begin
  select count(*) into bad from public.lakes
   where pull_deadline <> hard_freeze_est - 8;
  if bad > 0 then
    raise exception 'Pull deadline rule broken on % lake(s)', bad;
  end if;
end $$;

-- ------------------------------------------------------------- SERVICES --
create unique index if not exists services_name_uidx on public.services (name);

insert into public.services
  (name, pricing_model, base, unit_rate, frequency_options, min_photos, is_water_work, band_pricing, active)
values
  -- Seasonal (flat)
  ('Spring opening', 'flat', 430, 0,
   array['One-time (spring)'], 3, false, null, true),
  ('Fall winterization', 'flat', 485, 0,
   array['One-time (fall)'], 4, false, null, true),

  -- Pier: base + rate × sections
  ('Pier install / removal', 'per_section', 220, 48,
   array['Install (spring)','Removal (fall)'], 2, true,
   '{"count_field":"pier_sections"}'::jsonb, true),

  -- Boat lift: rate × lifts (floored at 1, per prototype)
  ('Boat lift set / pull', 'per_section', 0, 495,
   array['Set (spring)','Pull (fall)'], 2, true,
   '{"count_field":"boat_lifts","min_count":1}'::jsonb, true),

  -- Jet ski winterize & store: rate × number of jet skis (PLACEHOLDER rate)
  ('Jet ski winterize & store', 'per_section', 0, 350,
   array['Winterize + store','De-winterize + launch'], 2, true,
   '{"count_field":"jet_skis"}'::jsonb, true),

  -- PWC lift set/pull: rate × number of PWC lifts (PLACEHOLDER rate)
  ('PWC lift set / pull', 'per_section', 0, 165,
   array['Set (spring)','Pull (fall)'], 2, true,
   '{"count_field":"pwc_lifts"}'::jsonb, true),

  -- Boat storage & winterize: rate × total feet
  ('Boat storage & winterize', 'per_foot', 0, 50,
   array['Winterize + store','De-winterize + launch'], 3, true, null, true),

  -- Water toys: base + per-lift + per-toy
  ('Water toy prep & storage', 'flat', 120, 0,
   array['Store (fall)','Deploy (spring)'], 1, true,
   '{"add":[{"field":"toy_lifts","rate":60},{"field":"toys_count","rate":15}]}'::jsonb, true),

  -- Lawn: band price
  ('Lawn mowing & trim', 'band', 0, 0,
   array['Weekly','Every 2 weeks'], 1, false,
   '{"small":65,"medium":85,"large":110}'::jsonb, true),

  -- Housekeeping: price by square-footage tier
  ('Housekeeping', 'per_sqft_band', 0, 0,
   array['Weekly','Every 2 weeks','Before each arrival'], 2, false,
   '{"tiers":[{"max":1800,"price":80},{"max":2800,"price":95},{"max":null,"price":120}]}'::jsonb, true)
on conflict (name) do update set
  pricing_model     = excluded.pricing_model,
  base              = excluded.base,
  unit_rate         = excluded.unit_rate,
  frequency_options = excluded.frequency_options,
  min_photos        = excluded.min_photos,
  is_water_work     = excluded.is_water_work,
  band_pricing      = excluded.band_pricing,
  active            = excluded.active;

-- ------------------------------------------- BACKFILLS, RE-ISSUED IN ORDER --
-- These three ran in 0008 / 0031 / 0042 against an empty table on a rebuild.
-- Re-issued here, now that the rows they describe actually exist. Guarded so
-- they never clobber a value an operator has since tuned by hand.

-- 0008: per-service daily capacity (the dispatcher's per-day ceiling).
update public.services set daily_capacity = case name
  when 'Pier install / removal'      then 3
  when 'Boat lift set / pull'        then 4
  when 'PWC lift set / pull'         then 4
  when 'Boat storage & winterize'    then 4
  when 'Jet ski winterize & store'   then 4
  when 'Water toy prep & storage'    then 6
  when 'Lawn mowing & trim'          then 8
  when 'Housekeeping'                then 5
  when 'Spring opening'              then 3
  when 'Fall winterization'          then 3
  else daily_capacity end
where daily_capacity = 5; -- only services still at the column default

-- 0031: lake slugs power the public SEO pages.
update public.lakes
   set slug = regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')
 where slug is null;

-- 0042: est_minutes is what the fleet router budgets a day against (rule 8 —
-- the dial lives in the database, and the nightly learner tunes it from real
-- durations, so this is only the starting estimate).
update public.services set est_minutes = v.m
from (values
  ('Lawn mowing & trim', 45),
  ('Housekeeping', 90),
  ('Pier install / removal', 180),
  ('Boat lift set / pull', 90),
  ('PWC lift set / pull', 60),
  ('Jet ski winterize & store', 60),
  ('Fall winterization', 120),
  ('Spring opening', 120),
  ('Water toy prep & storage', 60),
  ('Boat storage & winterize', 120),
  ('Boat haul-out (we pick it up)', 60),
  ('Boat return & splash', 60),
  ('Boat winterization (shop)', 90),
  ('Spring de-winterize & test run', 90),
  ('Winter storage — indoor', 30),
  ('Winter storage — outdoor', 30),
  ('Shrink wrap', 90),
  ('Battery care (pull, tend, reinstall)', 30),
  ('Engine oil & filter change', 45),
  ('Storage overstay (per-diem)', 0)
) as v(n, m)
where services.name = v.n and services.est_minutes is null;
