-- ============================================================
--  LakeLife — waitlist warning SENT-LEDGER (two-season audit,
--  bug 10d). The "we're still lining up a crew — pick another
--  day or invite your own" text is the customer's LAST chance
--  to act before the machine cancels. It used to be a bare
--  date equality: one missed nightly lost it forever, and a
--  manual re-run re-texted everyone on the boundary.
--
--  lib/waitlist.ts now says when the warning is OWED (a short
--  catch-up window); this table says whether it was already
--  SENT. The unique index is the exactly-once guarantee — the
--  insert IS the claim, so two runs racing the same job can
--  only produce one text. Same shape and posture as nudge_log
--  (0030): ops-readable, client-write-proof.
--  Run once. Safe to re-run.
-- ============================================================

create table if not exists public.waitlist_notice_log (
  id      uuid primary key default gen_random_uuid(),
  job_id  uuid not null references public.jobs(id) on delete cascade,
  kind    text not null,
  sent_at timestamptz not null default now()
);

-- THE guarantee: one notice of a kind per job, ever. Losing this index
-- turns the catch-up window back into a nightly nag.
create unique index if not exists waitlist_notice_log_once
  on public.waitlist_notice_log (job_id, kind);
create index if not exists waitlist_notice_log_recent
  on public.waitlist_notice_log (kind, sent_at desc);

alter table public.waitlist_notice_log enable row level security;
drop policy if exists waitlist_notice_log_ops on public.waitlist_notice_log;
create policy waitlist_notice_log_ops on public.waitlist_notice_log for select using (public.ll_is_ops());

-- MEMORY (supabase-default-write-grants): RLS alone does not stop a client
-- write — the default grants must be revoked explicitly. Only the service
-- role (the nightly) ever writes this ledger.
revoke insert, update, delete on public.waitlist_notice_log from authenticated, anon;
grant select on public.waitlist_notice_log to authenticated;
