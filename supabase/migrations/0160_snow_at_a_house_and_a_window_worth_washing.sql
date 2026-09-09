-- ============================================================================
-- 0160 — SNOW AT A HOUSE, AND A WINDOW WORTH WASHING
--
-- The two service rows. Both land INACTIVE and UNPRICED, on purpose: the owner
-- has not given the numbers, and an unpriced service that is live is how a $0
-- booking happens (0115 — zeroing a global price made every unpatched call
-- site silently return $0, and it cost three money bugs).
--
-- 0159 put the two profile facts in place with all four of their doorways.
-- This adds the rows that read them, and nothing else changes: no crew can be
-- eligible, no tile can appear, no price can be quoted.
--
-- ------------------------------------------------ the twin, not a rewrite ---
--
-- 'Snow clearing — roads & common drives' (0144) STAYS EXACTLY AS IT IS. That
-- one is park_only: a park's roads and shared drives, priced flat per push by
-- the park. This is the lake-home twin, priced by the size of one household's
-- driveway — the same shape the catalogue already uses for mowing, where
-- 'Lawn mowing & trim' and 'Park grounds mowing & trim' sit side by side and
-- price completely differently. Two services, because they are two jobs.
--
-- NOT park_bookable, deliberately. A park could plausibly want per-lot snow
-- one day, but `withParkRate` overlays only `base` and `unit_rate` and never
-- `band_pricing` — so a park would silently inherit the global band ladder,
-- which is [[park-rates-never-combine]] violated by omission. That needs its
-- own build; it is not a flag flip.
--
-- ------------------------------- every column stated, and why that matters --
--
-- A `services` row inherits four defaults that are each wrong here, and three
-- of them fail silently:
--
--   min_photos default 0        — and the completion trigger (0050) reads
--                                 `if required <= 0 then return new`. A row
--                                 left at the default DEFEATS CLAUDE.md RULE 2
--                                 for that service: the job completes with no
--                                 photos and the payout releases. Nothing
--                                 anywhere asserts min_photos > 0 globally.
--   est_minutes has NO default  — 0048 raises on any NULL, so a rebuild would
--                                 fail; and at runtime serviceMinutes falls
--                                 back to 60 for everything.
--   frequency_options default {} — BookingGrid renders no frequency choices
--                                 and isRecurring("") is false, so the service
--                                 can never be enrolled or autopiloted.
--   criticality default 'routine' — wrong for snow, which is the protective
--                                 case: 0053 means the nightly never
--                                 auto-cancels protective work when no crew is
--                                 found, and an un-ploughed drive strands
--                                 somebody.
--
-- est_minutes and daily_capacity below are ESTIMATES, chosen against the
-- existing seeds (lawn 45min/8 a day, housekeeping 90min/5 a day). 0042's
-- nightly learner tunes est_minutes from real jobs, so these are a starting
-- budget and not a claim.
-- ============================================================================

insert into public.services
  (name, kind, pricing_model, base, unit_rate, band_pricing, frequency_options,
   min_photos, est_minutes, daily_capacity, criticality, needs_interior_access,
   is_water_work, takes_custody, needs_pickup_spot, needs_release,
   park_only, park_bookable, solo_bookable, active)
select
  'Snow removal — drive & walks',
  'standalone',
  'band',        -- by driveway size, the same model as the mow
  0,             -- NO PRICE. The three band amounts are the owner's to give.
  0,
  -- The whole reason `band_field` exists (0159). Without it this prices off
  -- the customer's LAWN — a real, bookable, wrong number.
  '{"band_field": "drive_band"}'::jsonb,
  array['Per push'],
  2,             -- before and after. The proof the drive was actually cleared.
  25,            -- a residential drive and walks; the learner will correct it
  12,            -- more than a mow's 8: a plough moves faster between stops
  'protective',  -- 0053: never auto-cancelled. Nobody gets snowed in quietly.
  false,         -- outside work; no key, no gate code, no access dispute
  false, false, false, false,
  false,         -- NOT park_only: this is a household's driveway
  false,         -- NOT park_bookable — see header, band_pricing does not overlay
  false,
  false          -- INACTIVE until the owner prices it
where not exists (
  select 1 from public.services where name = 'Snow removal — drive & walks'
);

insert into public.services
  (name, kind, pricing_model, base, unit_rate, band_pricing, frequency_options,
   min_photos, est_minutes, daily_capacity, criticality, needs_interior_access,
   is_water_work, takes_custody, needs_pickup_spot, needs_release,
   park_only, park_bookable, solo_bookable, active)
select
  'Window washing',
  'standalone',
  'per_section', -- base + a rate per pane, the same model as a pier
  0,             -- NO PRICE. Visit fee and per-pane rate are the owner's.
  0,
  -- Counting panes is also what keeps this off a property with none: 0 reads
  -- as "no glass we handle" and serviceApplies gives it no tile at all.
  '{"count_field": "panes"}'::jsonb,
  array['One-time'],
  3,             -- the glass IS the proof of work here, more than anywhere
  120,
  3,             -- a half-day job, like spring opening
  'routine',
  false,         -- OUTSIDE ONLY (his decision). This is the flag that keeps it
                 -- clear of the interior-access rules entirely: a locked door
                 -- can never turn a window job into a no-show dispute.
  false, false, false, false,
  false, false, false,
  false          -- INACTIVE until the owner prices it
where not exists (
  select 1 from public.services where name = 'Window washing'
);

comment on column public.services.band_pricing is
  'Extra rule parameters. `count_field` names what a per_section rule counts; '
  '`band_field` (0160) names which categorical size a band rule reads, '
  'defaulting to lawn_band so the mow is untouched. Prices live here too for '
  'band and per_sqft_band rules.';

-- --------------------------------------------------- post-conditions ------

do $$
declare r record; n int;
begin
  for r in select * from public.services
            where name in ('Snow removal — drive & walks', 'Window washing') loop

    -- INACTIVE AND UNPRICED. The two facts that make this migration safe.
    if r.active then
      raise exception '0160: % is ACTIVE with no price — it would quote $0', r.name;
    end if;
    if r.base <> 0 or r.unit_rate <> 0 then
      raise exception '0160: % carries a price nobody gave it', r.name;
    end if;

    -- RULE 2 IS NOT OPTIONAL. min_photos 0 makes the completion trigger a
    -- no-op for this service and the payout releases on no evidence at all.
    if coalesce(r.min_photos, 0) <= 0 then
      raise exception '0160: % has no photo gate — rule 2 defeated by a column default', r.name;
    end if;
    -- 0048 raises on a NULL, and serviceMinutes falls back to 60 for everything.
    if r.est_minutes is null then
      raise exception '0160: % has no time budget', r.name;
    end if;
    -- An empty frequency list cannot be booked or enrolled.
    if coalesce(array_length(r.frequency_options, 1), 0) = 0 then
      raise exception '0160: % offers no frequency, so nothing can book it', r.name;
    end if;
    -- Both are lake-home services. park_only would hide them from every house.
    if r.park_only then
      raise exception '0160: % is park_only — the whole point is the platform', r.name;
    end if;
  end loop;

  -- The rules read the right profile fact, or they read the lawn.
  if (select band_pricing->>'band_field' from public.services
       where name = 'Snow removal — drive & walks') <> 'drive_band' then
    raise exception '0160: snow would price off the customer''s lawn';
  end if;
  if (select band_pricing->>'count_field' from public.services
       where name = 'Window washing') <> 'panes' then
    raise exception '0160: window washing counts the wrong thing';
  end if;

  -- 0150 ASSERTS EXACTLY FIVE SERVICES NEED INTERIOR ACCESS. Window washing is
  -- outside-only, so the count must not have moved — and if anyone later
  -- "improves" it to include insides, they break a historical migration on the
  -- next rebuild and should find out here first.
  select count(*) into n from public.services where needs_interior_access;
  if n <> 5 then
    raise exception '0160: % services need interior access, 0150 pins it at 5', n;
  end if;

  -- The park's own snow service is untouched. Two jobs, two rows.
  if not exists (
    select 1 from public.services
     where name = 'Snow clearing — roads & common drives' and park_only and active
  ) then
    raise exception '0160: the park snow service was disturbed';
  end if;

  raise notice '0160: two services exist, both inactive and unpriced. Nothing can book them yet.';
end $$;
