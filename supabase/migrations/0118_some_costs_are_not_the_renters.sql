-- 0118 — SOME COSTS ARE THE PARK'S, AND SAYING SO HAS TO BE A CHOICE
--
-- The Haven comes with a boat, and it is for the SHORT-STAY guests to book
-- while they are here. That single fact breaks the assumption every cost on
-- this screen has carried until now: that a bill the park pays is a bill the
-- lots share.
--
-- Winterizing that boat is not a cost of living on lot 14. It is a cost of
-- running the nightly side, and it should come out of nightly revenue. Today it
-- would be entered as `other`, `canSplit('other')` is true, and it would be
-- divided across all twenty-one rentable lots — nineteen households billed a
-- share of a boat they cannot book. Small money, and precisely the kind of line
-- item a resident is right to be angry about.
--
-- So: an explicit third way for a bill to come to rest.
--
--   per_lot      divided across the rentable lots (what everything does today)
--   metered      reserved by 0069, no writer yet
--   park_only    THE PARK CARRIES IT, on purpose. Recorded, in the books, in
--                the fee comparison — simply never divided.
--   fee_covered  a recurring fee already covers this category, so recordCost
--                deliberately did not split it a second time
--
-- `fee_covered` is not new behaviour; it is an existing behaviour that had no
-- name. The fee-covered branch has always written park_absorbed = amount_paid
-- with a NULL denominator, and the screen had to INFER what that meant by
-- comparing park_absorbed against zero. That inference collides on a $0 bill
-- and, worse, cannot tell "a fee covers this" from "recorded before we tracked
-- it". 0112 argued that a snapshot beats a recomputation; this is the same
-- argument applied to the reason.

alter table public.park_costs drop constraint if exists park_costs_allocation_method_check;
alter table public.park_costs add constraint park_costs_allocation_method_check
  check (allocation_method in ('per_lot', 'metered', 'park_only', 'fee_covered'));

-- Name the rows that already mean 'fee_covered'. A cost with no denominator
-- that the park absorbed in full is exactly what that branch writes; there is
-- no other way to produce that shape.
update public.park_costs
   set allocation_method = 'fee_covered'
 where denominator_lots is null
   and park_absorbed > 0
   and allocated_total = 0
   and allocation_method = 'per_lot';

comment on column public.park_costs.allocation_method is
  'How this bill came to rest. per_lot = divided across the rentable lots. '
  'park_only = the park carries it deliberately, because it serves the park''s '
  'own side of the business (the guest boat, a park-owned home) rather than the '
  'households. fee_covered = a recurring fee already covers the category. '
  'metered is reserved and has no writer. A STORED FACT, not something the '
  'screen re-derives from the numbers — see 0112.';

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; ok boolean; got text;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0118 Proof','1 Rd','0118-proof', lid,'mh', false) returning id into pid;

    -- 1. A COST THE PARK CARRIES CAN BE RECORDED, and divides to nobody.
    insert into public.park_costs
      (park_id, category, period_start, period_end, amount_paid,
       allocated_total, allocation_method, park_absorbed, source_note)
    values (pid, 'other', date '2026-10-01', date '2026-10-31', 640,
            0, 'park_only', 640, 'Guest boat — winterize & haul');

    select allocation_method into got from public.park_costs
     where park_id = pid and source_note like 'Guest boat%';
    if got <> 'park_only' then
      raise exception '0118: a park-carried cost stored as %, expected park_only', got;
    end if;

    -- 2. IT NEVER OVER-RECOVERS. allocated_total stays 0, so the existing
    --    never-over-recover constraint is satisfied and no share can exist.
    if exists (
      select 1 from public.park_costs
       where park_id = pid and allocation_method = 'park_only' and allocated_total <> 0
    ) then
      raise exception '0118: a park-carried cost allocated something to somebody';
    end if;

    -- 3. A METHOD NOBODY WRITES IS STILL REFUSED — the CHECK is a real fence,
    --    not a comment. This is what stops a typo becoming a silent third rule.
    ok := false;
    begin
      update public.park_costs set allocation_method = 'split_evenly'
       where park_id = pid;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0118: an unknown allocation method was accepted'; end if;

    -- 4. THE OLD METHODS STILL WORK. A migration that widens a rule must not
    --    quietly narrow it somewhere else.
    update public.park_costs set allocation_method = 'per_lot' where park_id = pid;
    update public.park_costs set allocation_method = 'metered' where park_id = pid;
    update public.park_costs set allocation_method = 'fee_covered' where park_id = pid;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
