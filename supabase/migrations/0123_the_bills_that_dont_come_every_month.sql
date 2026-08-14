-- 0123 — THE BILLS THAT DON'T COME EVERY MONTH
--
-- 0114 allowed one cadence, `monthly`, and said quarterly and annual were
-- "deliberately absent rather than stored-and-ignored". That was right at the
-- time — there was no reader. It stopped being right the moment the reminder
-- had to cover The Haven's actual costs, because his biggest non-sewer bills
-- do not arrive monthly:
--
--   Sewer / electric   $17,198/yr   monthly      — already covered
--   Groundskeeping      $2,377/yr   monthly-ish  — already covered
--   Property taxes      $3,559/yr   ANNUAL       — no cadence AND no category
--   Insurance             $797/yr   ANNUAL       — no cadence AND no category
--   Trash                 $544/yr   QUARTERLY    — no cadence
--
-- (2024 figures from the seller's pro-forma. The point is the SHAPE, not the
-- amounts — every park has bills on all three rhythms.)
--
-- TWO THINGS WERE MISSING, and either alone is useless. A cadence with no
-- category leaves the tax bill nowhere to go; a category with no cadence makes
-- it nag twelve times a year about a bill that arrives once.
--
-- ---------------------------------------------------------------- cadence --
--
-- `due_month` is what a quarterly or annual bill needs and a monthly one must
-- not have: WHICH month it lands. For quarterly it anchors the cycle — a
-- due_month of 2 means February, May, August, November. The CHECK below makes
-- the pairing structural rather than a convention somebody has to remember.
--
-- The reminder's PERIOD and its task key follow the cadence, so an annual bill
-- is one task a year rather than twelve. That logic is in `billPeriod` in
-- cost-helpers, tested against leap years and quarter boundaries — this file
-- only makes the shape storable.

alter table public.park_cost_schedules
  drop constraint if exists park_cost_schedules_cadence_check;
alter table public.park_cost_schedules
  add constraint park_cost_schedules_cadence_check
  check (cadence in ('monthly', 'quarterly', 'annual'));

alter table public.park_cost_schedules
  add column if not exists due_month smallint
  check (due_month is null or due_month between 1 and 12);

alter table public.park_cost_schedules
  drop constraint if exists park_cost_schedules_due_month_fits_cadence;
alter table public.park_cost_schedules
  add constraint park_cost_schedules_due_month_fits_cadence
  check (
    (cadence = 'monthly'  and due_month is null) or
    (cadence in ('quarterly', 'annual') and due_month is not null)
  );

comment on column public.park_cost_schedules.due_month is
  'WHICH month a quarterly or annual bill lands. NULL for monthly, where every '
  'month is the month. For quarterly it anchors the cycle: 2 means February, '
  'May, August and November.';

-- ------------------------------------------------------------- categories --
--
-- A tax bill and an insurance premium are shared park costs — they sit in the
-- pool every rentable lot carries a share of, exactly like sewer. They were
-- landing in `other`, which is a bucket with a one-per-park reminder slot, so
-- the tax reminder and the insurance reminder could not both exist and either
-- would be cleared by whichever bill was entered first.
--
-- Widened on BOTH tables in one migration on purpose. 0117 exists because
-- park_cost_schedules had no category CHECK at all while park_costs did, and
-- letting them drift again would put a reminder in front of a category the
-- costs screen cannot record.

alter table public.park_costs drop constraint if exists park_costs_category_check;
alter table public.park_costs add constraint park_costs_category_check
  check (category in ('water','sewer','trash','common_electric','grounds',
                      'unit_electric','other','tax','insurance'));

alter table public.park_cost_schedules drop constraint if exists park_cost_schedules_category_check;
alter table public.park_cost_schedules add constraint park_cost_schedules_category_check
  check (category in ('water','sewer','trash','common_electric','grounds',
                      'tax','insurance'));

-- ------------------------------------------------------ post-conditions ----
do $$
declare
  lid uuid; pid uuid; ok boolean; c text;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0123 Proof','1 Rd','0123-proof', lid,'mh', false) returning id into pid;

    -- 1. THE THREE RHYTHMS A PARK ACTUALLY HAS.
    insert into public.park_cost_schedules (park_id, category, cadence, due_day)
    values (pid, 'sewer', 'monthly', 5);
    insert into public.park_cost_schedules (park_id, category, cadence, due_day, due_month)
    values (pid, 'trash', 'quarterly', 10, 2);
    insert into public.park_cost_schedules (park_id, category, cadence, due_day, due_month, typical_amount)
    values (pid, 'tax', 'annual', 10, 11, 3559);
    insert into public.park_cost_schedules (park_id, category, cadence, due_day, due_month)
    values (pid, 'insurance', 'annual', 1, 6);

    -- 2. A MONTHLY BILL HAS NO due_month — every month is the month, and
    --    storing one would be a fact with two possible readings.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, cadence, due_day, due_month)
      values (pid, 'water', 'monthly', 5, 3);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0123: a monthly bill was given a month'; end if;

    -- 3. AND AN ANNUAL ONE CANNOT GO WITHOUT. "Some time this year" is not a
    --    reminder, it is a shrug.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, cadence, due_day)
      values (pid, 'water', 'annual', 5);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0123: an annual bill landed in no month'; end if;

    -- 4. A CADENCE NOBODY WROTE A READER FOR IS STILL REFUSED.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, cadence, due_day, due_month)
      values (pid, 'water', 'fortnightly', 5, 1);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0123: an unknown cadence was accepted'; end if;

    -- 5. TAX AND INSURANCE ARE RECORDABLE COSTS, not just schedulable ones.
    --    A reminder for a category recordCost cannot write is 0117's whole bug.
    insert into public.park_costs (park_id, category, period_start, period_end, amount_paid)
    values (pid, 'tax', date '2026-01-01', date '2027-01-01', 3559),
           (pid, 'insurance', date '2026-06-01', date '2027-06-01', 797);

    -- 6. EVERY CATEGORY THE SCHEDULE ALLOWS, park_costs ALSO ALLOWS. If these
    --    two drift the reminder points at a door the costs screen cannot open.
    foreach c in array array['water','sewer','trash','common_electric','grounds','tax','insurance']
    loop
      begin
        insert into public.park_costs (park_id, category, period_start, period_end, amount_paid)
        values (pid, c, date '2025-01-01', date '2025-02-01', 1);
      exception when check_violation then
        raise exception '0123: schedule allows %, park_costs does not', c;
      end;
    end loop;

    -- 7. unit_electric AND other STAY OFF THE SCHEDULE. recordCost refuses the
    --    first outright; the second cannot be told apart from another 'other'
    --    under the one-per-category index.
    foreach c in array array['unit_electric','other'] loop
      ok := false;
      begin
        insert into public.park_cost_schedules (park_id, category, cadence, due_day)
        values (pid, c, 'monthly', 5);
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0123: % became schedulable', c; end if;
    end loop;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
