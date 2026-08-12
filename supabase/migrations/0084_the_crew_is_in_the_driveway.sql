-- 0084 — THE CREW IS IN THE DRIVEWAY AND IT IS BIGGER THAN THE PROFILE.
--
-- Brendon: "crews should have the ability to adjust, stating reason, give
-- added pricing and then shoots over to customer for approval BEFORE WORK
-- STARTS. if there is a discrepancy it needs to be addressed by the crew when
-- they arrive."
--
-- Rule 6 already said a flag changes nothing until the homeowner approves.
-- What was missing is that nothing STOPPED. A crew could flag twelve sections
-- and complete the job in the same visit, so the owner was billed for eight,
-- the crew was paid for eight, and the approval arrived after the fact with
-- nothing left to decide.
--
-- Rule 1 is untouched: the crew states the FACTS (twelve, not eight) and the
-- system prices them. A crew never sees the customer's number.

-- --------------------------------------------- does this one need inside ---
-- Brendon's rule for the crew who cannot reach anybody: "If the crew doesnt
-- need to get into the house then do the work or it becomes a no show,
-- reschedule if both parties agree or they get charged."
--
-- That turns a judgement a tired crew makes at 7:40am into a fact the service
-- already knows about itself. A dial in the database, like every other rule.
alter table public.services
  add column if not exists needs_interior_access boolean not null default false;

comment on column public.services.needs_interior_access is
  'True when the crew must get inside to do the work at all. Decides what '
  'happens when nobody answers: outside work proceeds at the booked scope, '
  'inside work becomes a no-show (reschedule by agreement, else charged).';

update public.services set needs_interior_access = true
 where name in ('Housekeeping', 'Spring opening', 'Fall winterization');

-- ------------------------------------------------- the work is held here ---
alter table public.flags
  add column if not exists at_arrival boolean not null default false;

comment on column public.flags.at_arrival is
  'Raised by the crew standing on site, BEFORE starting. These hold the job. '
  'A flag raised any other time is an ordinary correction and stops nothing.';

alter table public.jobs
  add column if not exists held_at      timestamptz,
  add column if not exists held_flag_id uuid references public.flags(id) on delete set null,
  add column if not exists no_show_at   timestamptz,
  add column if not exists no_show_reason text;

comment on column public.jobs.held_at is
  'Set when a crew raises an at-arrival discrepancy. While this is set the job '
  'CANNOT be completed — the owner has to decide first. Cleared by approve or '
  'decline; declining means the crew does the scope originally booked.';

comment on column public.jobs.no_show_at is
  'The crew arrived, needed to get inside, and could not. Not a completion and '
  'not a cancellation — its own fact, so it can be rescheduled by agreement or '
  'charged under the cancellation policy.';

-- A hold has to point at the thing being decided, or nobody can clear it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_hold_names_its_flag') then
    alter table public.jobs add constraint jobs_hold_names_its_flag
      check ((held_at is null) = (held_flag_id is null));
  end if;
end $$;

-- A no-show needs a reason, for the same purpose an invoice line does: the
-- customer may be charged for it and is entitled to know what happened.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_no_show_has_a_reason') then
    alter table public.jobs add constraint jobs_no_show_has_a_reason
      check (no_show_at is null or coalesce(btrim(no_show_reason), '') <> '');
  end if;
end $$;

-- ------------------------------------------------------- SERVER-ENFORCED ---
-- The photo gate taught this lesson: a rule the UI enforces is a rule that is
-- not enforced. Held work cannot be completed, in the database, whatever any
-- screen or action believes.
create or replace function public.jobs_held_work_cannot_complete()
returns trigger language plpgsql as $function$
begin
  if new.status in ('complete', 'paid')
     and new.held_at is not null
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    raise exception
      'jobs: this visit is waiting on the owner to approve a correction — it cannot be completed yet';
  end if;

  -- A no-show is not work done. It must not masquerade as a completed visit,
  -- because completion is what releases a payout and bills the full job.
  if new.status in ('complete', 'paid') and new.no_show_at is not null then
    raise exception
      'jobs: a no-show cannot be completed — reschedule it or charge it';
  end if;

  return new;
end $function$;

drop trigger if exists trg_jobs_held_work_cannot_complete on public.jobs;
create trigger trg_jobs_held_work_cannot_complete
  before insert or update on public.jobs
  for each row execute function public.jobs_held_work_cannot_complete();

-- ------------------------------------------------------ post-conditions ----
do $$
declare n int; ok boolean; jid uuid; fid uuid;
begin
  select count(*) into n from public.services
   where needs_interior_access and name in ('Housekeeping','Spring opening','Fall winterization');
  if n <> 3 then raise exception '0084: interior services not marked (got %)', n; end if;

  select count(*) into n from public.services
   where needs_interior_access and name in ('Lawn mowing & trim','Pier install / removal');
  if n <> 0 then raise exception '0084: outdoor work wrongly marked as needing inside'; end if;

  ok := false;
  begin
    update public.jobs set held_at = now() where id = (select id from public.jobs limit 1);
  exception when check_violation then ok := true;
       when others then ok := true;
  end;
  if not ok then raise exception '0084: a hold with no flag was accepted'; end if;

  ok := false;
  begin
    update public.jobs set no_show_at = now() where id = (select id from public.jobs limit 1);
  exception when check_violation then ok := true;
       when others then ok := true;
  end;
  if not ok then raise exception '0084: a reasonless no-show was accepted'; end if;

  -- AND THE ONE THAT MATTERS: held work cannot be completed.
  select id into jid from public.jobs where status not in ('complete','paid') limit 1;
  if jid is not null then
    insert into public.flags (job_id, type, note, status, at_arrival)
    values (jid, 'correction', '0084 post-condition', 'pending', true)
    returning id into fid;
    update public.jobs set held_at = now(), held_flag_id = fid where id = jid;

    ok := false;
    begin
      update public.jobs set status = 'complete' where id = jid;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0084: HELD WORK WAS COMPLETED — the gate does not hold'; end if;

    update public.jobs set held_at = null, held_flag_id = null where id = jid;
    delete from public.flags where id = fid;
  end if;
end $$;
