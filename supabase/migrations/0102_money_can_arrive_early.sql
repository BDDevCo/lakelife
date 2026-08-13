-- 0102 — MONEY CAN ARRIVE THE DAY IT ARRIVES.
--
-- `park_payments.charge_id` was NOT NULL, and the only control that opened the
-- record-a-payment form was gated on an open balance. So at a park where
-- nineteen households pay cash and check at a window, none of these could be
-- recorded at all:
--
--   A January check handed over on 28 December.
--   A second check for a month already paid.
--   An overpayment — $520 against a $500 bill.
--   A deposit taken at signing.
--
-- Every one of them happens in month one. And the moment the ledger and the
-- bank stop agreeing, the notebook comes back out and none of the careful work
-- above it gets used.
--
-- ================== HOW THE MONEY STAYS HONEST ==============================
--
-- A payment is now anchored to a CHARGE (applied) or to a RENTER (money on
-- account), and exactly one of those is required — an unanchored payment is
-- money from nobody, which is the state that makes a ledger useless.
--
-- Unapplied money is invisible to every existing total BY CONSTRUCTION, not by
-- a filter somebody has to remember: `sync_charge_paid` sums payments by
-- `charge_id`, so a row with none contributes to no charge's `paid_total` and
-- therefore to no arrears figure. Applying it later is one UPDATE setting
-- `charge_id`, and the same trigger then does the arithmetic. This is the same
-- shape as 0097's tip: a different kind of money kept out of the revenue path
-- by the anchor it does not have.
--
-- A DEPOSIT IS NOT RENT AND MUST NEVER PAY ONE. It is held money that goes
-- back, so it may never carry a charge_id at all — enforced below rather than
-- left to a screen. That also keeps it out of `paid_total` for free.

alter table public.park_payments
  -- Which park, always — including for money with no charge to derive it from.
  add column if not exists park_id uuid references public.parks(id) on delete cascade,
  -- Who handed it over. Required when there is no charge; useful even when
  -- there is, because "whose money is this" is the first question in a dispute.
  add column if not exists renter_id uuid references public.park_renters(id) on delete set null,
  add column if not exists kind text not null default 'rent',
  -- Deposit custody, recorded on the deposit itself rather than as a negative
  -- payment: `park_payments_amount_check` forbids a non-positive amount, and a
  -- refund that looks like a payment is how a ledger starts lying.
  add column if not exists returned_on date,
  add column if not exists returned_amount numeric(10,2),
  add column if not exists return_note text;

-- Backfill before the NOT NULL, so an existing row cannot block the migration
-- for a value it could always have derived.
update public.park_payments p
   set park_id = c.park_id
  from public.park_charges c
 where c.id = p.charge_id and p.park_id is null;

alter table public.park_payments alter column charge_id drop not null;
alter table public.park_payments alter column park_id set not null;

alter table public.park_payments drop constraint if exists park_payments_kind_check;
alter table public.park_payments add constraint park_payments_kind_check
  check (kind in ('rent', 'deposit'));

-- MONEY FROM NOBODY IS NOT A RECORD.
alter table public.park_payments drop constraint if exists park_payments_is_anchored;
alter table public.park_payments add constraint park_payments_is_anchored
  check (charge_id is not null or renter_id is not null);

-- A DEPOSIT NEVER PAYS A BILL. Held money is not income, and letting it settle
-- a rent charge would both overstate collection and quietly spend something
-- that has to go back.
alter table public.park_payments drop constraint if exists park_payments_deposit_is_held;
alter table public.park_payments add constraint park_payments_deposit_is_held
  check (kind <> 'deposit' or charge_id is null);

-- A RETURN IS A DEPOSIT'S OWN EVENT, and never more than was taken.
alter table public.park_payments drop constraint if exists park_payments_return_is_sane;
alter table public.park_payments add constraint park_payments_return_is_sane
  check (
    (returned_on is null and returned_amount is null)
    or (kind = 'deposit'
        and returned_on is not null
        and returned_amount is not null
        and returned_amount > 0
        and returned_amount <= amount)
  );

-- A MISTYPED YEAR MOVES INCOME INTO ANOTHER TAX YEAR, silently, and nobody
-- finds out until an accountant does. Two years back covers recording history
-- at takeover; a month forward covers a post-dated check. Beyond that is a
-- typo, and it should be refused while somebody is still looking at the form.
alter table public.park_payments drop constraint if exists park_payments_received_on_is_sane;
alter table public.park_payments add constraint park_payments_received_on_is_sane
  check (received_on >= (created_at::date - 730) and received_on <= (created_at::date + 31));

create index if not exists park_payments_unapplied_idx
  on public.park_payments (park_id, received_on desc)
  where charge_id is null and reversed_at is null and kind = 'rent';

create index if not exists park_payments_deposits_idx
  on public.park_payments (park_id, renter_id)
  where kind = 'deposit' and reversed_at is null;

-- --------------------------------------------- the receipt number, fixed ----
-- `assign_receipt_no` resolved the park by joining THROUGH the charge, so a
-- payment with no charge would have silently got no receipt number at all —
-- and the office hands a receipt over for a deposit. It now reads the park
-- directly, and counts every payment in that park rather than only the ones
-- with a charge, so the sequence cannot collide.
create or replace function public.assign_receipt_no()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare pid uuid; n integer;
begin
  if new.receipt_no is not null then return new; end if;

  pid := new.park_id;
  if pid is null then
    select c.park_id into pid from public.park_charges c where c.id = new.charge_id;
  end if;
  if pid is null then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended(pid::text, 0));

  select coalesce(max(p.receipt_no), 0) + 1 into n
    from public.park_payments p
   where p.park_id = pid;

  new.receipt_no := n;
  return new;
end $function$;

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; lot uuid; ren uuid; res uuid; ch uuid;
        pay uuid; dep uuid; ok boolean; n1 int; n2 int; owed numeric; paid numeric;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0102 Proof','1 Rd','0102-proof', lid, 'mh', false) returning id into pid;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'Lot 1', true,'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid,'0102 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange('2026-01-01','2027-01-01','[)'),'annual','active',500) returning id into res;
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, lines)
    values (pid, lot, res, ren, '2026-08', date '2026-08-01', 500, '[]'::jsonb) returning id into ch;

    -- 1. THE POINT: money with no charge is recordable.
    insert into public.park_payments (park_id, renter_id, amount, method, received_on)
    values (pid, ren, 500, 'check', current_date) returning id, receipt_no into pay, n1;
    if n1 is null then raise exception '0102: unapplied money got no receipt number'; end if;

    -- 2. It touches NO charge total — invisible by construction.
    select amount, paid_total into owed, paid from public.park_charges where id = ch;
    if paid <> 0 then raise exception '0102: unapplied money leaked into paid_total (%)', paid; end if;

    -- 3. Applying it later does the arithmetic.
    update public.park_payments set charge_id = ch where id = pay;
    select paid_total into paid from public.park_charges where id = ch;
    if paid <> 500 then raise exception '0102: applying the payment did not settle the charge (%)', paid; end if;

    -- 4. A deposit is recordable and can NEVER pay a bill.
    insert into public.park_payments (park_id, renter_id, amount, method, received_on, kind)
    values (pid, ren, 300, 'cash', current_date, 'deposit') returning id, receipt_no into dep, n2;
    if n2 is null or n2 = n1 then raise exception '0102: receipt numbers collided or were skipped (% vs %)', n1, n2; end if;

    ok := false;
    begin
      update public.park_payments set charge_id = ch where id = dep;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0102: A DEPOSIT WAS USED TO PAY RENT'; end if;

    -- 5. Returning more than was taken is refused; returning part is fine.
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 400 where id = dep;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0102: returned more deposit than was ever taken'; end if;
    update public.park_payments set returned_on = current_date, returned_amount = 300 where id = dep;

    -- 6. A payment from nobody is refused.
    ok := false;
    begin
      insert into public.park_payments (park_id, amount, method, received_on)
      values (pid, 100, 'cash', current_date);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0102: a payment anchored to nothing was accepted'; end if;

    -- 7. A mistyped year is refused.
    ok := false;
    begin
      insert into public.park_payments (park_id, renter_id, amount, method, received_on)
      values (pid, ren, 100, 'cash', current_date + 400);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0102: a payment received 400 days from now was accepted'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
