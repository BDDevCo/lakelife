-- 0117 — A REMINDER MUST POINT AT A DOOR THAT OPENS
--
-- 0114 created `park_cost_schedules` with `category text not null` and no CHECK
-- at all, while `park_costs` has carried `park_costs_category_check` since 0069.
-- Nothing stood between a typo and a reminder that can never be cleared: the
-- Today task matches a schedule's category against the categories of costs
-- recorded that month, so a schedule for 'sewage' would nag forever about a
-- bill the costs screen has no way to enter.
--
-- The allowed set here is NARROWER than `park_costs`, on purpose:
--
--   * `unit_electric` is refused by `recordCost` outright — power on a home the
--     park owns is metered to that home and billed directly, never divided
--     across the lots (0069, and `canSplit` in cost-helpers). A reminder for it
--     would send him to /park/costs, where it is not in the dropdown and the
--     action would refuse it. That is a door that does not open.
--
--   * `other` is a trap under the one-per-category index. Only one 'other'
--     schedule can be active per park, and ANY cost recorded as 'other' in the
--     month clears it — so the property tax and the insurance binder would
--     share a single reminder and each would falsely satisfy the other. A
--     wrong reassurance is worse than no reminder. Those belong in the note
--     box on /park/today, which exists precisely for the things with no
--     derivable column: "the property tax, the insurance binder, the licence
--     renewal — none of those have a derivable column anywhere, and never will."
--
-- No seeds, no default schedule, no default amount. A new park owner starts
-- with an empty list and a screen that says so.

alter table public.park_cost_schedules
  drop constraint if exists park_cost_schedules_category_check;

alter table public.park_cost_schedules
  add constraint park_cost_schedules_category_check
  check (category in ('water', 'sewer', 'trash', 'common_electric', 'grounds'));

comment on column public.park_cost_schedules.category is
  'Which recurring bill this is. Deliberately a NARROWER set than '
  'park_costs.category: unit_electric is never split (recordCost refuses it) '
  'and ''other'' cannot be told apart from another ''other'' under the '
  'one-per-category index, so both would produce reminders that lead nowhere.';

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; ok boolean;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0117 Proof','1 Rd','0117-proof', lid,'mh', false) returning id into pid;

    -- 1. THE FIVE THAT recordCost CAN ACTUALLY WRITE ARE ALL ACCEPTED.
    insert into public.park_cost_schedules (park_id, category, due_day)
    values (pid,'water',1), (pid,'sewer',5), (pid,'trash',10),
           (pid,'common_electric',15), (pid,'grounds',20);

    -- 2. A TYPO IS REFUSED. This is the whole migration: 'sewage' would have
    --    been stored happily and nagged forever.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, due_day)
      values (pid, 'sewage', 5);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0117: a category no cost screen can enter was accepted'; end if;

    -- 3. unit_electric IS REFUSED — recordCost would refuse the bill it asks for.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, due_day)
      values (pid, 'unit_electric', 5);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0117: a reminder for a cost that can never be split was accepted'; end if;

    -- 4. 'other' IS REFUSED — one active row per category means two different
    --    'other' bills would satisfy each other's reminder.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, due_day)
      values (pid, 'other', 5);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0117: an ambiguous ''other'' reminder was accepted'; end if;

    -- 5. EVERY CATEGORY THIS TABLE ALLOWS IS ONE park_costs ALSO ALLOWS. If
    --    these two constraints ever drift, the reminder points at a door the
    --    costs screen cannot open — which is the bug this file exists to stop.
    insert into public.park_costs
      (park_id, category, period_start, period_end, amount_paid)
    select pid, c, date '2026-01-01', date '2026-01-31', 1
    from unnest(array['water','sewer','trash','common_electric','grounds']) as c;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
