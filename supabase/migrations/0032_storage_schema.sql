-- ============================================================
--  LakeLife — storage & winterization, phase S1 (schema only).
--  Design: docs/storage-winterize-design.md (rev 3, owner-approved).
--  Sell LEGS not scenarios: packages = bundles of component services,
--  ONE JOB PER VISIT, so rule 1 (vendor price-blindness), rule 2
--  (photo gate) and rule 8 (pricing in DB) all ride existing rails.
--  Seeds live in 0033 (INACTIVE until the wizard ships — the new
--  enum value below cannot be used in this same transaction anyway).
--  Run once. Safe to re-run.
-- ============================================================

-- 1) The storage pricing model (roadmap §4): seasonal minimum
--    (base + unit_rate × boat feet) charged at fall completion;
--    per-diem overage (platform dials) billed at spring splash.
alter type pricing_model add value if not exists 'seasonal_plus_perdiem';

-- 2) Components/add-ons are priceable but never appear as menu tiles.
alter table public.services
  add column if not exists kind text not null default 'standalone'
    check (kind in ('standalone','component','addon'));

-- 3) Vendor storage capability + the bailee-insurance gate.
--    A standard COI excludes property in the vendor's custody —
--    storage legs unlock ONLY with an unexpired garagekeepers doc
--    (owner decision: hard gate, same present+unexpired posture as COI).
--    Storage capacity is a seasonal FEET pool, not a daily slot count.
alter table public.vendors
  add column if not exists storage_capacity_feet integer not null default 0,
  add column if not exists storage_types text[] not null default '{}',
  add column if not exists garagekeepers_url text,
  add column if not exists garagekeepers_expiry date;

-- 4) Customer-facing packages and their component recipes.
create table if not exists public.service_packages (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,          -- 'you_tow' | 'we_haul' | 'storage_only'
  name        text not null,
  description text,
  active      boolean not null default false,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.package_components (
  package_id uuid not null references public.service_packages(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  phase      text not null check (phase in ('fall','spring')),
  required   boolean not null default true,
  default_on boolean not null default true,
  primary key (package_id, service_id, phase)
);

-- 5) The season envelope: links the fall visit, the winter stay and the
--    spring visit of one boat's package. storing_vendor pins spring legs
--    to whoever physically holds the boat (no re-dispatch of custody).
create table if not exists public.job_groups (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,
  package_id         uuid not null references public.service_packages(id),
  status             text not null default 'active'
                       check (status in ('active','completed','cancelled')),
  storing_vendor     uuid references public.vendors(id),
  storage_service_id uuid references public.services(id),  -- chosen tier (outdoor/indoor)
  created_at         timestamptz not null default now()
);

alter table public.jobs
  add column if not exists group_id uuid references public.job_groups(id) on delete set null,
  add column if not exists phase text check (phase in ('fall','spring')),
  add column if not exists price_finalized boolean not null default true;

-- 6) Per-component line items under a visit job. Carries BOTH prices, so
--    like referral_earnings it is OPS-ONLY at RLS (rule 1 by arithmetic:
--    owners must not see vendor_cost, vendors must not see customer_price).
--    jobs.customer_price / vendor_cost stay as the sums — settleJob,
--    invoices and payouts are untouched.
create table if not exists public.job_items (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs(id) on delete cascade,
  service_id     uuid not null references public.services(id),
  customer_price numeric not null default 0,
  vendor_cost    numeric not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists job_items_job_idx on public.job_items(job_id);

-- 7) The custody ledger: one row per boat-winter. intake_at stamps when
--    the fall visit completes; per-diem accrues past the season-end dials.
create table if not exists public.storage_stays (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.job_groups(id) on delete cascade,
  vendor_id  uuid not null references public.vendors(id),
  boat_label text,
  boat_feet  numeric not null default 0,
  intake_at  timestamptz,
  out_at     timestamptz,
  status     text not null default 'reserved'
               check (status in ('reserved','in_storage','released','cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists storage_stays_vendor_idx on public.storage_stays(vendor_id, status);

-- 8) RLS + the house write-revoke pattern (RLS alone is not enough).
alter table public.service_packages  enable row level security;
alter table public.package_components enable row level security;
alter table public.job_groups        enable row level security;
alter table public.job_items         enable row level security;
alter table public.storage_stays     enable row level security;

-- Packages are menu data (customer-side prices only) — world-readable.
drop policy if exists service_packages_read on public.service_packages;
create policy service_packages_read on public.service_packages
  for select using (true);
drop policy if exists package_components_read on public.package_components;
create policy package_components_read on public.package_components
  for select using (true);

-- Season envelopes: ops, or the homeowner who owns the property.
drop policy if exists job_groups_read on public.job_groups;
create policy job_groups_read on public.job_groups
  for select using (
    public.ll_is_ops()
    or exists (select 1 from public.properties p
               where p.id = property_id and p.owner_id = auth.uid())
  );

-- Line items: OPS-ONLY (both prices live here).
drop policy if exists job_items_ops on public.job_items;
create policy job_items_ops on public.job_items
  for select using (public.ll_is_ops());

-- Stays: ops, or the vendor holding the boat (no prices in this table);
-- homeowners get status through the requests UI server-side.
drop policy if exists storage_stays_read on public.storage_stays;
create policy storage_stays_read on public.storage_stays
  for select using (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

revoke insert, update, delete on public.service_packages   from authenticated, anon;
revoke insert, update, delete on public.package_components from authenticated, anon;
revoke insert, update, delete on public.job_groups         from authenticated, anon;
revoke insert, update, delete on public.job_items          from authenticated, anon;
revoke insert, update, delete on public.storage_stays      from authenticated, anon;
grant select on public.service_packages   to authenticated, anon;
grant select on public.package_components to authenticated, anon;
grant select on public.job_groups         to authenticated;
grant select on public.job_items          to authenticated;
grant select on public.storage_stays      to authenticated;

-- 9) The dials (rule 8; owner-approved 2026-07-22): storage season ends
--    May 31 — per-diem starts after, $10/day, margin-weighted like all money.
insert into public.platform_settings (key, value) values
  ('storage_perdiem_daily',     '10'::jsonb),
  ('storage_season_end_month',  '5'::jsonb),
  ('storage_season_end_day',    '31'::jsonb)
on conflict (key) do nothing;
