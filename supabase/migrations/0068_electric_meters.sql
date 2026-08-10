-- ============================================================================
-- 0068 — THE ONE METERED UTILITY.
--
-- The owner's structure, now complete:
--
--   GROUNDS FEE (flat, an averaged prorated share) covers water, sewer, trash,
--   maintenance and the UNMETERED electricity — park lighting, common areas.
--
--   ELECTRICITY AT THE LOT is the exception: metered, and billed at what the
--   resident actually used. Long-term stays only — you do not read a meter
--   between a Friday and a Sunday.
--
-- WHY THIS IS NOT JUST ANOTHER COST CATEGORY. Everything in 0064 is a bill the
-- park receives and divides. This is the opposite: a number read off a
-- pedestal at each lot, turned into consumption by SUBTRACTING THE LAST
-- READING, and billed per unit. The arithmetic has failure modes a division
-- does not, and every one of them lands on a resident's bill.
--
-- ---------------------------------------------------------------------------
-- THE FAILURE MODES, AND WHY NONE OF THEM GUESSES:
--
--   A READING LOWER THAN THE LAST ONE. Either the meter rolled past its
--   maximum, or it was replaced, or somebody misread it. Those produce wildly
--   different bills and the software CANNOT TELL THEM APART. So it refuses to
--   bill and asks. A guessed rollover on a misread charges somebody for 99,000
--   kilowatt-hours, and they find out when the bill arrives.
--
--   NO PREVIOUS READING. The first read of a meter is a BASELINE, not a bill.
--   Billing the whole face value of a meter would charge a new tenant for
--   every unit since the pedestal was installed.
--
--   A MISSING MONTH. Consumption is measured between two real readings,
--   whatever the gap. It is never estimated to fill a hole — an estimated
--   utility bill is where disputes come from, and a real reading next month
--   settles it correctly anyway.
-- ---------------------------------------------------------------------------
--
-- FOR COUNSEL, alongside the fee-disclosure question: reselling metered
-- electricity to residents is regulated, and in many places the rate may not
-- exceed what the utility charged. This schema records a rate and the readings
-- it was applied to, so the arithmetic can be shown. It does not know what is
-- permitted.
-- ============================================================================

-- The meter on the pedestal. NULL means this lot has none — plenty of lots
-- don't, and a park may meter some and not others.
alter table public.park_lots
  add column if not exists electric_meter_id text;

comment on column public.park_lots.electric_meter_id is
  'The meter serial on this lot''s pedestal. NULL = unmetered, and unmetered '
  'lots are simply not billed for electricity.';

-- What the park bills per unit. Kept in CENTS to avoid a float creeping into
-- money: 12.4 c/kWh is 12.4, not 0.124 rounded somewhere.
alter table public.parks
  add column if not exists electric_cents_per_kwh numeric(8,3);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parks_electric_rate_check') then
    alter table public.parks add constraint parks_electric_rate_check
      check (electric_cents_per_kwh is null or electric_cents_per_kwh >= 0);
  end if;
end $$;

comment on column public.parks.electric_cents_per_kwh is
  'Cents per kWh billed to residents. NULL = the park does not bill metered '
  'electricity. What may lawfully be charged here is a legal question.';


create table if not exists public.lot_meter_readings (
  id          uuid primary key default gen_random_uuid(),
  park_lot_id uuid not null references public.park_lots(id) on delete cascade,

  read_on     date not null,
  -- The number on the dial. NOT consumption — consumption is the difference
  -- between two of these, and storing the difference instead would make a
  -- correction to an old reading impossible to propagate.
  reading     numeric(12,2) not null check (reading >= 0),

  -- Set by a human when the dial legitimately went backwards. The software
  -- never infers either of these.
  rollover        boolean not null default false,
  meter_replaced  boolean not null default false,

  note        text,
  read_by     uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),

  -- One reading per lot per day. Two would make consumption ambiguous.
  unique (park_lot_id, read_on),

  -- A reading cannot be both a rollover and a replacement: the first carries
  -- consumption over the top, the second starts from zero, and they produce
  -- different bills.
  constraint meter_reading_one_reason
    check (not (rollover and meter_replaced))
);

comment on table public.lot_meter_readings is
  'Readings off the pedestal. Consumption is the DIFFERENCE between two of '
  'them, computed at read time — never stored, so correcting an old reading '
  'fixes every bill after it.';

create index if not exists lot_meter_readings_lot_idx
  on public.lot_meter_readings (park_lot_id, read_on desc);


-- ---------------------------------------------------------------- rls -------
alter table public.lot_meter_readings enable row level security;

drop policy if exists lot_meter_readings_read on public.lot_meter_readings;
create policy lot_meter_readings_read on public.lot_meter_readings
  for select to authenticated
  using (
    public.ll_manages_lot(park_lot_id)
    or public.ll_is_ops()
    -- A resident may see the readings for the lot they are on. It is their
    -- usage, and a bill they cannot check is a bill they will dispute.
    or exists (
      select 1
        from public.lot_reservations lr
        join public.park_renters pr on pr.id = lr.renter_id
       where lr.park_lot_id = lot_meter_readings.park_lot_id
         and pr.user_id = auth.uid()
         and lr.status in ('approved', 'active')
    )
  );

revoke all on public.lot_meter_readings from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.lot_meter_readings from authenticated;
grant select on public.lot_meter_readings to authenticated;


-- ------------------------------------------------------ post-conditions -----
do $$
begin
  if to_regclass('public.lot_meter_readings') is null then
    raise exception '0068: lot_meter_readings missing';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'meter_reading_one_reason') then
    raise exception '0068: a reading could claim to be both a rollover and a replacement';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='park_lots' and column_name='electric_meter_id'
  ) then
    raise exception '0068: park_lots.electric_meter_id missing';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema='public' and table_name='lot_meter_readings' and grantee='anon'
  ) then
    raise exception '0068: anon holds a grant on meter readings';
  end if;

  raise notice '0068: electricity is metered, and a backwards dial is a question rather than a bill.';
end $$;
