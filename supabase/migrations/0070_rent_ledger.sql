-- ============================================================================
-- 0070 — THE RENT LEDGER. WHO OWES, WHO PAID, WHO IS LATE.
--
-- The owner's first ask, back at the start: "see all the renters, who is
-- compliant and who is not, PAYMENTS OVERDUE, who is about to leave". This is
-- the table that answers it.
--
-- NO PROCESSOR REQUIRED, AND THAT IS NOT A COMPROMISE. Most people in a
-- mobile-home park pay by CHECK OR CASH at the office window. Card is the
-- minority path here, not the default — software that treats cash as an
-- afterthought is software written for a different business. So `method` leads
-- with cash and check, and a card payment through the processor is simply one
-- more value in the list when keys exist.
--
-- ---------------------------------------------------------------------------
-- A CHARGE IS A SNAPSHOT, NOT A VIEW.
--
-- `lines` is frozen jsonb: "$400 lot rent · for the month", "$55 grounds fee".
-- Re-rate somebody in June and May's charge does not move. A ledger that
-- recomputes history is a ledger nobody can reconcile against a bank statement,
-- and the whole point of this table is to be the thing you argue from.
--
-- WHY NOT REUSE `invoices`. That table is per-JOB service billing — a boat
-- winterisation against a property. Park rent is recurring tenancy billing
-- against a lot, with proration, fees, and a due day. Same word, different
-- noun. Sharing the table would mean every query in both domains carrying a
-- "but not that kind" filter forever.
-- ---------------------------------------------------------------------------
-- ============================================================================

create table if not exists public.park_charges (
  id             uuid primary key default gen_random_uuid(),
  park_id        uuid not null references public.parks(id) on delete cascade,
  park_lot_id    uuid not null references public.park_lots(id) on delete cascade,
  -- The tenancy billed. ON DELETE SET NULL: removing a tenancy must not erase
  -- the money it owed.
  reservation_id uuid references public.lot_reservations(id) on delete set null,
  -- Whose bill it is, kept independently so a closed tenancy still has a name
  -- against the debt.
  renter_id      uuid references public.park_renters(id) on delete set null,

  -- 'YYYY-MM'. The calendar month billed, not the agreement period.
  period_month   text not null check (period_month ~ '^\d{4}-\d{2}$'),
  due_on         date not null,

  -- THE SNAPSHOT. [{label, amount, basis}] exactly as the resident saw it.
  lines          jsonb not null default '[]'::jsonb,
  amount         numeric(10,2) not null check (amount >= 0),

  -- Maintained by trigger from the payments themselves, never incremented.
  paid_total     numeric(10,2) not null default 0 check (paid_total >= 0),

  status         text not null default 'open'
                   check (status in ('open', 'paid', 'void')),
  voided_at      timestamptz,
  void_reason    text,

  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),

  -- NEVER BILL A MONTH TWICE. The single most important constraint here: a
  -- double-run of the charge job must not double a household's rent.
  unique (reservation_id, period_month),

  constraint park_charges_void_has_reason
    check (voided_at is null or void_reason is not null)
);

comment on table public.park_charges is
  'One household, one month. `lines` is a FROZEN snapshot of the statement — '
  're-rating somebody in June must not move May''s charge, or the ledger '
  'cannot be reconciled against a bank statement.';

create index if not exists park_charges_park_idx
  on public.park_charges (park_id, period_month desc);

-- The working set for "who is late": open, and something still owing.
create index if not exists park_charges_open_idx
  on public.park_charges (park_id, due_on)
  where status = 'open';


create table if not exists public.park_payments (
  id          uuid primary key default gen_random_uuid(),
  charge_id   uuid not null references public.park_charges(id) on delete cascade,

  amount      numeric(10,2) not null check (amount > 0),

  -- CASH AND CHECK FIRST. That is how rent actually arrives at a park office.
  method      text not null
                check (method in ('cash', 'check', 'card', 'ach', 'transfer', 'other')),
  -- Check number, transfer reference, or the processor's id once keys exist.
  reference   text,

  received_on date not null,
  note        text,
  recorded_by uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.park_payments is
  'Money actually received. Cash and check are first-class, because that is '
  'how most park residents pay; a card payment is one more method, not the '
  'assumed one.';

create index if not exists park_payments_charge_idx
  on public.park_payments (charge_id, received_on);


-- ------------------------------------------------- keeping the sum honest ---
--
-- Recomputed from the payments rather than incremented, so a corrected or
-- deleted payment cannot leave the total drifting from reality. Also flips
-- status, so "paid" is never a thing somebody forgot to set.
create or replace function public.sync_charge_paid()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare target uuid; total numeric(10,2); owed numeric(10,2); cur_status text;
begin
  target := coalesce(new.charge_id, old.charge_id);

  select coalesce(sum(p.amount), 0) into total
    from public.park_payments p where p.charge_id = target;

  select c.amount, c.status into owed, cur_status
    from public.park_charges c where c.id = target;

  update public.park_charges
     set paid_total = total,
         -- A VOID charge stays void. Paying against one is refused below, but
         -- if it ever happened, money arriving must not silently un-void a
         -- charge somebody deliberately cancelled.
         status = case
                    when cur_status = 'void' then 'void'
                    when total >= owed then 'paid'
                    else 'open'
                  end
   where id = target;
  return null;
end $$;

drop trigger if exists trg_sync_charge_paid on public.park_payments;
create trigger trg_sync_charge_paid
after insert or update or delete on public.park_payments
for each row execute function public.sync_charge_paid();


-- A payment against a VOIDED charge is a bookkeeping error, not a payment.
create or replace function public.guard_park_payment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare st text;
begin
  select status into st from public.park_charges where id = new.charge_id;
  if st = 'void' then
    raise exception 'park_payments: that charge was voided — record the payment against a live one';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_park_payment on public.park_payments;
create trigger trg_guard_park_payment
before insert or update on public.park_payments
for each row execute function public.guard_park_payment();


-- ---------------------------------------------------------------- rls -------
alter table public.park_charges  enable row level security;
alter table public.park_payments enable row level security;

drop policy if exists park_charges_read on public.park_charges;
create policy park_charges_read on public.park_charges
  for select to authenticated
  using (
    public.ll_manages_park(park_id)
    or public.ll_is_ops()
    -- A resident may see their OWN bills. A bill you cannot look at is a bill
    -- you will phone about.
    or exists (
      select 1 from public.park_renters pr
       where pr.id = park_charges.renter_id and pr.user_id = auth.uid()
    )
  );

drop policy if exists park_payments_read on public.park_payments;
create policy park_payments_read on public.park_payments
  for select to authenticated
  using (exists (
    select 1 from public.park_charges c
     where c.id = park_payments.charge_id
       and (
         public.ll_manages_park(c.park_id)
         or public.ll_is_ops()
         or exists (
           select 1 from public.park_renters pr
            where pr.id = c.renter_id and pr.user_id = auth.uid()
         )
       )
  ));

revoke all on public.park_charges  from anon;
revoke all on public.park_payments from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.park_charges from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.park_payments from authenticated;
grant select on public.park_charges  to authenticated;
grant select on public.park_payments to authenticated;


-- ------------------------------------------------------ post-conditions -----
do $$
begin
  if to_regclass('public.park_charges') is null then
    raise exception '0070: park_charges missing';
  end if;
  if to_regclass('public.park_payments') is null then
    raise exception '0070: park_payments missing';
  end if;

  -- The one that stops a double-run doubling somebody's rent.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.park_charges'::regclass and contype = 'u'
  ) then
    raise exception '0070: a month could be billed twice';
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_sync_charge_paid') then
    raise exception '0070: paid_total would drift from the payments';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_guard_park_payment') then
    raise exception '0070: a voided charge could still take money';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema='public' and table_name in ('park_charges','park_payments')
       and grantee='anon'
  ) then
    raise exception '0070: anon holds a grant on the ledger';
  end if;

  raise notice '0070: the ledger is open. Cash and check are first-class.';
end $$;
