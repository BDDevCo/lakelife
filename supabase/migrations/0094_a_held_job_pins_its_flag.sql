-- 0094 — A HELD JOB PINS ITS FLAG.
--
-- Two guards written the same night contradict each other:
--
--   0084: jobs.held_flag_id -> flags(id) ON DELETE SET NULL
--   0084: check ((held_at is null) = (held_flag_id is null))
--
-- So deleting a flag that is holding a job makes the FK null the column, and
-- the check immediately refuses the row. Postgres reports it as a check
-- violation on `jobs` during a DELETE on `flags`, which reads like a bug in
-- the wrong table. Found while tearing down a fixture; it would read exactly
-- the same way to somebody trying to clean up a bad flag in production.
--
-- RESTRICT SAYS THE TRUE THING. A flag that is holding a job cannot be
-- deleted — the hold has to be released first, by approving or declining it,
-- which is the decision the hold exists to force. SET NULL was trying to
-- express "the flag is optional", and it is not: while `held_at` is set, that
-- flag IS the thing the owner is deciding about, and losing it would strand
-- the job in a hold nobody could clear.

alter table public.jobs drop constraint if exists jobs_held_flag_id_fkey;
alter table public.jobs add constraint jobs_held_flag_id_fkey
  foreign key (held_flag_id) references public.flags(id) on delete restrict;

comment on column public.jobs.held_flag_id is
  'The at-arrival flag this job is held on. ON DELETE RESTRICT: while a hold '
  'is live the flag cannot be deleted, because it is the thing being decided. '
  'Release the hold (approve or decline) and the flag becomes deletable.';

do $$
declare jid uuid; fid uuid; ok boolean;
begin
  select id into jid from public.jobs where status not in ('complete','paid') limit 1;
  if jid is null then return; end if;

  insert into public.flags (job_id, type, note, status, at_arrival)
  values (jid, 'correction', '0094 post-condition', 'pending', true)
  returning id into fid;
  update public.jobs set held_at = now(), held_flag_id = fid where id = jid;

  ok := false;
  begin
    delete from public.flags where id = fid;
  exception when foreign_key_violation then ok := true;
  end;
  if not ok then
    raise exception '0094: a flag holding a job was deletable — the hold could be orphaned';
  end if;

  update public.jobs set held_at = null, held_flag_id = null where id = jid;
  delete from public.flags where id = fid;
  if exists (select 1 from public.flags where id = fid) then
    raise exception '0094: a released flag was still undeletable';
  end if;
end $$;
