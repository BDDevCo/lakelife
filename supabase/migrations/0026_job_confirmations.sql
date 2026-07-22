-- ============================================================
--  LakeLife — the customer becomes the quality auditor (parked in
--  Phase E, built now). Every completed job's "done — with photos"
--  text carries one-tap 👍 / 👎 links. A thumbs-up builds the crew's
--  public-facing trust numbers; a thumbs-down pings the CREW to make
--  it right and lands on the Messages board — never an ops queue.
--  Run once. Safe to re-run.
-- ============================================================

create table if not exists public.job_confirmations (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs(id) on delete cascade,
  property_id   uuid references public.properties(id) on delete set null,
  vendor_id     uuid references public.vendors(id) on delete set null,
  -- null until the customer taps; exactly one verdict, ever (guarded flip)
  verdict       text check (verdict in ('good', 'issue')),
  note          text,
  confirm_token uuid not null default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  unique (job_id)
);
create unique index if not exists job_confirmations_token on public.job_confirmations (confirm_token);

alter table public.job_confirmations enable row level security;

-- A crew may see its own verdicts (their quality record); ops sees all.
-- Customers interact only through the tokenized links — no session needed.
drop policy if exists job_confirmations_access on public.job_confirmations;
create policy job_confirmations_access on public.job_confirmations for select
  using (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

revoke insert, update, delete on public.job_confirmations from authenticated, anon;
grant select on public.job_confirmations to authenticated;
