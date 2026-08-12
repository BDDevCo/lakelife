-- 0088 — "NO" IS NOT ALWAYS A SMALLER JOB.
--
-- 0084 told the crew: if the owner declines your correction, do the job as it
-- was booked. That quietly assumes EVERY JOB IS DIVISIBLE. Brendon caught it
-- looking at the screen:
--
--   "what if the crew cannot do the job because the inaccuracy..... or for
--    this example they just put in x sections of the pier and dont do the
--    rest?"
--
-- Both are real, and they are different failures.
--
--   CAN'T DO IT AT ALL. A pier REMOVAL at 8 of 12 sections leaves four
--   sections in the water over winter, where the ice destroys them. That is
--   not a smaller job, it is damage. Same for a boat that turns out to be
--   26 feet when the trailer was sent for 19.
--
--   DID PART OF IT AND LEFT. The crew installs the 8 that were booked, leaves
--   4 in the yard, and taps Complete. The invoice then says "Pier install OK"
--   while the owner looks at a pier ending in open water. The record and the
--   reality disagree, and the record is the one that gets paid.
--
-- THE PERSON WHO KNOWS WHICH CASE IT IS, IS THE CREW STANDING THERE. So they
-- are asked, once, at the moment they raise the discrepancy — not left to
-- discover it after the owner has already said no.

alter table public.flags
  add column if not exists crew_can_proceed  boolean,
  add column if not exists crew_cannot_reason text;

comment on column public.flags.crew_can_proceed is
  'At-arrival flags only. TRUE = "if they say no, I can still do what was '
  'booked" (a shorter pier, a partial clean). FALSE = "I cannot do this job '
  'at all without the change" — declining then stands the crew down instead '
  'of sending them at an impossible scope. NULL = not asked (legacy).';

comment on column public.flags.crew_cannot_reason is
  'Why the booked scope is impossible, in the crew''s words. Shown to the '
  'owner BEFORE they decide, because it changes what "no" means.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'flags_cannot_proceed_has_a_reason') then
    alter table public.flags add constraint flags_cannot_proceed_has_a_reason
      check (crew_can_proceed is distinct from false
             or coalesce(btrim(crew_cannot_reason), '') <> '');
  end if;
end $$;

-- ------------------------------------------------- the crew was sent away ---
-- Distinct from a no-show on purpose. A no-show is "nobody let us in". This is
-- "the owner answered, said no, and the booked job cannot be done." Different
-- cause, different conversation, different fault — so a different fact.
alter table public.jobs
  add column if not exists stood_down_at     timestamptz,
  add column if not exists stood_down_reason text;

comment on column public.jobs.stood_down_at is
  'The owner declined a correction the crew said they could not work around, '
  'so no work happened. Not a no-show (somebody was home and answered) and '
  'not a completion. Ops reschedules or cancels it.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_stood_down_has_a_reason') then
    alter table public.jobs add constraint jobs_stood_down_has_a_reason
      check (stood_down_at is null or coalesce(btrim(stood_down_reason), '') <> '');
  end if;
end $$;

alter table public.jobs
  add column if not exists scope_note text;

comment on column public.jobs.scope_note is
  'Written when an owner declines a correction and the crew proceeds anyway: '
  'plainly states what was done versus what the crew found, so a completed '
  'job never silently claims more than happened. It is the owner''s own '
  'decision, recorded — which protects the crew as much as the customer.';

-- ------------------------------------------------------- SERVER-ENFORCED ---
create or replace function public.jobs_held_work_cannot_complete()
returns trigger language plpgsql as $function$
begin
  if new.status in ('complete', 'paid')
     and new.held_at is not null
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    raise exception
      'jobs: this visit is waiting on the owner to approve a correction — it cannot be completed yet';
  end if;

  if new.status in ('complete', 'paid') and new.no_show_at is not null then
    raise exception
      'jobs: a no-show cannot be completed — reschedule it or charge it';
  end if;

  -- 0088: the owner said no to something the crew could not work around.
  if new.status in ('complete', 'paid') and new.stood_down_at is not null then
    raise exception
      'jobs: the crew was stood down on this one — no work happened, so it cannot be completed';
  end if;

  return new;
end $function$;

-- ------------------------------------------------------ post-conditions ----
do $$
declare n int; ok boolean;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='flags'
     and column_name in ('crew_can_proceed','crew_cannot_reason');
  if n <> 2 then raise exception '0088: flags is missing the proceed columns'; end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='jobs'
     and column_name in ('stood_down_at','stood_down_reason','scope_note');
  if n <> 3 then raise exception '0088: jobs is missing the stand-down columns'; end if;

  ok := false;
  begin
    insert into public.flags (type, note, status, at_arrival, crew_can_proceed)
    values ('pier_sections', 'test', 'pending', true, false);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0088: a cannot-proceed flag with no reason was accepted'; end if;

  ok := false;
  begin
    update public.jobs set stood_down_at = now() where id = (select id from public.jobs limit 1);
  exception when check_violation then ok := true; when others then ok := true;
  end;
  if not ok then raise exception '0088: a reasonless stand-down was accepted'; end if;
end $$;

-- =========================================================================
-- A NOTE FOR WHOEVER ADDS THE NEXT FOREIGN KEY BETWEEN TWO EXISTING TABLES.
--
-- 0084 added `jobs.held_flag_id -> flags(id)`. That gave `flags` and `jobs`
-- TWO relationships (the other being `flags.job_id -> jobs.id`), and PostgREST
-- then refuses a bare `jobs(...)` embed with 300 PGRST201 — which supabase-js
-- surfaces as {error, data:null}. The approvals screen rendered "No approvals
-- waiting" for every owner, with nothing logged, until it was found by opening
-- the page. Both queries now name the key: `jobs!flags_job_id_fkey(...)`.
-- =========================================================================
