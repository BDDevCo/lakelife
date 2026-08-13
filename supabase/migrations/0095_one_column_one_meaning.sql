-- 0095 — ONE COLUMN, ONE MEANING.
--
-- 0088 added `jobs.scope_note` for exactly one thing: what the crew DID versus
-- what they FOUND, on a job that went ahead at a reduced scope after the owner
-- declined a correction. Its whole purpose is that "a completed job never
-- silently claims more than happened", and the owner is promised in writing —
-- src/lib/arrival.ts — that "we'll note on the job what was and wasn't done".
--
-- 0089's `waiveProposedFee` then reused the same column for "Visit fee waived:
-- <reason>", which is a different fact about a job where NO work happened at
-- all. The two populations are disjoint today so nothing has been clobbered
-- yet, but a column with two meanings is how a screen ends up printing a
-- waiver reason where it promised to say what was done — and the fix is much
-- cheaper before anything starts reading it.

alter table public.jobs
  add column if not exists fee_waived_reason text;

comment on column public.jobs.fee_waived_reason is
  'Why a person waived the fee on an unworked visit. Its own column because '
  'scope_note means something else entirely: what the crew did versus what '
  'they found, on a visit that DID go ahead.';

comment on column public.jobs.scope_note is
  'What was done versus what the crew found, when an owner declined a '
  'correction and the visit went ahead at the booked scope. The owner is '
  'promised this in writing at the moment they decline, so it must reach a '
  'screen. Never reused for anything else — see fee_waived_reason.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_waiver_has_a_reason') then
    alter table public.jobs add constraint jobs_waiver_has_a_reason
      check (recovery_state is distinct from 'fee_waived'
             or coalesce(btrim(fee_waived_reason), '') <> ''
             -- Stand-downs are auto-waived by the nightly and carry their
             -- reason on stood_down_reason instead, so they are exempt.
             or stood_down_at is not null);
  end if;
end $$;

do $$
declare n int; ok boolean; jid uuid;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='jobs' and column_name='fee_waived_reason';
  if n <> 1 then raise exception '0095: jobs.fee_waived_reason missing'; end if;

  select id into jid from public.jobs where status not in ('complete','paid') limit 1;
  if jid is null then return; end if;

  ok := false;
  begin
    update public.jobs set recovery_state = 'fee_waived', fee_proposed_amount = 10 where id = jid;
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0095: a reasonless waiver was accepted'; end if;

  update public.jobs
     set recovery_state = 'fee_waived', fee_waived_reason = '0095 post-condition'
   where id = jid;
  update public.jobs set recovery_state = null, fee_waived_reason = null where id = jid;

  -- An auto-waived stand-down is exempt, because its reason lives on
  -- stood_down_reason. Note 0089's trigger refuses to CLEAR a stand-down
  -- unless the attempt is written down first — it fired on the first draft of
  -- this block, correctly, so the record is written here too.
  update public.jobs
     set stood_down_at = now(), stood_down_reason = '0095 stand-down', recovery_state = 'fee_waived'
   where id = jid;

  insert into public.job_visit_attempts (job_id, attempted_on, outcome, reason)
  values (jid, current_date, 'stood_down', '0095 post-condition');

  update public.jobs
     set recovery_state = null, fee_waived_reason = null,
         stood_down_at = null, stood_down_reason = null
   where id = jid;

  delete from public.job_visit_attempts where reason = '0095 post-condition';
end $$;
