-- ============================================================
--  LakeLife — crew imports their book of business.
--  A crew stages their existing customers here; when a homeowner signs up
--  with a matching email, the row materializes into a real property with
--  that crew pre-set as preferred. Run once in the SQL Editor. Safe to re-run.
-- ============================================================

create table if not exists public.customer_imports (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references public.vendors(id) on delete cascade,
  invite_email     text not null,          -- the claim key (homeowner signs up with this)
  invite_name      text,
  address          text,
  place_id         text,
  lat              double precision,
  lng              double precision,
  phone            text,
  note             text,                    -- freeform service hint from the crew
  status           text not null default 'pending',  -- pending | claimed | dismissed
  claimed_property uuid references public.properties(id) on delete set null,
  created_at       timestamptz not null default now()
);

-- One OPEN import per email — the first crew to import a customer holds the
-- pre-binding; a duplicate import is rejected at insert.
create unique index if not exists customer_imports_open_email
  on public.customer_imports (lower(invite_email))
  where status = 'pending';

create index if not exists idx_customer_imports_vendor on public.customer_imports(vendor_id);

alter table public.customer_imports enable row level security;

-- A crew reads ONLY their own imports; ops reads all. No customer prices here.
drop policy if exists customer_imports_access on public.customer_imports;
create policy customer_imports_access on public.customer_imports for select
  using (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

-- All writes are server-side (service role). Lock out direct client writes.
revoke insert, update, delete on public.customer_imports from authenticated, anon;
grant select on public.customer_imports to authenticated;
