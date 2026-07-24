-- ============================================================
--  LakeLife — Refund machinery (docs/refunds-design.md).
--  refunds: the append-only ledger of money returned to customers.
--  payouts.kind: 'earning' rows are job pay; 'adjustment' rows are
--  negative clawbacks that net against the crew's next batch (ToS §7.6).
--  Run once. Safe to re-run. (Applied in prod as 0043 + 0043b.)
-- ============================================================

create table if not exists public.refunds (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices(id) on delete restrict,
  job_id        uuid references public.jobs(id) on delete set null,
  amount        numeric not null check (amount > 0),
  crew_clawback numeric not null default 0 check (crew_clawback >= 0),
  reason        text not null,
  created_by    uuid references public.users(id) on delete set null,
  processor_ref text,
  created_at    timestamptz not null default now()
);
create index if not exists refunds_invoice_idx on public.refunds(invoice_id);

alter table public.refunds enable row level security;
drop policy if exists refunds_ops on public.refunds;
create policy refunds_ops on public.refunds
  for select using (public.ll_is_ops());
revoke insert, update, delete on public.refunds from authenticated, anon;
grant select on public.refunds to authenticated;

-- Distinguish job earnings from clawback adjustments in the payout ledger.
alter table public.payouts add column if not exists kind text not null default 'earning'
  check (kind in ('earning', 'adjustment'));
alter table public.payouts drop constraint if exists payouts_amount_sign;
alter table public.payouts add constraint payouts_amount_sign
  check ((kind = 'earning' and amount >= 0) or (kind = 'adjustment' and amount <= 0));

-- One EARNING per job stays ironclad; clawback ADJUSTMENTS may repeat
-- (one per partial refund) without tripping the money-uniqueness guard.
drop index if exists public.payouts_one_per_job;
create unique index if not exists payouts_one_earning_per_job
  on public.payouts (job_id) where (job_id is not null and kind = 'earning');

-- 0043c (review hardening, 2026-07-23): the immutable "ever owed" anchor —
-- reductions mutate payouts.amount, so conservation math needs the original
-- preserved — plus refund idempotency keys.
alter table public.payouts add column if not exists original_amount numeric;
update public.payouts set original_amount = amount where original_amount is null and kind = 'earning';
alter table public.refunds add column if not exists idempotency_key text;
create unique index if not exists refunds_idempotency_idx
  on public.refunds (idempotency_key) where (idempotency_key is not null);
