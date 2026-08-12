-- 0079 — DID THE MACHINE ACTUALLY RUN LAST NIGHT?
--
-- /park/today tells the owner "checked last night" or "worked out just now".
-- Without a record of the run, the first of those was a guess: a nightly that
-- died, or never fired at all, produced a screen that said everything had been
-- checked. A quiet screen has to mean "we looked and found nothing", never "we
-- didn't look".
--
-- The unique index on (park_id, run_on, runner) is a CLAIM, not just a
-- constraint. The runner inserts its row FIRST; a duplicate-key failure is how
-- a second invocation on the same night discovers it has nothing to do. That
-- makes a manual re-trigger safe and keeps a retried cron from double-billing
-- or double-notifying.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE EXISTS LATE: this table was applied directly to production and
-- the migration was never committed. The repo is what a rebuilt environment is
-- made from, so for a while any fresh database silently lacked the table — and
-- park-machine.ts treats an insert failure as "already ran tonight", meaning a
-- rebuilt environment would have reported clean nights while doing nothing at
-- all. Reconstructed here verbatim from the live schema and made idempotent so
-- it is a no-op against production.
-- ---------------------------------------------------------------------------

create table if not exists public.park_machine_runs (
  id          uuid primary key default gen_random_uuid(),
  park_id     uuid not null references public.parks(id) on delete cascade,

  -- The LAKE date the run is for, not a timestamp. The nightly fires at 8pm
  -- Indiana, so a UTC-derived day would file half the year's runs under
  -- tomorrow and make "checked last night" wrong by one.
  run_on      date not null,
  runner      text not null,

  ok          boolean not null default true,
  error       text,

  -- How many things it noticed. Zero means it looked and the park was clean.
  found       integer not null default 0 check (found >= 0),

  -- Stamped when the run COMPLETES. A row with a null finished_at is a run
  -- that claimed the night and then died partway — which must not be counted
  -- as a good night just because `ok` still holds its default.
  finished_at timestamptz,
  created_at  timestamptz not null default now(),

  -- A FAILURE MUST SAY WHY. "It didn't work" with no reason is the same as
  -- silence, and silence is the failure mode this whole table exists to close.
  constraint machine_run_failure_has_a_reason check (ok or error is not null)
);

-- THE CLAIM. Insert-first; a 23505 means somebody else has tonight.
create unique index if not exists park_machine_runs_claim_idx
  on public.park_machine_runs (park_id, run_on, runner);

create index if not exists park_machine_runs_recent_idx
  on public.park_machine_runs (park_id, run_on desc);

alter table public.park_machine_runs enable row level security;

-- Read-only to the humans it concerns. Every write is the service role.
drop policy if exists park_machine_runs_read on public.park_machine_runs;
create policy park_machine_runs_read on public.park_machine_runs
  for select using (public.ll_manages_park(park_id) or public.ll_is_ops());

revoke insert, update, delete on public.park_machine_runs from anon, authenticated;

comment on table public.park_machine_runs is
  'One row per park per night per runner. The unique index is a claim: the '
  'runner inserts before working, and a duplicate key is how it learns the '
  'night is already taken. finished_at null = claimed then died.';


-- ------------------------------------------------------ post-conditions -----
-- Prove the shape rather than trusting that the statements above ran.
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'park_machine_runs'
     and column_name in ('park_id', 'run_on', 'runner', 'ok', 'error', 'found', 'finished_at');
  if n <> 7 then
    raise exception '0079: park_machine_runs is missing columns (found %)', n;
  end if;

  if not exists (
    select 1 from pg_indexes
     where tablename = 'park_machine_runs' and indexname = 'park_machine_runs_claim_idx'
  ) then
    raise exception '0079: the claim index is missing — two runs could both take the same night';
  end if;

  -- The failure-needs-a-reason rule must actually refuse. Attempt the
  -- violation; if it succeeds, the constraint is decorative.
  begin
    insert into public.park_machine_runs (park_id, run_on, runner, ok, error)
    values ('00000000-0000-0000-0000-000000000000', '1900-01-01', '__probe__', false, null);
    raise exception '0079: a failed run with no reason was accepted';
  exception
    when check_violation then null;         -- refused for the right reason
    when foreign_key_violation then null;   -- refused earlier; the park is fake
  end;
end $$;
