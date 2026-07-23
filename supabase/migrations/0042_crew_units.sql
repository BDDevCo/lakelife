-- ============================================================
--  LakeLife — Fleet Routing (docs/fleet-routing-design.md).
--  crew_units: N trucks under ONE contractor. Money/liability/standing
--  stay on vendors; capacity, hours, and the morning route text move to
--  the truck. A vendor with zero units behaves exactly as before.
--  Run once. Safe to re-run.
-- ============================================================

create table if not exists public.crew_units (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references public.vendors(id) on delete cascade,
  name       text not null default 'Truck 1',
  phone      text,                          -- route text lands here (falls back to vendor phone)
  capacity   integer not null default 3 check (capacity between 1 and 20),
  work_start integer not null default 7 check (work_start between 0 and 23),
  work_end   integer not null default 17 check (work_end between 1 and 24),
  base_lat   double precision,              -- optional own start point; null = vendor base
  base_lng   double precision,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  check (work_end > work_start)
);
create index if not exists crew_units_vendor_idx on public.crew_units(vendor_id) where active;

alter table public.crew_units enable row level security;
drop policy if exists crew_units_read on public.crew_units;
create policy crew_units_read on public.crew_units
  for select using (
    public.ll_is_ops()
    or exists (select 1 from public.vendors v where v.id = vendor_id and v.user_id = auth.uid())
  );
-- Mutations go through server actions (service role) only.
revoke insert, update, delete on public.crew_units from authenticated, anon;
grant select on public.crew_units to authenticated;

-- Routes learn which truck they belong to (null = legacy single-route).
alter table public.routes add column if not exists crew_unit_id uuid references public.crew_units(id) on delete set null;
alter table public.routes add column if not exists unit_name text;
alter table public.routes add column if not exists drive_km numeric;

-- Per-service duration dials (rule 8): the time-budget capacity check and
-- the hours-fit flag read these. Null = engine default (60).
alter table public.services add column if not exists est_minutes integer;
update public.services set est_minutes = v.m
from (values
  ('Lawn mowing & trim', 45),
  ('Housekeeping', 90),
  ('Pier install / removal', 180),
  ('Boat lift set / pull', 90),
  ('PWC lift set / pull', 60),
  ('Jet ski winterize & store', 60),
  ('Fall winterization', 120),
  ('Spring opening', 120),
  ('Water toy prep & storage', 60),
  ('Boat storage & winterize', 120),
  ('Boat haul-out (we pick it up)', 60),
  ('Boat return & splash', 60),
  ('Boat winterization (shop)', 90),
  ('Spring de-winterize & test run', 90),
  ('Winter storage — indoor', 30),
  ('Winter storage — outdoor', 30),
  ('Shrink wrap', 90),
  ('Battery care (pull, tend, reinstall)', 30),
  ('Engine oil & filter change', 45),
  ('Storage overstay (per-diem)', 0)
) as v(n, m)
where services.name = v.n and services.est_minutes is null;

-- Fuel economics dial (ops display only — crews' own cost picture).
insert into public.platform_settings (key, value) values ('fuel_cost_per_mile', '0.65')
on conflict (key) do nothing;
