-- ============================================================
--  LakeLife — referral money hardening (adversarial review H2/H3/M2).
--  H2: a crew reading its own cross_sell earning rows could DERIVE the
--      customer's price (amount ÷ pct) — rule 1 by arithmetic. Rows go
--      ops-only; beneficiaries see AGGREGATES via server actions only.
--  H3: two concurrent settles could overdraft a credit balance across
--      two invoices — a per-user advisory lock + balance check in a
--      trigger makes the ledger overdraft-proof at the database.
--  M2: user_credits.earning_id (unique) makes maturation grants
--      idempotent — money can't vanish or double in a crash window.
--  Run once. Safe to re-run.
-- ============================================================

-- H2: per-row reads are ops-only; totals reach beneficiaries via aggregates.
drop policy if exists referral_earnings_access on public.referral_earnings;
create policy referral_earnings_access on public.referral_earnings for select
  using (public.ll_is_ops());

-- M2: idempotent maturation grants.
alter table public.user_credits
  add column if not exists earning_id uuid references public.referral_earnings(id) on delete set null;
create unique index if not exists user_credits_one_per_earning
  on public.user_credits (earning_id) where earning_id is not null;

-- H3: overdraft-proof credit ledger. The advisory lock serializes credit
-- writes PER USER inside the transaction, so two concurrent applications
-- can't both read the same balance and both spend it.
create or replace function public.guard_credit_balance()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.amount < 0 then
    perform pg_advisory_xact_lock(hashtext('user_credits:' || new.user_id::text));
    if (select coalesce(sum(amount), 0) from public.user_credits where user_id = new.user_id) + new.amount < 0 then
      raise exception 'insufficient credit balance';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists user_credits_no_overdraft on public.user_credits;
create trigger user_credits_no_overdraft
  before insert on public.user_credits
  for each row execute function public.guard_credit_balance();
