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
