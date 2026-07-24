-- ============================================================
--  LakeLife — Make-It-Right disputes (Autonomy Ladder, 2026-07-23).
--  A thumbs-down with a note opens a dispute and HOLDS the crew payout;
--  the crew gets one-tap fix / verify / talk links (right-to-cure per ToS
--  §11.5); resolution releases or claws the money. One OPEN dispute/job.
--  Run once. Safe to re-run. (Applied in prod as 0045.)
-- ============================================================

create table if not exists public.disputes (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.jobs(id) on delete cascade,
  customer_note     text,
  status            text not null default 'crew_review'
    check (status in ('crew_review','fixing','verifying','talk','escalated',
                      'resolved_fixed','resolved_verified','resolved_refunded','resolved_closed')),
  crew_token        text not null unique,
  customer_token    text not null unique,
  correction_job_id uuid references public.jobs(id) on delete set null,
  opened_at         timestamptz not null default now(),
  respond_by        timestamptz not null,
  resolved_at       timestamptz,
  resolution        text
);
create unique index if not exists disputes_one_open_per_job
  on public.disputes (job_id)
  where (status in ('crew_review','fixing','verifying','talk','escalated'));

alter table public.disputes enable row level security;
drop policy if exists disputes_ops on public.disputes;
create policy disputes_ops on public.disputes for select using (public.ll_is_ops());
revoke insert, update, delete on public.disputes from authenticated, anon;
grant select on public.disputes to authenticated;

alter table public.jobs add column if not exists correction_of uuid references public.jobs(id) on delete set null;
alter table public.messages add column if not exists ai boolean not null default false;
alter table public.services add column if not exists last_auto_priced_at timestamptz;

insert into public.platform_settings (key, value) values
  ('dispute_response_hours', '24'),
  ('dispute_auto_refund_max', '150'),
  ('dispute_fix_days', '7'),
  ('price_autoapply_max_pct', '0.10'),
  ('ai_autoreply_enabled', '1')
on conflict (key) do nothing;
