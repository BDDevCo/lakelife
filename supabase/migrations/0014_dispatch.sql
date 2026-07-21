-- ============================================================
--  LakeLife — Phase 8: auto-dispatch + crew-set rates.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ---------- job lifecycle timestamps (scoring + duration learning) ----------
alter table public.jobs add column if not exists started_at   timestamptz;
alter table public.jobs add column if not exists completed_at timestamptz;

-- ---------- preferred crew: first right of refusal on dispatch --------------
alter table public.properties
  add column if not exists preferred_vendor uuid references public.vendors(id) on delete set null;

-- ---------- crew-set PRIVATE rates (their take-home per service) ------------
-- Mirrors services' pricing shape so the same pricing engine computes the
-- crew's price for a job. Menu price stays LakeLife's; margin = menu − crew.
create table if not exists public.vendor_rates (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors(id) on delete cascade,
  service_id   uuid not null references public.services(id) on delete cascade,
  base         numeric default 0,
  unit_rate    numeric default 0,
  band_pricing jsonb,
  updated_at   timestamptz not null default now(),
  unique (vendor_id, service_id)
);

alter table public.vendor_rates enable row level security;

-- A crew reads ONLY their own rates; ops reads all. (Never customer prices.)
drop policy if exists vendor_rates_access on public.vendor_rates;
create policy vendor_rates_access on public.vendor_rates for select
  using (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

-- All writes go through server actions (service role) — no client writes.
-- (Postgres default grants would otherwise allow them; see 0009/0011 pattern.)
revoke insert, update, delete on public.vendor_rates from authenticated, anon;
grant select on public.vendor_rates to authenticated;

create index if not exists idx_vendor_rates_vendor on public.vendor_rates(vendor_id);
create index if not exists idx_jobs_vendor_date on public.jobs(vendor_id, date);
