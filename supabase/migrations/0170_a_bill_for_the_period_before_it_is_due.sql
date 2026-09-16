-- 0170 — A BILL FOR THE PERIOD BEFORE IT IS DUE
--
-- Indiana bills property tax in arrears: the bill due 10 November 2027 is the
-- 2026 tax. LaGrange sewer's bill dated the 5th is for the previous month's
-- service. The schedule (0114, 0123) knew WHEN a bill lands and nothing about
-- what it covers, so a 1 January go-live was shown a card for December's
-- sewer and for the seller's tax — and the cost door, which compares the
-- period a bill STARTS against go-live (billing-start), then refused both.
-- The reminder and the door disagreed because one of them was guessing.
--
-- WHAT WAS WRONG. `billPeriod` keyed, labelled and windowed every reminder on
-- the period the bill is due IN. For a bill paid in arrears that is the wrong
-- period by exactly one cadence, and nothing on the row could say so. The
-- card fell back to naming only the due date ("Sewer (bill due January 5)"),
-- which was honest and unhelpful: he reads "for December" off the envelope.
--
-- THE RULE NOW. A schedule may say that its bill is FOR the period before the
-- one it is due in. When it does, `billPeriod` (cost-helpers) keys, labels
-- and windows the reminder on the COVERED period while the due date stays
-- exactly where it was, so the go-live gate on the morning screen and the
-- cost door compare the same month, and the card reads "Sewer for December
-- 2026 (bill due January 5)". Set by the owner on the costs screen, per
-- schedule, for EVERY park — never a rule keyed on a state or a category.
-- This is his decision of 16 September ("yes I want it").
--
-- WHAT IT DELIBERATELY DOES NOT DO. It infers nothing: default FALSE, because
-- what is true on day one is that a schedule says nothing about coverage
-- until the owner ticks it, and every existing row (The Haven's two) reads
-- exactly as it did yesterday. It does not flip The Haven's rows — he ticks
-- them on screen. It does not move a due date, and it does not touch the
-- cost door (billing-start is unchanged; the shift happens upstream of it).

-- ------------------------------------------------------------- the column --

alter table public.park_cost_schedules
  add column if not exists covers_prior_period boolean not null default false;

comment on column public.park_cost_schedules.covers_prior_period is
  'TRUE when the bill is FOR the period before the one it is due in — a tax '
  'bill for last year, a sewer bill for last month. billPeriod (cost-helpers) '
  'then keys, labels and windows the reminder on the COVERED period while the '
  'due date stays real, so the go-live gate and the cost door compare the '
  'same month. Set by the owner on the costs screen; nothing infers it.';

-- RLS ALONE IS NOT ENOUGH (0114 said so for this table; re-asserted so a
-- column added later cannot be the one a client writes). The only writer is
-- saveCostSchedule through the service role.
revoke all on public.park_cost_schedules from anon, authenticated;

-- ------------------------------------------------------ post-conditions ----
do $$
declare
  lid uuid; pid uuid; ok boolean; sid uuid;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0170: no lake to hang a fixture on — post-conditions skipped';
    return;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active, cutover_date)
    values ('0170 Proof', '1 Rd', '0170-proof', lid, 'mh', false, date '2027-01-01')
    returning id into pid;

    -- (a) A ROW WRITTEN WITHOUT THE COLUMN SAYS NOTHING ABOUT COVERAGE. This
    --     is every row that existed before today.
    insert into public.park_cost_schedules (park_id, category, cadence, due_day)
    values (pid, 'sewer', 'monthly', 5) returning id into sid;
    if (select covers_prior_period from public.park_cost_schedules where id = sid) is distinct from false then
      raise exception '0170: default is not false';
    end if;

    -- (b) THE TAX BILL CAN SAY IT IS FOR LAST YEAR.
    insert into public.park_cost_schedules (park_id, category, cadence, due_day, due_month, covers_prior_period)
    values (pid, 'tax', 'annual', 10, 11, true);
    if (select covers_prior_period from public.park_cost_schedules
        where park_id = pid and category = 'tax') is distinct from true then
      raise exception '0170: the flag did not store true';
    end if;

    -- (c) THE FLAG IS NEVER UNKNOWN. A null here would read as "not flagged"
    --     in one reader and as "missing" in another.
    ok := false;
    begin
      update public.park_cost_schedules set covers_prior_period = null where id = sid;
    exception when not_null_violation then ok := true;
    end;
    if not ok then raise exception '0170: the flag went null'; end if;

    -- (d) AN EXISTING ROW TAKES THE FLAG BY UPDATE — the path The Haven's two
    --     schedules use from the costs screen's Edit door.
    update public.park_cost_schedules set covers_prior_period = true where id = sid;
    if (select count(*) from public.park_cost_schedules
        where park_id = pid and active and covers_prior_period) <> 2 then
      raise exception '0170: the flag did not stick on an existing row';
    end if;

    -- (e) 0114's ONE-LIVE-ROW-PER-CATEGORY INDEX STILL HOLDS. Adding a column
    --     must not have loosened the rule that two sewer reminders is two
    --     people entering the same bill.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, cadence, due_day, covers_prior_period)
      values (pid, 'sewer', 'monthly', 20, true);
    exception when unique_violation then ok := true;
    end;
    if not ok then raise exception '0170: 0114 index lost'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
