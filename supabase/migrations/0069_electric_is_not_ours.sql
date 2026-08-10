-- ============================================================================
-- 0069 — REVERSING 0068. THE PARK IS NOT IN THE ELECTRICITY BUSINESS.
--
-- 0068 built meter readings, a cents-per-kWh rate and a billing engine on my
-- misreading of "the only utility that is metered is electricity". The owner's
-- correction:
--
--   "We are not responsible for their electricity meter... electricity is
--    individually metered by the electrical company and billed to each of the
--    renters directly."
--
-- So there is no meter for the park to read, no rate for it to set, and no
-- charge for it to raise. The utility meters each lot and bills that resident.
-- The park never sees it.
--
-- THE ONE EXCEPTION IS OWNERSHIP, NOT METERING. Where the park owns the unit —
-- the double-wide, the four short-term homes — the electricity is the PARK'S
-- OWN BILL, because it is the park's building. That is a cost to record, not a
-- meter to read, and `park_costs` already does costs.
--
-- WHY DROP IT RATHER THAN LEAVE IT UNUSED. An unused billing mechanism is not
-- neutral: it is a table somebody wires up in eighteen months because it looks
-- deliberate, and a `covers` list that can claim "electricity" for lot renters
-- who are already paying the utility direct. Dead machinery for money is worse
-- than no machinery. Nothing referenced it and no row ever existed.
-- ============================================================================

drop table if exists public.lot_meter_readings;

alter table public.park_lots drop column if exists electric_meter_id;
alter table public.parks     drop column if exists electric_cents_per_kwh;
alter table public.parks     drop constraint if exists parks_electric_rate_check;

-- WHAT REMAINS TRUE, and now has somewhere to live: electricity on a unit the
-- park OWNS is a park cost like any other. Separate from common_electric —
-- park lighting is shared infrastructure covered by the grounds fee, while
-- this is the running cost of a building the park rents out, and it belongs
-- against that unit's income rather than against everybody's fee.
alter table public.park_costs drop constraint if exists park_costs_category_check;
alter table public.park_costs add constraint park_costs_category_check
  check (category in (
    'water', 'sewer', 'trash', 'common_electric', 'grounds', 'unit_electric', 'other'
  ));

comment on column public.park_costs.category is
  'common_electric = park lighting and shared areas, covered by the grounds '
  'fee. unit_electric = power for a home the PARK owns and rents out. A lot '
  'renter''s own electricity is billed to them by the utility and never '
  'appears here.';

do $$
begin
  if to_regclass('public.lot_meter_readings') is not null then
    raise exception '0069: the meter table is still here';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='park_lots' and column_name='electric_meter_id'
  ) then
    raise exception '0069: park_lots still carries a meter id';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='parks' and column_name='electric_cents_per_kwh'
  ) then
    raise exception '0069: parks still carries an electricity rate';
  end if;

  -- And the new category must actually be usable.
  begin
    perform 1 from public.park_costs where category = 'unit_electric';
  exception when others then
    raise exception '0069: unit_electric is not a valid cost category';
  end;

  raise notice '0069: the utility bills the renter; the park only pays for what it owns.';
end $$;
