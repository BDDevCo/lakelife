-- ============================================================
--  LakeLife — one profile per property, + marketing retention.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ---------- one profile per property (like one account per email) ----------
-- Google's Place ID is a stable fingerprint for a physical address, so it
-- dedupes "Main St" vs "Main Street" reliably. Enforced globally: a second
-- owner can't claim an address that already has a profile.
alter table public.properties
  add column if not exists place_id text;

create unique index if not exists properties_place_id_uidx
  on public.properties (place_id)
  where place_id is not null;

-- ---------- marketing retention (kept after a delete, until opt-out) --------
-- When a customer removes their property or deletes their account, we keep a
-- minimal contact record (name, email, phone, lake) for seasonal reminders
-- until they opt out. NOTE: what you may lawfully retain after a deletion
-- request is a privacy-policy / legal question — confirm the wording before beta.
create table if not exists public.marketing_contacts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  name       text,
  email      text not null,
  phone      text,
  lake       text,
  reason     text,                         -- 'property_removed' | 'account_deleted'
  opted_out  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email)
);

alter table public.marketing_contacts enable row level security;

-- Ops manages the marketing list; customers don't read it directly.
-- (Deletion actions write to it server-side with the service role.)
drop policy if exists marketing_ops on public.marketing_contacts;
create policy marketing_ops on public.marketing_contacts for all
  using (public.ll_is_ops()) with check (public.ll_is_ops());
