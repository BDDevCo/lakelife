-- 0111 — A PARK JOB BECOMES A COST, WITHOUT BEING RETYPED.
--
-- The loop the park module was built for closes here:
--
--   the park books a grounds mow from LakeLife (0107)
--     -> a crew does it and the park is invoiced
--       -> the owner records it as a park cost
--         -> it splits across the lots (0064)
--           -> it lands on each resident's bill as a line (0104)
--             -> the resident sees it and pays it (0108)
--
-- Every step existed except the third, which was the owner reading a figure
-- off one screen and typing it into another. That is where a digit gets
-- dropped, and the household that gets the wrong share has no way to know.
--
-- WHAT MAKES THE OFFER IDEMPOTENT. `source_job_id` is what says a job has
-- already become a cost. Without it the same mow is offered every time the
-- screen loads, and an owner who taps twice has billed his residents twice for
-- one mowing — silently, because two costs of $602 look exactly like a park
-- that mowed twice.
--
-- IT IS ALSO THE AUDIT TRAIL. "Where did this $602 come from" is answerable
-- for the life of the park, which matters when a resident disputes a share
-- eighteen months later. A retyped number can never answer that.
--
-- ON DELETE SET NULL, never cascade: deleting a job must not destroy the cost
-- record that residents were billed from. Same rule 0072 drew for payments.

alter table public.park_costs
  add column if not exists source_job_id uuid
    references public.jobs(id) on delete set null;

-- ONE COST PER JOB, enforced rather than hoped for. The check-then-insert in
-- the action is the courtesy; this is the rule.
create unique index if not exists park_costs_one_per_source_job
  on public.park_costs (source_job_id) where source_job_id is not null;

comment on column public.park_costs.source_job_id is
  'The LakeLife job this cost came from, when it was filled in from one rather '
  'than typed. NULL for a utility bill or anything else off-platform. Unique: '
  'a job may become a cost exactly once, so an owner who taps twice cannot '
  'bill his residents twice for one mowing.';

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; lot uuid; prop uuid; uid uuid; job uuid; c1 uuid;
        ok boolean; n int;
begin
  select id into lid from public.lakes limit 1;
  select id into uid from public.users limit 1;
  if lid is null or uid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0111 Proof','1 Rd','0111-proof', lid,'mh', false) returning id into pid;
    insert into public.park_members (park_id, user_id, role) values (pid, uid, 'owner');
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'1', true,'live') returning id into lot;
    insert into public.properties (owner_id, lake_id, address, park_id)
    values (uid, lid, '0111 grounds', pid) returning id into prop;
    update public.parks set service_property_id = prop where id = pid;

    insert into public.jobs (property_id, date, status, customer_price)
    values (prop, current_date, 'complete', 602) returning id into job;

    -- 1. A JOB BECOMES A COST.
    insert into public.park_costs
      (park_id, category, period_start, period_end, amount_paid, allocated_total,
       allocation_method, source_job_id)
    values (pid,'grounds', current_date - 30, current_date, 602, 0,'per_lot', job)
    returning id into c1;

    -- 2. AND ONLY ONCE. The double-tap that would bill 21 households twice.
    ok := false;
    begin
      insert into public.park_costs
        (park_id, category, period_start, period_end, amount_paid, allocated_total,
         allocation_method, source_job_id)
      values (pid,'grounds', current_date - 30, current_date, 602, 0,'per_lot', job);
    exception when unique_violation then ok := true;
    end;
    if not ok then
      raise exception '0111: one job was recorded as a cost twice — residents would be billed twice for one mow';
    end if;

    -- 3. A TYPED COST IS UNAFFECTED. Utility bills have no job behind them,
    --    and many of them must be allowed to coexist.
    insert into public.park_costs
      (park_id, category, period_start, period_end, amount_paid, allocated_total, allocation_method)
    values (pid,'water', current_date - 30, current_date, 1140, 0,'per_lot'),
           (pid,'water', current_date - 60, current_date - 31, 980, 0,'per_lot');

    -- 4. DELETING THE JOB LEAVES THE COST STANDING. Residents were billed from
    --    it; it cannot evaporate because a job row was tidied away.
    delete from public.jobs where id = job;
    select count(*) into n from public.park_costs where id = c1;
    if n <> 1 then
      raise exception '0111: deleting a job destroyed the cost its residents were billed from';
    end if;
    if (select source_job_id from public.park_costs where id = c1) is not null then
      raise exception '0111: the cost still points at a job that is gone';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
