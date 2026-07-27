-- ============================================================================
-- 0048 — REBUILD POST-CONDITIONS + the two things that only ever existed by hand
--
-- Rebuild verification (2026-07-26) found that a from-scratch replay produced
-- zero SQL errors and a platform that could not operate. Two separate problems:
--
--   1. The seeds were outside the migration set (fixed in 0047).
--   2. The STORAGE BUCKETS were never in any migration at all. They were
--      created by hand in the dashboard. That is the more serious one: rule 2
--      says a job cannot reach 'complete' without its photos, and photos need
--      the private job-photos bucket. On a rebuilt database, uploadJobPhoto
--      fails, so NO job can ever complete and NO payout can ever release. The
--      whole platform is inert and nothing in SQL says why.
--
-- The post-condition check lives here rather than in 0047 on purpose: a guard
-- inside the seeding transaction rolls back its own seeds when it trips.
-- ============================================================================

-- ------------------------------------------------------- STORAGE BUCKETS --
-- Both are PRIVATE and stay private: job photos are a customer's property and
-- crew documents carry EINs and insurance details. Every read in the app is a
-- short-lived signed URL minted server-side after an authorization check
-- (src/lib/photos.ts) — there is no public-URL code path anywhere, and adding
-- one would expose both. 10 MB matches production and is a phone photo with
-- room to spare.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('job-photos',  'job-photos',  false, 10485760),
  ('vendor-docs', 'vendor-docs', false, 10485760)
on conflict (id) do update
  set public = false,                      -- never let a rebuild flip these open
      file_size_limit = excluded.file_size_limit;

-- ------------------------------------------------------- POST-CONDITIONS --
-- Fail loudly rather than boot a platform that looks fine and cannot trade.
-- Thresholds are calibrated against what a CORRECT rebuild actually produces:
-- 20 services of which 10 are active — the 10 storage/component services ship
-- inactive on purpose, waiting on the owner's rates before the launch switch
-- flips. An earlier version of this check required 15 ACTIVE and could
-- therefore never pass; that is why it is written against both numbers now.
do $$
declare
  n_lakes int; n_services int; n_active int; n_noslug int; n_nomins int;
  n_buckets int; n_cap_default int; n_dials int;
begin
  select count(*) into n_lakes    from public.lakes;
  select count(*) into n_services from public.services;
  select count(*) into n_active   from public.services where active;
  select count(*) into n_noslug   from public.lakes    where slug is null;
  select count(*) into n_nomins   from public.services where est_minutes is null;
  select count(*) into n_dials    from public.platform_settings;
  select count(*) into n_buckets  from storage.buckets where id in ('job-photos','vendor-docs');
  -- 0008's backfill silently no-oped on the original rebuild, leaving every
  -- service at the column default. We test that the backfill RAN, not that any
  -- one dial holds a particular value: an operator may legitimately tune a
  -- service TO 5, so only ALL of the probes sitting at the default indicates a
  -- backfill that never applied. (False-alarm caught in re-verification.)
  select count(*) into n_cap_default
    from public.services
   where daily_capacity = 5
     and name in ('Pier install / removal', 'Lawn mowing & trim', 'Spring opening');

  if n_lakes < 3 then
    raise exception 'rebuild check: expected at least 3 lakes, found % — did 0047 run?', n_lakes;
  end if;
  if n_services < 20 then
    raise exception 'rebuild check: expected the full 20-row service menu, found %', n_services;
  end if;
  if n_active < 10 then
    raise exception 'rebuild check: expected at least 10 ACTIVE services, found % — the menu is empty and nothing is bookable', n_active;
  end if;
  if n_noslug > 0 then
    raise exception 'rebuild check: % lake(s) have no slug — every public /lakes/[slug] page would 404', n_noslug;
  end if;
  if n_nomins > 0 then
    raise exception 'rebuild check: % service(s) have no est_minutes — the fleet router has no time budget', n_nomins;
  end if;
  if n_cap_default >= 3 then
    raise exception 'rebuild check: daily_capacity is still the column default on every probed service — 0008''s backfill did not apply';
  end if;
  if n_dials < 34 then
    raise exception 'rebuild check: expected 34 platform_settings dials, found % — pricing rules live in the database (rule 8)', n_dials;
  end if;
  if n_buckets < 2 then
    raise exception 'rebuild check: storage buckets missing — no photos means no job can complete and no crew can be paid';
  end if;
end $$;

-- --------------------------------------- WHAT SQL STILL CANNOT RESTORE --
-- The storage buckets used to be a hand-made artifact that no migration knew
-- about, and a rebuilt platform silently could not trade. These three are the
-- same class of thing and cannot be fixed the same way, because each depends
-- on a secret that must never live in a public repo. So instead of failing a
-- legitimate rebuild, say so loudly in the migration output — a recovery that
-- comes up "green" while its automation is dead is the exact trap 0048 exists
-- to close. See supabase/REBUILD.md.
do $$
declare has_cron boolean;
begin
  select exists (
    select 1 from pg_extension e
     where e.extname = 'pg_cron'
  ) into has_cron;

  raise notice '--------------------------------------------------------------';
  raise notice 'REBUILD OK. Three things SQL cannot restore — do them now:';
  raise notice '  1. The intraday heartbeat. pg_cron installed: %. Nothing is', has_cron;
  raise notice '     scheduled by this migration because the statement embeds';
  raise notice '     CRON_SECRET. Without it there is NO 30-minute sweep:';
  raise notice '     no waitlist retries, no intraday re-homing. REBUILD.md has';
  raise notice '     the exact cron.schedule() call.';
  raise notice '  2. The first ops account. guard_role_change blocks role';
  raise notice '     changes from non-ops, so promote it with the service key.';
  raise notice '  3. GATE_ENCRYPTION_KEY must match the one used when any';
  raise notice '     restored gate codes were written, or they are unreadable.';
  raise notice '--------------------------------------------------------------';
end $$;
