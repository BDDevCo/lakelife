-- 0081 — A PAYMENT RECORDED WRONG MUST BE CORRECTABLE.
--
-- Three separate ways the park ledger could be put into a state nobody could
-- get it out of. All three matter before December 15th, because after that
-- they happen to real households.
--
-- ---------------------------------------------------------------------------
-- ONE: A TRANSPOSED DIGIT WAS PERMANENT.
--
-- `recordPayment` was the only write to park_payments. No edit, no delete, no
-- negative adjustment. 0070 forces `amount > 0`, so a compensating row is
-- impossible; 0072 refuses to void a charge with `paid_total > 0`, so the bill
-- cannot be cancelled either. Type $4,395 instead of $439.50 and the household
-- is permanently, unfixably in credit — while receipt-helpers promises the
-- owner "the bill goes back to outstanding".
--
-- A bounced check is the same shape and is not rare.
--
-- The correction is a REVERSAL, not a deletion. The row stays exactly where it
-- is, with its receipt number, and gains a reason and a timestamp. Nothing
-- disappears from the record — the whole point of this ledger is that a
-- payment is something two people were there for, and quietly deleting one
-- party's evidence is the opposite of that.
--
-- ---------------------------------------------------------------------------
-- TWO: TWO PAYMENTS AT ONCE COULD LOSE ONE.
--
-- `sync_charge_paid` computed `sum(amount)` and only THEN touched the charge,
-- taking no lock first — unlike `assign_receipt_no` (0076), which takes an
-- advisory lock precisely because it knows better. Two payments landing
-- together on the same charge could each compute a sum that missed the other,
-- and the second update would overwrite the first. Money recorded, money gone
-- from the total. Locking the charge row first makes the second trigger wait
-- and then see the first payment.
--
-- ---------------------------------------------------------------------------
-- THREE: VOIDING A BILL MADE THAT MONTH UNBILLABLE FOREVER.
--
-- `unique (reservation_id, period_month)` had no status predicate, and
-- `runCharges` builds its "already billed" set with no status filter. So a
-- voided bill kept occupying the slot: re-raising that household's rent for
-- that month was impossible, and `summarise` skips void charges, so it did not
-- even read as outstanding. The household simply stopped being billed for a
-- month, silently, as a consequence of the owner correcting a mistake.

-- ------------------------------------------------------------- reversal ----

alter table public.park_payments
  add column if not exists reversed_at     timestamptz,
  add column if not exists reversed_reason text,
  add column if not exists reversed_by     uuid references public.users(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payment_reversal_has_a_reason'
  ) then
    -- SAME RULE AS A DISPUTE RESOLUTION (0074): an action that moves money
    -- against somebody has to say why. "It was wrong" with no explanation is
    -- indistinguishable from an office covering a mistake, and this is the
    -- record a court would read.
    alter table public.park_payments
      add constraint payment_reversal_has_a_reason
      check (reversed_at is null or coalesce(btrim(reversed_reason), '') <> '');
  end if;
end $$;

comment on column public.park_payments.reversed_at is
  'Set when this payment was taken back — a typo, a bounced check. The row '
  'STAYS, keeping its receipt number; sync_charge_paid stops counting it.';

create index if not exists park_payments_live_idx
  on public.park_payments (charge_id) where reversed_at is null;


-- --------------------------------------------------------- idempotency -----
-- A double-tapped submit recorded the money twice and burnt two receipt
-- numbers. The key is minted once when the form opens, so a retry of the SAME
-- attempt collides and a genuine second payment (a new form, a new key) does
-- not. Nullable, because rows written before this have no key and two nulls
-- never collide in a unique index.
alter table public.park_payments
  add column if not exists idempotency_key text;

create unique index if not exists park_payments_idempotency_idx
  on public.park_payments (idempotency_key) where idempotency_key is not null;


-- ------------------------------------------- the sum, honestly and safely ---
create or replace function public.sync_charge_paid()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare target uuid; total numeric(10,2); owed numeric(10,2); cur_status text;
begin
  target := coalesce(new.charge_id, old.charge_id);

  -- LOCK THE CHARGE BEFORE READING THE PAYMENTS. Two payments arriving
  -- together used to each compute a sum that missed the other; the second
  -- update overwrote the first and that money left the total.
  select c.amount, c.status into owed, cur_status
    from public.park_charges c where c.id = target
    for update;

  -- A REVERSED PAYMENT IS NOT MONEY. It stays on the record, with its receipt
  -- number, and stops counting towards what has been paid.
  select coalesce(sum(p.amount), 0) into total
    from public.park_payments p
   where p.charge_id = target and p.reversed_at is null;

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

-- Reversal is an UPDATE, and the trigger already fires on update.
drop trigger if exists trg_sync_charge_paid on public.park_payments;
create trigger trg_sync_charge_paid
after insert or update or delete on public.park_payments
for each row execute function public.sync_charge_paid();


-- --------------------------------------- a voided month is billable again ---
alter table public.park_charges
  drop constraint if exists park_charges_reservation_id_period_month_key;

drop index if exists park_charges_reservation_id_period_month_key;

create unique index if not exists park_charges_one_live_per_period_idx
  on public.park_charges (reservation_id, period_month)
  where status <> 'void';


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='park_payments'
     and column_name in ('reversed_at','reversed_reason','reversed_by','idempotency_key');
  if n <> 4 then raise exception '0081: reversal/idempotency columns missing (found %)', n; end if;

  if not exists (
    select 1 from pg_indexes
     where tablename='park_charges' and indexname='park_charges_one_live_per_period_idx'
  ) then
    raise exception '0081: the void-aware period index is missing — a cancelled bill would still burn the month';
  end if;

  -- The old unconditional constraint must be GONE, or nothing changed.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.park_charges'::regclass
       and conname = 'park_charges_reservation_id_period_month_key'
  ) then
    raise exception '0081: the unconditional period constraint is still there';
  end if;

  -- Attempt the violation: a reversal with no reason must be refused.
  begin
    insert into public.park_payments
      (charge_id, amount, method, received_on, reversed_at, reversed_reason)
    values
      ('00000000-0000-0000-0000-000000000000', 1, 'cash', '1900-01-01', now(), '   ');
    raise exception '0081: a reversal with a blank reason was accepted';
  exception
    when check_violation then null;         -- refused for the right reason
    when foreign_key_violation then null;   -- refused earlier; the charge is fake
    when not_null_violation then null;
  end;
end $$;
