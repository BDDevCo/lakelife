-- ============================================================
--  LakeLife — crew no-show tracking (standing-based penalty).
--  A no-show = scheduled day passed with zero photos and no completion.
--  Consequence is REPUTATIONAL: reliability drags the crew score, which
--  demotes dispatch rank / Priority. Run once in SQL Editor. Safe to re-run.
-- ============================================================

create table if not exists public.vendor_no_shows (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references public.vendors(id) on delete cascade,
  job_id         uuid not null references public.jobs(id) on delete cascade,
  property_id    uuid references public.properties(id) on delete set null,
  scheduled_date date,
  created_at     timestamptz not null default now(),
  unique (job_id)                    -- one no-show record per job (idempotent sweep)
);

create index if not exists idx_no_shows_vendor on public.vendor_no_shows(vendor_id);

alter table public.vendor_no_shows enable row level security;

-- A crew may see their own misses (their standing card references the count);
-- ops sees all. Writes are server-only (nightly sweep, service role).
drop policy if exists vendor_no_shows_access on public.vendor_no_shows;
create policy vendor_no_shows_access on public.vendor_no_shows for select
  using (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

revoke insert, update, delete on public.vendor_no_shows from authenticated, anon;
grant select on public.vendor_no_shows to authenticated;
