-- 0083 — THE SCHEDULE LEARNS WHAT THE PRICE ALREADY KNEW.
--
-- Pricing has always scaled with the property. The schedule never did: every
-- service carried one flat est_minutes that never moved. A pier growing from
-- 8 sections to 12 moved the price $604 -> $796 and moved the schedule by
-- nothing, so the crew absorbed the difference in the evening. Worse, at a
-- flat 45 minutes the machine believed a crew could mow TWELVE large lawns
-- between 7am and 4pm. The real number is six.
--
-- Three things land here, all of them DIALS IN THE DATABASE rather than
-- constants in code, for the same reason prices live here (rule 8).

-- ---------------------------------------------------- how long, by size ---
alter table public.services
  add column if not exists duration_bands jsonb;

comment on column public.services.duration_bands is
  'How long this service takes, by size. Two shapes, mirroring band_pricing: '
  '{"rungs":[{"max":5,"minutes":120},...,{"max":null,"minutes":330}]} for a '
  'counted or measured size, or {"by_band":{"small":30,"medium":50,"large":90}} '
  'for a named one. The size is read off band_pricing.count_field — the SAME '
  'declaration the price uses, so time and money can never drift apart. '
  'NULL means "no ladder yet"; est_minutes is then used unchanged. '
  'An unknown size takes the LONGEST rung: money rounds down, time rounds up.';

-- The ladder must TERMINATE, or a size above every rung has no answer.
-- Expressed with jsonb containment because a check constraint may not carry a
-- subquery: an array contains {"max": null} when some element does.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'services_duration_ladder_terminates') then
    alter table public.services add constraint services_duration_ladder_terminates
      check (
        duration_bands is null
        or duration_bands ? 'by_band'
        or (
          jsonb_typeof(duration_bands -> 'rungs') = 'array'
          and jsonb_array_length(duration_bands -> 'rungs') > 0
          and (duration_bands -> 'rungs') @> '[{"max": null}]'::jsonb
        )
      );
  end if;
end $$;

-- ------------------------------------------- what THIS job was budgeted ---
-- Stamped when the job is booked, exactly as customer_price already is, so a
-- later edit to a dial cannot silently rewrite the past. Null falls back to
-- the service's est_minutes — never to zero, which is a job the time budget
-- cannot see.
alter table public.jobs
  add column if not exists est_minutes integer;

comment on column public.jobs.est_minutes is
  'Minutes budgeted for THIS visit, computed from the property at booking '
  'time and frozen here. Null = read services.est_minutes instead.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_est_minutes_is_positive') then
    alter table public.jobs add constraint jobs_est_minutes_is_positive
      check (est_minutes is null or (est_minutes > 0 and est_minutes <= 480));
  end if;
end $$;

-- --------------------------------------------------- the day we may sell ---
-- 7am start, 4pm cutoff. This governs what LAKELIFE PUTS INTO a crew's day,
-- not what a crew may do — they may work till eight on their own jobs; we
-- simply never fill past four. That is the protection being asked for, and it
-- avoids setting an independent contractor's working hours.
create table if not exists public.platform_dials (
  id                 boolean primary key default true,
  sell_start_hour    integer not null default 7,
  sell_end_hour      integer not null default 16,
  updated_at         timestamptz not null default now(),
  constraint platform_dials_is_one_row check (id),
  constraint platform_dials_day_runs_forwards check (sell_end_hour > sell_start_hour),
  constraint platform_dials_hours_are_real
    check (sell_start_hour between 0 and 23 and sell_end_hour between 1 and 24)
);

comment on table public.platform_dials is
  'One row. The hours LakeLife will SELL work into. Crews may open later or '
  'close earlier; they may never push the close later.';

insert into public.platform_dials (id) values (true) on conflict (id) do nothing;

alter table public.platform_dials enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='platform_dials'
                    and policyname='platform_dials_read') then
    create policy platform_dials_read on public.platform_dials for select to authenticated using (true);
  end if;
end $$;

-- Readable by a signed-in person (a crew should be able to see the window
-- they are scheduled against); writable by nobody but the service role.
revoke insert, update, delete on public.platform_dials from authenticated, anon;

-- The default crew window said 17 — five o'clock, not four. Every crew that
-- had not set one was being sold an hour past the cutoff.
alter table public.crew_units alter column work_end set default 16;

update public.crew_units set work_end = 16 where work_end > 16;

-- --------------------------------------------------------- the ladders ----
-- Seeded from the rules already in this table, so time and price agree from
-- the first minute. These are the owner's to tune on an ops screen.
update public.services set duration_bands =
  '{"rungs":[{"max":5,"minutes":120},{"max":9,"minutes":180},{"max":13,"minutes":255},{"max":null,"minutes":330}]}'::jsonb
 where name = 'Pier install / removal';

update public.services set duration_bands =
  '{"by_band":{"small":30,"medium":50,"large":90}}'::jsonb
 where name = 'Lawn mowing & trim';

update public.services set duration_bands =
  '{"rungs":[{"max":1800,"minutes":75},{"max":2800,"minutes":105},{"max":null,"minutes":150}]}'::jsonb
 where name = 'Housekeeping';

update public.services set duration_bands =
  '{"rungs":[{"max":1,"minutes":75},{"max":2,"minutes":135},{"max":null,"minutes":195}]}'::jsonb
 where name = 'Boat lift set / pull';

update public.services set duration_bands =
  '{"rungs":[{"max":20,"minutes":90},{"max":26,"minutes":120},{"max":null,"minutes":165}]}'::jsonb
 where name = 'Boat storage & winterize';

update public.services set duration_bands =
  '{"rungs":[{"max":1,"minutes":45},{"max":2,"minutes":75},{"max":null,"minutes":110}]}'::jsonb
 where name = 'Jet ski winterize & store';

update public.services set duration_bands =
  '{"rungs":[{"max":1,"minutes":45},{"max":2,"minutes":75},{"max":null,"minutes":110}]}'::jsonb
 where name = 'PWC lift set / pull';

-- ------------------------------------------------------ post-conditions ----
-- Prove it by ATTEMPTING each violation, not by trusting that it applied.
do $$
declare n int; ok boolean;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='services' and column_name='duration_bands';
  if n <> 1 then raise exception '0083: services.duration_bands missing'; end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='jobs' and column_name='est_minutes';
  if n <> 1 then raise exception '0083: jobs.est_minutes missing'; end if;

  ok := false;
  begin
    update public.services
       set duration_bands = '{"rungs":[{"max":5,"minutes":100}]}'::jsonb
     where name = 'Pier install / removal';
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0083: a ladder with no terminating rung was accepted'; end if;

  ok := false;
  begin
    update public.platform_dials set sell_end_hour = 5 where id;
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0083: a backwards sellable day was accepted'; end if;

  select count(*) into n from public.platform_dials where sell_start_hour = 7 and sell_end_hour = 16;
  if n <> 1 then raise exception '0083: platform_dials is not one row of 7-to-16'; end if;

  select count(*) into n from public.crew_units where work_end > 16;
  if n <> 0 then raise exception '0083: % crew unit(s) still sell past the cutoff', n; end if;

  select count(*) into n from public.services
   where active = true
     and pricing_model in ('per_section','band','per_sqft_band','per_foot')
     and duration_bands is null;
  if n <> 0 then raise exception '0083: % size-priced service(s) still have no ladder', n; end if;
end $$;
