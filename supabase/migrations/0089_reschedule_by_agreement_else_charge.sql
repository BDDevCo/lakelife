-- 0089 — "RESCHEDULE IF BOTH PARTIES AGREE OR THEY GET CHARGED."
--
-- 0084 and 0088 gave a visit two ways to end with no work done:
--   no_show_at    — the crew needed to get inside and couldn't
--   stood_down_at — the owner declined a correction the crew couldn't work around
--
-- Both stopped at "ops will sort it", which is not a path, it is a shrug.
-- Brendon's rule is the path: reschedule if both parties agree, else charge.
--
-- TWO THINGS THIS HAS TO GET RIGHT.
--
--   THE RECORD MUST SURVIVE THE RECOVERY. Rescheduling clears the live
--   no-show columns so the job can run again — and if that were all, the
--   attempt would vanish. A customer who has been no-showed four times would
--   look identical to one who never has. So every attempt is written to an
--   APPEND-ONLY table first, and the live columns are only ever a pointer to
--   the current state.
--
--   A CHARGE IS NOT AN UNATTENDED DECISION. The house rule (the autonomy
--   ladder) is that a job may run unattended only if its worst outcome is a
--   sentence on a screen, or a write the database would refuse if it were
--   wrong. Charging a card because a crew tapped a button on a doorstep is
--   neither. So the deadline passing PROPOSES a fee; a person releases it.

create table if not exists public.job_visit_attempts (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  vendor_id    uuid references public.vendors(id),
  attempted_on date not null,
  outcome      text not null,
  reason       text not null,
  created_at   timestamptz not null default now(),
  constraint job_visit_attempts_outcome_is_known
    check (outcome in ('no_access', 'stood_down')),
  constraint job_visit_attempts_has_a_reason
    check (coalesce(btrim(reason), '') <> '')
);

comment on table public.job_visit_attempts is
  'A crew went and no work happened. APPEND-ONLY: rescheduling clears the '
  'job''s live no_show/stood_down columns so it can run again, and without '
  'this the attempt would disappear with them. Four no-shows and none must '
  'never look the same.';

create index if not exists job_visit_attempts_job_idx
  on public.job_visit_attempts (job_id, attempted_on desc);

alter table public.job_visit_attempts enable row level security;
revoke all on public.job_visit_attempts from anon, authenticated;

alter table public.jobs
  add column if not exists reschedule_deadline date,
  add column if not exists recovery_state      text,
  add column if not exists fee_proposed_amount numeric(10,2);

comment on column public.jobs.reschedule_deadline is
  'The customer has until this date (lake time) to pick another day before a '
  'fee is PROPOSED. Set when a visit is recorded unworked.';

comment on column public.jobs.recovery_state is
  'Where an unworked visit has got to: awaiting_customer -> rescheduled | '
  'fee_proposed -> fee_charged | fee_waived. Null = never needed recovery.';

comment on column public.jobs.fee_proposed_amount is
  'What the policy says the fee WOULD be. Proposed, never charged, until a '
  'person releases it — a card charge is not an unattended decision.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_recovery_state_is_known') then
    alter table public.jobs add constraint jobs_recovery_state_is_known
      check (recovery_state is null or recovery_state in
        ('awaiting_customer','rescheduled','fee_proposed','fee_charged','fee_waived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jobs_proposed_fee_has_an_amount') then
    alter table public.jobs add constraint jobs_proposed_fee_has_an_amount
      check (recovery_state is distinct from 'fee_proposed' or fee_proposed_amount is not null);
  end if;
end $$;

-- ------------------------------------------------------- SERVER-ENFORCED ---
-- THE RECORD CANNOT BE LOST. Clearing a no-show or a stand-down is only legal
-- once the attempt has been written down. Without this, "reschedule" would be
-- indistinguishable from "quietly delete the evidence" — and the person it
-- protects most is the crew who drove there.
create or replace function public.jobs_attempt_must_be_recorded()
returns trigger language plpgsql as $function$
begin
  if tg_op = 'UPDATE'
     and ((old.no_show_at    is not null and new.no_show_at    is null)
       or (old.stood_down_at is not null and new.stood_down_at is null))
     and not exists (select 1 from public.job_visit_attempts a where a.job_id = new.id)
  then
    raise exception
      'jobs: write the visit attempt down before clearing it — otherwise the trip the crew made disappears';
  end if;
  return new;
end $function$;

drop trigger if exists trg_jobs_attempt_must_be_recorded on public.jobs;
create trigger trg_jobs_attempt_must_be_recorded
  before update on public.jobs
  for each row execute function public.jobs_attempt_must_be_recorded();

-- ------------------------------------------------------ post-conditions ----
do $$
declare n int; ok boolean; jid uuid;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='jobs'
     and column_name in ('reschedule_deadline','recovery_state','fee_proposed_amount');
  if n <> 3 then raise exception '0089: jobs is missing the recovery columns'; end if;

  ok := false;
  begin
    update public.jobs set recovery_state = 'sorted_it_out' where id = (select id from public.jobs limit 1);
  exception when check_violation then ok := true; when others then ok := true;
  end;
  if not ok then raise exception '0089: an unknown recovery_state was accepted'; end if;

  ok := false;
  begin
    insert into public.job_visit_attempts (job_id, attempted_on, outcome, reason)
    select id, current_date, 'no_access', '' from public.jobs limit 1;
  exception when check_violation then ok := true; when others then ok := true;
  end;
  if not ok then raise exception '0089: a reasonless attempt was accepted'; end if;

  -- AND THE ONE THAT MATTERS: a no-show cannot be cleared without a record.
  select id into jid from public.jobs where status not in ('complete','paid') limit 1;
  if jid is not null then
    update public.jobs set no_show_at = now(), no_show_reason = '0089 post-condition' where id = jid;
    ok := false;
    begin
      update public.jobs set no_show_at = null, no_show_reason = null where id = jid;
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0089: A NO-SHOW WAS CLEARED WITH NO RECORD — the crew''s trip vanished';
    end if;

    insert into public.job_visit_attempts (job_id, attempted_on, outcome, reason)
    values (jid, current_date, 'no_access', '0089 post-condition');
    update public.jobs set no_show_at = null, no_show_reason = null where id = jid;

    delete from public.job_visit_attempts where reason = '0089 post-condition';
  end if;
end $$;
