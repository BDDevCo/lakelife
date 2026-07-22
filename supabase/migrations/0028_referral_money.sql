-- ============================================================
--  LakeLife — referral MONEY layer (§8b, owner-blessed direction
--  2026-07-23). Golden rules enforced by construction: rewards
--  accrue ONLY on collected money (hooks live in settleJob after a
--  successful charge), 30-day maturation before anything is
--  spendable, single-level, self-referral blocked upstream.
--  All rates/caps are DIALS (rule 8) — the owner tunes, never code.
--  Run once. Safe to re-run.
-- ============================================================

-- 1) Who invited this crew? (homeowner-brings-crew arm — the best one.)
alter table public.vendors
  add column if not exists invited_by uuid references public.users(id) on delete set null;

-- 2) Referral earnings ledger — every accrual, whatever the arm.
--    pay_via 'credits' (homeowners/HOAs: service credits, no 1099) or
--    'payout' (crews: rides their existing 1099'd payout rails).
create table if not exists public.referral_earnings (
  id            uuid primary key default gen_random_uuid(),
  beneficiary   uuid not null references public.users(id) on delete cascade,
  kind          text not null check (kind in ('customer_referral', 'cross_sell', 'crew_referral')),
  source_job    uuid references public.jobs(id) on delete set null,
  source_vendor uuid references public.vendors(id) on delete set null,
  amount        numeric not null,
  status        text not null default 'accrued' check (status in ('accrued', 'matured', 'paid', 'void')),
  accrued_at    timestamptz not null default now(),
  matured_at    timestamptz
);
-- One accrual per (beneficiary, job, kind) — settleJob re-runs must not double-accrue.
create unique index if not exists referral_earnings_once
  on public.referral_earnings (beneficiary, source_job, kind) where source_job is not null;
create index if not exists referral_earnings_beneficiary on public.referral_earnings (beneficiary, status);

-- 3) Service credits ledger (grants +, applications −). Balance = sum(amount).
create table if not exists public.user_credits (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  amount     numeric not null,
  reason     text,
  invoice_id uuid references public.invoices(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists user_credits_user on public.user_credits (user_id);
-- One application per invoice — a settle re-run must not double-spend credits.
create unique index if not exists user_credits_one_per_invoice
  on public.user_credits (invoice_id) where invoice_id is not null;

-- 4) RLS: own rows readable (your credits, your earnings); ops all; writes server-only.
alter table public.referral_earnings enable row level security;
alter table public.user_credits enable row level security;

drop policy if exists referral_earnings_access on public.referral_earnings;
create policy referral_earnings_access on public.referral_earnings for select
  using (public.ll_is_ops() or beneficiary = auth.uid());

drop policy if exists user_credits_access on public.user_credits;
create policy user_credits_access on public.user_credits for select
  using (public.ll_is_ops() or user_id = auth.uid());

revoke insert, update, delete on public.referral_earnings from authenticated, anon;
revoke insert, update, delete on public.user_credits from authenticated, anon;
grant select on public.referral_earnings to authenticated;
grant select on public.user_credits to authenticated;

-- 5) The dials (owner-blessed defaults; tune anytime).
insert into public.platform_settings (key, value) values
  ('referral_customer_pct',    '0.05'::jsonb),  -- homeowner→homeowner: % of collected spend
  ('referral_cross_sell_pct',  '0.05'::jsonb),  -- importing crew: % on services they DON'T perform
  ('referral_crew_share_pct',  '0.25'::jsonb),  -- crew-bringer: % of collected margin...
  ('referral_crew_cap',        '250'::jsonb),   -- ...until this cap, then stops forever
  ('referral_sunset_days',     '365'::jsonb),   -- customer-spend arms sunset after a year
  ('referral_maturation_days', '30'::jsonb)     -- clawback window before spendable
on conflict (key) do nothing;
