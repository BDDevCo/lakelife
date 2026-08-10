-- ============================================================================
-- 0065 — INVENTORY THAT DOES NOT EXIST YET, AND INVENTORY THAT IS RENTED BY
--        THE NIGHT.
--
-- TWO THINGS THE HAVEN NEEDS THAT THE SCHEMA COULD NOT SAY.
--
-- 1. NOT EVERYTHING ON THE PLAN EXISTS.
--
--    Four short-term rental homes get bought AFTER closing and renovated
--    before they earn anything. Four more RV lots come out of trees that have
--    not been cleared. Lots 22-25 are numbers on a proforma.
--
--    Entering them as lots today makes them VACANT — and vacant is a lie with
--    consequences. The rent roll would read 26 lots, 20 occupied: 77%
--    occupancy against a true 91%. That figure goes in front of a lender.
--    Worse, a vacant lot is bookable, so somebody could reserve a home that
--    has not been bought.
--
--    `active` does not solve this. `active = false` means "in service but
--    switched off" — flooded, being repaired, held back this week. A home
--    that does not exist is not switched off. Two different facts, two
--    columns, and the bookable test is the AND of them.
--
-- 2. A HOME RENTED BY THE NIGHT IS NOT A LOT SOMEBODY LIVES ON.
--
--    Occupancy means different things for the two. A pad is occupied because
--    a household lives there; a short-term home is 63% occupied because it
--    was booked 19 nights of 30. Averaging them produces a number that
--    describes neither, so they are counted apart.
--
--    It also settles the agreement cap quietly: the three-month maximum is
--    about people living on lots, and a four-night stay was never going to
--    trip it.
-- ============================================================================

-- ------------------------------------------------------------- lifecycle ---
--
-- WHERE A LOT IS IN ITS LIFE, as opposed to whether it is switched on.
--   planned    — on the plan, not bought/built. Earns nothing, blocks nothing.
--   renovating — owned, being worked on. Still not bookable.
--   live       — real, and available subject to `active`.
--   retired    — was real, no longer offered. Keeps its history.
alter table public.park_lots
  add column if not exists lifecycle text not null default 'live';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'park_lots_lifecycle_check') then
    alter table public.park_lots add constraint park_lots_lifecycle_check
      check (lifecycle in ('planned', 'renovating', 'live', 'retired'));
  end if;
end $$;

comment on column public.park_lots.lifecycle is
  'planned | renovating | live | retired. NOT the same as `active`: active is '
  'the owner''s on/off switch for a lot that exists; lifecycle says whether it '
  'exists at all. Bookable = active AND lifecycle = live.';

-- When it is expected to be earning. Lets the roll say "4 homes, live around
-- December" rather than showing four silent holes.
alter table public.park_lots
  add column if not exists expected_live_on date;


-- ----------------------------------------------------------- rental mode ---
alter table public.park_lots
  add column if not exists rental_mode text not null default 'long_term';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'park_lots_rental_mode_check') then
    alter table public.park_lots add constraint park_lots_rental_mode_check
      check (rental_mode in ('long_term', 'short_term'));
  end if;
end $$;

comment on column public.park_lots.rental_mode is
  'long_term = somebody lives there. short_term = booked by the night. They '
  'are counted separately because "occupancy" means a different thing for '
  'each, and averaging the two describes neither.';

create index if not exists park_lots_lifecycle_idx
  on public.park_lots (park_id, lifecycle)
  where lifecycle <> 'live';


-- ------------------------------------------- nothing books what isn't real --
--
-- The guard already carries the park's agreement cap and three older
-- invariants (0052 → 0055 → 0062). This adds the one that stops a reservation
-- landing on a home nobody has bought yet.
create or replace function public.guard_lot_reservation()
returns trigger
language plpgsql security definer set search_path = public
as $function$
declare
  renter_account uuid;
  cap_months smallint;
  span_days int;
  lot_life text;
begin
  if new.renter_unit_id is not null
     and not exists (
       select 1 from public.renter_units u
        where u.id = new.renter_unit_id and u.renter_id = new.renter_id
     ) then
    raise exception
      'lot_reservations: unit % does not belong to renter file %',
      new.renter_unit_id, new.renter_id;
  end if;

  if not exists (
    select 1
      from public.park_lots pl
      join public.park_renters pr on pr.park_id = pl.park_id
     where pl.id = new.park_lot_id and pr.id = new.renter_id
  ) then
    raise exception
      'lot_reservations: renter file % is not in the park that owns lot %',
      new.renter_id, new.park_lot_id;
  end if;

  if new.decided_by is not null then
    select user_id into renter_account
      from public.park_renters where id = new.renter_id;
    if renter_account is not null and new.decided_by = renter_account
       and not exists (
         select 1
           from public.park_lots pl
           join public.park_members pm on pm.park_id = pl.park_id
          where pl.id = new.park_lot_id and pm.user_id = renter_account
       ) then
      raise exception 'lot_reservations: a renter cannot approve their own tenancy';
    end if;
  end if;

  -- 0065: a lot that is not LIVE cannot be reserved. Checked for reservations
  -- that actually HOLD the lot — an application against a lot being renovated
  -- is a reasonable thing to receive and to decide on later.
  if new.status in ('approved', 'active') then
    select pl.lifecycle into lot_life
      from public.park_lots pl where pl.id = new.park_lot_id;
    if lot_life is distinct from 'live' then
      raise exception
        'lot_reservations: lot % is % — it cannot be booked until it is live',
        new.park_lot_id, lot_life;
    end if;
  end if;

  -- 0062: no agreement may run longer than the park says one may.
  -- Grandfathered tenancies are exempt: they were inherited on a rolling
  -- one-year horizon and never agreed to a cap.
  if new.during is not null and new.origin is distinct from 'grandfathered' then
    select p.max_agreement_months into cap_months
      from public.park_lots pl
      join public.parks p on p.id = pl.park_id
     where pl.id = new.park_lot_id;
    if cap_months is not null then
      span_days := upper(new.during) - lower(new.during);
      if span_days > (cap_months::int * 31) + 1 then
        raise exception
          'lot_reservations: this park writes agreements of at most % months; that one runs % days. Renew instead — it chains to the last one.',
          cap_months, span_days;
      end if;
    end if;
  end if;

  return new;
end $function$;


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='park_lots'
     and column_name in ('lifecycle', 'rental_mode', 'expected_live_on');
  if n <> 3 then
    raise exception '0065: expected 3 new lot columns, found %', n;
  end if;

  -- Every existing lot must still be live and long-term: this migration adds
  -- vocabulary, it does not reclassify anybody's inventory.
  if exists (select 1 from public.park_lots where lifecycle <> 'live') then
    raise exception '0065: an existing lot stopped being live';
  end if;
  if exists (select 1 from public.park_lots where rental_mode <> 'long_term') then
    raise exception '0065: an existing lot changed rental mode';
  end if;

  raise notice '0065: inventory can be planned, and a nightly home is counted apart.';
end $$;
