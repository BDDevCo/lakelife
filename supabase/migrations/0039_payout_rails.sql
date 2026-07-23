-- ============================================================
--  LakeLife — automated payout rails (owner, 2026-07-22):
--  "take the human interaction out of banking and payments to
--  crews and HOAs — all automated."
--
--  1) payout_accounts: where a payee's money goes. Routing/account are
--     ENCRYPTED AT REST (same AES-256-GCM as gate codes, rule-3 posture);
--     the encrypted blobs NEVER leave the server — clients see last4 via
--     server-shaped data only. One row per user: crew users AND HOA users.
--  2) payout_batches: every money movement is a ledger row FIRST —
--     'queued' batches are what the bank-API layer (or, until it lands,
--     the auto-generated ACH export) executes. Crews can pull early for
--     the early_payout_fee_pct dial; month-end runs free.
--  Run once. Safe to re-run.
-- ============================================================

create table if not exists public.payout_accounts (
  user_id           uuid primary key references public.users(id) on delete cascade,
  bank_name         text,
  routing_encrypted bytea,
  account_encrypted bytea,
  account_last4     text,
  updated_at        timestamptz not null default now()
);

create table if not exists public.payout_batches (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id),
  vendor_id  uuid references public.vendors(id),
  kind       text not null check (kind in ('early', 'monthly', 'referral')),
  gross      numeric not null default 0,
  fee        numeric not null default 0,
  net        numeric not null default 0,
  status     text not null default 'queued' check (status in ('queued', 'exported', 'paid', 'failed')),
  created_at timestamptz not null default now(),
  paid_at    timestamptz
);

alter table public.payouts
  add column if not exists batch_id uuid references public.payout_batches(id);
create index if not exists payouts_batch_idx on public.payouts(batch_id);
create index if not exists payouts_vendor_unbatched_idx on public.payouts(vendor_id) where batch_id is null;

alter table public.payout_accounts enable row level security;
alter table public.payout_batches  enable row level security;

-- Encrypted blobs are server-only: ops policy exists for admin visibility,
-- ordinary clients read NOTHING from this table.
drop policy if exists payout_accounts_ops on public.payout_accounts;
create policy payout_accounts_ops on public.payout_accounts
  for select using (public.ll_is_ops());

-- A payee may read their OWN batches (their own take-home — rule-1 safe).
drop policy if exists payout_batches_read on public.payout_batches;
create policy payout_batches_read on public.payout_batches
  for select using (public.ll_is_ops() or user_id = auth.uid());

revoke insert, update, delete on public.payout_accounts from authenticated, anon;
revoke insert, update, delete on public.payout_batches  from authenticated, anon;
grant select on public.payout_accounts to authenticated;
grant select on public.payout_batches  to authenticated;

insert into public.platform_settings (key, value) values
  ('early_payout_fee_pct', '0.02'::jsonb)
on conflict (key) do nothing;
