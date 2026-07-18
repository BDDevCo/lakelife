-- ============================================================
--  LakeLife — payment methods on file (tokens only).
--  CLAUDE.md rule 4: card data NEVER touches our database. We store
--  only the processor's vault token + safe display details (brand,
--  last 4, expiry). No PAN, no CVC — ever.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

create table if not exists public.payment_methods (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  brand      text,
  last4      text,
  exp_month  integer,
  exp_year   integer,
  token      text not null,            -- processor vault token (NOT card data)
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_payment_methods_user on public.payment_methods(user_id);

alter table public.payment_methods enable row level security;

-- A customer manages their own cards; ops can view for support.
drop policy if exists pm_owner on public.payment_methods;
create policy pm_owner on public.payment_methods for all
  using (user_id = auth.uid() or public.ll_is_ops())
  with check (user_id = auth.uid() or public.ll_is_ops());
