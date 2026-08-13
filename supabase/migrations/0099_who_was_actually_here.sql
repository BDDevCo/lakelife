-- 0099 — WHO WAS ACTUALLY HERE.
--
-- Brendon wants the crew to be able to say who was on a job, so the company
-- owner can hand tips to the right person and see who was where. Built small
-- and OPTIONAL, and deliberately without the two things that would change what
-- LakeLife is.
--
-- WHY IT EXISTS AT ALL: 0097 pays tips to a company, and there is ONE bank
-- account per company. The earnings statement attributes tips using
-- `routes.unit_name`, which only exists when the nightly fleet router assigned
-- a named truck — a hand-assigned job says "Crew not recorded" forever. Asking
-- the crew is the honest source; inferring it from a route is a guess that
-- fails silently.
--
-- ============================ THE LINE THIS MUST NOT CROSS ==================
--
-- LakeLife is a THIRD-PARTY ADMINISTRATOR. The crews are independent
-- businesses, and that posture is the whole legal footing of the company.
-- Holding a roster of somebody else's workers and scoring them is a textbook
-- indicator of CONTROL — the joint-employer question that has cost this entire
-- category enormous sums.
--
-- So the rule, and it belongs in the schema rather than in somebody's memory:
--
--   A worker is the VENDOR'S data, held for them. It is NEVER an input to
--   LakeLife's routing, pricing, crew standing, or dispatch decisions.
--
-- The owner sees their own people. The moment our dispatch reads a worker to
-- decide anything, LakeLife has stopped being an administrator. If you are
-- about to join `crew_workers` into anything under src/lib/router,
-- src/app/book/dispatch or lake-standing: don't.
--
-- ALSO DELIBERATELY ABSENT: a customer cannot tip a named person. The money
-- lands in one company account, so "tip Fred $20" would be a promise we have
-- no mechanism to keep — worse than today's honest "it goes to the crew, the
-- split is yours". That waits until crews say whether they want individual
-- payment, which is a conversation, not a schema decision.

-- ------------------------------------------------------------ the roster ---
create table if not exists public.crew_workers (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors(id) on delete cascade,
  name        text not null,
  -- Soft delete. Seasonal lake crews turn over; a worker who has left must
  -- disappear from the picker WITHOUT disappearing from last season's
  -- statement.
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.crew_workers is
  'A vendor''s own people, for THEIR reporting and tip splits. Never an input '
  'to LakeLife routing, pricing or crew standing — see 0099 header. Optional: '
  'a vendor who keeps no roster loses nothing they have today.';

create index if not exists crew_workers_vendor_idx
  on public.crew_workers (vendor_id) where active;

-- Two people at one company may not share a name, or the picker is a coin toss.
create unique index if not exists crew_workers_unique_name
  on public.crew_workers (vendor_id, lower(btrim(name)));

-- -------------------------------------------------------- who did the job ---
create table if not exists public.job_workers (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  -- SET NULL, not RESTRICT: unlike a payment record (0097), the useful thing
  -- here is the NAME, and it is snapshotted below. Deleting a worker must not
  -- be blocked by history, and must not rewrite it either.
  worker_id   uuid references public.crew_workers(id) on delete set null,
  -- THE SNAPSHOT, same reasoning as `routes.unit_name`: renaming or removing
  -- somebody next season must never change what last season's statement said.
  name        text not null,
  created_at  timestamptz not null default now()
);

comment on table public.job_workers is
  'Who the crew says was on a job. OPTIONAL — completion is never gated on it '
  '(the photo gate is the only gate). `name` is a snapshot so history is '
  'stable when a worker is renamed or removed.';

create index if not exists job_workers_job_idx on public.job_workers (job_id);

-- The same person, twice, on one job is a double-tap, not a fact.
create unique index if not exists job_workers_once_per_job
  on public.job_workers (job_id, worker_id) where worker_id is not null;

-- ------------------------------------------------------------------- RLS ---
alter table public.crew_workers enable row level security;
alter table public.job_workers  enable row level security;

-- Mirrors `crew_units_read`: the vendor who owns the row, or ops.
drop policy if exists crew_workers_read on public.crew_workers;
create policy crew_workers_read on public.crew_workers
  for select using (
    public.ll_is_ops()
    or exists (select 1 from public.vendors v
                where v.id = crew_workers.vendor_id and v.user_id = auth.uid())
  );

-- `ll_my_vendor_job` already answers "is this job on my route?" (0010).
drop policy if exists job_workers_read on public.job_workers;
create policy job_workers_read on public.job_workers
  for select using (public.ll_is_ops() or public.ll_my_vendor_job(job_workers.job_id));

-- RLS IS NOT A GRANT — the standing lesson of this project. Every write goes
-- through a server action holding the service role; no browser needs INSERT on
-- either table, so no browser gets it.
revoke insert, update, delete on public.crew_workers from anon, authenticated;
revoke insert, update, delete on public.job_workers  from anon, authenticated;
revoke select on public.crew_workers from anon;
revoke select on public.job_workers  from anon;

-- AND THE REST OF 0060'S LIST. 0060 revoked truncate/references/trigger across
-- `all tables in schema public` — which was a ONE-TIME SWEEP, not a standing
-- rule. Every table created since re-acquires them from Supabase's defaults,
-- so a migration that adds a table and stops at insert/update/delete leaves
-- the same gap 0060 was written to close. (Not reachable through PostgREST,
-- which exposes no TRUNCATE — but "not reachable today" is how the write
-- grants got left alone in the first place.)
revoke truncate, references, trigger on public.crew_workers from anon, authenticated;
revoke truncate, references, trigger on public.job_workers  from anon, authenticated;

-- ------------------------------------------------------ post-conditions ----
do $$
declare vid uuid; jid uuid; w1 uuid; w2 uuid; ok boolean;
begin
  select id into vid from public.vendors limit 1;
  select id into jid from public.jobs limit 1;
  if vid is null or jid is null then return; end if;

  begin
    insert into public.crew_workers (vendor_id, name) values (vid, '0099 Alice') returning id into w1;
    insert into public.crew_workers (vendor_id, name) values (vid, '0099 Bob')   returning id into w2;

    -- 1. A NAME IS UNIQUE PER VENDOR, case- and space-insensitively.
    ok := false;
    begin
      insert into public.crew_workers (vendor_id, name) values (vid, '  0099 alice ');
    exception when unique_violation then ok := true;
    end;
    if not ok then raise exception '0099: one vendor took two workers with the same name'; end if;

    -- 2. Two people on one job is the normal case.
    insert into public.job_workers (job_id, worker_id, name) values (jid, w1, '0099 Alice');
    insert into public.job_workers (job_id, worker_id, name) values (jid, w2, '0099 Bob');

    -- 3. The same person twice is not.
    ok := false;
    begin
      insert into public.job_workers (job_id, worker_id, name) values (jid, w1, '0099 Alice');
    exception when unique_violation then ok := true;
    end;
    if not ok then raise exception '0099: the same worker was recorded twice on one job'; end if;

    -- 4. THE ONE THAT MATTERS: removing a worker keeps the history readable.
    delete from public.crew_workers where id = w1;
    if not exists (select 1 from public.job_workers
                    where job_id = jid and name = '0099 Alice' and worker_id is null) then
      raise exception '0099: deleting a worker destroyed or rewrote the job history';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
