-- ============================================================================
-- 0066 — WHAT THIS PARK EARNS FROM, AS A CHOICE RATHER THAN AN ASSUMPTION.
--
-- A park is not one business. The Haven runs six at once: pads people live on,
-- a home the park owns and rents monthly, four homes it will rent by the
-- night, boat slips, storage in a pole barn, and the utility costs it passes
-- back. The next park runs two of those and something nobody has thought of.
--
-- So the shape is a CHOICE the owner makes at setup, stored here. Readiness —
-- "you turned slips on but you have no slips" — is DERIVED from the park's own
-- data and never stored, because a stored ready-flag goes stale the moment a
-- lot is deleted. Intention is a fact about the owner; readiness is a fact
-- about the park.
--
-- Allowlisted rather than free text, same reasoning as lot features: a typo in
-- an array nobody validates becomes a stream that silently never renders.
-- ============================================================================

alter table public.parks
  add column if not exists revenue_streams text[] not null default '{}';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parks_revenue_streams_check') then
    alter table public.parks add constraint parks_revenue_streams_check
      check (revenue_streams <@ array[
        'long_term_lots', 'park_owned_rentals', 'short_term_homes',
        'boat_slips', 'storage', 'cost_recovery', 'fees'
      ]::text[]);
  end if;
end $$;

comment on column public.parks.revenue_streams is
  'Which income streams this park runs. The owner''s INTENTION, chosen at '
  'setup. Whether each one is actually ready to earn is derived from the '
  'park''s data, never stored.';

-- Storage as inventory: a barn or a numbered space is a lot like any other,
-- and reusing park_lots means it gets availability, rates and the
-- no-double-booking constraint for free.
alter table public.park_lots drop constraint if exists park_lots_site_type_check;
alter table public.park_lots add constraint park_lots_site_type_check
  check (site_type in ('rv_site', 'mh_single', 'mh_double', 'tent', 'slip', 'storage'));

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='parks' and column_name='revenue_streams'
  ) then
    raise exception '0066: parks.revenue_streams missing';
  end if;

  -- Existing parks choose nothing by default: this migration adds a question,
  -- it does not answer it on anybody's behalf.
  if exists (select 1 from public.parks where array_length(revenue_streams, 1) is not null) then
    raise exception '0066: a park was given revenue streams it never chose';
  end if;

  -- And storage must now be a sayable kind of lot.
  begin
    perform 1 from public.park_lots where site_type = 'storage';
  exception when others then
    raise exception '0066: storage is not a valid site type';
  end;

  raise notice '0066: a park says what it earns from, and storage is inventory.';
end $$;
