-- ============================================================
-- LakeLife — complete database setup (all 3 files in order)
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to run once on a fresh project.
-- ============================================================

-- ========== FILE 1 of 3: schema ==========
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

-- ========== FILE 2 of 3: security rules ==========
-- ============================================================
--  LakeLife — Row-Level Security + role separation
--  Run this SECOND (after 0001_schema.sql).
--
--  The three roles (owner / vendor / ops) are enforced HERE at
--  the database level, not just in the UI (CLAUDE.md rules 1 & 3):
--    • Vendors can NEVER read customer prices or margin.
--    • Owners see only the single all-in price, never vendor cost
--      or LakeLife's margin.
--    • Gate/door codes are encrypted at rest.
-- ============================================================

-- ---------- helper functions ----------
create or replace function public.ll_is_ops()
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.users where id = auth.uid() and role = 'ops') $$;

create or replace function public.ll_my_vendor_id()
returns uuid
language sql stable security definer set search_path = public
as $$ select id from public.vendors where user_id = auth.uid() limit 1 $$;

-- ---------- auto-create a public.users row when someone signs up ----------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.users (id, email, email_verified, name, auth_provider)
  values (
    new.id,
    new.email,
    coalesce((new.email_confirmed_at is not null), false),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    coalesce(new.raw_app_meta_data->>'provider', 'email')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------- prevent non-ops from promoting themselves to a higher role ----------
create or replace function public.guard_role_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role is distinct from old.role and not public.ll_is_ops() then
    raise exception 'Only ops can change a user role';
  end if;
  return new;
end $$;

drop trigger if exists guard_user_role on public.users;
create trigger guard_user_role
  before update on public.users
  for each row execute function public.guard_role_change();

-- ---------- gate/door code encryption (CLAUDE.md rule 3) ----------
-- The backend supplies the encryption key (from an env var) so the raw
-- key never lives in the database. Day-of-job visibility gating for
-- vendors is wired in Phase 4 (jobs), where the "is it this vendor's
-- scheduled day at this property?" check lives.
create or replace function public.ll_encrypt_gate_code(p_code text, p_key text)
returns bytea
language sql immutable
as $$ select pgp_sym_encrypt(p_code, p_key) $$;

create or replace function public.ll_decrypt_gate_code(p_cipher bytea, p_key text)
returns text
language sql immutable
as $$ select pgp_sym_decrypt(p_cipher, p_key) $$;

-- ============================================================
--  Enable RLS on every table
-- ============================================================
alter table public.users               enable row level security;
alter table public.lakes               enable row level security;
alter table public.properties          enable row level security;
alter table public.property_profile    enable row level security;
alter table public.boats               enable row level security;
alter table public.toys                enable row level security;
alter table public.profile_photos      enable row level security;
alter table public.services            enable row level security;
alter table public.vendors             enable row level security;
alter table public.vendor_availability enable row level security;
alter table public.jobs                enable row level security;
alter table public.job_photos          enable row level security;
alter table public.routes              enable row level security;
alter table public.flags               enable row level security;
alter table public.messages            enable row level security;
alter table public.invoices            enable row level security;
alter table public.payments            enable row level security;
alter table public.payouts             enable row level security;
alter table public.notification_prefs  enable row level security;

-- ============================================================
--  USERS — see/update yourself; ops sees everyone
-- ============================================================
create policy users_select on public.users for select
  using (id = auth.uid() or public.ll_is_ops());
create policy users_update on public.users for update
  using (id = auth.uid() or public.ll_is_ops());

-- ============================================================
--  LAKES / SERVICES — season info & customer prices.
--  Readable by owners and ops ONLY (vendors must not see prices).
--  Only ops can edit.
-- ============================================================
create policy lakes_read on public.lakes for select
  using (auth.uid() is not null);   -- season dates are not price data; all logged-in users may read
create policy lakes_write on public.lakes for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());

create policy services_read on public.services for select
  using (public.ll_is_ops() or exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'
  ));  -- NOT vendors: services carry customer pricing
create policy services_write on public.services for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());

-- ============================================================
--  PROPERTIES and everything hanging off them — owner owns, ops sees all
-- ============================================================
create policy properties_owner on public.properties for all
  using (owner_id = auth.uid() or public.ll_is_ops())
  with check (owner_id = auth.uid() or public.ll_is_ops());

-- child tables keyed by property_id
create policy profile_owner on public.property_profile for all
  using (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())))
  with check (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())));

create policy boats_owner on public.boats for all
  using (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())))
  with check (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())));

create policy toys_owner on public.toys for all
  using (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())))
  with check (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())));

create policy photos_owner on public.profile_photos for all
  using (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())))
  with check (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())));

create policy messages_owner on public.messages for all
  using (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())))
  with check (exists (select 1 from public.properties p where p.id = property_id and (p.owner_id = auth.uid() or public.ll_is_ops())));

create policy notif_self on public.notification_prefs for all
  using (user_id = auth.uid() or public.ll_is_ops())
  with check (user_id = auth.uid() or public.ll_is_ops());

-- ============================================================
--  VENDORS — a vendor sees only their own row; ops sees all
-- ============================================================
create policy vendors_self on public.vendors for select
  using (user_id = auth.uid() or public.ll_is_ops());
create policy vendors_ops_write on public.vendors for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());
create policy vendor_updates_self on public.vendors for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy avail_vendor on public.vendor_availability for all
  using (vendor_id = public.ll_my_vendor_id() or public.ll_is_ops())
  with check (vendor_id = public.ll_my_vendor_id() or public.ll_is_ops());

-- ============================================================
--  JOBS & money — the heart of rule 1.
--  Base tables are OPS-ONLY. Owners and vendors read through
--  purpose-built views that omit the columns they must not see.
-- ============================================================
create policy jobs_ops on public.jobs for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());

create policy jobphotos_access on public.job_photos for all
  using (public.ll_is_ops()
    or exists (select 1 from public.jobs j where j.id = job_id and j.vendor_id = public.ll_my_vendor_id())
    or exists (select 1 from public.jobs j join public.properties p on p.id = j.property_id
               where j.id = job_id and p.owner_id = auth.uid()))
  with check (public.ll_is_ops()
    or exists (select 1 from public.jobs j where j.id = job_id and j.vendor_id = public.ll_my_vendor_id()));

create policy routes_access on public.routes for select
  using (vendor_id = public.ll_my_vendor_id() or public.ll_is_ops());
create policy routes_ops_write on public.routes for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());

create policy flags_access on public.flags for all
  using (public.ll_is_ops()
    or vendor_id = public.ll_my_vendor_id()
    or exists (select 1 from public.jobs j join public.properties p on p.id = j.property_id
               where j.id = job_id and p.owner_id = auth.uid()))
  with check (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

create policy invoices_access on public.invoices for select
  using (public.ll_is_ops()
    or exists (select 1 from public.properties p where p.id = property_id and p.owner_id = auth.uid()));
create policy invoices_ops_write on public.invoices for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());

create policy payments_ops on public.payments for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());

-- Vendors may read their own payout STATUS, but payouts carry no
-- customer price, so a row read is fine; ops manages everything.
create policy payouts_access on public.payouts for select
  using (vendor_id = public.ll_my_vendor_id() or public.ll_is_ops());
create policy payouts_ops_write on public.payouts for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());

-- ============================================================
--  Price-safe VIEWS (security definer — they bypass base-table
--  RLS but hand back only the allowed columns, filtered to the
--  caller's own rows).
-- ============================================================

-- Owners: their jobs WITH the single all-in customer price,
-- but WITHOUT vendor_cost or margin.
create or replace view public.owner_jobs
with (security_invoker = off) as
  select j.id, j.property_id, j.service_id, j.vendor_id, j.date, j.slot,
         j.status, j.customer_price, j.route_id, j.sequence, j.created_at
  from public.jobs j
  join public.properties p on p.id = j.property_id
  where p.owner_id = auth.uid();

-- Vendors: their assigned jobs with NO pricing at all.
create or replace view public.vendor_jobs
with (security_invoker = off) as
  select j.id, j.property_id, j.service_id, j.vendor_id, j.date, j.slot,
         j.status, j.route_id, j.sequence, j.created_at
  from public.jobs j
  where j.vendor_id = public.ll_my_vendor_id();

grant select on public.owner_jobs  to authenticated;
grant select on public.vendor_jobs to authenticated;

-- Revoke any accidental direct column access to the money columns:
revoke all on public.jobs from anon;

-- ========== FILE 3 of 3: lakes seed ==========
-- ============================================================
--  LakeLife — Seed the three lakes  (run AFTER 0001 and 0002)
--  Dates come straight from the prototype's Lake Conditions panel.
--  pull_deadline = hard_freeze_est − 8 days  (CLAUDE.md rule 7)
--  Update ice_out_actual each March and the booking calendar reflows.
-- ============================================================

insert into public.lakes (name, ice_out_actual, hard_freeze_est, pull_deadline) values
  ('Big Long Lake',   date '2026-03-21', date '2026-11-22', date '2026-11-14'),
  ('Pretty Lake',     date '2026-03-24', date '2026-11-20', date '2026-11-12'),
  ('Big Turkey Lake', date '2026-03-19', date '2026-11-24', date '2026-11-16')
on conflict (name) do update
  set ice_out_actual  = excluded.ice_out_actual,
      hard_freeze_est = excluded.hard_freeze_est,
      pull_deadline   = excluded.pull_deadline;

-- Sanity check: pull deadline must equal freeze minus 8 days.
do $$
declare bad int;
begin
  select count(*) into bad from public.lakes
   where pull_deadline <> hard_freeze_est - 8;
  if bad > 0 then
    raise exception 'Pull deadline rule broken on % lake(s)', bad;
  end if;
end $$;
