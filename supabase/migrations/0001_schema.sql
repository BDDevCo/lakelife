-- ============================================================
--  LakeLife — Database schema  (from launch plan §5)
--  Run this FIRST in Supabase → SQL Editor → New query → Run.
--  Then run 0002_rls.sql, then the files in supabase/seed/.
-- ============================================================

-- Encryption for gate/door codes (CLAUDE.md rule 3)
create extension if not exists pgcrypto;

-- ---------- enums ----------
do $$ begin
  create type user_role as enum ('owner', 'vendor', 'ops');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pricing_model as enum ('flat', 'per_section', 'per_foot', 'band', 'per_sqft_band');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_status as enum ('requested', 'scheduled', 'in_progress', 'complete', 'paid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type flag_status as enum ('pending', 'approved', 'declined');
exception when duplicate_object then null; end $$;

do $$ begin
  create type vendor_status as enum ('invited', 'active', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type availability_status as enum ('open', 'blocked', 'booked');
exception when duplicate_object then null; end $$;

-- ---------- users ----------
-- One row per person. id matches Supabase Auth's user id.
-- Both email AND phone must be verified before first booking (CLAUDE.md rule 5).
create table if not exists public.users (
  id             uuid primary key references auth.users(id) on delete cascade,
  role           user_role not null default 'owner',
  name           text,
  email          text,
  email_verified boolean not null default false,
  phone          text,
  phone_verified boolean not null default false,
  auth_provider  text,                         -- 'email' | 'google' | 'apple'
  created_at     timestamptz not null default now()
);

-- ---------- lakes ----------
-- Pull deadline = hard freeze − 8 days (CLAUDE.md rule 7).
create table if not exists public.lakes (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  ice_out_actual  date,
  hard_freeze_est date,
  pull_deadline   date,
  created_at      timestamptz not null default now()
);

-- ---------- properties ----------
create table if not exists public.properties (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references public.users(id) on delete cascade,
  lake_id              uuid references public.lakes(id),
  address              text,
  lat                  double precision,
  lng                  double precision,
  sqft                 integer,
  beds                 integer,
  baths                numeric,
  gate_code_encrypted  bytea,                   -- encrypted at rest; see 0002_rls.sql
  created_at           timestamptz not null default now()
);

-- ---------- property_profile (the pricing source of truth) ----------
create table if not exists public.property_profile (
  property_id   uuid primary key references public.properties(id) on delete cascade,
  pier_sections integer default 0,
  ladder        boolean default false,
  bumpers       boolean default false,
  boat_lifts    integer default 0,
  canopy        boolean default false,
  toy_lifts     integer default 0,
  lawn_band     text                            -- e.g. 'small' | 'medium' | 'large'
);

-- ---------- boats (per-foot pricing) ----------
create table if not exists public.boats (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  type        text,
  length_ft   numeric
);

-- ---------- toys ----------
create table if not exists public.toys (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  name        text
);

-- ---------- profile_photos (owner-uploaded waterfront + crew job photos live in job_photos) ----------
create table if not exists public.profile_photos (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  url         text not null,
  uploaded_by uuid references public.users(id),
  created_at  timestamptz not null default now()
);

-- ---------- services (pricing rules live in DATA, not code — CLAUDE.md rule 8) ----------
create table if not exists public.services (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  pricing_model     pricing_model not null,
  base              numeric default 0,          -- flat fee / starting price
  unit_rate         numeric default 0,          -- per section / per foot
  frequency_options text[] default '{}',        -- e.g. {'One-time','Weekly'}
  min_photos        integer not null default 0, -- photo gate (CLAUDE.md rule 2)
  is_water_work     boolean not null default false, -- blocked outside lake season window
  band_pricing      jsonb,                       -- for band / per_sqft_band models
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- ---------- vendors ----------
-- No valid COI ⇒ router skips them.
create table if not exists public.vendors (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  company       text,
  service_types text[] default '{}',
  daily_capacity integer default 0,
  coi_url       text,
  coi_expiry    date,
  w9_url        text,
  payout_token  text,
  status        vendor_status not null default 'invited',
  created_at    timestamptz not null default now()
);

-- ---------- vendor_availability (tap-to-block grid) ----------
create table if not exists public.vendor_availability (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references public.vendors(id) on delete cascade,
  date       date not null,
  slot       text not null,                     -- e.g. 'am' | 'pm'
  status     availability_status not null default 'open',
  unique (vendor_id, date, slot)
);

-- ---------- jobs ----------
-- customer_price / vendor_cost / margin are OPS-ONLY. Vendors read jobs
-- through the price-free vendor_jobs view in 0002_rls.sql (CLAUDE.md rule 1).
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  service_id    uuid references public.services(id),
  vendor_id     uuid references public.vendors(id),
  date          date,
  slot          text,
  status        job_status not null default 'requested',
  customer_price numeric,                        -- OPS/owner only
  vendor_cost    numeric,                        -- OPS only
  margin         numeric,                        -- OPS only
  route_id      uuid,
  sequence      integer,
  created_at    timestamptz not null default now()
);

-- ---------- job_photos (>= service.min_photos required before status='complete') ----------
create table if not exists public.job_photos (
  id        uuid primary key default gen_random_uuid(),
  job_id    uuid not null references public.jobs(id) on delete cascade,
  url       text not null,
  taken_at  timestamptz not null default now()
);

-- ---------- routes (rebuilt nightly at 8pm) ----------
create table if not exists public.routes (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references public.vendors(id) on delete cascade,
  date          date not null,
  stops_order   jsonb,
  drive_minutes integer,
  map_url       text,
  created_at    timestamptz not null default now()
);

-- ---------- flags (vendor profile corrections; approval reprices) ----------
create table if not exists public.flags (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid references public.jobs(id) on delete cascade,
  vendor_id      uuid references public.vendors(id),
  type           text,
  note           text,
  proposed_change jsonb,
  status         flag_status not null default 'pending',
  created_at     timestamptz not null default now()
);

-- ---------- messages (dispatch message board) ----------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  from_user   uuid references public.users(id),
  body        text,
  created_at  timestamptz not null default now()
);

-- ---------- invoices / payments / payouts ----------
create table if not exists public.invoices (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid references public.jobs(id) on delete set null,
  property_id   uuid references public.properties(id) on delete cascade,
  amount        numeric,
  status        text default 'draft',
  processor_ref text,
  created_at    timestamptz not null default now()
);

create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid references public.invoices(id) on delete cascade,
  amount        numeric,
  status        text default 'pending',
  processor_ref text,
  created_at    timestamptz not null default now()
);

create table if not exists public.payouts (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid references public.vendors(id) on delete cascade,
  job_id        uuid references public.jobs(id) on delete set null,
  amount        numeric,
  status        text default 'pending',          -- releases on photo-verified completion
  processor_ref text,
  created_at    timestamptz not null default now()
);

-- ---------- notification_prefs (receipts locked always-on) ----------
create table if not exists public.notification_prefs (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references public.users(id) on delete cascade,
  type     text not null,
  channel  text not null,                         -- 'email' | 'sms'
  enabled  boolean not null default true,
  unique (user_id, type, channel)
);

-- ---------- helpful indexes ----------
create index if not exists idx_properties_owner on public.properties(owner_id);
create index if not exists idx_jobs_property   on public.jobs(property_id);
create index if not exists idx_jobs_vendor     on public.jobs(vendor_id);
create index if not exists idx_vendors_user    on public.vendors(user_id);
create index if not exists idx_avail_vendor    on public.vendor_availability(vendor_id, date);
