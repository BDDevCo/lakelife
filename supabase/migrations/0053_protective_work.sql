-- ============================================================================
-- 0053 — PROTECTIVE WORK: the nightly may never cancel a job whose absence
--        destroys property.
--
-- THE BUG, verified in src/lib/automation.ts (expireUnfilledJobs): when a job's
-- date passes with no crew assigned, the nightly flips it to `cancelled` and
-- texts the customer:
--
--   "we couldn't line up a crew in time for {service} at {where} — so we've
--    cancelled it and you were never charged."
--
-- For a mow that is the honest floor, and it was built deliberately as one
-- (ladder rung 8: no silent rot, no ops queue). For a WINTERIZATION before a
-- hard freeze it is a burst pipe, a destroyed home, a habitability claim, and
-- a text from us that reads as a shrug. "You were never charged" is not the
-- point when the furnace line splits.
--
-- The carve-out template already exists eight lines above the cancel, in the
-- same function: the storage-custody guard skips any visit whose boat is in
-- the barn, because "cancelling the envelope would silence the overstay meter
-- and strand the boat." Same shape. Higher stakes.
--
-- WHY A TRIGGER AND NOT JUST THE `continue`: 0050 established that a rule the
-- platform depends on lives in the DATABASE, because an app-layer guard is one
-- refactor away from being edited out by someone who does not know what it was
-- for. After this migration, no future change to the nightly can burst a pipe.
--
-- Ops visibility is the other half and it is NOT optional: getNeedsAttention
-- filters `date >= today`, so a past-dated unfilled job disappears from the ops
-- console entirely. Cancelling is what made that safe. Removing the cancel
-- without widening that query would turn a loud wrong answer into a silent
-- one, which is worse. That change ships in the same commit.
-- ============================================================================

-- Rule 8: this is a per-service DIAL in the database, not a list in code. Ops
-- can promote a service to protective without a deploy, and a new service
-- lands as routine until somebody decides otherwise.
alter table public.services
  add column if not exists criticality text not null default 'routine';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'services_criticality_check'
  ) then
    alter table public.services
      add constraint services_criticality_check
      check (criticality in ('routine', 'protective'));
  end if;
end $$;

comment on column public.services.criticality is
  'protective = the ABSENCE of this work destroys property (winterization '
  'before a freeze; a pier or lift left in through ice-up). A protective job '
  'is never auto-cancelled by the nightly and never disappears from ops. '
  'routine = a missed visit is a disappointment, not damage.';

-- Why a job was cancelled, so the trigger below can tell an automated sweep
-- from a person. Null on every historical row, which the trigger reads as
-- "not an authorised human cancel" — correct, and those rows are already
-- terminal so nothing re-evaluates them.
alter table public.jobs
  add column if not exists cancel_reason text;

comment on column public.jobs.cancel_reason is
  'Who ended this job and on what authority: customer_request | ops_override | '
  'expired_unfilled | policy. Load-bearing — jobs_protective_no_autocancel '
  'reads it to distinguish a human decision from an automated sweep.';


-- ---------------------------------------------------------------- the gate --
-- A protective job may only be cancelled by a PERSON. The nightly, a future
-- nightly, and anything else that flips a status without saying why are all
-- refused.
create or replace function public.guard_protective_cancel()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare crit text;
begin
  if new.status <> 'cancelled' or old.status = 'cancelled' then
    return new;
  end if;

  select s.criticality into crit
    from public.services s where s.id = new.service_id;

  -- Unknown/absent criticality is treated as routine, matching the column
  -- default and lib/waitlist.ts expiryActionFor(). A service row that vanished
  -- cannot be protective.
  if crit is null or crit = 'routine' then
    return new;
  end if;

  if new.cancel_reason is null
     or new.cancel_reason not in ('customer_request', 'ops_override') then
    raise exception
      'protective work cannot be auto-cancelled (job %, service criticality %). '
      'A person must cancel it with cancel_reason customer_request or ops_override.',
      new.id, crit;
  end if;

  return new;
end $$;

drop trigger if exists jobs_protective_no_autocancel on public.jobs;
create trigger jobs_protective_no_autocancel
  before update on public.jobs
  for each row execute function public.guard_protective_cancel();


-- ------------------------------------------------------- which services -----
-- Only the unambiguous cases: work whose absence splits a pipe or cracks a
-- block. Named, not pattern-matched, so a future service called "Winter
-- flower planting" is not swept in by a LIKE '%winter%'.
--
-- DELIBERATELY NOT FLAGGED YET: pier and lift REMOVAL, which is genuinely
-- protective (ice destroys a pier left in), because "Pier install / removal"
-- is ONE service row covering both directions and the spring install is not
-- protective at all. Flagging the row would make every spring install
-- un-cancellable. That needs the phase distinction the storage packages
-- already have (package_components.role, migration 0051) and it is a separate
-- piece of work — rule 7's pull deadline is the current guard there.
update public.services set criticality = 'protective'
 where name in (
   'Fall winterization',
   'Boat storage & winterize',
   'Jet ski winterize & store',
   'Boat winterization (shop)'
 )
   and criticality is distinct from 'protective';


-- ------------------------------------------------------ post-conditions -----
-- 0050's lesson: "no error" is not proof. A PL/pgSQL slip rolls the whole file
-- back in silence. Assert that the load-bearing objects EXIST.
do $$
declare n int;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='services' and column_name='criticality'
  ) then
    raise exception '0053: services.criticality did not land';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='jobs' and column_name='cancel_reason'
  ) then
    raise exception '0053: jobs.cancel_reason did not land';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'jobs_protective_no_autocancel' and not tgisinternal
  ) then
    raise exception '0053: the protective-cancel guard did not land — the nightly could still cancel a winterization';
  end if;

  select count(*) into n from public.services where criticality = 'protective';
  -- Zero is legitimate on a bare rebuild that has not seeded services yet.
  -- Non-zero here means the seed ran and the flags took.
  raise notice '0053: protective-work guard active. % service(s) flagged protective.', n;
end $$;
