-- 0186 — THE TWO SCHEDULES THAT LEAVE NO TRACE.
--
-- Three things are scheduled. ONE of them already proves it ran, and this
-- migration deliberately does not touch it: the nightly's park step claims a
-- park_machine_runs row (0079) before it works and stamps finished_at when it
-- is done, and /park/today turns absence into an alarm the owner reads when he
-- opens the page. That direction is right and it is argued in full in
-- src/app/park/machine-helpers.ts — an alert sent BY the scheduler cannot fire
-- when the scheduler is the thing that died. The nightly is therefore NOT in
-- this table and must never be: a job that checks itself always passes, which
-- is worse than no check because it makes the screen say somebody looked.
--
-- The other two prove nothing at all:
--
--   * /api/cron/seasonal — Vercel, `0 12 * * *`, 8am at the lakes. On the ~362
--     days a year when no lake's pull deadline is exactly 14 days out,
--     sendSeasonalPullReminders returns {ok:true, lakes:0, emailed:0} at its
--     first branch and the route writes nowhere. That is indistinguishable
--     from a cron that stopped firing in March. The cost lands once: the
--     single date per lake per year when the freeze warning goes out, and by
--     then the silence is eight months old and the send is never retried.
--
--   * /api/cron/intraday — Supabase pg_cron, every 30 minutes (0023). Its
--     result is JSON nothing in this repo reads. A DIFFERENT RAIL from the two
--     above, which is exactly why the nightly watching it is worth something:
--     pg_cron and Vercel Cron fail separately.
--
-- ONE ROW PER JOB, NOT ONE PER RUN. The intraday beat fires 48 times a day; a
-- per-run history would grow forever with no reader and no retention sweep.
-- The only question actually asked of this table is "when was this job last
-- seen alive?", so it holds one row per job and every run overwrites it.
--
-- ABSENCE IS LOUDER THAN LATENESS, and the SHAPE carries that rather than a
-- flag doing it: a job that has never run has NO ROW, which is a different
-- fact from a row with an old timestamp. cronAlarms() gives the two different
-- sentences, and cron-health.test.ts requires them to differ.

create table if not exists public.cron_runs (
  -- The scheduled job's name. PRIMARY KEY: one row per job, overwritten.
  -- WRITER: stampCronRun() in src/lib/cron-health.ts, and nowhere else. It is
  -- called from src/app/api/cron/seasonal/route.ts and
  -- src/app/api/cron/intraday/route.ts. READER: checkCronHealth() in the same
  -- file, called from src/app/api/cron/nightly/route.ts.
  job              text primary key,

  -- When the most recent invocation began, stamped immediately after the
  -- CRON_SECRET check. WRITER: stampCronRun(job, "started").
  last_started_at  timestamptz not null,

  -- When that invocation ended, on EITHER ending. Null — or older than
  -- last_started_at — means it began and did not come back, which is not the
  -- same as a run that went fine even though last_ok is still sitting on its
  -- default of true. That is the exact trap 0079 documents for finished_at.
  -- WRITER: stampCronRun(job, "finished", …).
  last_finished_at timestamptz,

  -- Whether that ending was the good one. WRITER: stampCronRun finish.
  last_ok          boolean not null default true,
  last_error       text,

  -- A FAILURE MUST SAY WHY — the same rule 0079 set for park_machine_runs.
  -- "It didn't work" with no reason is the silence this table exists to close.
  constraint cron_run_failure_has_a_reason check (last_ok or last_error is not null)
);

alter table public.cron_runs enable row level security;

-- Ops only. A homeowner or a crew has no business knowing our schedule.
drop policy if exists cron_runs_read on public.cron_runs;
create policy cron_runs_read on public.cron_runs
  for select using (public.ll_is_ops());

-- The standing `alter default privileges` does NOT revoke writes from
-- `authenticated`; that revoke has to be written per table or PostgREST leaves
-- the door open regardless of RLS. Every write here is the service role.
revoke insert, update, delete on public.cron_runs from anon, authenticated;

comment on table public.cron_runs is
  'One row per scheduled job, overwritten on every run: when it last started, '
  'when it last finished, and whether that ending was good. Written only by '
  'stampCronRun() in lib/cron-health.ts; read only by checkCronHealth(), which '
  'the nightly calls so a job that stopped firing reaches the digest. The '
  'nightly itself is deliberately NOT in here — it cannot report its own '
  'death; its dead-man is park_machine_runs (0079), read on /park/today.';

-- ------------------------------------------------------ post-conditions -----
-- Prove the shape rather than trusting that the statements above ran.
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'cron_runs'
     and column_name in ('job','last_started_at','last_finished_at','last_ok','last_error');
  if n <> 5 then
    raise exception '0186: cron_runs is missing columns (found %)', n;
  end if;

  -- The failure-needs-a-reason rule must actually REFUSE. Attempt the
  -- violation; if it succeeds, the constraint is decorative.
  begin
    insert into public.cron_runs (job, last_started_at, last_ok, last_error)
    values ('__probe__', now(), false, null);
    raise exception '0186: a failed run with no reason was accepted';
  exception
    when check_violation then null;   -- refused for the right reason
  end;

  -- And a clean stamp must round-trip, so the table is not merely present but
  -- actually writable by the role that will be doing the stamping.
  insert into public.cron_runs (job, last_started_at) values ('__probe__', now());
  if not exists (select 1 from public.cron_runs where job = '__probe__') then
    raise exception '0186: a clean stamp did not land';
  end if;
  delete from public.cron_runs where job = '__probe__';
end $$;
